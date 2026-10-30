// Reads monthly observation counts from a Power BI report.
//
// There is no API access (the user has view-only rights, no Build permission),
// so we open the report in Edge, signed in as the user, and capture the
// "querydata" responses Power BI fetches to draw its visuals. Decoding and
// column detection live in powerbi_dsr.rs.
//
// How it stays out of the way:
// - Background reads use the app's shared Edge profile under its lock, so
//   they never run at the same time as a submission or the project-list
//   download (a submission started meanwhile waits for the read to finish).
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
use crate::cdp_net::{is_data_url, NetCapture};
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
    /// Report page holding the observation counts, clicked after the report opens.
    page_name: Option<String>,
    /// "rolling12": the last 12 count columns are the last 12 months, the
    /// right-most being the current month (their column names are ignored).
    month_layout: Option<String>,
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
            rolling: match non_empty(&self.month_layout).as_deref() {
                Some("rolling12") => {
                    let now = chrono::Local::now();
                    let year = now.format("%Y").to_string().parse().unwrap_or(2026);
                    let month = now.format("%m").to_string().parse().unwrap_or(1);
                    Some((12, (year, month)))
                }
                _ => None,
            },
        }
    }
}

/// What the app has learned about the report, saved between launches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LearnedSchema {
    filter_field: Option<String>,
    /// Direct address of the observation page, learned after the first click,
    /// so later reads open it without switching pages.
    page_url: Option<String>,
}

impl LearnedSchema {
    fn save(&self, p: &Paths) {
        if let Ok(t) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(&p.schema, t);
        }
    }
}

/// Where to open the report, and which page to click (none once the page's
/// own address is known).
fn report_target(cfg: &ReportConfig, schema: &LearnedSchema) -> (String, Option<String>) {
    match &schema.page_url {
        Some(url) => {
            // Keep the original query string (e.g. experience=power-bi).
            let query = cfg.url.split_once('?').map(|(_, q)| format!("?{}", q)).unwrap_or_default();
            (format!("{}{}", url, query), None)
        }
        None => (cfg.url.clone(), non_empty(&cfg.page_name)),
    }
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
    /// What happened, step by step.
    pub log: Vec<String>,
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
    /// Tables read straight from the page (fallback when no data responses).
    page_tables: Vec<DecodedTable>,
    identity: Option<Identity>,
    /// Address after switching to the observation page (saved for next time).
    page_url: Option<String>,
    /// Step-by-step notes, shown by Inspect when something goes wrong.
    log: Vec<String>,
}

impl Capture {
    fn summary(&self) -> String {
        self.log.iter().rev().take(4).rev().cloned().collect::<Vec<_>>().join(" | ")
    }
}

fn edge_exe() -> std::path::PathBuf {
    let edge_default = std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    if edge_default.exists() { edge_default } else { std::path::PathBuf::from("msedge.exe") }
}

/// Installed in the page before Power BI loads: keeps a copy of every
/// querydata response Power BI fetches (fetch or XHR). A second capture path
/// next to the DevTools network events, in case those miss the traffic.
const HOOK_JS: &str = r#"(() => { if (window.__roamQD) return; window.__roamQD = [];
  const isQD = u => { try { return /querydata|executequeries|queryexecutionservice|\/public\/query(\?|$)/i.test(String(u)); } catch (e) { return false; } };
  const keep = t => { try { if (typeof t === 'string' && t) window.__roamQD.push(t); } catch (e) {} };
  const f = window.fetch;
  if (f) window.fetch = function (...a) {
    const u = a[0] && a[0].url ? a[0].url : a[0];
    return f.apply(this, a).then(r => { if (isQD(u)) { try { r.clone().text().then(keep); } catch (e) {} } return r; });
  };
  const o = XMLHttpRequest.prototype.open, s = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__roamUrl = u; return o.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (isQD(this.__roamUrl)) this.addEventListener('load', () => { try {
      keep(this.responseType === 'json' ? JSON.stringify(this.response) : (this.responseType === '' || this.responseType === 'text') ? this.responseText : '');
    } catch (e) {} });
    return s.apply(this, arguments);
  };
})();"#;

/// Documents to search: the page itself and any same-origin frames.
const DOCS_JS: &str = r#"const docs = [document]; for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }"#;

/// Lists the names in the report's Pages pane (for the log).
const PAGE_LABELS_JS: &str = r#"(() => { try {
  const docs = [document]; for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }
  const names = new Set();
  for (const d of docs) for (const e of d.querySelectorAll('[role="tab"],[role="treeitem"],[role="listitem"],[role="option"]')) {
    const t = (e.innerText || e.getAttribute('aria-label') || '').trim(); if (t && t.length < 80) names.add(t);
  }
  return [...names].slice(0, 15).join(' | ') + ' (frames: ' + (docs.length - 1) + ')';
} catch (e) { return 'error: ' + e.message; } })()"#;

/// Clicks a report page by its name in the Pages pane (also inside frames).
/// Returns "clicked", "not-found", or "error: ...".
fn page_click_js(page_name: &str) -> String {
    format!(
        r#"((name) => {{ try {{
  const want = name.trim().toLowerCase();
  {docs}
  const els = docs.flatMap(d => [...d.querySelectorAll('[role="tab"],[role="treeitem"],[role="listitem"],[role="option"],[role="menuitem"],button,a,li,span,div')]);
  const label = e => ((e.innerText || '').trim() || (e.getAttribute('aria-label') || '').trim()).toLowerCase();
  const hits = els.filter(e => label(e) === want);
  if (!hits.length) return 'not-found';
  hits.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  const el = hits[0];
  const target = el.closest('[role="tab"],[role="treeitem"],[role="listitem"],[role="option"],[role="menuitem"],button,a') || el;
  target.scrollIntoView({{ block: 'center' }});
  target.click();
  return 'clicked';
}} catch (e) {{ return 'error: ' + e.message; }} }})({name})"#,
        docs = DOCS_JS,
        name = serde_json::to_string(page_name).unwrap_or_else(|_| "\"\"".into())
    )
}

/// Finds the signed-in user's name in the page: Power BI's access token, or
/// the Microsoft sign-in (MSAL) tokens and account records Power BI keeps in
/// browser storage. Returns JSON or "".
const IDENTITY_JS: &str = r#"(() => { const out = {};
  // Power BI's header: the profile button is labelled "Account manager for Surname, Name".
  try { for (const e of document.querySelectorAll('[aria-label*="Account manager for" i],[title*="Account manager for" i]')) {
    const t = (e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/^.*Account manager for\s*/i, '').replace(/^["“]|["”]$/g, '').trim();
    if (t) return JSON.stringify({ display: t, found: true }); } } catch (e) {}
  const dec = s => { try { const b = s.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)))); } catch (e) { return null; } };
  const take = p => { if (!p || out.found) return;
    const email = p.upn || p.preferred_username || p.unique_name || p.email || p.username || null;
    if (p.given_name || p.family_name || (p.name && email)) Object.assign(out, { given: p.given_name || null, family: p.family_name || null, display: p.name || null, email, found: true }); };
  try { if (window.powerBIAccessToken) take(dec(window.powerBIAccessToken)); } catch (e) {}
  for (const st of [window.sessionStorage, window.localStorage]) { try {
    for (let i = 0; i < st.length && !out.found; i++) { const v = st.getItem(st.key(i)) || '';
      for (const m of v.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/g) || []) take(dec(m));
      try { const j = JSON.parse(v); if (j && typeof j === 'object') { take(j.idTokenClaims); if (j.name && j.username) take({ name: j.name, upn: j.username }); } } catch (e) {}
    } } catch (e) {} }
  return out.found ? JSON.stringify(out) : ''; })()"#;

/// Reads the table/matrix visuals on the page as text: header names and the
/// rows currently rendered. Power BI marks them up as accessible grids.
const GRIDS_JS: &str = r#"(() => { try {
  const out = [];
  for (const g of [...document.querySelectorAll('[role="grid"],[role="treegrid"],[role="table"]')].slice(0, 6)) {
    const rows = [...g.querySelectorAll('[role="row"]')];
    const cells = r => [...r.querySelectorAll('[role="columnheader"],[role="rowheader"],[role="gridcell"],[role="cell"]')].map(c => (c.innerText || c.getAttribute('aria-label') || '').trim());
    const header = rows.find(r => r.querySelector('[role="columnheader"]'));
    const columns = header ? cells(header) : [];
    const body = rows.filter(r => r !== header && r.querySelector('[role="gridcell"],[role="cell"],[role="rowheader"]')).slice(0, 200).map(cells);
    if (columns.length || body.length) out.push({ columns, rows: body });
  }
  return JSON.stringify(out);
} catch (e) { return '[]'; } })()"#;

fn page_grids(tab: &headless_chrome::Tab) -> Vec<DecodedTable> {
    #[derive(Deserialize)]
    struct Grid {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    }
    let grids: Vec<Grid> = eval_string(tab, GRIDS_JS).and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    grids
        .into_iter()
        .map(|g| {
            let width = g.columns.len().max(g.rows.iter().map(|r| r.len()).max().unwrap_or(0));
            let mut columns = g.columns;
            while columns.len() < width {
                columns.push(format!("Column {}", columns.len() + 1));
            }
            DecodedTable {
                measures: vec![false; columns.len()],
                columns,
                rows: g.rows.into_iter().map(|r| r.into_iter().map(Value::from).collect()).collect(),
            }
        })
        .collect()
}

fn eval_string(tab: &headless_chrome::Tab, js: &str) -> Option<String> {
    tab.evaluate(js, false).ok().and_then(|r| r.value).and_then(|v| v.as_str().map(str::to_string))
}

/// Opens the report in Edge, switches to `page_name` if given, and returns
/// every querydata response body, the signed-in identity if the page exposes
/// it, and a log of each step. Only fails if Edge itself cannot be driven;
/// an empty result means the report loaded but no data was seen.
fn capture_report(
    user_data_dir: &std::path::Path,
    report_url: &str,
    page_name: Option<&str>,
    headless: bool,
    timeout_secs: u64,
) -> Result<Capture, String> {
    let started = Instant::now();
    let mut log: Vec<String> = Vec::new();
    // Each step is also written straight to powerbi-log.txt in the app data
    // folder, so there is something to look at even if a read never finishes.
    let log_file = user_data_dir.parent().map(|d| d.join("powerbi-log.txt"));
    if let Some(f) = &log_file {
        let _ = std::fs::write(f, format!("Power BI read started {}\nReport: {}\n", chrono::Local::now().to_rfc3339(), report_url));
    }
    let note = |log: &mut Vec<String>, msg: String| {
        let line = format!("{:>5.1}s {}", started.elapsed().as_secs_f32(), msg);
        if let Some(f) = &log_file {
            if let Ok(mut fh) = std::fs::OpenOptions::new().append(true).create(true).open(f) {
                use std::io::Write;
                let _ = writeln!(fh, "{}", line);
            }
        }
        log.push(line);
    };

    kill_edge_by_profile(user_data_dir);
    mark_clean_exit(user_data_dir);
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
        .arg("--hide-crash-restore-bubble")
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
        // Edge is closed forcefully; stop it offering to "restore pages" next time.
        thread::sleep(Duration::from_millis(500));
        mark_clean_exit(user_data_dir);
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
        note(&mut log, "Edge did not start in time".to_string());
        cleanup();
        return Err("Edge did not start in time".to_string());
    };
    note(&mut log, format!("Edge started ({})", if headless { "hidden" } else { "visible" }));

    let result = (|| -> Result<Capture, String> {
        let browser = Browser::connect(ws_url.clone()).map_err(|e| format!("Failed to connect to Edge: {}", e))?;
        let tab = browser.new_tab().map_err(|e| format!("Failed to open Edge tab: {}", e))?;

        // Watches the tab and its background workers (Power BI fetches its
        // data from a worker, which the tab-level events below do not see).
        let host = ws_url.trim_start_matches("ws://").split('/').next().unwrap_or("").to_string();
        let net = match NetCapture::start(&format!("ws://{}/devtools/page/{}", host, tab.get_target_id())) {
            Ok(n) => Some(n),
            Err(e) => {
                note(&mut log, format!("Worker network watcher not started: {}", e));
                None
            }
        };

        // Headless Edge identifies itself as "HeadlessEdg", which Power BI may
        // refuse. Present the normal Edge user agent instead.
        if headless {
            if let Some(ua) = eval_string(&tab, "navigator.userAgent") {
                let _ = tab.set_user_agent(&ua.replace("HeadlessEdg", "Edg").replace("Headless", ""), None, None);
            }
        }

        let _ = tab.call_method(headless_chrome::protocol::cdp::Page::AddScriptToEvaluateOnNewDocument {
            source: HOOK_JS.to_string(),
            world_name: None,
            include_command_line_api: None,
            run_immediately: None,
        });

        let bodies: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let bodies = bodies.clone();
            tab.register_response_handling(
                "powerbi-querydata",
                Box::new(move |params, fetch_body| {
                    if !is_data_url(&params.response.url) {
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
        note(&mut log, "Opening the report".to_string());

        // Responses seen so far: (DevTools network events, in-page hook).
        let counts = |tab: &headless_chrome::Tab| -> (usize, usize) {
            let hooked = eval_string(tab, "String((window.__roamQD || []).length)").and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
            let workers = net.as_ref().map(|n| n.body_count()).unwrap_or(0);
            (bodies.lock().unwrap().len() + workers, hooked)
        };
        let seen = |tab: &headless_chrome::Tab| -> usize { let (a, b) = counts(tab); a + b };
        // Waits until data has arrived and then gone quiet for `quiet` seconds.
        let wait_for_data = |tab: &headless_chrome::Tab, limit: Duration, quiet: Duration| -> usize {
            let start = Instant::now();
            let (mut last, mut last_change) = (seen(tab), Instant::now());
            while start.elapsed() < limit {
                thread::sleep(Duration::from_millis(500));
                let n = seen(tab);
                if n != last {
                    last = n;
                    last_change = Instant::now();
                } else if n > 0 && last_change.elapsed() >= quiet {
                    break;
                }
            }
            last
        };

        let total = Duration::from_secs(timeout_secs);
        let mut page_url = None;
        match page_name.filter(|n| !n.trim().is_empty()) {
            Some(name) => {
                // Click the page as soon as it shows up in the Pages list,
                // rather than waiting for the first page's data.
                let start = Instant::now();
                let mut outcome = String::from("not-found");
                let mut last_report = Instant::now() - Duration::from_secs(60);
                while start.elapsed() < total / 2 {
                    if tab.get_url().contains("login.microsoftonline.com") {
                        outcome = "sign-in page shown".into();
                        if headless {
                            break;
                        }
                    } else {
                        outcome = eval_string(&tab, &page_click_js(name)).unwrap_or_else(|| "error: no result".into());
                        if outcome.starts_with("clicked") {
                            break;
                        }
                    }
                    if last_report.elapsed() > Duration::from_secs(10) {
                        last_report = Instant::now();
                        let (net, hook) = counts(&tab);
                        let labels = eval_string(&tab, PAGE_LABELS_JS).unwrap_or_default();
                        note(&mut log, format!("Waiting for page \"{}\" ({}). Data so far: {} network / {} in-page. Title \"{}\". Page names visible: {}",
                            name, outcome, net, hook, tab.get_title().unwrap_or_default(), labels));
                    }
                    thread::sleep(Duration::from_secs(1));
                }
                let before_url = tab.get_url();
                note(&mut log, format!("Switching to page \"{}\": {}", name, outcome));
                if outcome.starts_with("clicked") {
                    // Keep only the data for the page we want.
                    bodies.lock().unwrap().clear();
                    if let Some(n) = &net {
                        n.clear_bodies();
                    }
                    let _ = eval_string(&tab, "(window.__roamQD = [], '')");
                    let n = wait_for_data(&tab, total / 2, Duration::from_secs(5));
                    let url = tab.get_url();
                    let (net, hook) = counts(&tab);
                    note(&mut log, format!("Page loaded: {} data responses ({} network / {} in-page). Address {}", n, net, hook,
                        if url != before_url { "changed" } else { "did not change" }));
                    if url != before_url && url.contains("/reports/") {
                        page_url = Some(url.split('?').next().unwrap_or(&url).to_string());
                    }
                }
            }
            None => {
                let n = wait_for_data(&tab, total, Duration::from_secs(5));
                note(&mut log, format!("Report loaded: {} data responses", n));
            }
        }

        let identity = eval_string(&tab, IDENTITY_JS).filter(|s| !s.is_empty()).and_then(|s| serde_json::from_str::<Identity>(&s).ok());
        note(&mut log, match &identity {
            Some(i) => format!("Signed in as: {} / {} {}", i.display.clone().unwrap_or_default(), i.given.clone().unwrap_or_default(), i.family.clone().unwrap_or_default()),
            None => "Could not read the signed-in name from the page".to_string(),
        });

        // A last look at the page itself: the visible tables, as text.
        let page_tables = page_grids(&tab);
        note(&mut log, format!("Tables visible on the page: {}", page_tables.iter().map(|t| format!("{} columns x {} rows", t.columns.len(), t.rows.len())).collect::<Vec<_>>().join(", ")));

        // Every capture path, without duplicates.
        let mut all: Vec<String> = bodies.lock().unwrap().clone();
        if let Some(n) = net {
            let r = n.finish();
            note(&mut log, format!("Network watcher attached to: {}", r.targets.join(", ")));
            if let Some(e) = r.error {
                note(&mut log, format!("Network watcher: {}", e));
            }
            note(&mut log, format!("Requests seen (top): {}", r.request_summary.iter().take(15).cloned().collect::<Vec<_>>().join("; ")));
            for b in r.bodies {
                if !all.contains(&b) {
                    all.push(b);
                }
            }
        }
        let hooked: Vec<String> = eval_string(&tab, "JSON.stringify(window.__roamQD || [])")
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        for h in hooked {
            if !all.contains(&h) {
                all.push(h);
            }
        }
        note(&mut log, format!("Collected {} data responses", all.len()));
        Ok(Capture { bodies: all, page_tables, identity, page_url, log: log.clone() })
    })();

    cleanup();
    result
}

/// Marks the Edge profile as cleanly closed, so Edge does not offer to
/// "restore pages" after being shut down by the app.
fn mark_clean_exit(user_data_dir: &std::path::Path) {
    let prefs_path = user_data_dir.join("Default").join("Preferences");
    let Ok(text) = std::fs::read_to_string(&prefs_path) else { return };
    let Ok(mut prefs) = serde_json::from_str::<Value>(&text) else { return };
    if let Some(profile) = prefs.get_mut("profile").and_then(|p| p.as_object_mut()) {
        profile.insert("exit_type".into(), Value::from("Normal"));
        profile.insert("exited_cleanly".into(), Value::from(true));
        if let Ok(out) = serde_json::to_string(&prefs) {
            let _ = std::fs::write(&prefs_path, out);
        }
    }
}

struct Paths {
    shared_profile: std::path::PathBuf,
    /// Left by an earlier test build that copied the sign-in; deleted on sight.
    old_snapshot_profile: std::path::PathBuf,
    cache: std::path::PathBuf,
    schema: std::path::PathBuf,
    app_data: std::path::PathBuf,
}

fn paths(app_handle: &tauri::AppHandle) -> Result<Paths, String> {
    let app_data = app_handle.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let _ = std::fs::create_dir_all(&app_data);
    Ok(Paths {
        shared_profile: app_data.join("edge_profile"),
        old_snapshot_profile: app_data.join("edge_profile_powerbi"),
        cache: app_data.join("observation-counts-cache.json"),
        schema: app_data.join("powerbi-schema.json"),
        app_data,
    })
}

/// Only one Power BI read at a time (startup check, refresh and search).
static POWERBI_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

/// Reads the report: headless first, then (if the user asked for it) a
/// visible window so they can sign in. Both use the app's shared Edge
/// profile under its lock, waiting their turn like the project-list
/// download and submissions do. (Copying the profile's sign-in to read in
/// parallel was tried and removed: antivirus treats copying browser
/// cookies as credential theft.)
async fn run_capture(app_handle: &tauri::AppHandle, url: &str, page: Option<String>, interactive: bool) -> Result<Capture, String> {
    let p = paths(app_handle)?;
    let _one_at_a_time = POWERBI_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    if p.old_snapshot_profile.exists() {
        kill_edge_by_profile(&p.old_snapshot_profile);
        let _ = std::fs::remove_dir_all(&p.old_snapshot_profile);
    }

    // An empty capture counts as a failure here, so a visible retry can follow.
    let non_empty_capture = |c: Capture| if c.bodies.is_empty() && c.page_tables.is_empty() { Err(format!("No report data was found. {}", c.summary())) } else { Ok(c) };
    let headless = {
        let _profile_guard = edge_profile_lock().lock().await;
        let (dir, url, page) = (p.shared_profile.clone(), url.to_string(), page.clone());
        tokio::task::spawn_blocking(move || capture_report(&dir, &url, page.as_deref(), true, 60))
            .await
            .map_err(|e| e.to_string())?
            .and_then(non_empty_capture)
    };
    match headless {
        Ok(c) => Ok(c),
        Err(e) if !interactive => Err(e),
        Err(e) => {
            let _ = app_handle.emit("activation-debug", format!("Opening Power BI so you can sign in ({})", e));
            let _profile_guard = edge_profile_lock().lock().await;
            let (dir, url) = (p.shared_profile.clone(), url.to_string());
            tokio::task::spawn_blocking(move || capture_report(&dir, &url, page.as_deref(), false, 120))
                .await
                .map_err(|e| e.to_string())?
                .and_then(non_empty_capture)
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
/// Remembers the URL filter field once the observer column has been seen, and
/// the observation page's address once it has been reached and had data.
fn learn_schema(p: &Paths, capture: &Capture, tables: &[DecodedTable], hints: &ColumnHints, schema: &mut LearnedSchema) {
    let mut changed = false;
    if let Some(field) = observer_query_name(tables, hints.observer.as_deref()).and_then(|q| url_filter_field(&q)) {
        if schema.filter_field.as_deref() != Some(field.as_str()) {
            schema.filter_field = Some(field);
            changed = true;
        }
    }
    if let Some(url) = &capture.page_url {
        if !tables.is_empty() && schema.page_url.as_deref() != Some(url.as_str()) {
            schema.page_url = Some(url.clone());
            changed = true;
        }
    }
    if changed {
        schema.save(p);
    }
}

/// Tables from Power BI's data responses, or, if none arrived, the tables
/// read from the page itself.
fn decode_all(capture: &Capture) -> Vec<DecodedTable> {
    let decoded: Vec<DecodedTable> = capture.bodies.iter().flat_map(|b| decode_querydata(b)).collect();
    if decoded.is_empty() { capture.page_tables.clone() } else { decoded }
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
    let (base, page) = report_target(&cfg, &schema);
    let url_for = |base: &str, field: &Option<String>, names: &[String]| match field {
        Some(f) if !names.is_empty() => with_filter(base, &filter_any_of(f, names)),
        _ => base.to_string(),
    };

    let first_url = url_for(&base, &filter_field, &candidates);
    let capture = run_capture(&app_handle, &first_url, page, interactive).await?;
    let mut tables = decode_all(&capture);
    learn_schema(&p, &capture, &tables, &hints, &mut schema);
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
        let (base, page) = report_target(&cfg, &schema);
        let second_url = url_for(&base, &schema.filter_field, &candidates);
        if second_url != first_url {
            let capture = run_capture(&app_handle, &second_url, page, false).await?;
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
        return Err(format!(
            "The report loaded but no observation counts were found in it ({}). Use Inspect Power BI report in the debug menu to see what it contains.",
            capture.summary()
        ));
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
        let (base, page) = report_target(&cfg, &schema);
        let capture = run_capture(&app_handle, &base, page, true).await?;
        let tables = decode_all(&capture);
        learn_schema(&p, &capture, &tables, &hints, &mut schema);
        names = names_in(&tables, hints.observer.as_deref());
        field = schema.filter_field.clone();
    }
    if let Some(f) = field {
        let (base, page) = report_target(&cfg, &schema);
        let capture = run_capture(&app_handle, &with_filter(&base, &filter_contains(&f, &query)), page, true).await?;
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
    let mut schema = load_schema(&p);
    let field = non_empty(&cfg.observer_filter).or(schema.filter_field.clone());
    let (base, page) = report_target(&cfg, &schema);
    let url = match (field, non_empty(&observer)) {
        (Some(f), Some(name)) => with_filter(&base, &filter_any_of(&f, &[name])),
        _ => base.clone(),
    };
    let _one_at_a_time = POWERBI_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let _profile_guard = edge_profile_lock().lock().await;
    let (dir, url_owned) = (p.shared_profile.clone(), url.clone());
    let capture = tokio::task::spawn_blocking(move || capture_report(&dir, &url_owned, page.as_deref(), false, 120))
        .await
        .map_err(|e| e.to_string())??;
    let tables = decode_all(&capture);
    learn_schema(&p, &capture, &tables, &cfg.hints(), &mut schema);
    let result = InspectResult {
        url,
        log: capture.log.clone(),
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
