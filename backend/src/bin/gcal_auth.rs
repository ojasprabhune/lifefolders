// Run once to mint a Google OAuth refresh token for the calendar sync:
//   cargo run --bin gcal-auth
// Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env already (from a
// Desktop app OAuth client in Google Cloud Console). Prints a
// GOOGLE_REFRESH_TOKEN line to paste into .env - Google only issues a
// refresh token on first consent, so if this prints nothing, revoke prior
// access at https://myaccount.google.com/permissions and rerun.
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";
const REDIRECT_URI: &str = "http://127.0.0.1:8383";

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let client_id = env::var("GOOGLE_CLIENT_ID")?;
    let client_secret = env::var("GOOGLE_CLIENT_SECRET")?;

    let listener = TcpListener::bind("127.0.0.1:8383")?;
    let scope = utf8_percent_encode(SCOPE, NON_ALPHANUMERIC);
    let auth_url = format!(
        "{AUTH_URL}?client_id={client_id}&redirect_uri={REDIRECT_URI}\
         &response_type=code&scope={scope}&access_type=offline&prompt=consent"
    );

    println!("Open this URL, sign in with the Google account that owns the");
    println!("\"sidequests\" calendar, and approve access:\n\n{auth_url}\n");
    println!("Waiting for the redirect back to {REDIRECT_URI} ...");

    let (mut stream, _) = listener.accept()?;
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;

    let code = request_line
        .split_whitespace()
        .nth(1)
        .and_then(|path| path.split("code=").nth(1))
        .and_then(|rest| rest.split('&').next())
        .ok_or_else(|| anyhow::anyhow!("no ?code= in redirect: {request_line}"))?
        .to_string();

    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nDone, you can close this tab.")?;

    let http = reqwest::Client::new();
    let resp: TokenResponse = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    match resp.refresh_token {
        Some(rt) => println!("\nGOOGLE_REFRESH_TOKEN={rt}"),
        None => println!(
            "\nNo refresh_token in the response (access_token={}). \
             Revoke prior access at https://myaccount.google.com/permissions and rerun.",
            resp.access_token
        ),
    }

    Ok(())
}
