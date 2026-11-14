// ROAM AI through GitHub Copilot. Users sign in once with their own
// (free) GitHub account; the app does the rest:
//
// - Installs GitHub's official Copilot CLI (one copilot.exe, pinned version,
//   checked against its SHA-256) into the app data folder in the background,
//   so nobody touches a terminal. Downloaded from GitHub's release page, or
//   through the app's Edge if the direct download is blocked.
// - Signs in with GitHub's device flow, led by the app: a small in-app window
//   opens GitHub's sign-in page (where people can also create an account),
//   with the one-time code filled in. The token is handed to
//   `copilot login --with-token`, which keeps it in Windows Credential Manager.
// - Runs each AI request as `copilot -p` with no tools, no custom
//   instructions and no MCP servers, in an empty folder: a plain prompt in,
//   text out.
//
// Gemini stays as a fallback for people who still have a working key.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const CLI_VERSION: &str = "1.0.112";
/// SHA-256 of copilot-win32-x64.zip for CLI_VERSION (as in the release's SHA256SUMS.txt).
const CLI_SHA256: &str = "159a5e610c7b64c4b68b97a812fd7913182f372cb84ce688d81167d5277896d9";
/// The OAuth app of the GitHub Copilot CLI: tokens from it are what
/// `copilot login --with-token` accepts.
const CLIENT_ID: &str = "Ov23ctDVkRmgkPke0Mmm";
/// Kept small on purpose (the CLI itself asks for repo, gist and more, which
/// ROAM AI does not need). "copilotScopes" in the project data overrides it.
const DEFAULT_SCOPES: &str = "read:user read:org";
const SIGN_IN_WINDOW: &str = "github-sign-in";
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn cli_url() -> String {
    format!("https://github.com/github/copilot-cli/releases/download/v{}/copilot-win32-x64.zip", CLI_VERSION)
}

fn base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("copilot");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn exe_path(dir: &Path) -> PathBuf {
    dir.join("bin").join("copilot.exe")
}
fn account_file(dir: &Path) -> PathBuf {
    dir.join("account.json")
}

/// A plain (non-link) setting from the cached project data.
fn setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    let text = std::fs::read_to_string(dir.join("project-data-cache.json")).ok()?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{FEFF}')).ok()?;
    v.get(key)?.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn log(app: &tauri::AppHandle, msg: &str) {
    use std::io::Write;
    if let Ok(dir) = base_dir(app) {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("roam-ai-log.txt")) {
            let _ = writeln!(f, "{} v{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), env!("CARGO_PKG_VERSION"), msg);
        }
    }
}

fn setup_progress(app: &tauri::AppHandle, stage: &str, percent: Option<u32>) {
    let _ = app.emit("roam-ai-setup", serde_json::json!({ "stage": stage, "percent": percent }));
}

// ---------------------------------------------------------------- install

static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn installed(dir: &Path) -> bool {
    exe_path(dir).is_file() && std::fs::read_to_string(dir.join("bin").join("version.txt")).map(|v| v.trim() == CLI_VERSION).unwrap_or(false)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect())
}

/// Direct download with progress.
async fn download_direct(app: &tauri::AppHandle, to: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(cli_url()).send().await.map_err(|e| format!("download not reached: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("download returned {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(to).await.map_err(|e| e.to_string())?;
    let (mut done, mut last) = (0u64, 101u32);
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download interrupted: {}", e))? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if total > 0 {
            let pct = (done * 100 / total) as u32;
            if pct != last {
                last = pct;
                setup_progress(app, "downloading", Some(pct));
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// The same download through the app's Edge (works where only the browser
/// may reach the internet, e.g. behind a sign-in proxy).
async fn download_with_edge(app: &tauri::AppHandle, to: &Path) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (profile, dl, url) = (data.join("edge_profile"), base_dir(app)?.join("edge-download"), cli_url());
    setup_progress(app, "downloading", None);
    let _profile = crate::edge_profile_lock().lock().await;
    let path = tokio::task::spawn_blocking(move || {
        crate::browser_download(&crate::powerbi::edge_exe(), &profile, &dl, &url, true, 900, Some("copilot-win32-x64.zip"))
    })
    .await
    .map_err(|e| e.to_string())??;
    std::fs::rename(&path, to).or_else(|_| std::fs::copy(&path, to).map(|_| ())).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(base_dir(app)?.join("edge-download"));
    Ok(())
}

/// Makes sure the pinned CLI is in place; installs it if not.
pub async fn ensure_cli(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = base_dir(app)?;
    if installed(&dir) {
        return Ok(exe_path(&dir));
    }
    let _guard = INSTALL.lock().await;
    if installed(&dir) {
        return Ok(exe_path(&dir));
    }
    log(app, &format!("Installing Copilot CLI {}", CLI_VERSION));
    let zip = dir.join("copilot-download.zip");
    let _ = std::fs::remove_file(&zip);
    let mut result = download_direct(app, &zip).await;
    if let Err(e) = &result {
        log(app, &format!("Direct download failed ({}); trying through Edge", e));
        let _ = std::fs::remove_file(&zip);
        result = download_with_edge(app, &zip).await;
    }
    if let Err(e) = result {
        log(app, &format!("Download failed: {}", e));
        setup_progress(app, "failed", None);
        return Err(format!("ROAM AI could not be set up (download failed: {}).", e));
    }
    setup_progress(app, "installing", None);
    let hash = sha256_file(&zip)?;
    if !hash.eq_ignore_ascii_case(CLI_SHA256) {
        let _ = std::fs::remove_file(&zip);
        log(app, &format!("Checksum mismatch: {}", hash));
        setup_progress(app, "failed", None);
        return Err("ROAM AI could not be set up (the download was damaged). It will try again later.".to_string());
    }
    let staging = dir.join("bin-new");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    // Windows' own tar (bsdtar) unpacks zip files.
    let tar = std::env::var("SystemRoot").map(|r| PathBuf::from(r).join("System32").join("tar.exe")).unwrap_or_else(|_| PathBuf::from("tar.exe"));
    let out = tokio::process::Command::new(tar)
        .arg("-xf")
        .arg(&zip)
        .arg("-C")
        .arg(&staging)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| format!("Could not unpack ROAM AI: {}", e))?;
    if !out.status.success() || !staging.join("copilot.exe").is_file() {
        log(app, &format!("Unpack failed: {}", String::from_utf8_lossy(&out.stderr)));
        setup_progress(app, "failed", None);
        return Err("ROAM AI could not be set up (unpacking failed).".to_string());
    }
    std::fs::write(staging.join("version.txt"), CLI_VERSION).map_err(|e| e.to_string())?;
    let bin = dir.join("bin");
    let _ = std::fs::remove_dir_all(&bin);
    std::fs::rename(&staging, &bin).map_err(|e| format!("Could not install ROAM AI: {}", e))?;
    let _ = std::fs::remove_file(&zip);
    log(app, "Copilot CLI installed");
    setup_progress(app, "ready", Some(100));
    Ok(exe_path(&dir))
}

// ---------------------------------------------------------------- running the CLI

fn command(app: &tauri::AppHandle, exe: &Path) -> Result<tokio::process::Command, String> {
    let dir = base_dir(app)?;
    let (home, work) = (dir.join("home"), dir.join("work"));
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.current_dir(&work)
        // Only the account signed in here: never a token from the environment.
        .env_remove("COPILOT_GITHUB_TOKEN")
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env_remove("COPILOT_ALLOW_ALL")
        .env("COPILOT_HOME", &home)
        .env("NO_COLOR", "1")
        .env("COPILOT_DISABLE_DESKTOP_NOTIFICATIONS", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// Why a run failed, as a message with a prefix the app understands:
/// "SIGN_IN:" (sign in again), "QUOTA:" (monthly allowance used up) or none.
fn classify(text: &str) -> String {
    let t = text.to_lowercase();
    let short: String = text.trim().chars().take(400).collect();
    if t.contains("no authentication information") || t.contains("authentication failed") || t.contains("sign in again") || t.contains("could not be validated") || t.contains("not logged in") || t.contains("bad credentials") {
        format!("SIGN_IN: Sign in again to use ROAM AI. ({})", short)
    } else if t.contains("quota") || t.contains("100% used") || t.contains("rate limit") || t.contains("usage limit") || t.contains("limit exceeded") {
        format!("QUOTA: Your free monthly ROAM AI allowance is used up. ({})", short)
    } else {
        format!("ROAM AI did not answer: {}", short)
    }
}

/// One prompt in, the reply text out.
async fn run_prompt(app: &tauri::AppHandle, prompt: &str, timeout_secs: u64) -> Result<String, String> {
    let exe = ensure_cli(app).await?;
    let model = setting(app, "copilotModel").filter(|m| m.len() <= 64 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c)));
    for attempt in 0..2 {
        let use_model = if attempt == 0 { model.clone() } else { None };
        let mut cmd = command(app, &exe)?;
        cmd.arg("-p")
            .arg(prompt)
            .args(["-s", "--no-color", "--available-tools=", "--no-custom-instructions", "--disable-builtin-mcps", "--no-ask-user", "--no-eager-powershell-resolution", "--log-level", "none"]);
        if let Some(m) = &use_model {
            cmd.arg("--model").arg(m);
        }
        let started = Instant::now();
        let out = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
            .await
            .map_err(|_| "ROAM AI took too long to answer. Please try again.".to_string())?
            .map_err(|e| format!("ROAM AI could not start: {}", e))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() && !stdout.is_empty() {
            log(app, &format!("Prompt answered in {:.1}s{}", started.elapsed().as_secs_f32(), use_model.as_deref().map(|m| format!(" ({})", m)).unwrap_or_default()));
            return Ok(stdout);
        }
        let text = if stderr.is_empty() { stdout } else { stderr };
        log(app, &format!("Prompt failed (exit {:?}): {}", out.status.code(), text.chars().take(600).collect::<String>()));
        // A model name from the project data that isn't available: try the default once.
        if attempt == 0 && use_model.is_some() && text.to_lowercase().contains("model") {
            continue;
        }
        let err = classify(&text);
        if err.starts_with("SIGN_IN:") {
            if let Ok(dir) = base_dir(app) {
                let _ = std::fs::remove_file(account_file(&dir));
            }
        }
        return Err(err);
    }
    Err("ROAM AI did not answer.".to_string())
}

/// Whether someone has signed in to ROAM AI on this computer.
pub fn signed_in(app: &tauri::AppHandle) -> bool {
    base_dir(app).map(|d| account_file(&d).is_file()).unwrap_or(false)
}

/// The ROAM chat: the app's instructions plus what the user said; returns
/// the JSON object the model wrote.
pub async fn chat(app: &tauri::AppHandle, instructions: &str, conversation: &str) -> Result<String, String> {
    let prompt = format!(
        "{}\n\nAnswer with the JSON object only: no tools, no explanations, no code fences.\n\nUser Input: {}",
        instructions, conversation
    );
    let reply = run_prompt(app, &prompt, 120).await?;
    Ok(json_part(&reply))
}

/// A one-off question (e.g. the feedback summary); returns the reply text.
pub async fn ask(app: &tauri::AppHandle, prompt: &str) -> Result<String, String> {
    run_prompt(app, prompt, 120).await
}

/// The JSON object in a reply (models sometimes wrap it in text or fences).
pub fn json_part(reply: &str) -> String {
    match (reply.find('{'), reply.rfind('}')) {
        (Some(a), Some(b)) if b > a => reply[a..=b].to_string(),
        _ => reply.trim().to_string(),
    }
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoamAiStatus {
    installed: bool,
    signed_in: bool,
    login: Option<String>,
}

#[tauri::command]
pub fn roam_ai_status(app_handle: tauri::AppHandle) -> Result<RoamAiStatus, String> {
    let dir = base_dir(&app_handle)?;
    let login = std::fs::read_to_string(account_file(&dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["login"].as_str().map(str::to_string));
    Ok(RoamAiStatus { installed: installed(&dir), signed_in: account_file(&dir).is_file(), login })
}

/// Installs ROAM AI in the background (progress: "roam-ai-setup" events).
#[tauri::command]
pub async fn roam_ai_prepare(app_handle: tauri::AppHandle) -> Result<(), String> {
    ensure_cli(&app_handle).await.map(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    user_code: String,
    verification_uri: String,
}

struct Pending {
    device_code: String,
    interval: u64,
    expires: Instant,
}
static PENDING: std::sync::Mutex<Option<Pending>> = std::sync::Mutex::new(None);
/// Bumped to cancel a sign-in that is waiting.
static SIGN_IN_GEN: AtomicU64 = AtomicU64::new(0);

fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("ROAM-Logger/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// Fills in the code on GitHub's device page, and shows a short guide at the
/// bottom of every page of the sign-in window.
fn helper_script(user_code: &str) -> String {
    let code = serde_json::to_string(user_code).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function () {{
  var CODE = {code};
  function setValue(el, v) {{
    var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }}
  function onDevicePage() {{ return location.hostname === 'github.com' && location.pathname.indexOf('/login/device') === 0; }}
  function fill() {{
    if (!onDevicePage()) return false;
    var chars = CODE.replace(/-/g, '').split('');
    var boxes = Array.prototype.slice.call(document.querySelectorAll('input[id^="user-code-"], input[name^="user-code-"]'))
      .filter(function (i) {{ return i.type !== 'hidden'; }});
    if (boxes.length >= chars.length) {{
      boxes.slice(0, chars.length).forEach(function (b, i) {{ if (!b.value) setValue(b, chars[i]); }});
      return true;
    }}
    var single = document.querySelector('input[name="user_code"]:not([type="hidden"]), input#user_code');
    if (single) {{ if (!single.value) setValue(single, CODE); return true; }}
    return false;
  }}
  function guide() {{
    if (!document.body) return;
    var el = document.getElementById('roam-logger-guide');
    if (!el) {{
      el = document.createElement('div');
      el.id = 'roam-logger-guide';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 14px;background:#2F3C46;color:#fff;font:14px/1.4 Segoe UI,Arial,sans-serif;border-top:3px solid #E2231A;box-shadow:0 -2px 8px rgba(0,0,0,.2)';
      document.body.appendChild(el);
    }}
    var text = onDevicePage()
      ? 'ROAM Logger: your code ' + CODE + ' is filled in. Press Continue, then Authorize. This window closes by itself.'
      : (location.pathname.indexOf('/signup') === 0
          ? 'ROAM Logger: create your free GitHub account, then you will come back here to finish. Your code is ' + CODE + '.'
          : 'ROAM Logger: sign in to GitHub (or create a free account). Your code is ' + CODE + '.');
    if (el.textContent !== text) el.textContent = text;
  }}
  var tries = 0, filled = false;
  var t = setInterval(function () {{
    tries++;
    guide();
    if (!filled) filled = fill();
    if (tries > 240) clearInterval(t);
  }}, 250);
}})();"#
    )
}

fn open_window(app: &tauri::AppHandle, url: &str, user_code: Option<&str>, title: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(SIGN_IN_WINDOW) {
        let _ = w.destroy();
    }
    let parsed = url.parse().map_err(|e| format!("bad link: {}", e))?;
    let mut builder = tauri::WebviewWindowBuilder::new(app, SIGN_IN_WINDOW, tauri::WebviewUrl::External(parsed))
        .title(title)
        .inner_size(520.0, 780.0)
        .min_inner_size(400.0, 560.0)
        .center()
        .focused(true);
    if let Some(code) = user_code {
        builder = builder.initialization_script(&helper_script(code));
    }
    builder.build().map(|_| ()).map_err(|e| format!("Could not open the sign-in window: {}", e))
}

fn close_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(SIGN_IN_WINDOW) {
        let _ = w.destroy();
    }
}

/// Starts signing in: gets a one-time code from GitHub and opens the in-app
/// sign-in window with it filled in. Then call roam_ai_sign_in_wait.
#[tauri::command]
pub async fn roam_ai_sign_in_start(app_handle: tauri::AppHandle) -> Result<DeviceCode, String> {
    SIGN_IN_GEN.fetch_add(1, Ordering::SeqCst);
    let scopes = setting(&app_handle, "copilotScopes").unwrap_or_else(|| DEFAULT_SCOPES.to_string());
    let resp = github_client()?
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", scopes.as_str())])
        .send()
        .await
        .map_err(|e| format!("GitHub could not be reached: {}", e))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("GitHub's answer was not readable ({}): {}", status, e))?;
    let (Some(user_code), Some(device_code)) = (v["user_code"].as_str(), v["device_code"].as_str()) else {
        log(&app_handle, &format!("Device code request failed: {}", v));
        return Err(format!("GitHub did not start the sign-in: {}", v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("unknown error")));
    };
    let uri = v["verification_uri"].as_str().unwrap_or("https://github.com/login/device").to_string();
    *PENDING.lock().unwrap() = Some(Pending {
        device_code: device_code.to_string(),
        interval: v["interval"].as_u64().unwrap_or(5).max(1),
        expires: Instant::now() + Duration::from_secs(v["expires_in"].as_u64().unwrap_or(900)),
    });
    log(&app_handle, "Sign-in started");
    // Install in the background meanwhile, so it is ready when they finish.
    let app2 = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = ensure_cli(&app2).await;
    });
    open_window(&app_handle, &uri, Some(user_code), "Sign in to switch on ROAM AI")?;
    Ok(DeviceCode { user_code: user_code.to_string(), verification_uri: uri })
}

/// Opens the sign-in window again (if the user closed it).
#[tauri::command]
pub fn roam_ai_open_sign_in(app_handle: tauri::AppHandle, user_code: String) -> Result<(), String> {
    open_window(&app_handle, "https://github.com/login/device", Some(&user_code), "Sign in to switch on ROAM AI")
}

/// Opens GitHub's Copilot settings in the in-app window (to turn on Copilot Free).
#[tauri::command]
pub fn roam_ai_open_copilot_settings(app_handle: tauri::AppHandle) -> Result<(), String> {
    open_window(&app_handle, "https://github.com/settings/copilot", None, "Turn on GitHub Copilot Free")
}

#[tauri::command]
pub fn roam_ai_sign_in_cancel(app_handle: tauri::AppHandle) {
    SIGN_IN_GEN.fetch_add(1, Ordering::SeqCst);
    *PENDING.lock().unwrap() = None;
    close_window(&app_handle);
}

/// Waits for the user to finish in the sign-in window, then signs the CLI in
/// and checks ROAM AI answers. Returns the GitHub user name.
/// Errors: "CANCELLED", "EXPIRED: ...", "NO_COPILOT: ..." (signed in, but the
/// account can't use Copilot yet), or a message.
#[tauri::command]
pub async fn roam_ai_sign_in_wait(app_handle: tauri::AppHandle) -> Result<String, String> {
    let my_gen = SIGN_IN_GEN.load(Ordering::SeqCst);
    let (device_code, mut interval, expires) = {
        let p = PENDING.lock().unwrap();
        let p = p.as_ref().ok_or("CANCELLED")?;
        (p.device_code.clone(), p.interval, p.expires)
    };
    let client = github_client()?;
    let token = loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if SIGN_IN_GEN.load(Ordering::SeqCst) != my_gen {
            return Err("CANCELLED".to_string());
        }
        if Instant::now() > expires {
            close_window(&app_handle);
            return Err("EXPIRED: The sign-in took too long. Please start again.".to_string());
        }
        let resp = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[("client_id", CLIENT_ID), ("device_code", device_code.as_str()), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")])
            .send()
            .await;
        let Ok(resp) = resp else { continue };
        let Ok(v) = resp.json::<Value>().await else { continue };
        if let Some(t) = v["access_token"].as_str() {
            break t.to_string();
        }
        match v["error"].as_str().unwrap_or_default() {
            "authorization_pending" => {}
            "slow_down" => interval = v["interval"].as_u64().unwrap_or(interval + 5),
            "expired_token" => {
                close_window(&app_handle);
                return Err("EXPIRED: The code expired. Please start again.".to_string());
            }
            "access_denied" => {
                close_window(&app_handle);
                return Err("CANCELLED".to_string());
            }
            other => {
                log(&app_handle, &format!("Sign-in poll error: {}", v));
                close_window(&app_handle);
                return Err(format!("GitHub stopped the sign-in ({}).", if other.is_empty() { "unknown error" } else { other }));
            }
        }
    };
    *PENDING.lock().unwrap() = None;
    close_window(&app_handle);
    log(&app_handle, "GitHub authorized; signing in the CLI");

    // Hand the token to the CLI (kept in Windows Credential Manager).
    let exe = ensure_cli(&app_handle).await?;
    let mut cmd = command(&app_handle, &exe)?;
    cmd.args(["login", "--with-token"]).stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("ROAM AI could not start: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(format!("{}\n", token).as_bytes()).await.map_err(|e| e.to_string())?;
        drop(stdin);
    }
    let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| "Signing in took too long. Please try again.".to_string())?
        .map_err(|e| e.to_string())?;
    let said = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        log(&app_handle, &format!("copilot login failed: {}", said.trim()));
        return Err(format!("Signing in did not work: {}", said.trim().chars().take(300).collect::<String>()));
    }
    // "Signed in successfully as <login>." (sometimes with the host in brackets)
    let login = said
        .split("Signed in successfully as ")
        .nth(1)
        .map(|s| s.split(|c: char| c.is_whitespace() || c == '.' || c == '(' || c == '!').next().unwrap_or("").to_string())
        .filter(|s| !s.is_empty());
    let dir = base_dir(&app_handle)?;
    let _ = std::fs::write(dir.join("login.json"), serde_json::json!({ "login": login }).to_string());
    log(&app_handle, &format!("CLI signed in as {}", login.as_deref().unwrap_or("?")));
    check(&app_handle, login).await
}

/// Asks ROAM AI a tiny question to confirm the account can use Copilot.
async fn check(app: &tauri::AppHandle, login: Option<String>) -> Result<String, String> {
    match run_prompt(app, "Reply with the single word OK.", 90).await {
        Ok(_) => {
            let dir = base_dir(app)?;
            let _ = std::fs::write(
                account_file(&dir),
                serde_json::json!({ "login": login, "signedInAt": chrono::Local::now().to_rfc3339(), "cliVersion": CLI_VERSION }).to_string(),
            );
            log(app, "ROAM AI is on");
            Ok(login.unwrap_or_default())
        }
        Err(e) if e.starts_with("SIGN_IN:") || e.starts_with("QUOTA:") || e.contains("took too long") || e.contains("could not start") => Err(e),
        // Signed in, but the account can't use Copilot (most often: Copilot
        // Free not turned on yet).
        Err(e) => Err(format!("NO_COPILOT: {}", e.trim_start_matches("ROAM AI did not answer: "))),
    }
}

/// Checks again after the user turned on Copilot Free.
#[tauri::command]
pub async fn roam_ai_check(app_handle: tauri::AppHandle) -> Result<String, String> {
    let dir = base_dir(&app_handle)?;
    let login = std::fs::read_to_string(dir.join("login.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["login"].as_str().map(str::to_string));
    check(&app_handle, login).await
}

/// Turns ROAM AI off on this computer (the next use asks to sign in again).
#[tauri::command]
pub fn roam_ai_sign_out(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = base_dir(&app_handle)?;
    let _ = std::fs::remove_file(account_file(&dir));
    let _ = std::fs::remove_file(dir.join("login.json"));
    log(&app_handle, "Signed out");
    Ok(())
}

/// Opens the ROAM AI log (for support).
#[tauri::command]
pub fn roam_ai_log_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    Ok(base_dir(&app_handle)?.join("roam-ai-log.txt").display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_from_replies() {
        assert_eq!(json_part("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(json_part("Here: {\"a\":{\"b\":2}} done"), "{\"a\":{\"b\":2}}");
        assert_eq!(json_part("no json"), "no json");
    }

    #[test]
    fn classifies_errors() {
        assert!(classify("Error: No authentication information found.").starts_with("SIGN_IN:"));
        assert!(classify("Plan: 100% used, resets Dec 1").starts_with("QUOTA:"));
        assert!(classify("something else").starts_with("ROAM AI did not answer"));
    }
}
