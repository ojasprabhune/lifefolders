use anyhow::Result;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{Datelike, Duration, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::models::{Log, TaskData, TaskRequest};
use crate::routes::AppError;
use crate::undo::{self, Effect};
use crate::AppState;

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct Task {
    pub id: Uuid,
    pub title: String,
    pub category: String,
    pub due_date: Option<NaiveDate>,
    pub due_time: Option<NaiveTime>,
    pub effort_minutes: Option<i32>,
    pub status: String,
    pub is_exam: bool,
    pub note: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
    pub completed_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct Checkpoint {
    pub id: Uuid,
    pub task_id: Uuid,
    pub offset_days: i32,
    pub due_date: NaiveDate,
    pub status: String,
}

pub(crate) const TASK_COLUMNS: &str =
    "id, title, category, due_date, due_time, effort_minutes, status, is_exam, note, created_at, completed_at";

pub(crate) async fn open_tasks(state: &AppState) -> Result<Vec<Task>, AppError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks \
         WHERE archived_at IS NULL AND status != 'done' ORDER BY due_date NULLS LAST"
    ))
    .fetch_all(&state.pool)
    .await?)
}

// Only match on the whole title being equal to (or a substring of) an
// existing one. A weaker "shares one word" tier used to live here, but any
// two tasks on the same subject ("US History Project" / "US History
// Syllabus", "Math HW1" / "Math Edpuzzle") share their subject word, so it
// kept silently rescheduling one task instead of creating the other. A
// missed update just leaves a harmless duplicate; a false match silently
// clobbers the wrong task, which is worse, so we bias toward the former.
pub(crate) fn best_match<'a>(items: &'a [Task], query: &str) -> Option<&'a Task> {
    let q = query.trim().to_lowercase();
    let mut best: Option<(&Task, i32)> = None;
    for item in items {
        let n = item.title.trim().to_lowercase();
        let score = if n == q {
            2
        } else if n.contains(&q) || q.contains(&n) {
            1
        } else {
            continue;
        };
        if best.map(|(_, s)| score > s).unwrap_or(true) {
            best = Some((item, score));
        }
    }
    best.map(|(item, _)| item)
}

pub async fn context_block(state: &AppState) -> String {
    let Ok(tasks) = open_tasks(state).await else {
        return String::new();
    };
    if tasks.is_empty() {
        return String::new();
    }
    let mut out = String::from("Open tasks:\n");
    for t in tasks.iter().take(40) {
        let due = match (t.due_date, t.due_time) {
            (Some(d), Some(time)) => format!("{d} {time}"),
            (Some(d), None) => d.to_string(),
            (None, _) => "no due date".into(),
        };
        out.push_str(&format!(
            "- [{}] {} (due {due}, {})\n",
            t.category, t.title, t.status
        ));
    }
    out
}

fn parse_due(s: Option<&str>) -> Option<NaiveDate> {
    s.and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok())
}

fn parse_due_time(s: Option<&str>) -> Option<NaiveTime> {
    s.and_then(|s| {
        let s = s.trim();
        NaiveTime::parse_from_str(s, "%H:%M")
            .or_else(|_| NaiveTime::parse_from_str(s, "%H:%M:%S"))
            .ok()
    })
}

async fn regenerate_checkpoints(
    state: &AppState,
    task_id: Uuid,
    title: &str,
    due: NaiveDate,
) -> Result<(), AppError> {
    let deleted: Vec<(Uuid,)> =
        sqlx::query_as("DELETE FROM task_checkpoints WHERE task_id = $1 AND status = 'todo' RETURNING id")
            .bind(task_id)
            .fetch_all(&state.pool)
            .await?;
    for (id,) in deleted {
        spawn_checkpoint_delete(state, id);
    }
    let today = Utc::now().date_naive();
    for offset in [7, 3, 1] {
        let cp_date = due - Duration::days(offset);
        if cp_date >= today {
            let (id,): (Uuid,) = sqlx::query_as(
                "INSERT INTO task_checkpoints (task_id, offset_days, due_date) VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(task_id)
            .bind(offset)
            .bind(cp_date)
            .fetch_one(&state.pool)
            .await?;
            spawn_checkpoint_sync(state, id, title, offset as i32, cp_date);
        }
    }
    Ok(())
}

async fn clear_pending_checkpoints(state: &AppState, task_id: Uuid) -> Result<(), AppError> {
    let deleted: Vec<(Uuid,)> =
        sqlx::query_as("DELETE FROM task_checkpoints WHERE task_id = $1 AND status = 'todo' RETURNING id")
            .bind(task_id)
            .fetch_all(&state.pool)
            .await?;
    for (id,) in deleted {
        spawn_checkpoint_delete(state, id);
    }
    Ok(())
}

fn spawn_checkpoint_sync(state: &AppState, checkpoint_id: Uuid, task_title: &str, offset_days: i32, due_date: NaiveDate) {
    let Some(cfg) = state.gcal.clone() else { return };
    let title = task_title.to_string();
    tokio::spawn(async move {
        let uid = format!("lf-checkpoint-{checkpoint_id}");
        let summary = format!("study: {title} ({offset_days}d out)");
        if let Err(e) = crate::gcal::upsert_event(&cfg.http, &cfg.client_id, &cfg.client_secret, &cfg.refresh_token, &cfg.calendar_id, &uid, &summary, due_date, None, None).await {
            tracing::warn!("checkpoint calendar sync failed for {checkpoint_id}: {e:#}");
        }
    });
}

fn spawn_checkpoint_delete(state: &AppState, checkpoint_id: Uuid) {
    let Some(cfg) = state.gcal.clone() else { return };
    tokio::spawn(async move {
        let uid = format!("lf-checkpoint-{checkpoint_id}");
        if let Err(e) = crate::gcal::delete_event(&cfg.http, &cfg.client_id, &cfg.client_secret, &cfg.refresh_token, &cfg.calendar_id, &uid).await {
            tracing::warn!("checkpoint calendar delete failed for {checkpoint_id}: {e:#}");
        }
    });
}

fn spawn_calendar_sync(state: &AppState, task: &Task) {
    let Some(cfg) = state.gcal.clone() else { return };
    let task = task.clone();
    tokio::spawn(async move {
        let uid = format!("lf-task-{}", task.id);
        let result = match (task.due_date, task.status.as_str()) {
            (Some(due), status) if status != "done" => {
                crate::gcal::upsert_event(&cfg.http, &cfg.client_id, &cfg.client_secret, &cfg.refresh_token, &cfg.calendar_id, &uid, &task.title, due, task.due_time, task.effort_minutes).await
            }
            _ => crate::gcal::delete_event(&cfg.http, &cfg.client_id, &cfg.client_secret, &cfg.refresh_token, &cfg.calendar_id, &uid).await,
        };
        if let Err(e) = result {
            tracing::warn!("calendar sync failed for task {}: {e:#}", task.id);
        }
    });
}

fn spawn_calendar_delete(state: &AppState, task_id: Uuid) {
    let Some(cfg) = state.gcal.clone() else { return };
    tokio::spawn(async move {
        let uid = format!("lf-task-{task_id}");
        if let Err(e) = crate::gcal::delete_event(&cfg.http, &cfg.client_id, &cfg.client_secret, &cfg.refresh_token, &cfg.calendar_id, &uid).await {
            tracing::warn!("calendar delete failed for task {task_id}: {e:#}");
        }
    });
}

// The LLM is asked to set is_exam itself, but it's inconsistent about it on
// terse titles ("psych exam", "physics exam friday" have come back false or
// omitted entirely) - missing a real exam silently drops its study
// checkpoints, which is worse than the rare false positive of an unrelated
// task with "test"/"quiz" in the title picking up harmless extra reminders.
// So back the model's call up with a literal check on the title itself.
fn looks_like_exam(title: &str) -> bool {
    const EXAM_WORDS: &[&str] = &["exam", "test", "quiz", "midterm"];
    title
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| EXAM_WORDS.contains(&w))
}

pub(crate) async fn create_task(state: &AppState, req: &TaskRequest) -> Result<Task, AppError> {
    let is_exam = req.is_exam.unwrap_or(false) || looks_like_exam(&req.title);
    let task: Task = sqlx::query_as(&format!(
        "INSERT INTO tasks (title, category, due_date, due_time, effort_minutes, status, is_exam, note) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {TASK_COLUMNS}"
    ))
    .bind(req.title.trim())
    .bind(req.category.as_deref().unwrap_or("other"))
    .bind(parse_due(req.due_date.as_deref()))
    .bind(parse_due_time(req.due_time.as_deref()))
    .bind(req.effort_minutes)
    .bind(req.status.as_deref().unwrap_or("not_started"))
    .bind(is_exam)
    .bind(&req.note)
    .fetch_one(&state.pool)
    .await?;
    if task.is_exam {
        if let Some(due) = task.due_date {
            regenerate_checkpoints(state, task.id, &task.title, due).await?;
        }
    }
    spawn_calendar_sync(state, &task);
    Ok(task)
}

pub(crate) async fn update_task(
    state: &AppState,
    existing: &Task,
    req: &TaskRequest,
) -> Result<(Task, String), AppError> {
    let new_status = req.status.clone().unwrap_or_else(|| existing.status.clone());
    // Dropping the deadline drops the clock time with it - a time of day on a
    // task with no date has nothing to hang off.
    let (new_due, new_due_time) = if req.clear_due_date {
        (None, None)
    } else {
        (
            req.due_date
                .as_deref()
                .map(|s| parse_due(Some(s)))
                .unwrap_or(existing.due_date),
            req.due_time
                .as_deref()
                .map(|s| parse_due_time(Some(s)))
                .unwrap_or(existing.due_time),
        )
    };
    let new_is_exam = req.is_exam.unwrap_or(existing.is_exam);
    let completed_at = if new_status == "done" && existing.status != "done" {
        Some(Utc::now())
    } else if new_status != "done" {
        None
    } else {
        existing.completed_at
    };

    // A new note (e.g. "did 1 module of psych notes") reads as progress on
    // the task, not a correction - append it to whatever's already there
    // instead of silently overwriting it, so repeated check-ins build up a
    // visible log instead of each one erasing the last.
    let task: Task = sqlx::query_as(&format!(
        "UPDATE tasks SET status = $2, due_date = $3, due_time = $9, is_exam = $4, \
            category = COALESCE($8, category), \
            effort_minutes = COALESCE($5, effort_minutes), \
            note = CASE \
                WHEN $6::text IS NULL THEN note \
                WHEN note IS NULL OR note = '' THEN $6 \
                ELSE note || E'\\n' || $6 \
            END, \
            completed_at = $7 \
         WHERE id = $1 RETURNING {TASK_COLUMNS}"
    ))
    .bind(existing.id)
    .bind(&new_status)
    .bind(new_due)
    .bind(new_is_exam)
    .bind(req.effort_minutes)
    .bind(&req.note)
    .bind(completed_at)
    .bind(&req.category)
    .bind(new_due_time)
    .fetch_one(&state.pool)
    .await?;

    let due_or_exam_changed = new_due != existing.due_date || new_is_exam != existing.is_exam;
    if due_or_exam_changed {
        if task.is_exam {
            if let Some(due) = task.due_date {
                regenerate_checkpoints(state, task.id, &task.title, due).await?;
            }
        } else {
            clear_pending_checkpoints(state, task.id).await?;
        }
    }

    let action = if new_status != existing.status {
        "status"
    } else if new_due != existing.due_date || new_due_time != existing.due_time {
        "rescheduled"
    } else if task.category != existing.category {
        "moved"
    } else {
        "note"
    };
    spawn_calendar_sync(state, &task);
    Ok((task, action.to_string()))
}

async fn restore_task_fields(state: &AppState, snapshot: &Task) -> Result<Task, AppError> {
    let task: Task = sqlx::query_as(&format!(
        "UPDATE tasks SET status = $2, due_date = $3, due_time = $8, is_exam = $4, \
            effort_minutes = $5, note = $6, completed_at = $7, \
            title = $9, category = $10 \
         WHERE id = $1 RETURNING {TASK_COLUMNS}"
    ))
    .bind(snapshot.id)
    .bind(&snapshot.status)
    .bind(snapshot.due_date)
    .bind(snapshot.is_exam)
    .bind(snapshot.effort_minutes)
    .bind(&snapshot.note)
    .bind(snapshot.completed_at)
    .bind(snapshot.due_time)
    .bind(&snapshot.title)
    .bind(&snapshot.category)
    .fetch_one(&state.pool)
    .await?;

    if task.is_exam {
        if let Some(due) = task.due_date {
            regenerate_checkpoints(state, task.id, &task.title, due).await?;
        } else {
            clear_pending_checkpoints(state, task.id).await?;
        }
    } else {
        clear_pending_checkpoints(state, task.id).await?;
    }
    spawn_calendar_sync(state, &task);
    Ok(task)
}

// The three entry points undo.rs calls into for a TaskCreated/TaskUpdated/
// TaskDeleted action - reverse exactly what create_task/update_task/
// delete_task did, including their calendar and checkpoint side effects.
pub(crate) async fn undo_created(state: &AppState, task_id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE tasks SET archived_at = now() WHERE id = $1")
        .bind(task_id)
        .execute(&state.pool)
        .await?;
    spawn_calendar_delete(state, task_id);
    clear_pending_checkpoints(state, task_id).await?;
    Ok(())
}

pub(crate) async fn undo_updated(state: &AppState, snapshot: &Task) -> Result<(), AppError> {
    restore_task_fields(state, snapshot).await?;
    Ok(())
}

pub(crate) async fn undo_deleted(
    state: &AppState,
    snapshot: &Task,
    checkpoints: &[Checkpoint],
) -> Result<(), AppError> {
    sqlx::query("UPDATE tasks SET archived_at = NULL WHERE id = $1")
        .bind(snapshot.id)
        .execute(&state.pool)
        .await?;
    for cp in checkpoints {
        sqlx::query(
            "INSERT INTO task_checkpoints (id, task_id, offset_days, due_date, status) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
        )
        .bind(cp.id)
        .bind(cp.task_id)
        .bind(cp.offset_days)
        .bind(cp.due_date)
        .bind(&cp.status)
        .execute(&state.pool)
        .await?;
        if cp.status == "todo" {
            spawn_checkpoint_sync(state, cp.id, &snapshot.title, cp.offset_days, cp.due_date);
        }
    }
    spawn_calendar_sync(state, snapshot);
    Ok(())
}

// A trailing "#word" anywhere in the raw entry is an explicit, deterministic
// category override - lets you pin exactly where a task lands instead of
// hoping the LLM's free-text category guess matches what you meant.
fn explicit_category(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .find_map(|w| w.strip_prefix('#'))
        .map(|s| s.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|s| !s.is_empty())
}

// A trailing "@time" anywhere in the raw entry is an explicit, deterministic
// due-time override, the same idea as "#tag" for category - lets you pin an
// exact clock time (a meeting, a presentation) instead of relying on the
// model to notice a time phrase and format it correctly. Accepts common
// shorthand ("@3pm", "@3:30pm", "@15:30") since this is typed by hand.
fn explicit_time(raw: &str) -> Option<NaiveTime> {
    raw.split_whitespace()
        .find_map(|w| w.strip_prefix('@'))
        .and_then(parse_flexible_time)
}

fn parse_flexible_time(s: &str) -> Option<NaiveTime> {
    let cleaned = s.trim_matches(|c: char| !c.is_alphanumeric() && c != ':');
    let upper = cleaned.to_uppercase();
    ["%I:%M%p", "%I%p", "%H:%M", "%H:%M:%S"]
        .iter()
        .find_map(|fmt| NaiveTime::parse_from_str(&upper, fmt).ok())
}

// Byte offset of a "note:" marker, matched ASCII-case-insensitively. Every
// byte of the needle is ASCII, so a hit is always on a char boundary and the
// index is safe to slice on.
fn note_marker(s: &str) -> Option<usize> {
    s.as_bytes().windows(5).position(|w| w.eq_ignore_ascii_case(b"note:"))
}

// "note:" anywhere in the raw entry means everything after it is the note,
// verbatim - the third deterministic marker alongside "#tag" and "@time".
// Without it the model decides for itself what counts as a note, which is how
// "remove the due date" ended up filed as a note rather than acted on.
fn explicit_note(raw: &str) -> Option<String> {
    let idx = note_marker(raw)?;
    let note = raw[idx + 5..].trim();
    (!note.is_empty()).then(|| note.to_string())
}

// The LLM is told to leave any "#tag"/"@time"/"note:" out of the title, but
// strip them here too as a backstop in case it echoes one back verbatim.
fn is_unit_word(w: &str) -> bool {
    matches!(w, "h" | "hr" | "hrs" | "hour" | "hours" | "m" | "min" | "mins" | "minute" | "minutes")
}

fn is_number(w: &str) -> bool {
    !w.is_empty()
        && w.chars().all(|c| c.is_ascii_digit() || c == '.')
        && w.chars().any(|c| c.is_ascii_digit())
}

/// A duration written as one word: "40min", "1hr", "2h30". A word that merely
/// ends in digits is not one - "ps5" and "1968" have to survive.
fn is_glued_duration(w: &str) -> bool {
    let digits: String = w.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if digits.is_empty() {
        return false;
    }
    let rest = &w[digits.len()..];
    is_unit_word(rest) || rest.strip_prefix('h').is_some_and(is_number)
}

/// How long the user said something takes, written inline the way `#tag` and
/// `@time` are: "physics ps5 1 hr", "email coach 20min". Read from the head of
/// the entry only - a duration inside a `note:` is time spent, not an estimate.
fn explicit_effort(raw: &str) -> Option<i32> {
    let head = match note_marker(raw) {
        Some(idx) => &raw[..idx],
        None => raw,
    };
    effort_from_text(head)
}

fn weekday_alias(w: &str) -> Option<u32> {
    Some(match w {
        "sunday" | "sun" => 0,
        "monday" | "mon" => 1,
        "tuesday" | "tue" | "tues" => 2,
        "wednesday" | "wed" | "weds" => 3,
        "thursday" | "thu" | "thur" | "thurs" => 4,
        "friday" | "fri" => 5,
        "saturday" | "sat" => 6,
        _ => return None,
    })
}

fn month_alias(w: &str) -> Option<u32> {
    Some(match w {
        "jan" | "january" => 1,
        "feb" | "february" => 2,
        "mar" | "march" => 3,
        "apr" | "april" => 4,
        "may" => 5,
        "jun" | "june" => 6,
        "jul" | "july" => 7,
        "aug" | "august" => 8,
        "sep" | "sept" | "september" => 9,
        "oct" | "october" => 10,
        "nov" | "november" => 11,
        "dec" | "december" => 12,
        _ => return None,
    })
}

// The nearest occurrence on or after today; "next" only differs on the day
// itself. Same rule as `nextWeekday` in localParse.ts.
fn next_weekday(today: NaiveDate, target: u32, strict: bool) -> NaiveDate {
    let from = today.weekday().num_days_from_sunday();
    let mut delta = (target + 7 - from) % 7;
    if delta == 0 && strict {
        delta = 7;
    }
    today + Duration::days(delta as i64)
}

fn month_day(today: NaiveDate, month: u32, day: u32) -> Option<NaiveDate> {
    let this_year = NaiveDate::from_ymd_opt(today.year(), month, day)?;
    if this_year >= today {
        Some(this_year)
    } else {
        NaiveDate::from_ymd_opt(today.year() + 1, month, day)
    }
}

fn date_word(w: &str) -> String {
    let w = w.to_lowercase();
    let w = w.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '/' || c == '-'));
    w.strip_suffix("'s").unwrap_or(w).to_string()
}

/// The deadline an entry names, worked out here rather than by the model,
/// which gets weekday arithmetic wrong often enough to matter ("due saturday"
/// landing on friday). A port of `findDate` in localParse.ts, so the row drawn
/// before the request leaves agrees with the one that comes back.
///
/// Only an unambiguous answer counts: phrases led by "due"/"by"/"to"/... win
/// over bare ones (so "friday quiz due monday" is monday), and if what's left
/// still names two different days the model is trusted instead, since that is
/// usually two tasks in one entry. Read from the head only, as with effort.
pub fn explicit_due(raw: &str, today: NaiveDate) -> Option<NaiveDate> {
    let head = match note_marker(raw) {
        Some(idx) => &raw[..idx],
        None => raw,
    };
    let words: Vec<&str> = head
        .split_whitespace()
        .filter(|w| !w.starts_with('#') && !w.starts_with('@'))
        .collect();
    let lead = |i: usize| {
        i > 0
            && matches!(
                date_word(words[i - 1]).as_str(),
                "due" | "by" | "on" | "before" | "to" | "until" | "till" | "til"
            )
    };

    let mut hits: Vec<(NaiveDate, bool)> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let w = date_word(words[i]);
        let next = words.get(i + 1).map(|s| date_word(s)).unwrap_or_default();
        let after = words.get(i + 2).map(|s| date_word(s)).unwrap_or_default();
        let (date, used) = match w.as_str() {
            "today" | "tonight" | "tonite" => (Some(today), 1),
            "tomorrow" | "tmrw" | "tmr" | "tmw" | "tomo" => (Some(today + Duration::days(1)), 1),
            "next" if next == "week" => (Some(today + Duration::days(7)), 2),
            "next" => (weekday_alias(&next).map(|d| next_weekday(today, d, true)), 2),
            "this" | "coming" => (weekday_alias(&next).map(|d| next_weekday(today, d, false)), 2),
            "in" if is_number(&next) && matches!(after.as_str(), "day" | "days" | "week" | "weeks") => {
                let n = next.parse::<f64>().unwrap_or(0.0) as i64;
                let days = if after.starts_with("week") { n * 7 } else { n };
                (Some(today + Duration::days(days)), 3)
            }
            "in" if matches!(next.as_str(), "a" | "one") && after == "week" => {
                (Some(today + Duration::days(7)), 3)
            }
            _ => {
                if let Some(d) = weekday_alias(&w) {
                    (Some(next_weekday(today, d, false)), 1)
                } else if let (Some(m), Ok(d)) = (month_alias(&w), next.parse::<u32>()) {
                    (month_day(today, m, d), 2)
                } else if let Ok(d) = NaiveDate::parse_from_str(&w, "%Y-%m-%d") {
                    (Some(d), 1)
                } else {
                    let parts: Vec<&str> = w.split('/').collect();
                    match parts[..] {
                        [m, d] | [m, d, _] => match (m.parse::<u32>(), d.parse::<u32>()) {
                            (Ok(m), Ok(d)) => (month_day(today, m, d), 1),
                            _ => (None, 1),
                        },
                        _ => (None, 1),
                    }
                }
            }
        };
        match date {
            Some(d) => {
                hits.push((d, lead(i)));
                i += used;
            }
            None => i += 1,
        }
    }

    let led: Vec<NaiveDate> = hits.iter().filter(|h| h.1).map(|h| h.0).collect();
    let pool = if led.is_empty() { hits.iter().map(|h| h.0).collect() } else { led };
    let first = *pool.first()?;
    pool.iter().all(|d| *d == first).then_some(first)
}

fn strip_markers(title: &str) -> String {
    let head = match note_marker(title) {
        Some(idx) => &title[..idx],
        None => title,
    };
    let words: Vec<&str> = head.split_whitespace().collect();
    let mut out: Vec<&str> = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        let lower = w.to_lowercase();
        if w.starts_with('#') || w.starts_with('@') || is_glued_duration(&lower) {
            i += 1;
            continue;
        }
        // A bare number is only a duration when the word after it is a unit,
        // which is what keeps "read 30 pages" intact.
        if is_number(&lower) && words.get(i + 1).is_some_and(|n| is_unit_word(&n.to_lowercase())) {
            i += 2;
            continue;
        }
        out.push(w);
        i += 1;
    }
    out.join(" ")
}

pub async fn apply(state: &AppState, raw: &str, mut req: TaskRequest) -> Result<Log, AppError> {
    if let Some(tag) = explicit_category(raw) {
        req.category = Some(tag);
    }
    if let Some(time) = explicit_time(raw) {
        req.due_time = Some(time.format("%H:%M").to_string());
    }
    if let Some(note) = explicit_note(raw) {
        req.note = Some(note);
    }
    // Beats whatever the model guessed, the same way #tag beats its category.
    if let Some(minutes) = explicit_effort(raw) {
        req.effort_minutes = Some(minutes);
    }
    req.title = strip_markers(&req.title);

    let open = open_tasks(state).await?;
    let matched = best_match(&open, &req.title).cloned();

    let (task, action, previous_due_date) = match matched {
        Some(existing)
            if req.status.is_some()
                || req.due_date.is_some()
                || req.due_time.is_some()
                || req.note.is_some()
                || req.category.is_some()
                || req.is_exam.is_some() =>
        {
            let snapshot = existing.clone();
            let was_due = existing.due_date;
            let (task, action) = update_task(state, &existing, &req).await?;
            undo::record(state, Effect::TasksUpdated(vec![snapshot]));
            let moved_date = action == "rescheduled" && was_due != task.due_date;
            (task, action, moved_date.then_some(was_due).flatten())
        }
        _ => {
            let task = create_task(state, &req).await?;
            undo::record(state, Effect::TaskCreated(task.id));
            (task, "created".to_string(), None)
        }
    };

    let data = TaskData {
        task_id: task.id,
        title: task.title.clone(),
        category: task.category.clone(),
        due_date: task.due_date,
        due_time: task.due_time,
        status: task.status.clone(),
        is_exam: task.is_exam,
        action,
        note: req.note,
        previous_due_date,
        previous_title: None,
    };

    let log: Log = sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'task', $2) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(raw)
    .bind(serde_json::to_value(&data).unwrap())
    .fetch_one(&state.pool)
    .await?;
    Ok(log)
}

#[derive(Debug, Serialize)]
pub struct TaskWithCheckpoints {
    #[serde(flatten)]
    pub task: Task,
    pub checkpoints: Vec<Checkpoint>,
}

pub async fn list_tasks(State(state): State<AppState>) -> Result<Json<Vec<TaskWithCheckpoints>>, AppError> {
    let tasks: Vec<Task> = sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE archived_at IS NULL \
         ORDER BY due_date NULLS LAST, created_at"
    ))
    .fetch_all(&state.pool)
    .await?;
    let mut out = Vec::with_capacity(tasks.len());
    for task in tasks {
        let checkpoints: Vec<Checkpoint> = sqlx::query_as(
            "SELECT id, task_id, offset_days, due_date, status FROM task_checkpoints \
             WHERE task_id = $1 ORDER BY due_date",
        )
        .bind(task.id)
        .fetch_all(&state.pool)
        .await?;
        out.push(TaskWithCheckpoints { task, checkpoints });
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
pub struct PatchTask {
    pub title: Option<String>,
    pub status: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub category: Option<String>,
    pub effort_minutes: Option<i32>,
    pub is_exam: Option<bool>,
    // Editing the field replaces it, unlike a typed progress note, which
    // appends (see update_task). Correcting a note you can see on screen has
    // to be able to shorten it, not only grow it.
    pub note: Option<String>,
    // update_task COALESCEs effort_minutes, so a null there means "leave it
    // alone" and there is otherwise no way to take an estimate back off.
    #[serde(default)]
    pub clear_effort: bool,
    // Set by the timeline's own row editor. That row is already the history
    // of the change it is correcting, so writing another one beside it would
    // log the correction twice.
    #[serde(default)]
    pub quiet: bool,
}

/// What a click in the sidequests panel did, worded the way the timeline
/// words the same change typed. One row per click, so a patch touching
/// several fields reports the one you would see: status, then the date, the
/// section, the name, the note. The frontend draws its own copy of this row
/// before the response lands (`history.ts`), so the two have to agree word
/// for word or the swap reads as an edit.
pub(crate) fn history_of(before: &Task, after: &Task, note_changed: bool) -> Option<(String, TaskData)> {
    let mut data = TaskData {
        task_id: after.id,
        title: after.title.clone(),
        category: after.category.clone(),
        due_date: after.due_date,
        due_time: after.due_time,
        status: after.status.clone(),
        is_exam: after.is_exam,
        action: String::new(),
        note: None,
        previous_due_date: None,
        previous_title: None,
    };
    let title = &after.title;
    let raw = if after.status != before.status {
        data.action = "status".into();
        match after.status.as_str() {
            "done" => format!("finished {title}"),
            "in_progress" => format!("started {title}"),
            _ => format!("reopened {title}"),
        }
    } else if after.due_date != before.due_date {
        data.action = "rescheduled".into();
        data.previous_due_date = before.due_date;
        match after.due_date {
            Some(d) => format!("moved {title} to {}", d.format("%a %b %-d")),
            None => format!("cleared the due date on {title}"),
        }
    } else if after.is_exam != before.is_exam || after.category != before.category {
        data.action = "moved".into();
        format!("moved {title} to {}", if after.is_exam { "exam" } else { &after.category })
    } else if after.title != before.title {
        data.action = "renamed".into();
        data.previous_title = Some(before.title.clone());
        format!("renamed {} to {title}", before.title)
    } else if note_changed && after.note != before.note {
        data.action = "note".into();
        data.note = after.note.clone();
        match &after.note {
            Some(n) => format!("{title}: {n}"),
            None => format!("cleared the note on {title}"),
        }
    } else {
        return None;
    };
    Some((raw, data))
}

async fn insert_history(state: &AppState, raw: &str, data: &TaskData) -> Result<Log, AppError> {
    Ok(sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'task', $2) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(raw)
    .bind(serde_json::to_value(data).unwrap())
    .fetch_one(&state.pool)
    .await?)
}

// The timeline row rides back with the task, so the panel can hand it to the
// timeline without the timeline having to go and fetch the day again.
#[derive(Debug, Serialize)]
pub struct Patched {
    #[serde(flatten)]
    task: Task,
    history: Option<Log>,
}

pub async fn patch_task(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchTask>,
) -> Result<Json<Patched>, AppError> {
    if let Some(s) = &body.status {
        if !matches!(s.as_str(), "not_started" | "in_progress" | "done") {
            return Err(AppError::BadRequest("bad status".into()));
        }
    }
    let existing: Option<Task> = sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE id = $1 AND archived_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let existing = existing.ok_or(AppError::NotFound)?;
    undo::begin(&state);

    let req = TaskRequest {
        title: existing.title.clone(),
        category: body.category,
        due_date: body.due_date,
        due_time: body.due_time,
        effort_minutes: body.effort_minutes,
        status: body.status,
        is_exam: body.is_exam,
        note: None,
        clear_due_date: false,
    };
    let snapshot = existing.clone();
    let (mut task, _) = update_task(&state, &existing, &req).await?;

    // Both applied after update_task rather than through it: it treats title
    // as the thing to match an existing task *by*, and appends to note rather
    // than replacing. Editing either field on screen means replace.
    if body.clear_effort {
        task = sqlx::query_as(&format!(
            "UPDATE tasks SET effort_minutes = NULL WHERE id = $1 RETURNING {TASK_COLUMNS}"
        ))
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    }

    let new_title = body.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if new_title.is_some() || body.note.is_some() {
        let note = body.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
        task = sqlx::query_as(&format!(
            "UPDATE tasks SET \
                title = COALESCE($2, title), \
                note = CASE WHEN $3 THEN $4 ELSE note END \
             WHERE id = $1 RETURNING {TASK_COLUMNS}"
        ))
        .bind(id)
        .bind(new_title)
        .bind(body.note.is_some())
        .bind(note)
        .fetch_one(&state.pool)
        .await?;
    }

    // The title is baked into the calendar event summaries - the task's own
    // and each pending checkpoint's ("study: X (7d out)") - so a rename has to
    // push them again. update_task already synced, but with the old name.
    if new_title.is_some_and(|t| t != existing.title) {
        spawn_calendar_sync(&state, &task);
        let pending: Vec<Checkpoint> = sqlx::query_as(
            "SELECT id, task_id, offset_days, due_date, status FROM task_checkpoints \
             WHERE task_id = $1 AND status = 'todo'",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await?;
        for cp in pending {
            spawn_checkpoint_sync(&state, cp.id, &task.title, cp.offset_days, cp.due_date);
        }
    }

    let history = match history_of(&existing, &task, body.note.is_some()) {
        Some((raw, data)) if !body.quiet => Some(insert_history(&state, &raw, &data).await?),
        _ => None,
    };

    undo::record(&state, Effect::TasksUpdated(vec![snapshot]));
    // Recorded after the task snapshot so undo replays them in reverse and the
    // timeline row goes before the task is put back.
    if let Some(log) = &history {
        undo::record(&state, Effect::LogsCreated(vec![log.id]));
    }
    Ok(Json(Patched { task, history }))
}

pub(crate) async fn archive_task(state: &AppState, id: Uuid) -> Result<bool, AppError> {
    let existing: Option<Task> = sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE id = $1 AND archived_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(existing) = existing else { return Ok(false) };

    let checkpoints: Vec<Checkpoint> = sqlx::query_as(
        "SELECT id, task_id, offset_days, due_date, status FROM task_checkpoints WHERE task_id = $1",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    sqlx::query("UPDATE tasks SET archived_at = now() WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    spawn_calendar_delete(state, id);
    clear_pending_checkpoints(state, id).await?;
    undo::record(state, Effect::TaskDeleted { snapshot: existing, checkpoints });
    Ok(true)
}

// Called from routes::delete_log when the deleted timeline entry was a task
// action - removing the entry should take the real task with it too. Not an
// error if the task is already gone (e.g. deleting an older "rescheduled"
// log line for a task that was since completed or removed some other way).
pub(crate) async fn cascade_delete(state: &AppState, task_id: Uuid) -> Result<(), AppError> {
    archive_task(state, task_id).await?;
    Ok(())
}

pub async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Log>, AppError> {
    let existing: Option<Task> = sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE id = $1 AND archived_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let existing = existing.ok_or(AppError::NotFound)?;
    undo::begin(&state);
    archive_task(&state, id).await?;
    let data = TaskData {
        task_id: existing.id,
        title: existing.title.clone(),
        category: existing.category.clone(),
        due_date: existing.due_date,
        due_time: existing.due_time,
        status: existing.status.clone(),
        is_exam: existing.is_exam,
        action: "deleted".to_string(),
        note: None,
        previous_due_date: None,
        previous_title: None,
    };
    // Recorded after archive_task's own snapshot, so undo takes the row away
    // before it brings the sidequest back.
    let log = insert_history(&state, &format!("deleted {}", existing.title), &data).await?;
    undo::record(&state, Effect::LogsCreated(vec![log.id]));
    Ok(Json(log))
}

#[derive(Debug, Deserialize)]
pub struct NewCheckpoint {
    pub offset_days: i32,
}

pub async fn create_checkpoint(
    State(state): State<AppState>,
    Path(task_id): Path<Uuid>,
    Json(body): Json<NewCheckpoint>,
) -> Result<Json<Checkpoint>, AppError> {
    if !(1..=90).contains(&body.offset_days) {
        return Err(AppError::BadRequest("offset must be 1-90 days".into()));
    }
    let task: Option<(String, Option<NaiveDate>)> =
        sqlx::query_as("SELECT title, due_date FROM tasks WHERE id = $1")
            .bind(task_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((title, due)) = task else { return Err(AppError::NotFound) };
    let Some(due) = due else {
        return Err(AppError::BadRequest("task has no due date to count back from".into()));
    };
    let taken: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM task_checkpoints WHERE task_id = $1 AND offset_days = $2",
    )
    .bind(task_id)
    .bind(body.offset_days)
    .fetch_one(&state.pool)
    .await?;
    if taken > 0 {
        return Err(AppError::BadRequest(format!("already a {}d checkpoint", body.offset_days)));
    }

    let cp: Checkpoint = sqlx::query_as(
        "INSERT INTO task_checkpoints (task_id, offset_days, due_date) VALUES ($1, $2, $3) \
         RETURNING id, task_id, offset_days, due_date, status",
    )
    .bind(task_id)
    .bind(body.offset_days)
    .bind(due - Duration::days(body.offset_days as i64))
    .fetch_one(&state.pool)
    .await?;
    spawn_checkpoint_sync(&state, cp.id, &title, cp.offset_days, cp.due_date);
    Ok(Json(cp))
}

pub async fn delete_checkpoint(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let gone = sqlx::query("DELETE FROM task_checkpoints WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if gone == 0 {
        return Err(AppError::NotFound);
    }
    spawn_checkpoint_delete(&state, id);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct PatchCheckpoint {
    pub status: Option<String>,
    pub offset_days: Option<i32>,
}

pub async fn patch_checkpoint(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchCheckpoint>,
) -> Result<Json<Checkpoint>, AppError> {
    if let Some(status) = body.status.as_deref() {
        if !matches!(status, "todo" | "done") {
            return Err(AppError::BadRequest("bad status".into()));
        }
    }

    // An offset is only meaningful relative to the exam it counts back from,
    // so moving one moves its date too rather than leaving the two disagreeing.
    let mut new_due: Option<NaiveDate> = None;
    if let Some(offset) = body.offset_days {
        if !(1..=90).contains(&offset) {
            return Err(AppError::BadRequest("offset must be 1-90 days".into()));
        }
        let row: Option<(Option<NaiveDate>, i64)> = sqlx::query_as(
            "SELECT t.due_date, (SELECT COUNT(*) FROM task_checkpoints o \
               WHERE o.task_id = c.task_id AND o.id <> c.id AND o.offset_days = $2) \
             FROM task_checkpoints c JOIN tasks t ON t.id = c.task_id WHERE c.id = $1",
        )
        .bind(id)
        .bind(offset)
        .fetch_optional(&state.pool)
        .await?;
        let Some((task_due, taken)) = row else { return Err(AppError::NotFound) };
        let Some(task_due) = task_due else {
            return Err(AppError::BadRequest("task has no due date to count back from".into()));
        };
        if taken > 0 {
            return Err(AppError::BadRequest(format!("already a {offset}d checkpoint")));
        }
        new_due = Some(task_due - Duration::days(offset as i64));
    }

    let cp: Option<Checkpoint> = sqlx::query_as(
        "UPDATE task_checkpoints SET status = COALESCE($2::text, status), \
           offset_days = COALESCE($3::int, offset_days), \
           due_date = COALESCE($4::date, due_date) \
         WHERE id = $1 \
         RETURNING id, task_id, offset_days, due_date, status",
    )
    .bind(id)
    .bind(&body.status)
    .bind(body.offset_days)
    .bind(new_due)
    .fetch_optional(&state.pool)
    .await?;
    let Some(cp) = cp else { return Err(AppError::NotFound) };

    if cp.status == "done" {
        spawn_checkpoint_delete(&state, cp.id);
    } else {
        let title: Option<(String,)> = sqlx::query_as("SELECT title FROM tasks WHERE id = $1")
            .bind(cp.task_id)
            .fetch_optional(&state.pool)
            .await?;
        if let Some((title,)) = title {
            spawn_checkpoint_sync(&state, cp.id, &title, cp.offset_days, cp.due_date);
        }
    }

    Ok(Json(cp))
}

/// Minutes of work read out of free text: "3 hr", "1.5h", "30m", "2h30",
/// "45 minutes". Used as a fallback when a sidequest has no explicit estimate,
/// because people wrote their estimates into the note before there was a field
/// for them. A bare number with no unit is ignored - "physics ps5" and "read
/// pages 30-40" are not durations - except directly after an hours figure,
/// which is how "2h30" is written.
pub(crate) fn effort_from_text(s: &str) -> Option<i32> {
    let lower = s.to_lowercase();
    let b = lower.as_bytes();
    let mut total = 0.0f64;
    let mut found = false;
    let mut after_hours = false;
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            // Only whitespace may sit between "2h" and its "30".
            if !b[i].is_ascii_whitespace() {
                after_hours = false;
            }
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
            i += 1;
        }
        let Ok(n) = lower[start..i].parse::<f64>() else {
            after_hours = false;
            continue;
        };
        let mut j = i;
        while j < b.len() && b[j] == b' ' {
            j += 1;
        }
        let unit_start = j;
        while j < b.len() && b[j].is_ascii_alphabetic() {
            j += 1;
        }
        let unit = &lower[unit_start..j];
        if unit.starts_with("hr") || unit == "h" || unit.starts_with("hour") {
            total += n * 60.0;
            found = true;
            after_hours = true;
            i = j;
        } else if unit == "m" || unit.starts_with("min") {
            total += n;
            found = true;
            after_hours = false;
            i = j;
        } else if after_hours && unit.is_empty() {
            total += n;
            after_hours = false;
        }
    }
    let minutes = total.round() as i32;
    // A whole day of work in one sidequest is a typo, not an estimate.
    (found && minutes > 0 && minutes <= 16 * 60).then_some(minutes)
}

#[cfg(test)]
mod tests {
    use super::{effort_from_text, explicit_due, explicit_effort, explicit_note, history_of, strip_markers, Task};
    use chrono::NaiveDate;

    fn day(s: &str) -> Option<NaiveDate> {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
    }

    fn task() -> Task {
        Task {
            id: uuid::Uuid::nil(),
            title: "chem lab".into(),
            category: "homework".into(),
            due_date: day("2026-10-30"),
            due_time: None,
            effort_minutes: None,
            status: "not_started".into(),
            is_exam: false,
            note: None,
            created_at: chrono::Utc::now(),
            completed_at: None,
        }
    }

    // history.ts draws these same words before the server answers.
    #[test]
    fn history_wording() {
        let before = task();
        let raw = |after: Task, note: bool| history_of(&before, &after, note).map(|(r, d)| (r, d.action));

        let done = Task { status: "done".into(), ..task() };
        assert_eq!(raw(done, false), Some(("finished chem lab".into(), "status".into())));
        let started = Task { status: "in_progress".into(), ..task() };
        assert_eq!(raw(started, false), Some(("started chem lab".into(), "status".into())));
        let exam = Task { is_exam: true, ..task() };
        assert_eq!(raw(exam, false), Some(("moved chem lab to exam".into(), "moved".into())));
        let club = Task { category: "club".into(), ..task() };
        assert_eq!(raw(club, false), Some(("moved chem lab to club".into(), "moved".into())));
        let later = Task { due_date: day("2026-11-02"), ..task() };
        assert_eq!(raw(later, false), Some(("moved chem lab to Mon Nov 2".into(), "rescheduled".into())));
        let renamed = Task { title: "chem writeup".into(), ..task() };
        assert_eq!(
            raw(renamed, false),
            Some(("renamed chem lab to chem writeup".into(), "renamed".into()))
        );
        let noted = Task { note: Some("just the graphs".into()), ..task() };
        assert_eq!(raw(noted.clone(), true), Some(("chem lab: just the graphs".into(), "note".into())));
        // A patch that names the note but leaves it as it was writes nothing.
        assert_eq!(raw(task(), true), None);
        assert_eq!(raw(noted, false), None);
    }

    #[test]
    fn a_weekday_resolves_to_the_coming_one() {
        // 2026-10-27 is a tuesday.
        let today = day("2026-10-27").unwrap();
        assert_eq!(explicit_due("chem lab due saturday", today), day("2026-10-31"));
        assert_eq!(explicit_due("move chem lab to sat", today), day("2026-10-31"));
        assert_eq!(explicit_due("chem lab due tuesday", today), day("2026-10-27"));
        assert_eq!(explicit_due("chem lab due monday", today), day("2026-11-02"));
        assert_eq!(explicit_due("chem lab next tuesday", today), day("2026-11-03"));
        assert_eq!(explicit_due("chem lab next friday", today), day("2026-10-30"));
        assert_eq!(explicit_due("chem lab tomorrow", today), day("2026-10-28"));
        assert_eq!(explicit_due("chem lab in 3 days", today), day("2026-10-30"));
        assert_eq!(explicit_due("chem lab due nov 3", today), day("2026-11-03"));
        assert_eq!(explicit_due("chem lab due 1/5", today), day("2027-01-05"));
    }

    #[test]
    fn a_weekday_in_the_title_loses_to_the_deadline() {
        let today = day("2026-10-27").unwrap();
        assert_eq!(explicit_due("friday quiz review due monday", today), day("2026-11-02"));
        assert_eq!(explicit_due("study for friday's quiz by thursday", today), day("2026-10-29"));
        assert_eq!(explicit_due("chem lab due saturday #homework @3pm", today), day("2026-10-31"));
    }

    #[test]
    fn two_different_deadlines_are_left_to_the_model() {
        let today = day("2026-10-27").unwrap();
        assert_eq!(explicit_due("chem lab due friday and essay due monday", today), None);
        assert_eq!(explicit_due("chem lab note: moved from friday", today), None);
        assert_eq!(explicit_due("chem lab done", today), None);
    }

    #[test]
    fn a_duration_typed_into_an_entry_becomes_the_estimate() {
        assert_eq!(explicit_effort("physics ps5 1 hr"), Some(60));
        assert_eq!(explicit_effort("email coach 20min"), Some(20));
        assert_eq!(explicit_effort("research compilation 2.5 hours #homework @5pm"), Some(150));
        assert_eq!(explicit_effort("lit paragraph"), None);
        // Inside a note it is time already spent, not an estimate.
        assert_eq!(explicit_effort("psych notes note: took me 3 hours"), None);
    }

    #[test]
    fn stripping_a_duration_leaves_the_title_alone() {
        assert_eq!(strip_markers("physics ps5 1 hr"), "physics ps5");
        assert_eq!(strip_markers("email coach 20min"), "email coach");
        assert_eq!(strip_markers("write up the 1968 paper"), "write up the 1968 paper");
        assert_eq!(strip_markers("read 30 pages"), "read 30 pages");
        assert_eq!(strip_markers("finish level 2 of the course"), "finish level 2 of the course");
        assert_eq!(strip_markers("research 2h30 #homework @5pm"), "research");
    }

    #[test]
    fn durations_are_read_out_of_free_text() {
        assert_eq!(effort_from_text("3 hr"), Some(180));
        assert_eq!(effort_from_text("1.5 hr"), Some(90));
        assert_eq!(effort_from_text("30 min"), Some(30));
        assert_eq!(effort_from_text("25m"), Some(25));
        assert_eq!(effort_from_text("2h30"), Some(150));
        assert_eq!(effort_from_text("1h 30m"), Some(90));
        assert_eq!(effort_from_text("takes about 45 minutes i think"), Some(45));
        assert_eq!(effort_from_text("2 hours"), Some(120));
    }

    #[test]
    fn a_bare_number_is_not_a_duration() {
        // Every one of these is a real note that must not become an estimate.
        assert_eq!(effort_from_text("physics ps5"), None);
        assert_eq!(effort_from_text("read pages 30-40"), None);
        assert_eq!(effort_from_text("did 20 of 30 problems"), None);
        assert_eq!(effort_from_text("ch 3 only"), None);
        assert_eq!(effort_from_text(""), None);
        // 20 hours of work on one sidequest is a typo.
        assert_eq!(effort_from_text("20 hr"), None);
    }

    #[test]
    fn note_marker_takes_everything_after_it() {
        assert_eq!(
            explicit_note("psych notes note: started module 4").as_deref(),
            Some("started module 4")
        );
        // Case-insensitive, and "notes" must not be mistaken for the marker.
        assert_eq!(explicit_note("read notes NOTE: ch 3 only").as_deref(), Some("ch 3 only"));
        assert_eq!(explicit_note("psych notes are done").as_deref(), None);
        assert_eq!(explicit_note("psych notes note:   ").as_deref(), None);
    }

    #[test]
    fn strip_markers_drops_the_note_tail_and_tags() {
        assert_eq!(strip_markers("psych notes note: started module 4"), "psych notes");
        assert_eq!(strip_markers("clean the garage #personal @3pm"), "clean the garage");
        assert_eq!(strip_markers("psych notes"), "psych notes");
    }
}
