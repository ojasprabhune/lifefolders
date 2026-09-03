use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{Duration, NaiveDate, NaiveTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::routes::AppError;
use crate::tasks::{self, Task};
use crate::{focus, groq, sleep, AppState};

const DEFAULT_BREAK_MIN: i32 = 30;
const NO_ESTIMATE_MIN: i32 = 30;
/// A spaced-review session with no estimate of its own. Shorter than a default
/// task block on purpose - a 1d-out review is a run-through, not the work.
const REVIEW_MIN: i32 = 30;

/// Meals the generated plan leaves free. Data rather than prose in the prompt,
/// so moving one is an edit here.
pub const MEAL_BREAKS: [(&str, &str, &str); 2] =
    [("12:30", "13:30", "lunch"), ("20:30", "21:00", "dinner")];

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct PlanBlock {
    pub id: Uuid,
    pub position: i32,
    pub kind: String,
    pub task_id: Option<Uuid>,
    pub label: String,
    pub minutes: i32,
    pub pinned_start: Option<NaiveTime>,
}

/// A block with its clock times filled in. Times are never stored - they fall
/// out of walking the list from `starts_at`, which is the whole reason
/// inserting something in the middle re-times everything below it for free.
#[derive(Debug, Serialize)]
pub struct TimedBlock {
    #[serde(flatten)]
    pub block: PlanBlock,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Serialize)]
pub struct DayPlanView {
    pub plan_date: NaiveDate,
    pub starts_at: String,
    pub ends_at: Option<String>,
    pub blocks: Vec<TimedBlock>,
    /// Minutes past `ends_at` the last block runs. 0 when it fits.
    pub overflow_minutes: i32,
    /// The sidequest to drop first if it doesn't fit: the one due furthest
    /// out, breaking ties by the longest, since dropping it buys the most.
    pub push_suggestion: Option<PushSuggestion>,
}

#[derive(Debug, Serialize)]
pub struct PushSuggestion {
    pub task_id: Uuid,
    pub label: String,
    pub minutes: i32,
    pub due_date: Option<NaiveDate>,
}

#[derive(Debug, FromRow)]
struct PlanRow {
    starts_at: NaiveTime,
    ends_at: Option<NaiveTime>,
}

fn hhmm(t: NaiveTime) -> String {
    t.format("%H:%M").to_string()
}

fn minutes_of(t: NaiveTime) -> i32 {
    (t.hour() * 60 + t.minute()) as i32
}

fn round_up_5(m: i32) -> i32 {
    ((m + 4) / 5) * 5
}

fn at_minute(m: i32) -> NaiveTime {
    let m = m.rem_euclid(1440);
    NaiveTime::from_hms_opt((m / 60) as u32, (m % 60) as u32, 0).unwrap()
}

/// Walk the blocks from `starts_at`, giving each one a start and an end. A
/// pinned block jumps the clock forward to its hour rather than starting when
/// the previous one happened to finish; a pin in the past is ignored, because
/// a plan that runs backwards is worse than one that runs late.
fn lay_out(starts_at: NaiveTime, blocks: Vec<PlanBlock>) -> (Vec<TimedBlock>, i32) {
    let mut clock = minutes_of(starts_at);
    let mut out = Vec::with_capacity(blocks.len());
    for block in blocks {
        if let Some(pin) = block.pinned_start {
            let pinned = minutes_of(pin);
            if pinned > clock {
                clock = pinned;
            }
        }
        let start = clock;
        clock += block.minutes;
        out.push(TimedBlock {
            block,
            start: hhmm(at_minute(start)),
            end: hhmm(at_minute(clock)),
        });
    }
    (out, clock)
}

async fn load_blocks(state: &AppState, date: NaiveDate) -> Result<Vec<PlanBlock>, AppError> {
    Ok(sqlx::query_as(
        "SELECT id, position, kind, task_id, label, minutes, pinned_start \
         FROM plan_blocks WHERE plan_date = $1 ORDER BY position",
    )
    .bind(date)
    .fetch_all(&state.pool)
    .await?)
}

async fn view(state: &AppState, date: NaiveDate, row: PlanRow) -> Result<DayPlanView, AppError> {
    let blocks = load_blocks(state, date).await?;
    let (timed, end_minute) = lay_out(row.starts_at, blocks);

    let overflow = match row.ends_at {
        Some(limit) => {
            // The limit is a bedtime, so it is routinely past midnight from
            // the plan's point of view - compare on the same side of the day.
            let mut limit_min = minutes_of(limit);
            if limit_min < minutes_of(row.starts_at) {
                limit_min += 1440;
            }
            (end_minute - limit_min).max(0)
        }
        None => 0,
    };

    let push = suggest_push(state, &timed, date, overflow).await?;

    Ok(DayPlanView {
        plan_date: date,
        starts_at: hhmm(row.starts_at),
        ends_at: row.ends_at.map(hhmm),
        blocks: timed,
        overflow_minutes: overflow,
        push_suggestion: push,
    })
}

/// What the plan is carrying for one sidequest, for deciding what to drop.
#[derive(Debug, Clone)]
struct Candidate {
    task_id: Uuid,
    label: String,
    due_date: Option<NaiveDate>,
    is_exam: bool,
    minutes: i32,
}

/// Which sidequest to drop when the day doesn't fit.
///
/// Work that isn't due today goes first - moving that is a free win, and it is
/// what "push something to tomorrow" actually means. Only if everything in the
/// plan is due today does it suggest one of those, and then never an exam.
/// Within a group it takes the *smallest* block that still clears the
/// overflow: dropping three hours to save forty minutes is not a trade, and
/// the point is to get under the line, not to empty the evening.
fn choose_push(mut candidates: Vec<Candidate>, today: NaiveDate, overflow: i32) -> Option<Candidate> {
    if candidates.is_empty() || overflow <= 0 {
        return None;
    }
    // Exam revision is the last thing to go, ahead of even the deadline test:
    // a study block for tomorrow's quiz is not a spare hour just because the
    // quiz isn't today. Each filter is guarded so it can never empty the list.
    if candidates.iter().any(|c| !c.is_exam) {
        candidates.retain(|c| !c.is_exam);
    }
    let deferrable: Vec<Candidate> =
        candidates.iter().filter(|c| c.due_date.is_none_or(|d| d > today)).cloned().collect();
    if !deferrable.is_empty() {
        candidates = deferrable;
    }
    candidates
        .iter()
        .filter(|c| c.minutes >= overflow)
        .min_by_key(|c| c.minutes)
        .or_else(|| candidates.iter().max_by_key(|c| c.minutes))
        .cloned()
}

async fn suggest_push(
    state: &AppState,
    blocks: &[TimedBlock],
    today: NaiveDate,
    overflow: i32,
) -> Result<Option<PushSuggestion>, AppError> {
    let ids: Vec<Uuid> = blocks.iter().filter_map(|b| b.block.task_id).collect();
    if ids.is_empty() {
        return Ok(None);
    }
    let rows: Vec<(Uuid, String, Option<NaiveDate>, bool)> = sqlx::query_as(
        "SELECT id, title, due_date, is_exam FROM tasks \
         WHERE id = ANY($1) AND status <> 'done' AND archived_at IS NULL",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;

    // A sidequest split around a meal is two blocks; dropping it drops both,
    // so its weight is the total.
    let candidates: Vec<Candidate> = rows
        .into_iter()
        .map(|(task_id, label, due_date, is_exam)| Candidate {
            minutes: blocks
                .iter()
                .filter(|b| b.block.task_id == Some(task_id))
                .map(|b| b.block.minutes)
                .sum(),
            task_id,
            label,
            due_date,
            is_exam,
        })
        .collect();

    Ok(choose_push(candidates, today, overflow).map(|c| PushSuggestion {
        task_id: c.task_id,
        label: c.label,
        minutes: c.minutes,
        due_date: c.due_date,
    }))
}

#[derive(Debug, Deserialize)]
pub struct DateQuery {
    pub date: Option<NaiveDate>,
    pub tz_offset_min: Option<i32>,
    pub goal_min: Option<i64>,
}

fn local_today(offset: i32) -> NaiveDate {
    (Utc::now() - Duration::minutes(offset as i64)).date_naive()
}

/// Read the plan for a date, creating an empty one on first touch so the panel
/// always has a start time and an end time to show and edit.
pub async fn get(
    State(state): State<AppState>,
    Query(q): Query<DateQuery>,
) -> Result<Json<DayPlanView>, AppError> {
    let offset = q.tz_offset_min.unwrap_or(0);
    let date = q.date.unwrap_or_else(|| local_today(offset));
    let row = ensure_row(&state, date, offset, q.goal_min.unwrap_or(480)).await?;
    Ok(Json(view(&state, date, row).await?))
}

async fn ensure_row(
    state: &AppState,
    date: NaiveDate,
    offset: i32,
    goal_min: i64,
) -> Result<PlanRow, AppError> {
    if let Some(row) = sqlx::query_as::<_, PlanRow>(
        "SELECT starts_at, ends_at FROM day_plans WHERE plan_date = $1",
    )
    .bind(date)
    .fetch_optional(&state.pool)
    .await?
    {
        return Ok(row);
    }

    // A new plan starts now if it's for today, and at 9am otherwise. Its end
    // is the bedtime the sleep coach is already asking for, so the two agree.
    let now = Utc::now() - Duration::minutes(offset as i64);
    let starts_at = if date == now.date_naive() {
        at_minute(round_up_5(now.hour() as i32 * 60 + now.minute() as i32))
    } else {
        at_minute(9 * 60)
    };
    let ends_at = sleep::bedtime_target(state, goal_min, offset).await?.map(|m| at_minute(m as i32));

    sqlx::query("INSERT INTO day_plans (plan_date, starts_at, ends_at) VALUES ($1, $2, $3) ON CONFLICT (plan_date) DO NOTHING")
        .bind(date)
        .bind(starts_at)
        .bind(ends_at)
        .execute(&state.pool)
        .await?;
    Ok(PlanRow { starts_at, ends_at })
}

#[derive(Debug, Deserialize)]
pub struct PatchPlan {
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    #[serde(default)]
    pub clear_ends_at: bool,
}

fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s, "%H:%M").ok()
}

pub async fn patch(
    State(state): State<AppState>,
    Query(q): Query<DateQuery>,
    Json(body): Json<PatchPlan>,
) -> Result<Json<DayPlanView>, AppError> {
    let offset = q.tz_offset_min.unwrap_or(0);
    let date = q.date.unwrap_or_else(|| local_today(offset));
    ensure_row(&state, date, offset, q.goal_min.unwrap_or(480)).await?;

    let starts = body.starts_at.as_deref().and_then(parse_hhmm);
    let ends = body.ends_at.as_deref().and_then(parse_hhmm);
    let row: PlanRow = sqlx::query_as(
        "UPDATE day_plans SET \
            starts_at = COALESCE($2, starts_at), \
            ends_at = CASE WHEN $4 THEN NULL ELSE COALESCE($3, ends_at) END, \
            updated_at = now() \
         WHERE plan_date = $1 RETURNING starts_at, ends_at",
    )
    .bind(date)
    .bind(starts)
    .bind(ends)
    .bind(body.clear_ends_at)
    .fetch_one(&state.pool)
    .await?;

    // Moving the day's bounds can strand a meal outside them. Generation
    // already refuses to place one there; this is the same rule applied after
    // the fact, because the usual way you end up with lunch at quarter to four
    // is planning at lunchtime and then pushing the start back.
    let keep = meals_in_window(minutes_of(row.starts_at), window_end(row.starts_at, row.ends_at));
    let stranded: Vec<&str> = MEAL_BREAKS
        .iter()
        .map(|(_, _, what)| *what)
        .filter(|what| !keep.iter().any(|(_, _, k)| k == what))
        .collect();
    if !stranded.is_empty() {
        let hit = sqlx::query(
            "DELETE FROM plan_blocks WHERE plan_date = $1 AND kind = 'break' AND label = ANY($2)",
        )
        .bind(date)
        .bind(&stranded)
        .execute(&state.pool)
        .await?;
        if hit.rows_affected() > 0 {
            renumber(&state, date).await?;
        }
    }

    Ok(Json(view(&state, date, row).await?))
}

#[derive(Debug, Deserialize)]
pub struct NewBlock {
    pub kind: Option<String>,
    pub task_id: Option<Uuid>,
    pub label: Option<String>,
    pub minutes: Option<i32>,
    /// Insert directly after this block. Absent means append to the end.
    pub after: Option<Uuid>,
}

pub async fn add_block(
    State(state): State<AppState>,
    Query(q): Query<DateQuery>,
    Json(body): Json<NewBlock>,
) -> Result<Json<DayPlanView>, AppError> {
    let offset = q.tz_offset_min.unwrap_or(0);
    let date = q.date.unwrap_or_else(|| local_today(offset));
    let row = ensure_row(&state, date, offset, q.goal_min.unwrap_or(480)).await?;

    let kind = body.kind.unwrap_or_else(|| "custom".into());
    let (label, minutes) = match (&kind[..], body.task_id) {
        ("task", Some(id)) => {
            let t: Option<Task> = sqlx::query_as(&format!(
                "SELECT {} FROM tasks WHERE id = $1",
                tasks::TASK_COLUMNS
            ))
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
            let t = t.ok_or(AppError::NotFound)?;
            let est = t
                .effort_minutes
                .or_else(|| t.note.as_deref().and_then(tasks::effort_from_text))
                .unwrap_or(NO_ESTIMATE_MIN);
            (t.title, body.minutes.unwrap_or(est))
        }
        ("break", _) => (
            body.label.unwrap_or_else(|| "break".into()),
            body.minutes.unwrap_or(DEFAULT_BREAK_MIN),
        ),
        _ => (
            body.label.unwrap_or_else(|| "something".into()),
            body.minutes.unwrap_or(NO_ESTIMATE_MIN),
        ),
    };

    // Positions are re-numbered densely on every write, so "insert after X"
    // is just "take X's position plus one and push everything below down".
    let at = match body.after {
        Some(id) => {
            let p: Option<(i32,)> =
                sqlx::query_as("SELECT position FROM plan_blocks WHERE id = $1 AND plan_date = $2")
                    .bind(id)
                    .bind(date)
                    .fetch_optional(&state.pool)
                    .await?;
            p.map(|(p,)| p + 1).unwrap_or(i32::MAX)
        }
        None => i32::MAX,
    };
    sqlx::query("UPDATE plan_blocks SET position = position + 1 WHERE plan_date = $1 AND position >= $2")
        .bind(date)
        .bind(at)
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "INSERT INTO plan_blocks (plan_date, position, kind, task_id, label, minutes) \
         VALUES ($1, LEAST($2, (SELECT COALESCE(MAX(position) + 1, 0) FROM plan_blocks WHERE plan_date = $1)), $3, $4, $5, $6)",
    )
    .bind(date)
    .bind(at)
    .bind(&kind)
    .bind(body.task_id)
    .bind(&label)
    .bind(minutes.max(1))
    .execute(&state.pool)
    .await?;
    renumber(&state, date).await?;
    Ok(Json(view(&state, date, row).await?))
}

#[derive(Debug, Deserialize)]
pub struct PatchBlock {
    pub label: Option<String>,
    pub minutes: Option<i32>,
    pub pinned_start: Option<String>,
    #[serde(default)]
    pub clear_pin: bool,
    /// New index in the list, for a drag.
    pub position: Option<i32>,
}

pub async fn patch_block(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<DateQuery>,
    Json(body): Json<PatchBlock>,
) -> Result<Json<DayPlanView>, AppError> {
    let offset = q.tz_offset_min.unwrap_or(0);
    let date = q.date.unwrap_or_else(|| local_today(offset));
    let row = ensure_row(&state, date, offset, q.goal_min.unwrap_or(480)).await?;

    sqlx::query(
        "UPDATE plan_blocks SET \
            label = COALESCE($2, label), \
            minutes = GREATEST(COALESCE($3, minutes), 1), \
            pinned_start = CASE WHEN $5 THEN NULL ELSE COALESCE($4, pinned_start) END \
         WHERE id = $1",
    )
    .bind(id)
    .bind(body.label.as_deref())
    .bind(body.minutes)
    .bind(body.pinned_start.as_deref().and_then(parse_hhmm))
    .bind(body.clear_pin)
    .execute(&state.pool)
    .await?;

    // A length you set here is the estimate for that sidequest, so it survives
    // a re-plan instead of reverting to the default. Only when the sidequest
    // owns exactly one block, though: a task split around a meal is two, and
    // writing either half back would quietly halve the whole estimate.
    if let Some(mins) = body.minutes.filter(|m| *m > 0) {
        let owner: Option<(Option<Uuid>,)> =
            sqlx::query_as("SELECT task_id FROM plan_blocks WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.pool)
                .await?;
        if let Some((Some(task_id),)) = owner {
            let (blocks,): (i64,) = sqlx::query_as(
                "SELECT count(*) FROM plan_blocks WHERE plan_date = $1 AND task_id = $2",
            )
            .bind(date)
            .bind(task_id)
            .fetch_one(&state.pool)
            .await?;
            if blocks == 1 {
                sqlx::query("UPDATE tasks SET effort_minutes = $2 WHERE id = $1")
                    .bind(task_id)
                    .bind(mins)
                    .execute(&state.pool)
                    .await?;
            }
        }
    }

    if let Some(to) = body.position {
        // `to` is where the row should END UP, counted in the list it leaves
        // behind. Doubling positions and slotting the moved row between two of
        // them was the previous approach and it was quietly wrong in one
        // direction: removing the row shifts every index below it, so moving
        // something down landed it short. Taking the row out and putting it
        // back needs no arithmetic to get wrong.
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM plan_blocks WHERE plan_date = $1 ORDER BY position",
        )
        .bind(date)
        .fetch_all(&state.pool)
        .await?;
        for (i, block_id) in reorder(ids, id, to).iter().enumerate() {
            sqlx::query("UPDATE plan_blocks SET position = $2 WHERE id = $1")
                .bind(block_id)
                .bind(i as i32)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(Json(view(&state, date, row).await?))
}

pub async fn delete_block(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<DateQuery>,
) -> Result<Json<DayPlanView>, AppError> {
    let offset = q.tz_offset_min.unwrap_or(0);
    let date = q.date.unwrap_or_else(|| local_today(offset));
    let row = ensure_row(&state, date, offset, q.goal_min.unwrap_or(480)).await?;
    sqlx::query("DELETE FROM plan_blocks WHERE id = $1 AND plan_date = $2")
        .bind(id)
        .bind(date)
        .execute(&state.pool)
        .await?;
    renumber(&state, date).await?;
    Ok(Json(view(&state, date, row).await?))
}

/// Take `id` out of the list and put it back at index `to`.
fn reorder(ids: Vec<Uuid>, id: Uuid, to: i32) -> Vec<Uuid> {
    let mut rest: Vec<Uuid> = ids.into_iter().filter(|x| *x != id).collect();
    let at = (to.max(0) as usize).min(rest.len());
    rest.insert(at, id);
    rest
}

async fn renumber(state: &AppState, date: NaiveDate) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE plan_blocks b SET position = r.rn - 1 FROM ( \
            SELECT id, ROW_NUMBER() OVER (ORDER BY position, label) AS rn \
            FROM plan_blocks WHERE plan_date = $1 \
         ) r WHERE b.id = r.id AND b.position <> r.rn - 1",
    )
    .bind(date)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Ask the model for a first draft and replace the day's blocks with it. Every
/// edit after this is the user's; regenerating is explicit and destructive on
/// purpose, because merging a fresh plan into a hand-edited one would produce
/// something neither of you asked for.
pub async fn generate(
    State(state): State<AppState>,
    Query(q): Query<DateQuery>,
) -> Result<Json<DayPlanView>, AppError> {
    let offset = q.tz_offset_min.unwrap_or(0);
    let date = q.date.unwrap_or_else(|| local_today(offset));
    Ok(Json(regenerate(&state, date, offset, q.goal_min.unwrap_or(480)).await?))
}

pub(crate) async fn regenerate(
    state: &AppState,
    date: NaiveDate,
    offset: i32,
    goal_min: i64,
) -> Result<DayPlanView, AppError> {
    let mut row = ensure_row(state, date, offset, goal_min).await?;

    // Re-planning today starts from now, not from whenever the plan was first
    // opened - an afternoon start time on an evening re-plan is just wrong.
    // Rounded up to the next five minutes because "start at 6:31" is a time
    // nobody starts at. Only when the stored start has already gone by, though:
    // a start time in the future was typed on purpose, and dragging it back to
    // now isn't re-planning the day, it's overruling you about when it begins.
    let now = Utc::now() - Duration::minutes(offset as i64);
    if date == now.date_naive() {
        let from_now = at_minute(round_up_5(now.hour() as i32 * 60 + now.minute() as i32));
        if row.starts_at < from_now {
            sqlx::query("UPDATE day_plans SET starts_at = $2, updated_at = now() WHERE plan_date = $1")
                .bind(date)
                .bind(from_now)
                .execute(&state.pool)
                .await?;
            row.starts_at = from_now;
        }
    }

    let open = tasks::open_tasks(state).await?;
    let spent = focus::minutes_by_task(state, 14).await?;
    let reviews = due_reviews(state, date).await?;
    let brief = build_brief(&open, &reviews, &spent, date, row.starts_at, row.ends_at);
    let Some(drafted) = groq::plan_blocks(&state.http, &state.groq_key, &brief).await else {
        return Err(AppError::BadRequest("couldn't put a plan together right now".into()));
    };

    sqlx::query("DELETE FROM plan_blocks WHERE plan_date = $1")
        .bind(date)
        .execute(&state.pool)
        .await?;
    let drafted = insert_meals(row.starts_at, row.ends_at, drafted);
    for (i, b) in drafted.iter().enumerate() {
        let label = clean_label(&b.label);
        // The model names sidequests by title; resolving here rather than
        // trusting it with uuids is the same bargain the rest of the app makes.
        // "study for psych mcq test" has to resolve to the exam, so the block
        // can still be started and ticked - best_match works on titles, so the
        // prefix comes off first.
        let hay = label.strip_prefix("study for ").unwrap_or(&label);
        let task_id = (b.kind == "task")
            .then(|| tasks::best_match(&open, hay).map(|t| t.id))
            .flatten();
        sqlx::query(
            "INSERT INTO plan_blocks (plan_date, position, kind, task_id, label, minutes) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(date)
        .bind(i as i32)
        .bind(if task_id.is_some() { "task" } else { &b.kind[..] })
        .bind(task_id)
        .bind(&label)
        .bind(b.minutes.clamp(1, 12 * 60))
        .execute(&state.pool)
        .await?;
    }
    view(state, date, row).await
}

/// How late a meal may be pushed to let a block finish in one piece. Cutting a
/// forty minute task in half to eat on the dot is worse than eating a quarter
/// of an hour later, so the meal moves first and only a block that would delay
/// it past this gets split.
const MEAL_SHIFT_MAX: i32 = 45;

/// The plan's end in the same frame as its start: a bedtime is routinely past
/// midnight from the day's point of view, so it has to be counted on the far
/// side of it rather than compared as a smaller number.
fn window_end(starts_at: NaiveTime, ends_at: Option<NaiveTime>) -> Option<i32> {
    let start = minutes_of(starts_at);
    ends_at.map(|e| {
        let m = minutes_of(e);
        if m < start {
            m + 1440
        } else {
            m
        }
    })
}

/// Which meals belong to a day running from `start` to `end`. A meal already
/// over before the day begins isn't a break, and neither is one whose hour
/// falls after the day is meant to be finished - planning quarter to four
/// until seven shouldn't hand you lunch.
fn meals_in_window(start: i32, end: Option<i32>) -> Vec<(i32, i32, &'static str)> {
    MEAL_BREAKS
        .iter()
        .filter_map(|(from, to, what)| {
            let f = minutes_of(parse_hhmm(from)?);
            let t = minutes_of(parse_hhmm(to)?);
            (t > start && end.is_none_or(|e| f < e)).then_some((f, t, *what))
        })
        .collect()
}

/// Meals are placed here rather than by the model. Asked to position them by
/// arithmetic it drifted - dinner landed at 10:53pm in one run - and there is
/// nothing to reason about: a meal happens at its hour, give or take.
///
/// A meal keeps its full length wherever it lands. A block that would run into
/// one is left whole and the meal slides after it, unless that would push the
/// meal more than MEAL_SHIFT_MAX late, in which case the block is split and the
/// halves still add up to the original length.
fn insert_meals(
    starts_at: NaiveTime,
    ends_at: Option<NaiveTime>,
    drafted: Vec<groq::DraftBlock>,
) -> Vec<groq::DraftBlock> {
    let start = minutes_of(starts_at);
    let mut meals = meals_in_window(start, window_end(starts_at, ends_at));
    meals.sort();
    meals.reverse(); // popped from the back, so earliest first

    let mut clock = start;
    let mut out: Vec<groq::DraftBlock> = Vec::with_capacity(drafted.len() + meals.len());
    for b in drafted {
        let mut left = b.minutes;
        while left > 0 {
            let Some(&(from, to, what)) = meals.last() else { break };
            if clock >= from {
                // Its hour has come, possibly late because the block before it
                // was allowed to finish. It still lasts as long as it should.
                out.push(groq::DraftBlock {
                    kind: "break".into(),
                    label: what.into(),
                    minutes: to - from,
                });
                clock += to - from;
                meals.pop();
                continue;
            }
            let gap = from - clock;
            if left <= gap {
                break;
            }
            // The block runs past the meal's hour. Delaying the meal a little
            // beats cutting the block in two.
            if left - gap <= MEAL_SHIFT_MAX {
                break;
            }
            out.push(groq::DraftBlock { kind: b.kind.clone(), label: b.label.clone(), minutes: gap });
            clock += gap;
            left -= gap;
        }
        if left > 0 {
            out.push(groq::DraftBlock { kind: b.kind.clone(), label: b.label.clone(), minutes: left });
            clock += left;
        }
    }
    // A meal whose hour arrived after the last block still has to be eaten.
    while let Some((from, to, what)) = meals.pop() {
        if clock >= from {
            out.push(groq::DraftBlock {
                kind: "break".into(),
                label: what.into(),
                minutes: to - from,
            });
            clock += to - from;
        }
    }
    out
}

/// The prompt asks for the title verbatim and the model appends the category
/// anyway ("lit paragraph [homework]"), so the bracket comes off here rather
/// than being asked for again.
fn clean_label(label: &str) -> String {
    let trimmed = label.trim();
    // Asked to keep the order it was given, the model started handing back the
    // brief's whole line - "lit paragraph [homework] due today, not_started, 90
    // minutes" - as the label, so the cut can't only happen at the end of the
    // string any more. What makes it safe is testing the tail: only when the
    // bracket is followed by nothing, or by the deadline the brief prints right
    // after the category, is this our own line coming back. A title that simply
    // has a bracket in it ("read [part 2] of the chapter") is left whole.
    let Some(at) = trimmed.find(" [") else { return trimmed.to_string() };
    let Some(close) = trimmed[at..].find(']') else { return trimmed.to_string() };
    let tail = trimmed[at + close + 1..].trim_start();
    if tail.is_empty() || tail.starts_with("due ") || tail.starts_with("no deadline") {
        trimmed[..at].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// A spaced-review reminder that has come due: the 7d/3d/1d study sessions an
/// exam generates. These are real work for today and were being ignored
/// entirely - the plan only ever looked at a task's own due date, so the study
/// session for Tuesday's quiz never appeared on Sunday.
#[derive(Debug, Clone)]
pub struct DueReview {
    pub title: String,
    pub offset_days: i32,
    pub effort_minutes: Option<i32>,
}

impl DueReview {
    fn label(&self) -> String {
        format!("study for {}", self.title)
    }
}

async fn due_reviews(state: &AppState, date: NaiveDate) -> Result<Vec<DueReview>, AppError> {
    let rows: Vec<(String, i32, Option<i32>)> = sqlx::query_as(
        "SELECT t.title, c.offset_days, t.effort_minutes \
         FROM task_checkpoints c JOIN tasks t ON t.id = c.task_id \
         WHERE c.status = 'todo' AND c.due_date <= $1 \
           AND t.archived_at IS NULL AND t.status <> 'done' \
         ORDER BY c.due_date, c.offset_days DESC",
    )
    .bind(date)
    .fetch_all(&state.pool)
    .await?;
    // One session per exam. Two reminders can be due at once - an overdue 3d
    // and today's 1d - but they are the same revision, and two identical
    // blocks in an evening reads as a bug rather than as a plan. The query
    // orders by due date then widest offset, so the first row per exam is the
    // one that has been waiting longest.
    let mut seen: Vec<String> = Vec::new();
    Ok(rows
        .into_iter()
        .filter(|(title, ..)| {
            let fresh = !seen.contains(title);
            if fresh {
                seen.push(title.clone());
            }
            fresh
        })
        .map(|(title, offset_days, effort_minutes)| DueReview { title, offset_days, effort_minutes })
        .collect())
}

/// What a sidequest is expected to take: its own estimate, then one written
/// into its note back before there was a field for it, then the default.
fn estimate_of(t: &Task) -> i32 {
    t.effort_minutes
        .or_else(|| t.note.as_deref().and_then(tasks::effort_from_text))
        .unwrap_or(NO_ESTIMATE_MIN)
}

fn build_brief(
    open: &[Task],
    reviews: &[DueReview],
    spent: &[(Uuid, i64, i64, chrono::DateTime<Utc>)],
    date: NaiveDate,
    starts_at: NaiveTime,
    ends_at: Option<NaiveTime>,
) -> String {
    let today = date;
    let line = |t: &Task| {
        let due = match t.due_date {
            Some(d) if d == today => "due today".to_string(),
            Some(d) => format!("due {d}"),
            None => "no deadline".into(),
        };
        let est = t
            .effort_minutes
            .or_else(|| t.note.as_deref().and_then(tasks::effort_from_text))
            .map(|m| format!("{m} minutes"))
            .unwrap_or_else(|| format!("{NO_ESTIMATE_MIN} minutes (no estimate given)"));
        let history = match spent.iter().find(|(id, ..)| *id == t.id) {
            Some((_, mins, ..)) => format!(", {mins}m of focus already"),
            None => String::new(),
        };
        format!("- {} [{}] {due}, {}, {est}{history}\n", t.title, t.category, t.status)
    };

    let (mut now_due, mut later): (Vec<&Task>, Vec<&Task>) =
        open.iter().partition(|t| t.due_date.is_some_and(|d| d <= date));
    // Longest first, within each group. The model left to itself works down
    // the list it was handed, so a half-hour errand kept opening the day and
    // the ninety-minute piece of actual work landed in the evening. The big
    // thing wants the hours you still have, and if the day does overrun, what
    // gets pushed off the end should be the small stuff.
    now_due.sort_by_key(|t| std::cmp::Reverse(estimate_of(t)));
    later.sort_by_key(|t| std::cmp::Reverse(estimate_of(t)));

    // Backlog only fills a day that has nothing of its own. Offered both
    // groups the model took the second one as permission rather than as a
    // reserve: an evening with three hours of work due today came back with
    // the whole backlog stacked behind it, running past bedtime, and the
    // app's own answer was to suggest dropping the work it had just added.
    // "What am I doing today" is answered by today. An hour left over at the
    // end is a real answer, not a gap that needs filling.
    let backlog_only = now_due.is_empty() && reviews.is_empty();
    if !backlog_only {
        later.clear();
    }

    let mut brief = format!("The plan starts at {}.\n", starts_at.format("%H:%M"));
    if let Some(end) = ends_at {
        brief.push_str(&format!("It has to be finished by {}.\n", end.format("%H:%M")));
    }
    brief.push_str("\nDUE TODAY OR ALREADY LATE - plan these:\n");
    if now_due.is_empty() && reviews.is_empty() {
        brief.push_str("(nothing)\n");
    }
    // Study sessions go at the top of the group, not the bottom. They are the
    // most time-sensitive thing in it - the exam is in a day or two - and
    // being last is what got them dropped when the day overflowed.
    for r in reviews {
        brief.push_str(&format!(
            "- {} [study session] due today, {} days before the exam, {} minutes\n",
            r.label(),
            r.offset_days,
            r.effort_minutes.unwrap_or(REVIEW_MIN)
        ));
    }
    for t in &now_due {
        brief.push_str(&line(t));
    }
    if backlog_only {
        brief.push_str("\nNOTHING IS DUE TODAY. Pick from these instead:\n");
        if later.is_empty() {
            brief.push_str("(nothing)\n");
        }
        for t in &later {
            brief.push_str(&line(t));
        }
    }
    brief
}

#[cfg(test)]
mod tests {
    use super::{clean_label, lay_out, PlanBlock};
    use chrono::NaiveTime;
    use uuid::Uuid;

    fn draft(kind: &str, label: &str, minutes: i32) -> crate::groq::DraftBlock {
        crate::groq::DraftBlock { kind: kind.into(), label: label.into(), minutes }
    }

    fn cand(label: &str, due: Option<&str>, exam: bool, minutes: i32) -> super::Candidate {
        super::Candidate {
            task_id: Uuid::nil(),
            label: label.into(),
            due_date: due.map(|d| d.parse().unwrap()),
            is_exam: exam,
            minutes,
        }
    }

    fn today() -> chrono::NaiveDate {
        "2026-08-30".parse().unwrap()
    }

    #[test]
    fn something_not_due_today_is_dropped_before_anything_that_is() {
        let picked = super::choose_push(
            vec![
                cand("research", Some("2026-08-30"), false, 180),
                cand("ptsa award", Some("2026-09-03"), false, 30),
            ],
            today(),
            60,
        );
        // Even though the ptsa award is too small to clear the whole overflow,
        // moving work that isn't due yet beats moving work that is.
        assert_eq!(picked.unwrap().label, "ptsa award");
    }

    #[test]
    fn among_equals_it_takes_the_smallest_that_clears_the_overflow() {
        let picked = super::choose_push(
            vec![
                cand("research", Some("2026-08-30"), false, 180),
                cand("lit paragraph", Some("2026-08-30"), false, 90),
                cand("physics ps4", Some("2026-08-30"), false, 30),
            ],
            today(),
            68,
        );
        // 90 clears 68; 180 also would, but emptying the evening is not the ask.
        assert_eq!(picked.unwrap().label, "lit paragraph");
    }

    #[test]
    fn revision_for_tomorrows_exam_outranks_homework_due_today() {
        let picked = super::choose_push(
            vec![
                cand("csp unit 1 quiz", Some("2026-08-31"), true, 60),
                cand("physics ps4", Some("2026-08-30"), false, 30),
            ],
            today(),
            20,
        );
        // The quiz isn't due today, which would normally make it the free win -
        // but not studying for tomorrow's exam is not a free win.
        assert_eq!(picked.unwrap().label, "physics ps4");
    }

    #[test]
    fn an_exam_is_the_last_thing_to_go() {
        let picked = super::choose_push(
            vec![
                cand("psych mcq", Some("2026-08-30"), true, 60),
                cand("lit paragraph", Some("2026-08-30"), false, 90),
            ],
            today(),
            50,
        );
        assert_eq!(picked.unwrap().label, "lit paragraph");
    }

    #[test]
    fn nothing_big_enough_means_dropping_the_biggest() {
        let picked = super::choose_push(
            vec![
                cand("a", Some("2026-08-30"), false, 30),
                cand("b", Some("2026-08-30"), false, 45),
            ],
            today(),
            200,
        );
        assert_eq!(picked.unwrap().label, "b");
    }

    #[test]
    fn a_day_that_fits_suggests_nothing() {
        assert!(super::choose_push(vec![cand("a", None, false, 30)], today(), 0).is_none());
    }

    #[test]
    fn a_block_that_only_just_overruns_a_meal_moves_the_meal_instead() {
        let start = NaiveTime::parse_from_str("17:44", "%H:%M").unwrap();
        // 17:44 + 180 runs to 20:44, fourteen minutes past dinner at 20:30.
        // Eating at 20:44 beats cutting the task in two to eat on the dot.
        let out = super::insert_meals(start, None, vec![draft("task", "research", 180)]);
        let shape: Vec<_> = out.iter().map(|b| (b.kind.as_str(), b.label.as_str(), b.minutes)).collect();
        assert_eq!(shape, vec![("task", "research", 180), ("break", "dinner", 30)]);
    }

    #[test]
    fn a_block_that_would_hold_a_meal_up_for_hours_is_split() {
        let start = NaiveTime::parse_from_str("18:00", "%H:%M").unwrap();
        // 18:00 + 240 would run to 22:00 - an hour and a half past dinner.
        let out = super::insert_meals(start, None, vec![draft("task", "essay", 240)]);
        let shape: Vec<_> = out.iter().map(|b| (b.kind.as_str(), b.label.as_str(), b.minutes)).collect();
        assert_eq!(
            shape,
            vec![("task", "essay", 150), ("break", "dinner", 30), ("task", "essay", 90)]
        );
        assert_eq!(150 + 90, 240, "a split must not lose or invent minutes");
    }

    #[test]
    fn a_meal_keeps_its_length_when_it_is_pushed_late() {
        let start = NaiveTime::parse_from_str("20:00", "%H:%M").unwrap();
        // Starts half an hour before dinner, runs 60 - dinner lands at 21:00
        // and still lasts its full half hour rather than being trimmed.
        let out = super::insert_meals(start, None, vec![draft("task", "reading", 60)]);
        let dinner = out.iter().find(|b| b.label == "dinner").expect("dinner");
        assert_eq!(dinner.minutes, 30);
    }

    #[test]
    fn a_meal_already_over_is_not_a_break() {
        let start = NaiveTime::parse_from_str("17:44", "%H:%M").unwrap();
        let out = super::insert_meals(start, None, vec![draft("task", "short", 20)]);
        assert!(!out.iter().any(|b| b.label == "lunch"), "lunch ended hours ago");
        assert_eq!(out.len(), 1, "a block that clears every meal is untouched");
    }

    #[test]
    fn a_day_starting_before_lunch_gets_both_meals() {
        let start = NaiveTime::parse_from_str("09:00", "%H:%M").unwrap();
        let out = super::insert_meals(start, None, vec![draft("task", "long", 12 * 60)]);
        let breaks: Vec<_> = out.iter().filter(|b| b.kind == "break").map(|b| b.label.as_str()).collect();
        assert_eq!(breaks, vec!["lunch", "dinner"]);
        let work: i32 = out.iter().filter(|b| b.kind == "task").map(|b| b.minutes).sum();
        assert_eq!(work, 12 * 60, "splitting must not lose or invent minutes");
    }

    #[test]
    fn a_label_keeps_only_the_title() {
        assert_eq!(clean_label("lit paragraph [homework]"), "lit paragraph");
        assert_eq!(
            clean_label("lit paragraph [homework] due today, not_started, 90 minutes"),
            "lit paragraph"
        );
        assert_eq!(clean_label("study for physics quiz 1 [study session] due today"), "study for physics quiz 1");
        assert_eq!(clean_label("read up on history"), "read up on history");
    }

    #[test]
    fn an_afternoon_start_gets_no_lunch() {
        // The bug this exists for: plan the day at lunchtime, then push the
        // start to quarter to four. Lunch has to go, not be re-timed to 3:45.
        let start = NaiveTime::parse_from_str("15:45", "%H:%M").unwrap();
        let out = super::insert_meals(start, None, vec![draft("task", "reading", 60)]);
        assert!(!out.iter().any(|b| b.label == "lunch"), "lunch was over hours ago");
    }

    #[test]
    fn a_day_that_ends_before_dinner_gets_no_dinner() {
        let start = NaiveTime::parse_from_str("15:45", "%H:%M").unwrap();
        let end = NaiveTime::parse_from_str("19:00", "%H:%M").unwrap();
        // Four hours of work would run past 8:30 - but the day is meant to be
        // over by seven, so dinner is not this plan's problem.
        let out = super::insert_meals(start, Some(end), vec![draft("task", "essay", 240)]);
        assert!(out.iter().all(|b| b.kind == "task"), "no meal belongs in a 3:45-7 day");
    }

    #[test]
    fn a_bedtime_past_midnight_still_counts_dinner_as_inside_the_day() {
        let start = NaiveTime::parse_from_str("15:45", "%H:%M").unwrap();
        let end = NaiveTime::parse_from_str("00:30", "%H:%M").unwrap();
        let out = super::insert_meals(start, Some(end), vec![draft("task", "essay", 360)]);
        assert!(out.iter().any(|b| b.label == "dinner"), "8:30 is before a 12:30 bedtime");
    }

    fn task(title: &str, due: Option<&str>, minutes: i32) -> crate::tasks::Task {
        crate::tasks::Task {
            id: Uuid::new_v4(),
            title: title.into(),
            category: "homework".into(),
            due_date: due.map(|d| d.parse().unwrap()),
            due_time: None,
            effort_minutes: Some(minutes),
            status: "not_started".into(),
            is_exam: false,
            note: None,
            created_at: chrono::Utc::now(),
            completed_at: None,
        }
    }

    fn brief_for(open: &[crate::tasks::Task], reviews: &[super::DueReview]) -> String {
        super::build_brief(
            open,
            reviews,
            &[],
            today(),
            NaiveTime::parse_from_str("17:00", "%H:%M").unwrap(),
            NaiveTime::parse_from_str("23:00", "%H:%M").ok(),
        )
    }

    #[test]
    fn a_day_with_work_of_its_own_is_never_offered_the_backlog() {
        let open = vec![
            task("ch 1-6", Some("2026-08-30"), 130),
            task("ptsa award", Some("2026-09-12"), 30),
            task("visit VA", None, 30),
        ];
        let brief = brief_for(&open, &[]);
        assert!(brief.contains("ch 1-6"));
        assert!(!brief.contains("ptsa award"), "work due in a fortnight is not today's plan");
        assert!(!brief.contains("visit VA"), "and neither is work with no deadline at all");
    }

    #[test]
    fn a_review_that_has_come_due_counts_as_work_of_its_own() {
        // Nothing is due, but tomorrow's quiz needs revising tonight - that is
        // a real day, so the backlog stays out of it.
        let open = vec![task("ptsa award", Some("2026-09-12"), 30)];
        let reviews = vec![super::DueReview {
            title: "physics quiz 1".into(),
            offset_days: 1,
            effort_minutes: Some(30),
        }];
        let brief = brief_for(&open, &reviews);
        assert!(brief.contains("study for physics quiz 1"));
        assert!(!brief.contains("ptsa award"));
    }

    #[test]
    fn an_empty_day_falls_back_to_the_backlog_rather_than_planning_nothing() {
        let open = vec![task("ptsa award", Some("2026-09-12"), 30), task("visit VA", None, 45)];
        let brief = brief_for(&open, &[]);
        assert!(brief.contains("NOTHING IS DUE TODAY"));
        assert!(brief.contains("ptsa award") && brief.contains("visit VA"));
        // Still longest first.
        assert!(brief.find("visit VA") < brief.find("ptsa award"));
    }

    #[test]
    fn a_row_lands_where_the_drag_put_it_in_both_directions() {
        let ids: Vec<Uuid> = (1..=4u128).map(Uuid::from_u128).collect();
        let (a, b, c, d) = (ids[0], ids[1], ids[2], ids[3]);
        // Dragging the first row down past two others.
        assert_eq!(super::reorder(ids.clone(), a, 2), vec![b, c, a, d]);
        // And the last row up past two others.
        assert_eq!(super::reorder(ids.clone(), d, 1), vec![a, d, b, c]);
        // Ends stay reachable, and a nonsense index is clamped rather than
        // panicking on a list that has shrunk under a stale drag.
        assert_eq!(super::reorder(ids.clone(), a, 3), vec![b, c, d, a]);
        assert_eq!(super::reorder(ids.clone(), d, 0), vec![d, a, b, c]);
        assert_eq!(super::reorder(ids.clone(), b, 99), vec![a, c, d, b]);
        assert_eq!(super::reorder(ids.clone(), b, 1), ids);
    }

    #[test]
    fn a_start_time_rounds_up_to_the_next_five_minutes() {
        assert_eq!(super::round_up_5(18 * 60 + 31), 18 * 60 + 35);
        assert_eq!(super::round_up_5(18 * 60 + 35), 18 * 60 + 35);
        assert_eq!(super::round_up_5(18 * 60 + 36), 18 * 60 + 40);
        assert_eq!(super::round_up_5(0), 0);
    }

    #[test]
    fn a_trailing_category_comes_off_the_label() {
        assert_eq!(clean_label("lit paragraph [homework]"), "lit paragraph");
        assert_eq!(clean_label("dinner"), "dinner");
        // A bracket that is part of the name stays put.
        assert_eq!(clean_label("read [part 2] of the chapter"), "read [part 2] of the chapter");
    }

    fn block(minutes: i32, pin: Option<&str>) -> PlanBlock {
        PlanBlock {
            id: Uuid::nil(),
            position: 0,
            kind: "task".into(),
            task_id: None,
            label: "x".into(),
            minutes,
            pinned_start: pin.map(|p| NaiveTime::parse_from_str(p, "%H:%M").unwrap()),
        }
    }

    #[test]
    fn blocks_run_back_to_back_from_the_start_time() {
        let start = NaiveTime::parse_from_str("17:44", "%H:%M").unwrap();
        let (timed, end) = lay_out(start, vec![block(180, None), block(30, None), block(90, None)]);
        assert_eq!(timed[0].start, "17:44");
        assert_eq!(timed[0].end, "20:44");
        assert_eq!(timed[1].start, "20:44");
        assert_eq!(timed[2].end, "22:44");
        assert_eq!(end, 17 * 60 + 44 + 300);
    }

    #[test]
    fn a_pin_holds_its_hour_and_leaves_a_gap() {
        let start = NaiveTime::parse_from_str("17:00", "%H:%M").unwrap();
        let (timed, _) = lay_out(start, vec![block(30, None), block(30, Some("19:00"))]);
        assert_eq!(timed[0].start, "17:00");
        assert_eq!(timed[1].start, "19:00", "the pinned block waits for its hour");
        assert_eq!(timed[1].end, "19:30");
    }

    #[test]
    fn a_pin_already_past_is_ignored_rather_than_running_the_day_backwards() {
        let start = NaiveTime::parse_from_str("17:00", "%H:%M").unwrap();
        let (timed, _) = lay_out(start, vec![block(120, None), block(30, Some("18:00"))]);
        assert_eq!(timed[1].start, "19:00", "19:00 is where the previous block actually ended");
    }
}
