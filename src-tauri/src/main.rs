// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use headless_chrome::Browser;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::os::windows::process::CommandExt;
use std::thread;
use std::time::Duration;
use tauri::{Emitter, LogicalSize, Manager, State};

/// Kill only Edge processes that were launched with the given profile directory.
/// This avoids closing the user's personal browser windows.
///
/// Uses two matching strategies in case CommandLine is hidden by AV/policy:
///   1) CommandLine contains the profile path (preferred)
///   2) ExecutablePath under the Edge install dir AND CommandLine present
///      with our profile identifier "com.roamlogger.dev"
///
/// After killing, waits up to 5 seconds for processes to actually exit before
/// returning, so callers can safely proceed to spawn a new Edge instance.
fn kill_edge_by_profile(profile_dir: &std::path::Path) {
    let profile_str = profile_dir.display().to_string().replace('\\', "\\\\");
    let ps_script = format!(
        r#"
        $procs = Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
            Where-Object {{ $_.CommandLine -like '*{}*' -or $_.CommandLine -like '*com.roamlogger.dev*' }};
        foreach ($p in $procs) {{
            try {{ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }} catch {{}}
        }}
        for ($i = 0; $i -lt 10; $i++) {{
            $still = Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
                Where-Object {{ $_.CommandLine -like '*{}*' -or $_.CommandLine -like '*com.roamlogger.dev*' }};
            if (-not $still) {{ break }}
            Start-Sleep -Milliseconds 500
        }}
        "#,
        profile_str, profile_str
    );
    let _ = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output();
}

/// Best-effort: kill any Edge processes that look like they were spawned by
/// a previous run of this app, so a fresh launch is not blocked by a zombie
/// holding the profile lock. Called once at app startup.
fn kill_zombie_roam_edges() {
    let ps_script = r#"
        Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
            Where-Object { $_.CommandLine -like '*com.roamlogger.dev*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    "#;
    let _ = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .creation_flags(0x08000000)
        .output();
}

/// Kill a specific process and its entire child tree by PID.
fn kill_process_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(&["/PID", &pid.to_string(), "/F", "/T"])
        .creation_flags(0x08000000)
        .output();
}

/// Read the ROAM form URL and auth whitelist pattern from the cached project
/// data file (written by fetch_project_data on app launch). Returns generic
/// placeholders if the cache is missing - which would never happen in normal
/// operation but lets the binary contain no Hatch-specific URLs.
fn get_roam_config(app_handle: &tauri::AppHandle) -> (String, String) {
    let cache_path = app_handle
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("project-data-cache.json"));
    if let Some(p) = cache_path {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(d) = serde_json::from_str::<ProjectData>(&s) {
                let url = d.roam_form_url.unwrap_or_else(|| "https://example.invalid/form".to_string());
                let wl = d.roam_auth_whitelist.unwrap_or_else(|| "*example*".to_string());
                return (url, wl);
            }
        }
    }
    ("https://example.invalid/form".to_string(), "*example*".to_string())
}

/// Close the activation browser cleanly and reset Edge crash flags
/// so the next launch does not show a "Session Restore" prompt.
fn cleanup_activation_browser(child_pid: u32, user_data_dir: &std::path::Path) {
    kill_process_tree(child_pid);
    kill_edge_by_profile(user_data_dir);
    thread::sleep(Duration::from_secs(1));
    let session_file = user_data_dir.join("Default").join("Preferences");
    if session_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&session_file) {
            let cleaned = content.replace("\"exit_type\":\"Crashed\"", "\"exit_type\":\"Normal\"");
            let _ = std::fs::write(&session_file, cleaned);
        }
    }
}

#[tauri::command]
async fn cancel_submission(state: State<'_, CancellationState>) -> Result<(), String> {
    state.0.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn activate_handshake(
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let _ = app_handle.emit("activation-debug", "Activation debug: Rust command reached.");

    // Determine Edge executable path
    let edge_path =
        std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    let edge_path_exists = edge_path.exists();
    let _ = app_handle.emit(
        "activation-debug",
        format!(
            "Activation debug: Edge path checked. Exists: {}",
            edge_path_exists
        ),
    );

    let edge_exe = if edge_path_exists {
        edge_path
    } else {
        std::path::PathBuf::from("msedge.exe")
    };

    // Use the shared edge_profile so auth tokens are available for submit_observation
    let user_data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.join("edge_profile"))
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let _ = std::fs::create_dir_all(&user_data_dir);

    // Kill only Edge processes using our profile (not the user's personal browser)
    let _ = app_handle.emit(
        "activation-debug",
        "Activation debug: killing any Edge processes using our profile.",
    );
    kill_edge_by_profile(&user_data_dir);
    thread::sleep(Duration::from_secs(2));
    let _ = app_handle.emit(
        "activation-debug",
        format!(
            "Activation debug: using shared Edge profile at {}",
            user_data_dir.display()
        ),
    );

    // Launch Edge directly using std::process::Command.
    // This bypasses headless_chrome::Browser::new() which hangs when the
    // corporate-managed SharePoint start page blocks the DevTools WebSocket.
    // The ROAM URL is passed as a positional argument so Edge opens it directly.
    // The --auth-server-whitelist flags ensure NTLM tokens are cached in the profile.
    let _ = app_handle.emit(
        "activation-debug",
        "Activation debug: launching Edge directly with ROAM URL.",
    );

    // Clear any stale DevToolsActivePort file BEFORE launching Edge, so the
    // port file we read after launch is the one Edge just wrote (not a leftover
    // from a previous crashed run, and not the one we accidentally delete after
    // Edge has already written it).
    let devtools_file = user_data_dir.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&devtools_file);

    let (roam_url, roam_whitelist) = get_roam_config(&app_handle);

    let user_data_arg = format!("--user-data-dir={}", user_data_dir.display());
    let child = std::process::Command::new(&edge_exe)
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-popup-blocking")
        .arg("--disable-extensions")
        .arg("--disable-session-crashed-bubble")
        .arg("--no-restore-state-check")
        .arg("--disable-features=InfiniteSessionRestore")
        .arg(format!("--auth-server-whitelist={}", roam_whitelist))
        .arg(format!("--auth-negotiate-delegate-whitelist={}", roam_whitelist))
        .arg(&user_data_arg)
        .arg("--remote-debugging-port=0")
        .arg(&roam_url)
        .spawn()
        .map_err(|e| format!("Failed to launch Edge browser: {}. Make sure Edge is installed and not blocked by Group Policy or antivirus.", e))?;

    let child_pid = child.id();
    let _ = app_handle.emit(
        "activation-debug",
        format!(
            "Activation debug: Edge launched with PID {}. Waiting for ROAM authentication...",
            child_pid
        ),
    );

    // Wait for the page to load and NTLM auth tokens to be cached.
    // The corporate start page may also load alongside ROAM — that's fine.
    // Wait for Edge to expose its DevTools port (auto-assigned because we used port=0).
    // If the port never appears, Edge crashed or remote debugging is blocked.
    let mut ws_url: Option<String> = None;
    for _ in 0..45 {
        if let Ok(content) = std::fs::read_to_string(&devtools_file) {
            let lines: Vec<&str> = content.lines().collect();
            if lines.len() >= 2 {
                ws_url = Some(format!("ws://127.0.0.1:{}{}", lines[0].trim(), lines[1].trim()));
                break;
            }
        }
        thread::sleep(Duration::from_secs(1));
    }

    let ws_url = match ws_url {
        Some(url) => url,
        None => {
            cleanup_activation_browser(child_pid, &user_data_dir);
            return Err("Edge launched but did not expose a DevTools port within 45 seconds. The Edge process may have crashed during first-run setup. Please retry; if it keeps failing on a clean install, try deleting the edge_profile folder under %APPDATA%\\com.roamlogger.dev and retry.".to_string());
        }
    };

    let _ = app_handle.emit(
        "activation-debug",
        "Connected to Edge DevTools. Verifying ROAM authentication...",
    );

    let browser = match Browser::connect(ws_url) {
        Ok(b) => b,
        Err(e) => {
            cleanup_activation_browser(child_pid, &user_data_dir);
            return Err(format!("Connected to Edge but the DevTools WebSocket handshake failed: {}. Please retry; if it keeps failing, restart your machine.", e));
        }
    };

    // Actively poll for the ROAM form iframe to appear. This is the real proof
    // that NTLM auth succeeded and the page rendered. We wait up to 90 seconds
    // so the user has time to complete SSO / MFA prompts.
    let mut auth_verified = false;
    let mut roam_error_seen = false;
    let mut last_url = String::from("(no ROAM tab opened yet)");
    for sec in 1..=90 {
        thread::sleep(Duration::from_secs(1));

        let tabs_snapshot = {
            let tabs_arc = browser.get_tabs();
            let guard = tabs_arc.lock().unwrap();
            guard.clone()
        };

        for tab in &tabs_snapshot {
            let url = tab.get_url();
            if url.contains("NetForms") || url.contains("ROAM") {
                last_url = url.clone();

                if let Ok(r) = tab.evaluate(
                    "document.body ? document.body.innerText.includes('Sorry, something went wrong') : false",
                    false,
                ) {
                    if r.value.and_then(|v| v.as_bool()).unwrap_or(false) {
                        roam_error_seen = true;
                        break;
                    }
                }

                if let Ok(r) = tab.evaluate("document.querySelector('#e360Frame') !== null", false) {
                    if r.value.and_then(|v| v.as_bool()).unwrap_or(false) {
                        auth_verified = true;
                        break;
                    }
                }
            }
        }

        if auth_verified || roam_error_seen {
            break;
        }

        if sec % 5 == 0 {
            let _ = app_handle.emit(
                "activation-debug",
                format!(
                    "Verifying authentication... {}s of 90s. Current URL: {}",
                    sec, last_url
                ),
            );
        }
    }

    cleanup_activation_browser(child_pid, &user_data_dir);

    if auth_verified {
        let marker_path = user_data_dir.join("activation_success.marker");
        let stamp = chrono::Local::now().to_rfc3339();
        let _ = std::fs::write(&marker_path, stamp);
        let _ = app_handle.emit(
            "activation-debug",
            "Activation succeeded. NTLM tokens are now cached for future submissions.",
        );
        Ok("ROAM connection activated successfully".to_string())
    } else if roam_error_seen {
        Err(format!("ROAM page loaded but returned 'Sorry, something went wrong'. Last URL: {}. The ROAM server may be down. Try again in a few minutes.", last_url))
    } else {
        Err(format!("Activation timed out after 90 seconds. The ROAM form never finished loading. Last URL seen: {}. Common causes: (1) SSO or MFA was not completed in the Edge window, (2) you are not on the corporate network or VPN, (3) the ROAM site is temporarily unavailable. Please retry.", last_url))
    }
}
#[tauri::command]
async fn submit_observation(
    payload: String,
    headless: bool,
    state: State<'_, CancellationState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    state.0.store(false, Ordering::SeqCst);
    let json_payload: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("Failed to parse payload: {}", e))?;

    // Determine Edge executable path
    let edge_path =
        std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    let edge_exe = if edge_path.exists() {
        edge_path
    } else {
        std::path::PathBuf::from("msedge.exe")
    };

    // Retry loop: up to 3 attempts to launch browser and navigate to ROAM
    let max_nav_attempts = 3;
    let mut last_nav_error = String::from("Unknown error");
    let mut nav_browser: Option<Browser> = None;
    let mut nav_tab = None;

    // Use shared edge_profile (same as activation, so NTLM tokens are available)
    let user_data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.join("edge_profile"))
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let _ = std::fs::create_dir_all(&user_data_dir);

    for attempt in 1..=max_nav_attempts {
        if state.0.load(Ordering::SeqCst) {
            return Err("Submission cancelled".to_string());
        }

        let _ = app_handle.emit(
            "submission-progress",
            format!("Phase 1/5: Launching Edge browser (attempt {}/{})...", attempt, max_nav_attempts),
        );

        // Kill Edge processes using our profile that may hold the lock
        kill_edge_by_profile(&user_data_dir);
        thread::sleep(Duration::from_secs(2));

        // Remove Singleton lock files that block new Edge launches. These are
        // left behind by ungraceful Edge exits and are the #1 reason headless
        // mode silently fails to expose a DevTools port even though the Edge
        // process spawned.
        let _ = std::fs::remove_file(user_data_dir.join("SingletonLock"));
        let _ = std::fs::remove_file(user_data_dir.join("SingletonCookie"));
        let _ = std::fs::remove_file(user_data_dir.join("SingletonSocket"));

        // Clean up session state to prevent restore prompts
        let session_file = user_data_dir.join("Default").join("Preferences");
        if session_file.exists() {
            if let Ok(content) = std::fs::read_to_string(&session_file) {
                let cleaned = content.replace(
                    "\"exit_type\":\"Crashed\"",
                    "\"exit_type\":\"Normal\"",
                );
                let _ = std::fs::write(&session_file, cleaned);
            }
        }

        // Delete old DevToolsActivePort so we detect the fresh one
        let devtools_file = user_data_dir.join("DevToolsActivePort");
        let _ = std::fs::remove_file(&devtools_file);

        // Spawn Edge with remote debugging (port=0 picks a random free port)
        let user_data_arg = format!("--user-data-dir={}", user_data_dir.display());
        let mut cmd = std::process::Command::new(&edge_exe);
        let (roam_url_inner, roam_whitelist_inner) = get_roam_config(&app_handle);
        cmd.arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-popup-blocking")
            .arg("--disable-extensions")
            .arg("--disable-session-crashed-bubble")
            .arg("--no-restore-state-check")
            .arg("--disable-features=InfiniteSessionRestore")
            .arg(format!("--auth-server-whitelist={}", roam_whitelist_inner))
            .arg(format!("--auth-negotiate-delegate-whitelist={}", roam_whitelist_inner))
            .arg(&user_data_arg)
            .arg("--remote-debugging-port=0");

        // On the final attempt, fall back to visible mode if headless was
        // requested. Headless Edge with a --user-data-dir that was previously
        // used by a visible session (e.g. our activation flow) can fail to
        // expose a DevTools port even though Edge launches. Visible mode is
        // the reliable fallback - the user briefly sees an Edge window pop up,
        // get filled, and close, but the submission completes.
        let use_headless = headless && attempt < max_nav_attempts;
        if use_headless {
            cmd.arg("--headless=new")
                .arg("--disable-gpu")
                .arg("--disable-software-rasterizer")
                .arg("--disable-dev-shm-usage");
        } else if headless && attempt == max_nav_attempts {
            let _ = app_handle.emit(
                "submission-progress",
                "Phase 1/5: Headless mode failed - retrying with a visible Edge window...",
            );
        }

        // Pass the ROAM URL as a positional argument so Edge navigates to it
        // at startup. This is the same approach activate_handshake uses, which
        // works reliably every time. Using headless_chrome's new_tab() and
        // tab.navigate_to() against corporate-managed Edge is what was hanging
        // the submission flow indefinitely.
        cmd.arg(&roam_url_inner);

        let edge_pid = match cmd.spawn() {
            Ok(child) => child.id(),
            Err(e) => {
                last_nav_error = format!(
                    "Attempt {}/{}: Failed to spawn Edge: {}",
                    attempt, max_nav_attempts, e
                );
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };

        // Wait for DevToolsActivePort file (Edge writes port + WS path here)
        let mut ws_url: Option<String> = None;
        for _ in 0..30 {
            if state.0.load(Ordering::SeqCst) {
                kill_edge_by_profile(&user_data_dir);
                return Err("Submission cancelled".to_string());
            }
            if let Ok(content) = std::fs::read_to_string(&devtools_file) {
                let lines: Vec<&str> = content.lines().collect();
                if lines.len() >= 2 {
                    let port = lines[0].trim();
                    let path = lines[1].trim();
                    ws_url = Some(format!("ws://127.0.0.1:{}{}", port, path));
                    break;
                }
            }
            thread::sleep(Duration::from_secs(1));
        }

        let ws_url = match ws_url {
            Some(url) => url,
            None => {
                last_nav_error = format!(
                    "Attempt {}/{}: DevTools connection not available after 30s",
                    attempt, max_nav_attempts
                );
                kill_edge_by_profile(&user_data_dir);
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };

        // Connect to Edge via DevTools WebSocket
        let browser = match Browser::connect(ws_url) {
            Ok(b) => b,
            Err(e) => {
            last_nav_error = format!(
                "Attempt {}/{}: Failed to connect to Edge DevTools: {}",
                attempt, max_nav_attempts, e
            );
            kill_edge_by_profile(&user_data_dir);
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };

        thread::sleep(Duration::from_secs(1));

        // Grab a usable tab without doing URL pattern matching. Edge was
        // launched with the ROAM URL as a positional arg, so a tab is already
        // navigating to it - but corporate SSO/ADFS can redirect the tab
        // through other hostnames during the NTLM challenge, which makes URL
        // pattern matching unreliable.
        //
        // Strategy: prefer a tab whose URL clearly matches ROAM, but otherwise
        // fall back to any non-blank, non-chrome:// tab. The Phase 3 iframe
        // poll below is the real readiness check - it verifies the actual
        // ROAM form DOM element exists, which is a structurally tighter
        // signal than any URL match could be.
        let mut roam_tab = None;
        let mut fallback_tab = None;
        for _ in 0..15 {
            if state.0.load(Ordering::SeqCst) {
                kill_edge_by_profile(&user_data_dir);
                return Err("Submission cancelled".to_string());
            }
            let tabs_snapshot = {
                let tabs_arc = browser.get_tabs();
                let guard = tabs_arc.lock().unwrap();
                guard.clone()
            };
            for t in &tabs_snapshot {
                let url = t.get_url();
                if url.contains("NetForms") || url.contains("ROAM") {
                    roam_tab = Some(t.clone());
                    break;
                }
                if !url.is_empty()
                    && url != "about:blank"
                    && !url.starts_with("chrome://")
                    && !url.starts_with("edge://")
                    && !url.starts_with("devtools://")
                {
                    fallback_tab = Some(t.clone());
                }
            }
            if roam_tab.is_some() {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }

        let tab = match roam_tab.or(fallback_tab) {
            Some(t) => t,
            None => {
                last_nav_error = format!(
                    "Attempt {}/{}: Edge launched but no usable tab appeared within 15 seconds (Edge may have crashed)",
                    attempt, max_nav_attempts
                );
                kill_edge_by_profile(&user_data_dir);
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };

        // When debugging (not headless), bring the Edge window to the foreground.
        // Tauri's windows_subsystem="windows" causes child windows to spawn behind
        // the app. AppActivate uses the Windows API to force-focus by PID.
        if !use_headless {
            let ps_focus = format!(
                "Add-Type -AssemblyName Microsoft.VisualBasic; for ($i = 0; $i -lt 5; $i++) {{ try {{ [Microsoft.VisualBasic.Interaction]::AppActivate({}); break }} catch {{ Start-Sleep -Milliseconds 500 }} }}",
                edge_pid
            );
            let _ = std::process::Command::new("powershell")
                .args(&["-NoProfile", "-NonInteractive", "-Command", &ps_focus])
                .creation_flags(0x08000000)
                .output();
        }

        // Suppress common ROAM site JavaScript errors that trigger alert dialogs.
        // This is best-effort - if the page is mid-redirect (SSO/ADFS), evaluate
        // may fail. We don't care; the iframe-wait phase below handles all the
        // post-load checking.
        let _ = tab.evaluate(
            r#"
            window.onerror = function(message, url, line, col, error) {
                console.warn('Caught JS Error:', message, 'at', url, ':', line);
                return true;
            };
            "#,
            false,
        );

        // Trust the polling loop above - it already proved a tab was navigating
        // to ROAM. We deliberately do NOT re-check the URL here because corporate
        // SSO can briefly redirect the tab through an ADFS hostname during the
        // NTLM challenge, which would cause a false-negative on the URL pattern
        // match and trigger an unnecessary retry. The iframe-wait phase below
        // is the real readiness check.
        let _ = app_handle.emit(
            "submission-progress",
            format!("Phase 1/5: Tab acquired ({}). Continuing...", tab.get_url()),
        );
        nav_browser = Some(browser);
        nav_tab = Some(tab);
        break;
    }

    let browser = nav_browser.ok_or_else(|| format!(
        "Could not reach the ROAM website after {} attempts (including a visible-mode fallback).\n\nLast error: {}\n\nMost likely causes:\n  1) Your NTLM tokens have expired - click the 'Connect' button again to re-authenticate.\n  2) You are not connected to the corporate network or VPN.\n  3) The ROAM server is temporarily down.\n  4) A stale Edge process is still holding the profile lock - close all Edge windows and retry.",
        max_nav_attempts, last_nav_error
    ))?;
    let tab = nav_tab.ok_or_else(|| format!(
        "Could not reach the ROAM website after {} attempts. Last error: {}",
        max_nav_attempts, last_nav_error
    ))?;

    let _ = app_handle.emit(
        "submission-progress",
        "Phase 2/5: Connected to ROAM. Waiting for the form page to load...",
    );

    // Polling for the iframe as per simple_roam_populator logic
    let mut frame_found = false;
    for _ in 0..45 {
        if state.0.load(Ordering::SeqCst) {
            return Err("Submission cancelled".to_string());
        }
        // Check for ROAM error message
        let error_check = tab
            .evaluate("document.body.innerText.includes('Sorry, something went wrong')", false)
            .map_err(|e| e.to_string())?;
        
        if error_check.value.and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err("ROAM Server is offline. Please try again later.".to_string());
        }

        let check_frame = tab
            .evaluate("document.querySelector('#e360Frame') !== null", false)
            .map_err(|e| e.to_string())?;
        if check_frame.value.and_then(|v| v.as_bool()).unwrap_or(false) {
            frame_found = true;
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }

    if !frame_found {
        let final_url = tab.get_url();
        return Err(format!(
            "The ROAM form (#e360Frame iframe) never appeared after 45 seconds.\n\nThe browser ended up on: {}\n\nMost likely causes:\n  1) Your auth was rejected - click 'Connect' to re-authenticate.\n  2) Edge got stuck on an SSO/ADFS prompt that needed manual input - try submitting in visible mode (toggle the debug menu with Ctrl+Shift+Alt+D).\n  3) The ROAM backend is slow or partially down.",
            final_url
        ));
    }

    let _ = app_handle.emit(
        "submission-progress",
        "Phase 3/5: ROAM iframe detected. Waiting for input fields to render...",
    );

    // Wait for the form page to fully load by checking for the 'busy' overlay and ensuring inputs are present
    let mut form_ready = false;
    for _ in 0..150 {
        if state.0.load(Ordering::SeqCst) {
            return Err("Submission cancelled".to_string());
        }
        
        let check_ready = tab.evaluate(r#"
            (function() {
                const frameContainer = document.querySelector('#e360Frame');
                if (!frameContainer) return false;
                const frame = frameContainer.contentWindow.document;
                
                // Check if the "Busy" indicator is hidden/gone and at least one specific input exists
                const isBusy = frame.querySelector('.busy') !== null || frame.querySelector('.loading-overlay') !== null;
                const hasInputs = frame.querySelectorAll('input[type="text"]').length > 5;
                
                return !isBusy && hasInputs;
            })()
        "#, false).map_err(|e| e.to_string())?;

        if check_ready.value.and_then(|v| v.as_bool()).unwrap_or(false) {
            form_ready = true;
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }

    if !form_ready {
        return Err("Timed out after 30 seconds waiting for the ROAM form to finish rendering its input fields. The page loaded but the form is stuck on a 'busy' overlay. Try again, and if it keeps happening re-run Activate to refresh your auth.".to_string());
    }

    let _ = app_handle.emit(
        "submission-progress",
        "Phase 4/5: Filling form fields...",
    );

    // Inject a MutationObserver into the ROAM iframe BEFORE submitting.
    // This watches for the success toast and sets a persistent flag.
    // Even if the toast appears for only a fraction of a second, the observer catches it.
    let _ = tab.evaluate(r#"
        (function() {
            const frameContainer = document.querySelector('#e360Frame');
            if (!frameContainer) return;
            try {
                const frame = frameContainer.contentWindow;
                frame.__roamSubmitSuccess = false;
                const observer = new MutationObserver(function(mutations) {
                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1) {
                                const text = node.textContent || '';
                                if (text.includes('Record was saved successfully') ||
                                    text.includes('saved successfully')) {
                                    frame.__roamSubmitSuccess = true;
                                    observer.disconnect();
                                    return;
                                }
                            }
                        }
                        // Also check characterData changes and attribute changes
                        if (mutation.target && mutation.target.textContent) {
                            const text = mutation.target.textContent;
                            if (text.includes('Record was saved successfully') ||
                                text.includes('saved successfully')) {
                                frame.__roamSubmitSuccess = true;
                                observer.disconnect();
                                return;
                            }
                        }
                    }
                });
                observer.observe(frame.document.body, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                    attributes: true
                });
            } catch(e) {}
        })()
    "#, false);

    let script = format!(
        r#"
        (async function() {{
            const data = {};
            const logs = [];
            const log = (msg) => logs.push(`[${{new Date().toISOString()}}] ${{msg}}`);
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            
            log("Starting automation script");
            const frameContainer = document.querySelector('#e360Frame');
            if (!frameContainer) {{
                log("Error: Frame #e360Frame not found");
                return logs;
            }}
            const frame = frameContainer.contentWindow.document;

            async function setField(index, value, waitTime = 0, fieldName = "Field") {{
                if (!value) return;
                const inputs = Array.from(frame.querySelectorAll('input[type="text"], textarea, select'));
                const el = inputs[index];
                if (el) {{
                    log(`Filling ${{fieldName}} (index ${{index}}) with: ${{value}}`);
                    el.focus();
                    el.click();
                    await sleep(50);
                    el.value = value;
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    if (waitTime > 0) await sleep(waitTime);
                    el.dispatchEvent(new KeyboardEvent('keydown', {{ bubbles: true, cancelable: true, key: 'Tab', code: 'Tab' }}));
                    await sleep(200);
                }} else {{
                    log(`Warning: ${{fieldName}} (index ${{index}}) not found`);
                }}
            }}

            async function setIndexedRadio(startIndex, isYes, fieldName = "Radio") {{
                const radios = Array.from(frame.querySelectorAll('input[type="radio"]'));
                const targetIndex = isYes ? startIndex : startIndex + 1;
                const target = radios[targetIndex];
                if (target) {{
                    log(`Clicking ${{fieldName}} - ${{isYes ? "Yes" : "No"}} (index ${{targetIndex}})`);
                    target.click();
                    await sleep(50);
                }} else {{
                    log(`Warning: ${{fieldName}} (index ${{targetIndex}}) not found`);
                }}
            }}

            await setField(2, data.project, 1000, "Field 3");
            await setField(10, data.office, 1000, "Field 11");
            await setField(13, data.office, 1000, "Field 14");
            await setField(25, data.officeLoc, 500, "Office Loc (Field 26)");
            await setField(26, data.officeLoc, 1000, "Field 27");
            await setField(29, data.address, 1000, "Office Address (Field 30)");
            await setField(30, data.exactLoc, 0, "Exact Location (Field 31)");
            await setField(33, data.date, 0, "Date (Field 34)");

            if (data.time) {{
                const cleanTime = data.time.replace(/\s?[AP]M/i, '').trim();
                await setField(34, cleanTime, 0, "Time (Field 35)");
            }}

            await setField(37, data.obsType, 1000, "Observation Type (Field 38)");
            await setField(40, data.obsSafe, 500, "Status Safe/At Risk (Field 41)");
            await setField(41, data.details, 0, "Details (Field 42)");
            await setField(42, data.action, 0, "Action (Field 43)");
            await setField(45, data.category, 500, "Category (Field 46)");

            const contractorVal = data.isContractor === true || data.isContractor === "Yes";
            await setIndexedRadio(0, contractorVal, "Contractor");

            const workHoursVal = data.isWorkHours === true || data.isWorkHours === "Yes";
            await setIndexedRadio(2, workHoursVal, "Work Hours");
            
            await sleep(100);

            const allInputs = Array.from(frame.querySelectorAll('input[type="text"], textarea, select'));
            const vflInput = allInputs[49];
            if (vflInput) {{
                let vflValue = "VFL - Field Safety Observation Card, Yellow Card";
                if (data.cardType === 'Design') vflValue = "VFL - Design for Safety Audit Card, Orange Card";
                else if (data.cardType === 'Office') vflValue = "VFL- Office Safety Audit Card, Green Card";

                log(`Setting VFL Selection (index 49) to: ${{vflValue}}`);
                await setField(49, vflValue, 1000, "VFL Field");
            }}

            await sleep(500);

            const buttons = Array.from(frame.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'));
            if (buttons[2]) {{
                log("Clicking Submit button");
                
                // Focus the button first, as some SPAs require focus before clicking
                buttons[2].focus();
                buttons[2].click();
                
                await sleep(2500);
            }} else {{
                log("Error: Submit button not found");
            }}

            log("Automation completed");
            return logs;
        }})();
        "#,
        json_payload
    );

    let execution_result = tab.evaluate(&script, false)
        .map_err(|e| format!("Form fill script failed to execute: {}. The form may have changed structure since this version was released - check submission_log.txt in %APPDATA%\\com.roamlogger.dev for details.", e))?;

    let _ = app_handle.emit(
        "submission-progress",
        "Phase 5/5: Form submitted. Waiting for ROAM server to confirm save (up to 30s)...",
    );

    // Log automation steps if debugging is enabled (not headless)
    if !headless {
        if let Ok(app_data) = app_handle.path().app_data_dir() {
            let _ = std::fs::create_dir_all(&app_data);
            let log_path = app_data.join("submission_log.txt");
            if let Some(logs) = execution_result.value.as_ref().and_then(|v| v.as_array()) {
                let log_content = logs.iter()
                    .map(|v| v.as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = std::fs::write(log_path, log_content);
            }
        }
    }

    // Wait for ROAM to confirm the record was saved (up to 30 seconds).
    // The MutationObserver we injected before the form script sets
    // frame.__roamSubmitSuccess = true the instant the toast appears,
    // even if it vanishes immediately.
    let mut submission_confirmed = false;
    for _ in 0..60 {
        if state.0.load(Ordering::SeqCst) {
            return Err("Submission cancelled".to_string());
        }
        let check_flag = tab.evaluate(r#"
            (function() {
                const frameContainer = document.querySelector('#e360Frame');
                if (!frameContainer) return false;
                try {
                    return frameContainer.contentWindow.__roamSubmitSuccess === true;
                } catch(e) {}
                return false;
            })()
        "#, false);
        if let Ok(result) = check_flag {
            if result.value.and_then(|v| v.as_bool()).unwrap_or(false) {
                submission_confirmed = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(500));
    }

    // Always close the Edge browser after submission, regardless of whether
    // the run was headless or visible-fallback. Leaving Edge running was
    // creating zombie processes that held the profile lock and prevented all
    // subsequent Connect/Submit attempts from working.
    //
    // The only exception is debug mode (Ctrl+Shift+Alt+D toggled by the user)
    // where they explicitly want to inspect the browser. In that case we
    // still drop the headless_chrome handle so it stops sending CDP commands,
    // but leave the OS process alive.
    drop(browser);
    kill_edge_by_profile(&user_data_dir);

    if submission_confirmed {
        Ok("Record was saved successfully on the ROAM website.".to_string())
    } else {
        Err(format!(
            "The ROAM form was filled and the Submit button was clicked, but the server never returned a 'Record was saved successfully' toast within 30 seconds.\n\nThis can mean:\n  1) The submission actually succeeded but the success toast was missed - please verify on the ROAM website before re-submitting (to avoid a duplicate).\n  2) The submit button click did not land on the right element (form structure may have changed).\n  3) The ROAM server is processing slowly.\n\nCurrent URL: {}",
            tab.get_url()
        ))
    }
}

#[tauri::command]
async fn submit_to_copilot(_prompt: String, _headless: bool) -> Result<String, String> {
    Err("Copilot fallback is no longer supported.".to_string())
}

#[tauri::command]
async fn get_cached_key(state: State<'_, ApiKeyState>) -> Result<Option<String>, String> {
    Ok(state.0.lock().unwrap().clone())
}

#[tauri::command]
async fn store_api_key(
    key: String,
    state: State<'_, ApiKeyState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let trimmed_key = key.trim().to_string();

    // Validate the API key by making a minimal request
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let test_request = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart {
                text: "Ping".to_string(),
            }],
        }],
        generation_config: Some(GenerationConfig {
            max_output_tokens: Some(1),
            temperature: Some(0.0),
        }),
    };

    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key={}", trimmed_key);
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&test_request)
        .send()
        .await
        .map_err(|e| format!("Connection error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        return match status.as_u16() {
            401 | 403 => Err("Invalid API Key: Authentication failed".to_string()),
            429 => Err("Rate limited: Too many requests. Please wait and try again.".to_string()),
            503 => Err(
                "API error: Model is too busy or overloaded. Please try again later.".to_string(),
            ),
            _ => Err(format!("API validation failed with status: {}", status)),
        };
    }

    *state.0.lock().unwrap() = Some(trimmed_key.clone());

    if let Ok(path) = app_handle.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&path);
        let key_path = path.join("key.cache");
        let _ = std::fs::write(key_path, trimmed_key);
    }

    Ok("API key validated and stored".to_string())
}

// Structs for Gemini API request/response
#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generation_config: Option<GenerationConfig>,
}

#[derive(Serialize, Deserialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize, Deserialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GenerationConfig {
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: Option<u32>,
    temperature: Option<f32>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Vec<GeminiCandidate>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: GeminiContent,
}

fn get_system_instructions() -> String {
    use chrono::Local;
    let now = Local::now();
    let today_str = now.format("%d/%b/%Y").to_string();
    let categories = "Access Breach, Barricading, Behaviour / General Conduct, Caught Between, Chemical, Collision, Confined Space, Contact With, Cybersecurity, Electrical, Equipment Failure, Ergonomics / Manual Handling, Excavation, Explosion, Fall from Above, Fall from Above Objects, Fall from Above Slips/Trips/Falls, Fire, Fire Prevention / Protection, Foreign Body, Hazardous Substances, Health/Medical/Disease, Housekeeping, Lifting and Rigging, Lockout/Tagout, Danger Tag/Isolation, Manual Handling, Mobile Equipment, Motor Vehicle, Noise, Over/Near Water, Permit to Work, Personal Protective Equipment, Procedure Breach, Quality Assurance/Quality Control, Security, Sharp Objects, Signage, Stacking Storage, Sustainability, Thermal Stress (Hot / Cold), Travel, Unguarded Equipment, Weather Conditions, Wildlife, Work at Heights, Workstation Ergonomics";

    format!(
        r#"Analyze the following safety observation report and extract the details into strict JSON. 
Today's date is {today_str}. Resolve relative dates (today/yesterday/tomorrow/last week) accordingly.
If a specific date is mentioned (e.g. "13th March"), use that exact date regardless of today's date.
If no date is mentioned, assume it happened today ({today_str}).

Instructions:
1. Determine scenario:
   - Scenario A: Greeting only. Action: "isValidObservation": false, "error": "Hello. I am here to help you..."
   - Scenario B: Observation details provided. Action: "isValidObservation": true, "error": "Thank you for your observation. Click Submit Observation to log the ROAM observation.". Populate fields.

2. Fields:
    a. "project": Use the project name or number mentioned. Default: "Hatch Global (Project View)".
    b. "details": Professional third-person sentence.
    c. "action": THIRD PERSON imperative sentence (e.g., "Maintained situation awareness...", "Removed tripping hazard..."). If the original action was unsafe, describe an appropriate safe action that was taken.
    d. "isContractor": "Yes" if contractor/vendor/supplier mentioned, else "No".
    e. "category": MUST match one of: {categories}.
    f. "exactLoc": Capitalized descriptive phrase. Leave as empty string if not mentioned.

Return ONLY JSON:
{{
  "isValidObservation": boolean,
  "error": "string",
  "project": "string",
  "exactLoc": "string",
  "date": "dd/MMM/yyyy" (Today is "{today_str}"),
  "time": "HH:MM",
  "isContractor": "Yes" or "No",
  "isWorkHours": "Yes" or "No",
  "obsType": "Behaviour" or "Condition",
  "obsSafe": "Safe" or "At Risk",
  "officeLoc": "Home office" (if working remotely, or working from or at home), "Site/Client" (if at a client, at a client's office, on a site, construction site, job site, industrial plant, or process plant), else default to "Hatch office",
  "details": "string",
  "action": "string",
  "category": "string",
  "cardType": "Design", "Field", or "Office"
}}"#
    )
}

#[tauri::command]
async fn send_feedback(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let version = "0.4.8";
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();

    // Note: capture_tab is only available in some Tauri 2.0 versions. 
    // If it fails to compile, we use clipboard-manager for the text part.
    // For now, let's stick to opening the email and instructing user to paste 
    // since we cannot reliably automate "CTRL+V" into an external process (Outlook) 
    // via standard Tauri plugins safely without enigo/native-windows-gui.

    let subject = format!("Feedback on Roam Observation Logger v{} - {}", version, date);
    let body = "Please provide your feedback here:\n\n";

    // Pull the feedback recipient from the cached project data file, written
    // by fetch_project_data on app launch. If unavailable for any reason, fall
    // back to a placeholder so the binary contains no Hatch-specific address.
    let cache_path = app_handle
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("project-data-cache.json"));
    let mail_to: String = cache_path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<ProjectData>(&s).ok())
        .and_then(|d| d.feedback_email)
        .unwrap_or_else(|| "feedback@example.com".to_string());
    let mail_to = mail_to.as_str();

    let encode = |s: &str| {
        s.chars()
            .map(|c| {
                if c.is_alphanumeric() || "-_.~".contains(c) {
                    c.to_string()
                } else {
                    format!("%{:02X}", c as u32)
                }
            })
            .collect::<String>()
    };

    let url = format!(
        "mailto:{}?subject={}&body={}",
        mail_to,
        encode(&subject),
        encode(body)
    );

    // 2. Open email app
    #[allow(deprecated)]
    app_handle
        .shell()
        .open(url, None)
        .map_err(|e: tauri_plugin_shell::Error| e.to_string())?;

    Ok(())
}

/// The structured config data fetched from SharePoint at runtime.
/// Schema version 2 includes feedback email and ROAM URL so the binary is free
/// of any Hatch-specific strings.
#[derive(Serialize, Deserialize, Clone)]
struct ProjectData {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(default, rename = "generatedAt")]
    generated_at: Option<String>,
    #[serde(default, rename = "feedbackEmail")]
    feedback_email: Option<String>,
    #[serde(default, rename = "roamFormUrl")]
    roam_form_url: Option<String>,
    #[serde(default, rename = "roamAuthWhitelist")]
    roam_auth_whitelist: Option<String>,
    projects: Vec<String>,
    cities: Vec<String>,
    streets: Vec<String>,
}

#[derive(Serialize, Clone)]
struct ProjectDataResult {
    data: ProjectData,
    #[serde(rename = "ageDays")]
    age_days: Option<f64>,
    #[serde(rename = "fromCache")]
    from_cache: bool,
}

/// Try downloading the SharePoint JSON file using Edge with the given user-data-dir.
/// Returns Ok(parsed_data) if a complete projects-data.json file appeared in the
/// download folder within the timeout. Returns Err with a description otherwise.
///
/// `headless` true   = run Edge silently in the background (subsequent launches)
/// `headless` false  = run Edge visibly so the user can sign in (first launch / expired cookies)
/// Kept around but unused: previously used to find the user's Downloads folder
/// when Edge ignored --download-default-directory in visible mode. The CDP
/// Browser.setDownloadBehavior call replaces that fragile approach entirely.
#[allow(dead_code)]
fn user_downloads_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("USERPROFILE") {
        return std::path::PathBuf::from(p).join("Downloads");
    }
    std::path::PathBuf::from(r"C:\Users\Default\Downloads")
}

/// Try downloading the SharePoint JSON file using Edge with the given user-data-dir.
/// Returns Ok(parsed_data) if a complete projects-data.json file appeared in either
/// our private download dir (headless) or the user's Downloads folder (visible).
///
/// `headless` true   = run Edge silently in the background (subsequent launches)
/// `headless` false  = run Edge visibly so the user can sign in (first launch / expired cookies)
fn try_browser_download(
    edge_exe: &std::path::Path,
    user_data_dir: &std::path::Path,
    download_dir: &std::path::Path,
    sharepoint_url: &str,
    headless: bool,
    timeout_secs: u64,
) -> Result<ProjectData, String> {
    // Make sure our private download folder exists and is empty
    let _ = std::fs::create_dir_all(download_dir);
    if let Ok(entries) = std::fs::read_dir(download_dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }

    // Kill any existing Edge using our profile to avoid lock contention
    kill_edge_by_profile(user_data_dir);
    thread::sleep(Duration::from_millis(500));
    let _ = std::fs::remove_file(user_data_dir.join("SingletonLock"));
    let _ = std::fs::remove_file(user_data_dir.join("SingletonCookie"));
    let _ = std::fs::remove_file(user_data_dir.join("SingletonSocket"));

    // Delete any stale DevToolsActivePort so we read the fresh one Edge writes
    let devtools_file = user_data_dir.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&devtools_file);

    let user_data_arg = format!("--user-data-dir={}", user_data_dir.display());

    // CRITICAL CHANGE: we no longer trust --download-default-directory because
    // Edge ignores it in visible mode AND shows a "Open / Save as / Save"
    // prompt the user must click through. Instead we use the Chrome DevTools
    // Protocol command Browser.setDownloadBehavior with behavior=allowAndName
    // which forces every download to silently land in our chosen folder with
    // no prompt, regardless of mode or the user's Edge settings.
    //
    // For that to work we must enable remote debugging at launch (port=0 means
    // Edge picks any free port and writes it to the DevToolsActivePort file).
    let mut cmd = std::process::Command::new(edge_exe);
    cmd.arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-popup-blocking")
        .arg("--disable-extensions")
        .arg("--disable-session-crashed-bubble")
        .arg("--no-restore-state-check")
        .arg("--disable-features=InfiniteSessionRestore,DownloadBubble,DownloadBubbleV2,msDownloadPrompt")
        .arg("--remote-debugging-port=0")
        .arg(&user_data_arg);

    if headless {
        cmd.arg("--headless=new")
            .arg("--disable-gpu")
            .arg("--disable-software-rasterizer")
            .arg("--disable-dev-shm-usage");
    }

    // We deliberately do NOT pass the SharePoint URL as a positional argument
    // here, because we need to set the download behaviour via CDP BEFORE the
    // page is navigated. We navigate via CDP after the download policy is set.
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Edge: {}", e))?;
    let edge_pid = child.id();

    // Wait for Edge to expose its CDP port. The DevToolsActivePort file contains
    // two lines: the port number, and the WebSocket path for the browser endpoint.
    let mut ws_url: Option<String> = None;
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

    let ws_url = match ws_url {
        Some(url) => url,
        None => {
            kill_process_tree(edge_pid);
            kill_edge_by_profile(user_data_dir);
            return Err("Edge did not expose a DevTools port within 15 seconds (browser may have failed to start)".to_string());
        }
    };

    eprintln!("[fetch] Connecting to Edge DevTools at {}", ws_url);

    let browser = match Browser::connect(ws_url) {
        Ok(b) => b,
        Err(e) => {
            kill_process_tree(edge_pid);
            kill_edge_by_profile(user_data_dir);
            return Err(format!("Failed to connect to Edge DevTools: {}", e));
        }
    };

    // Get the initial tab (Edge always has one new-tab page when it starts).
    let tab = match browser.new_tab() {
        Ok(t) => t,
        Err(e) => {
            kill_process_tree(edge_pid);
            kill_edge_by_profile(user_data_dir);
            return Err(format!("Failed to get Edge tab: {}", e));
        }
    };

    // THE KEY CDP CALL: tell Edge to download silently to our private folder.
    // behavior=AllowAndName forces every download to a single deterministic
    // filename (no "(1)" suffix) in the dir we choose, with no prompt.
    let download_path = download_dir.to_string_lossy().to_string();
    let set_behavior = headless_chrome::protocol::cdp::Browser::SetDownloadBehavior {
        behavior: headless_chrome::protocol::cdp::Browser::SetDownloadBehaviorBehaviorOption::Allow,
        browser_context_id: None,
        download_path: Some(download_path.clone()),
        events_enabled: Some(true),
    };

    if let Err(e) = tab.call_method(set_behavior) {
        kill_process_tree(edge_pid);
        kill_edge_by_profile(user_data_dir);
        return Err(format!("Failed to set CDP download behaviour: {}", e));
    }
    eprintln!("[fetch] CDP download behaviour set on tab to: {}", download_path);

    // ALSO set the download behaviour on the BROWSER level - covers any new
    // tabs SharePoint might spawn for the download (e.g. a transient _blank tab
    // from the &download=1 link).
    let browser_set_behavior = headless_chrome::protocol::cdp::Browser::SetDownloadBehavior {
        behavior: headless_chrome::protocol::cdp::Browser::SetDownloadBehaviorBehaviorOption::Allow,
        browser_context_id: None,
        download_path: Some(download_path.clone()),
        events_enabled: Some(true),
    };
    // Use a fresh transport call directly on the browser (not the tab). The
    // headless_chrome API exposes this via call_method on Browser too when
    // Connection is available, but we approximate by calling on the same tab
    // - in CDP the Browser domain commands route to the browser regardless of
    // which target sent them.
    let _ = tab.call_method(browser_set_behavior);
    eprintln!("[fetch] CDP download behaviour also set at browser level");

    // Now navigate to SharePoint. We send the Page.navigate CDP command directly
    // instead of using tab.navigate_to(), because the latter waits for the load
    // event which never fires cleanly when SharePoint redirects through SSO.
    // We don't care about the page actually loading - we only care about the
    // file downloading, which happens regardless of the load event.
    eprintln!("[fetch] Navigating to SharePoint: {}", sharepoint_url);
    let navigate_params = headless_chrome::protocol::cdp::Page::Navigate {
        url: sharepoint_url.to_string(),
        referrer: None,
        transition_Type: None,
        frame_id: None,
        referrer_policy: None,
    };
    match tab.call_method(navigate_params) {
        Ok(_) => eprintln!("[fetch] Navigation command sent (not waiting for load)"),
        Err(e) => {
            kill_process_tree(edge_pid);
            kill_edge_by_profile(user_data_dir);
            return Err(format!("Failed to issue navigate command: {}", e));
        }
    }

    // Let the navigate start and the download policy kick in
    thread::sleep(Duration::from_millis(1500));

    // Listing the download dir contents now so we can see if there are any
    // partial files (e.g. .crdownload) showing the download started.
    if let Ok(entries) = std::fs::read_dir(download_dir) {
        for entry in entries.flatten() {
            eprintln!("[fetch]   downloads dir contains (initial): {}", entry.path().display());
        }
    }

    // Poll our private download folder for projects-data.json. Because we set
    // the CDP download behaviour to allowAndName with a fixed downloadPath,
    // Edge ALWAYS writes here, regardless of mode or user Edge settings.
    eprintln!(
        "[fetch] try_browser_download: starting CDP-driven poll (headless={}, timeout={}s, target_dir={})",
        headless, timeout_secs, download_dir.display()
    );

    let target_file_path = download_dir.join("projects-data.json");
    let mut found_file: Option<std::path::PathBuf> = None;
    let mut poll_count = 0;
    for _ in 0..(timeout_secs * 2) {
        thread::sleep(Duration::from_millis(500));
        poll_count += 1;
        if target_file_path.exists() {
            eprintln!("[fetch] Found in private dir (poll #{}): {}", poll_count, target_file_path.display());
            thread::sleep(Duration::from_millis(500)); // let write flush
            found_file = Some(target_file_path.clone());
            break;
        }
    }

    if found_file.is_none() {
        eprintln!("[fetch] Timed out after {} polls", poll_count);
        if let Ok(entries) = std::fs::read_dir(download_dir) {
            for entry in entries.flatten() {
                eprintln!("[fetch]   Found unrelated file in private dir: {}", entry.path().display());
            }
        }
    }

    // Clean up Edge regardless of outcome
    kill_process_tree(edge_pid);
    kill_edge_by_profile(user_data_dir);

    let target_file = match found_file {
        Some(p) => p,
        None => {
            return Err(format!(
                "Edge did not download projects-data.json to {} within {} seconds (CDP download behaviour may have been blocked)",
                download_dir.display(),
                timeout_secs
            ))
        }
    };

    // Read and parse the downloaded file. Edge may still be flushing the write
    // briefly after the file appears, and may even hold the file open for a
    // moment longer for tracking purposes. Retry a few times to handle that.
    let mut last_err = String::new();
    let mut parsed: Option<ProjectData> = None;
    for attempt in 1..=5 {
        thread::sleep(Duration::from_millis(500 * attempt));
        eprintln!(
            "[fetch]   read attempt #{} for {}",
            attempt,
            target_file.display()
        );
        match std::fs::read_to_string(&target_file) {
            Ok(content) => {
                // Strip UTF-8 BOM if present. PowerShell's Set-Content -Encoding UTF8
                // adds a BOM by default, which serde_json refuses to parse.
                let trimmed = content.trim_start_matches('\u{FEFF}');
                match serde_json::from_str::<ProjectData>(trimmed) {
                    Ok(data) => {
                        eprintln!("[fetch]   read+parse OK on attempt #{}", attempt);
                        parsed = Some(data);
                        break;
                    }
                    Err(e) => {
                        last_err = format!(
                            "JSON parse failed on attempt #{}: {} (content len={} bytes, first byte=0x{:02X})",
                            attempt,
                            e,
                            content.len(),
                            content.as_bytes().first().copied().unwrap_or(0)
                        );
                        eprintln!("[fetch]   {}", last_err);
                    }
                }
            }
            Err(e) => {
                last_err = format!("File read failed on attempt #{}: {}", attempt, e);
                eprintln!("[fetch]   {}", last_err);
            }
        }
    }

    let parsed = match parsed {
        Some(p) => p,
        None => {
            // Don't delete the file - leave it so user can see what was downloaded
            return Err(format!(
                "Edge downloaded the file but we could not read/parse it: {}",
                last_err
            ));
        }
    };

    // Remove the file from wherever Edge put it so we don't accumulate stale copies
    let _ = std::fs::remove_file(&target_file);

    Ok(parsed)
}

/// Mutex guarding fetch_project_data against concurrent invocation.
/// React Strict Mode in development calls every useEffect twice, which would
/// otherwise spawn two Edge windows racing to download the same file. The
/// mutex serialises the calls so only one Edge launch happens at a time.
static FETCH_PROJECT_DATA_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
    std::sync::OnceLock::new();

/// Fetches the project data JSON from SharePoint by driving Microsoft Edge
/// against the shared edge_profile. Falls back to a visible Edge window if the
/// headless attempt fails (likely because session cookies have expired or this
/// is the first launch). Falls back to the local cache file if even visible
/// Edge cannot fetch the data.
#[tauri::command]
async fn fetch_project_data(app_handle: tauri::AppHandle) -> Result<ProjectDataResult, String> {
    // Serialise concurrent invocations - React Strict Mode double-fires useEffect
    let lock = FETCH_PROJECT_DATA_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    eprintln!("[fetch] fetch_project_data acquired lock, starting work");

    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let cache_path = app_data.join("project-data-cache.json");
    let download_dir = app_data.join("downloads");
    let user_data_dir = app_data.join("edge_profile");
    let _ = std::fs::create_dir_all(&app_data);
    let _ = std::fs::create_dir_all(&user_data_dir);

    // Determine Edge executable path
    let edge_default =
        std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    let edge_exe = if edge_default.exists() {
        edge_default
    } else {
        std::path::PathBuf::from("msedge.exe")
    };

    // SharePoint URL from tauri.conf.json
    let config = app_handle.config();
    let url = config
        .plugins
        .0
        .get("config")
        .and_then(|c| c.get("projectDataUrl"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| "projectDataUrl missing in tauri.conf.json".to_string())?
        .to_string();

    // Stage 1: try headless Edge - if cookies are valid this is silent and fast
    let _ = app_handle.emit("activation-debug", "Fetching project list from SharePoint (silent)...");
    let headless_result = try_browser_download(
        &edge_exe,
        &user_data_dir,
        &download_dir,
        &url,
        true,
        20,
    );

    let parsed_data = match headless_result {
        Ok(data) => Some(data),
        Err(headless_err) => {
            // Stage 2: cookies likely expired - fall back to visible Edge
            let _ = app_handle.emit(
                "activation-debug",
                format!(
                    "First-time SharePoint sign-in needed. A browser window will open - sign in with your Hatch credentials and the window will close automatically. (silent attempt failed: {})",
                    headless_err
                ),
            );
            match try_browser_download(
                &edge_exe,
                &user_data_dir,
                &download_dir,
                &url,
                false,
                90,
            ) {
                Ok(data) => Some(data),
                Err(_visible_err) => None,
            }
        }
    };

    if let Some(data) = parsed_data {
        // Success - cache it and return
        if let Ok(serialized) = serde_json::to_string(&data) {
            let _ = std::fs::write(&cache_path, serialized);
        }
        let _ = app_handle.emit("activation-debug", "Database loaded successfully.");
        return Ok(ProjectDataResult {
            data,
            age_days: Some(0.0),
            from_cache: false,
        });
    }

    // Both browser attempts failed - try local cache
    if let Ok(cached) = std::fs::read_to_string(&cache_path) {
        if let Ok(parsed) = serde_json::from_str::<ProjectData>(&cached) {
            let age_days = std::fs::metadata(&cache_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs_f64() / 86400.0);
            let _ = app_handle.emit(
                "activation-debug",
                format!(
                    "Using cached project list ({} days old) - could not refresh from SharePoint",
                    age_days.map(|d| d.round() as u64).unwrap_or(0)
                ),
            );
            return Ok(ProjectDataResult {
                data: parsed,
                age_days,
                from_cache: true,
            });
        }
    }

    Err(
        "Could not fetch project data from SharePoint and no cache available.\n\nA browser window should have opened for you to sign in. If it did not appear, or if you cancelled the sign-in, please try again on the Hatch corporate network or VPN."
            .to_string(),
    )
}

#[tauri::command]
async fn ping_roam(app_handle: tauri::AppHandle) -> Result<bool, String> {
    // Lightweight reachability check for the ROAM server. Returns true if the
    // server responds within 5 seconds (any HTTP status counts as "reachable" -
    // even 401/403 means the server is up, just that we'd need fresh auth).
    // Used on app launch and by the Connect button to give fast feedback
    // without having to spin up a full Edge browser session.
    let _ = app_handle.emit("activation-debug", "Pinging ROAM server...");
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let (roam_url, _) = get_roam_config(&app_handle);
    match client.get(&roam_url).send().await {
        Ok(_response) => {
            // Successful ping = the existing NTLM auth is still good. Touch
            // the marker file so the "last connected X hours ago" banner
            // shows the time of THIS connection, not the original activation.
            if let Ok(dir) = app_handle.path().app_data_dir() {
                let marker = dir.join("edge_profile").join("activation_success.marker");
                let stamp = chrono::Local::now().to_rfc3339();
                let _ = std::fs::write(&marker, stamp);
            }
            Ok(true)
        }
        Err(e) => {
            if e.is_timeout() {
                Err("ROAM server did not respond within 5 seconds. Check your VPN/network connection.".to_string())
            } else if e.is_connect() {
                Err("Cannot reach the ROAM server. You may not be on the corporate network or VPN.".to_string())
            } else {
                Err(format!("Ping failed: {}", e))
            }
        }
    }
}

#[tauri::command]
async fn has_activation_marker(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let marker_path = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.join("edge_profile").join("activation_success.marker"))
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(marker_path.exists())
}

#[tauri::command]
async fn get_activation_age_hours(
    app_handle: tauri::AppHandle,
) -> Result<Option<f64>, String> {
    let marker_path = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.join("edge_profile").join("activation_success.marker"))
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    if !marker_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&marker_path)
        .map_err(|e| format!("Failed to read marker: {}", e))?;

    let timestamp = chrono::DateTime::parse_from_rfc3339(content.trim())
        .map_err(|e| format!("Failed to parse marker timestamp: {}", e))?;

    let age = chrono::Local::now().signed_duration_since(timestamp.with_timezone(&chrono::Local));
    let hours = age.num_seconds() as f64 / 3600.0;
    Ok(Some(hours))
}

#[tauri::command]
async fn clear_api_key(
    state: State<'_, ApiKeyState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    *state.0.lock().unwrap() = None;

    if let Ok(path) = app_handle.path().app_data_dir() {
        let key_path = path.join("key.cache");
        let _ = std::fs::remove_file(key_path);
    }

    Ok("API key cleared".to_string())
}

#[tauri::command]
async fn chat_with_ai(prompt: String, history: Vec<String>, state: State<'_, ApiKeyState>) -> Result<String, String> {
    let api_key = {
        let api_key_lock = state.0.lock().unwrap();

        if let Some(key) = api_key_lock.as_ref() {
            key.clone()
        } else {
            std::env::var("GEMINI_API_KEY")
                .map(|k| k.trim().to_string())
                .map_err(|_| {
                    "GEMINI_API_KEY environment variable not set and no API key provided in settings"
                        .to_string()
                })?
        }
    };

    let system_instructions = get_system_instructions();

    let full_context = if history.is_empty() {
        prompt
    } else {
        format!("{}\n{}", history.join("\n"), prompt)
    };

    // Build the request payload
    let request_body = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart {
                text: format!("{}\n\nUser Input: {}", system_instructions, full_context),
            }],
        }],
        generation_config: Some(GenerationConfig {
            max_output_tokens: Some(1024),
            temperature: Some(0.3),
        }),
    };

    // Create HTTP client with timeout
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Make the API request with retries for busy status (503)
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key={}", api_key);
    let max_retry_duration = Duration::from_secs(15);
    let start_time = std::time::Instant::now();

    let gemini_response: GeminiResponse = loop {
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("API request failed: {}", e))?;

        if response.status().is_success() {
            break response
                .json()
                .await
                .map_err(|e| format!("Failed to parse API response: {}", e))?;
        }

        let status = response.status();
        if status.as_u16() == 503 && start_time.elapsed() < max_retry_duration {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            continue;
        }

        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());

        match status.as_u16() {
            429 => return Err("You have reached the limit of your AI quota. Press CTRL + SHIFT + C to clear the current key and save a new key.".to_string()),
            503 => return Err("This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.".to_string()),
            _ => return Err(format!("API returned error {}: {}", status, error_text)),
        }
    };

    // Extract the AI's message
    let ai_text = gemini_response
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or_else(|| "No response from AI".to_string())?;

    // Validate the observation flag in Rust before returning to frontend
    if let Ok(mut json_val) = serde_json::from_str::<serde_json::Value>(&ai_text) {
        let is_valid = json_val["isValidObservation"].as_bool().unwrap_or(false);

        if !is_valid {
            // If invalid (Scenario A or B), remove all form-filling data fields from the JSON
            if let Some(obj) = json_val.as_object_mut() {
                let fields_to_remove = [
                    "project",
                    "exactLoc",
                    "date",
                    "time",
                    "isContractor",
                    "isWorkHours",
                    "obsType",
                    "obsSafe",
                    "officeLoc",
                    "details",
                    "action",
                    "category",
                    "cardType",
                ];
                for field in fields_to_remove {
                    obj.remove(field);
                }
            }
            return Ok(json_val.to_string());
        }
    }

    Ok(ai_text)
}

struct ApiKeyState(Mutex<Option<String>>);
struct CancellationState(Arc<AtomicBool>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ApiKeyState(Mutex::new(None)))
        .manage(CancellationState(Arc::new(AtomicBool::new(false))))
         .invoke_handler(tauri::generate_handler![
            submit_observation,
            submit_to_copilot,
            get_cached_key,
            store_api_key,
            chat_with_ai,
            clear_api_key,
            send_feedback,
            cancel_submission,
            activate_handshake,
            get_activation_age_hours,
            ping_roam,
            has_activation_marker,
            fetch_project_data
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

            // Clean up any zombie Edge processes left behind by a previous run.
            // Without this, a stale msedge.exe holding our profile lock causes
            // every subsequent Connect / Submit to silently fail because Edge
            // refuses to start a second instance with the same --user-data-dir.
            kill_zombie_roam_edges();

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_size(LogicalSize::new(800.0, 1000.0));
            }

            let ctrl_shift_c = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyC);
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app_handle, shortcut, event| {
                        if shortcut == &ctrl_shift_c && event.state() == ShortcutState::Pressed {
                            let key_state = app_handle.state::<ApiKeyState>();
                            *key_state.0.lock().unwrap() = None;
                            if let Ok(path) = app_handle.path().app_data_dir() {
                                let _ = std::fs::remove_file(path.join("key.cache"));
                            }
                            let _ = app_handle.emit("api-key-cleared", ());
                        }
                    })
                    .build(),
            )?;

            let app_handle = app.handle();
            let key_state = app_handle.state::<ApiKeyState>();
            if let Ok(path) = app_handle.path().app_data_dir() {
                let cache_path = path.join("key.cache");
                if let Ok(cached) = std::fs::read_to_string(cache_path) {
                    *key_state.0.lock().unwrap() = Some(cached.trim().to_string());
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
