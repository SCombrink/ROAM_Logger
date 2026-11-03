// Who uses ROAM Logger, and which shared crews they follow: each app writes
// a small user-<name>.json into a SharePoint folder everyone can edit
// ("usersFolderUrl" in the project data) once a day, and again when the
// crews it follows change. Opening a crew reads only its members' files, so
// crew admins can see who has joined.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::Manager;

use crate::crews::{link_setting, with_folder};
use crate::submission_log::who;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub name: String,
    pub email: String,
    pub app_version: String,
    /// When the app last checked in (ISO)
    pub last_seen: String,
    /// Codes of the shared crews this person follows (as member or not)
    #[serde(default)]
    pub crews: Vec<String>,
}

/// The file for an email address: user-<part before @>.json.
pub fn file_for(email: &str) -> Option<String> {
    let local = email.trim().split('@').next()?.to_lowercase();
    let safe: String = local.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect();
    (!safe.is_empty()).then(|| format!("user-{}.json", safe))
}

/// Whether the users folder is set up.
#[tauri::command]
pub fn presence_available(app_handle: tauri::AppHandle) -> bool {
    link_setting(&app_handle, "usersFolderUrl").is_some()
}

/// Writes (or updates) this user's file. Background only: never opens a
/// window. Errors are returned for the caller to retry another day.
#[tauri::command]
pub async fn check_in(app_handle: tauri::AppHandle, crews: Vec<String>) -> Result<(), String> {
    let link = link_setting(&app_handle, "usersFolderUrl").ok_or("No users folder set up.")?;
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let (name, email) = who(&app_data);
    let file = file_for(&email).ok_or("Your email isn't known yet (it comes with your own counts).")?;
    let me = Presence {
        name,
        email: email.to_lowercase(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        last_seen: chrono::Local::now().to_rfc3339(),
        crews,
    };
    let text = serde_json::to_string_pretty(&me).map_err(|e| e.to_string())?;
    with_folder(&app_handle, link, false, false, move |s| {
        for _ in 0..3 {
            let done = match s.read_text(&file)? {
                None => s.create_text(&file, &text)?,
                Some((_, etag)) => s.save_text(&file, &text, &etag)?,
            };
            if done {
                return Ok(());
            }
        }
        Err("The users folder is busy.".to_string())
    })
    .await
}

/// The check-in files of these people (by email), for a crew's member list.
/// People without a file (not using ROAM Logger, or not since this was set
/// up) are left out.
#[tauri::command]
pub async fn fetch_presence(app_handle: tauri::AppHandle, emails: Vec<String>) -> Result<BTreeMap<String, Presence>, String> {
    let link = link_setting(&app_handle, "usersFolderUrl").ok_or("No users folder set up.")?;
    let wanted: Vec<(String, String)> = emails
        .iter()
        .filter_map(|e| Some((e.trim().to_lowercase(), file_for(e)?)))
        .collect();
    if wanted.is_empty() {
        return Ok(BTreeMap::new());
    }
    with_folder(&app_handle, link, false, false, move |s| {
        let mut out = BTreeMap::new();
        for (email, file) in &wanted {
            if let Ok(Some((text, _))) = s.read_text(file) {
                if let Ok(p) = serde_json::from_str::<Presence>(&text) {
                    out.insert(email.clone(), p);
                } else if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    // An older or partial file still shows the person uses the app.
                    out.insert(email.clone(), Presence {
                        name: v["name"].as_str().unwrap_or_default().to_string(),
                        email: email.clone(),
                        app_version: v["appVersion"].as_str().unwrap_or_default().to_string(),
                        last_seen: v["lastSeen"].as_str().unwrap_or_default().to_string(),
                        crews: vec![],
                    });
                }
            }
        }
        Ok(out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        assert_eq!(file_for("Willem.duPlooy@hatch.com").as_deref(), Some("user-willem.duplooy.json"));
        assert_eq!(file_for("sybrandt.combrink2@hatch.com").as_deref(), Some("user-sybrandt.combrink2.json"));
        assert_eq!(file_for("../evil@x.com").as_deref(), Some("user-..evil.json"));
        assert_eq!(file_for("").as_deref(), None);
    }
}
