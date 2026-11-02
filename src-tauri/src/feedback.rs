// Feedback from users, written as one JSON file each into a SharePoint
// folder everyone can add to ("feedbackFolderUrl" in the project data), so
// the app owner can pick it up there (e.g. a Power Automate flow that turns
// each new file into a GitHub issue).
//
// Each message is saved on this computer first (feedback-queue folder) and
// removed once it is in SharePoint, so none is lost when SharePoint can't be
// reached; leftovers are sent on the next launch.

use serde::Serialize;
use tauri::Manager;

use crate::crews::{link_setting, with_folder};
use crate::submission_log::who;

const MAX_MESSAGE: usize = 5000;
/// Recent submission results attached (when the user allows): times,
/// outcomes, errors and card type only; never what was written.
const RECENT_RESULTS: usize = 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Feedback {
    kind: String,
    message: String,
    created_at: String,
    name: String,
    email: String,
    windows_user: String,
    computer: String,
    app_version: String,
    /// Header and last rows of submissions-log.csv, if included
    recent_submissions: Option<String>,
}

fn queue_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?.join("feedback-queue");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Whether in-app feedback is set up (a feedback folder link is known).
#[tauri::command]
pub fn feedback_available(app_handle: tauri::AppHandle) -> bool {
    link_setting(&app_handle, "feedbackFolderUrl").is_some()
}

/// Saves the feedback and sends it to the feedback folder. Returns "sent",
/// or "queued" when it is kept to be sent later.
#[tauri::command]
pub async fn submit_feedback(app_handle: tauri::AppHandle, kind: String, message: String, include_results: bool) -> Result<String, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Write a message first.".to_string());
    }
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let (name, email) = who(&app_data);
    let recent = include_results
        .then(|| std::fs::read_to_string(app_data.join("submissions-log.csv")).ok())
        .flatten()
        .map(|csv| {
            let lines: Vec<&str> = csv.lines().collect();
            let header = lines.first().copied().unwrap_or_default();
            let rows = &lines[lines.len().saturating_sub(RECENT_RESULTS).max(1).min(lines.len())..];
            std::iter::once(header).chain(rows.iter().copied()).collect::<Vec<_>>().join("\n")
        });
    let now = chrono::Local::now();
    let feedback = Feedback {
        kind: kind.trim().chars().take(30).collect(),
        message: message.chars().take(MAX_MESSAGE).collect(),
        created_at: now.to_rfc3339(),
        name,
        email: email.clone(),
        windows_user: std::env::var("USERNAME").unwrap_or_default(),
        computer: std::env::var("COMPUTERNAME").unwrap_or_default(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        recent_submissions: recent,
    };
    let who_part: String = email.split('@').next().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| feedback.windows_user.clone())
        .chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c.to_ascii_lowercase() } else { '_' }).collect();
    let file = format!("feedback-{}-{}.json", now.format("%Y%m%d-%H%M%S"), who_part);
    let text = serde_json::to_string_pretty(&feedback).map_err(|e| e.to_string())?;
    std::fs::write(queue_dir(&app_handle)?.join(&file), text).map_err(|e| format!("Could not save the feedback: {}", e))?;

    Ok(if send_pending(&app_handle, true).await > 0 && !queue_dir(&app_handle)?.join(&file).exists() { "sent".into() } else { "queued".into() })
}

/// Sends the saved feedback files to the feedback folder; returns how many
/// were sent. `interactive`: the user just pressed Send (a sign-in window
/// may open if needed).
pub async fn send_pending(app_handle: &tauri::AppHandle, interactive: bool) -> usize {
    let Some(link) = link_setting(app_handle, "feedbackFolderUrl") else { return 0 };
    let Ok(dir) = queue_dir(app_handle) else { return 0 };
    let files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let text = std::fs::read_to_string(e.path()).ok()?;
                    name.ends_with(".json").then_some((name, text))
                })
                .collect()
        })
        .unwrap_or_default();
    if files.is_empty() {
        return 0;
    }
    let sent = with_folder(app_handle, link, interactive, interactive, move |s| {
        let mut done = Vec::new();
        for (name, text) in &files {
            // Already there (sent before, but not yet removed here) counts as sent.
            if s.create_text(name, text).is_ok() {
                done.push(name.clone());
            }
        }
        Ok(done)
    })
    .await
    .unwrap_or_default();
    for name in &sent {
        let _ = std::fs::remove_file(dir.join(name));
    }
    sent.len()
}
