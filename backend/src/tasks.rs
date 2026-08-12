use anyhow::Result;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::models::{Log, TaskData, TaskRequest};
use crate::routes::AppError;
use crate::AppState;

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct Task {
    pub id: Uuid,
    pub title: String,
    pub category: String,
    pub due_date: Option<NaiveDate>,
    pub effort_minutes: Option<i32>,
    pub status: String,
    pub is_exam: bool,
    pub note: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
    pub completed_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Checkpoint {
    pub id: Uuid,
    pub task_id: Uuid,
    pub offset_days: i32,
    pub due_date: NaiveDate,
    pub status: String,
}

const TASK_COLUMNS: &str =
    "id, title, category, due_date, effort_minutes, status, is_exam, note, created_at, completed_at";

async fn open_tasks(state: &AppState) -> Result<Vec<Task>, AppError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks \
         WHERE archived_at IS NULL AND status != 'done' ORDER BY due_date NULLS LAST"
    ))
    .fetch_all(&state.pool)
    .await?)
}

const TITLE_STOPWORDS: &[&str] = &[
    "test", "exam", "quiz", "homework", "essay", "paper", "assignment", "project", "review",
    "final", "midterm", "syllabus", "worksheet", "packet", "notes", "lab", "presentation",
    "outline", "draft", "reading", "chapter", "unit",
];

fn best_match<'a>(items: &'a [Task], query: &str) -> Option<&'a Task> {
    let q = query.to_lowercase();
    let mut best: Option<(&Task, i32)> = None;
    for item in items {
        let n = item.title.to_lowercase();
        let score = if n == q {
            3
        } else if n.contains(&q) || q.contains(&n) {
            2
        } else if n.split_whitespace().any(|w| {
            w.len() > 2 && !TITLE_STOPWORDS.contains(&w) && q.contains(w)
        }) {
            1
        } else {
            continue;
        };
        if best.map(|(_, s)| score > s).unwrap_or(true) {
            best = Some((item, score));
        }
    }
    best.map(|(item, _)| item)
}

pub async fn context_block(state: &AppState) -> String {
    let Ok(tasks) = open_tasks(state).await else {
        return String::new();
    };
    if tasks.is_empty() {
        return String::new();
    }
    let mut out = String::from("Open tasks:\n");
    for t in tasks.iter().take(40) {
        let due = t
            .due_date
            .map(|d| d.to_string())
            .unwrap_or_else(|| "no due date".into());
        out.push_str(&format!(
            "- [{}] {} (due {due}, {})\n",
            t.category, t.title, t.status
        ));
    }
    out
}

fn parse_due(s: Option<&str>) -> Option<NaiveDate> {
    s.and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok())
}

async fn regenerate_checkpoints(
    state: &AppState,
    task_id: Uuid,
    title: &str,
    due: NaiveDate,
) -> Result<(), AppError> {
    let deleted: Vec<(Uuid,)> =
        sqlx::query_as("DELETE FROM task_checkpoints WHERE task_id = $1 AND status = 'todo' RETURNING id")
            .bind(task_id)
            .fetch_all(&state.pool)
            .await?;
    for (id,) in deleted {
        spawn_checkpoint_delete(state, id);
    }
    let today = Utc::now().date_naive();
    for offset in [7, 3, 1] {
        let cp_date = due - Duration::days(offset);
        if cp_date >= today {
            let (id,): (Uuid,) = sqlx::query_as(
                "INSERT INTO task_checkpoints (task_id, offset_days, due_date) VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(task_id)
            .bind(offset)
            .bind(cp_date)
            .fetch_one(&state.pool)
            .await?;
            spawn_checkpoint_sync(state, id, title, offset as i32, cp_date);
        }
    }
    Ok(())
}

async fn clear_pending_checkpoints(state: &AppState, task_id: Uuid) -> Result<(), AppError> {
    let deleted: Vec<(Uuid,)> =
        sqlx::query_as("DELETE FROM task_checkpoints WHERE task_id = $1 AND status = 'todo' RETURNING id")
            .bind(task_id)
            .fetch_all(&state.pool)
            .await?;
    for (id,) in deleted {
        spawn_checkpoint_delete(state, id);
    }
    Ok(())
}

fn spawn_checkpoint_sync(state: &AppState, checkpoint_id: Uuid, task_title: &str, offset_days: i32, due_date: NaiveDate) {
    let Some(cfg) = state.caldav.clone() else { return };
    let title = task_title.to_string();
    tokio::spawn(async move {
        let uid = format!("lf-checkpoint-{checkpoint_id}");
        let summary = format!("study: {title} ({offset_days}d out)");
        let ical = crate::caldav::vevent(&uid, &summary, due_date);
        if let Err(e) = crate::caldav::put_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password, &ical).await {
            tracing::warn!("checkpoint calendar sync failed for {checkpoint_id}: {e:#}");
        }
    });
}

fn spawn_checkpoint_delete(state: &AppState, checkpoint_id: Uuid) {
    let Some(cfg) = state.caldav.clone() else { return };
    tokio::spawn(async move {
        let uid = format!("lf-checkpoint-{checkpoint_id}");
        if let Err(e) = crate::caldav::delete_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password).await {
            tracing::warn!("checkpoint calendar delete failed for {checkpoint_id}: {e:#}");
        }
    });
}

fn spawn_calendar_sync(state: &AppState, task: &Task) {
    let Some(cfg) = state.caldav.clone() else { return };
    let task = task.clone();
    tokio::spawn(async move {
        let uid = format!("lf-task-{}", task.id);
        let result = match (task.due_date, task.status.as_str()) {
            (Some(due), status) if status != "done" => {
                let label = if task.is_exam { "exam" } else { task.category.as_str() };
                let summary = format!("[{label}] {}", task.title);
                let ical = crate::caldav::vevent(&uid, &summary, due);
                crate::caldav::put_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password, &ical).await
            }
            _ => crate::caldav::delete_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password).await,
        };
        if let Err(e) = result {
            tracing::warn!("calendar sync failed for task {}: {e:#}", task.id);
        }
    });
}

fn spawn_calendar_delete(state: &AppState, task_id: Uuid) {
    let Some(cfg) = state.caldav.clone() else { return };
    tokio::spawn(async move {
        let uid = format!("lf-task-{task_id}");
        if let Err(e) = crate::caldav::delete_ical(&cfg.http, &cfg.calendar_url, &uid, &cfg.apple_id, &cfg.app_password).await {
            tracing::warn!("calendar delete failed for task {task_id}: {e:#}");
        }
    });
}

async fn create_task(state: &AppState, req: &TaskRequest) -> Result<Task, AppError> {
    let task: Task = sqlx::query_as(&format!(
        "INSERT INTO tasks (title, category, due_date, effort_minutes, status, is_exam, note) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {TASK_COLUMNS}"
    ))
    .bind(req.title.trim())
    .bind(req.category.as_deref().unwrap_or("other"))
    .bind(parse_due(req.due_date.as_deref()))
    .bind(req.effort_minutes)
    .bind(req.status.as_deref().unwrap_or("not_started"))
    .bind(req.is_exam.unwrap_or(false))
    .bind(&req.note)
    .fetch_one(&state.pool)
    .await?;
    if task.is_exam {
        if let Some(due) = task.due_date {
            regenerate_checkpoints(state, task.id, &task.title, due).await?;
        }
    }
    spawn_calendar_sync(state, &task);
    Ok(task)
}

async fn update_task(
    state: &AppState,
    existing: &Task,
    req: &TaskRequest,
) -> Result<(Task, String), AppError> {
    let new_status = req.status.clone().unwrap_or_else(|| existing.status.clone());
    let new_due = req
        .due_date
        .as_deref()
        .map(|s| parse_due(Some(s)))
        .unwrap_or(existing.due_date);
    let new_is_exam = req.is_exam.unwrap_or(existing.is_exam);
    let completed_at = if new_status == "done" && existing.status != "done" {
        Some(Utc::now())
    } else if new_status != "done" {
        None
    } else {
        existing.completed_at
    };

    let task: Task = sqlx::query_as(&format!(
        "UPDATE tasks SET status = $2, due_date = $3, is_exam = $4, \
            effort_minutes = COALESCE($5, effort_minutes), note = COALESCE($6, note), \
            completed_at = $7 \
         WHERE id = $1 RETURNING {TASK_COLUMNS}"
    ))
    .bind(existing.id)
    .bind(&new_status)
    .bind(new_due)
    .bind(new_is_exam)
    .bind(req.effort_minutes)
    .bind(&req.note)
    .bind(completed_at)
    .fetch_one(&state.pool)
    .await?;

    let due_or_exam_changed = new_due != existing.due_date || new_is_exam != existing.is_exam;
    if due_or_exam_changed {
        if task.is_exam {
            if let Some(due) = task.due_date {
                regenerate_checkpoints(state, task.id, &task.title, due).await?;
            }
        } else {
            clear_pending_checkpoints(state, task.id).await?;
        }
    }

    let action = if new_status != existing.status {
        "status"
    } else if new_due != existing.due_date {
        "rescheduled"
    } else {
        "note"
    };
    spawn_calendar_sync(state, &task);
    Ok((task, action.to_string()))
}

pub async fn apply(state: &AppState, raw: &str, req: TaskRequest) -> Result<Log, AppError> {
    let open = open_tasks(state).await?;
    let matched = best_match(&open, &req.title);

    let (task, action) = match matched {
        Some(existing) if req.status.is_some() || req.due_date.is_some() || req.note.is_some() => {
            update_task(state, existing, &req).await?
        }
        _ => (create_task(state, &req).await?, "created".to_string()),
    };

    let data = TaskData {
        task_id: task.id,
        title: task.title.clone(),
        category: task.category.clone(),
        due_date: task.due_date,
        status: task.status.clone(),
        is_exam: task.is_exam,
        action,
        note: req.note,
    };

    let log: Log = sqlx::query_as(
        "INSERT INTO logs (raw_input, parsed_type, data) VALUES ($1, 'task', $2) \
         RETURNING id, created_at, raw_input, parsed_type, data",
    )
    .bind(raw)
    .bind(serde_json::to_value(&data).unwrap())
    .fetch_one(&state.pool)
    .await?;
    Ok(log)
}

#[derive(Debug, Serialize)]
pub struct TaskWithCheckpoints {
    #[serde(flatten)]
    pub task: Task,
    pub checkpoints: Vec<Checkpoint>,
}

pub async fn list_tasks(State(state): State<AppState>) -> Result<Json<Vec<TaskWithCheckpoints>>, AppError> {
    let tasks: Vec<Task> = sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE archived_at IS NULL \
         ORDER BY due_date NULLS LAST, created_at"
    ))
    .fetch_all(&state.pool)
    .await?;
    let mut out = Vec::with_capacity(tasks.len());
    for task in tasks {
        let checkpoints: Vec<Checkpoint> = sqlx::query_as(
            "SELECT id, task_id, offset_days, due_date, status FROM task_checkpoints \
             WHERE task_id = $1 ORDER BY due_date",
        )
        .bind(task.id)
        .fetch_all(&state.pool)
        .await?;
        out.push(TaskWithCheckpoints { task, checkpoints });
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
pub struct PatchTask {
    pub status: Option<String>,
    pub due_date: Option<String>,
    pub category: Option<String>,
    pub effort_minutes: Option<i32>,
    pub is_exam: Option<bool>,
}

pub async fn patch_task(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchTask>,
) -> Result<Json<Task>, AppError> {
    if let Some(s) = &body.status {
        if !matches!(s.as_str(), "not_started" | "in_progress" | "done") {
            return Err(AppError::BadRequest("bad status".into()));
        }
    }
    let existing: Option<Task> = sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE id = $1 AND archived_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let existing = existing.ok_or(AppError::NotFound)?;

    let req = TaskRequest {
        title: existing.title.clone(),
        category: body.category,
        due_date: body.due_date,
        effort_minutes: body.effort_minutes,
        status: body.status,
        is_exam: body.is_exam,
        note: None,
    };
    let (task, _) = update_task(&state, &existing, &req).await?;
    Ok(Json(task))
}

pub async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("UPDATE tasks SET archived_at = now() WHERE id = $1 AND archived_at IS NULL")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    spawn_calendar_delete(&state, id);
    clear_pending_checkpoints(&state, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct PatchCheckpoint {
    pub status: String,
}

pub async fn patch_checkpoint(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchCheckpoint>,
) -> Result<Json<Checkpoint>, AppError> {
    if !matches!(body.status.as_str(), "todo" | "done") {
        return Err(AppError::BadRequest("bad status".into()));
    }
    let cp: Option<Checkpoint> = sqlx::query_as(
        "UPDATE task_checkpoints SET status = $2 WHERE id = $1 \
         RETURNING id, task_id, offset_days, due_date, status",
    )
    .bind(id)
    .bind(&body.status)
    .fetch_optional(&state.pool)
    .await?;
    let Some(cp) = cp else { return Err(AppError::NotFound) };

    if cp.status == "done" {
        spawn_checkpoint_delete(&state, cp.id);
    } else {
        let title: Option<(String,)> = sqlx::query_as("SELECT title FROM tasks WHERE id = $1")
            .bind(cp.task_id)
            .fetch_optional(&state.pool)
            .await?;
        if let Some((title,)) = title {
            spawn_checkpoint_sync(&state, cp.id, &title, cp.offset_days, cp.due_date);
        }
    }

    Ok(Json(cp))
}
