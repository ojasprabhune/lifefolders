use axum::extract::State;
use axum::http::StatusCode;
use uuid::Uuid;

use crate::models::Log;
use crate::routes::AppError;
use crate::tasks::{self, Checkpoint, Task};
use crate::AppState;

// One thing a mutation did. A single user action usually does several: moving
// a sidequest updates the task *and* writes a timeline row, deleting a
// timeline row archives the task behind it. Recording only the last of those
// left the other half stranded on screen after cmd+Z, so the slot holds the
// whole set instead of one entry.
//
// In-memory and single-slot on purpose: it only needs to survive until the
// next mutation or the next undo, never across a server restart.
#[derive(Debug, Clone)]
pub enum Effect {
    LogsCreated(Vec<Uuid>),
    LogUpdated(Log),
    LogsDeleted(Vec<Uuid>),
    TaskCreated(Uuid),
    TasksUpdated(Vec<Task>),
    TaskDeleted { snapshot: Task, checkpoints: Vec<Checkpoint> },
}

/// Start a new undoable action, discarding whatever the last one was. One HTTP
/// request is one action however many things it touches, so every mutating
/// handler calls this once before doing any work and the helpers it calls only
/// `record`. A helper that began its own action would throw away the effects
/// its caller had already recorded - which is exactly the bug this replaced.
pub fn begin(state: &AppState) {
    if let Ok(mut guard) = state.last_action.lock() {
        guard.clear();
    }
}

pub fn record(state: &AppState, effect: Effect) {
    if let Ok(mut guard) = state.last_action.lock() {
        guard.push(effect);
    }
}

pub async fn undo_last(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let effects = state
        .last_action
        .lock()
        .ok()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default();
    if effects.is_empty() {
        return Err(AppError::NotFound);
    }

    // Unwind in reverse - the last thing done is the first thing undone.
    for effect in effects.into_iter().rev() {
        match effect {
            Effect::LogsCreated(ids) => {
                for id in ids {
                    sqlx::query("UPDATE logs SET deleted_at = now() WHERE id = $1")
                        .bind(id)
                        .execute(&state.pool)
                        .await?;
                }
            }
            Effect::LogUpdated(snapshot) => {
                sqlx::query("UPDATE logs SET data = $2, raw_input = $3 WHERE id = $1")
                    .bind(snapshot.id)
                    .bind(&snapshot.data)
                    .bind(&snapshot.raw_input)
                    .execute(&state.pool)
                    .await?;
            }
            Effect::LogsDeleted(ids) => {
                for id in ids {
                    sqlx::query("UPDATE logs SET deleted_at = NULL WHERE id = $1")
                        .bind(id)
                        .execute(&state.pool)
                        .await?;
                }
            }
            Effect::TaskCreated(task_id) => tasks::undo_created(&state, task_id).await?,
            Effect::TasksUpdated(snapshots) => {
                for snapshot in &snapshots {
                    tasks::undo_updated(&state, snapshot).await?;
                }
            }
            Effect::TaskDeleted { snapshot, checkpoints } => {
                tasks::undo_deleted(&state, &snapshot, &checkpoints).await?
            }
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
