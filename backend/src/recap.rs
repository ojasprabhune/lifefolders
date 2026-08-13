use axum::extract::State;
use axum::http::StatusCode;
use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use serde_json::json;
use std::collections::BTreeSet;

use crate::routes::AppError;
use crate::{cadences, AppState};

struct RecapStats {
    start_date: NaiveDate,
    today: NaiveDate,
    focus_minutes: i64,
    tasks_completed: i64,
    workouts: i64,
    avg_sleep_min: Option<f64>,
    streak: Option<(String, i64)>,
    milestone: Option<i64>,
    days: Vec<(NaiveDate, bool)>,
}

const FOCUS_MILESTONE_STEP: i64 = 500;

async fn gather(state: &AppState, offset: i32) -> Result<RecapStats, AppError> {
    let today = (Utc::now() - Duration::minutes(offset as i64)).date_naive();
    let start_date = today - Duration::days(6);
    // Local midnight of the window's first day, expressed in UTC.
    let start_ts = Utc.from_utc_datetime(&start_date.and_hms_opt(0, 0, 0).unwrap())
        + Duration::minutes(offset as i64);

    let focus_minutes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(actual_minutes), 0)::bigint FROM focus_sessions WHERE ended_at >= $1",
    )
    .bind(start_ts)
    .fetch_one(&state.pool)
    .await?;

    let tasks_completed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE completed_at >= $1")
            .bind(start_ts)
            .fetch_one(&state.pool)
            .await?;

    let workouts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM logs \
         WHERE parsed_type = 'workout' AND deleted_at IS NULL AND created_at >= $1",
    )
    .bind(start_ts)
    .fetch_one(&state.pool)
    .await?;

    let avg_sleep_min: Option<f64> = sqlx::query_scalar(
        "SELECT AVG((data->>'duration_min')::float) FROM logs \
         WHERE parsed_type = 'sleep' AND deleted_at IS NULL \
         AND data->>'duration_min' IS NOT NULL AND data->>'night_date' >= $1",
    )
    .bind(start_date.to_string())
    .fetch_one(&state.pool)
    .await?;

    let streak = cadences::max_current_streak(state, offset).await?;

    // Milestone: a lifetime focus-minute total crossing a round number inside
    // this week's sessions.
    let lifetime: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(actual_minutes), 0)::bigint FROM focus_sessions WHERE ended_at IS NOT NULL",
    )
    .fetch_one(&state.pool)
    .await?;
    let before: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(actual_minutes), 0)::bigint FROM focus_sessions \
         WHERE ended_at IS NOT NULL AND ended_at < $1",
    )
    .bind(start_ts)
    .fetch_one(&state.pool)
    .await?;
    let milestone = (lifetime / FOCUS_MILESTONE_STEP > before / FOCUS_MILESTONE_STEP)
        .then(|| (lifetime / FOCUS_MILESTONE_STEP) * FOCUS_MILESTONE_STEP);

    // A day is "active" if anything at all was logged on it.
    let created: Vec<(chrono::DateTime<Utc>,)> = sqlx::query_as(
        "SELECT created_at FROM logs WHERE deleted_at IS NULL AND created_at >= $1",
    )
    .bind(start_ts)
    .fetch_all(&state.pool)
    .await?;
    let active: BTreeSet<NaiveDate> = created
        .into_iter()
        .map(|(ts,)| (ts - Duration::minutes(offset as i64)).date_naive())
        .collect();
    let days: Vec<(NaiveDate, bool)> = (0..7)
        .map(|i| {
            let d = start_date + Duration::days(i);
            (d, active.contains(&d))
        })
        .collect();

    Ok(RecapStats {
        start_date,
        today,
        focus_minutes,
        tasks_completed,
        workouts,
        avg_sleep_min,
        streak,
        milestone,
        days,
    })
}

fn format_sleep(min: Option<f64>) -> String {
    match min {
        Some(m) if m > 0.0 => {
            let total = m.round() as i64;
            format!("{}h {:02}m", total / 60, total % 60)
        }
        _ => "—".into(),
    }
}

fn headline(s: &RecapStats) -> String {
    if let Some(n) = s.milestone {
        return format!("You crossed {n} total focus minutes this week");
    }
    if let Some((name, days)) = &s.streak {
        return format!("{days}-day {name} streak");
    }
    if s.focus_minutes > 0 {
        return format!("{} focus minutes this week", s.focus_minutes);
    }
    "Here's your week".into()
}

fn tile(label: &str, value: &str) -> String {
    format!(
        "<td width=\"50%\" style=\"padding:6px;\">\
           <div style=\"border:1px solid #eae0d3;border-radius:8px;padding:14px 16px;\">\
             <div style=\"font-family:Georgia,serif;font-size:28px;color:#2b2521;line-height:1;\">{value}</div>\
             <div style=\"font-size:12px;color:#8a7d74;margin-top:6px;\">{label}</div>\
           </div>\
         </td>"
    )
}

fn render_html(s: &RecapStats) -> String {
    let mut tiles: Vec<String> = vec![
        tile("focus minutes", &s.focus_minutes.to_string()),
        tile("tasks completed", &s.tasks_completed.to_string()),
        tile("workouts", &s.workouts.to_string()),
        tile("avg sleep", &format_sleep(s.avg_sleep_min)),
    ];
    if let Some((name, days)) = &s.streak {
        tiles.push(tile(&format!("{name} streak"), &format!("{days}d")));
    }
    // Pad to an even count so the 2-column grid stays aligned.
    if tiles.len() % 2 == 1 {
        tiles.push("<td width=\"50%\" style=\"padding:6px;\"></td>".into());
    }
    let tile_rows: String = tiles
        .chunks(2)
        .map(|pair| format!("<tr>{}</tr>", pair.join("")))
        .collect();

    let day_letters = ["s", "m", "t", "w", "t", "f", "s"];
    let cells: String = s
        .days
        .iter()
        .enumerate()
        .map(|(i, (d, active))| {
            let bg = if *active { "#e4402a" } else { "#e6dccd" };
            let letter = day_letters[d.weekday().num_days_from_sunday() as usize];
            let _ = i;
            format!(
                "<td align=\"center\" style=\"padding:0 3px;\">\
                   <div style=\"width:30px;height:30px;border-radius:7px;background:{bg};\"></div>\
                   <div style=\"font-size:10px;color:#8a7d74;margin-top:4px;\">{letter}</div>\
                 </td>"
            )
        })
        .collect();

    let range = format!(
        "{} – {}",
        s.start_date.format("%b %-d"),
        s.today.format("%b %-d")
    );
    let headline = headline(s);

    format!(
        "<!doctype html><html><body style=\"margin:0;background:#fbf3ea;\">\
         <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#fbf3ea;padding:24px 0;\"><tr><td align=\"center\">\
           <table role=\"presentation\" width=\"480\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:480px;max-width:92%;font-family:Helvetica,Arial,sans-serif;\">\
             <tr><td style=\"background:#2b2521;border-radius:12px;padding:28px 24px;\">\
               <div style=\"font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#c9beb3;\">life · week in review</div>\
               <div style=\"font-family:Georgia,serif;font-size:26px;color:#fbf3ea;margin-top:10px;line-height:1.25;\">{headline}</div>\
               <div style=\"font-size:13px;color:#8a7d74;margin-top:8px;\">{range}</div>\
             </td></tr>\
             <tr><td style=\"height:12px;\"></td></tr>\
             <tr><td><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\">{tile_rows}</table></td></tr>\
             <tr><td style=\"height:12px;\"></td></tr>\
             <tr><td style=\"padding:6px;\">\
               <div style=\"font-size:12px;color:#8a7d74;margin:0 0 10px 2px;\">activity this week</div>\
               <table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\"><tr>{cells}</tr></table>\
             </td></tr>\
           </table>\
         </td></tr></table>\
         </body></html>"
    )
}

pub async fn send(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let Some(cfg) = state.recap.clone() else {
        return Err(AppError::BadRequest("recap email not configured".into()));
    };
    let stats = gather(&state, cfg.tz_offset_min).await?;
    let html = render_html(&stats);
    let subject = format!(
        "your week · {} – {}",
        stats.start_date.format("%b %-d"),
        stats.today.format("%b %-d")
    );

    let payload = json!({
        "from": cfg.from,
        "to": [cfg.to],
        "subject": subject,
        "html": html,
    });
    let resp = state
        .http
        .post("https://api.resend.com/emails")
        .bearer_auth(&cfg.api_key)
        .json(&payload)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(%status, "resend send failed: {text}");
        return Err(AppError::Internal(anyhow::anyhow!("email send failed")));
    }
    Ok(StatusCode::OK)
}
