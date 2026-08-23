use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Duration, NaiveDate, TimeZone, Utc};
use uuid::Uuid;

use crate::models::{Action, CreateLog, ItineraryEntry, ListQuery, Log, SleepData, UpdateLog};
use crate::undo::{set_last, UndoAction};
use crate::{commands, groq, cadences, learning, tasks, wger, AppState};

pub enum AppError {
    NotFound,
    BadRequest(String),
    Unauthorized,
    Internal(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError::Internal(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::Internal(e) => {
                tracing::error!("internal error: {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

const LOG_COLUMNS: &str = "id, created_at, raw_input, parsed_type, data";

#[derive(serde::Serialize)]
pub struct CreateResponse {
    pub logs: Vec<Log>,
    pub notice: Option<String>,
    // Set when a command started a timer, so the frontend can adopt that
    // session rather than opening the picker and starting a second one.
    pub focus_session: Option<crate::focus::StartedSession>,
}


async fn insert_log(state: &AppState, raw: &str, parsed_type: &str, data: serde_json::Value) -> Result<Log, AppError> {
    let log: Log = sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, $2, $3) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(raw)
    .bind(parsed_type)
    .bind(data)
    .fetch_one(&state.pool)
    .await?;
    Ok(log)
}

/// Insert the workout, or update the existing entry for the same wger
/// session so saying "worked out" twice does not duplicate it.
async fn upsert_workout(
    state: &AppState,
    raw: &str,
    data: &crate::models::WorkoutData,
) -> Result<Log, AppError> {
    let existing: Option<Log> = sqlx::query_as(
        "SELECT id, created_at, raw_input, parsed_type, data FROM logs \
         WHERE parsed_type = 'workout' AND deleted_at IS NULL \
         AND (data->>'wger_session_id')::bigint = $1",
    )
    .bind(data.wger_session_id)
    .fetch_optional(&state.pool)
    .await?;

    let payload = serde_json::to_value(data).unwrap();
    match existing {
        Some(log) => {
            // Keep an earlier user note when the re-sync does not bring one.
            let mut payload = payload;
            if payload.get("note").map(|n| n.is_null()).unwrap_or(true) {
                if let Some(old) = log.data.get("note").filter(|n| !n.is_null()) {
                    payload["note"] = old.clone();
                }
            }
            let updated: Log = sqlx::query_as(
                "UPDATE logs SET data = $2 WHERE id = $1 \
                 RETURNING id, created_at, raw_input, parsed_type, data",
            )
            .bind(log.id)
            .bind(payload)
            .fetch_one(&state.pool)
            .await?;
            Ok(updated)
        }
        None => insert_log(state, raw, "workout", payload).await,
    }
}

fn parse_at(at: &Option<String>, tz_offset: i32) -> Option<chrono::DateTime<Utc>> {
    let s = at.as_deref()?.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // A bare local datetime is shifted to UTC with the request's offset.
    let formats = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"];
    for f in &formats {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return Some(Utc.from_utc_datetime(&naive) + Duration::minutes(tz_offset as i64));
        }
    }
    None
}

fn local_date(ts: chrono::DateTime<Utc>, tz_offset: i32) -> String {
    (ts - Duration::minutes(tz_offset as i64)).date_naive().to_string()
}

async fn open_sleep(state: &AppState) -> Result<Option<Log>, AppError> {
    let log: Option<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs \
         WHERE parsed_type = 'sleep' AND deleted_at IS NULL \
         AND data->>'sleep_end' IS NULL ORDER BY created_at DESC LIMIT 1"
    ))
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .next();
    Ok(log)
}

async fn handle_sleep(
    state: &AppState,
    raw: &str,
    action: &str,
    at: Option<chrono::DateTime<Utc>>,
    tz_offset: i32,
) -> Result<Log, AppError> {
    let ts = at.unwrap_or_else(Utc::now);
    let open = open_sleep(state).await?;

    if action == "start" {
        if let Some(log) = open {
            let patch = serde_json::json!({
                "sleep_start": ts,
                "night_date": local_date(ts, tz_offset),
            });
            let updated: Log = sqlx::query_as(&format!(
                "UPDATE logs SET data = data || $2 WHERE id = $1 RETURNING {LOG_COLUMNS}"
            ))
            .bind(log.id)
            .bind(patch)
            .fetch_one(&state.pool)
            .await?;
            return Ok(updated);
        }
        let data = SleepData {
            sleep_start: Some(ts),
            sleep_end: None,
            duration_min: None,
            night_date: local_date(ts, tz_offset),
        };
        return insert_log(state, raw, "sleep", serde_json::to_value(data).unwrap()).await;
    }

    match open {
        Some(log) => {
            let start = log
                .data
                .get("sleep_start")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc));
            let duration = start.map(|s| ((ts - s).num_minutes()).max(0));
            let patch = serde_json::json!({
                "sleep_end": ts,
                "duration_min": duration,
                "night_date": local_date(ts, tz_offset),
            });
            let updated: Log = sqlx::query_as(&format!(
                "UPDATE logs SET data = data || $2 WHERE id = $1 RETURNING {LOG_COLUMNS}"
            ))
            .bind(log.id)
            .bind(patch)
            .fetch_one(&state.pool)
            .await?;
            Ok(updated)
        }
        None => {
            let data = SleepData {
                sleep_start: None,
                sleep_end: Some(ts),
                duration_min: None,
                night_date: local_date(ts, tz_offset),
            };
            insert_log(state, raw, "sleep", serde_json::to_value(data).unwrap()).await
        }
    }
}

/// Append one item to a trip's itinerary. Returns None when no trip exists.
async fn append_itinerary(
    state: &AppState,
    destination: Option<&str>,
    name: &str,
    note: Option<String>,
) -> Result<Option<Log>, AppError> {
    let trip: Option<Log> = match destination {
        Some(dest) => {
            sqlx::query_as(&format!(
                "SELECT {LOG_COLUMNS} FROM logs \
                 WHERE parsed_type = 'trip' AND deleted_at IS NULL \
                 AND data->>'destination' ILIKE $1 \
                 ORDER BY created_at DESC LIMIT 1"
            ))
            .bind(format!("%{dest}%"))
            .fetch_optional(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as(&format!(
                "SELECT {LOG_COLUMNS} FROM logs \
                 WHERE parsed_type = 'trip' AND deleted_at IS NULL \
                 ORDER BY (data->>'end_date' IS NULL) DESC, created_at DESC LIMIT 1"
            ))
            .fetch_optional(&state.pool)
            .await?
        }
    };
    let Some(trip) = trip else {
        return Ok(None);
    };

    let entry = serde_json::to_value(ItineraryEntry { name: name.to_string(), note }).unwrap();
    let updated: Log = sqlx::query_as(&format!(
        "UPDATE logs SET data = jsonb_set(data, '{{itinerary}}', \
            COALESCE(data->'itinerary', '[]'::jsonb) || $2) \
         WHERE id = $1 RETURNING {LOG_COLUMNS}"
    ))
    .bind(trip.id)
    .bind(entry)
    .fetch_one(&state.pool)
    .await?;
    Ok(Some(updated))
}

pub async fn create_log(
    State(state): State<AppState>,
    Json(body): Json<CreateLog>,
) -> Result<Json<CreateResponse>, AppError> {
    let raw = body.raw_text.trim();
    if raw.is_empty() {
        return Err(AppError::BadRequest("raw_text is empty".into()));
    }
    let tz_offset = body.tz_offset_min.unwrap_or(0);

    let now_local = Utc::now() - Duration::minutes(tz_offset as i64);
    let mut context = format!(
        "Current local datetime: {} ({}).\n",
        now_local.format("%Y-%m-%dT%H:%M"),
        now_local.format("%A")
    );
    context.push_str(&learning::context_block(&state).await);
    context.push_str(&tasks::context_block(&state).await);
    context.push_str(&cadences::context_block(&state).await);

    let actions =
        groq::parse(&state.http, &state.groq_key, &state.usda_key, raw, &context).await?;

    let mut logs = Vec::with_capacity(actions.len());
    let mut notices = Vec::new();
    let mut focus_session = None;
    for action in actions {
        match action {
            Action::Entry(entry) => {
                let log = insert_log(&state, raw, entry.type_name(), entry.to_json()).await?;
                set_last(&state, UndoAction::LogCreated { log_ids: vec![log.id] });
                logs.push(log);
            }
            Action::Workout { note, allow_not_today } => {
                let Some(wger_key) = state.wger_key.as_deref() else {
                    notices.push("wger is not configured.".to_string());
                    continue;
                };
                match wger::sync(&state.http, wger_key, tz_offset, note, allow_not_today).await {
                    Ok(wger::Outcome::Synced(data)) => {
                        let log = upsert_workout(&state, raw, &data).await?;
                        set_last(&state, UndoAction::LogCreated { log_ids: vec![log.id] });
                        logs.push(log);
                    }
                    Ok(wger::Outcome::Notice(msg)) => notices.push(msg),
                    Err(e) => {
                        tracing::warn!("wger sync failed: {e:#}");
                        notices.push("Could not reach wger, try again.".to_string());
                    }
                }
            }
            Action::Sleep { action, at, wake_at } => {
                let at_ts = parse_at(&at, tz_offset);
                if action == "both" {
                    let wake_ts = parse_at(&wake_at, tz_offset);
                    let start_log = handle_sleep(&state, raw, "start", at_ts, tz_offset).await?;
                    let end_log = handle_sleep(&state, raw, "end", wake_ts, tz_offset).await?;
                    set_last(
                        &state,
                        UndoAction::LogCreated { log_ids: vec![start_log.id, end_log.id] },
                    );
                    logs.push(end_log);
                } else {
                    let log = handle_sleep(&state, raw, &action, at_ts, tz_offset).await?;
                    set_last(&state, UndoAction::LogCreated { log_ids: vec![log.id] });
                    logs.push(log);
                }
            }
            Action::ItineraryItem { destination, name, note } => {
                match append_itinerary(&state, destination.as_deref(), &name, note).await? {
                    Some(log) => {
                        set_last(&state, UndoAction::LogCreated { log_ids: vec![log.id] });
                        logs.push(log);
                    }
                    None => notices.push("No trip found to add to.".to_string()),
                }
            }
            Action::Learning(req) => {
                let log = learning::apply(&state, raw, req).await?;
                set_last(&state, UndoAction::LogCreated { log_ids: vec![log.id] });
                logs.push(log);
            }
            Action::Task(req) => {
                // tasks::apply already records its own richer undo (calendar
                // and checkpoint aware) before returning.
                logs.push(tasks::apply(&state, raw, req).await?);
            }
            Action::Command(req) => {
                let outcome = commands::apply(&state, raw, req, tz_offset).await?;
                notices.push(outcome.notice);
                logs.extend(outcome.logs);
                if outcome.focus_session.is_some() {
                    focus_session = outcome.focus_session;
                }
            }
            Action::Cadence(req) => match cadences::apply(&state, raw, &req, tz_offset).await? {
                cadences::CadenceOutcome::Logged(log) => {
                    set_last(&state, UndoAction::LogCreated { log_ids: vec![log.id] });
                    logs.push(log);
                }
                cadences::CadenceOutcome::AlreadyDone => {}
                cadences::CadenceOutcome::NoMatch => {
                    notices.push(format!("No cadence matches \"{}\".", req.cadence_name))
                }
            },
        }
    }

    let notice = (!notices.is_empty()).then(|| notices.join(" "));
    Ok(Json(CreateResponse { logs, notice, focus_session }))
}

pub async fn list_workouts(State(state): State<AppState>) -> Result<Json<Vec<Log>>, AppError> {
    let workouts: Vec<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs \
         WHERE parsed_type = 'workout' AND deleted_at IS NULL \
         ORDER BY data->>'date' DESC, created_at DESC"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(workouts))
}

pub async fn list_logs(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<Log>>, AppError> {
    let offset_min = query.tz_offset_min.unwrap_or(0);
    if !(-900..=900).contains(&offset_min) {
        return Err(AppError::BadRequest("tz_offset_min out of range".into()));
    }

    // tz_offset_min uses the JS getTimezoneOffset convention: minutes to add
    // to local time to reach UTC (PDT is 420).
    let local_date = match &query.date {
        Some(d) => NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .map_err(|_| AppError::BadRequest("date must be YYYY-MM-DD".into()))?,
        None => (Utc::now() - Duration::minutes(offset_min as i64)).date_naive(),
    };
    let start = Utc.from_utc_datetime(&local_date.and_hms_opt(0, 0, 0).unwrap())
        + Duration::minutes(offset_min as i64);
    let end = start + Duration::days(1);

    let category = query.category.as_deref().unwrap_or("all");
    if !matches!(category, "all" | "nutrition" | "person" | "album" | "song") {
        return Err(AppError::BadRequest(
            "category must be nutrition, person, album, song or all".into(),
        ));
    }

    // Sleep entries belong to the night they close: they are bucketed by
    // night_date (the wake date) and pinned below the day's other entries,
    // first in chronological order since the list renders newest first.
    let logs: Vec<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs \
         WHERE deleted_at IS NULL \
         AND (CASE WHEN parsed_type = 'sleep' AND data->>'night_date' IS NOT NULL \
              THEN data->>'night_date' = $4 \
              ELSE created_at >= $1 AND created_at < $2 END) \
         AND ($3 = 'all' OR parsed_type = $3) \
         ORDER BY (parsed_type = 'sleep') ASC, created_at DESC"
    ))
    .bind(start)
    .bind(end)
    .bind(category)
    .bind(local_date.to_string())
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(logs))
}

pub async fn get_log(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Log>, AppError> {
    let log: Option<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs WHERE id = $1 AND deleted_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;

    log.map(Json).ok_or(AppError::NotFound)
}

pub async fn update_log(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateLog>,
) -> Result<Json<Log>, AppError> {
    if let Some(data) = &body.data {
        if !data.is_object() {
            return Err(AppError::BadRequest("data must be an object".into()));
        }
    }

    let before: Option<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs WHERE id = $1 AND deleted_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let before = before.ok_or(AppError::NotFound)?;

    let log: Option<Log> = sqlx::query_as(&format!(
        "UPDATE logs SET \
            data = data || COALESCE($2, '{{}}'::jsonb), \
            raw_input = COALESCE($3, raw_input) \
         WHERE id = $1 AND deleted_at IS NULL \
         RETURNING {LOG_COLUMNS}"
    ))
    .bind(id)
    .bind(body.data)
    .bind(body.raw_input)
    .fetch_optional(&state.pool)
    .await?;
    let log = log.ok_or(AppError::NotFound)?;

    set_last(&state, UndoAction::LogUpdated { snapshot: before });
    Ok(Json(log))
}

pub async fn delete_log(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let existing: Option<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs WHERE id = $1 AND deleted_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let existing = existing.ok_or(AppError::NotFound)?;

    sqlx::query("UPDATE logs SET deleted_at = now() WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;

    // Task-type log rows just record what happened for the timeline - the
    // real task lives in its own table. Deleting the timeline entry should
    // take the actual task with it too, not leave an orphan in the Tasks
    // panel that no longer has anything to show where it came from.
    let task_id = (existing.parsed_type == "task")
        .then(|| existing.data.get("task_id").and_then(|v| v.as_str()))
        .flatten()
        .and_then(|s| Uuid::parse_str(s).ok());

    if let Some(task_id) = task_id {
        tasks::cascade_delete(&state, task_id).await?;
    } else {
        set_last(&state, UndoAction::LogDeleted { log_id: id });
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_weights(State(state): State<AppState>) -> Result<Json<Vec<Log>>, AppError> {
    let weights: Vec<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs \
         WHERE parsed_type = 'weight' AND deleted_at IS NULL \
         ORDER BY created_at DESC LIMIT 180"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(weights))
}

pub async fn list_sleep(State(state): State<AppState>) -> Result<Json<Vec<Log>>, AppError> {
    let nights: Vec<Log> = sqlx::query_as(&format!(
        "SELECT {LOG_COLUMNS} FROM logs \
         WHERE parsed_type = 'sleep' AND deleted_at IS NULL \
         ORDER BY data->>'night_date' DESC, created_at DESC LIMIT 120"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(nights))
}

pub async fn transcribe(
    State(state): State<AppState>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut audio: Option<(Vec<u8>, String, String)> = None;
    while let Some(part) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("bad multipart: {e}")))?
    {
        if part.name() == Some("file") {
            let content_type = part.content_type().unwrap_or("audio/webm").to_string();
            let filename = part.file_name().unwrap_or("audio.webm").to_string();
            let bytes = part
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(format!("upload failed: {e}")))?;
            audio = Some((bytes.to_vec(), content_type, filename));
        }
    }
    let (bytes, content_type, filename) =
        audio.ok_or_else(|| AppError::BadRequest("no audio file".into()))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(AppError::BadRequest("audio too large".into()));
    }

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&content_type)
        .map_err(|e| AppError::BadRequest(format!("bad content type: {e}")))?;
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-large-v3-turbo")
        .text("response_format", "json")
        .text("language", "en")
        .text(
            "prompt",
            "Personal log entry: food (roti, dal, dosa, paneer, biryani, cortado, oat milk), \
             people met, albums and songs, gym via wger, places, trips, sleep, \
             learning (CS 285, Sutton and Barto, policy gradient).",
        )
        .part("file", part);

    let resp = state
        .http
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(&state.groq_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(%status, "transcription failed: {text}");
        return Err(AppError::Internal(anyhow::anyhow!("transcription failed")));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| AppError::Internal(e.into()))?;
    let raw = body["text"].as_str().unwrap_or("");
    let text = groq::polish(&state.http, &state.groq_key, raw).await;
    Ok(Json(serde_json::json!({ "text": text })))
}

pub async fn health() -> &'static str {
    "ok"
}
