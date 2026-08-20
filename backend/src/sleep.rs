use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::groq;
use crate::models::SleepData;
use crate::routes::AppError;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct InsightQuery {
    pub tz_offset_min: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct InsightResponse {
    pub blurb: String,
    pub generated_for: NaiveDate,
}

#[derive(Debug, sqlx::FromRow)]
struct CachedInsight {
    for_date: NaiveDate,
    blurb: String,
}

/// The metrics/trend chart on the solace dashboard are computed client-side
/// straight off `GET /api/sleep`, same as the weight trend on soma - this
/// endpoint only exists for the one thing that needs a server: the daily LLM
/// blurb, cached so Groq is called once a day rather than on every page open.
pub async fn insight(
    State(state): State<AppState>,
    Query(q): Query<InsightQuery>,
) -> Result<Json<InsightResponse>, AppError> {
    let offset = q.tz_offset_min.unwrap_or(0);
    let today = (Utc::now() - Duration::minutes(offset as i64)).date_naive();

    let cached: Option<CachedInsight> =
        sqlx::query_as("SELECT for_date, blurb FROM sleep_insight_cache WHERE id = 1")
            .fetch_optional(&state.pool)
            .await?;
    if let Some(c) = cached {
        if c.for_date == today {
            return Ok(Json(InsightResponse { blurb: c.blurb, generated_for: today }));
        }
    }

    let rows: Vec<(serde_json::Value,)> = sqlx::query_as(
        "SELECT data FROM logs \
         WHERE parsed_type = 'sleep' AND deleted_at IS NULL \
           AND data->>'sleep_end' IS NOT NULL \
         ORDER BY data->>'night_date' DESC, created_at DESC LIMIT 14",
    )
    .fetch_all(&state.pool)
    .await?;
    let nights: Vec<SleepData> = rows
        .into_iter()
        .filter_map(|(v,)| serde_json::from_value(v).ok())
        .collect();

    // Not enough nights for a pattern to mean anything yet - skip the LLM
    // call entirely and don't cache, so it re-checks as soon as more nights
    // land instead of being stuck on this message until tomorrow.
    if nights.len() < 3 {
        return Ok(Json(InsightResponse {
            blurb: "log a few more nights to get a read on your pattern".into(),
            generated_for: today,
        }));
    }

    let summary = build_summary(&nights, offset);
    let blurb = match groq::sleep_insight(&state.http, &state.groq_key, &summary).await {
        Some(b) => b,
        // Also uncached, for the same reason: a transient Groq failure
        // shouldn't lock in a placeholder for the rest of the day.
        None => {
            return Ok(Json(InsightResponse {
                blurb: "couldn't reach the sleep coach right now".into(),
                generated_for: today,
            }))
        }
    };

    sqlx::query(
        "INSERT INTO sleep_insight_cache (id, for_date, blurb, generated_at) VALUES (1, $1, $2, now()) \
         ON CONFLICT (id) DO UPDATE SET for_date = $1, blurb = $2, generated_at = now()",
    )
    .bind(today)
    .bind(&blurb)
    .execute(&state.pool)
    .await?;

    Ok(Json(InsightResponse { blurb, generated_for: today }))
}

fn build_summary(nights: &[SleepData], offset_min: i32) -> String {
    nights
        .iter()
        .map(|n| {
            let weekday = NaiveDate::parse_from_str(&n.night_date, "%Y-%m-%d")
                .map(|d| d.weekday().to_string())
                .unwrap_or_default();
            let duration = n.duration_min.map(format_duration).unwrap_or_else(|| "?".into());
            let bed = n.sleep_start.map(|t| local_time(t, offset_min)).unwrap_or_else(|| "?".into());
            let wake = n.sleep_end.map(|t| local_time(t, offset_min)).unwrap_or_else(|| "?".into());
            format!("{} {}: {}, bed {}, up {}", weekday, n.night_date, duration, bed, wake)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_duration(min: i64) -> String {
    format!("{}h{:02}m", min / 60, min % 60)
}

fn local_time(ts: DateTime<Utc>, offset_min: i32) -> String {
    let local = ts - Duration::minutes(offset_min as i64);
    local.format("%I:%M%P").to_string().trim_start_matches('0').to_string()
}
