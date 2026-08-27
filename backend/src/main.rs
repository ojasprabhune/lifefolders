use std::env;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

mod caldav;
mod commands;
mod daily;
mod focus;
mod groq;
mod recap;
mod cadences;
mod learning;
mod models;
mod music;
mod rank;
mod routes;
mod search;
mod sleep;
mod tasks;
mod undo;
mod usda;
mod wger;
mod wishlist;

#[derive(Clone)]
pub struct CaldavConfig {
    pub http: reqwest::Client,
    pub apple_id: String,
    pub app_password: String,
    pub calendar_url: String,
}

#[derive(Clone)]
pub struct RecapConfig {
    pub api_key: String,
    pub from: String,
    pub to: String,
    pub tz_offset_min: i32,
}

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub http: reqwest::Client,
    pub groq_key: String,
    pub usda_key: String,
    pub auth_token: String,
    pub wger_key: Option<String>,
    pub caldav: Option<CaldavConfig>,
    pub recap: Option<RecapConfig>,
    pub last_action: Arc<Mutex<Vec<undo::Effect>>>,
}

async fn require_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let provided = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    if provided != Some(state.auth_token.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    next.run(req).await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "life_api=info,tower_http=info".into()),
        )
        .init();

    let database_url = env::var("DATABASE_URL")?;
    let groq_key = env::var("GROQ_API_KEY")?;
    let usda_key = env::var("USDA_API_KEY").unwrap_or_else(|_| "DEMO_KEY".into());
    let auth_token = env::var("AUTH_TOKEN")?;
    let wger_key = env::var("WGER_API_KEY").ok().filter(|k| !k.is_empty());

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;

    let caldav = (|| {
        Some(CaldavConfig {
            http: http.clone(),
            apple_id: env::var("CALDAV_APPLE_ID").ok().filter(|v| !v.is_empty())?,
            app_password: env::var("CALDAV_APP_PASSWORD").ok().filter(|v| !v.is_empty())?,
            calendar_url: env::var("CALDAV_CALENDAR_URL").ok().filter(|v| !v.is_empty())?,
        })
    })();

    let allowed_origins = [
        "https://ojasprabhune.github.io",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    .map(|o| o.parse::<HeaderValue>().unwrap());

    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    // Recap email is optional: without a Resend key and recipient the endpoint
    // just reports it's unconfigured.
    let recap = (|| {
        Some(RecapConfig {
            api_key: env::var("RESEND_API_KEY").ok().filter(|v| !v.is_empty())?,
            to: env::var("RECAP_TO").ok().filter(|v| !v.is_empty())?,
            from: env::var("RECAP_FROM")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "onboarding@resend.dev".into()),
            tz_offset_min: env::var("RECAP_TZ_OFFSET_MIN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(420),
        })
    })();

    let last_action = Arc::new(Mutex::new(Vec::new()));
    let state = AppState {
        pool,
        http,
        groq_key,
        usda_key,
        auth_token,
        wger_key,
        caldav,
        recap,
        last_action,
    };

    let api = Router::new()
        .route("/api/logs", get(routes::list_logs).post(routes::create_log))
        .route("/api/undo", post(undo::undo_last))
        .route(
            "/api/logs/{id}",
            get(routes::get_log)
                .patch(routes::update_log)
                .delete(routes::delete_log),
        )
        .route("/api/search", get(search::search))
        .route("/api/wishlist", get(wishlist::list).post(wishlist::create))
        .route(
            "/api/wishlist/{id}",
            axum::routing::patch(wishlist::patch).delete(wishlist::archive),
        )
        .route("/api/albums", get(music::list_albums))
        .route("/api/songs", get(music::list_songs))
        .route("/api/workouts", get(routes::list_workouts))
        .route("/api/weights", get(routes::list_weights))
        .route("/api/rank", post(rank::rank))
        .route("/api/rank/list", get(rank::list))
        .route("/api/sleep", get(routes::list_sleep))
        .route("/api/sleep/insight", get(sleep::insight))
        .route("/api/transcribe", post(routes::transcribe))
        .route("/api/fields", get(learning::list_fields).post(learning::create_field))
        .route("/api/fields/{id}", get(learning::get_field))
        .route("/api/fields/{id}/resources", post(learning::add_resource))
        .route("/api/fields/{id}/plan/generate", post(learning::generate_plan))
        .route("/api/fields/{id}/plan", axum::routing::put(learning::save_plan))
        .route("/api/resources/{id}", axum::routing::patch(learning::patch_resource))
        .route("/api/topics/{id}", axum::routing::patch(learning::patch_topic))
        .route("/api/tasks", get(tasks::list_tasks))
        .route(
            "/api/tasks/{id}",
            axum::routing::patch(tasks::patch_task).delete(tasks::delete_task),
        )
        .route("/api/task-checkpoints/{id}", axum::routing::patch(tasks::patch_checkpoint))
        .route("/api/cadences", get(cadences::list_cadences).post(cadences::create_cadence))
        .route(
            "/api/cadences/{id}",
            axum::routing::delete(cadences::archive_cadence).patch(cadences::patch_cadence),
        )
        .route("/api/cadences/{id}/completions", get(cadences::completions))
        .route("/api/daily-notes", get(daily::list))
        .route("/api/daily-notes/{date}", axum::routing::patch(daily::patch))
        .route("/api/focus-sessions", post(focus::create_session))
        .route("/api/focus-sessions/active", get(focus::active_session))
        .route("/api/focus-sessions/{id}/pause", post(focus::pause_session))
        .route("/api/focus-sessions/{id}/resume", post(focus::resume_session))
        .route("/api/focus-sessions/{id}/extend", post(focus::extend_session))
        .route("/api/focus-sessions/{id}", delete(focus::delete_session))
        .route("/api/tasks/{id}/focus-sessions", get(focus::list_for_task))
        .route("/api/recap/send", post(recap::send))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .layer(axum::extract::DefaultBodyLimit::max(60 * 1024 * 1024));

    let app = Router::new()
        .route("/health", get(routes::health))
        // Ended via navigator.sendBeacon on tab close, which cannot send the
        // bearer header, so this route sits outside require_auth and checks the
        // token itself (header or body).
        .route("/api/focus-sessions/{id}/end", post(focus::end_session))
        .merge(api)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = env::var("PORT").unwrap_or_else(|_| "8080".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    tracing::info!("listening on port {port}");
    axum::serve(listener, app).await?;
    Ok(())
}
