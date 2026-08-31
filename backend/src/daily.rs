use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::routes::AppError;
use crate::AppState;

#[derive(Debug, Serialize, FromRow)]
pub struct DailyNote {
    pub date: NaiveDate,
    pub today_text: String,
    pub tomorrow_text: String,
    pub updated_at: DateTime<Utc>,
}

// Create the row for `date` if it doesn't exist yet, seeding today_text from
// the previous date's tomorrow_text. ON CONFLICT DO NOTHING makes it a no-op
// once the row exists, so the seed only ever happens on the first touch and
// later edits to "today" never reach back into yesterday's row.
async fn ensure_row(state: &AppState, date: NaiveDate) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO daily_notes (date, today_text, tomorrow_text) \
         VALUES ($1, COALESCE((SELECT tomorrow_text FROM daily_notes WHERE date = $1 - 1), ''), '') \
         ON CONFLICT (date) DO NOTHING",
    )
    .bind(date)
    .execute(&state.pool)
    .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub days: Option<i64>,
    pub tz_offset_min: Option<i32>,
}

pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<DailyNote>>, AppError> {
    let days = q.days.unwrap_or(7).clamp(1, 60);
    let offset = q.tz_offset_min.unwrap_or(0);
    let today = (Utc::now() - Duration::minutes(offset as i64)).date_naive();
    // Seed today's row on load so the "today" box already carries over what was
    // written into yesterday's "tomorrow" box.
    ensure_row(&state, today).await?;

    let start = today - Duration::days(days - 1);
    let notes: Vec<DailyNote> = sqlx::query_as(
        "SELECT date, today_text, tomorrow_text, updated_at FROM daily_notes \
         WHERE date >= $1 AND date <= $2 ORDER BY date DESC",
    )
    .bind(start)
    .bind(today)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(notes))
}

#[derive(Debug, Deserialize)]
pub struct PatchNote {
    pub today_text: Option<String>,
    pub tomorrow_text: Option<String>,
}

pub async fn patch(
    State(state): State<AppState>,
    Path(date): Path<String>,
    Json(body): Json<PatchNote>,
) -> Result<Json<DailyNote>, AppError> {
    let date = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("date must be YYYY-MM-DD".into()))?;
    ensure_row(&state, date).await?;

    let note: DailyNote = sqlx::query_as(
        "UPDATE daily_notes SET \
            today_text = COALESCE($2, today_text), \
            tomorrow_text = COALESCE($3, tomorrow_text), \
            updated_at = now() \
         WHERE date = $1 \
         RETURNING date, today_text, tomorrow_text, updated_at",
    )
    .bind(date)
    .bind(body.today_text)
    .bind(body.tomorrow_text)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(note))
}
