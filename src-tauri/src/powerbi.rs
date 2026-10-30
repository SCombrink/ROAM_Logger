// Reads monthly observation counts from a Power BI report.
//
// There is no API access (the user has view-only rights, no Build permission),
// so we open the report in the shared, already signed-in Edge profile and
// capture the "querydata" responses Power BI fetches to draw its visuals.
// Those responses use Power BI's compressed DSR format, decoded below into
// plain tables. Which columns hold the observer, the date and the count is
// set in tauri.conf.json (plugins.config.observationReport) so a report
// redesign only needs a config change.

use headless_chrome::Browser;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::powerbi_dsr::{aggregate, base64_decode, decode_querydata, DecodedTable};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::{edge_profile_lock, kill_edge_by_profile, kill_process_tree};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportConfig {
    url: String,
    observer_column: Option<String>,
    date_column: Option<String>,
    count_column: Option<String>,
}

/// Counts per observer per month ("YYYY-MM").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationCounts {
    pub observers: BTreeMap<String, BTreeMap<String, f64>>,
    pub fetched_at: String,
    #[serde(default)]
    pub from_cache: bool,
    #[serde(default)]
    pub age_hours: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSummary {
    pub columns: Vec<String>,
    pub row_count: usize,
    pub sample_rows: Vec<Vec<Value>>,
}

// ---------------------------------------------------------------------------
// Capturing the report in Edge
// ---------------------------------------------------------------------------

fn edge_exe() -> std::path::PathBuf {
    let edge_default = std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    if edge_default.exists() { edge_default } else { std::path::PathBuf::from("msedge.exe") }
}

/// Opens the report in Edge and returns every table Power BI loaded.
/// Stops once responses have been quiet for a few seconds, or at the timeout.
fn capture_report_tables(
    user_data_dir: &std::path::Path,
    report_url: &str,
    headless: bool,
    timeout_secs: u64,
) -> Result<Vec<DecodedTable>, String> {
    kill_edge_by_profile(user_data_dir);
    thread::sleep(Duration::from_millis(500));
    for f in ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"] {
        let _ = std::fs::remove_file(user_data_dir.join(f));
    }
    let devtools_file = user_data_dir.join("DevToolsActivePort");

    let mut cmd = std::process::Command::new(edge_exe());
    cmd.arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-extensions")
        .arg("--disable-session-crashed-bubble")
        .arg("--no-restore-state-check")
        // A large window so Power BI lays out (and queries) every visual.
        .arg("--window-size=1600,1200")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", user_data_dir.display()));
    if headless {
        cmd.arg("--headless=new").arg("--disable-gpu").arg("--disable-dev-shm-usage");
    }
    let child = cmd.spawn().map_err(|e| format!("Failed to start Edge: {}", e))?;
    let edge_pid = child.id();
    let cleanup = || {
        kill_process_tree(edge_pid);
        kill_edge_by_profile(user_data_dir);
    };

    let mut ws_url = None;
    for _ in 0..30 {
        thread::sleep(Duration::from_millis(500));
        if let Ok(content) = std::fs::read_to_string(&devtools_file) {
            let lines: Vec<&str> = content.lines().collect();
            if lines.len() >= 2 {
                ws_url = Some(format!("ws://127.0.0.1:{}{}", lines[0].trim(), lines[1].trim()));
                break;
            }
        }
    }
    let Some(ws_url) = ws_url else {
        cleanup();
        return Err("Edge did not start in time".to_string());
    };

    let result = (|| -> Result<Vec<DecodedTable>, String> {
        let browser = Browser::connect(ws_url).map_err(|e| format!("Failed to connect to Edge: {}", e))?;
        let tab = browser.new_tab().map_err(|e| format!("Failed to open Edge tab: {}", e))?;

        // Headless Edge identifies itself as "HeadlessEdg", which Power BI may
        // refuse. Present the normal Edge user agent instead.
        if headless {
            if let Ok(ua) = tab.evaluate("navigator.userAgent", false) {
                if let Some(ua) = ua.value.and_then(|v| v.as_str().map(str::to_string)) {
                    let _ = tab.set_user_agent(&ua.replace("HeadlessEdg", "Edg").replace("Headless", ""), None, None);
                }
            }
        }

        let bodies: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let last_seen: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        {
            let bodies = bodies.clone();
            let last_seen = last_seen.clone();
            tab.register_response_handling(
                "powerbi-querydata",
                Box::new(move |params, fetch_body| {
                    let url = params.response.url.to_lowercase();
                    if !url.contains("querydata") {
                        return;
                    }
                    if let Ok(body) = fetch_body() {
                        let text = if body.base_64_encoded {
                            match base64_decode(&body.body) {
                                Some(t) => t,
                                None => return,
                            }
                        } else {
                            body.body
                        };
                        bodies.lock().unwrap().push(text);
                        *last_seen.lock().unwrap() = Some(Instant::now());
                    }
                }),
            )
            .map_err(|e| format!("Failed to watch network traffic: {}", e))?;
        }

        tab.call_method(headless_chrome::protocol::cdp::Page::Navigate {
            url: report_url.to_string(),
            referrer: None,
            transition_Type: None,
            frame_id: None,
            referrer_policy: None,
        })
        .map_err(|e| format!("Failed to open the report: {}", e))?;

        // Wait until visuals stop loading: 6s of quiet after the first result.
        let start = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(500));
            let quiet = last_seen.lock().unwrap().map(|t| t.elapsed() > Duration::from_secs(6)).unwrap_or(false);
            if quiet || start.elapsed() > Duration::from_secs(timeout_secs) {
                break;
            }
        }
        let _ = tab.deregister_response_handling_all();

        let tables: Vec<DecodedTable> = bodies.lock().unwrap().iter().flat_map(|b| decode_querydata(b)).collect();
        if tables.is_empty() {
            let url_now = tab.get_url();
            if url_now.contains("login.microsoftonline.com") {
                return Err("Power BI needs you to sign in".to_string());
            }
            return Err(format!("No report data was received within {} seconds", timeout_secs));
        }
        Ok(tables)
    })();

    cleanup();
    result
}

fn report_config(app_handle: &tauri::AppHandle) -> Result<ReportConfig, String> {
    let cfg = app_handle
        .config()
        .plugins
        .0
        .get("config")
        .and_then(|c| c.get("observationReport"))
        .cloned()
        .ok_or_else(|| "observationReport is not set in tauri.conf.json".to_string())?;
    let cfg: ReportConfig = serde_json::from_value(cfg).map_err(|e| format!("observationReport config is invalid: {}", e))?;
    if cfg.url.trim().is_empty() {
        return Err("observationReport.url is empty".to_string());
    }
    Ok(cfg)
}

fn paths(app_handle: &tauri::AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let app_data = app_handle.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let _ = std::fs::create_dir_all(&app_data);
    Ok((app_data.join("edge_profile"), app_data.join("observation-counts-cache.json")))
}

/// Captures the report and tries headless first, then (if allowed) a visible
/// window so the user can sign in.
async fn capture_with_fallback(app_handle: &tauri::AppHandle, url: &str, interactive: bool) -> Result<Vec<DecodedTable>, String> {
    let (user_data_dir, _) = paths(app_handle)?;
    let _profile_guard = edge_profile_lock().lock().await;
    let dir = user_data_dir.clone();
    let url_owned = url.to_string();
    let headless = tokio::task::spawn_blocking(move || capture_report_tables(&dir, &url_owned, true, 40))
        .await
        .map_err(|e| e.to_string())?;
    match headless {
        Ok(t) => Ok(t),
        Err(e) if !interactive => Err(e),
        Err(e) => {
            let _ = app_handle.emit("activation-debug", format!("Opening Power BI so you can sign in ({})", e));
            let url_owned = url.to_string();
            tokio::task::spawn_blocking(move || capture_report_tables(&user_data_dir, &url_owned, false, 120))
                .await
                .map_err(|e| e.to_string())?
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns the last saved counts without opening Power BI.
#[tauri::command]
pub async fn get_cached_observation_counts(app_handle: tauri::AppHandle) -> Result<Option<ObservationCounts>, String> {
    let (_, cache_path) = paths(&app_handle)?;
    let Ok(text) = std::fs::read_to_string(&cache_path) else { return Ok(None) };
    let Ok(mut counts) = serde_json::from_str::<ObservationCounts>(&text) else { return Ok(None) };
    counts.from_cache = true;
    counts.age_hours = std::fs::metadata(&cache_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs_f64() / 3600.0);
    Ok(Some(counts))
}

/// Opens the Power BI report, reads the observation counts and caches them.
/// `interactive` allows a visible Edge window if sign-in is needed.
#[tauri::command]
pub async fn fetch_observation_counts(app_handle: tauri::AppHandle, interactive: Option<bool>) -> Result<ObservationCounts, String> {
    let cfg = report_config(&app_handle)?;
    // Empty strings in the config mean "not set yet".
    let non_empty = |v: &Option<String>| v.clone().filter(|s| !s.trim().is_empty());
    let observer_col = non_empty(&cfg.observer_column).ok_or("observationReport.observerColumn is not set")?;
    let date_col = non_empty(&cfg.date_column).ok_or("observationReport.dateColumn is not set")?;
    let count_col = non_empty(&cfg.count_column);
    let tables = capture_with_fallback(&app_handle, &cfg.url, interactive.unwrap_or(false)).await?;
    let year = chrono::Local::now().format("%Y").to_string().parse::<i32>().unwrap_or(2026);
    let observers = aggregate(&tables, &observer_col, &date_col, count_col.as_deref(), year);
    if observers.is_empty() {
        return Err(format!(
            "The report loaded but no visual had columns matching \"{}\" and \"{}\". Use Inspect Power BI report in the debug menu to see the available columns.",
            observer_col, date_col
        ));
    }
    let counts = ObservationCounts {
        observers,
        fetched_at: chrono::Local::now().to_rfc3339(),
        from_cache: false,
        age_hours: Some(0.0),
    };
    let (_, cache_path) = paths(&app_handle)?;
    if let Ok(text) = serde_json::to_string(&counts) {
        let _ = std::fs::write(&cache_path, text);
    }
    Ok(counts)
}

/// Debug helper: opens the report in a visible window and returns a summary of
/// every table Power BI loaded (column names plus a few rows), also saved to
/// powerbi-inspect.json in the app data folder. Used once to find the right
/// column names for the config.
#[tauri::command]
pub async fn inspect_powerbi_report(app_handle: tauri::AppHandle) -> Result<Vec<TableSummary>, String> {
    let cfg = report_config(&app_handle)?;
    let (user_data_dir, _) = paths(&app_handle)?;
    let _profile_guard = edge_profile_lock().lock().await;
    let url = cfg.url.clone();
    let tables = tokio::task::spawn_blocking(move || capture_report_tables(&user_data_dir, &url, false, 120))
        .await
        .map_err(|e| e.to_string())??;
    let summaries: Vec<TableSummary> = tables
        .iter()
        .map(|t| TableSummary { columns: t.columns.clone(), row_count: t.rows.len(), sample_rows: t.rows.iter().take(5).cloned().collect() })
        .collect();
    if let Ok(app_data) = app_handle.path().app_data_dir() {
        if let Ok(text) = serde_json::to_string_pretty(&summaries) {
            let _ = std::fs::write(app_data.join("powerbi-inspect.json"), text);
        }
    }
    Ok(summaries)
}
