// Reads monthly observation counts from a Power BI report.
//
// There is no API access (the user has view-only rights, no Build permission),
// so we open the report in Edge, signed in as the user, and capture the
// "querydata" responses Power BI fetches to draw its visuals. Decoding and
// column detection live in powerbi_dsr.rs.
//
// How it stays out of the way:
// - Background reads run on a snapshot of the shared Edge profile (its
//   sign-in cookies copied to a separate folder), so they never hold the
//   profile lock that submissions and the project-list download need.
// - The report lists every employee, but Power BI only sends the first few
//   hundred rows of a large table, so the report is opened with a URL filter
//   for the user's name.
//
// Who the user is: read from the Power BI page's own access token (given and
// family name from Microsoft sign-in), with the Windows directory account as
// a fallback, turned into the report's "Last, First" form.

use headless_chrome::Browser;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::powerbi_dsr::{
    aggregate, base64_decode, decode_querydata, filter_any_of, filter_contains, name_candidates, names_in,
    observer_query_name, url_filter_field, with_filter, ColumnHints, DecodedTable,
};
use crate::{edge_profile_lock, kill_edge_by_profile, kill_process_tree};

/// Runs a process without flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportConfig {
    url: String,
    // All optional: anything left empty is detected from the report.
    observer_column: Option<String>,
    date_column: Option<String>,
    count_column: Option<String>,
    /// Power BI URL filter field ("Table/Column"), normally learned from the report.
    observer_filter: Option<String>,
}

/// Empty strings in the config mean "not set".
fn non_empty(v: &Option<String>) -> Option<String> {
    v.clone().filter(|s| !s.trim().is_empty())
}

impl ReportConfig {
    fn hints(&self) -> ColumnHints {
        ColumnHints {
            observer: non_empty(&self.observer_column),
            date: non_empty(&self.date_column),
            count: non_empty(&self.count_column),
        }
    }
}

/// What the app has learned about the report, saved between launches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LearnedSchema {
    filter_field: Option<String>,
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
    /// The report name matched to this user (chosen or auto-detected).
    #[serde(default)]
    pub observer: Option<String>,
}

/// The signed-in person, as Microsoft sign-in or Windows describes them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub given: Option<String>,
    pub family: Option<String>,
    pub display: Option<String>,
    pub email: Option<String>,
}

impl Identity {
    fn candidates(&self) -> Vec<String> {
        name_candidates(self.given.as_deref(), self.family.as_deref(), self.display.as_deref())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    pub url: String,
    pub identity: Option<Identity>,
    pub tables: Vec<TableSummary>,
    /// The first part of each raw response, to diagnose layouts the decoder
    /// does not understand yet.
    pub raw_samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSummary {
    pub columns: Vec<String>,
    pub measures: Vec<bool>,
    pub row_count: usize,
    pub sample_rows: Vec<Vec<Value>>,
}

// ---------------------------------------------------------------------------
// Capturing the report in Edge
// ---------------------------------------------------------------------------

struct Capture {
    bodies: Vec<String>,
    identity: Option<Identity>,
}

fn edge_exe() -> std::path::PathBuf {
    let edge_default = std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    if edge_default.exists() { edge_default } else { std::path::PathBuf::from("msedge.exe") }
}

/// Reads the signed-in user's name from the access token Power BI keeps on
/// its page (a JWT with given_name / family_name / name / upn claims).
const IDENTITY_JS: &str = r#"(() => { try {
  const t = window.powerBIAccessToken; if (!t) return "";
  const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0))));
  return JSON.stringify({ given: p.given_name || null, family: p.family_name || null, display: p.name || null, email: p.upn || p.unique_name || p.email || null });
} catch (e) { return ""; } })()"#;

/// Opens the report in Edge and returns every querydata response body, plus
/// the signed-in identity if the page exposes it. Stops once responses have
/// been quiet for a few seconds, or at the timeout.
fn capture_report(user_data_dir: &std::path::Path, report_url: &str, headless: bool, timeout_secs: u64) -> Result<Capture, String> {
    kill_edge_by_profile(user_data_dir);
    thread::sleep(Duration::from_millis(300));
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

    let result = (|| -> Result<Capture, String> {
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
                    if !params.response.url.to_lowercase().contains("querydata") {
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

        // Wait until visuals stop loading: 5s of quiet after the first result.
        let start = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(400));
            let quiet = last_seen.lock().unwrap().map(|t| t.elapsed() > Duration::from_secs(5)).unwrap_or(false);
            if quiet || start.elapsed() > Duration::from_secs(timeout_secs) {
                break;
            }
        }
        let _ = tab.deregister_response_handling_all();

        let identity = tab
            .evaluate(IDENTITY_JS, false)
            .ok()
            .and_then(|r| r.value)
            .and_then(|v| v.as_str().map(str::to_string))
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str::<Identity>(&s).ok());

        let bodies = bodies.lock().unwrap().clone();
        if bodies.is_empty() {
            if tab.get_url().contains("login.microsoftonline.com") {
                return Err("Power BI needs you to sign in".to_string());
            }
            return Err(format!("No report data was received within {} seconds", timeout_secs));
        }
        Ok(Capture { bodies, identity })
    })();

    cleanup();
    result
}

/// Copies the shared profile's sign-in (cookies and the key that encrypts
/// them) into a separate profile folder, so a background read can run
/// without holding the shared profile.
fn snapshot_profile(shared: &std::path::Path, snapshot: &std::path::Path) -> Result<(), String> {
    kill_edge_by_profile(snapshot);
    let cookies = shared.join("Default").join("Network").join("Cookies");
    if !cookies.exists() {
        return Err("No signed-in Edge profile to copy yet".to_string());
    }
    let net = snapshot.join("Default").join("Network");
    std::fs::create_dir_all(&net).map_err(|e| e.to_string())?;
    std::fs::copy(shared.join("Local State"), snapshot.join("Local State")).map_err(|e| format!("Copy Local State: {}", e))?;
    std::fs::copy(&cookies, net.join("Cookies")).map_err(|e| format!("Copy cookies: {}", e))?;
    let journal = shared.join("Default").join("Network").join("Cookies-journal");
    if journal.exists() {
        let _ = std::fs::copy(journal, net.join("Cookies-journal"));
    }
    Ok(())
}

struct Paths {
    shared_profile: std::path::PathBuf,
    snapshot_profile: std::path::PathBuf,
    cache: std::path::PathBuf,
    schema: std::path::PathBuf,
    app_data: std::path::PathBuf,
}

fn paths(app_handle: &tauri::AppHandle) -> Result<Paths, String> {
    let app_data = app_handle.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let _ = std::fs::create_dir_all(&app_data);
    Ok(Paths {
        shared_profile: app_data.join("edge_profile"),
        snapshot_profile: app_data.join("edge_profile_powerbi"),
        cache: app_data.join("observation-counts-cache.json"),
        schema: app_data.join("powerbi-schema.json"),
        app_data,
    })
}

/// Only one Power BI read at a time (startup check, refresh and search).
static POWERBI_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

/// Reads the report. Headless on a profile snapshot first (does not block
/// submissions); if that fails and the user asked for it, a visible window
/// on the shared profile so they can sign in.
async fn run_capture(app_handle: &tauri::AppHandle, url: &str, interactive: bool) -> Result<Capture, String> {
    let p = paths(app_handle)?;
    let _one_at_a_time = POWERBI_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;

    // Hold the shared profile only long enough to copy its cookies.
    let snapshot_ok = {
        let _profile_guard = edge_profile_lock().lock().await;
        snapshot_profile(&p.shared_profile, &p.snapshot_profile)
    };
    let headless = match snapshot_ok {
        Ok(()) => {
            let (dir, url) = (p.snapshot_profile.clone(), url.to_string());
            tokio::task::spawn_blocking(move || capture_report(&dir, &url, true, 40)).await.map_err(|e| e.to_string())?
        }
        Err(e) => Err(e),
    };
    match headless {
        Ok(c) => Ok(c),
        Err(e) if !interactive => Err(e),
        Err(e) => {
            let _ = app_handle.emit("activation-debug", format!("Opening Power BI so you can sign in ({})", e));
            let _profile_guard = edge_profile_lock().lock().await;
            let (dir, url) = (p.shared_profile.clone(), url.to_string());
            tokio::task::spawn_blocking(move || capture_report(&dir, &url, false, 120)).await.map_err(|e| e.to_string())?
        }
    }
}

/// The signed-in Windows user as the company directory describes them.
/// Returns None quickly off the company network or on non-domain machines.
fn windows_identity() -> Option<Identity> {
    let script = "Add-Type -AssemblyName System.DirectoryServices.AccountManagement; \
        $u = [System.DirectoryServices.AccountManagement.UserPrincipal]::Current; \
        [pscustomobject]@{ given = $u.GivenName; family = $u.Surname; display = $u.DisplayName; email = $u.EmailAddress } | ConvertTo-Json -Compress";
    let mut child = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(8) => thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    serde_json::from_slice::<Identity>(&output.stdout).ok()
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

fn load_schema(p: &Paths) -> LearnedSchema {
    std::fs::read_to_string(&p.schema).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Remembers the URL filter field once the observer column has been seen.
fn learn_schema(p: &Paths, tables: &[DecodedTable], hints: &ColumnHints, schema: &mut LearnedSchema) {
    if let Some(field) = observer_query_name(tables, hints.observer.as_deref()).and_then(|q| url_filter_field(&q)) {
        if schema.filter_field.as_deref() != Some(field.as_str()) {
            schema.filter_field = Some(field);
            if let Ok(t) = serde_json::to_string_pretty(schema) {
                let _ = std::fs::write(&p.schema, t);
            }
        }
    }
}

fn decode_all(capture: &Capture) -> Vec<DecodedTable> {
    capture.bodies.iter().flat_map(|b| decode_querydata(b)).collect()
}

/// The first candidate that appears in the report (case-insensitive).
fn match_name(observers: &BTreeMap<String, BTreeMap<String, f64>>, candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find_map(|c| observers.keys().find(|k| k.eq_ignore_ascii_case(c.trim())).cloned())
}

fn current_year() -> i32 {
    chrono::Local::now().format("%Y").to_string().parse::<i32>().unwrap_or(2026)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns the last saved counts without opening Power BI.
#[tauri::command]
pub async fn get_cached_observation_counts(app_handle: tauri::AppHandle) -> Result<Option<ObservationCounts>, String> {
    let p = paths(&app_handle)?;
    let Ok(text) = std::fs::read_to_string(&p.cache) else { return Ok(None) };
    let Ok(mut counts) = serde_json::from_str::<ObservationCounts>(&text) else { return Ok(None) };
    counts.from_cache = true;
    counts.age_hours = std::fs::metadata(&p.cache)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs_f64() / 3600.0);
    Ok(Some(counts))
}

/// Opens the Power BI report and reads observation counts.
/// - No `observer`: the signed-in user is detected, and the result is saved
///   as the user's own counts.
/// - With `observer`: that person's counts (the user's known name, or a
///   colleague being looked up). Saved only when `save` is true.
/// `interactive` allows a visible Edge window if sign-in is needed.
#[tauri::command]
pub async fn fetch_observation_counts(
    app_handle: tauri::AppHandle,
    interactive: Option<bool>,
    observer: Option<String>,
    save: Option<bool>,
) -> Result<ObservationCounts, String> {
    let cfg = report_config(&app_handle)?;
    let hints = cfg.hints();
    let p = paths(&app_handle)?;
    let mut schema = load_schema(&p);
    let interactive = interactive.unwrap_or(false);
    let year = current_year();

    let chosen = non_empty(&observer);
    // Candidate names: the user's choice, or else the Windows directory name
    // (cheap to look up before opening Power BI).
    let mut candidates: Vec<String> = match &chosen {
        Some(name) => vec![name.clone()],
        None => tokio::task::spawn_blocking(windows_identity).await.ok().flatten().map(|i| i.candidates()).unwrap_or_default(),
    };

    let filter_field = non_empty(&cfg.observer_filter).or_else(|| schema.filter_field.clone());
    let url_for = |field: &Option<String>, names: &[String]| match field {
        Some(f) if !names.is_empty() => with_filter(&cfg.url, &filter_any_of(f, names)),
        _ => cfg.url.clone(),
    };

    let first_url = url_for(&filter_field, &candidates);
    let capture = run_capture(&app_handle, &first_url, interactive).await?;
    let mut tables = decode_all(&capture);
    learn_schema(&p, &tables, &hints, &mut schema);
    let mut observers = aggregate(&tables, &hints, year);

    // Names from the Microsoft sign-in on the Power BI page itself.
    if chosen.is_none() {
        for c in capture.identity.as_ref().map(|i| i.candidates()).unwrap_or_default() {
            if !candidates.iter().any(|x| x.eq_ignore_ascii_case(&c)) {
                candidates.push(c);
            }
        }
    }
    let mut matched = match_name(&observers, &candidates);

    // Not found yet: open the report again, filtered to every candidate name,
    // now that the filter field and the sign-in names are known.
    if matched.is_none() && !candidates.is_empty() && schema.filter_field.is_some() {
        let second_url = url_for(&schema.filter_field, &candidates);
        if second_url != first_url {
            let capture = run_capture(&app_handle, &second_url, false).await?;
            tables = decode_all(&capture);
            observers = aggregate(&tables, &hints, year);
            matched = match_name(&observers, &candidates);
        }
    }

    if let Some(name) = &chosen {
        if matched.is_none() {
            return Err(format!(
                "No rows for \"{}\" in the report. Check the name is exactly as it appears in Power BI, for example \"Abbott, Ryan\".",
                name
            ));
        }
    }
    if observers.is_empty() {
        return Err("The report loaded but no observation counts were found in it. Use Inspect Power BI report in the debug menu to see what it contains.".to_string());
    }

    let counts = ObservationCounts {
        observers,
        fetched_at: chrono::Local::now().to_rfc3339(),
        from_cache: false,
        age_hours: Some(0.0),
        observer: matched,
    };
    if save.unwrap_or(true) {
        if let Ok(text) = serde_json::to_string(&counts) {
            let _ = std::fs::write(&p.cache, text);
        }
    }
    Ok(counts)
}

/// Searches every employee name in the report containing `query`
/// (case-insensitive), using a Power BI "contains" URL filter.
#[tauri::command]
pub async fn search_report_names(app_handle: tauri::AppHandle, query: String) -> Result<Vec<String>, String> {
    let query = query.trim().to_string();
    if query.chars().count() < 2 {
        return Err("Type at least 2 letters to search".to_string());
    }
    let cfg = report_config(&app_handle)?;
    let hints = cfg.hints();
    let p = paths(&app_handle)?;
    let mut schema = load_schema(&p);

    let mut field = non_empty(&cfg.observer_filter).or_else(|| schema.filter_field.clone());
    let mut names: Vec<String> = Vec::new();
    if field.is_none() {
        // First use: open the report once to learn which field holds names.
        let capture = run_capture(&app_handle, &cfg.url, true).await?;
        let tables = decode_all(&capture);
        learn_schema(&p, &tables, &hints, &mut schema);
        names = names_in(&tables, hints.observer.as_deref());
        field = schema.filter_field.clone();
    }
    if let Some(f) = field {
        let capture = run_capture(&app_handle, &with_filter(&cfg.url, &filter_contains(&f, &query)), true).await?;
        names = names_in(&decode_all(&capture), hints.observer.as_deref());
    }
    let q = query.to_lowercase();
    let mut found: Vec<String> = names.into_iter().filter(|n| n.to_lowercase().contains(&q)).collect();
    found.truncate(200);
    Ok(found)
}

/// Debug helper: opens the report in a visible window and returns a summary of
/// every table Power BI loaded (column names plus a few rows), the detected
/// sign-in identity, and the start of each raw response. Also saved to
/// powerbi-inspect.json in the app data folder.
#[tauri::command]
pub async fn inspect_powerbi_report(app_handle: tauri::AppHandle, observer: Option<String>) -> Result<InspectResult, String> {
    let cfg = report_config(&app_handle)?;
    let p = paths(&app_handle)?;
    let schema = load_schema(&p);
    let field = non_empty(&cfg.observer_filter).or(schema.filter_field);
    let url = match (field, non_empty(&observer)) {
        (Some(f), Some(name)) => with_filter(&cfg.url, &filter_any_of(&f, &[name])),
        _ => cfg.url.clone(),
    };
    let _one_at_a_time = POWERBI_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let _profile_guard = edge_profile_lock().lock().await;
    let (dir, url_owned) = (p.shared_profile.clone(), url.clone());
    let capture = tokio::task::spawn_blocking(move || capture_report(&dir, &url_owned, false, 120))
        .await
        .map_err(|e| e.to_string())??;
    let tables = decode_all(&capture);
    let result = InspectResult {
        url,
        identity: capture.identity.clone(),
        tables: tables
            .iter()
            .map(|t| TableSummary {
                columns: t.columns.clone(),
                measures: t.measures.clone(),
                row_count: t.rows.len(),
                sample_rows: t.rows.iter().take(5).cloned().collect(),
            })
            .collect(),
        raw_samples: capture.bodies.iter().take(8).map(|b| b.chars().take(6000).collect()).collect(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&result) {
        let _ = std::fs::write(p.app_data.join("powerbi-inspect.json"), text);
    }
    Ok(result)
}
