// The safety focus shown in the empty chat area: an HTML page the Health &
// Safety team keeps in a SharePoint file they edit themselves. Its sharing
// link is "safetyFocusUrl" (project data, or tauri.conf.json).
//
// The app shows the copy it saved last time straight away, then downloads
// the file in the background with the user's signed-in Edge (the same way as
// the project list); if it changed, the new copy is saved and the screen
// cross-fades to it. The page
// is shown in a sandbox with no scripts, so it can only show content.

use tauri::Manager;

use crate::crews::link_setting;
use crate::powerbi::edge_exe;
use crate::{browser_download, edge_profile_lock};

const CACHE: &str = "safety-focus.html";
/// Larger than any sensible page; stops a wrong link filling the screen.
const MAX_BYTES: usize = 1_500_000;

/// The copy saved last time, if any.
#[tauri::command]
pub fn get_safety_focus(app_handle: tauri::AppHandle) -> Option<String> {
    let dir = app_handle.path().app_data_dir().ok()?;
    std::fs::read_to_string(dir.join(CACHE)).ok().filter(|t| !t.trim().is_empty())
}

fn note(dir: &std::path::Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("safety-focus-log.txt")) {
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg);
    }
}

/// The sharing link with download=1, so opening it downloads the file.
fn download_link(link: &str) -> String {
    if link.contains("download=1") {
        link.to_string()
    } else {
        format!("{}{}download=1", link, if link.contains('?') { '&' } else { '?' })
    }
}

/// Fetches the file and returns it if it differs from the saved copy
/// (None when unchanged, or when no link is set). Uses the same hidden-Edge
/// download as the project list. Never opens a window. Each step goes to
/// safety-focus-log.txt in the app data folder.
#[tauri::command]
pub async fn refresh_safety_focus(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let Some(link) = link_setting(&app_handle, "safetyFocusUrl") else {
        note(&dir, "No safetyFocusUrl in the project data: showing the built-in page.");
        return Ok(None);
    };
    note(&dir, &format!("Fetching {}", link));
    let (profile, downloads, url) = (dir.join("edge_profile"), dir.join("downloads-focus"), download_link(&link));
    let result = {
        let _profile = edge_profile_lock().lock().await;
        tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&downloads);
            let path = browser_download(&edge_exe(), &profile, &downloads, &url, true, 45, None)?;
            let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the downloaded file: {}", e))?;
            let _ = std::fs::remove_dir_all(&downloads);
            Ok::<_, String>((path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), bytes))
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let (name, bytes) = match result {
        Ok(v) => v,
        Err(e) => {
            note(&dir, &format!("Failed: {} (if this says the file did not download, check the link opens the file for everyone in the company)", e));
            return Err(e);
        }
    };
    let text = String::from_utf8_lossy(&bytes).trim_start_matches('\u{FEFF}').to_string();
    note(&dir, &format!("Downloaded {} ({} bytes)", name, bytes.len()));
    if text.len() > MAX_BYTES || !text.contains('<') {
        note(&dir, "Not used: the file is not an HTML page.");
        return Err("The safety focus file is not an HTML page.".to_string());
    }
    if std::fs::read_to_string(dir.join(CACHE)).ok().as_deref() == Some(text.as_str()) {
        note(&dir, "Unchanged since last time.");
        return Ok(None);
    }
    std::fs::write(dir.join(CACHE), &text).map_err(|e| e.to_string())?;
    note(&dir, "Saved: the new version shows now and on the next launches.");
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::download_link;

    #[test]
    fn adds_download_once() {
        assert_eq!(download_link("https://x.sharepoint.com/:u:/g/abc?e=1"), "https://x.sharepoint.com/:u:/g/abc?e=1&download=1");
        assert_eq!(download_link("https://x.sharepoint.com/:u:/g/abc"), "https://x.sharepoint.com/:u:/g/abc?download=1");
        assert_eq!(download_link("https://x/abc?download=1"), "https://x/abc?download=1");
    }
}
