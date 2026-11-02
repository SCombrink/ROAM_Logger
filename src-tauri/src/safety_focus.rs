// The safety focus shown in the empty chat area: an HTML page the Health &
// Safety team keeps in a SharePoint file they edit themselves. Its sharing
// link is "safetyFocusUrl" (project data, or tauri.conf.json).
//
// The app shows the copy it saved last time straight away, then fetches the
// file in the background through the user's signed-in Edge session; if it
// changed, the new copy is saved and the screen cross-fades to it. The page
// is shown in a sandbox with no scripts, so it can only show content.

use serde_json::{json, Value};
use tauri::Manager;

use crate::crews::{link_setting, with_page, Ready};

const CACHE: &str = "safety-focus.html";
/// Larger than any sensible page; stops a wrong link filling the screen.
const MAX_BYTES: usize = 1_500_000;

/// The copy saved last time, if any.
#[tauri::command]
pub fn get_safety_focus(app_handle: tauri::AppHandle) -> Option<String> {
    let dir = app_handle.path().app_data_dir().ok()?;
    std::fs::read_to_string(dir.join(CACHE)).ok().filter(|t| !t.trim().is_empty())
}

/// Fetches the file and returns it if it differs from the saved copy
/// (None when unchanged, or when no link is set). Never opens a window.
#[tauri::command]
pub async fn refresh_safety_focus(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(link) = link_setting(&app_handle, "safetyFocusUrl") else { return Ok(None) };
    let origin = link.split('/').take(3).collect::<Vec<_>>().join("/") + "/";
    let fetch_link = link.clone();
    let text = with_page(&app_handle, origin, Ready::Site, false, false, move |s| {
        let get = || -> Result<Value, String> {
            s.run(
                "const u = new URL(A.link); u.searchParams.set('download', '1');
                 const r = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
                 const cd = r.headers.get('content-disposition') || '';
                 const text = await r.text();
                 return JSON.stringify({ status: r.status, file: r.ok && (/attachment/i.test(cd) || /download\\.aspx/i.test(r.url)), text });",
                json!({ "link": fetch_link }),
            )
        };
        let mut r = get()?;
        if r["file"].as_bool() != Some(true) {
            // The first time, the sharing link has to be opened to grant access.
            s.visit(&fetch_link, 6);
            r = get()?;
        }
        if r["file"].as_bool() != Some(true) {
            return Err(format!("The safety focus file could not be read (status {}). Check its link is shared with everyone in the company.", r["status"]));
        }
        Ok(r["text"].as_str().unwrap_or_default().to_string())
    })
    .await?;

    let text = text.trim_start_matches('\u{FEFF}').to_string();
    if text.len() > MAX_BYTES || !text.contains('<') {
        return Err("The safety focus file is not an HTML page.".to_string());
    }
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if std::fs::read_to_string(dir.join(CACHE)).ok().as_deref() == Some(text.as_str()) {
        return Ok(None);
    }
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(dir.join(CACHE), &text).map_err(|e| e.to_string())?;
    Ok(Some(text))
}
