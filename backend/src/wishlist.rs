use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::models::Log;
use crate::routes::AppError;
use crate::AppState;

pub const KINDS: &[&str] = &["album", "song", "place", "trip", "learning", "other"];

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct WishlistItem {
    pub id: Uuid,
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_log_id: Option<Uuid>,
}

const ITEM_COLUMNS: &str = "id, kind, title, detail, created_at, resolved_at, resolved_log_id";

async fn open_items(state: &AppState) -> Result<Vec<WishlistItem>, AppError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM wishlist_items \
         WHERE resolved_at IS NULL AND archived_at IS NULL ORDER BY created_at"
    ))
    .fetch_all(&state.pool)
    .await?)
}

pub async fn context_block(state: &AppState) -> String {
    let Ok(items) = open_items(state).await else {
        return String::new();
    };
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::from("On the wishlist (wants, not yet done):\n");
    for i in items.iter().take(40) {
        out.push_str(&format!("- [{}] {}\n", i.kind, i.title));
    }
    out
}

/// Add an item, writing the timeline row alongside it.
pub async fn add(
    state: &AppState,
    raw: &str,
    kind: &str,
    title: &str,
    detail: Option<String>,
) -> Result<(WishlistItem, Log), AppError> {
    let kind = if KINDS.contains(&kind) { kind } else { "other" };
    let item: WishlistItem = sqlx::query_as(&format!(
        "INSERT INTO wishlist_items (kind, title, detail) VALUES ($1, $2, $3) \
         RETURNING {ITEM_COLUMNS}"
    ))
    .bind(kind)
    .bind(title.trim())
    .bind(detail)
    .fetch_one(&state.pool)
    .await?;

    let data = serde_json::json!({
        "item_id": item.id,
        "kind": item.kind,
        "title": item.title,
        "action": "added",
    });
    let log: Log = sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'wishlist', $2) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(raw)
    .bind(data)
    .fetch_one(&state.pool)
    .await?;
    Ok((item, log))
}

/// The wishlist kind and name a freshly logged entry would be known by, or
/// None when this kind of entry can't cross anything off. The parsed_type
/// doubles as the wishlist kind; only the field holding the name differs.
fn candidate<'a>(parsed_type: &'a str, data: &serde_json::Value) -> Option<(&'a str, String)> {
    let field = match parsed_type {
        "album" | "song" => "title",
        "place" => "name",
        "trip" => "destination",
        "learning" => "field_name",
        _ => return None,
    };
    let name = data.get(field)?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    Some((parsed_type, name.to_string()))
}

fn days_waited(from: DateTime<Utc>, to: DateTime<Utc>) -> i64 {
    (to - from).num_days().max(0)
}

/// Called after any log is inserted: if it matches something open on the
/// wishlist of the same kind, cross it off and hand back a notice. A miss is
/// silent - most entries have nothing waiting for them.
pub async fn try_resolve(
    state: &AppState,
    log: &Log,
) -> Result<Option<String>, AppError> {
    let Some((kind, name)) = candidate(&log.parsed_type, &log.data) else {
        return Ok(None);
    };

    let item: Option<WishlistItem> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM wishlist_items \
         WHERE resolved_at IS NULL AND archived_at IS NULL AND kind = $1 \
         AND ($2 ILIKE '%' || title || '%' OR title ILIKE '%' || $2 || '%') \
         ORDER BY length(title) DESC LIMIT 1"
    ))
    .bind(kind)
    .bind(&name)
    .fetch_optional(&state.pool)
    .await?;
    let Some(item) = item else { return Ok(None) };

    sqlx::query("UPDATE wishlist_items SET resolved_at = now(), resolved_log_id = $2 WHERE id = $1")
        .bind(item.id)
        .bind(log.id)
        .execute(&state.pool)
        .await?;

    let data = serde_json::json!({
        "item_id": item.id,
        "kind": item.kind,
        "title": item.title,
        "action": "resolved",
        "days_waited": days_waited(item.created_at, Utc::now()),
    });
    sqlx::query("INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'wishlist', $2)")
        .bind(&log.raw_input)
        .bind(data)
        .execute(&state.pool)
        .await?;

    let waited = days_waited(item.created_at, Utc::now());
    Ok(Some(match waited {
        0 => format!("crossed \"{}\" off your list.", item.title),
        1 => format!("crossed \"{}\" off your list — sat there a day.", item.title),
        n => format!("crossed \"{}\" off your list — sat there {n} days.", item.title),
    }))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<WishlistItem>>, AppError> {
    let items: Vec<WishlistItem> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM wishlist_items WHERE archived_at IS NULL \
         ORDER BY resolved_at NULLS FIRST, created_at DESC"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(items))
}

#[derive(Debug, Deserialize)]
pub struct NewItem {
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<NewItem>,
) -> Result<Json<WishlistItem>, AppError> {
    let title = body.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("title is empty".into()));
    }
    if !KINDS.contains(&body.kind.as_str()) {
        return Err(AppError::BadRequest("unknown kind".into()));
    }
    let raw = format!("want to: {title}");
    let (item, _) = add(&state, &raw, &body.kind, title, body.detail).await?;
    Ok(Json(item))
}

#[derive(Debug, Deserialize)]
pub struct PatchItem {
    pub title: Option<String>,
    pub detail: Option<String>,
    pub resolved: Option<bool>,
}

pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchItem>,
) -> Result<Json<WishlistItem>, AppError> {
    let item: Option<WishlistItem> = sqlx::query_as(&format!(
        "UPDATE wishlist_items SET \
            title = COALESCE($2, title), \
            detail = COALESCE($3, detail), \
            resolved_at = CASE WHEN $4::bool IS NULL THEN resolved_at \
                               WHEN $4 THEN COALESCE(resolved_at, now()) \
                               ELSE NULL END \
         WHERE id = $1 AND archived_at IS NULL RETURNING {ITEM_COLUMNS}"
    ))
    .bind(id)
    .bind(body.title.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(body.detail)
    .bind(body.resolved)
    .fetch_optional(&state.pool)
    .await?;
    item.map(Json).ok_or(AppError::NotFound)
}

pub async fn archive(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let done = sqlx::query("UPDATE wishlist_items SET archived_at = now() WHERE id = $1 AND archived_at IS NULL")
        .bind(id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
