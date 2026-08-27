use anyhow::Result;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{Duration, NaiveDate, NaiveTime, Utc};
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

const TASK_COLUMNS: &str =
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
    let Some(cfg) = state.caldav.clone() else { return };
    let title = task_title.to_string();
    tokio::spawn(async move {
        let uid = format!("lf-checkpoint-{checkpoint_id}");
        let summary = format!("study: {title} ({offset_days}d out)");
        let ical = crate::caldav::vevent(&uid, &summary, due_date, None);
        if let Err(e) = crate::caldav::put_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password, &ical).await {
            tracing::warn!("checkpoint calendar sync failed for {checkpoint_id}: {e:#}");
        }
    });
}

fn spawn_checkpoint_delete(state: &AppState, checkpoint_id: Uuid) {
    let Some(cfg) = state.caldav.clone() else { return };
    tokio::spawn(async move {
        let uid = format!("lf-checkpoint-{checkpoint_id}");
        if let Err(e) = crate::caldav::delete_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password).await {
            tracing::warn!("checkpoint calendar delete failed for {checkpoint_id}: {e:#}");
        }
    });
}

fn spawn_calendar_sync(state: &AppState, task: &Task) {
    let Some(cfg) = state.caldav.clone() else { return };
    let task = task.clone();
    tokio::spawn(async move {
        let uid = format!("lf-task-{}", task.id);
        let result = match (task.due_date, task.status.as_str()) {
            (Some(due), status) if status != "done" => {
                let label = if task.is_exam { "exam" } else { task.category.as_str() };
                let summary = format!("[{label}] {}", task.title);
                let ical = crate::caldav::vevent(&uid, &summary, due, task.due_time);
                crate::caldav::put_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password, &ical).await
            }
            _ => crate::caldav::delete_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password).await,
        };
        if let Err(e) = result {
            tracing::warn!("calendar sync failed for task {}: {e:#}", task.id);
        }
    });
}

fn spawn_calendar_delete(state: &AppState, task_id: Uuid) {
    let Some(cfg) = state.caldav.clone() else { return };
    tokio::spawn(async move {
        let uid = format!("lf-task-{task_id}");
        if let Err(e) = crate::caldav::delete_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password).await {
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
            effort_minutes = $5, note = $6, completed_at = $7 \
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
fn strip_markers(title: &str) -> String {
    let head = match note_marker(title) {
        Some(idx) => &title[..idx],
        None => title,
    };
    head.split_whitespace()
        .filter(|w| !w.starts_with('#') && !w.starts_with('@'))
        .collect::<Vec<_>>()
        .join(" ")
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
    req.title = strip_markers(&req.title);

    let open = open_tasks(state).await?;
    let matched = best_match(&open, &req.title).cloned();

    let (task, action) = match matched {
        Some(existing)
            if req.status.is_some()
                || req.due_date.is_some()
                || req.due_time.is_some()
                || req.note.is_some()
                || req.category.is_some()
                || req.is_exam.is_some() =>
        {
            let snapshot = existing.clone();
            let (task, action) = update_task(state, &existing, &req).await?;
            undo::record(state, Effect::TasksUpdated(vec![snapshot]));
            (task, action)
        }
        _ => {
            let task = create_task(state, &req).await?;
            undo::record(state, Effect::TaskCreated(task.id));
            (task, "created".to_string())
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
}

pub async fn patch_task(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchTask>,
) -> Result<Json<Task>, AppError> {
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
    // Set after update_task rather than through it: its note handling appends,
    // which is right for a typed check-in and wrong for editing the field.
    if let Some(note) = body.note {
        let note = note.trim();
        task = sqlx::query_as(&format!(
            "UPDATE tasks SET note = $2 WHERE id = $1 RETURNING {TASK_COLUMNS}"
        ))
        .bind(id)
        .bind((!note.is_empty()).then_some(note))
        .fetch_one(&state.pool)
        .await?;
    }
    undo::record(&state, Effect::TasksUpdated(vec![snapshot]));
    Ok(Json(task))
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
) -> Result<StatusCode, AppError> {
    undo::begin(&state);
    if !archive_task(&state, id).await? {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct PatchCheckpoint {
    pub status: String,
}

pub async fn patch_checkpoint(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchCheckpoint>,
) -> Result<Json<Checkpoint>, AppError> {
    if !matches!(body.status.as_str(), "todo" | "done") {
        return Err(AppError::BadRequest("bad status".into()));
    }
    let cp: Option<Checkpoint> = sqlx::query_as(
        "UPDATE task_checkpoints SET status = $2 WHERE id = $1 \
         RETURNING id, task_id, offset_days, due_date, status",
    )
    .bind(id)
    .bind(&body.status)
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

#[cfg(test)]
mod tests {
    use super::{explicit_note, strip_markers};

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
