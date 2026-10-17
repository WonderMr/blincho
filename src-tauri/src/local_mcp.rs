//! An opt-in, stateless MCP endpoint for local desktop integrations.
//!
//! This module owns no app actions. It serves the renderer's sanitized snapshot
//! and queues a small, expiring set of requests for the renderer to validate.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const PREFERRED_PORT: u16 = 47831;
const MAX_HEADERS: usize = 8192;
const MAX_BODY: usize = 65_536;
const MAX_QUEUE: usize = 16;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const SNAPSHOT_MAX_AGE: Duration = Duration::from_secs(10);
const COMMAND_MAX_AGE: Duration = Duration::from_secs(5);
const PROTOCOLS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Shared {
    status: McpStatus,
    snapshot: Option<(Value, Instant)>,
    commands: VecDeque<(McpCommand, Instant)>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCommand {
    name: String,
    timer_version: u64,
    break_event_id: Option<String>,
}

struct Server {
    stop: Arc<AtomicBool>,
    active: Arc<Mutex<Option<TcpStream>>>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct LocalMcp {
    shared: Arc<Mutex<Shared>>,
    server: Mutex<Option<Server>>,
}

// No app callbacks run under this lock. Recover a poisoned lock so disabling
// always retains the ability to revoke the listener and queued requests.
fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

impl LocalMcp {
    pub fn status(&self) -> McpStatus {
        lock(&self.shared).status.clone()
    }

    /// Enable a loopback listener, or close it and revoke its current token.
    pub fn configure(&self, enabled: bool) -> McpStatus {
        let mut server = lock(&self.server);
        if enabled
            && server
                .as_ref()
                .is_some_and(|server| !server.thread.is_finished())
        {
            return self.status();
        }
        // Revoke app action delivery before waiting for an in-flight socket.
        // A concurrent renderer poll must not drain commands during shutdown.
        {
            let mut shared = lock(&self.shared);
            shared.commands.clear();
            shared.snapshot = None;
            shared.status = McpStatus {
                enabled,
                ..McpStatus::default()
            };
        }
        if let Some(server) = server.take() {
            server.stop.store(true, Ordering::SeqCst);
            if let Some(stream) = lock(&server.active).as_ref() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            let _ = server.thread.join();
        }
        if !enabled {
            return self.status();
        }
        match self.start() {
            Ok(running) => *server = Some(running),
            Err(error) => lock(&self.shared).status.error = Some(error),
        }
        self.status()
    }

    pub fn publish(&self, snapshot: Value) {
        // The caller supplies the public projection, never its raw app state.
        if snapshot.is_object() && snapshot.to_string().len() <= MAX_BODY {
            let mut shared = lock(&self.shared);
            if shared.status.enabled && shared.status.running {
                shared.snapshot = Some((snapshot, Instant::now()));
            }
        }
    }

    pub fn take_commands(&self) -> Vec<McpCommand> {
        let mut shared = lock(&self.shared);
        if !shared.status.enabled || !shared.status.running {
            shared.commands.clear();
            return vec![];
        }
        shared
            .commands
            .drain(..)
            .filter(|(_, queued)| queued.elapsed() <= COMMAND_MAX_AGE)
            .map(|(command, _)| command)
            .collect()
    }

    pub fn shutdown(&self) {
        self.configure(false);
    }

    fn start(&self) -> Result<Server, String> {
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| "Unable to create local MCP token".to_string())?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, PREFERRED_PORT))
            .or_else(|_| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
            .map_err(|error| format!("Unable to start local MCP: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let active = Arc::new(Mutex::new(None::<TcpStream>));
        let shared = self.shared.clone();
        {
            let mut shared = lock(&shared);
            shared.status = McpStatus {
                enabled: true,
                running: true,
                url: Some(format!("http://127.0.0.1:{port}/mcp")),
                token: Some(token.clone()),
                error: None,
            };
        }
        let worker_stop = stop.clone();
        let worker_active = active.clone();
        let thread = thread::Builder::new()
            .name("blincho-local-mcp".into())
            .spawn(move || {
                while !worker_stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, peer)) => {
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            // Accepted sockets may inherit nonblocking mode on
                            // some platforms. Reads use an explicit deadline.
                            if stream.set_nonblocking(false).is_err() {
                                continue;
                            }
                            {
                                let mut active = lock(&worker_active);
                                if worker_stop.load(Ordering::SeqCst) {
                                    break;
                                }
                                match stream.try_clone() {
                                    Ok(clone) => *active = Some(clone),
                                    Err(_) => continue,
                                }
                            }
                            let response = handle_http(&mut stream, port, &token, &shared);
                            if !worker_stop.load(Ordering::SeqCst) {
                                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                                let _ = stream.write_all(&response.bytes());
                            }
                            let _ = stream.shutdown(Shutdown::Both);
                            *lock(&worker_active) = None;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(error) => {
                            let mut shared = lock(&shared);
                            shared.status.running = false;
                            shared.status.url = None;
                            shared.status.token = None;
                            shared.status.error = Some(format!("Local MCP stopped: {error}"));
                            shared.commands.clear();
                            break;
                        }
                    }
                }
            })
            .map_err(|error| {
                let mut shared = lock(&self.shared);
                shared.status.running = false;
                shared.status.url = None;
                shared.status.token = None;
                format!("Unable to start local MCP worker: {error}")
            })?;
        Ok(Server {
            stop,
            active,
            thread,
        })
    }
}

impl Drop for LocalMcp {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct HttpResponse {
    code: u16,
    body: Option<Value>,
}

impl HttpResponse {
    fn empty(code: u16) -> Self {
        Self { code, body: None }
    }
    fn json(code: u16, body: Value) -> Self {
        Self {
            code,
            body: Some(body),
        }
    }
    fn bytes(&self) -> Vec<u8> {
        let reason = match self.code {
            200 => "OK",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            408 => "Request Timeout",
            411 => "Length Required",
            413 => "Content Too Large",
            415 => "Unsupported Media Type",
            431 => "Request Header Fields Too Large",
            _ => "Bad Request",
        };
        let body = self.body.as_ref().map(Value::to_string).unwrap_or_default();
        let mut headers = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n", self.code, reason, body.len());
        if self.body.is_some() {
            headers.push_str("Content-Type: application/json\r\n");
        }
        if self.code == 401 {
            headers.push_str("WWW-Authenticate: Bearer realm=\"Blincho local MCP\"\r\n");
        }
        if self.code == 405 {
            headers.push_str("Allow: POST\r\n");
        }
        headers.push_str("\r\n");
        headers.push_str(&body);
        headers.into_bytes()
    }
}

fn read_chunk(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
    deadline: Instant,
) -> Result<(), HttpResponse> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(HttpResponse::empty(408));
    }
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| HttpResponse::empty(400))?;
    let mut chunk = [0_u8; 1024];
    match stream.read(&mut chunk) {
        Ok(0) => Err(HttpResponse::empty(400)),
        Ok(size) => {
            buffer.extend_from_slice(&chunk[..size]);
            Ok(())
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) =>
        {
            Err(HttpResponse::empty(408))
        }
        Err(_) => Err(HttpResponse::empty(400)),
    }
}

fn handle_http(
    stream: &mut TcpStream,
    port: u16,
    token: &str,
    shared: &Mutex<Shared>,
) -> HttpResponse {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let mut bytes = Vec::with_capacity(2048);
    let header_end = loop {
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            if end + 4 > MAX_HEADERS {
                return HttpResponse::empty(431);
            }
            break end + 4;
        }
        if bytes.len() >= MAX_HEADERS {
            return HttpResponse::empty(431);
        }
        if let Err(response) = read_chunk(stream, &mut bytes, deadline) {
            return response;
        }
    };
    let Ok(header_text) = std::str::from_utf8(&bytes[..header_end]) else {
        return HttpResponse::empty(400);
    };
    let mut lines = header_text[..header_end - 4].split("\r\n");
    let mut request = lines.next().unwrap_or("").split(' ');
    let method = request.next().unwrap_or("");
    let path = request.next().unwrap_or("");
    if request.next() != Some("HTTP/1.1") || request.next().is_some() {
        return HttpResponse::empty(400);
    }
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return HttpResponse::empty(400);
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value
                .bytes()
                .any(|byte| byte < 32 && byte != b'\t' || byte == 127)
            || headers.len() >= 40
            || headers
                .insert(name.to_ascii_lowercase(), value.trim())
                .is_some()
        {
            return HttpResponse::empty(400);
        }
    }
    let numeric_host = format!("127.0.0.1:{port}");
    let localhost_host = format!("localhost:{port}");
    if !headers
        .get("host")
        .is_some_and(|host| *host == numeric_host || host.eq_ignore_ascii_case(&localhost_host))
    {
        return HttpResponse::empty(403);
    }
    if let Some(origin) = headers.get("origin") {
        if *origin != format!("http://{numeric_host}")
            && *origin != format!("http://{localhost_host}")
        {
            return HttpResponse::empty(403);
        }
    }
    let expected = format!("Bearer {token}");
    if !headers
        .get("authorization")
        .is_some_and(|value| constant_time_equal(value.as_bytes(), expected.as_bytes()))
    {
        return HttpResponse::empty(401);
    }
    if path != "/mcp" {
        return HttpResponse::empty(404);
    }
    if method != "POST" {
        return HttpResponse::empty(405);
    }
    if headers
        .get("mcp-protocol-version")
        .is_some_and(|version| !PROTOCOLS.contains(version))
    {
        return HttpResponse::empty(400);
    }
    if headers.contains_key("transfer-encoding") {
        return HttpResponse::empty(400);
    }
    if !headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    }) {
        return HttpResponse::empty(415);
    }
    // Streamable HTTP clients advertise support for both response formats.
    if !headers.get("accept").is_some_and(|value| {
        let formats: Vec<_> = value
            .split(',')
            .map(|format| format.split(';').next().unwrap_or("").trim())
            .collect();
        formats.contains(&"application/json") && formats.contains(&"text/event-stream")
    }) {
        return HttpResponse::empty(400);
    }
    let Some(length) = headers.get("content-length") else {
        return HttpResponse::empty(411);
    };
    if length.is_empty() || !length.bytes().all(|byte| byte.is_ascii_digit()) {
        return HttpResponse::empty(400);
    }
    let Ok(length) = length.parse::<usize>() else {
        return HttpResponse::empty(413);
    };
    if length > MAX_BODY {
        return HttpResponse::empty(413);
    }
    while bytes.len() - header_end < length {
        if let Err(response) = read_chunk(stream, &mut bytes, deadline) {
            return response;
        }
    }
    match serde_json::from_slice::<Value>(&bytes[header_end..header_end + length]) {
        Ok(request) => dispatch(request, shared),
        Err(_) => HttpResponse::json(400, rpc_error(Value::Null, -32700, "Parse error")),
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn tool_result(value: Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value})
}

fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}

fn dispatch(request: Value, shared: &Mutex<Shared>) -> HttpResponse {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let notification = request.get("id").is_none();
    if !request.is_object()
        || request["jsonrpc"] != "2.0"
        || !request["method"].is_string()
        || request
            .get("params")
            .is_some_and(|params| !params.is_object())
        || (!notification && !id.is_string() && !id.is_number())
    {
        return HttpResponse::json(200, rpc_error(Value::Null, -32600, "Invalid request"));
    }
    // JSON-RPC notifications never produce a response body, even for an unknown
    // method. They cannot invoke tools or trigger app mutations.
    if notification {
        return HttpResponse::empty(202);
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match request["method"].as_str().unwrap_or("") {
        "initialize" => {
            let Some(version) = params["protocolVersion"].as_str() else {
                return HttpResponse::json(
                    200,
                    rpc_error(id, -32602, "protocolVersion is required"),
                );
            };
            let version = if PROTOCOLS.contains(&version) {
                version
            } else {
                PROTOCOLS[0]
            };
            json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"Blincho","version":env!("CARGO_PKG_VERSION")},"instructions":"Read timer status or request timer actions. Actions are queued for the app and may be rejected by its current state."})
        }
        "ping" => json!({}),
        "tools/list" => tools(),
        "tools/call" => {
            let Some(name) = params["name"].as_str() else {
                return HttpResponse::json(200, rpc_error(id, -32602, "Tool name is required"));
            };
            if params.get("arguments").is_some_and(|arguments| {
                !arguments.is_object()
                    || arguments
                        .as_object()
                        .is_some_and(|object| !object.is_empty())
            }) {
                return HttpResponse::json(
                    200,
                    rpc_error(id, -32602, "This tool takes no arguments"),
                );
            }
            match call_tool(name, shared) {
                Some(result) => result,
                None => return HttpResponse::json(200, rpc_error(id, -32602, "Unknown tool")),
            }
        }
        _ => return HttpResponse::json(200, rpc_error(id, -32601, "Method not found")),
    };
    HttpResponse::json(200, json!({"jsonrpc":"2.0","id":id,"result":result}))
}

fn tools() -> Value {
    let definitions = [
        ("get_status", "Read the current timer and break status.", true),
        ("get_settings", "Read the app's public settings.", true),
        ("get_today_stats", "Read today's aggregated timer statistics.", true),
        ("start_break", "Request a break through the app. Returns queued, not completed.", false),
        ("pause_timer", "Request pausing the work timer. Returns queued, not completed.", false),
        ("resume_timer", "Request resuming the work timer. Returns queued, not completed.", false),
        ("skip_break", "Request skipping a break. An unfinished strict break cannot be skipped. Returns queued, not completed.", false),
    ];
    json!({"tools":definitions.into_iter().map(|(name,description,read_only)| json!({
        "name":name,"description":description,
        "inputSchema":{"type":"object","properties":{},"additionalProperties":false},
        "annotations":{"readOnlyHint":read_only,"destructiveHint":false,"openWorldHint":false}
    })).collect::<Vec<_>>()})
}

fn call_tool(name: &str, shared: &Mutex<Shared>) -> Option<Value> {
    let key = match name {
        "get_status" => Some("status"),
        "get_settings" => Some("settings"),
        "get_today_stats" => Some("todayStats"),
        "start_break" | "pause_timer" | "resume_timer" | "skip_break" => None,
        _ => return None,
    };
    let mut shared = lock(shared);
    let Some((snapshot, published)) = shared.snapshot.as_ref() else {
        return Some(tool_error("App state is not available yet"));
    };
    if published.elapsed() > SNAPSHOT_MAX_AGE {
        return Some(tool_error("App state is out of date"));
    }
    if let Some(key) = key {
        return Some(
            snapshot
                .get(key)
                .filter(|value| value.is_object())
                .cloned()
                .map(tool_result)
                .unwrap_or_else(|| tool_error("App state is not available yet")),
        );
    }
    if !shared.status.enabled || !shared.status.running {
        return Some(tool_error("Local MCP is disabled"));
    }
    if ["strictMode", "isBreakActive", "breakElapsed"]
        .iter()
        .any(|key| !snapshot["status"][*key].is_boolean())
    {
        return Some(tool_error("App state is not available yet"));
    }
    if name == "skip_break"
        && snapshot["status"]["strictMode"] == true
        && snapshot["status"]["isBreakActive"] == true
        && snapshot["status"]["breakElapsed"] != true
    {
        return Some(tool_error("An unfinished strict break cannot be skipped"));
    }
    let Some(timer_version) = snapshot["status"]["timerVersion"].as_u64() else {
        return Some(tool_error("App state is not available yet"));
    };
    let break_event_id = match &snapshot["status"]["breakEventId"] {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => return Some(tool_error("App state is not available yet")),
    };
    shared
        .commands
        .retain(|(_, queued)| queued.elapsed() <= COMMAND_MAX_AGE);
    if shared.commands.len() >= MAX_QUEUE {
        return Some(tool_error("Too many app actions are waiting"));
    }
    shared.commands.push_back((
        McpCommand {
            name: name.into(),
            timer_version,
            break_event_id,
        },
        Instant::now(),
    ));
    Some(tool_result(json!({"status":"queued","action":name})))
}

#[cfg(test)]
mod tests {
    use super::*;
    static HTTP_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn app_snapshot(strict: bool) -> Value {
        json!({"status":{"isRunning":true,"strictMode":strict,"isBreakActive":true,"breakElapsed":false,"timerVersion":1,"breakEventId":"break-1"},"settings":{"strictMode":strict},"todayStats":{"breaks":2}})
    }

    fn test_shared() -> Mutex<Shared> {
        Mutex::new(Shared {
            status: McpStatus {
                enabled: true,
                running: true,
                ..McpStatus::default()
            },
            snapshot: Some((app_snapshot(false), Instant::now())),
            ..Shared::default()
        })
    }

    fn rpc(method: &str, params: Value) -> Value {
        json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
    }

    fn response_json(response: &str) -> Value {
        serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    fn request_at(url: &str, token: &str, method: &str, extra: &str, body: &str) -> String {
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let mut stream = TcpStream::connect(authority).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let request = format!("{method} /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n{extra}\r\n{body}", body.len());
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn raw_request(url: &str, request: &str) -> String {
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let mut stream = TcpStream::connect(authority).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        // Rejected oversized requests can leave unread input when the server
        // closes. Preserve the response even if TCP subsequently reports reset.
        if let Err(error) = stream.read_to_string(&mut response) {
            assert!(
                !response.is_empty() && error.kind() == std::io::ErrorKind::ConnectionReset,
                "{error}"
            );
        }
        response
    }

    #[test]
    fn initialize_tools_and_queued_actions() {
        let shared = test_shared();
        let initialize = dispatch(
            rpc("initialize", json!({"protocolVersion":"2025-11-25"})),
            &shared,
        );
        assert_eq!(
            initialize.body.as_ref().unwrap()["result"]["protocolVersion"],
            "2025-11-25"
        );
        let listing = dispatch(rpc("tools/list", json!({})), &shared);
        assert_eq!(
            listing.body.as_ref().unwrap()["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            7
        );
        let read = dispatch(
            rpc("tools/call", json!({"name":"get_today_stats"})),
            &shared,
        );
        assert_eq!(
            read.body.as_ref().unwrap()["result"]["structuredContent"]["breaks"],
            2
        );
        let action = dispatch(
            rpc("tools/call", json!({"name":"start_break","arguments":{}})),
            &shared,
        );
        assert_eq!(
            action.body.as_ref().unwrap()["result"]["structuredContent"]["status"],
            "queued"
        );
        assert_eq!(lock(&shared).commands[0].0.name, "start_break");
        assert_eq!(lock(&shared).commands[0].0.timer_version, 1);
        assert_eq!(
            lock(&shared).commands[0].0.break_event_id.as_deref(),
            Some("break-1")
        );
    }

    #[test]
    fn notifications_are_empty_and_cannot_mutate() {
        let shared = test_shared();
        for request in [
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"start_break"}}),
        ] {
            let response = dispatch(request, &shared);
            assert_eq!(response.code, 202);
            assert!(response.body.is_none());
        }
        assert!(lock(&shared).commands.is_empty());
    }

    #[test]
    fn malformed_rpc_and_unknown_tools_are_rejected() {
        let shared = test_shared();
        for request in [
            json!([]),
            json!({"jsonrpc":"2.0","id":null,"method":"ping"}),
            rpc("ping", json!([])),
        ] {
            assert_eq!(
                dispatch(request, &shared).body.unwrap()["error"]["code"],
                -32600
            );
        }
        assert_eq!(
            dispatch(rpc("tools/call", json!({"name":"lock_computer"})), &shared)
                .body
                .unwrap()["error"]["code"],
            -32602
        );
        assert_eq!(
            dispatch(
                rpc(
                    "tools/call",
                    json!({"name":"start_break","arguments":{"shell":"ignored"}})
                ),
                &shared
            )
            .body
            .unwrap()["error"]["code"],
            -32602
        );
    }

    #[test]
    fn strict_break_stale_state_and_queue_limit_reject_actions() {
        let shared = test_shared();
        lock(&shared).snapshot = Some((app_snapshot(true), Instant::now()));
        assert_eq!(call_tool("skip_break", &shared).unwrap()["isError"], true);
        assert!(lock(&shared).commands.is_empty());
        lock(&shared).snapshot = Some((
            app_snapshot(false),
            Instant::now() - SNAPSHOT_MAX_AGE - Duration::from_secs(1),
        ));
        assert_eq!(call_tool("start_break", &shared).unwrap()["isError"], true);
        lock(&shared).snapshot = Some((app_snapshot(false), Instant::now()));
        for _ in 0..MAX_QUEUE {
            assert!(call_tool("pause_timer", &shared)
                .unwrap()
                .get("isError")
                .is_none());
        }
        assert_eq!(call_tool("pause_timer", &shared).unwrap()["isError"], true);
    }

    #[test]
    fn commands_expire_and_disable_revokes_pending_work() {
        let app = LocalMcp::default();
        let command = |name: &str| McpCommand {
            name: name.into(),
            timer_version: 1,
            break_event_id: None,
        };
        {
            let mut shared = lock(&app.shared);
            shared.status.enabled = true;
            shared.status.running = true;
            shared.commands.push_back((
                command("start_break"),
                Instant::now() - COMMAND_MAX_AGE - Duration::from_secs(1),
            ));
            shared
                .commands
                .push_back((command("resume_timer"), Instant::now()));
        }
        assert_eq!(app.take_commands(), vec![command("resume_timer")]);
        lock(&app.shared)
            .commands
            .push_back((command("start_break"), Instant::now()));
        app.configure(false);
        assert!(app.take_commands().is_empty());
    }

    #[test]
    fn http_auth_origin_host_protocol_and_lifecycle() {
        let _test = lock(&HTTP_TEST_LOCK);
        let app = LocalMcp::default();
        assert!(!app.status().enabled);
        assert!(app.status().token.is_none());
        app.publish(app_snapshot(false));
        let status = app.configure(true);
        assert!(status.running, "{:?}", status.error);
        let url = status.url.as_ref().unwrap();
        let token = status.token.as_ref().unwrap();
        assert_eq!(token.len(), 64);
        assert!(url.starts_with("http://127.0.0.1:"));
        assert_eq!(app.configure(true).token.as_ref(), Some(token));
        let body = rpc("ping", json!({})).to_string();
        let valid = request_at(url, token, "POST", "", &body);
        assert!(valid.starts_with("HTTP/1.1 200"));
        assert_eq!(response_json(&valid)["result"], json!({}));
        assert!(request_at(url, "bad", "POST", "", &body).starts_with("HTTP/1.1 401"));
        assert!(
            request_at(url, token, "POST", "Origin: https://example.org\r\n", &body)
                .starts_with("HTTP/1.1 403")
        );
        assert!(
            request_at(url, token, "POST", "Host: example.org\r\n", &body)
                .starts_with("HTTP/1.1 400")
        );
        assert!(request_at(
            url,
            token,
            "POST",
            "MCP-Protocol-Version: unsupported\r\n",
            &body
        )
        .starts_with("HTTP/1.1 400"));
        assert!(request_at(url, token, "GET", "", "").starts_with("HTTP/1.1 405"));
        assert!(request_at(url, token, "POST", "", "invalid").starts_with("HTTP/1.1 400"));
        let notification = request_at(
            url,
            token,
            "POST",
            "",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        );
        assert!(notification.starts_with("HTTP/1.1 202"));
        assert!(notification.ends_with("\r\n\r\n"));
        let disabled = app.configure(false);
        assert!(!disabled.running && !disabled.enabled);
        assert!(disabled.url.is_none() && disabled.token.is_none());
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        assert!(TcpStream::connect(authority).is_err());
        let restarted = app.configure(true);
        assert!(restarted.running);
        assert_ne!(restarted.token.as_ref(), Some(token));
    }

    #[test]
    fn disable_closes_incomplete_request_without_waiting_for_deadline() {
        let _test = lock(&HTTP_TEST_LOCK);
        let app = LocalMcp::default();
        let status = app.configure(true);
        let url = status.url.unwrap();
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let mut stream = TcpStream::connect(authority).unwrap();
        stream.write_all(b"POST /mcp HTTP/1.1\r\nHost:").unwrap();
        thread::sleep(Duration::from_millis(80));
        let start = Instant::now();
        app.shutdown();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(TcpStream::connect(authority).is_err());
    }

    #[test]
    fn occupied_preferred_port_falls_back_to_an_available_loopback_port() {
        let _test = lock(&HTTP_TEST_LOCK);
        let _occupied = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, PREFERRED_PORT));
        let app = LocalMcp::default();
        let status = app.configure(true);
        assert!(status.running, "{:?}", status.error);
        assert_ne!(status.url.as_deref(), Some("http://127.0.0.1:47831/mcp"));
    }

    #[test]
    fn http_rejects_foreign_host_oversized_requests_and_ambiguous_framing() {
        let _test = lock(&HTTP_TEST_LOCK);
        let app = LocalMcp::default();
        let status = app.configure(true);
        let url = status.url.unwrap();
        let token = status.token.unwrap();
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let prefix = format!("POST /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nAccept: application/json,text/event-stream\r\nContent-Type: application/json\r\n");
        let foreign = format!("POST /mcp HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\n\r\n");
        assert!(raw_request(&url, &foreign).starts_with("HTTP/1.1 403"));
        assert!(
            raw_request(&url, &format!("{prefix}Content-Length: 65537\r\n\r\n"))
                .starts_with("HTTP/1.1 413")
        );
        assert!(raw_request(
            &url,
            &format!("{prefix}Content-Length: 0\r\nContent-Length: 0\r\n\r\n")
        )
        .starts_with("HTTP/1.1 400"));
        assert!(raw_request(
            &url,
            &format!("{prefix}Transfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n")
        )
        .starts_with("HTTP/1.1 400"));
        assert!(raw_request(
            &url,
            &format!(
                "{prefix}X-Large: {}\r\nContent-Length: 0\r\n\r\n",
                "x".repeat(MAX_HEADERS)
            )
        )
        .starts_with("HTTP/1.1 431"));
    }

    #[test]
    fn incomplete_body_has_a_bounded_request_deadline() {
        let _test = lock(&HTTP_TEST_LOCK);
        let app = LocalMcp::default();
        let status = app.configure(true);
        let url = status.url.unwrap();
        let token = status.token.unwrap();
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let request = format!("POST /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nAccept: application/json,text/event-stream\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{{");
        let start = Instant::now();
        assert!(raw_request(&url, &request).starts_with("HTTP/1.1 408"));
        assert!(start.elapsed() >= Duration::from_secs(2));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
