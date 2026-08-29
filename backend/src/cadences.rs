use std::collections::{BTreeSet, HashMap};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
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
    pub interval_unit: String,
    pub interval_n: i32,
    pub weekdays: Vec<i16>,
    pub anchor_date: NaiveDate,
    pub active: bool,
    pub created_at: DateTime<Utc>,
}

const CADENCE_COLUMNS: &str =
    "id, name, interval_unit, interval_n, weekdays, anchor_date, active, created_at";

/// When a cadence is meant to happen. Every N days, or every N weeks on a set
/// of weekdays - an empty weekday set means "once anywhere inside that week",
/// which is what the old "weekly" cadence meant and still the right shape for
/// something you owe once a week but don't care which day.
///
/// Everything downstream works in *occurrences* rather than calendar days: a
/// day the cadence wasn't due is not a miss, so skipping it can't break a
/// streak.
pub struct Schedule {
    pub unit: String,
    pub every: i64,
    pub weekdays: Vec<i16>,
    pub anchor: NaiveDate,
}

impl Schedule {
    pub fn of(c: &Cadence) -> Self {
        Schedule {
            unit: c.interval_unit.clone(),
            every: c.interval_n.max(1) as i64,
            weekdays: c.weekdays.clone(),
            anchor: c.anchor_date,
        }
    }

    fn weekly(&self) -> bool {
        self.unit == "week"
    }

    /// Is the period containing `d` one the interval lands on?
    fn active_period(&self, d: NaiveDate) -> bool {
        // Nothing before the anchor is owed - a cadence made on Wednesday
        // shouldn't show Monday of that week as a day you missed.
        if d < self.anchor {
            return false;
        }
        let (a, b) = (self.period_start(self.anchor), self.period_start(d));
        let step = if self.weekly() { 7 } else { 1 };
        ((b - a).num_days() / step) % self.every == 0
    }

    fn period_start(&self, d: NaiveDate) -> NaiveDate {
        if self.weekly() {
            week_start(d)
        } else {
            d
        }
    }

    /// Every occurrence in `from..=to`, ascending. A weekly cadence with no
    /// weekdays picked contributes one occurrence per active week, dated to
    /// that week's Sunday; everything else contributes one per due day.
    pub fn occurrences(&self, from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
        let mut out = Vec::new();
        let mut d = from.max(self.anchor);
        while d <= to {
            if self.active_period(d) {
                if !self.weekly() {
                    out.push(d);
                } else if self.weekdays.is_empty() {
                    let start = week_start(d);
                    if out.last() != Some(&start) {
                        out.push(start);
                    }
                } else if self.weekdays.contains(&(d.weekday().num_days_from_sunday() as i16)) {
                    out.push(d);
                }
            }
            d += Duration::days(1);
        }
        out
    }

    /// True when `d` is itself a day the cadence is owed on - what the grid
    /// shades to distinguish "not due" from "missed".
    pub fn is_due_on(&self, d: NaiveDate) -> bool {
        if !self.active_period(d) {
            return false;
        }
        if !self.weekly() || self.weekdays.is_empty() {
            return true;
        }
        self.weekdays.contains(&(d.weekday().num_days_from_sunday() as i16))
    }

    pub fn label(&self) -> String {
        let unit = if self.weekly() { "week" } else { "day" };
        let base = match self.every {
            1 if self.weekly() => "weekly".to_string(),
            1 => "daily".to_string(),
            n => format!("every {n} {unit}s"),
        };
        if self.weekly() && !self.weekdays.is_empty() {
            const NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
            let mut days: Vec<i16> = self.weekdays.clone();
            days.sort_unstable();
            let names: Vec<&str> =
                days.iter().filter_map(|d| NAMES.get(*d as usize).copied()).collect();
            return format!("{base} on {}", names.join("/"));
        }
        base
    }
}

pub(crate) async fn active_cadences(state: &AppState) -> Result<Vec<Cadence>, AppError> {
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
pub(crate) fn best_match<'a>(cadences: &'a [Cadence], query: &str) -> Option<&'a Cadence> {
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
        out.push_str(&format!("- {} ({})\n", h.name, Schedule::of(h).label()));
    }
    out
}

/// Write a cadence_completion log row for an already-resolved cadence, unless
/// it's already been marked done today — a cadence is a daily yes/no, so a
/// second "did sat" (or a second completed focus session on it) shouldn't
/// pile up more rows in the timeline. Returns None when skipped for that
/// reason.
pub async fn log_completion(
    state: &AppState,
    cadence_id: Uuid,
    cadence_name: &str,
    raw: &str,
    tz_offset_min: i32,
    for_date: Option<NaiveDate>,
) -> Result<Option<Log>, AppError> {
    // create_log restamps created_at afterwards, but this guard runs before
    // the insert, so it needs the target day handed to it directly.
    let today = for_date
        .unwrap_or_else(|| (Utc::now() - Duration::minutes(tz_offset_min as i64)).date_naive());
    let recent: Vec<(DateTime<Utc>,)> = sqlx::query_as(
        "SELECT created_at FROM logs \
         WHERE parsed_type = 'cadence_completion' AND deleted_at IS NULL \
         AND data->>'cadence_id' = $1 AND created_at >= $2",
    )
    .bind(cadence_id.to_string())
    // Window around the day being marked, not around now - a backdated tick
    // would otherwise look past every row it needs to compare against.
    .bind(Utc.from_utc_datetime(&(today - Duration::days(2)).and_hms_opt(0, 0, 0).unwrap()))
    .fetch_all(&state.pool)
    .await?;
    let already_today = recent
        .iter()
        .any(|(ts,)| (*ts - Duration::minutes(tz_offset_min as i64)).date_naive() == today);
    if already_today {
        return Ok(None);
    }

    let data = CadenceData {
        cadence_id,
        cadence_name: cadence_name.to_string(),
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

pub enum CadenceOutcome {
    Logged(Log),
    AlreadyDone,
    NoMatch,
}

/// Resolve the free-text cadence name against the active cadences and, on a
/// match, write a completion log row (once per day - see log_completion).
pub async fn apply(
    state: &AppState,
    raw: &str,
    req: &CadenceCompletionRequest,
    tz_offset_min: i32,
    for_date: Option<NaiveDate>,
) -> Result<CadenceOutcome, AppError> {
    let cadences = active_cadences(state).await?;
    let Some(cadence) = best_match(&cadences, &req.cadence_name) else {
        return Ok(CadenceOutcome::NoMatch);
    };
    let logged =
        log_completion(state, cadence.id, &cadence.name, raw, tz_offset_min, for_date).await?;
    Ok(match logged {
        Some(log) => CadenceOutcome::Logged(log),
        None => CadenceOutcome::AlreadyDone,
    })
}

pub async fn list_cadences(State(state): State<AppState>) -> Result<Json<Vec<Cadence>>, AppError> {
    Ok(Json(active_cadences(&state).await?))
}

#[derive(Debug, Deserialize)]
pub struct CreateCadence {
    pub name: String,
    pub interval_unit: Option<String>,
    pub interval_n: Option<i32>,
    pub weekdays: Option<Vec<i16>>,
}

/// Validate and normalise a schedule coming off the wire. Weekdays are only
/// meaningful on a weekly cadence, so a day-unit one drops them rather than
/// storing a set nothing will ever read.
fn clean_schedule(
    unit: Option<&str>,
    n: Option<i32>,
    weekdays: Option<Vec<i16>>,
) -> Result<(String, i32, Vec<i16>), AppError> {
    let unit = unit.unwrap_or("day");
    if !matches!(unit, "day" | "week") {
        return Err(AppError::BadRequest("interval_unit must be day or week".into()));
    }
    let n = n.unwrap_or(1);
    if !(1..=52).contains(&n) {
        return Err(AppError::BadRequest("interval_n must be between 1 and 52".into()));
    }
    let mut days = if unit == "week" { weekdays.unwrap_or_default() } else { Vec::new() };
    if days.iter().any(|d| !(0..=6).contains(d)) {
        return Err(AppError::BadRequest("weekdays must be 0-6".into()));
    }
    days.sort_unstable();
    days.dedup();
    Ok((unit.to_string(), n, days))
}

pub async fn create_cadence(
    State(state): State<AppState>,
    Json(body): Json<CreateCadence>,
) -> Result<Json<Cadence>, AppError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is empty".into()));
    }
    let (unit, n, weekdays) =
        clean_schedule(body.interval_unit.as_deref(), body.interval_n, body.weekdays)?;
    let cadence: Cadence = sqlx::query_as(&format!(
        "INSERT INTO cadences (name, interval_unit, interval_n, weekdays) \
         VALUES ($1, $2, $3, $4) RETURNING {CADENCE_COLUMNS}"
    ))
    .bind(name)
    .bind(&unit)
    .bind(n)
    .bind(&weekdays)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(cadence))
}

#[derive(Debug, Deserialize)]
pub struct PatchCadence {
    pub name: Option<String>,
    pub interval_unit: Option<String>,
    pub interval_n: Option<i32>,
    pub weekdays: Option<Vec<i16>>,
}

pub async fn patch_cadence(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchCadence>,
) -> Result<Json<Cadence>, AppError> {
    let existing: Option<Cadence> =
        sqlx::query_as(&format!("SELECT {CADENCE_COLUMNS} FROM cadences WHERE id = $1 AND active"))
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let existing = existing.ok_or(AppError::NotFound)?;

    let name = match body.name.as_deref().map(str::trim) {
        Some("") => return Err(AppError::BadRequest("name is empty".into())),
        Some(n) => n.to_string(),
        None => existing.name.clone(),
    };
    // A schedule field only counts as "being changed" when the unit is sent
    // too, so renaming can't silently reset an every-2-weeks cadence to daily.
    let (unit, n, weekdays) = match body.interval_unit.as_deref() {
        Some(u) => clean_schedule(Some(u), body.interval_n, body.weekdays)?,
        None => (existing.interval_unit.clone(), existing.interval_n, existing.weekdays.clone()),
    };

    // Re-anchor when the interval changes so "every 2 weeks" restarts from the
    // week you changed it, which is what picking a new schedule means. An
    // unchanged schedule keeps its original anchor and its whole history.
    let rescheduled = unit != existing.interval_unit || n != existing.interval_n;
    let cadence: Cadence = sqlx::query_as(&format!(
        "UPDATE cadences SET name = $2, interval_unit = $3, interval_n = $4, weekdays = $5, \
            anchor_date = CASE WHEN $6 THEN CURRENT_DATE ELSE anchor_date END \
         WHERE id = $1 AND active RETURNING {CADENCE_COLUMNS}"
    ))
    .bind(id)
    .bind(&name)
    .bind(&unit)
    .bind(n)
    .bind(&weekdays)
    .bind(rescheduled)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(cadence))
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
    // The days inside the window the cadence was actually owed on, so the grid
    // can shade "not due" differently from "missed" - without it an every-2-
    // weeks cadence looks like a wall of failures.
    pub due_dates: Vec<NaiveDate>,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub unit: String,
}

/// The window every completions query works over. Reaches back a little
/// further than the requested window so a streak running up to its first day
/// is measured against real neighbours, not a hard cutoff - a full extra week
/// (not just a day) so a weekly cadence is safe too, in case the window's
/// first day lands mid-week.
fn window(q: &CompletionsQuery) -> (i64, i32, NaiveDate, NaiveDate) {
    let days = q.days.unwrap_or(90).clamp(1, 400);
    let offset = q.tz_offset_min.unwrap_or(0);
    let today = (Utc::now() - Duration::minutes(offset as i64)).date_naive();
    (days, offset, today, today - Duration::days(days + 8))
}

fn summarize(
    cadence: &Cadence,
    all: BTreeSet<NaiveDate>,
    days: i64,
    today: NaiveDate,
    since: NaiveDate,
) -> Completions {
    let schedule = Schedule::of(cadence);
    let occurrences = schedule.occurrences(since, today);
    let current_streak = current_run(&occurrences, &all, today);
    let longest_streak = longest_run(&occurrences, &all, today);

    // Only surface the dates inside the requested window to the client; the
    // extra days pulled above were just for accurate streak measurement.
    let start = today - Duration::days(days - 1);
    Completions {
        dates: all.into_iter().filter(|d| *d >= start).collect(),
        due_dates: start
            .iter_days()
            .take_while(|d| *d <= today)
            .filter(|d| schedule.is_due_on(*d))
            .collect(),
        current_streak,
        longest_streak,
        unit: cadence.interval_unit.clone(),
    }
}

pub async fn completions(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<CompletionsQuery>,
) -> Result<Json<Completions>, AppError> {
    let (days, offset, today, since) = window(&q);

    let cadence: Cadence =
        sqlx::query_as(&format!("SELECT {CADENCE_COLUMNS} FROM cadences WHERE id = $1"))
            .bind(id)
            .fetch_one(&state.pool)
            .await?;

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

    Ok(Json(summarize(&cadence, all, days, today, since)))
}

/// Every active cadence's grid in one request. The wall shows all of them at
/// once, and asking per cadence made that N round trips against a backend
/// that sleeps between visits - this stays two queries however many there are.
pub async fn all_completions(
    State(state): State<AppState>,
    Query(q): Query<CompletionsQuery>,
) -> Result<Json<HashMap<Uuid, Completions>>, AppError> {
    let (days, offset, today, since) = window(&q);
    let cadences = active_cadences(&state).await?;

    let rows: Vec<(Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT data->>'cadence_id', created_at FROM logs \
         WHERE parsed_type = 'cadence_completion' AND deleted_at IS NULL \
         AND created_at >= $1 ORDER BY created_at",
    )
    .bind(Utc.from_utc_datetime(&since.and_hms_opt(0, 0, 0).unwrap()))
    .fetch_all(&state.pool)
    .await?;

    let mut by_id: HashMap<Uuid, BTreeSet<NaiveDate>> = HashMap::new();
    for (cadence_id, ts) in rows {
        let Some(id) = cadence_id.and_then(|s| Uuid::parse_str(&s).ok()) else {
            continue;
        };
        by_id.entry(id).or_default().insert((ts - Duration::minutes(offset as i64)).date_naive());
    }

    Ok(Json(
        cadences
            .into_iter()
            .map(|c| {
                let all = by_id.remove(&c.id).unwrap_or_default();
                (c.id, summarize(&c, all, days, today, since))
            })
            .collect(),
    ))
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
        let occurrences = Schedule::of(&c).occurrences(since, today);
        let streak = current_run(&occurrences, &dates, today);
        if streak > 0 && best.as_ref().map(|(_, s)| streak > *s).unwrap_or(true) {
            best = Some((c.name.clone(), streak));
        }
    }
    Ok(best)
}

// Sunday-aligned, matching the frontend's week columns (buildWeeks in
// Cadences.tsx) so "this week" means the same 7 days on both ends.
fn week_start(d: NaiveDate) -> NaiveDate {
    d - Duration::days(d.weekday().num_days_from_sunday() as i64)
}

/// Was the occurrence starting at `slot` satisfied? A completion counts toward
/// the latest occurrence at or before it, so finishing an "every 3 days"
/// cadence a day late still clears that occurrence rather than falling into a
/// gap and reading as a miss.
fn satisfied(occurrences: &[NaiveDate], i: usize, dates: &BTreeSet<NaiveDate>) -> bool {
    let start = occurrences[i];
    let end = occurrences.get(i + 1).copied();
    dates
        .range(start..)
        .take_while(|d| end.map(|e| **d < e).unwrap_or(true))
        .next()
        .is_some()
}

/// Consecutive satisfied occurrences counting back from the most recent one.
/// The current occurrence being unfinished doesn't break the streak - it just
/// hasn't happened yet - so the count falls back to the one before it, the
/// same forgiveness the day-based version always had for "today".
fn current_run(occurrences: &[NaiveDate], dates: &BTreeSet<NaiveDate>, today: NaiveDate) -> i64 {
    let last = match occurrences.iter().rposition(|d| *d <= today) {
        Some(i) => i,
        None => return 0,
    };
    let mut i = if satisfied(occurrences, last, dates) {
        last
    } else if last > 0 && satisfied(occurrences, last - 1, dates) {
        last - 1
    } else {
        return 0;
    };
    let mut streak = 0;
    loop {
        if !satisfied(occurrences, i, dates) {
            break;
        }
        streak += 1;
        if i == 0 {
            break;
        }
        i -= 1;
    }
    streak
}

fn longest_run(occurrences: &[NaiveDate], dates: &BTreeSet<NaiveDate>, today: NaiveDate) -> i64 {
    let mut longest = 0;
    let mut run = 0;
    for i in 0..occurrences.len() {
        // An occurrence still in the future is not a miss; stop rather than
        // letting empty future slots reset the run to zero.
        if occurrences[i] > today {
            break;
        }
        run = if satisfied(occurrences, i, dates) { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    longest
}

#[cfg(test)]
mod tests {
    use super::{current_run, longest_run, week_start, Cadence, Schedule};
    use chrono::{Duration, NaiveDate};
    use std::collections::BTreeSet;

    fn day(n: i64) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 12).unwrap() + Duration::days(n)
    }

    fn schedule(unit: &str, every: i64, weekdays: &[i16], anchor: NaiveDate) -> Schedule {
        Schedule {
            unit: unit.into(),
            every,
            weekdays: weekdays.to_vec(),
            anchor,
        }
    }

    fn set(offsets: &[i64]) -> BTreeSet<NaiveDate> {
        offsets.iter().map(|&n| day(n)).collect()
    }

    // A plain daily cadence has to behave exactly as it did before schedules
    // existed, since every existing cadence was migrated into this shape.
    #[test]
    fn daily_streak_counts_back_from_today() {
        let today = day(0);
        let sched = schedule("day", 1, &[], day(-30));
        let occ = sched.occurrences(day(-30), today);
        assert_eq!(current_run(&occ, &set(&[0, -1, -2, -4, -5]), today), 3);
    }

    #[test]
    fn daily_streak_uses_yesterday_when_today_missing() {
        let today = day(0);
        let sched = schedule("day", 1, &[], day(-30));
        let occ = sched.occurrences(day(-30), today);
        assert_eq!(current_run(&occ, &set(&[-1, -2]), today), 2);
    }

    #[test]
    fn daily_streak_zero_when_gap_before_today() {
        let today = day(0);
        let sched = schedule("day", 1, &[], day(-30));
        let occ = sched.occurrences(day(-30), today);
        assert_eq!(current_run(&occ, &set(&[-2, -3]), today), 0);
    }

    #[test]
    fn daily_longest_run_finds_best_stretch() {
        let today = day(0);
        let sched = schedule("day", 1, &[], day(-30));
        let occ = sched.occurrences(day(-30), today);
        assert_eq!(longest_run(&occ, &set(&[0, -1, -3, -4, -5, -6, -9]), today), 4);
    }

    // The old "weekly" cadence: once anywhere in the week, streak counts weeks.
    #[test]
    fn weekly_streak_ignores_which_day_within_the_week_was_hit() {
        let today = day(0);
        let this_week = week_start(today);
        let sched = schedule("week", 1, &[], this_week - Duration::days(70));
        let occ = sched.occurrences(this_week - Duration::days(70), today);
        // one hit per week, on a different weekday each time
        let dates: BTreeSet<NaiveDate> = [0i64, -7, -14]
            .iter()
            .enumerate()
            .map(|(i, &w)| this_week + Duration::days(w + i as i64))
            .collect();
        assert_eq!(current_run(&occ, &dates, today), 3);
    }

    #[test]
    fn weekly_streak_falls_back_to_last_week_when_this_week_missing() {
        let today = day(0);
        let this_week = week_start(today);
        let sched = schedule("week", 1, &[], this_week - Duration::days(70));
        let occ = sched.occurrences(this_week - Duration::days(70), today);
        let dates: BTreeSet<NaiveDate> =
            [-7i64, -14].iter().map(|&w| this_week + Duration::days(w)).collect();
        assert_eq!(current_run(&occ, &dates, today), 2);
    }

    // The whole point of the schedule: a day it was never owed on is not a
    // miss. Every 3 days, hit on schedule, nothing in between - still a streak.
    #[test]
    fn every_n_days_skips_the_days_between() {
        let today = day(0);
        let sched = schedule("day", 3, &[], day(-9));
        let occ = sched.occurrences(day(-30), today);
        assert_eq!(occ, vec![day(-9), day(-6), day(-3), day(0)]);
        assert_eq!(current_run(&occ, &set(&[0, -3, -6, -9]), today), 4);
        // Completions land on the occurrence they follow, never the one ahead
        // of them: -1 and -2 both belong to the -3 occurrence, so -6 is still
        // an unambiguous miss and the streak stops there.
        assert_eq!(current_run(&occ, &set(&[-1, -2]), today), 1);
    }

    #[test]
    fn biweekly_on_chosen_weekdays_only_counts_those_days() {
        let anchor = NaiveDate::from_ymd_opt(2026, 8, 2).unwrap(); // a Sunday
        let today = NaiveDate::from_ymd_opt(2026, 8, 31).unwrap();
        // every 2 weeks, on monday and friday
        let sched = schedule("week", 2, &[1, 5], anchor);
        let occ = sched.occurrences(anchor, today);
        let expect: Vec<NaiveDate> = ["2026-08-03", "2026-08-07", "2026-08-17", "2026-08-21", "2026-08-31"]
            .iter()
            .map(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap())
            .collect();
        assert_eq!(occ, expect);
        // the off weeks are not due at all
        assert!(!sched.is_due_on(NaiveDate::from_ymd_opt(2026, 8, 10).unwrap()));
        assert!(sched.is_due_on(NaiveDate::from_ymd_opt(2026, 8, 17).unwrap()));
        // wednesday of an active week is not a due day either
        assert!(!sched.is_due_on(NaiveDate::from_ymd_opt(2026, 8, 19).unwrap()));
    }

    #[test]
    fn a_late_completion_still_clears_its_occurrence() {
        let today = day(0);
        let sched = schedule("day", 3, &[], day(-9));
        let occ = sched.occurrences(day(-30), today);
        // due on -9/-6/-3/0, done a day late each time except today
        assert_eq!(current_run(&occ, &set(&[-8, -5, -2]), today), 3);
    }

    #[test]
    fn labels_read_the_way_you_would_say_them() {
        let a = day(0);
        assert_eq!(schedule("day", 1, &[], a).label(), "daily");
        assert_eq!(schedule("day", 3, &[], a).label(), "every 3 days");
        assert_eq!(schedule("week", 1, &[], a).label(), "weekly");
        assert_eq!(schedule("week", 2, &[], a).label(), "every 2 weeks");
        assert_eq!(schedule("week", 2, &[1, 3, 5], a).label(), "every 2 weeks on mon/wed/fri");
    }

    #[test]
    fn schedule_of_defaults_a_zero_interval_to_one() {
        let c = Cadence {
            id: uuid::Uuid::nil(),
            name: "x".into(),
            interval_unit: "day".into(),
            interval_n: 0,
            weekdays: vec![],
            anchor_date: day(0),
            active: true,
            created_at: chrono::Utc::now(),
        };
        assert_eq!(Schedule::of(&c).every, 1);
    }
}
