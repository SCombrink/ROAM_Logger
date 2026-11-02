// A record of every submission attempt, hidden or visible, successful or
// not, to find and fix problems. What people wrote is never recorded: of
// the observation only the card type (Field, Design or Office) is kept, as
// it has been a source of failures before.
//
// On each computer, in the app data folder:
// - submissions-log.txt: each attempt step by step, with times, who, which
//   computer and app version, every phase message, the form-fill steps
//   (values blanked) and the full result or error.
// - submissions-log.csv: one row per attempt, to filter and sort in Excel.
//
// When the project data has a "logsFolderUrl" (a SharePoint folder everyone
// can edit), each row is also added to submissions-<person>.csv there, in
// the background after the submission, so the app owner sees every user's
// attempts in one place. Rows wait in submissions-upload-queue.csv until
// they are uploaded, so none are lost when an upload fails.
//
// Attempts of the same observation (a hidden try and its small-window
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
    /// Seconds from the start at which each phase began
    timeline: Vec<(f64, String)>,
}

/// One submission runs at a time (they share the Edge profile lock).
static CURRENT: Mutex<Option<Current>> = Mutex::new(None);

/// Guards the upload queue file.
static QUEUE: Mutex<()> = Mutex::new(());

pub const CSV_HEADER: &str = "Date,Time,Result,Seconds,Name,Email,Windows user,Computer,App version,Submission ID,Attempt,Card type,Last step,Timeline,Error";

/// Starts recording an attempt.
pub fn begin() {
    *CURRENT.lock().unwrap() = Some(Current { started: Local::now(), lines: vec![], last_step: String::new(), timeline: vec![] });
}

/// Adds a timestamped line to the attempt being recorded (ignored if none).
pub fn note(msg: &str) {
    if let Some(c) = CURRENT.lock().unwrap().as_mut() {
        c.lines.push(format!("  {}  {}", Local::now().format("%H:%M:%S%.3f"), msg));
        if let Some(phase) = msg.strip_prefix("Phase ").and_then(|p| p.split('/').next()) {
            c.last_step = msg.to_string();
            let at = (Local::now() - c.started).num_milliseconds() as f64 / 1000.0;
            if c.timeline.last().map(|(_, p)| p.as_str()) != Some(phase) {
                c.timeline.push((at, phase.to_string()));
            }
        }
    }
}

/// Adds a form-fill step, with the value typed into the field blanked
/// (only the card type is kept).
pub fn note_form(line: &str) {
    note(&format!("Form: {}", redact(line)));
}

fn redact(line: &str) -> String {
    if line.contains("VFL") {
        return line.to_string();
    }
    match line.find(" with: ") {
        Some(i) => format!("{} with: (value not logged)", &line[..i]),
        None => line.to_string(),
    }
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
/// observation report.
pub(crate) fn who(app_data: &std::path::Path) -> (String, String) {
    let counts: Option<Value> = std::fs::read_to_string(app_data.join("observation-counts-cache.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    let name = counts.as_ref().and_then(|c| c["observer"].as_str()).map(|n| match n.split_once(',') {
        Some((last, first)) => format!("{} {}", first.trim(), last.trim()),
        None => n.to_string(),
    });
    let email = counts.as_ref().and_then(|c| c["email"].as_str()).unwrap_or("").to_string();
    (name.unwrap_or_else(|| "(name not known yet)".to_string()), email)
}

/// Finishes the attempt: records it, and uploads it when shared logging is
/// set up.
pub fn finish(app_handle: &tauri::AppHandle, payload_json: &str, mode: &str, result: &Result<String, String>) {
    let Ok(app_data) = app_handle.path().app_data_dir() else { return };
    let shared = crate::crews::link_setting(app_handle, "logsFolderUrl").is_some();
    record(&app_data, payload_json, mode, result, shared);
    if shared {
        let app = app_handle.clone();
        tauri::async_runtime::spawn(async move { upload_pending(&app).await });
    }
}

fn record(app_data: &std::path::Path, payload_json: &str, mode: &str, result: &Result<String, String>, queue: bool) {
    let Some(current) = CURRENT.lock().unwrap().take() else { return };
    let _ = std::fs::create_dir_all(app_data);
    let payload: Value = serde_json::from_str(payload_json).unwrap_or(Value::Null);
    let card = payload.get("cardType").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let (name, email) = who(app_data);
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
    let timeline = current
        .timeline
        .iter()
        .map(|(at, phase)| format!("P{} {:.1}s", phase, at))
        .chain(std::iter::once(format!("end {:.1}s", seconds)))
        .collect::<Vec<_>>()
        .join(" > ");

    let mut text = format!(
        "=== {} | {} | {:.1}s\nWho: {}{} | Windows user: {} | Computer: {} | App v{}\nSubmission {} | Attempt: {} | Card type: {}\nSteps:\n",
        current.started.format("%Y-%m-%d %H:%M:%S"),
        outcome,
        seconds,
        name,
        if email.is_empty() { String::new() } else { format!(" ({})", email) },
        windows_user,
        computer,
        version,
        id,
        mode,
        if card.is_empty() { "?" } else { &card },
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
        card,
        current.last_step,
        timeline,
        error,
    ]
    .iter()
    .map(|c| csv(c))
    .collect::<Vec<_>>()
    .join(",");

    let csv_path = app_data.join("submissions-log.csv");
    // Older versions wrote other columns: start a fresh file in this format.
    let old_format = std::fs::read_to_string(&csv_path).ok().is_some_and(|t| !t.starts_with(CSV_HEADER));
    if old_format {
        let _ = std::fs::rename(&csv_path, app_data.join("submissions-log.old.csv"));
    }
    let new_file = !csv_path.exists();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&csv_path) {
        if new_file {
            let _ = writeln!(f, "{}", CSV_HEADER);
        }
        let _ = writeln!(f, "{}", row);
    }
    if queue {
        let _guard = QUEUE.lock().unwrap();
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(app_data.join("submissions-upload-queue.csv")) {
            let _ = writeln!(f, "{}", row);
        }
    }
}

/// This person's file in the shared logs folder.
fn shared_file_name(app_data: &std::path::Path) -> String {
    let (_, email) = who(app_data);
    let who = match email.split('@').next().filter(|s| !s.is_empty()) {
        Some(local) => local.to_string(),
        None => format!("{}-{}", std::env::var("USERNAME").unwrap_or_default(), std::env::var("COMPUTERNAME").unwrap_or_default()),
    };
    let safe: String = who.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c.to_ascii_lowercase() } else { '_' }).collect();
    format!("submissions-{}.csv", safe.trim_matches(|c| c == '-' || c == '_'))
}

/// The queued rows, without blank lines.
fn queued_rows(app_data: &std::path::Path) -> Vec<String> {
    let _guard = QUEUE.lock().unwrap();
    std::fs::read_to_string(app_data.join("submissions-upload-queue.csv"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// Removes the first `n` queued rows (the ones just uploaded); rows added
/// meanwhile stay.
fn drop_uploaded(app_data: &std::path::Path, n: usize) {
    let _guard = QUEUE.lock().unwrap();
    let path = app_data.join("submissions-upload-queue.csv");
    let rest: Vec<String> = std::fs::read_to_string(&path).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).skip(n).map(str::to_string).collect();
    let _ = if rest.is_empty() { std::fs::remove_file(&path) } else { std::fs::write(&path, rest.join("\n") + "\n") };
}

/// The shared file with the new rows added (a new file starts with the header).
fn appended(existing: Option<&str>, rows: &[String]) -> String {
    let mut text = match existing {
        Some(t) if !t.trim().is_empty() => t.trim_end().to_string() + "\n",
        _ => format!("{}\n", CSV_HEADER),
    };
    for r in rows {
        text.push_str(r);
        text.push('\n');
    }
    text
}

static UPLOADING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Uploads queued rows to this person's file in the shared logs folder.
/// Runs in the background; never opens a window (if a sign-in is needed the
/// rows wait for the next upload).
pub async fn upload_pending(app_handle: &tauri::AppHandle) {
    let Ok(_one_at_a_time) = UPLOADING.try_lock() else { return };
    let Some(link) = crate::crews::link_setting(app_handle, "logsFolderUrl") else { return };
    let Ok(app_data) = app_handle.path().app_data_dir() else { return };
    let rows = queued_rows(&app_data);
    if rows.is_empty() {
        return;
    }
    let name = shared_file_name(&app_data);
    let count = rows.len();
    let uploaded = crate::crews::with_folder(app_handle, link, false, false, move |s| {
        for _ in 0..4 {
            let done = match s.read_text(&name)? {
                None => s.create_text(&name, &appended(None, &rows))?,
                Some((text, etag)) => s.save_text(&name, &appended(Some(&text), &rows), &etag)?,
            };
            if done {
                return Ok(());
            }
        }
        Err("The shared log file is busy.".to_string())
    })
    .await;
    if uploaded.is_ok() {
        drop_uploaded(&app_data, count);
    }
}

/// Whether submissions are shared with the app owner (logsFolderUrl set).
#[tauri::command]
pub fn shared_logging_enabled(app_handle: tauri::AppHandle) -> bool {
    crate::crews::link_setting(&app_handle, "logsFolderUrl").is_some()
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
    fn records_attempts_without_what_was_written() {
        let dir = std::env::temp_dir().join(format!("roam-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("observation-counts-cache.json"), r#"{"observer":"Combrink, Sybrandt","email":"sybrandt.combrink@hatch.com","observers":{}}"#).unwrap();
        // An older-format log is set aside.
        std::fs::write(dir.join("submissions-log.csv"), "Date,Time,Result,Seconds,Name\n\"x\"\n").unwrap();
        let payload = r#"{"date":"2026-11-02","time":"09:00","cardType":"Design","category":"Housekeeping","project":"Secret Project","exactLoc":"Level 3","details":"Cables across the walkway","action":"Taped them down"}"#;

        begin();
        note("Phase 1/5: Launching Edge browser (attempt 1/3)...");
        note("Phase 1/5: Tab acquired. Continuing...");
        note("Phase 2/5: Connected to ROAM. Waiting for the form page to load...");
        record(&dir, payload, "Hidden", &Err("Sign-in needed: ROAM asked to sign in, which can't be done in the background.".into()), true);
        begin();
        note("Phase 4/5: Filling form fields...");
        note_form("[t] Filling Details (Field 42) (index 41) with: Cables across the walkway");
        note_form("[t] Filling VFL Field (index 49) with: VFL - Design for Safety Audit Card, Orange Card");
        note_form("[t] Clicking Submit button");
        note("Phase 5/5: Form submitted. Waiting for ROAM server to confirm save (up to 30s)...");
        record(&dir, payload, "Small visible window (automatic retry)", &Ok("Record was saved successfully on the ROAM website.".into()), true);
        note("ignored: no attempt running");

        let txt = std::fs::read_to_string(dir.join("submissions-log.txt")).unwrap();
        println!("{}", txt);
        assert_eq!(txt.matches("=== ").count(), 2);
        assert!(txt.contains("| FAILED |") && txt.contains("| SAVED |"));
        assert!(txt.contains("Who: Sybrandt Combrink (sybrandt.combrink@hatch.com)"));
        assert!(txt.contains("Card type: Design"));
        assert!(txt.contains("Filling Details (Field 42) (index 41) with: (value not logged)"));
        assert!(txt.contains("VFL - Design for Safety Audit Card, Orange Card"));
        for secret in ["Cables", "Taped", "Secret Project", "Housekeeping", "Level 3", "ignored"] {
            assert!(!txt.contains(secret), "{}", secret);
        }

        let csv = std::fs::read_to_string(dir.join("submissions-log.csv")).unwrap();
        println!("{}", csv);
        let rows: Vec<&str> = csv.lines().collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], CSV_HEADER);
        assert!(dir.join("submissions-log.old.csv").exists());
        assert!(rows[1].contains("\"FAILED\"") && rows[1].contains("\"Design\"") && rows[1].contains("\"P1 0.0s > P2 0.0s > end"));
        assert!(!csv.contains("Secret Project") && !csv.contains("Cables"));
        let id = |r: &str| r.split("\",\"").nth(9).unwrap().to_string();
        assert_eq!(id(rows[1]), id(rows[2]));

        // Upload queue: both rows wait; uploading the first leaves the second.
        assert_eq!(queued_rows(&dir).len(), 2);
        assert_eq!(appended(None, &queued_rows(&dir)).lines().next(), Some(CSV_HEADER));
        assert_eq!(appended(Some("h\nr1\n\n"), &["r2".to_string()]), "h\nr1\nr2\n");
        drop_uploaded(&dir, 1);
        assert_eq!(queued_rows(&dir), vec![rows[2].to_string()]);
        drop_uploaded(&dir, 1);
        assert!(!dir.join("submissions-upload-queue.csv").exists());
        assert_eq!(shared_file_name(&dir), "submissions-sybrandt.combrink.csv");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
