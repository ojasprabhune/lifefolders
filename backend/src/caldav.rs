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

// PT15H: all-day events are floating (no TZID), so a duration-based alarm relative
// to the start of the day is interpreted in the device's current local timezone -
// this is the same mechanism Apple's own "time of event" alerts use, and it means
// the 3pm alert stays correct across timezone changes and DST with no tz math here.
pub fn vevent(uid: &str, summary: &str, due_date: NaiveDate) -> String {
    let dt = due_date.format("%Y%m%d");
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//lifefolders//task-sync//EN\r\n\
         BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:{stamp}\r\nDTSTART;VALUE=DATE:{dt}\r\n\
         DTEND;VALUE=DATE:{dt}\r\nSUMMARY:{}\r\n\
         BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:{}\r\nTRIGGER:PT15H\r\nEND:VALARM\r\n\
         END:VEVENT\r\nEND:VCALENDAR\r\n",
        escape_ical(summary),
        escape_ical(summary)
    )
}
