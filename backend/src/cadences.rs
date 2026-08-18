use std::collections::BTreeSet;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::models::{CadenceCompletionRequest, CadenceData, Log};
use crate::routes::AppError;
use crate::AppState;

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct Cadence {
    pub id: Uuid,
    pub name: String,
    pub target_frequency: String,
    pub active: bool,
    pub created_at: DateTime<Utc>,
}

const CADENCE_COLUMNS: &str = "id, name, target_frequency, active, created_at";

async fn active_cadences(state: &AppState) -> Result<Vec<Cadence>, AppError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {CADENCE_COLUMNS} FROM cadences WHERE active ORDER BY created_at"
    ))
    .fetch_all(&state.pool)
    .await?)
}

// Same conservative matching as tasks: only accept a whole-title equality or
// containment. A weaker "shares a word" tier would let "read" match "read 30
// pages" style cadences by accident; a missed match just falls through to a
// notice, which is safer than logging a completion against the wrong cadence.
fn best_match<'a>(cadences: &'a [Cadence], query: &str) -> Option<&'a Cadence> {
    let q = query.trim().to_lowercase();
    let mut best: Option<(&Cadence, i32)> = None;
    for cadence in cadences {
        let n = cadence.name.trim().to_lowercase();
        let score = if n == q {
            2
        } else if n.contains(&q) || q.contains(&n) {
            1
        } else {
            continue;
        };
        if best.map(|(_, s)| score > s).unwrap_or(true) {
            best = Some((cadence, score));
        }
    }
    best.map(|(cadence, _)| cadence)
}

pub async fn context_block(state: &AppState) -> String {
    let Ok(cadences) = active_cadences(state).await else {
        return String::new();
    };
    if cadences.is_empty() {
        return String::new();
    }
    let mut out = String::from("Active cadences:\n");
    for h in cadences.iter().take(40) {
        out.push_str(&format!("- {} ({})\n", h.name, h.target_frequency));
    }
    out
}

/// Resolve the free-text cadence name against the active cadences and, on a match,
/// write a completion log row. Returns None when nothing matches so the caller
/// can surface a notice rather than inventing a cadence.
pub async fn apply(
    state: &AppState,
    raw: &str,
    req: &CadenceCompletionRequest,
) -> Result<Option<Log>, AppError> {
    let cadences = active_cadences(state).await?;
    let Some(cadence) = best_match(&cadences, &req.cadence_name) else {
        return Ok(None);
    };

    let data = CadenceData {
        cadence_id: cadence.id,
        cadence_name: cadence.name.clone(),
    };
    let log: Log = sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'cadence_completion', $2) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(raw)
    .bind(serde_json::to_value(&data).unwrap())
    .fetch_one(&state.pool)
    .await?;
    Ok(Some(log))
}

pub async fn list_cadences(State(state): State<AppState>) -> Result<Json<Vec<Cadence>>, AppError> {
    Ok(Json(active_cadences(&state).await?))
}

#[derive(Debug, Deserialize)]
pub struct CreateCadence {
    pub name: String,
    pub target_frequency: Option<String>,
}

pub async fn create_cadence(
    State(state): State<AppState>,
    Json(body): Json<CreateCadence>,
) -> Result<Json<Cadence>, AppError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is empty".into()));
    }
    let freq = body.target_frequency.as_deref().unwrap_or("daily");
    if !matches!(freq, "daily" | "weekly") {
        return Err(AppError::BadRequest("frequency must be daily or weekly".into()));
    }
    let cadence: Cadence = sqlx::query_as(&format!(
        "INSERT INTO cadences (name, target_frequency) VALUES ($1, $2) RETURNING {CADENCE_COLUMNS}"
    ))
    .bind(name)
    .bind(freq)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(cadence))
}

#[derive(Debug, Deserialize)]
pub struct PatchCadence {
    pub name: String,
}

pub async fn patch_cadence(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchCadence>,
) -> Result<Json<Cadence>, AppError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is empty".into()));
    }
    let cadence: Option<Cadence> = sqlx::query_as(&format!(
        "UPDATE cadences SET name = $2 WHERE id = $1 AND active RETURNING {CADENCE_COLUMNS}"
    ))
    .bind(id)
    .bind(name)
    .fetch_optional(&state.pool)
    .await?;
    cadence.map(Json).ok_or(AppError::NotFound)
}

// Archive rather than delete: past completion logs still reference the cadence
// by name for the timeline, so keeping the definition around costs nothing and
// avoids dangling ids.
pub async fn archive_cadence(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let done = sqlx::query("UPDATE cadences SET active = false WHERE id = $1 AND active")
        .bind(id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct CompletionsQuery {
    pub days: Option<i64>,
    pub tz_offset_min: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct Completions {
    pub dates: Vec<NaiveDate>,
    pub current_streak: i64,
    pub longest_streak: i64,
}

pub async fn completions(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<CompletionsQuery>,
) -> Result<Json<Completions>, AppError> {
    let days = q.days.unwrap_or(90).clamp(1, 400);
    let offset = q.tz_offset_min.unwrap_or(0);
    let today = (Utc::now() - Duration::minutes(offset as i64)).date_naive();
    // Fetch a little before the window so a streak running up to the window's
    // first day is measured against real neighbours, not a hard cutoff.
    let since = today - Duration::days(days + 1);

    let rows: Vec<(DateTime<Utc>,)> = sqlx::query_as(
        "SELECT created_at FROM logs \
         WHERE parsed_type = 'cadence_completion' AND deleted_at IS NULL \
         AND data->>'cadence_id' = $1 AND created_at >= $2 \
         ORDER BY created_at",
    )
    .bind(id.to_string())
    .bind(Utc.from_utc_datetime(&since.and_hms_opt(0, 0, 0).unwrap()))
    .fetch_all(&state.pool)
    .await?;

    // Collapse timestamps into distinct local completion dates.
    let all: BTreeSet<NaiveDate> = rows
        .into_iter()
        .map(|(ts,)| (ts - Duration::minutes(offset as i64)).date_naive())
        .collect();

    let current_streak = current_run(&all, today);
    let longest_streak = longest_run(&all);

    // Only surface the dates inside the requested window to the client; the
    // extra day pulled above was just for accurate streak measurement.
    let start = today - Duration::days(days - 1);
    let dates: Vec<NaiveDate> = all.into_iter().filter(|d| *d >= start).collect();

    Ok(Json(Completions { dates, current_streak, longest_streak }))
}

/// The single strongest live streak across all active cadences, as
/// (name, days). Used by the weekly recap. None when nothing is streaking.
pub async fn max_current_streak(
    state: &AppState,
    tz_offset: i32,
) -> Result<Option<(String, i64)>, AppError> {
    let cadences = active_cadences(state).await?;
    let today = (Utc::now() - Duration::minutes(tz_offset as i64)).date_naive();
    let since = today - Duration::days(400);
    let mut best: Option<(String, i64)> = None;
    for c in cadences {
        let rows: Vec<(DateTime<Utc>,)> = sqlx::query_as(
            "SELECT created_at FROM logs \
             WHERE parsed_type = 'cadence_completion' AND deleted_at IS NULL \
             AND data->>'cadence_id' = $1 AND created_at >= $2",
        )
        .bind(c.id.to_string())
        .bind(Utc.from_utc_datetime(&since.and_hms_opt(0, 0, 0).unwrap()))
        .fetch_all(&state.pool)
        .await?;
        let dates: BTreeSet<NaiveDate> = rows
            .into_iter()
            .map(|(ts,)| (ts - Duration::minutes(tz_offset as i64)).date_naive())
            .collect();
        let streak = current_run(&dates, today);
        if streak > 0 && best.as_ref().map(|(_, s)| streak > *s).unwrap_or(true) {
            best = Some((c.name.clone(), streak));
        }
    }
    Ok(best)
}

// Consecutive days counting back from today, or from yesterday when today
// isn't done yet, so an unfinished-but-alive streak still shows.
fn current_run(dates: &BTreeSet<NaiveDate>, today: NaiveDate) -> i64 {
    let mut day = if dates.contains(&today) {
        today
    } else if dates.contains(&(today - Duration::days(1))) {
        today - Duration::days(1)
    } else {
        return 0;
    };
    let mut streak = 0;
    while dates.contains(&day) {
        streak += 1;
        day -= Duration::days(1);
    }
    streak
}

fn longest_run(dates: &BTreeSet<NaiveDate>) -> i64 {
    let mut longest = 0;
    let mut run = 0;
    let mut prev: Option<NaiveDate> = None;
    for &d in dates {
        run = match prev {
            Some(p) if d == p + Duration::days(1) => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        prev = Some(d);
    }
    longest
}

#[cfg(test)]
mod tests {
    use super::{current_run, longest_run};
    use chrono::{Duration, NaiveDate};
    use std::collections::BTreeSet;

    fn set(days: &[i64], today: NaiveDate) -> BTreeSet<NaiveDate> {
        days.iter().map(|&n| today + Duration::days(n)).collect()
    }

    #[test]
    fn current_streak_counts_back_from_today() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
        // today, yesterday, two days ago done; gap; older run
        let dates = set(&[0, -1, -2, -4, -5], today);
        assert_eq!(current_run(&dates, today), 3);
    }

    #[test]
    fn current_streak_uses_yesterday_when_today_missing() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
        let dates = set(&[-1, -2], today);
        assert_eq!(current_run(&dates, today), 2);
    }

    #[test]
    fn current_streak_zero_when_gap_before_today() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
        let dates = set(&[-2, -3], today);
        assert_eq!(current_run(&dates, today), 0);
    }

    #[test]
    fn longest_streak_finds_best_run() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
        let dates = set(&[0, -1, -3, -4, -5, -6, -9], today);
        assert_eq!(longest_run(&dates), 4);
    }
}
