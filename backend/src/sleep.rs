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
    // The goal lives in the browser's localStorage, so the client has to hand
    // it over for the blurb to be able to talk about hitting or missing it.
    pub goal_min: Option<i64>,
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
    goal_min: i32,
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
    let goal_min = q.goal_min.unwrap_or(480).clamp(240, 720);
    let today = (Utc::now() - Duration::minutes(offset as i64)).date_naive();

    let cached: Option<CachedInsight> =
        sqlx::query_as("SELECT for_date, blurb, goal_min FROM sleep_insight_cache WHERE id = 1")
            .fetch_optional(&state.pool)
            .await?;
    if let Some(c) = cached {
        // The blurb is written against a goal, so a changed goal invalidates
        // it just as surely as a new day does.
        if c.for_date == today && i64::from(c.goal_min) == goal_min {
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

    let brief = format!("{}\n\n{}", build_facts(&nights, goal_min), build_summary(&nights, offset));
    let blurb = match groq::sleep_insight(&state.http, &state.groq_key, &brief).await {
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
        "INSERT INTO sleep_insight_cache (id, for_date, blurb, goal_min, generated_at) \
         VALUES (1, $1, $2, $3, now()) \
         ON CONFLICT (id) DO UPDATE SET for_date = $1, blurb = $2, goal_min = $3, generated_at = now()",
    )
    .bind(today)
    .bind(&blurb)
    .bind(goal_min as i32)
    .execute(&state.pool)
    .await?;

    Ok(Json(InsightResponse { blurb, generated_for: today }))
}

/// Nights oldest-first, each line stating how many days separate it from the
/// line above. Without that the model reads "next line down" as "next night",
/// which is how two Saturdays a week apart got called back to back.
fn build_summary(nights: &[SleepData], offset_min: i32) -> String {
    let mut lines = Vec::with_capacity(nights.len());
    let mut prev: Option<NaiveDate> = None;
    for n in nights.iter().rev() {
        let date = NaiveDate::parse_from_str(&n.night_date, "%Y-%m-%d").ok();
        let weekday = date.map(|d| d.weekday().to_string()).unwrap_or_default();
        let gap = match (prev, date) {
            (Some(p), Some(d)) => match (d - p).num_days() {
                1 => " (the next night)".to_string(),
                n => format!(" ({n} days after the line above)"),
            },
            _ => String::new(),
        };
        let duration = n.duration_min.map(format_duration).unwrap_or_else(|| "?".into());
        let bed = n.sleep_start.map(|t| local_time(t, offset_min)).unwrap_or_else(|| "?".into());
        let wake = n.sleep_end.map(|t| local_time(t, offset_min)).unwrap_or_else(|| "?".into());
        lines.push(format!(
            "{} {}: {}, bed {}, up {}{}",
            weekday, n.night_date, duration, bed, wake, gap
        ));
        prev = date;
    }
    format!("NIGHTS (oldest first):\n{}", lines.join("\n"))
}

/// Every relational claim the blurb is allowed to make, worked out here rather
/// than left to the model - it reached for "in a row" to mean "both of these"
/// and contradicted the streak counter sitting right beside it on screen.
/// Mirrors computeMetrics() in Sleep.tsx so the two can't disagree.
fn build_facts(nights: &[SleepData], goal_min: i64) -> String {
    // Oldest-first, only nights with a real duration, only parseable dates.
    let mut closed: Vec<(NaiveDate, i64)> = nights
        .iter()
        .filter_map(|n| {
            let d = NaiveDate::parse_from_str(&n.night_date, "%Y-%m-%d").ok()?;
            Some((d, n.duration_min?))
        })
        .collect();
    closed.sort_by_key(|(d, _)| *d);

    let mut out = format!("FACTS (the only relationships you may state):\n- goal: {}\n", format_duration(goal_min));

    // Runs of calendar-consecutive nights that each hit the goal. The current
    // streak is the run that ends on the most recent night, and only then.
    let mut runs: Vec<Vec<NaiveDate>> = Vec::new();
    for (date, mins) in &closed {
        if *mins < goal_min {
            continue;
        }
        match runs.last_mut() {
            Some(run) if *run.last().unwrap() + Duration::days(1) == *date => run.push(*date),
            _ => runs.push(vec![*date]),
        }
    }
    let latest = closed.last().map(|(d, _)| *d);
    let current = runs
        .last()
        .filter(|r| Some(*r.last().unwrap()) == latest)
        .map(|r| r.len())
        .unwrap_or(0);
    out.push_str(&format!("- current streak of goal-hitting nights: {current}\n"));
    match runs.iter().max_by_key(|r| r.len()) {
        Some(best) if best.len() > 1 => out.push_str(&format!(
            "- longest run of consecutive goal-hitting nights in this window: {} ({} to {})\n",
            best.len(),
            best.first().unwrap(),
            best.last().unwrap()
        )),
        _ => out.push_str(
            "- longest run of consecutive goal-hitting nights in this window: 1 or fewer, so NOTHING here is \"in a row\"\n",
        ),
    }

    let hits = closed.iter().filter(|(_, m)| *m >= goal_min).count();
    out.push_str(&format!("- nights at or over goal: {hits} of {}\n", closed.len()));
    if let Some((d, m)) = closed.iter().max_by_key(|(_, m)| *m) {
        out.push_str(&format!("- longest night: {} on {d}\n", format_duration(*m)));
    }
    if let Some((d, m)) = closed.iter().min_by_key(|(_, m)| *m) {
        out.push_str(&format!("- shortest night: {} on {d}\n", format_duration(*m)));
    }

    let avg = |v: Vec<i64>| (!v.is_empty()).then(|| v.iter().sum::<i64>() / v.len() as i64);
    let is_weekend =
        |d: &NaiveDate| matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun);
    let weekday_avg = avg(closed.iter().filter(|(d, _)| !is_weekend(d)).map(|(_, m)| *m).collect());
    let weekend_avg = avg(closed.iter().filter(|(d, _)| is_weekend(d)).map(|(_, m)| *m).collect());
    if let Some(m) = weekday_avg {
        out.push_str(&format!("- weekday average: {}\n", format_duration(m)));
    }
    if let Some(m) = weekend_avg {
        out.push_str(&format!("- weekend average: {}\n", format_duration(m)));
    }
    if let Some(m) = avg(closed.iter().rev().take(7).map(|(_, m)| *m).collect()) {
        out.push_str(&format!(
            "- last 7 nights average: {} ({} vs goal)\n",
            format_duration(m),
            format_duration((m - goal_min).abs())
        ));
    }
    out
}

fn format_duration(min: i64) -> String {
    format!("{}h{:02}m", min / 60, min % 60)
}

fn local_time(ts: DateTime<Utc>, offset_min: i32) -> String {
    let local = ts - Duration::minutes(offset_min as i64);
    local.format("%I:%M%P").to_string().trim_start_matches('0').to_string()
}

#[cfg(test)]
mod tests {
    use super::build_facts;
    use crate::models::SleepData;

    fn night(date: &str, minutes: i64) -> SleepData {
        SleepData {
            sleep_start: None,
            sleep_end: None,
            duration_min: Some(minutes),
            night_date: date.into(),
        }
    }

    // The reported bug: Aug 15 and Aug 22 were the two 9h+ nights, a week
    // apart, and the blurb called them "two 9-hour+ nights in a row" while the
    // streak counter beside it read 0. The only real run here is Aug 15-16,
    // and Aug 22 stands alone - so the facts can never offer that pair.
    #[test]
    fn two_good_nights_a_week_apart_are_not_a_run() {
        let nights = vec![
            night("2026-08-23", 448),
            night("2026-08-22", 564),
            night("2026-08-21", 449),
            night("2026-08-20", 325),
            night("2026-08-19", 426),
            night("2026-08-18", 414),
            night("2026-08-17", 332),
            night("2026-08-16", 522),
            night("2026-08-15", 593),
        ];
        let facts = build_facts(&nights, 480);
        assert!(facts.contains("current streak of goal-hitting nights: 0"), "{facts}");
        assert!(facts.contains("nights at or over goal: 3 of 9"), "{facts}");
        // The only run offered is the genuinely adjacent pair, so there is no
        // way to read Aug 22 as being in a row with anything.
        assert!(facts.contains("window: 2 (2026-08-15 to 2026-08-16)"), "{facts}");
        assert!(!facts.contains("2026-08-22 to"), "{facts}");
    }

    #[test]
    fn a_real_run_ending_today_is_the_current_streak() {
        let nights = vec![
            night("2026-08-23", 500),
            night("2026-08-22", 510),
            night("2026-08-21", 400),
        ];
        let facts = build_facts(&nights, 480);
        assert!(facts.contains("current streak of goal-hitting nights: 2"), "{facts}");
        assert!(facts.contains("2026-08-22 to 2026-08-23"), "{facts}");
    }

    // A run that ended before the most recent night is history, not a streak.
    #[test]
    fn a_run_that_ended_earlier_is_not_the_current_streak() {
        let nights = vec![
            night("2026-08-23", 400),
            night("2026-08-22", 510),
            night("2026-08-21", 500),
        ];
        let facts = build_facts(&nights, 480);
        assert!(facts.contains("current streak of goal-hitting nights: 0"), "{facts}");
        assert!(facts.contains("2026-08-21 to 2026-08-22"), "{facts}");
    }
}
