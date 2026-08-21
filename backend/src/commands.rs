use chrono::{Duration, NaiveDate, NaiveTime, Utc};

use crate::focus::{self, StartedSession};
use crate::models::{CommandRequest, Log};
use crate::routes::AppError;
use crate::tasks::{self, Task};
use crate::undo::{set_last, UndoAction};
use crate::{cadences, AppState};

/// A command changes existing state and reports back in words - it never
/// writes a logs row of its own, so `create_log` gets a notice and an empty
/// logs list instead of a timeline entry.
pub struct Outcome {
    pub notice: String,
    pub focus_session: Option<StartedSession>,
}

fn say(notice: impl Into<String>) -> Outcome {
    Outcome { notice: notice.into(), focus_session: None }
}

fn pretty_date(d: NaiveDate) -> String {
    d.format("%a %b %-d").to_string()
}

fn undoable(text: String) -> Outcome {
    say(format!("{text} — cmd+Z to undo"))
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
            for existing in &targets {
                snapshots.push(existing.clone());
                let mut patch = patch_for(existing);
                patch.due_date = Some(date.to_string());
                if let Some(t) = time {
                    patch.due_time = Some(t.format("%H:%M").to_string());
                }
                tasks::update_task(state, existing, &patch).await?;
            }
            set_last(state, UndoAction::TasksUpdated { snapshots });

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
            Ok(undoable(notice))
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
            tasks::update_task(state, &existing, &patch).await?;
            set_last(state, UndoAction::TaskUpdated { snapshot });
            let worded = match status.as_str() {
                "done" => "done",
                "in_progress" => "in progress",
                _ => "not started",
            };
            Ok(undoable(format!("marked {} {worded}", existing.title)))
        }

        CommandRequest::DeleteTask { title } => {
            let Some(existing) = resolve_one(state, &title).await? else {
                return Ok(say(format!("no open sidequest matches \"{title}\".")));
            };
            // archive_task records its own TaskDeleted undo, checkpoints included.
            tasks::archive_task(state, existing.id).await?;
            Ok(undoable(format!("deleted {}", existing.title)))
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
            patch.category = Some(category.clone());
            tasks::update_task(state, &existing, &patch).await?;
            set_last(state, UndoAction::TaskUpdated { snapshot });
            Ok(undoable(format!("moved {} to {category}", existing.title)))
        }

        CommandRequest::StartFocus { title, cadence_name, minutes } => {
            let minutes = minutes.clamp(1, 600);
            if let Some(name) = cadence_name.filter(|n| !n.trim().is_empty()) {
                let active = cadences::active_cadences(state).await?;
                let Some(cadence) = cadences::best_match(&active, &name) else {
                    return Ok(say(format!("no cadence matches \"{name}\".")));
                };
                let started =
                    focus::open_session(state, None, Some(cadence.id), cadence.name.clone(), minutes)
                        .await?;
                let notice = format!("{minutes} min on {}", cadence.name);
                return Ok(Outcome { notice, focus_session: Some(started) });
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
            Ok(Outcome { notice, focus_session: Some(started) })
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
            set_last(state, UndoAction::LogDeleted { log_id: log.id });
            Ok(undoable(format!("deleted \"{}\"", log.raw_input.trim())))
        }
    }
}
