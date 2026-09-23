use anyhow::{anyhow, Result};
use chrono::{Days, NaiveDate};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

async fn access_token(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<String> {
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("google token refresh returned {status}: {body}"));
    }
    Ok(resp.json::<TokenResponse>().await?.access_token)
}

// Google event ids are restricted to lowercase base32hex ([a-v0-9], 5-1024
// chars). Our uids ("lf-task-<uuid>", "lf-checkpoint-<uuid>") are already
// nothing but lowercase letters within a-v and hex digits, so stripping the
// hyphens is the entire transform needed to make them valid ids.
fn event_id(uid: &str) -> String {
    uid.replace('-', "")
}

pub async fn upsert_event(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
    calendar_id: &str,
    uid: &str,
    summary: &str,
    due_date: NaiveDate,
) -> Result<()> {
    let token = access_token(http, client_id, client_secret, refresh_token).await?;
    let id = event_id(uid);
    // All-day events use a date-only start/end, and Google's end date is
    // exclusive, so a single-day event ends the day after it starts.
    let end_date = due_date + Days::new(1);
    let body = json!({
        "id": id,
        "summary": summary,
        "start": { "date": due_date.format("%Y-%m-%d").to_string() },
        "end": { "date": end_date.format("%Y-%m-%d").to_string() },
        "reminders": { "useDefault": false },
    });

    let base = format!("https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events");

    // PUT updates an existing event; a task synced for the first time has no
    // event yet, so a 404 there falls through to POST (insert with our id).
    let resp = http
        .put(format!("{base}/{id}"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await?;
    if resp.status() == StatusCode::NOT_FOUND {
        let resp = http.post(&base).bearer_auth(&token).json(&body).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("google calendar insert {id} returned {status}: {text}"));
        }
        return Ok(());
    }
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("google calendar update {id} returned {status}: {text}"));
    }
    Ok(())
}

pub async fn delete_event(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
    calendar_id: &str,
    uid: &str,
) -> Result<()> {
    let token = access_token(http, client_id, client_secret, refresh_token).await?;
    let id = event_id(uid);
    let url = format!("https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events/{id}");
    let resp = http.delete(&url).bearer_auth(&token).send().await?;
    let status = resp.status();
    if !status.is_success() && status != StatusCode::NOT_FOUND && status != StatusCode::GONE {
        return Err(anyhow!("google calendar delete {id} returned {status}"));
    }
    Ok(())
}
