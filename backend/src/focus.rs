use axum::extract::{Path, State};
use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::models::{FocusSessionData, TaskRequest};
use crate::routes::AppError;
use crate::undo::{set_last, UndoAction};
use crate::{cadences, tasks, AppState};

#[derive(Debug, Serialize, FromRow)]
pub struct FocusSession {
    pub id: Uuid,
    pub task_id: Option<Uuid>,
    pub cadence_id: Option<Uuid>,
    pub planned_minutes: i32,
    pub actual_minutes: Option<i32>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub completed: bool,
    pub paused_at: Option<DateTime<Utc>>,
    pub paused_seconds: i32,
}

const SESSION_COLUMNS: &str = "id, task_id, cadence_id, planned_minutes, actual_minutes, \
    started_at, ended_at, completed, paused_at, paused_seconds";

#[derive(Debug, Deserialize)]
pub struct NewTask {
    pub title: String,
    pub category: Option<String>,
    pub due_date: Option<String>,
    pub effort_minutes: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateFocus {
    pub task_id: Option<Uuid>,
    pub new_task: Option<NewTask>,
    pub cadence_id: Option<Uuid>,
    pub planned_minutes: i32,
}

#[derive(Debug, Serialize)]
pub struct StartedSession {
    #[serde(flatten)]
    pub session: FocusSession,
    pub title: String,
}

pub async fn create_session(
    State(state): State<AppState>,
    Json(body): Json<CreateFocus>,
) -> Result<Json<StartedSession>, AppError> {
    if !(1..=600).contains(&body.planned_minutes) {
        return Err(AppError::BadRequest("planned_minutes out of range".into()));
    }

    let (task_id, cadence_id, title) = if let Some(cid) = body.cadence_id {
        let row: Option<(String,)> = sqlx::query_as("SELECT name FROM cadences WHERE id = $1 AND active")
            .bind(cid)
            .fetch_optional(&state.pool)
            .await?;
        (None, Some(cid), row.ok_or(AppError::NotFound)?.0)
    } else {
        match (body.task_id, body.new_task) {
            (Some(id), _) => {
                let row: Option<(String,)> = sqlx::query_as(
                    "SELECT title FROM tasks WHERE id = $1 AND archived_at IS NULL",
                )
                .bind(id)
                .fetch_optional(&state.pool)
                .await?;
                (Some(id), None, row.ok_or(AppError::NotFound)?.0)
            }
            (None, Some(nt)) => {
                let req = TaskRequest {
                    title: nt.title,
                    category: nt.category,
                    due_date: nt.due_date,
                    due_time: None,
                    effort_minutes: nt.effort_minutes,
                    status: None,
                    is_exam: None,
                    note: None,
                    clear_due_date: false,
                };
                let task = tasks::create_task(&state, &req).await?;
                (Some(task.id), None, task.title)
            }
            (None, None) => {
                return Err(AppError::BadRequest("task_id, cadence_id, or new_task required".into()))
            }
        }
    };

    Ok(Json(open_session(&state, task_id, cadence_id, title, body.planned_minutes).await?))
}

/// Insert the session row and pair it with the display title. Split out of
/// create_session so a command ("/start 30 on psych notes") starts a timer
/// through exactly the same path the picker does, having resolved the
/// task or cadence its own way.
pub(crate) async fn open_session(
    state: &AppState,
    task_id: Option<Uuid>,
    cadence_id: Option<Uuid>,
    title: String,
    planned_minutes: i32,
) -> Result<StartedSession, AppError> {
    let session: FocusSession = sqlx::query_as(&format!(
        "INSERT INTO focus_sessions (task_id, cadence_id, planned_minutes) VALUES ($1, $2, $3) \
         RETURNING {SESSION_COLUMNS}"
    ))
    .bind(task_id)
    .bind(cadence_id)
    .bind(planned_minutes)
    .fetch_one(&state.pool)
    .await?;
    Ok(StartedSession { session, title })
}

#[derive(Debug, Deserialize)]
struct EndBody {
    completed: bool,
    token: Option<String>,
    tz_offset_min: Option<i32>,
}

fn authorized(state: &AppState, headers: &HeaderMap, body_token: Option<&str>) -> bool {
    let provided = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or(body_token);
    provided == Some(state.auth_token.as_str())
}

/// Ends a running session. Reached two ways: the interactive Stop/complete
/// button (bearer header) and `navigator.sendBeacon` on tab close (which can't
/// set headers, so the token rides in the body). This route therefore lives
/// outside the shared bearer middleware and checks the token itself, and reads
/// a raw String body so a text/plain beacon (no CORS preflight) parses too.
///
/// Idempotent: the UPDATE only touches a session that hasn't ended yet, so a
/// beacon and a Stop click racing on the same session write exactly one logs
/// row between them.
pub async fn end_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<FocusSession>, AppError> {
    let end: EndBody =
        serde_json::from_str(&body).map_err(|_| AppError::BadRequest("bad body".into()))?;
    if !authorized(&state, &headers, end.token.as_deref()) {
        return Err(AppError::Unauthorized);
    }

    // Subtract accumulated paused_seconds, plus whatever's elapsed in an
    // still-open pause (ending mid-pause is allowed), from the wall-clock
    // span so actual_minutes reflects time actually worked.
    let updated: Option<FocusSession> = sqlx::query_as(&format!(
        "UPDATE focus_sessions SET \
            ended_at = now(), \
            actual_minutes = GREATEST(0, ROUND(( \
                EXTRACT(EPOCH FROM (now() - started_at)) - paused_seconds \
                - COALESCE(EXTRACT(EPOCH FROM (now() - paused_at)), 0) \
            ) / 60.0))::int, \
            completed = $2 \
         WHERE id = $1 AND ended_at IS NULL \
         RETURNING {SESSION_COLUMNS}"
    ))
    .bind(id)
    .bind(end.completed)
    .fetch_optional(&state.pool)
    .await?;

    let Some(session) = updated else {
        // Already ended (or never existed): return the current row if present
        // and write no second logs entry.
        let existing: Option<FocusSession> =
            sqlx::query_as(&format!("SELECT {SESSION_COLUMNS} FROM focus_sessions WHERE id = $1"))
                .bind(id)
                .fetch_optional(&state.pool)
                .await?;
        return existing.map(Json).ok_or(AppError::NotFound);
    };

    let title = if let Some(task_id) = session.task_id {
        let (title,): (String,) = sqlx::query_as("SELECT title FROM tasks WHERE id = $1")
            .bind(task_id)
            .fetch_one(&state.pool)
            .await?;
        title
    } else {
        let (name,): (String,) = sqlx::query_as("SELECT name FROM cadences WHERE id = $1")
            .bind(session.cadence_id)
            .fetch_one(&state.pool)
            .await?;
        name
    };

    let data = FocusSessionData {
        session_id: session.id,
        task_id: session.task_id,
        cadence_id: session.cadence_id,
        title: title.clone(),
        planned_minutes: session.planned_minutes,
        actual_minutes: session.actual_minutes.unwrap_or(0),
        completed: session.completed,
    };
    let log: crate::models::Log = sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'focus_session', $2) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(format!("focus: {title}"))
    .bind(serde_json::to_value(&data).unwrap())
    .fetch_one(&state.pool)
    .await?;
    let mut log_ids = vec![log.id];

    // A completed cadence-tied session also counts as today's cadence
    // completion, same as saying "did sat practice" through the text input.
    if session.completed {
        if let Some(cadence_id) = session.cadence_id {
            let completion = cadences::log_completion(
                &state,
                cadence_id,
                &title,
                &format!("focus: {title}"),
                end.tz_offset_min.unwrap_or(0),
                None,
            )
            .await?;
            if let Some(completion) = completion {
                log_ids.push(completion.id);
            }
        }
    }

    set_last(&state, UndoAction::LogCreated { log_ids });

    Ok(Json(session))
}

pub async fn pause_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<FocusSession>, AppError> {
    let session: Option<FocusSession> = sqlx::query_as(&format!(
        "UPDATE focus_sessions SET paused_at = now() \
         WHERE id = $1 AND ended_at IS NULL AND paused_at IS NULL \
         RETURNING {SESSION_COLUMNS}"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    session.map(Json).ok_or(AppError::NotFound)
}

pub async fn resume_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<FocusSession>, AppError> {
    let session: Option<FocusSession> = sqlx::query_as(&format!(
        "UPDATE focus_sessions SET \
            paused_seconds = paused_seconds + GREATEST(0, EXTRACT(EPOCH FROM (now() - paused_at)))::int, \
            paused_at = NULL \
         WHERE id = $1 AND ended_at IS NULL AND paused_at IS NOT NULL \
         RETURNING {SESSION_COLUMNS}"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    session.map(Json).ok_or(AppError::NotFound)
}

#[derive(Debug, Deserialize)]
pub struct ExtendBody {
    pub minutes: i32,
}

pub async fn extend_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ExtendBody>,
) -> Result<Json<FocusSession>, AppError> {
    if !(1..=120).contains(&body.minutes) {
        return Err(AppError::BadRequest("minutes out of range".into()));
    }
    let session: Option<FocusSession> = sqlx::query_as(&format!(
        "UPDATE focus_sessions SET planned_minutes = planned_minutes + $2 \
         WHERE id = $1 AND ended_at IS NULL \
         RETURNING {SESSION_COLUMNS}"
    ))
    .bind(id)
    .bind(body.minutes)
    .fetch_optional(&state.pool)
    .await?;
    session.map(Json).ok_or(AppError::NotFound)
}

pub async fn list_for_task(
    State(state): State<AppState>,
    Path(task_id): Path<Uuid>,
) -> Result<Json<Vec<FocusSession>>, AppError> {
    let sessions: Vec<FocusSession> = sqlx::query_as(&format!(
        "SELECT {SESSION_COLUMNS} FROM focus_sessions \
         WHERE task_id = $1 AND ended_at IS NOT NULL ORDER BY started_at DESC"
    ))
    .bind(task_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(sessions))
}

/// Minutes already sunk into each task over the last `days`, as
/// (task_id, minutes, sessions, last date). Lets the day plan tell a sidequest
/// that's nearly finished apart from one that hasn't been started.
pub async fn minutes_by_task(
    state: &AppState,
    days: i64,
) -> Result<Vec<(Uuid, i64, i64, DateTime<Utc>)>, AppError> {
    Ok(sqlx::query_as(
        "SELECT task_id, COALESCE(SUM(actual_minutes), 0)::bigint, COUNT(*)::bigint, \
                MAX(started_at) \
         FROM focus_sessions \
         WHERE task_id IS NOT NULL AND ended_at IS NOT NULL AND started_at >= $1 \
         GROUP BY task_id",
    )
    .bind(Utc::now() - chrono::Duration::days(days))
    .fetch_all(&state.pool)
    .await?)
}

/// Drop a finished session and the timeline row it wrote. Both or neither -
/// leaving the log behind would keep showing a session the sidequest no longer
/// lists, which is the confusion this button exists to clear up.
pub async fn delete_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let deleted: Option<(Uuid,)> =
        sqlx::query_as("DELETE FROM focus_sessions WHERE id = $1 RETURNING id")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    if deleted.is_none() {
        return Err(AppError::NotFound);
    }
    sqlx::query(
        "UPDATE logs SET deleted_at = now() \
         WHERE parsed_type = 'focus_session' AND deleted_at IS NULL \
         AND data->>'session_id' = $1",
    )
    .bind(id.to_string())
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
