use anyhow::{anyhow, Result};
use chrono::NaiveDate;
use reqwest::{Method, StatusCode};

fn escape_ical(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(',', "\\,")
        .replace(';', "\\;")
        .replace('\n', "\\n")
}

pub async fn put_ical(
    http: &reqwest::Client,
    collection_url: &str,
    uid: &str,
    apple_id: &str,
    app_password: &str,
    ical_body: &str,
) -> Result<()> {
    let url = format!("{}/{}.ics", collection_url.trim_end_matches('/'), uid);
    let resp = http
        .request(Method::from_bytes(b"PUT")?, &url)
        .basic_auth(apple_id, Some(app_password))
        .header("Content-Type", "text/calendar; charset=utf-8")
        .body(ical_body.to_string())
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("caldav PUT {url} returned {status}"));
    }
    Ok(())
}

pub async fn delete_ical(
    http: &reqwest::Client,
    collection_url: &str,
    uid: &str,
    apple_id: &str,
    app_password: &str,
) -> Result<()> {
    let url = format!("{}/{}.ics", collection_url.trim_end_matches('/'), uid);
    let resp = http
        .delete(&url)
        .basic_auth(apple_id, Some(app_password))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() && status != StatusCode::NOT_FOUND {
        return Err(anyhow!("caldav DELETE {url} returned {status}"));
    }
    Ok(())
}

// Used to be an all-day event with a PT15H (midnight+15h) duration alarm,
// but Apple injects its own extra default alert onto all-day events no
// matter what - that injection specifically targets all-day events, so a
// timed event (literally starting at 3:30pm) sidesteps it entirely, and the
// alarm collapses to "fire at start" instead of needing duration math.
// Hardcoded to Pacific time since this is a single-user app.
pub fn vevent(uid: &str, summary: &str, due_date: NaiveDate) -> String {
    let start = due_date.format("%Y%m%dT153000");
    let end = due_date.format("%Y%m%dT154500");
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//lifefolders//task-sync//EN\r\n\
         BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:{stamp}\r\n\
         DTSTART;TZID=America/Los_Angeles:{start}\r\nDTEND;TZID=America/Los_Angeles:{end}\r\n\
         SUMMARY:{}\r\n\
         BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:{}\r\nTRIGGER:PT0M\r\nEND:VALARM\r\n\
         END:VEVENT\r\nEND:VCALENDAR\r\n",
        escape_ical(summary),
        escape_ical(summary)
    )
}
