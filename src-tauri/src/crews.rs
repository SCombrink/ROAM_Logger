// Shared crews, kept as one JSON file per crew in a SharePoint folder that
// everyone in the company can open through a sharing link.
//
// There is no API access, so (like the project list and the observation
// report) the app opens the folder link in Edge, signed in as the user, and
// reads and saves the crew files with SharePoint's own REST calls from that
// page. Everyone reads; only a crew's admins save (enforced by the app, see
// crew_model.rs). Saves use the file's version tag, so two admins changing a
// crew at the same moment do not overwrite each other: the second change is
// re-applied on top of the first.
//
// The folder link comes from the project data ("crewsFolderUrl"), so it can
// be set or moved without a new release; tauri.conf.json can also set it.

use headless_chrome::{Browser, Tab};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::crew_model::{apply_change, file_name, new_code, new_crew, parse_code, Actor, Crew, CrewChange, NewMember};
use crate::powerbi::{edge_exe, mark_clean_exit};
use crate::{edge_profile_lock, kill_edge_by_profile, kill_process_tree};

/// The folder's site and server-relative path, once the link has opened.
const FOLDER_JS: &str = r#"(() => { try {
  if (!/\.sharepoint\.com$/i.test(location.hostname)) return '';
  const u = new URL(location.href);
  let id = u.searchParams.get('id') || u.searchParams.get('RootFolder') || '';
  if (!id) { const p = decodeURIComponent(u.pathname); if (/^\/(personal|sites|teams)\/[^/]+\/.+/i.test(p) && !/\/(_layouts|Forms)\//i.test(p)) id = p; }
  const parts = id.split('/');
  if (!id || !/^(personal|sites|teams)$/i.test(parts[1] || '')) return '';
  return JSON.stringify({ web: location.origin + parts.slice(0, 3).join('/'), folder: id.replace(/\/$/, '') });
} catch (e) { return ''; } })()"#;

/// SharePoint REST helpers used by every operation below.
const PRELUDE: &str = r#"
const H = { 'Accept': 'application/json;odata=nometadata' };
const enc = s => encodeURIComponent(s.replace(/'/g, "''"));
const fileApi = (web, path) => `${web}/_api/web/GetFileByServerRelativePath(decodedurl='${enc(path)}')`;
const folderApi = (web, path) => `${web}/_api/web/GetFolderByServerRelativePath(decodedurl='${enc(path)}')`;
const notFound = (status, body) => status === 404 || /FileNotFound|does not exist|-2147024894/i.test(body || '');
async function digest(web) {
  const r = await fetch(`${web}/_api/contextinfo`, { method: 'POST', headers: H, credentials: 'include' });
  if (!r.ok) throw new Error('contextinfo ' + r.status);
  return (await r.json()).FormDigestValue;
}
async function failure(r) { const body = (await r.text()).slice(0, 300); return { status: r.status, error: body, missing: notFound(r.status, body) }; }
async function readFile(web, path) {
  const p = await fetch(fileApi(web, path) + '?$select=ETag', { headers: H, credentials: 'include', cache: 'no-store' });
  if (!p.ok) return await failure(p);
  const etag = (await p.json()).ETag;
  const c = await fetch(fileApi(web, path) + '/$value', { credentials: 'include', cache: 'no-store' });
  if (!c.ok) return await failure(c);
  return { etag, text: await c.text() };
}
"#;

struct Session {
    pid: u32,
    dir: std::path::PathBuf,
    _browser: Browser,
    tab: Arc<Tab>,
    web: String,
    folder: String,
    log: std::path::PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        kill_process_tree(self.pid);
        kill_edge_by_profile(&self.dir);
        thread::sleep(Duration::from_millis(400));
        mark_clean_exit(&self.dir);
    }
}

enum OpenError {
    SignIn,
    Other(String),
}

fn note(log: &std::path::Path, msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(log) {
        use std::io::Write;
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%H:%M:%S"), msg);
    }
}

impl Session {
    /// Opens the folder link in Edge with the app's shared profile and waits
    /// until SharePoint shows the folder.
    fn open(dir: &std::path::Path, link: &str, headless: bool, timeout_secs: u64) -> Result<Session, OpenError> {
        let log = dir.parent().unwrap_or(dir).join("crews-log.txt");
        note(&log, &format!("Opening crews folder ({})", if headless { "hidden" } else { "visible" }));
        kill_edge_by_profile(dir);
        mark_clean_exit(dir);
        thread::sleep(Duration::from_millis(300));
        for f in ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"] {
            let _ = std::fs::remove_file(dir.join(f));
        }
        let mut cmd = std::process::Command::new(edge_exe());
        cmd.arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-extensions")
            .arg("--hide-crash-restore-bubble")
            .arg("--window-size=1100,800")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", dir.display()));
        if headless {
            cmd.arg("--headless=new").arg("--disable-gpu");
        }
        let pid = cmd.spawn().map_err(|e| OpenError::Other(format!("Failed to start Edge: {}", e)))?.id();
        let kill = || {
            kill_process_tree(pid);
            kill_edge_by_profile(dir);
            thread::sleep(Duration::from_millis(400));
            mark_clean_exit(dir);
        };

        let mut ws_url = None;
        for _ in 0..30 {
            thread::sleep(Duration::from_millis(500));
            if let Ok(content) = std::fs::read_to_string(dir.join("DevToolsActivePort")) {
                let lines: Vec<&str> = content.lines().collect();
                if lines.len() >= 2 {
                    ws_url = Some(format!("ws://127.0.0.1:{}{}", lines[0].trim(), lines[1].trim()));
                    break;
                }
            }
        }
        let Some(ws_url) = ws_url else {
            kill();
            return Err(OpenError::Other("Edge did not start in time".to_string()));
        };
        let opened = (|| -> Result<(Browser, Arc<Tab>), String> {
            let browser = Browser::connect(ws_url).map_err(|e| format!("Failed to connect to Edge: {}", e))?;
            let tab = browser.new_tab().map_err(|e| format!("Failed to open Edge tab: {}", e))?;
            tab.navigate_to(link).map_err(|e| format!("Failed to open the crews folder: {}", e))?;
            Ok((browser, tab))
        })();
        let (browser, tab) = match opened {
            Ok(v) => v,
            Err(e) => {
                kill();
                return Err(OpenError::Other(e));
            }
        };

        let started = Instant::now();
        let mut signing_in = false;
        while started.elapsed() < Duration::from_secs(timeout_secs) {
            thread::sleep(Duration::from_millis(700));
            let url = tab.get_url();
            if url.contains("login.microsoftonline.com") || url.contains("login.live.com") {
                if headless {
                    note(&log, "Sign-in page shown");
                    drop((browser, tab));
                    kill();
                    return Err(OpenError::SignIn);
                }
                signing_in = true;
                continue;
            }
            let found = tab.evaluate(FOLDER_JS, false).ok().and_then(|r| r.value).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            if let Ok(info) = serde_json::from_str::<Value>(&found) {
                let web = info["web"].as_str().unwrap_or_default().to_string();
                let folder = info["folder"].as_str().unwrap_or_default().to_string();
                note(&log, &format!("Folder: {} (site {}){}", folder, web, if signing_in { " after sign-in" } else { "" }));
                return Ok(Session { pid, dir: dir.to_path_buf(), _browser: browser, tab, web, folder, log });
            }
        }
        note(&log, &format!("Folder not found; last page: {}", tab.get_url()));
        drop((browser, tab));
        kill();
        Err(OpenError::Other("The crews folder did not open. Check the crews folder link is shared with everyone in the company.".to_string()))
    }

    /// Runs one REST operation in the page and returns its JSON result.
    fn run(&self, body: &str, args: Value) -> Result<Value, String> {
        let js = format!(
            "(async () => {{ {} const A = {}; const WEB = {}; const FOLDER = {}; try {{ {} }} catch (e) {{ return JSON.stringify({{ error: String(e) }}); }} }})()",
            PRELUDE,
            args,
            json!(self.web),
            json!(self.folder),
            body
        );
        let result = self.tab.evaluate(&js, true).map_err(|e| format!("SharePoint did not answer: {}", e))?;
        let text = result.value.and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        serde_json::from_str(&text).map_err(|_| "SharePoint gave an unexpected answer.".to_string())
    }

    fn path(&self, id: &str) -> String {
        format!("{}/{}", self.folder, file_name(id))
    }

    /// The crew file and its version tag; Ok(None) when there is no such crew.
    fn read(&self, id: &str) -> Result<Option<(Crew, String)>, String> {
        let r = self.run("return JSON.stringify(await readFile(WEB, A.path));", json!({ "path": self.path(id) }))?;
        if r["missing"].as_bool() == Some(true) {
            return Ok(None);
        }
        if let Some(e) = r["error"].as_str() {
            note(&self.log, &format!("Read {} failed: {} {}", id, r["status"], e));
            return Err(friendly(r["status"].as_u64(), "read the crew"));
        }
        let crew: Crew = serde_json::from_str(r["text"].as_str().unwrap_or_default()).map_err(|e| format!("The crew file is damaged: {}", e))?;
        Ok(Some((crew, r["etag"].as_str().unwrap_or_default().to_string())))
    }

    /// Creates a new crew file. Ok(false) if the code is already taken.
    fn create(&self, crew: &Crew) -> Result<bool, String> {
        let text = serde_json::to_string_pretty(crew).map_err(|e| e.to_string())?;
        let r = self.run(
            "const d = await digest(WEB);
             const r = await fetch(folderApi(WEB, FOLDER) + `/Files/AddUsingPath(decodedurl='${enc(A.name)}',overwrite=false)`, { method: 'POST', headers: { ...H, 'X-RequestDigest': d }, body: A.text, credentials: 'include' });
             return JSON.stringify(r.ok ? { ok: true } : await failure(r));",
            json!({ "name": file_name(&crew.id), "text": text }),
        )?;
        if r["ok"].as_bool() == Some(true) {
            return Ok(true);
        }
        let error = r["error"].as_str().unwrap_or_default();
        if error.contains("already exists") || r["status"].as_u64() == Some(409) {
            return Ok(false);
        }
        note(&self.log, &format!("Create failed: {} {}", r["status"], error));
        Err(friendly(r["status"].as_u64(), "create the crew"))
    }

    /// Saves a changed crew, only if nobody saved it since `etag` was read.
    /// Ok(false) when someone else saved in between.
    fn save(&self, crew: &Crew, etag: &str) -> Result<bool, String> {
        let text = serde_json::to_string_pretty(crew).map_err(|e| e.to_string())?;
        let r = self.run(
            "const d = await digest(WEB);
             const r = await fetch(fileApi(WEB, A.path) + '/$value', { method: 'POST', headers: { ...H, 'X-RequestDigest': d, 'X-HTTP-Method': 'PUT', 'IF-MATCH': A.etag }, body: A.text, credentials: 'include' });
             return JSON.stringify(r.ok ? { ok: true } : r.status === 412 ? { conflict: true } : await failure(r));",
            json!({ "path": self.path(&crew.id), "etag": etag, "text": text }),
        )?;
        self.outcome(r, "save the crew")
    }

    /// Moves the crew file to the recycle bin (it can be restored from there).
    fn delete(&self, id: &str, etag: &str) -> Result<bool, String> {
        let r = self.run(
            "const d = await digest(WEB);
             const r = await fetch(fileApi(WEB, A.path) + '/recycle()', { method: 'POST', headers: { ...H, 'X-RequestDigest': d, 'IF-MATCH': A.etag }, credentials: 'include' });
             return JSON.stringify(r.ok ? { ok: true } : r.status === 412 ? { conflict: true } : await failure(r));",
            json!({ "path": self.path(id), "etag": etag }),
        )?;
        self.outcome(r, "delete the crew")
    }

    fn outcome(&self, r: Value, what: &str) -> Result<bool, String> {
        if r["ok"].as_bool() == Some(true) {
            return Ok(true);
        }
        if r["conflict"].as_bool() == Some(true) {
            return Ok(false);
        }
        note(&self.log, &format!("Could not {}: {} {}", what, r["status"], r["error"]));
        Err(friendly(r["status"].as_u64(), what))
    }
}

fn friendly(status: Option<u64>, what: &str) -> String {
    match status {
        Some(401) | Some(403) => format!("Could not {}: no permission to change files in the crews folder. Ask for the folder to be shared with edit rights.", what),
        Some(s) => format!("Could not {} (SharePoint error {}).", what, s),
        None => format!("Could not {}.", what),
    }
}

/// The crews folder link: from the project data, else from tauri.conf.json.
fn folder_link(app_handle: &tauri::AppHandle) -> Option<String> {
    let from_data = app_handle
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("project-data-cache.json")).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("crewsFolderUrl").and_then(|u| u.as_str()).map(str::to_string));
    let from_config = || {
        app_handle.config().plugins.0.get("config").and_then(|c| c.get("crewsFolderUrl")).and_then(|u| u.as_str()).map(str::to_string)
    };
    from_data.or_else(from_config).map(|s| s.trim().to_string()).filter(|s| s.starts_with("https://"))
}

/// Runs `work` in a crews folder session: hidden first; a visible window
/// (so the user can sign in) only for something the user started.
async fn with_session<T: Send + 'static>(
    app_handle: &tauri::AppHandle,
    interactive: bool,
    work: impl Fn(&Session) -> Result<T, String> + Send + Sync + 'static,
) -> Result<T, String> {
    let link = folder_link(app_handle).ok_or("Shared crews are not set up yet.")?;
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?.join("edge_profile");
    let work = Arc::new(work);
    let _profile = edge_profile_lock().lock().await;
    let attempt = |headless: bool, timeout: u64| {
        let (dir, link, work) = (dir.clone(), link.clone(), work.clone());
        tokio::task::spawn_blocking(move || match Session::open(&dir, &link, headless, timeout) {
            Ok(session) => Ok(work(&session)),
            Err(e) => Err(e),
        })
    };
    match attempt(true, 45).await.map_err(|e| e.to_string())? {
        Ok(result) => result,
        Err(OpenError::SignIn) if interactive => match attempt(false, 150).await.map_err(|e| e.to_string())? {
            Ok(result) => result,
            Err(OpenError::SignIn) => Err("Sign-in was not completed.".to_string()),
            Err(OpenError::Other(e)) => Err(e),
        },
        Err(OpenError::SignIn) => Err("Sign-in needed: press refresh on the crew to sign in.".to_string()),
        Err(OpenError::Other(e)) => Err(e),
    }
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn random_seed() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

/// Whether shared crews are set up (a crews folder link is known).
#[tauri::command]
pub fn shared_crews_available(app_handle: tauri::AppHandle) -> bool {
    folder_link(&app_handle).is_some()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewRead {
    pub id: String,
    pub crew: Option<Crew>,
    /// No such crew (never existed, or deleted)
    pub missing: bool,
    pub error: Option<String>,
}

/// Reads the given crews (one session for all of them).
#[tauri::command]
pub async fn fetch_shared_crews(app_handle: tauri::AppHandle, ids: Vec<String>, interactive: Option<bool>) -> Result<Vec<CrewRead>, String> {
    // Codes as typed or pasted ("7kq4m2", "Code: 7KQ4M2").
    let ids: Vec<String> = ids.iter().filter_map(|t| parse_code(t)).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    with_session(&app_handle, interactive.unwrap_or(false), move |s| {
        Ok(ids
            .iter()
            .map(|id| match s.read(id) {
                Ok(Some((crew, _))) => CrewRead { id: id.clone(), crew: Some(crew), missing: false, error: None },
                Ok(None) => CrewRead { id: id.clone(), crew: None, missing: true, error: None },
                Err(e) => CrewRead { id: id.clone(), crew: None, missing: false, error: Some(e) },
            })
            .collect())
    })
    .await
}

/// Creates a crew with the user as admin, and returns it with its code.
#[tauri::command]
pub async fn create_shared_crew(app_handle: tauri::AppHandle, name: String, me: Actor, members: Vec<NewMember>) -> Result<Crew, String> {
    with_session(&app_handle, true, move |s| {
        for _ in 0..5 {
            let crew = new_crew(&new_code(random_seed()), &name, &me, &members, &now())?;
            if s.create(&crew)? {
                return Ok(crew);
            }
        }
        Err("Could not create the crew. Try again.".to_string())
    })
    .await
}

/// Changes a crew (admins only). Returns the saved crew, or None if it was
/// deleted. If someone else saved the crew meanwhile, the change is applied
/// again on top of theirs.
#[tauri::command]
pub async fn change_shared_crew(app_handle: tauri::AppHandle, id: String, me: Actor, change: CrewChange) -> Result<Option<Crew>, String> {
    with_session(&app_handle, true, move |s| {
        for _ in 0..4 {
            let (crew, etag) = s.read(&id)?.ok_or("This crew no longer exists.")?;
            let saved = match apply_change(crew, &change, &me, &now())? {
                Some(updated) => s.save(&updated, &etag)?.then_some(Some(updated)),
                None => s.delete(&id, &etag)?.then_some(None),
            };
            if let Some(result) = saved {
                return Ok(result);
            }
        }
        Err("The crew is being changed by someone else right now. Try again in a moment.".to_string())
    })
    .await
}
