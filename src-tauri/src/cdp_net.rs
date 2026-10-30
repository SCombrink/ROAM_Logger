// Watches a browser tab's network traffic over its DevTools connection,
// including requests made by the tab's background workers. Power BI fetches
// report data from a worker, which the tab-level network events used by
// headless_chrome do not see. Same approach as Edge's own DevTools: attach to
// every worker the page starts ("auto-attach") and enable network events in
// each of them.
//
// Kept free of Tauri code so it can be tested against a real browser.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::powerbi_dsr::base64_decode;

#[derive(Default)]
struct State {
    /// Bodies of responses whose address matched the filter.
    bodies: Vec<String>,
    /// Every response seen, grouped by "where it came from: host/path".
    requests: BTreeMap<String, usize>,
    /// Kinds of targets attached to (page, worker, ...).
    targets: Vec<String>,
    error: Option<String>,
}

pub struct NetCapture {
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<State>>,
    handle: Option<JoinHandle<()>>,
}

/// What a capture saw.
pub struct NetResult {
    pub bodies: Vec<String>,
    /// e.g. "worker wabi-north-europe-redirect.analysis.windows.net/explore/querydata x4"
    pub request_summary: Vec<String>,
    pub targets: Vec<String>,
    pub error: Option<String>,
}

/// Report data requests. Shared capacity uses .../explore/querydata;
/// Premium/Fabric capacity uses .../QueryExecutionService/.../public/query.
pub fn is_data_url(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("querydata") || u.contains("executequeries") || u.contains("queryexecutionservice") || u.split('?').next().unwrap_or("").ends_with("/public/query")
}

fn short_url(url: &str) -> String {
    let no_query = url.split(['?', '#']).next().unwrap_or(url);
    no_query.split_once("://").map(|(_, rest)| rest).unwrap_or(no_query).to_string()
}

impl NetCapture {
    /// Connects to a page's DevTools WebSocket (ws://host:port/devtools/page/ID)
    /// and starts recording in a background thread.
    pub fn start(page_ws_url: &str) -> Result<NetCapture, String> {
        let (mut socket, _) = tungstenite::connect(page_ws_url).map_err(|e| format!("DevTools connect: {}", e))?;
        if let MaybeTlsStream::Plain(s) = socket.get_mut() {
            let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(State::default()));
        state.lock().unwrap().targets.push("page".into());
        let (stop2, state2) = (stop.clone(), state.clone());
        let handle = std::thread::spawn(move || run(socket, stop2, state2));
        Ok(NetCapture { stop, state, handle: Some(handle) })
    }

    pub fn body_count(&self) -> usize {
        self.state.lock().unwrap().bodies.len()
    }

    /// Forgets the bodies seen so far (e.g. the opening page's data).
    pub fn clear_bodies(&self) {
        self.state.lock().unwrap().bodies.clear();
    }

    pub fn finish(mut self) -> NetResult {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let mut st = self.state.lock().unwrap();
        let mut reqs: Vec<(String, usize)> = std::mem::take(&mut st.requests).into_iter().collect();
        reqs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        NetResult {
            bodies: std::mem::take(&mut st.bodies),
            request_summary: reqs.into_iter().take(25).map(|(k, n)| format!("{} x{}", k, n)).collect(),
            targets: std::mem::take(&mut st.targets),
            error: st.error.take(),
        }
    }
}

impl Drop for NetCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

struct Conn {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Conn {
    fn send(&mut self, session: Option<&str>, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let mut msg = json!({ "id": self.next_id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = Value::from(s);
        }
        let _ = self.socket.send(Message::text(msg.to_string()));
        self.next_id
    }

    /// Network events, and following every worker the target starts.
    fn watch(&mut self, session: Option<&str>) {
        self.send(session, "Network.enable", json!({}));
        self.send(session, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }));
    }
}

fn run(socket: WebSocket<MaybeTlsStream<TcpStream>>, stop: Arc<AtomicBool>, state: Arc<Mutex<State>>) {
    let mut conn = Conn { socket, next_id: 0 };
    conn.watch(None);

    // (session, requestId) -> (url, target kind)
    let mut urls: HashMap<(String, String), (String, String)> = HashMap::new();
    // session -> target kind
    let mut kinds: HashMap<String, String> = HashMap::new();
    // command id of a pending getResponseBody
    let mut pending: HashMap<u64, ()> = HashMap::new();

    while !stop.load(Ordering::SeqCst) {
        let text = match conn.socket.read() {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
            Err(e) => {
                state.lock().unwrap().error = Some(format!("DevTools connection: {}", e));
                break;
            }
        };
        let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
        let session = msg["sessionId"].as_str().unwrap_or("").to_string();

        // Reply to a getResponseBody we sent.
        if let Some(id) = msg["id"].as_u64() {
            if pending.remove(&id).is_some() {
                let result = &msg["result"];
                if let Some(body) = result["body"].as_str() {
                    let text = if result["base64Encoded"].as_bool() == Some(true) { base64_decode(body) } else { Some(body.to_string()) };
                    if let Some(t) = text {
                        state.lock().unwrap().bodies.push(t);
                    }
                }
            }
            continue;
        }

        let params = &msg["params"];
        match msg["method"].as_str().unwrap_or("") {
            "Target.attachedToTarget" => {
                if let Some(child) = params["sessionId"].as_str().map(str::to_string) {
                    let kind = params["targetInfo"]["type"].as_str().unwrap_or("other").to_string();
                    state.lock().unwrap().targets.push(kind.clone());
                    kinds.insert(child.clone(), kind);
                    conn.watch(Some(&child));
                    conn.send(Some(&child), "Runtime.runIfWaitingForDebugger", json!({}));
                }
            }
            "Network.responseReceived" => {
                let (Some(rid), Some(url)) = (params["requestId"].as_str(), params["response"]["url"].as_str()) else { continue };
                let kind = kinds.get(&session).cloned().unwrap_or_else(|| "page".into());
                *state.lock().unwrap().requests.entry(format!("{} {}", kind, short_url(url))).or_insert(0) += 1;
                urls.insert((session.clone(), rid.to_string()), (url.to_string(), kind));
            }
            "Network.loadingFinished" => {
                let Some(rid) = params["requestId"].as_str() else { continue };
                if let Some((url, _)) = urls.remove(&(session.clone(), rid.to_string())) {
                    if is_data_url(&url) {
                        let s = (!session.is_empty()).then_some(session.as_str());
                        let id = conn.send(s, "Network.getResponseBody", json!({ "requestId": rid }));
                        pending.insert(id, ());
                    }
                }
            }
            _ => {}
        }
    }
}
