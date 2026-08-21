use axum::extract::State;
use axum::http::StatusCode;
use uuid::Uuid;

use crate::models::Log;
use crate::routes::AppError;
use crate::tasks::{self, Checkpoint, Task};
use crate::AppState;

// Snapshot of the single most recent mutation across the whole app - a plain
// logs-table entry (nutrition, person, sleep, ...) or a task, which also has
// its own real table plus calendar/checkpoint side effects. In-memory and
// single-slot on purpose: it only needs to survive until the next mutation
// or the next undo, never across a server restart. One shared slot (instead
// of a separate one per domain) so cmd+Z always undoes whatever actually
// happened last, regardless of where it happened.
#[derive(Debug, Clone)]
pub enum UndoAction {
    LogCreated { log_ids: Vec<Uuid> },
    LogUpdated { snapshot: Log },
    LogDeleted { log_id: Uuid },
    TaskCreated { task_id: Uuid },
    TaskUpdated { snapshot: Task },
    TasksUpdated { snapshots: Vec<Task> },
    TaskDeleted { snapshot: Task, checkpoints: Vec<Checkpoint> },
}

pub fn set_last(state: &AppState, action: UndoAction) {
    if let Ok(mut guard) = state.last_action.lock() {
        *guard = Some(action);
    }
}

pub async fn undo_last(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let action = state.last_action.lock().ok().and_then(|mut g| g.take());
    let Some(action) = action else { return Err(AppError::NotFound) };

    match action {
        UndoAction::LogCreated { log_ids } => {
            for id in log_ids {
                sqlx::query("UPDATE logs SET deleted_at = now() WHERE id = $1")
                    .bind(id)
                    .execute(&state.pool)
                    .await?;
            }
        }
        UndoAction::LogUpdated { snapshot } => {
            sqlx::query("UPDATE logs SET data = $2, raw_input = $3 WHERE id = $1")
                .bind(snapshot.id)
                .bind(&snapshot.data)
                .bind(&snapshot.raw_input)
                .execute(&state.pool)
                .await?;
        }
        UndoAction::LogDeleted { log_id } => {
            sqlx::query("UPDATE logs SET deleted_at = NULL WHERE id = $1")
                .bind(log_id)
                .execute(&state.pool)
                .await?;
        }
        UndoAction::TaskCreated { task_id } => tasks::undo_created(&state, task_id).await?,
        UndoAction::TaskUpdated { snapshot } => tasks::undo_updated(&state, &snapshot).await?,
        UndoAction::TasksUpdated { snapshots } => {
            for snapshot in &snapshots {
                tasks::undo_updated(&state, snapshot).await?;
            }
        }
        UndoAction::TaskDeleted { snapshot, checkpoints } => {
            tasks::undo_deleted(&state, &snapshot, &checkpoints).await?
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
