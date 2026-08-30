use chrono::{Duration, NaiveDate, NaiveTime, Utc};
use uuid::Uuid;

use crate::focus::{self, StartedSession};
use crate::models::{CommandRequest, Log, TaskData};
use crate::routes::AppError;
use crate::tasks::{self, Task};
use crate::undo::{self, Effect};
use crate::{cadences, daily, groq, AppState};

/// A command changes existing state and reports back in words - it never
/// writes a logs row of its own, so `create_log` gets a notice and an empty
/// logs list instead of a timeline entry.
pub struct Outcome {
    pub notice: String,
    pub logs: Vec<Log>,
    pub focus_session: Option<StartedSession>,
}

fn say(notice: impl Into<String>) -> Outcome {
    Outcome { notice: notice.into(), logs: Vec::new(), focus_session: None }
}

/// Write the same kind of timeline row a typed sidequest update writes, so
/// rescheduling or completing something from a command still leaves history
/// on the home page instead of only a notice that disappears.
async fn write_history(
    state: &AppState,
    raw: &str,
    task: &Task,
    action: &str,
) -> Result<Log, AppError> {
    write_history_from(state, raw, task, action, None).await
}

async fn write_history_from(
    state: &AppState,
    raw: &str,
    task: &Task,
    action: &str,
    previous_due_date: Option<NaiveDate>,
) -> Result<Log, AppError> {
    let data = TaskData {
        task_id: task.id,
        title: task.title.clone(),
        category: task.category.clone(),
        due_date: task.due_date,
        due_time: task.due_time,
        status: task.status.clone(),
        is_exam: task.is_exam,
        action: action.to_string(),
        note: None,
        previous_due_date,
    };
    Ok(sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'task', $2) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(raw)
    .bind(serde_json::to_value(&data).unwrap())
    .fetch_one(&state.pool)
    .await?)
}

fn pretty_date(d: NaiveDate) -> String {
    d.format("%a %b %-d").to_string()
}

fn undoable(text: String, logs: Vec<Log>) -> Outcome {
    Outcome { notice: format!("{text} — cmd+Z to undo"), logs, focus_session: None }
}

/// Build the TaskRequest that leaves everything alone except the fields a
/// command actually names. `title` carries the existing title so
/// `update_task`'s own matching never re-resolves to something else.
fn patch_for(existing: &Task) -> crate::models::TaskRequest {
    crate::models::TaskRequest {
        title: existing.title.clone(),
        category: None,
        due_date: None,
        due_time: None,
        effort_minutes: None,
        status: None,
        is_exam: None,
        note: None,
        clear_due_date: false,
    }
}

async fn resolve_one(state: &AppState, title: &str) -> Result<Option<Task>, AppError> {
    let open = tasks::open_tasks(state).await?;
    Ok(tasks::best_match(&open, title).cloned())
}

async fn filtered_tasks(
    state: &AppState,
    filter: &str,
    tz_offset: i32,
) -> Result<Vec<Task>, AppError> {
    let today = (Utc::now() - Duration::minutes(tz_offset as i64)).date_naive();
    let open = tasks::open_tasks(state).await?;
    Ok(open
        .into_iter()
        .filter(|t| match (filter, t.due_date) {
            ("due_today", Some(d)) => d == today,
            ("due_tomorrow", Some(d)) => d == today + Duration::days(1),
            ("overdue", Some(d)) => d < today,
            _ => false,
        })
        .collect())
}

pub async fn apply(
    state: &AppState,
    raw: &str,
    req: CommandRequest,
    tz_offset: i32,
) -> Result<Outcome, AppError> {
    match req {
        CommandRequest::RescheduleTasks { titles, filter, new_due_date, new_due_time } => {
            let Some(date) = NaiveDate::parse_from_str(new_due_date.trim(), "%Y-%m-%d").ok() else {
                return Ok(say("couldn't read that date."));
            };
            let time = new_due_time
                .as_deref()
                .and_then(|t| NaiveTime::parse_from_str(t.trim(), "%H:%M").ok());

            // Explicit titles win over a filter when the model sends both -
            // naming things is the more specific intent.
            let (targets, missed) = if !titles.is_empty() {
                let open = tasks::open_tasks(state).await?;
                let mut found: Vec<Task> = Vec::new();
                let mut missed: Vec<String> = Vec::new();
                for t in &titles {
                    match tasks::best_match(&open, t) {
                        Some(task) if !found.iter().any(|f| f.id == task.id) => {
                            found.push(task.clone())
                        }
                        Some(_) => {}
                        None => missed.push(t.clone()),
                    }
                }
                (found, missed)
            } else if let Some(f) = filter.as_deref() {
                (filtered_tasks(state, f, tz_offset).await?, Vec::new())
            } else {
                return Ok(say("say which sidequests to move, or which day they're due."));
            };

            if targets.is_empty() {
                let what = match (titles.is_empty(), filter.as_deref()) {
                    (false, _) => format!("nothing matches \"{}\".", titles.join("\", \"")),
                    (_, Some("due_today")) => "nothing is due today.".into(),
                    (_, Some("due_tomorrow")) => "nothing is due tomorrow.".into(),
                    (_, Some("overdue")) => "nothing is overdue.".into(),
                    _ => "nothing to move.".into(),
                };
                return Ok(say(what));
            }

            let mut snapshots = Vec::with_capacity(targets.len());
            let mut logs = Vec::with_capacity(targets.len());
            for existing in &targets {
                snapshots.push(existing.clone());
                let mut patch = patch_for(existing);
                patch.due_date = Some(date.to_string());
                if let Some(t) = time {
                    patch.due_time = Some(t.format("%H:%M").to_string());
                }
                let (updated, _) = tasks::update_task(state, existing, &patch).await?;
                logs.push(
                    write_history_from(state, raw, &updated, "rescheduled", existing.due_date)
                        .await?,
                );
            }
            undo::record(state, Effect::TasksUpdated(snapshots));

            let n = targets.len();
            let subject = if n == 1 {
                format!("moved {}", targets[0].title)
            } else {
                format!("moved {n} sidequests")
            };
            let mut notice = format!("{subject} to {}", pretty_date(date));
            if !missed.is_empty() {
                notice.push_str(&format!(" (no match for \"{}\")", missed.join("\", \"")));
            }
            Ok(undoable(notice, logs))
        }

        CommandRequest::ClearDueDate { title } => {
            let Some(existing) = resolve_one(state, &title).await? else {
                return Ok(say(format!("no open sidequest matches \"{title}\".")));
            };
            if existing.due_date.is_none() {
                return Ok(say(format!("{} has no due date to clear.", existing.title)));
            }
            let snapshot = existing.clone();
            let mut patch = patch_for(&existing);
            patch.clear_due_date = true;
            let (updated, _) = tasks::update_task(state, &existing, &patch).await?;
            undo::record(state, Effect::TasksUpdated(vec![snapshot]));
            let log =
                write_history_from(state, raw, &updated, "rescheduled", existing.due_date).await?;
            Ok(undoable(format!("cleared the due date on {}", existing.title), vec![log]))
        }

        CommandRequest::SetTaskStatus { title, status } => {
            if !matches!(status.as_str(), "not_started" | "in_progress" | "done") {
                return Ok(say("that isn't a status I track."));
            }
            let Some(existing) = resolve_one(state, &title).await? else {
                return Ok(say(format!("no open sidequest matches \"{title}\".")));
            };
            let snapshot = existing.clone();
            let mut patch = patch_for(&existing);
            patch.status = Some(status.clone());
            let (updated, _) = tasks::update_task(state, &existing, &patch).await?;
            undo::record(state, Effect::TasksUpdated(vec![snapshot]));
            let log = write_history(state, raw, &updated, "status").await?;
            let worded = match status.as_str() {
                "done" => "done",
                "in_progress" => "in progress",
                _ => "not started",
            };
            Ok(undoable(format!("marked {} {worded}", existing.title), vec![log]))
        }

        CommandRequest::DeleteTask { title } => {
            let Some(existing) = resolve_one(state, &title).await? else {
                return Ok(say(format!("no open sidequest matches \"{title}\".")));
            };
            // archive_task records its own TaskDeleted undo, checkpoints included.
            tasks::archive_task(state, existing.id).await?;
            let log = write_history(state, raw, &existing, "deleted").await?;
            Ok(undoable(format!("deleted {}", existing.title), vec![log]))
        }

        CommandRequest::RecategorizeTask { title, category } => {
            let category = category.trim().to_lowercase();
            if category.is_empty() {
                return Ok(say("say which section to move it to."));
            }
            let Some(existing) = resolve_one(state, &title).await? else {
                return Ok(say(format!("no open sidequest matches \"{title}\".")));
            };
            let snapshot = existing.clone();
            let mut patch = patch_for(&existing);
            // Same rule the sidequests panel drags by: "exam" is a section
            // driven by is_exam, not a category. Naming it sets the flag;
            // naming anything else clears it, so a quiz the parser guessed
            // was an exam can actually be moved back out to homework.
            let to_exam = matches!(category.as_str(), "exam" | "exams");
            patch.is_exam = Some(to_exam);
            if !to_exam {
                patch.category = Some(category.clone());
            }
            let (updated, _) = tasks::update_task(state, &existing, &patch).await?;
            undo::record(state, Effect::TasksUpdated(vec![snapshot]));
            let log = write_history(state, raw, &updated, "moved").await?;
            Ok(undoable(format!("moved {} to {category}", existing.title), vec![log]))
        }

        CommandRequest::StartFocus { title, cadence_name, minutes } => {
            let minutes = minutes.clamp(1, 600);
            // Opening a second session while one is still running leaves an
            // orphan the timer never shows and never ends. A session whose
            // planned time has already run out, though, is one the browser
            // never got to close (tab shut while offline, so the end never
            // reported) - refusing on those would wedge the command forever,
            // so close them out first and carry on.
            let open: Option<(Uuid, String, i32, chrono::DateTime<Utc>)> = sqlx::query_as(
                "SELECT f.id, COALESCE(t.title, c.name, 'something'), f.planned_minutes, f.started_at \
                 FROM focus_sessions f \
                 LEFT JOIN tasks t ON t.id = f.task_id \
                 LEFT JOIN cadences c ON c.id = f.cadence_id \
                 WHERE f.ended_at IS NULL ORDER BY f.started_at DESC LIMIT 1",
            )
            .fetch_optional(&state.pool)
            .await?;
            if let Some((id, name, planned, started_at)) = open {
                let elapsed = (Utc::now() - started_at).num_minutes();
                if elapsed < planned as i64 {
                    return Ok(say(format!("already timing {name} — stop that one first.")));
                }
                sqlx::query(
                    "UPDATE focus_sessions SET ended_at = now(), actual_minutes = $2, \
                     completed = false WHERE id = $1 AND ended_at IS NULL",
                )
                .bind(id)
                .bind(planned)
                .execute(&state.pool)
                .await?;
            }
            if let Some(name) = cadence_name.filter(|n| !n.trim().is_empty()) {
                let active = cadences::active_cadences(state).await?;
                let Some(cadence) = cadences::best_match(&active, &name) else {
                    return Ok(say(format!("no cadence matches \"{name}\".")));
                };
                let started =
                    focus::open_session(state, None, Some(cadence.id), cadence.name.clone(), minutes)
                        .await?;
                let notice = format!("{minutes} min on {}", cadence.name);
                return Ok(Outcome { notice, logs: Vec::new(), focus_session: Some(started) });
            }
            let Some(title) = title.filter(|t| !t.trim().is_empty()) else {
                return Ok(say("say what to focus on."));
            };
            let Some(existing) = resolve_one(state, &title).await? else {
                return Ok(say(format!("no open sidequest matches \"{title}\".")));
            };
            let started =
                focus::open_session(state, Some(existing.id), None, existing.title.clone(), minutes)
                    .await?;
            let notice = format!("{minutes} min on {}", existing.title);
            Ok(Outcome { notice, logs: Vec::new(), focus_session: Some(started) })
        }

        CommandRequest::PlanToday => {
            let now_local = Utc::now() - Duration::minutes(tz_offset as i64);
            let today = now_local.date_naive();
            let open = tasks::open_tasks(state).await?;
            if open.is_empty() {
                return Ok(say("nothing open to plan around."));
            }

            let spent = focus::minutes_by_task(state, 14).await?;
            let mut brief = format!(
                "It is {} on {}.\nOpen sidequests:\n",
                now_local.format("%-I:%M%p").to_string().to_lowercase(),
                now_local.format("%A %Y-%m-%d")
            );
            for t in &open {
                let due = match (t.due_date, t.due_time) {
                    (Some(d), Some(time)) => format!("due {d} at {}", time.format("%-I:%M%p")),
                    (Some(d), None) if d == today => "due today".into(),
                    (Some(d), None) => format!("due {d}"),
                    (None, _) => "no deadline".into(),
                };
                let effort = t
                    .effort_minutes
                    .map(|m| format!(", about {m}m of work"))
                    .unwrap_or_default();
                let history = match spent.iter().find(|(id, ..)| *id == t.id) {
                    Some((_, mins, count, last)) => format!(
                        ", {mins}m of focus across {count} sessions, last on {}",
                        (*last - Duration::minutes(tz_offset as i64)).format("%Y-%m-%d")
                    ),
                    None => ", never worked on".into(),
                };
                brief.push_str(&format!(
                    "- {} [{}] {due}, {}{effort}{history}\n",
                    t.title, t.category, t.status
                ));
            }

            let Some(plan) = groq::plan_today(&state.http, &state.groq_key, &brief).await else {
                return Ok(say("couldn't put a plan together right now."));
            };
            daily::prepend_today(state, today, &plan).await?;
            Ok(say("added to today's plan"))
        }

        CommandRequest::DeleteLastEntry => {
            let latest: Option<Log> = sqlx::query_as(
                "SELECT id, created_at, raw_input, parsed_type, data FROM logs \
                 WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .fetch_optional(&state.pool)
            .await?;
            let Some(log) = latest else {
                return Ok(say("nothing logged to delete."));
            };
            sqlx::query("UPDATE logs SET deleted_at = now() WHERE id = $1")
                .bind(log.id)
                .execute(&state.pool)
                .await?;
            undo::record(state, Effect::LogsDeleted(vec![log.id]));
            Ok(undoable(format!("deleted \"{}\"", log.raw_input.trim()), Vec::new()))
        }
    }
}
