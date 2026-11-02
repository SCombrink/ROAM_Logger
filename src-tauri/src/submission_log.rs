// A record of every submission attempt, hidden or visible, successful or
// not, kept in the app data folder:
// - submissions-log.txt: each attempt step by step, with times, who, which
//   computer and app version, the observation, every phase message, the
//   form-fill log and the full result or error.
// - submissions-log.csv: one row per attempt, to filter and sort in Excel.
// Attempts of the same observation (e.g. a hidden try and its small-window
// retry) share a submission ID.

use chrono::{DateTime, Local};
use serde_json::Value;
use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

struct Current {
    started: DateTime<Local>,
    lines: Vec<String>,
    last_step: String,
}

/// One submission runs at a time (they share the Edge profile lock).
static CURRENT: Mutex<Option<Current>> = Mutex::new(None);

/// Starts recording an attempt.
pub fn begin() {
    *CURRENT.lock().unwrap() = Some(Current { started: Local::now(), lines: vec![], last_step: String::new() });
}

/// Adds a timestamped line to the attempt being recorded (ignored if none).
pub fn note(msg: &str) {
    if let Some(c) = CURRENT.lock().unwrap().as_mut() {
        c.lines.push(format!("  {}  {}", Local::now().format("%H:%M:%S%.3f"), msg));
        if msg.starts_with("Phase") {
            c.last_step = msg.to_string();
        }
    }
}

fn field<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(|v| v.as_str()).unwrap_or("").trim()
}

fn short(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > max { format!("{}...", one_line.chars().take(max).collect::<String>()) } else { one_line }
}

fn csv(cell: &str) -> String {
    format!("\"{}\"", cell.replace('"', "\"\""))
}

/// The submission ID: the same observation gives the same ID on every attempt.
fn submission_id(payload: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    payload.hash(&mut h);
    format!("{:06X}", h.finish() & 0xFFFFFF)
}

/// Who is logging, as far as the app knows: their name and email from the
/// observation report, plus the Windows account and computer name.
fn who(app_data: &std::path::Path) -> (String, String) {
    let counts: Option<Value> = std::fs::read_to_string(app_data.join("observation-counts-cache.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    let name = counts.as_ref().and_then(|c| c["observer"].as_str()).map(|n| match n.split_once(',') {
        Some((last, first)) => format!("{} {}", first.trim(), last.trim()),
        None => n.to_string(),
    });
    let email = counts.as_ref().and_then(|c| c["email"].as_str()).unwrap_or("").to_string();
    (name.unwrap_or_else(|| "(name not known yet)".to_string()), email)
}

/// Finishes the attempt: appends it to both log files.
pub fn finish(app_handle: &tauri::AppHandle, payload_json: &str, mode: &str, result: &Result<String, String>) {
    if let Ok(app_data) = app_handle.path().app_data_dir() {
        record(&app_data, payload_json, mode, result);
    }
}

fn record(app_data: &std::path::Path, payload_json: &str, mode: &str, result: &Result<String, String>) {
    let Some(current) = CURRENT.lock().unwrap().take() else { return };
    let app_data = app_data.to_path_buf();
    let _ = std::fs::create_dir_all(&app_data);
    let payload: Value = serde_json::from_str(payload_json).unwrap_or(Value::Null);
    let (name, email) = who(&app_data);
    let windows_user = std::env::var("USERNAME").unwrap_or_default();
    let computer = std::env::var("COMPUTERNAME").unwrap_or_default();
    let version = env!("CARGO_PKG_VERSION");
    let id = submission_id(payload_json);
    let seconds = (Local::now() - current.started).num_milliseconds() as f64 / 1000.0;
    let (outcome, detail) = match result {
        Ok(msg) => ("SAVED", msg.clone()),
        Err(e) if e.contains("cancelled") => ("CANCELLED", e.clone()),
        Err(e) if e.contains("Submit button was clicked") => ("NOT CONFIRMED", e.clone()),
        Err(e) => ("FAILED", e.clone()),
    };

    let mut text = format!(
        "=== {} | {} | {}\nWho: {}{} | Windows user: {} | Computer: {} | App v{}\nSubmission {} | Attempt: {}\nObservation: {} {} | {} card | Category: {} | Project: {} | Office: {} | Location: {}\n  Details: {}\n  Action: {}\nSteps:\n",
        current.started.format("%Y-%m-%d %H:%M:%S"),
        outcome,
        format!("{:.1}s", seconds),
        name,
        if email.is_empty() { String::new() } else { format!(" ({})", email) },
        windows_user,
        computer,
        version,
        id,
        mode,
        field(&payload, "date"),
        field(&payload, "time"),
        field(&payload, "cardType"),
        field(&payload, "category"),
        field(&payload, "project"),
        field(&payload, "office"),
        field(&payload, "exactLoc"),
        short(field(&payload, "details"), 200),
        short(field(&payload, "action"), 200),
    );
    for line in &current.lines {
        text.push_str(line);
        text.push('\n');
    }
    text.push_str(&format!("Result: {}\n{}\n\n", outcome, detail.lines().map(|l| format!("  {}", l)).collect::<Vec<_>>().join("\n")));

    let txt = app_data.join("submissions-log.txt");
    // Keep the file a manageable size: start a new one past 5 MB.
    if std::fs::metadata(&txt).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&txt, app_data.join("submissions-log.old.txt"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&txt) {
        let _ = f.write_all(text.as_bytes());
    }

    let csv_path = app_data.join("submissions-log.csv");
    let new_file = !csv_path.exists();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&csv_path) {
        if new_file {
            let _ = writeln!(f, "Date,Time,Result,Seconds,Name,Email,Windows user,Computer,App version,Submission ID,Attempt,Last step,Observation date,Observation time,Card type,Category,Project,Error");
        }
        let error = match result {
            Ok(_) => String::new(),
            Err(e) => short(e, 300),
        };
        let row = [
            current.started.format("%Y-%m-%d").to_string(),
            current.started.format("%H:%M:%S").to_string(),
            outcome.to_string(),
            format!("{:.1}", seconds),
            name,
            email,
            windows_user,
            computer,
            version.to_string(),
            id,
            mode.to_string(),
            current.last_step,
            field(&payload, "date").to_string(),
            field(&payload, "time").to_string(),
            field(&payload, "cardType").to_string(),
            field(&payload, "category").to_string(),
            field(&payload, "project").to_string(),
            error,
        ];
        let _ = writeln!(f, "{}", row.iter().map(|c| csv(c)).collect::<Vec<_>>().join(","));
    }
}

/// Opens the app data folder with the submissions log selected.
#[tauri::command]
pub fn open_submissions_log(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let txt = dir.join("submissions-log.txt");
    #[cfg(windows)]
    {
        let arg = if txt.exists() { format!("/select,{}", txt.display()) } else { dir.display().to_string() };
        std::process::Command::new("explorer").arg(arg).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = txt;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_attempts_in_both_files() {
        let dir = std::env::temp_dir().join(format!("roam-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("observation-counts-cache.json"), r#"{"observer":"Combrink, Sybrandt","email":"sybrandt.combrink@hatch.com","observers":{}}"#).unwrap();
        let payload = r#"{"date":"2026-11-02","time":"09:00","cardType":"Field","category":"Housekeeping","project":"P1","office":"Cape Town","exactLoc":"Level 3","details":"Cables across the walkway, \"trip\" hazard","action":"Taped them down"}"#;

        begin();
        note("Phase 1/5: Launching Edge browser (attempt 1/3)...");
        note("Phase 2/5: Connected to ROAM. Waiting for the form page to load...");
        record(&dir, payload, "Hidden", &Err("Sign-in needed: ROAM asked to sign in, which can't be done in the background.".into()));
        begin();
        note("Phase 5/5: Form submitted. Waiting for ROAM server to confirm save (up to 30s)...");
        note("Form: [t] Clicking Submit button");
        record(&dir, payload, "Small visible window (automatic retry)", &Ok("Record was saved successfully on the ROAM website.".into()));
        note("ignored: no attempt running");

        let txt = std::fs::read_to_string(dir.join("submissions-log.txt")).unwrap();
        println!("{}", txt);
        assert_eq!(txt.matches("=== ").count(), 2);
        assert!(txt.contains("| FAILED |") && txt.contains("| SAVED |"));
        assert!(txt.contains("Who: Sybrandt Combrink (sybrandt.combrink@hatch.com)"));
        assert!(txt.contains("Form: [t] Clicking Submit button"));
        assert!(!txt.contains("ignored"));

        let csv = std::fs::read_to_string(dir.join("submissions-log.csv")).unwrap();
        println!("{}", csv);
        let rows: Vec<&str> = csv.lines().collect();
        assert_eq!(rows.len(), 3);
        assert!(rows[0].starts_with("Date,Time,Result"));
        assert!(rows[1].contains("\"FAILED\"") && rows[1].contains("\"Phase 2/5: Connected"));
        assert!(rows[2].contains("\"SAVED\""));
        // Both attempts of the same observation share the submission ID.
        let id = |r: &str| r.split("\",\"").nth(9).unwrap().to_string();
        assert_eq!(id(rows[1]), id(rows[2]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
