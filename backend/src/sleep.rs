use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc};
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
    recent_blurbs: sqlx::types::Json<Vec<String>>,
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

    let cached: Option<CachedInsight> = sqlx::query_as(
        "SELECT for_date, blurb, goal_min, recent_blurbs FROM sleep_insight_cache WHERE id = 1",
    )
    .fetch_optional(&state.pool)
    .await?;
    let mut history: Vec<String> = Vec::new();
    if let Some(c) = cached {
        // The blurb is written against a goal, so a changed goal invalidates
        // it just as surely as a new day does.
        if c.for_date == today && i64::from(c.goal_min) == goal_min {
            return Ok(Json(InsightResponse { blurb: c.blurb, generated_for: today }));
        }
        history = c.recent_blurbs.0;
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

    let mut brief = format!(
        "{}\n\n{}",
        build_facts(&nights, goal_min, offset),
        build_summary(&nights, offset)
    );
    if !history.is_empty() {
        brief.push_str(&format!(
            "\n\nWHAT YOU ALREADY SENT THEM (newest first - do not reuse these openings, shapes or phrasings):\n{}",
            history.iter().map(|b| format!("- {b}")).collect::<Vec<_>>().join("\n")
        ));
    }
    brief.push_str(&format!("\n\nTODAY'S ANGLE (follow it): {}\n", angle_for(today)));
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

    history.insert(0, blurb.clone());
    history.truncate(5);
    sqlx::query(
        "INSERT INTO sleep_insight_cache (id, for_date, blurb, goal_min, recent_blurbs, generated_at) \
         VALUES (1, $1, $2, $3, $4, now()) \
         ON CONFLICT (id) DO UPDATE SET for_date = $1, blurb = $2, goal_min = $3, \
             recent_blurbs = $4, generated_at = now()",
    )
    .bind(today)
    .bind(&blurb)
    .bind(goal_min as i32)
    .bind(sqlx::types::Json(&history))
    .execute(&state.pool)
    .await?;

    Ok(Json(InsightResponse { blurb, generated_for: today }))
}

/// The input to this call barely changes from day to day, so left alone the
/// model converges on one sentence skeleton - "you got Xh last night, lights
/// out by Y, you've got this" - and only the numbers move. Rotating the shape
/// of the message here is the part the model can't be trusted to vary itself.
fn angle_for(day: NaiveDate) -> &'static str {
    const ANGLES: [&str; 7] = [
        "open with the instruction itself, no wind-up. the number can come after, or not at all.",
        "one flat sentence. no encouragement, no sign-off, no exclamation.",
        "be blunt about the gap and leave the reassurance out entirely.",
        "lead with the thing they are getting right, then the ask.",
        "write it like you are checking in on a friend, and get them to commit to the time.",
        "short and hyped. push them hard, keep it to two clauses.",
        "skip the pep talk and lay out the arithmetic plainly - what time, for what wake-up.",
    ];
    ANGLES[(day.num_days_from_ce() as usize) % ANGLES.len()]
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
///
/// Split into RECENT and BACKGROUND because a flat list let the model pick
/// whichever figure was most dramatic - usually the longest night, often a
/// week and a half old - and open with it as if it were news. The sentence is
/// supposed to be about how the last few nights are going.
fn build_facts(nights: &[SleepData], goal_min: i64, offset_min: i32) -> String {
    // Oldest-first, only nights with a real duration, only parseable dates.
    let mut closed: Vec<(NaiveDate, i64)> = nights
        .iter()
        .filter_map(|n| {
            let d = NaiveDate::parse_from_str(&n.night_date, "%Y-%m-%d").ok()?;
            Some((d, n.duration_min?))
        })
        .collect();
    closed.sort_by_key(|(d, _)| *d);

    let latest = closed.last().map(|(d, _)| *d);
    let nights_ago = |d: &NaiveDate| match latest.map(|l| (l - *d).num_days()) {
        Some(0) | None => "the most recent night".to_string(),
        Some(1) => "the night before that".to_string(),
        Some(n) => format!("{n} nights before the most recent"),
    };
    let vs_goal = |m: i64| {
        format!("{} {}", format_span((m - goal_min).abs()), if m >= goal_min { "over" } else { "under" })
    };

    let mut out = format!(
        "FACTS (the only relationships you may state):\n- goal: {}\n",
        format_duration(goal_min)
    );

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
    let current = runs
        .last()
        .filter(|r| Some(*r.last().unwrap()) == latest)
        .map(|r| r.len())
        .unwrap_or(0);

    let avg = |v: Vec<i64>| (!v.is_empty()).then(|| v.iter().sum::<i64>() / v.len() as i64);
    let recent: Vec<(NaiveDate, i64)> = closed.iter().rev().take(3).copied().collect();
    let prior: Vec<i64> = closed.iter().rev().skip(3).take(4).map(|(_, m)| *m).collect();

    out.push_str("RECENT (the sentence must be about one of these):\n");
    if let Some((d, m)) = closed.last() {
        out.push_str(&format!(
            "- last night ({} {d}): {}, {} goal\n",
            d.weekday(),
            format_duration(*m),
            vs_goal(*m)
        ));
    }
    if let Some(m) = avg(recent.iter().map(|(_, m)| *m).collect()) {
        out.push_str(&format!(
            "- last {} nights average: {}, {} goal\n",
            recent.len(),
            format_duration(m),
            vs_goal(m)
        ));
        // Only worth stating once there is a stretch behind it to compare to,
        // otherwise "the trend" is just the same three nights again.
        if let Some(before) = avg(prior.clone()) {
            let delta = m - before;
            out.push_str(&format!(
                "- those {} nights vs the {} before them: {} {} on average\n",
                recent.len(),
                prior.len(),
                format_span(delta.abs()),
                if delta >= 0 { "more" } else { "less" }
            ));
        }
    }
    out.push_str(&format!("- current streak of goal-hitting nights: {current}\n"));
    let last7: Vec<i64> = closed.iter().rev().take(7).map(|(_, m)| *m).collect();
    let hits7 = last7.iter().filter(|m| **m >= goal_min).count();
    out.push_str(&format!("- nights at or over goal in the last {}: {hits7}\n", last7.len()));
    if let Some(m) = avg(last7.clone()) {
        out.push_str(&format!(
            "- last {} nights average: {}, {} goal\n",
            last7.len(),
            format_duration(m),
            vs_goal(m)
        ));
    }

    // The one thing the coach can actually ask for tonight. Bedtimes wrap past
    // midnight, so they are averaged in a frame that starts at 6pm rather than
    // at midnight - otherwise a 12:10am and an 11:50pm night average to noon.
    let recent7: Vec<&SleepData> = nights
        .iter()
        .filter(|n| NaiveDate::parse_from_str(&n.night_date, "%Y-%m-%d").is_ok())
        .take(7)
        .collect();
    let wake = median(
        recent7.iter().filter_map(|n| n.sleep_end.map(|t| minute_of_day(t, offset_min))).collect(),
    );
    let bed = median(
        recent7
            .iter()
            .filter_map(|n| n.sleep_start.map(|t| (minute_of_day(t, offset_min) + 360) % 1440))
            .collect(),
    )
    .map(|shifted| (shifted + 1080) % 1440);
    if let Some(w) = wake {
        out.push_str("TONIGHT (build the instruction around these):\n");
        out.push_str(&format!("- usual wake time over the last {} nights: {}\n", recent7.len(), clock(w)));
        let target = w - goal_min;
        out.push_str(&format!(
            "- to get the full {} and still be up at {}, asleep by {}\n",
            format_duration(goal_min),
            clock(w),
            clock(target)
        ));
        if let Some(b) = bed {
            out.push_str(&format!("- usual time asleep over those nights: {}\n", clock(b)));
            let earlier = (b + 360).rem_euclid(1440) - (target + 360).rem_euclid(1440);
            if earlier > 0 {
                out.push_str(&format!("- that is {} earlier than they usually go down\n", format_span(earlier)));
            } else {
                out.push_str("- they already go down early enough for that; the problem is elsewhere\n");
            }
        }
    }

    out.push_str("BACKGROUND (context only - never make the sentence about these):\n");
    let hits = closed.iter().filter(|(_, m)| *m >= goal_min).count();
    out.push_str(&format!("- nights at or over goal across the whole window: {hits} of {}\n", closed.len()));
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
    if let Some((d, m)) = closed.iter().max_by_key(|(_, m)| *m) {
        out.push_str(&format!("- longest night: {} on {d}, {}\n", format_duration(*m), nights_ago(d)));
    }
    if let Some((d, m)) = closed.iter().min_by_key(|(_, m)| *m) {
        out.push_str(&format!("- shortest night: {} on {d}, {}\n", format_duration(*m), nights_ago(d)));
    }
    let is_weekend =
        |d: &NaiveDate| matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun);
    if let Some(m) = avg(closed.iter().filter(|(d, _)| !is_weekend(d)).map(|(_, m)| *m).collect()) {
        out.push_str(&format!("- weekday average: {}\n", format_duration(m)));
    }
    if let Some(m) = avg(closed.iter().filter(|(d, _)| is_weekend(d)).map(|(_, m)| *m).collect()) {
        out.push_str(&format!("- weekend average: {}\n", format_duration(m)));
    }
    out
}

fn format_duration(min: i64) -> String {
    format!("{}h{:02}m", min / 60, min % 60)
}

/// Gaps and deltas, where "0h36m" reads like a typo and invites the model to
/// repeat it back that way.
fn format_span(min: i64) -> String {
    if min < 60 {
        format!("{min}m")
    } else {
        format_duration(min)
    }
}

fn median(mut v: Vec<i64>) -> Option<i64> {
    v.sort_unstable();
    v.get(v.len() / 2).copied()
}

fn minute_of_day(ts: DateTime<Utc>, offset_min: i32) -> i64 {
    let local = (ts - Duration::minutes(offset_min as i64)).time();
    i64::from(local.hour()) * 60 + i64::from(local.minute())
}

fn clock(mins: i64) -> String {
    let m = mins.rem_euclid(1440);
    let (h24, min) = (m / 60, m % 60);
    let hour = match h24 % 12 {
        0 => 12,
        h => h,
    };
    format!("{hour}:{min:02}{}", if h24 < 12 { "am" } else { "pm" })
}

fn local_time(ts: DateTime<Utc>, offset_min: i32) -> String {
    let local = ts - Duration::minutes(offset_min as i64);
    local.format("%I:%M%P").to_string().trim_start_matches('0').to_string()
}

#[cfg(test)]
mod tests {
    use super::{angle_for, build_facts};
    use crate::models::SleepData;
    use chrono::{Duration, NaiveDate};

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
        let facts = build_facts(&nights, 480, 0);
        assert!(facts.contains("current streak of goal-hitting nights: 0"), "{facts}");
        assert!(facts.contains("nights at or over goal across the whole window: 3 of 9"), "{facts}");
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
        let facts = build_facts(&nights, 480, 0);
        assert!(facts.contains("current streak of goal-hitting nights: 2"), "{facts}");
        assert!(facts.contains("2026-08-22 to 2026-08-23"), "{facts}");
    }

    // The reported follow-up: the blurb kept opening on the longest night even
    // when it was a week and a half old. The extremes now sit under BACKGROUND
    // with their distance spelled out, and every leading figure is recent.
    #[test]
    fn extremes_are_background_and_dated_relative_to_the_latest_night() {
        let nights = vec![
            night("2026-08-23", 400),
            night("2026-08-22", 410),
            night("2026-08-21", 395),
            night("2026-08-20", 420),
            night("2026-08-19", 430),
            night("2026-08-18", 600),
            night("2026-08-17", 300),
        ];
        let facts = build_facts(&nights, 480, 0);
        let (recent, background) = facts.split_once("BACKGROUND").unwrap();
        assert!(recent.contains("last night (Sun 2026-08-23): 6h40m, 1h20m under goal"), "{facts}");
        assert!(recent.contains("last 3 nights average: 6h41m, 1h19m under goal"), "{facts}");
        assert!(recent.contains("nights at or over goal in the last 7: 1"), "{facts}");
        assert!(!recent.contains("longest night"), "{facts}");
        assert!(background.contains("longest night: 10h00m on 2026-08-18, 5 nights before the most recent"), "{facts}");
        assert!(background.contains("shortest night: 5h00m on 2026-08-17, 6 nights before the most recent"), "{facts}");
    }

    // The last three nights are only a trend if there is a stretch behind them
    // to be a trend against.
    #[test]
    fn the_recent_stretch_is_compared_to_the_one_before_it() {
        let nights = vec![
            night("2026-08-23", 540),
            night("2026-08-22", 540),
            night("2026-08-21", 540),
            night("2026-08-20", 480),
            night("2026-08-19", 480),
            night("2026-08-18", 480),
            night("2026-08-17", 480),
        ];
        let facts = build_facts(&nights, 480, 0);
        assert!(facts.contains("those 3 nights vs the 4 before them: 1h00m more on average"), "{facts}");

        let short = vec![night("2026-08-23", 540), night("2026-08-22", 400), night("2026-08-21", 400)];
        assert!(!build_facts(&short, 480, 0).contains("before them"), "{}", build_facts(&short, 480, 0));
    }

    fn timed(date: &str, bed: &str, wake: &str, minutes: i64) -> SleepData {
        let at = |t: &str| {
            Some(
                format!("{date}T{t}:00Z")
                    .parse::<chrono::DateTime<chrono::Utc>>()
                    .unwrap(),
            )
        };
        SleepData {
            sleep_start: at(bed),
            sleep_end: at(wake),
            duration_min: Some(minutes),
            night_date: date.into(),
        }
    }

    #[test]
    fn tonight_targets_come_off_the_usual_wake_time() {
        // Newest first, the order the query hands them over in.
        let nights = vec![
            timed("2026-08-27", "00:50", "07:32", 372),
            timed("2026-08-26", "00:40", "07:28", 401),
            timed("2026-08-25", "00:55", "07:30", 388),
            timed("2026-08-24", "00:20", "07:35", 455),
            timed("2026-08-23", "00:30", "07:40", 470),
        ];
        let facts = build_facts(&nights, 480, 0);
        assert!(facts.contains("usual wake time over the last 5 nights: 7:32am"), "{facts}");
        assert!(facts.contains("to get the full 8h00m and still be up at 7:32am, asleep by 11:32pm"), "{facts}");
        assert!(facts.contains("usual time asleep over those nights: 12:40am"), "{facts}");
        assert!(facts.contains("that is 1h08m earlier than they usually go down"), "{facts}");
    }

    // Someone already going down early enough shouldn't be told to go down
    // earlier - the shortfall is coming from somewhere else.
    #[test]
    fn already_early_enough_says_so() {
        let nights = vec![
            timed("2026-08-27", "22:30", "06:00", 450),
            timed("2026-08-26", "22:20", "06:05", 445),
            timed("2026-08-25", "22:40", "06:00", 440),
        ];
        let facts = build_facts(&nights, 450, 0);
        assert!(facts.contains("already go down early enough"), "{facts}");
    }

    #[test]
    fn the_angle_moves_every_day() {
        let start = NaiveDate::from_ymd_opt(2026, 8, 28).unwrap();
        let week: std::collections::HashSet<&str> =
            (0..7).map(|i| angle_for(start + Duration::days(i))).collect();
        assert_eq!(week.len(), 7);
        assert_eq!(angle_for(start), angle_for(start + Duration::days(7)));
    }

    // The old blurb kept leading with a 10h night from a week and a half ago,
    // and later kept opening the exact same way every day. Loose on wording,
    // strict on the three things that were wrong: no stale extreme as the
    // subject, no invented adjacency, and no repeating yesterday's opening.
    #[tokio::test]
    #[ignore = "hits the live Groq API"]
    async fn coach_pushes_a_bedtime_without_repeating_itself() {
        dotenvy::dotenv().ok();
        let key = std::env::var("GROQ_API_KEY").expect("GROQ_API_KEY");
        let http = reqwest::Client::new();
        let nights = vec![
            timed("2026-08-27", "00:50", "07:32", 372),
            timed("2026-08-26", "00:40", "07:28", 401),
            timed("2026-08-25", "00:55", "07:30", 388),
            timed("2026-08-24", "00:20", "07:35", 455),
            timed("2026-08-23", "00:30", "07:40", 470),
            timed("2026-08-22", "00:10", "07:42", 462),
            timed("2026-08-21", "23:55", "07:23", 448),
            timed("2026-08-20", "22:40", "08:50", 610),
            timed("2026-08-19", "00:05", "07:15", 430),
        ];
        let facts = super::build_facts(&nights, 480, 0);
        let summary = super::build_summary(&nights, 0);
        println!("{facts}");

        let start = NaiveDate::from_ymd_opt(2026, 8, 28).unwrap();
        let mut history: Vec<String> = Vec::new();
        for day in 0..7 {
            let mut brief = format!("{facts}\n\n{summary}");
            if !history.is_empty() {
                brief.push_str(&format!(
                    "\n\nWHAT YOU ALREADY SENT THEM (newest first - do not reuse these openings, shapes or phrasings):\n{}",
                    history.iter().map(|b| format!("- {b}")).collect::<Vec<_>>().join("\n")
                ));
            }
            brief.push_str(&format!(
                "\n\nTODAY'S ANGLE (follow it): {}\n",
                super::angle_for(start + Duration::days(day))
            ));
            // Seven calls back to back trips the per-minute token limit and
            // sleep_insight reports that the same way it reports anything
            // else: None.
            if day > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
            let blurb = crate::groq::sleep_insight(&http, &key, &brief).await.expect("blurb");
            println!("> {blurb}");
            let lower = blurb.to_lowercase();
            assert!(!lower.contains("longest"), "{blurb}");
            assert!(!lower.contains("10h10m"), "{blurb}");
            assert_eq!(blurb, lower, "should be all lowercase: {blurb}");
            history.insert(0, blurb);
        }
        // Four different openings, not one sentence with the numbers swapped.
        let openings: std::collections::HashSet<String> = history
            .iter()
            .map(|b| b.split_whitespace().take(3).collect::<Vec<_>>().join(" "))
            .collect();
        assert!(openings.len() >= 5, "{history:?}");
    }

    // A run that ended before the most recent night is history, not a streak.
    #[test]
    fn a_run_that_ended_earlier_is_not_the_current_streak() {
        let nights = vec![
            night("2026-08-23", 400),
            night("2026-08-22", 510),
            night("2026-08-21", 500),
        ];
        let facts = build_facts(&nights, 480, 0);
        assert!(facts.contains("current streak of goal-hitting nights: 0"), "{facts}");
        assert!(facts.contains("2026-08-21 to 2026-08-22"), "{facts}");
    }
}
