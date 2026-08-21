use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::models::Log;
use crate::routes::AppError;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub limit: Option<i64>,
}

pub async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<Log>>, AppError> {
    let q = query.q.trim();
    if q.chars().count() < 2 {
        return Err(AppError::BadRequest("search needs at least 2 characters".into()));
    }
    let limit = query.limit.unwrap_or(100).clamp(1, 200);

    // ILIKE over data::text is deliberately crude: at this scale (thousands of
    // rows, one user) a sequential scan is instant, and it means every domain
    // is searchable without teaching the query about each one's JSONB shape.
    let logs: Vec<Log> = sqlx::query_as(
        "SELECT id, created_at, raw_input, parsed_type, data FROM logs \
         WHERE deleted_at IS NULL \
         AND (raw_input ILIKE $1 OR data::text ILIKE $1) \
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(format!("%{q}%"))
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(logs))
}
