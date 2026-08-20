// Loro — the MCP client for an extension's program (ADR-0031; R5a contract §4).
//
// An extension's program is an MCP server over stdio and Loro is its client. This
// module is ONLY that: newline-delimited JSON-RPC 2.0, request/response
// correlation by `id`, a timeout on every call, and a stop that ends the process
// TREE. It knows nothing about the acervo, manifests, settings, views or Tauri —
// `ext.rs` owns all of that and consumes the frozen surface below.
//
// WHAT THIS FILE INHERITS FROM SCARS ALREADY PAID FOR IN THIS REPO
//
// 1. stderr is drained in its own thread FROM THE MOMENT OF SPAWN. Measured on
//    this machine (macOS 25.6): a child writing to a stderr pipe nobody reads
//    blocks after 17,408 bytes (17 KiB). Once it blocks it stops producing
//    stdout, EOF never arrives, and the call hangs forever — the bug chat.rs
//    documents at :562-576 and loops.rs copies at :2052-2058. The tail is a RING
//    of the last STDERR_TAIL_BYTES: for a process that lives for hours, the
//    recent lines are the ones a «não respondeu» screen needs.
// 2. Whoever takes the child reaps it, and reaps OUTSIDE the lock. With `wait()`
//    inside the state lock the trava stayed held for the whole life of the next
//    process and every call — including the cancel that was the only escape —
//    blocked on the main thread (chat.rs:438-451, :605-615). Enforced here by a
//    source-text test: no function in this file holds `.lock(` and calls
//    `.wait(`.
// 3. Nothing here waits without a deadline. `recv_timeout` on the caller's side
//    (the shape proc.rs:129-153 proves), never `recv()`. ADR-0022 §28 is the
//    third time a blocking read on the main thread froze the window.
// 4. No request or response body is ever logged: method, id, duration, counts
//    (BR-8). Enforced by a source-text test.
//
// WHAT IS NEW HERE. chat.rs's transport is ONE-SHOT: it writes the prompt, drops
// stdin (:556-558) and the reader loop ends at EOF; `handle_stream_line`
// dispatches on `v["type"]` only (:307-416). Measured: `grep -rn 'jsonrpc'` over
// `src/` returned zero hits before this file — there was no id, no pending map, no
// reply channel and no request counter anywhere in the backend. So the whole
// correlation half is new: an `AtomicI64` counter, a pending map registered
// BEFORE the write, one reader thread per process, and a `Mutex<ChildStdin>` kept
// OPEN for the life of the client (like lib.rs:1076's syscap, unlike chat.rs).
//
// The public surface is FROZEN by the R5a contract §8 (batch A) and is consumed
// by ext.rs (batch B). An item batch B does not call yet is a contract item, not
// dead code — the same reason ai.rs:366 carries this attribute; without it
// `make lint` (clippy -D warnings) would fail on an accessor R5b is the first to
// use.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// the constants
// ---------------------------------------------------------------------------

/// The MCP protocol revision Loro speaks. ASSUNÇÃO (contract §4.2): there was
/// nothing in this repo to measure it against — `ai.rs:457` still hardcodes
/// `mcp_available: false` — so it is frozen in ONE place, here, and a server that
/// answers with another revision is refused by name rather than tolerated.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// The name Loro introduces itself with in `initialize`.
pub const CLIENT_NAME: &str = "loro";

/// The stderr tail kept per process, as a RING (BR-8: a bounded tail for
/// diagnosis, never a growing buffer and never content of a transcript).
pub const STDERR_TAIL_BYTES: usize = 4000;

// The four timeouts, from contract §4.6 (ADR-0031 §4.8's proposed floors).
//
// MEASURED (macOS 25.6, this machine), against a stdio JSON-RPC fixture server:
//   · one request→reply round trip on an already-running server, n=300:
//     p50 0.011 ms, p95 0.019 ms, worst 15.6 ms;
//   · spawn + first `initialize` reply, n=10: p50 13.6 ms, p95 17.6 ms;
//   · a server that writes 1,035,195 bytes to stderr before answering still
//     answers in 36 ms, because the drain runs from spawn.
// So VIEW_MS is ~280x the worst spawn-and-answer observed and ~450,000x the p50
// round trip: these are ceilings for a program that has stopped answering, not
// budgets a healthy one can brush against.
//
// STILL AN ASSUNÇÃO: the numbers above were measured against fixture servers
// (a Python one and the shell one in this file's tests), NOT against
// `examples/extensions/mcp-python` — batch D writes that server, and it did not
// exist when this module was written. The contract's §4.6 obligation (write the
// p50/p95 of the real `loro/describe`, `loro/view` and `loro/action` here) is
// therefore OPEN, and is named as open instead of being quietly satisfied by a
// number measured somewhere else.
pub const HANDSHAKE_MS: u64 = 10_000;
pub const VIEW_MS: u64 = 5_000;
pub const ACTION_MS: u64 = 30_000;
pub const STOP_GRACE_MS: u64 = 2_000;

// A ceiling that drifts down into the measured floor stops being a ceiling. These
// are COMPILE-TIME assertions and not a test, for two reasons: clippy denies a
// runtime assert on constants (`assertions_on_constants`, and `make lint` runs
// with -D warnings), and a build that cannot hold the invariant should not
// produce a binary at all. 18 ms is the worst spawn+first-reply measured above.
const _: () = assert!(VIEW_MS >= 250 * 18);
const _: () = assert!(VIEW_MS < HANDSHAKE_MS); // a handshake spawns a process first
const _: () = assert!(HANDSHAKE_MS < ACTION_MS); // an action may ask a person
const _: () = assert!(STOP_GRACE_MS > GRACE_POLL_MS * 4); // the grace must be pollable

// The restart policy (`RESTART_MAX`, `RESTART_WINDOW_MS`) is deliberately NOT
// here: it is supervisor policy and lives with the supervisor (contract §5.5), so
// there is exactly one definition of each number.

// How often the grace period polls the child. A poll, never a blocking `wait()`:
// the grace is then bounded by STOP_GRACE_MS and by nothing else.
const GRACE_POLL_MS: u64 = 20;

/// Loro's own namespace on the wire. It is not squattable: a `loro/*` tool or
/// notification outside R5a's set is refused BY NAME (§4.2 check 4, §4.4).
pub const LORO_PREFIX: &str = "loro/";

/// The only `loro/*` tools R5a calls.
pub const LORO_R5A_TOOLS: [&str; 4] =
    ["loro/describe", "loro/view", "loro/action", "loro/settings"];

/// The only `loro/*` message R5a accepts FROM a server. `loro/propose_outbound`,
/// `loro/propose_material` and `loro/exec` are not in this round — and `loro/exec`
/// never will be (ADR-0031 §3.1) — so they take the refusal path instead of being
/// queued for a later version.
pub const LORO_R5A_NOTIFICATIONS: [&str; 1] = ["loro/view_invalidated"];

/// The reserved `loro/*` names Loro itself has words for. A refusal may PRINT one
/// of these, because it is Loro's own vocabulary; a `loro/*` name outside the set
/// was chosen by the extension's process and is untrusted text, so it is counted
/// and never printed (BR-8 — see the refusal branch in `ext.rs`).
pub const LORO_RESERVED_KNOWN: [&str; 3] = [
    "loro/propose_outbound",
    "loro/propose_material",
    "loro/exec",
];

/// One frame off the child's stdout, bounded.
///
/// MEASURED, this machine (macOS 25.6), reproducing the line this reader used to
/// be — `BufReader::new(stdout).lines()` over `sh -c "yes 0123456789 | tr -d
/// '\n'"`: the HOST's RSS went 18 MB → 34 → 50 → 66 → 81 → 97 MB in 3 s (~26
/// MB/s), «a line arrived» never printed and the reader never ended. `lines()`
/// builds ONE unbounded `String`, so a server that writes to stdout without a
/// newline — malicious, or just a progress bar, or a `print(..., end="")` in a
/// loop — grows the app's memory until the OS kills it. No timeout covers it: the
/// deadlines bound the WAIT for a reply, not the growth of a buffer.
///
/// This is the same class `spawn_stderr_drain` reads bytes to avoid, and its
/// comment names it. Here the frame IS the protocol unit, so the ceiling is per
/// frame: a longer one is DROPPED up to the next newline and counted. Failure then
/// becomes a state — the call in flight times out by name (ADR-0031 §9) — instead
/// of a host that dies of memory pressure.
pub const MAX_FRAME_BYTES: usize = 4_000_000;

/// A method name is a NAME. 80 bytes is four times the longest name in this
/// contract (`loro/propose_outbound`, 21) and the cap exists because the value is
/// chosen by the extension: without it, `method` was an unbounded string that a
/// refusal then interpolated into a log line (BR-8).
pub const MAX_METHOD_BYTES: usize = 80;

#[derive(Debug, PartialEq)]
pub enum Frame {
    Line(String),
    /// a frame past `MAX_FRAME_BYTES`, discarded up to the next newline
    Oversize(usize),
    End,
}

/// Read one frame with a byte ceiling. `Take` bounds the READ itself, which is the
/// whole point: nothing accumulates past `cap`, so the pathological case above
/// costs `cap` bytes once instead of the machine's memory.
pub fn next_frame<R: BufRead>(src: &mut R, cap: usize) -> Frame {
    let mut buf: Vec<u8> = Vec::new();
    let n = match src.take(cap as u64).read_until(b'\n', &mut buf) {
        Ok(0) => return Frame::End,
        Ok(n) => n,
        Err(_) => return Frame::End,
    };
    if buf.last() == Some(&b'\n') || n < cap {
        // `from_utf8_lossy`: a frame with invalid bytes is a frame that will not
        // decode, and refusing it as JSON is better than dropping it unread.
        return Frame::Line(String::from_utf8_lossy(&buf).into_owned());
    }
    // The frame is longer than the ceiling: burn the rest of it, in bounded bites.
    let mut burnt = n;
    loop {
        let mut sink: Vec<u8> = Vec::new();
        match src.take(cap as u64).read_until(b'\n', &mut sink) {
            Ok(0) => return Frame::Oversize(burnt),
            Ok(m) => {
                burnt += m;
                if sink.last() == Some(&b'\n') || m < cap {
                    return Frame::Oversize(burnt);
                }
            }
            Err(_) => return Frame::Oversize(burnt),
        }
    }
}

/// A `method` this reader will carry. Bounded, printable ASCII, and only the
/// characters a JSON-RPC method name is made of: a value outside this shape is not
/// a name, so it is not queued and it is never logged.
pub fn method_shape_ok(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= MAX_METHOD_BYTES
        && m.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'_' | b'-' | b'.'))
}

// A chatty server must not be able to grow the host's memory through the one
// channel it has. `view_invalidated` is idempotent — the tab re-asks for the view
// once — so dropping the surplus loses nothing.
const MAX_NOTES: usize = 64;

const JSONRPC: &str = "2.0";

const ERR_NO_ANSWER: &str = "err.ext_no_answer";
const ERR_BAD_PAYLOAD: &str = "err.ext_bad_payload";
const ERR_ACTION_FAILED: &str = "err.ext_action_failed";
const ERR_SPAWN: &str = "err.ext_spawn";

// ---------------------------------------------------------------------------
// the wire, as pure functions (testable with no process at all)
// ---------------------------------------------------------------------------

/// One JSON object, one line, `\n`-terminated. serde_json escapes every newline
/// inside a string, so a request can never span two lines however the params
/// look.
pub fn encode_request(id: i64, method: &str, params: &Value) -> String {
    let mut line = serde_json::to_string(&json!({
        "jsonrpc": JSONRPC,
        "id": id,
        "method": method,
        "params": params,
    }))
    .unwrap_or_default();
    line.push('\n');
    line
}

/// A notification: no `id`, no reply expected. A NULL `params` is omitted rather
/// than sent as `null`, because §4.2's literal wire for
/// `notifications/initialized` carries no `params` member at all.
pub fn encode_notification(method: &str, params: &Value) -> String {
    let mut v = json!({ "jsonrpc": JSONRPC, "method": method });
    if !params.is_null() {
        if let Some(o) = v.as_object_mut() {
            o.insert("params".to_string(), params.clone());
        }
    }
    let mut line = serde_json::to_string(&v).unwrap_or_default();
    line.push('\n');
    line
}

/// What can arrive on the server's stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum McpIncoming {
    Reply { id: i64, result: Value },
    RpcError { id: i64, code: i64 },
    Notification { method: String },
}

/// Parse one line. `None` means «ignored on purpose» and is the whole point: a
/// line that is not JSON, a JSON value that is not an object, a `jsonrpc` that is
/// not "2.0", a reply whose `id` is not an integer we could have sent, and a
/// server→client REQUEST (id + method, which R5a answers to nothing) all land
/// here. The reader must survive every one of them — a protocol change cannot be
/// allowed to bring the reader down (the discipline chat.rs:18-19, :306 states).
pub fn decode_line(line: &str) -> Option<McpIncoming> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    if obj.get("jsonrpc").and_then(Value::as_str) != Some(JSONRPC) {
        return None;
    }
    match obj.get("id").and_then(Value::as_i64) {
        Some(id) => {
            if let Some(e) = obj.get("error") {
                let code = e.get("code").and_then(Value::as_i64).unwrap_or(0);
                return Some(McpIncoming::RpcError { id, code });
            }
            let result = obj.get("result")?.clone();
            Some(McpIncoming::Reply { id, result })
        }
        None => {
            let method = obj.get("method").and_then(Value::as_str)?;
            Some(McpIncoming::Notification {
                method: method.to_string(),
            })
        }
    }
}

/// The Loro payload inside an MCP tool result: the JSON carried as TEXT in the
/// first content block (§4.3). Returns the BARE error code; the caller appends
/// `:<method>`, because only the caller knows which of the four calls this was.
///
/// `result.isError` is refused without propagating the server's own text: that
/// text is data from an untrusted caller and never reaches a screen raw
/// (ADR-0031 §13.2).
pub fn payload_of(result: &Value) -> Result<Value, String> {
    if result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(ERR_ACTION_FAILED.to_string());
    }
    let first = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .ok_or_else(|| ERR_BAD_PAYLOAD.to_string())?;
    if first.get("type").and_then(Value::as_str) != Some("text") {
        return Err(ERR_BAD_PAYLOAD.to_string());
    }
    let text = first
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| ERR_BAD_PAYLOAD.to_string())?;
    let parsed: Value = serde_json::from_str(text).map_err(|_| ERR_BAD_PAYLOAD.to_string())?;
    // All four documented payloads are objects. A bare scalar that happens to be
    // valid JSON is not one of them, and letting it through would move the
    // refusal to whoever indexes it later.
    if !parsed.is_object() {
        return Err(ERR_BAD_PAYLOAD.to_string());
    }
    Ok(parsed)
}

/// A `loro/*` tool name outside R5a's four → the refusal, by name. Handed the
/// whole `tools/list` so the FIRST offender is the one reported.
pub fn reserved_tool_refusal(names: &[String]) -> Option<String> {
    names
        .iter()
        .find(|n| n.starts_with(LORO_PREFIX) && !LORO_R5A_TOOLS.contains(&n.as_str()))
        .map(|n| format!("err.ext_reserved_name:{n}"))
}

/// A `loro/*` message arriving FROM the server outside R5a's one → refused by
/// name and dropped (§4.4). A non-`loro/` notification is somebody else's
/// business and is simply ignored.
pub fn reserved_notification_refusal(method: &str) -> Option<String> {
    if method.starts_with(LORO_PREFIX) && !LORO_R5A_NOTIFICATIONS.contains(&method) {
        return Some(format!("err.ext_reserved_name:{method}"));
    }
    None
}

fn rpc_error(code: i64) -> String {
    format!("err.ext_rpc:{code}")
}

// ---------------------------------------------------------------------------
// correlation: a reply belongs to the caller that asked for it
// ---------------------------------------------------------------------------

type Delivery = Result<Value, String>;

#[derive(Default)]
struct Pending {
    map: Mutex<HashMap<i64, Sender<Delivery>>>,
}

impl Pending {
    /// Registered BEFORE the write, always. Measured: a fixture server answers a
    /// round trip in 0.011 ms at p50 — the reply can be back before the writing
    /// thread reaches its next statement, and a map populated afterwards would
    /// drop it.
    fn register(&self, id: i64) -> Receiver<Delivery> {
        let (tx, rx) = mpsc::channel();
        if let Ok(mut m) = self.map.lock() {
            m.insert(id, tx);
        }
        rx
    }

    fn forget(&self, id: i64) {
        if let Ok(mut m) = self.map.lock() {
            m.remove(&id);
        }
    }

    /// `false` when nobody was waiting for this id: a duplicate reply, or a reply
    /// to a call that already timed out. Dropped, never applied to another id.
    fn deliver(&self, id: i64, d: Delivery) -> bool {
        let tx = match self.map.lock() {
            Ok(mut m) => m.remove(&id),
            Err(_) => None,
        };
        match tx {
            Some(tx) => tx.send(d).is_ok(),
            None => false,
        }
    }

    /// stdout hit EOF: the program is gone. Every waiter learns NOW instead of
    /// sitting out its own timeout — a stopped extension must not cost the person
    /// 30 seconds of a spinner it can already explain.
    fn fail_all(&self, code: &str) -> usize {
        let waiting: Vec<Sender<Delivery>> = match self.map.lock() {
            Ok(mut m) => m.drain().map(|(_, tx)| tx).collect(),
            Err(_) => Vec::new(),
        };
        let n = waiting.len();
        for tx in waiting {
            let _ = tx.send(Err(code.to_string()));
        }
        n
    }
}

/// Never `recv()`. A call that cannot answer must end by NAME, in bounded time —
/// this is the freeze class ADR-0022 §28 names, and it has cost this repo three
/// separate incidents.
fn await_reply(rx: &Receiver<Delivery>, timeout_ms: u64, method: &str) -> Delivery {
    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(d) => d,
        Err(RecvTimeoutError::Timeout) => Err(format!("err.ext_timeout:{method}")),
        // the reader thread is gone, so the process is gone
        Err(RecvTimeoutError::Disconnected) => Err(ERR_NO_ANSWER.to_string()),
    }
}

// ---------------------------------------------------------------------------
// the stderr ring and the notification queue
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StderrRing {
    buf: Vec<u8>,
    seen: usize,
}

impl StderrRing {
    /// A RING: the LAST bytes survive. Growing to the cap and then discarding
    /// would keep the first lines of a process that has been running for hours —
    /// exactly the lines that explain nothing about why it stopped answering now.
    fn push(&mut self, chunk: &[u8]) {
        self.seen = self.seen.saturating_add(chunk.len());
        self.buf.extend_from_slice(chunk);
        if self.buf.len() > STDERR_TAIL_BYTES {
            let cut = self.buf.len() - STDERR_TAIL_BYTES;
            self.buf.drain(..cut);
        }
    }

    /// Lossy on purpose: the ring cuts at a byte boundary, so a multi-byte
    /// character can be halved at the front. A replacement character in a
    /// diagnostic tail is better than dropping the tail.
    fn tail(&self) -> String {
        String::from_utf8_lossy(&self.buf).into_owned()
    }
}

#[derive(Default)]
struct Notes {
    seen: Mutex<Vec<String>>,
}

impl Notes {
    fn push(&self, method: &str) -> bool {
        match self.seen.lock() {
            Ok(mut g) => {
                if g.len() >= MAX_NOTES {
                    return false;
                }
                g.push(method.to_string());
                true
            }
            Err(_) => false,
        }
    }

    fn drain(&self) -> Vec<String> {
        match self.seen.lock() {
            Ok(mut g) => std::mem::take(&mut *g),
            Err(_) => Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

pub struct McpConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub handshake_ms: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
}

/// One live MCP server process. There is deliberately no `Drop` that kills:
/// stopping is a DECISION (drop stdin, grace, then the tree) and not a side
/// effect of a scope ending. The registry in `ext.rs` and the `ExitRequested`
/// arm in `lib.rs` own the lifecycle.
pub struct McpClient {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Pending>,
    notes: Arc<Notes>,
    err: Arc<Mutex<StderrRing>>,
    next_id: AtomicI64,
    pid: u32,
    handshake_ms: u64,
}

impl McpClient {
    /// `paths::which(program)` and then `proc::command(exe)`: ONE lookup answers
    /// for both the probe and the spawn. ADR-0030 is exactly the bug where they
    /// answered different questions about the same binary — the probe searched
    /// the known locations while `spawn` searched a process PATH a GUI launch had
    /// never had, so a working agent was reported missing.
    pub fn spawn(cfg: &McpConfig) -> Result<McpClient, String> {
        let program = cfg.program.trim();
        // A command is a NAME here, not a path: a path would be a second way to
        // reach a binary outside the pacote, and §5.7 gives the manifest one.
        if program.is_empty() || program.contains('/') || program.contains('\\') {
            return Err(format!("err.ext_program_path:{program}"));
        }
        let exe = crate::paths::which(program)
            .ok_or_else(|| format!("err.ext_program_missing:{program}"))?;
        let mut child = crate::proc::command(&exe)
            .args(&cfg.args)
            .current_dir(&cfg.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| ERR_SPAWN.to_string())?;
        let pid = child.id();
        let (stdin, stdout, stderr) =
            match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
                (Some(i), Some(o), Some(e)) => (i, o, e),
                _ => {
                    // No pipe means no protocol. Reaping here is safe: nothing is
                    // locked yet and nobody else can be holding this child.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ERR_SPAWN.to_string());
                }
            };
        let pending = Arc::new(Pending::default());
        let notes = Arc::new(Notes::default());
        let err = Arc::new(Mutex::new(StderrRing::default()));
        // Both threads start BEFORE the first write. The stderr one especially:
        // 17 KiB of undrained stderr is all it takes to wedge the child.
        spawn_stderr_drain(stderr, err.clone());
        spawn_reader(stdout, pending.clone(), notes.clone());
        info!(pid, "mcp client spawned");
        Ok(McpClient {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            pending,
            notes,
            err,
            next_id: AtomicI64::new(1),
            pid,
            handshake_ms: cfg.handshake_ms,
        })
    }

    /// The handshake's own half: `initialize`, the protocol check, then the
    /// `notifications/initialized` notification. The checks that need the
    /// MANIFEST — `serverInfo.name` vs `program.server`, and `loro/describe`
    /// being present — belong to the caller, which is the only side that has the
    /// manifest (§4.2 checks 3 and 5).
    pub fn initialize(&self) -> Result<McpServerInfo, String> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
        });
        let result = self.request("initialize", &params, self.handshake_ms, "initialize")?;
        let theirs = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if theirs.is_empty() {
            return Err(format!("{ERR_BAD_PAYLOAD}:initialize"));
        }
        if theirs != PROTOCOL_VERSION {
            return Err(format!("err.ext_protocol_unsupported:{theirs}"));
        }
        let info = result.get("serverInfo");
        let name = info
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if name.is_empty() {
            return Err(format!("{ERR_BAD_PAYLOAD}:initialize"));
        }
        let version = info
            .and_then(|s| s.get("version"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.notify("notifications/initialized", &Value::Null)?;
        Ok(McpServerInfo {
            name: name.to_string(),
            version,
            protocol_version: theirs.to_string(),
        })
    }

    /// The names only. R5a needs `tools/list` to answer two questions — is
    /// `loro/describe` there, and is any `loro/*` name squatted — and both are
    /// about names.
    pub fn list_tools(&self) -> Result<Vec<String>, String> {
        let result = self.request("tools/list", &json!({}), self.handshake_ms, "tools/list")?;
        let Some(arr) = result.get("tools").and_then(Value::as_array) else {
            return Err(format!("{ERR_BAD_PAYLOAD}:tools/list"));
        };
        Ok(arr
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect())
    }

    /// An MCP `tools/call`, returning the parsed JSON of `content[0].text`. Every
    /// refusal is named with the TOOL, not with the wire method: the person's
    /// screen is about `loro/view`, not about `tools/call`.
    pub fn call_tool(&self, name: &str, args: &Value, timeout_ms: u64) -> Result<Value, String> {
        let params = json!({ "name": name, "arguments": args });
        let result = self.request("tools/call", &params, timeout_ms, name)?;
        payload_of(&result).map_err(|code| format!("{code}:{name}"))
    }

    /// The `loro/*` notification method names received since the last drain. The
    /// CALLER decides what each one means: `reserved_notification_refusal` names
    /// the ones outside R5a's single accepted message.
    pub fn drain_notifications(&self) -> Vec<String> {
        self.notes.drain()
    }

    pub fn stderr_tail(&self) -> String {
        match self.err.lock() {
            Ok(g) => g.tail(),
            Err(_) => String::new(),
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Non-blocking, always: `try_wait` never waits, so a UI asking «is it
    /// running?» cannot be made to hang by the answer (contract §5.5's `sweep`
    /// depends on this).
    pub fn is_alive(&self) -> bool {
        match self.child.lock() {
            Ok(mut g) => match g.as_mut() {
                Some(c) => matches!(c.try_wait(), Ok(None)),
                None => false,
            },
            Err(_) => false,
        }
    }

    /// Drop stdin (the graceful signal — the shape lib.rs:1076 and :1163 prove),
    /// wait up to `grace_ms`, and only then kill the TREE from the snapshot given.
    ///
    /// This blocks for up to `grace_ms` on purpose and does NOT spawn a thread of
    /// its own: the caller owns the decision of where to block, and in a Tauri
    /// command that is the blocking pool, never the main thread (ADR-0022 §28).
    pub fn stop(self, grace_ms: u64, table: &[(u32, u32, String)]) {
        let _ = self.stop_counting(grace_ms, table);
    }

    /// `stop` with the kill count, which is what a test can see.
    fn stop_counting(self, grace_ms: u64, table: &[(u32, u32, String)]) -> usize {
        let pid = self.pid;
        self.close_stdin();
        let mut child = self.take_child();
        let graceful = match child.as_mut() {
            Some(c) => wait_up_to(c, grace_ms),
            // nobody to reap: already stopped, and killing a pid we no longer own
            // is how PID reuse turns into killing a stranger
            None => true,
        };
        let kills = if graceful { 0 } else { kill_tree(pid, table) };
        if let (false, Some(c)) = (graceful, child.as_mut()) {
            reap(c);
        }
        let err_bytes = self.err_seen();
        info!(pid, kills, err_bytes, graceful, "mcp client stopped");
        kills
    }

    // ---- the plumbing ----------------------------------------------------

    fn request(
        &self,
        method: &str,
        params: &Value,
        timeout_ms: u64,
        tool: &str,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let rx = self.pending.register(id);
        let started = Instant::now();
        if let Err(e) = self.write_line(&encode_request(id, method, params)) {
            self.pending.forget(id);
            return Err(e);
        }
        let out = await_reply(&rx, timeout_ms, tool);
        // the id leaves the map whether it answered, failed or timed out
        self.pending.forget(id);
        let ms = started.elapsed().as_millis() as u64;
        let ok = out.is_ok();
        info!(method = %method, tool = %tool, id, ms, ok, "mcp call");
        out
    }

    fn notify(&self, method: &str, params: &Value) -> Result<(), String> {
        self.write_line(&encode_notification(method, params))
    }

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut g = self.stdin.lock().map_err(|_| ERR_NO_ANSWER.to_string())?;
        let Some(w) = g.as_mut() else {
            return Err(ERR_NO_ANSWER.to_string());
        };
        // A broken pipe here means the program is gone, which is a state the
        // screen already knows how to say.
        w.write_all(line.as_bytes())
            .map_err(|_| ERR_NO_ANSWER.to_string())?;
        w.flush().map_err(|_| ERR_NO_ANSWER.to_string())?;
        Ok(())
    }

    /// Dropping the child's stdin IS the graceful stop signal.
    fn close_stdin(&self) {
        if let Ok(mut g) = self.stdin.lock() {
            let _ = g.take();
        }
    }

    /// Takes the child OUT of the mutex. Whoever takes it reaps it, and reaps
    /// outside the lock (chat.rs:438-451 is the incident).
    fn take_child(&self) -> Option<Child> {
        match self.child.lock() {
            Ok(mut g) => g.take(),
            Err(_) => None,
        }
    }

    fn err_seen(&self) -> usize {
        match self.err.lock() {
            Ok(g) => g.seen,
            Err(_) => 0,
        }
    }
}

/// THE FLOOR UNDER EVERY CALLER. `stop` is the door — it drops stdin, waits the
/// grace and only then kills the tree — but a handle can also simply go out of
/// scope, and until this existed that leaked the child.
///
/// MEASURED (this machine, as a test in this file): spawn an `McpClient` over
/// `sh -c 'sleep 30'`, `drop` it, wait 400 ms, `kill -0 <pid>` → the process was
/// still alive. In the app the same handle had also been removed from `st.procs`,
/// so nothing could reach it again for the rest of the session.
///
/// SAFE TO RUN TWICE, and safe against PID reuse: `take_child` has already emptied
/// the mutex on the `stop` path, so this sees `None` and does nothing; and when it
/// does see a child, that child is one this client spawned and has not reaped —
/// a pid nobody else can have yet.
impl Drop for McpClient {
    fn drop(&mut self) {
        let mut child = match self.child.lock() {
            Ok(mut g) => match g.take() {
                Some(c) => c,
                None => return,
            },
            Err(_) => return,
        };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return; // already exited; nothing to signal, and it is reaped
        }
        self.close_stdin();
        let kills = kill_tree(self.pid, &crate::process_table());
        reap(&mut child);
        warn!(
            pid = self.pid,
            kills, "mcp client dropped while its child was alive"
        );
    }
}

/// Polls; never blocks past the deadline.
fn wait_up_to(child: &mut Child, grace_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(grace_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return false,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(GRACE_POLL_MS));
    }
}

/// Collects the direct child after a tree kill. `kill_tree` already signalled
/// this pid; the `kill` here is the no-op that makes the function safe on its
/// own, and the `wait` is what stops a zombie living for the rest of the app's
/// life (the lesson chat.rs's `kill_current_child` states).
fn reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_stderr_drain(stderr: ChildStderr, sink: Arc<Mutex<StderrRing>>) {
    std::thread::spawn(move || {
        // Bytes, not lines: a server that floods stderr WITHOUT a newline would
        // otherwise build one unbounded «line» in the reader before the ring ever
        // saw it.
        let mut src = stderr;
        let mut chunk = [0u8; 1024];
        loop {
            match src.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut g) = sink.lock() {
                        g.push(&chunk[..n]);
                    }
                }
            }
        }
    });
}

fn spawn_reader(stdout: ChildStdout, pending: Arc<Pending>, notes: Arc<Notes>) {
    std::thread::spawn(move || {
        let mut ignored = 0usize;
        let mut other = 0usize;
        let mut oversize = 0usize;
        let mut rdr = BufReader::new(stdout);
        loop {
            // BOUNDED, and `next_frame` carries the measurement of what unbounded
            // cost: `lines()` here grew the host's memory 26 MB/s and delivered
            // nothing.
            let line = match next_frame(&mut rdr, MAX_FRAME_BYTES) {
                Frame::Line(l) => l,
                Frame::Oversize(bytes) => {
                    oversize += 1;
                    // BR-8: a COUNT of bytes. The frame itself is a body.
                    warn!(
                        bytes,
                        cap = MAX_FRAME_BYTES,
                        "mcp frame too long, discarded"
                    );
                    continue;
                }
                Frame::End => break,
            };
            match decode_line(&line) {
                Some(McpIncoming::Reply { id, result }) => {
                    pending.deliver(id, Ok(result));
                }
                Some(McpIncoming::RpcError { id, code }) => {
                    pending.deliver(id, Err(rpc_error(code)));
                }
                Some(McpIncoming::Notification { method }) => {
                    // A NAME, CHECKED BEFORE IT IS QUEUED. `MAX_NOTES` bounds how
                    // MANY notes are kept and never how big one is, so without this
                    // an extension could park an arbitrary string in the queue —
                    // and the refusal on the other side logged it (BR-8).
                    if !method_shape_ok(&method) {
                        ignored += 1;
                    } else if method.starts_with(LORO_PREFIX) {
                        if !notes.push(&method) {
                            warn!(kept = MAX_NOTES, "mcp notification dropped");
                        }
                    } else {
                        other += 1;
                    }
                }
                None => ignored += 1,
            }
        }
        let waiting = pending.fail_all(ERR_NO_ANSWER);
        info!(ignored, other, oversize, waiting, "mcp reader ended");
    });
}

// ---------------------------------------------------------------------------
// the tree kill
// ---------------------------------------------------------------------------
//
// MEASURED CORRECTION to ADR-0031 §2.5, which says ADR-0023 «already had to learn
// to kill a process tree on Windows». It did not: every kill site in the backend
// is `Child::kill()` on the DIRECT pid (lib.rs:460, 565, 647, 1064; chat.rs:449;
// loops.rs:1750, 1776, 2055, 2152), and `grep -rn 'taskkill|setsid|process_group|
// pre_exec|libc::' desktop/src-tauri/src/ desktop/src-tauri/Cargo.toml` returned
// ZERO hits. What already existed is the enumeration half — `process_table()` and
// `has_descendant_process` (lib.rs:4493, :4503, :4554). The kill is new here.
//
// PID REUSE IS REAL, and loops.rs:1252 already treats it as real. So the kill
// takes ONE snapshot, kills only pids whose parent chain reaches `root` IN THAT
// SNAPSHOT, and never re-derives a target from a pid alone.

/// Every descendant of `root` in this snapshot, LEAVES FIRST, root excluded.
/// The `HashSet` is not decoration: a process table can present a cycle (a pid
/// that is its own ancestor after a reuse), and without the guard the walk never
/// ends.
pub fn descendants_of(table: &[(u32, u32, String)], root: u32) -> Vec<u32> {
    let mut seen: HashSet<u32> = HashSet::new();
    seen.insert(root);
    let mut levels: Vec<Vec<u32>> = Vec::new();
    let mut frontier = vec![root];
    while !frontier.is_empty() {
        let mut next: Vec<u32> = Vec::new();
        for pid in &frontier {
            for (cpid, ppid, _) in table {
                if ppid == pid && seen.insert(*cpid) {
                    next.push(*cpid);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        levels.push(next.clone());
        frontier = next;
    }
    // deepest level first: a parent killed before its children can leave them
    // reparented to init and outliving the app
    levels.into_iter().rev().flatten().collect()
}

/// Kills the tree and returns how many pids were signalled.
///
/// Unix shells out to `kill -9` rather than calling `libc::kill`: there is no
/// `libc` crate in `Cargo.toml` (measured), and an additive round does not add a
/// dependency for one call.
#[cfg(not(windows))]
pub fn kill_tree(root: u32, table: &[(u32, u32, String)]) -> usize {
    let mut targets = descendants_of(table, root);
    targets.push(root);
    let mut killed = 0usize;
    for pid in targets {
        let arg = pid.to_string();
        let ok = crate::proc::command("kill")
            .args(["-9", arg.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            killed += 1;
        }
    }
    killed
}

/// Windows has its own tree kill, so `taskkill /T /F` is ONE call for the whole
/// tree. The count is therefore the size of the tree in the snapshot (root
/// included) and not a per-pid confirmation — stated here because a number that
/// means two different things per platform is worse than no number.
#[cfg(windows)]
pub fn kill_tree(root: u32, table: &[(u32, u32, String)]) -> usize {
    let arg = root.to_string();
    let ok = crate::proc::command("taskkill")
        .args(["/T", "/F", "/PID", arg.as_str()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        descendants_of(table, root).len() + 1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the wire, with no process at all ---------------------------------

    #[test]
    fn a_request_is_framed_as_one_json_line() {
        let line = encode_request(7, "tools/call", &json!({ "name": "loro/view" }));
        assert!(line.ends_with('\n'), "the newline IS the frame");
        assert_eq!(
            line.matches('\n').count(),
            1,
            "two newlines are two messages to the server"
        );
        let v: Value = serde_json::from_str(line.trim()).expect("one line, one object");
        assert_eq!(v["jsonrpc"], json!("2.0"));
        assert_eq!(v["id"], json!(7));
        assert_eq!(v["method"], json!("tools/call"));
        assert_eq!(v["params"]["name"], json!("loro/view"));
        // HOW TO SEE IT RED: drop the `line.push('\n')` in `encode_request` — this
        // count becomes 0 and the fixture server below never answers, because its
        // `read` is waiting for a line that never ends.
        let with_a_newline_inside = encode_request(8, "tools/call", &json!({ "t": "a\nb" }));
        assert_eq!(
            with_a_newline_inside.matches('\n').count(),
            1,
            "serde_json escapes the newline: a payload can never split the frame"
        );
    }

    #[test]
    fn a_notification_is_the_literal_wire_of_the_contract() {
        // The literal line of contract §4.2. Measured: Cargo.toml asks serde_json
        // for no features, so object keys are BTreeMap-sorted, and "jsonrpc" sorts
        // before "method" — the bytes match the contract, they are not merely
        // equivalent to it.
        assert_eq!(
            encode_notification("notifications/initialized", &Value::Null),
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n"
        );
        // a null `params` is OMITTED, not sent as null
        assert!(!encode_notification("x", &Value::Null).contains("params"));
        assert!(encode_notification("x", &json!({ "a": 1 })).contains("\"params\""));
    }

    #[test]
    fn an_unparseable_line_does_not_bring_the_reader_down() {
        // HOW TO SEE IT RED: make `decode_line` unwrap instead of returning None —
        // the first of these panics, and in the real reader that thread dies and
        // the extension never answers again.
        for bad in [
            "",
            "not json",
            "[1,2]",
            "{}",
            "{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":{}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1}",
            // a server→client REQUEST (id + method): R5a answers none, so it is
            // ignored on purpose rather than half-handled
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sampling/createMessage\",\"params\":{}}",
        ] {
            assert!(
                decode_line(bad).is_none(),
                "{bad:?} has to be ignored, never fatal"
            );
        }
        assert_eq!(
            decode_line("{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"ok\":true}}"),
            Some(McpIncoming::Reply {
                id: 4,
                result: json!({ "ok": true })
            })
        );
        assert_eq!(
            decode_line("{\"jsonrpc\":\"2.0\",\"method\":\"loro/view_invalidated\",\"params\":{}}"),
            Some(McpIncoming::Notification {
                method: "loro/view_invalidated".to_string()
            })
        );
    }

    // ---- correlation -------------------------------------------------------

    #[test]
    fn a_reply_reaches_the_caller_that_asked_for_it() {
        let p = Pending::default();
        let one = p.register(1);
        let two = p.register(2);
        // delivered OUT OF ORDER on purpose: the id is the only thing that decides
        // which caller gets which result.
        assert!(p.deliver(2, Ok(json!({ "who": 2 }))));
        assert!(p.deliver(1, Ok(json!({ "who": 1 }))));
        assert_eq!(
            one.recv_timeout(Duration::from_millis(500))
                .expect("id 1 answered")
                .expect("no error"),
            json!({ "who": 1 })
        );
        assert_eq!(
            two.recv_timeout(Duration::from_millis(500))
                .expect("id 2 answered")
                .expect("no error"),
            json!({ "who": 2 })
        );
        // HOW TO SEE IT RED: key the pending map by anything but the id (a single
        // slot, or the method name) and the two results swap.
        assert!(
            !p.deliver(1, Ok(json!({ "who": "late" }))),
            "a reply nobody waits for is dropped, never applied to another id"
        );
    }

    #[test]
    fn a_call_that_never_answers_times_out_by_name() {
        // HOW TO SEE IT RED: replace `recv_timeout` with `recv()` in `await_reply`.
        // The test does not fail — it HANGS, and `cargo test` never finishes. That
        // is the freeze class ADR-0022 §28 names, seen from the inside.
        let p = Pending::default();
        let rx = p.register(9);
        let t0 = Instant::now();
        let out = await_reply(&rx, 60, "loro/view");
        assert_eq!(out.unwrap_err(), "err.ext_timeout:loro/view");
        assert!(
            t0.elapsed() < Duration::from_millis(VIEW_MS),
            "the deadline belongs to the caller, not to the server: {:?}",
            t0.elapsed()
        );
        p.forget(9);
        assert!(
            !p.deliver(9, Ok(json!({}))),
            "a timed-out id leaves the map, so a late reply cannot land on the next call"
        );
    }

    #[test]
    fn a_rpc_error_is_named_not_swallowed() {
        assert_eq!(
            decode_line(
                "{\"jsonrpc\":\"2.0\",\"id\":5,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}"
            ),
            Some(McpIncoming::RpcError { id: 5, code: -32601 })
        );
        assert_eq!(rpc_error(-32601), "err.ext_rpc:-32601");
        // HOW TO SEE IT RED: have the reader turn an `error` object into
        // `Ok(Value::Null)`. The caller then renders nothing and says nothing —
        // the state that lies.
        let p = Pending::default();
        let rx = p.register(5);
        assert!(p.deliver(5, Err(rpc_error(-32601))));
        assert_eq!(
            await_reply(&rx, 500, "loro/action").unwrap_err(),
            "err.ext_rpc:-32601"
        );
    }

    #[test]
    fn a_payload_that_is_not_text_json_is_refused() {
        let good = json!({
            "isError": false,
            "content": [{ "type": "text", "text": "{\"loroView\":1}" }]
        });
        assert_eq!(payload_of(&good).unwrap(), json!({ "loroView": 1 }));
        // HOW TO SEE IT RED: index `content[0]` blindly and hand its `text` on. A
        // malformed server then crosses the boundary and the refusal moves to
        // whoever indexes the value later (ADR-0031 §13.2).
        for bad in [
            json!({ "content": [] }),
            json!({ "content": [{ "type": "image", "data": "x" }] }),
            json!({ "content": [{ "type": "text", "text": "not json" }] }),
            json!({ "content": [{ "type": "text", "text": "7" }] }),
            json!({}),
        ] {
            assert_eq!(
                payload_of(&bad).unwrap_err(),
                "err.ext_bad_payload",
                "{bad} crossed the boundary"
            );
        }
        let failed = json!({
            "isError": true,
            "content": [{ "type": "text", "text": "{\"a\":1}" }]
        });
        assert_eq!(payload_of(&failed).unwrap_err(), "err.ext_action_failed");
    }

    #[test]
    fn a_reserved_loro_name_is_refused_by_name() {
        let squatted: Vec<String> = ["buscar", "loro/view", "loro/exec"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            reserved_tool_refusal(&squatted),
            Some("err.ext_reserved_name:loro/exec".to_string()),
            "the loro/ prefix is Loro's and cannot be squatted"
        );
        let honest: Vec<String> = LORO_R5A_TOOLS
            .iter()
            .chain(["buscar"].iter())
            .map(|s| s.to_string())
            .collect();
        assert_eq!(reserved_tool_refusal(&honest), None);
        assert_eq!(reserved_notification_refusal("loro/view_invalidated"), None);
        assert_eq!(reserved_notification_refusal("notifications/message"), None);
        // not in R5a → refused by name and dropped, never queued for a later round
        for out_of_round in [
            "loro/propose_outbound",
            "loro/propose_material",
            "loro/exec",
        ] {
            assert_eq!(
                reserved_notification_refusal(out_of_round),
                Some(format!("err.ext_reserved_name:{out_of_round}"))
            );
        }
    }

    // ---- the ring, the tree, the constants ---------------------------------

    #[test]
    fn the_stderr_ring_keeps_the_last_bytes_not_the_first() {
        let mut ring = StderrRing::default();
        let pad = "x".repeat(1000);
        for i in 0..1024 {
            ring.push(format!("noise {i} {pad}\n").as_bytes());
        }
        ring.push(b"LAST-LINE-MARKER\n");
        let tail = ring.tail();
        // HOW TO SEE IT RED: stop pushing once the buffer reaches the cap (grow
        // and discard). The marker disappears and `noise 0` is still there — the
        // first lines of a process that ran for hours, which explain nothing about
        // why it stopped answering now.
        assert!(
            tail.len() <= STDERR_TAIL_BYTES,
            "a ring, not a buffer: {} bytes",
            tail.len()
        );
        assert!(
            tail.ends_with("LAST-LINE-MARKER\n"),
            "the LAST lines survive"
        );
        assert!(!tail.contains("noise 0 "));
        assert!(ring.seen > 1_000_000, "counted {} bytes", ring.seen);
    }

    #[test]
    fn descendants_of_is_leaves_first_and_survives_a_cycle() {
        // 100 → {200 → 300, 201}, an unrelated 999, and a CYCLE: 400 ↔ 401.
        let table: Vec<(u32, u32, String)> = vec![
            (200, 100, "sh".to_string()),
            (201, 100, "python3".to_string()),
            (300, 200, "node".to_string()),
            (400, 401, "a".to_string()),
            (401, 400, "b".to_string()),
            (999, 1, "unrelated".to_string()),
        ];
        let d = descendants_of(&table, 100);
        assert_eq!(
            d,
            vec![300, 200, 201],
            "leaves first: a parent killed before its children leaves them reparented and alive"
        );
        assert!(
            !d.contains(&100),
            "the root is excluded — it is killed last"
        );
        assert!(!d.contains(&999));
        // HOW TO SEE IT RED: remove the `seen` HashSet and run this line — the walk
        // never ends and the test hangs.
        assert_eq!(descendants_of(&table, 400), vec![401]);
    }

    #[test]
    fn a_program_is_a_name_and_a_missing_one_is_refused_by_name() {
        let path_not_name = McpConfig {
            program: "./bin/agent".to_string(),
            args: Vec::new(),
            cwd: std::env::temp_dir(),
            handshake_ms: 100,
        };
        assert_eq!(
            McpClient::spawn(&path_not_name).err().unwrap(),
            "err.ext_program_path:./bin/agent"
        );
        let absent = McpConfig {
            program: "loro-este-binario-nao-existe".to_string(),
            args: Vec::new(),
            cwd: std::env::temp_dir(),
            handshake_ms: 100,
        };
        assert_eq!(
            McpClient::spawn(&absent).err().unwrap(),
            "err.ext_program_missing:loro-este-binario-nao-existe",
            "the extension screen owns this sentence: it must not borrow the chat's err.agent_not_found"
        );
    }

    // ---- the two disciplines, asserted on this file's own source -----------

    fn before_the_tests(src: &str) -> String {
        // assembled, or this very module would be inside the range it scans
        let cut = format!("#[cfg({})]", "test");
        src.split(&cut).next().unwrap_or_default().to_string()
    }

    fn fn_bodies(src: &str) -> Vec<(String, String)> {
        let lines: Vec<&str> = src.lines().collect();
        let starts: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| {
                let t = l.trim_start();
                t.starts_with("fn ") || t.starts_with("pub fn ") || t.starts_with("pub(crate) fn ")
            })
            .map(|(i, _)| i)
            .collect();
        let mut out = Vec::new();
        for (k, &s) in starts.iter().enumerate() {
            let e = starts.get(k + 1).copied().unwrap_or(lines.len());
            let name = lines[s]
                .split("fn ")
                .nth(1)
                .and_then(|r| r.split('(').next())
                .unwrap_or("?")
                .trim()
                .to_string();
            out.push((name, lines[s..e].join("\n")));
        }
        out
    }

    #[test]
    fn nothing_is_reaped_while_a_lock_is_held() {
        // chat.rs:438-451 is the incident: with `wait()` inside the state lock the
        // trava stayed held for the whole life of the next process, and every call
        // — including the cancel, the only escape — blocked on the main thread.
        // The rule this file follows is structural: the function that LOCKS never
        // waits, and the function that WAITS never locks.
        //
        // HOW TO SEE IT RED: move the `reap(c)` call inside `take_child`'s
        // `if let Ok(mut g) = self.child.lock()` block.
        let src = before_the_tests(include_str!("mcp.rs"));
        let bodies = fn_bodies(&src);
        let waits: Vec<&(String, String)> = bodies
            .iter()
            .filter(|(_, b)| b.contains(".wait("))
            .collect();
        let locks = bodies.iter().filter(|(_, b)| b.contains(".lock(")).count();
        assert!(
            !waits.is_empty(),
            "the scanner went blind: nothing waits here"
        );
        assert!(
            locks >= 4,
            "the scanner went blind: only {locks} functions lock"
        );
        for (name, body) in waits {
            assert!(
                !body.contains(".lock("),
                "{name} holds a lock and reaps inside it — that is chat.rs's deadlock, again"
            );
        }
    }

    #[test]
    fn no_body_is_ever_logged() {
        // BR-8. A log line carries the method, the id, a duration and counts. Never
        // a request, never a reply, never a line of stderr — an extension's payload
        // can hold transcript content, and proc.rs:171 does not even log a PATH,
        // because a home directory is PII.
        //
        // HOW TO SEE IT RED: add `text = %payload` (or `line = %line`) to any log
        // macro in this file.
        let src = before_the_tests(include_str!("mcp.rs"));
        let mut calls: Vec<String> = Vec::new();
        for macro_name in ["info!(", "warn!(", "error!("] {
            for (i, _) in src.match_indices(macro_name) {
                let rest = &src[i..];
                let end = rest.find(");").map(|e| e + 2).unwrap_or(rest.len());
                calls.push(rest[..end].to_lowercase());
            }
        }
        assert!(
            calls.len() >= 4,
            "the scanner went blind: {} log calls",
            calls.len()
        );
        for call in &calls {
            for forbidden in [
                "text", "payload", "body", "content", "params", "result", "args", "stdout",
                "stderr", "prompt", "tail", "line",
            ] {
                assert!(
                    !call.contains(forbidden),
                    "BR-8 — a log must not carry {forbidden}: {call}"
                );
            }
        }
    }

    // ---- against a real process, over the real wire -------------------------
    //
    // The fixture server is a POSIX shell script, so these are `cfg(unix)`: on
    // Windows the same code is covered by the pure halves above, and its tree kill
    // (`taskkill /T /F`) has no fixture here — that is stated rather than faked.
    // No network, no external binary: /bin/sh is what proc.rs's own tests already
    // spawn.

    #[cfg(unix)]
    const FIXTURE: &str = r#"
while IFS= read -r l; do
  id=`printf '%s' "$l" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p'`
  [ -z "$id" ] && continue
  case "$l" in
    *initialize*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"0.1.0"}}}\n' "$id" ;;
    *tools/list*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"loro/describe"},{"name":"loro/view"}]}}\n' "$id" ;;
    *nope*) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id" ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{"isError":false,"content":[{"type":"text","text":"{\\"loroView\\":1,\\"id\\":%s}"}]}}\n' "$id" "$id" ;;
  esac
done
"#;

    // Writes 1,035,195 bytes to stderr BEFORE it ever reads stdin. Measured with
    // the stderr drained: the whole flood takes 36 ms and the server still answers.
    // Measured with it NOT drained (a python child, same machine): the writer
    // blocks after 17,408 bytes and never gets to read stdin at all.
    #[cfg(unix)]
    const NOISY: &str = r#"
pad=`printf '%01000d' 0`
i=0
while [ $i -lt 1024 ]; do printf 'noise %d %s\n' "$i" "$pad" >&2; i=$((i+1)); done
printf 'LAST-LINE-MARKER\n' >&2
while IFS= read -r l; do
  id=`printf '%s' "$l" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p'`
  [ -z "$id" ] && continue
  printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fixture","version":"0.1.0"}}}\n' "$id"
done
"#;

    #[cfg(unix)]
    fn sh_client(script: &str, handshake_ms: u64) -> McpClient {
        let cfg = McpConfig {
            program: "sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            cwd: std::env::temp_dir(),
            handshake_ms,
        };
        McpClient::spawn(&cfg).expect("/bin/sh is the fixture server and exists on every unix")
    }

    #[cfg(unix)]
    #[test]
    fn the_wire_works_against_a_shell_fixture() {
        let c = sh_client(FIXTURE, 5_000);
        let info = c.initialize().expect("the fixture answers initialize");
        assert_eq!(info.name, "fixture");
        assert_eq!(info.version, "0.1.0");
        assert_eq!(info.protocol_version, PROTOCOL_VERSION);
        assert!(c.pid() > 0);
        assert!(c.is_alive());
        assert_eq!(
            c.list_tools().expect("the fixture answers tools/list"),
            vec!["loro/describe".to_string(), "loro/view".to_string()]
        );
        let payload = c
            .call_tool("loro/view", &json!({ "lang": "pt" }), 5_000)
            .expect("the fixture answers tools/call");
        assert_eq!(payload["loroView"], json!(1));
        // the fixture echoes back the id it was sent: the correlation, proved on
        // the real wire and not only over the pending map
        assert_eq!(
            payload["id"],
            json!(3),
            "ids increment per client: initialize=1, tools/list=2, this call=3"
        );
        assert_eq!(
            c.call_tool("nope", &json!({}), 5_000).unwrap_err(),
            "err.ext_rpc:-32601"
        );
        // nothing arrived on the notification channel: the fixture sends none
        assert!(c.drain_notifications().is_empty());
        assert_eq!(c.stop_counting(STOP_GRACE_MS, &[]), 0);
    }

    // ================ the stdout frame is BOUNDED =========================

    // HOW TO SEE IT RED: call `read_until` without the `take(cap)` (which is what
    // `BufReader::lines()` does) and the first case below returns a `Line` of every
    // byte the source has.
    //
    // MEASURED, this machine, with the line this reader used to be
    // (`BufReader::new(stdout).lines()`) over `sh -c "yes 0123456789 | tr -d
    // '\n'"`: the HOST's RSS went 18 MB -> 34 -> 50 -> 66 -> 81 -> 97 MB in 3 s
    // (~26 MB/s), no line was ever delivered and the reader never ended. No
    // timeout covers that: the deadlines bound the WAIT for a reply, not the
    // growth of a buffer.
    #[test]
    fn a_frame_without_a_newline_stops_at_the_ceiling() {
        let cap = 64;
        // a flood with no newline at all: bounded, and named as discarded
        let flood = vec![b'x'; cap * 10];
        let mut r = std::io::Cursor::new(flood);
        assert_eq!(next_frame(&mut r, cap), Frame::Oversize(cap * 10));
        assert_eq!(next_frame(&mut r, cap), Frame::End);

        // a flood, then a REAL frame: the reader survives the flood and keeps
        // speaking the protocol — failure is a state, never a stall (§9)
        let mut body = vec![b'y'; cap * 3];
        body.push(b'\n');
        body.extend_from_slice(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        body.push(b'\n');
        let mut r2 = std::io::Cursor::new(body);
        assert_eq!(next_frame(&mut r2, cap), Frame::Oversize(cap * 3 + 1));
        let ok = next_frame(&mut r2, cap);
        match &ok {
            Frame::Line(l) => assert!(matches!(
                decode_line(l),
                Some(McpIncoming::Reply { id: 1, .. })
            )),
            other => panic!("the frame after a flood must still decode: {other:?}"),
        }
        assert_eq!(next_frame(&mut r2, cap), Frame::End);

        // and a frame exactly at the ceiling, with its newline, still arrives
        let mut exact = vec![b'z'; cap - 1];
        exact.push(b'\n');
        let mut r3 = std::io::Cursor::new(exact);
        assert!(matches!(next_frame(&mut r3, cap), Frame::Line(_)));

        // the shipped ceiling is a ceiling, not a limit a real view brushes: the
        // view document ceiling is 2000 nodes (extview.js MAX_NODES)
        assert!(MAX_FRAME_BYTES >= 1_000_000);
    }

    // BR-8. The `method` is chosen by the extension's process and a refusal used to
    // interpolate it into a LOGGED field, with `MAX_NOTES` bounding only HOW MANY
    // notes are kept. HOW TO SEE IT RED: drop the `method_shape_ok` call in
    // `spawn_reader` (this test pins the predicate; `ext.rs` pins the log).
    #[test]
    fn a_method_is_a_name_and_never_a_body() {
        assert!(method_shape_ok("loro/view_invalidated"));
        assert!(method_shape_ok("notifications/message"));
        for bad in ["", "loro/com espaco", "loro/quebra\nlinha", "loro/aspa\"x"] {
            assert!(!method_shape_ok(bad), "{bad:?}");
        }
        // 200 KB of transcript under a `loro/` prefix is the real shape of the leak
        let body = format!("loro/{}", "a".repeat(200_000));
        assert!(!method_shape_ok(&body));
        assert!(!method_shape_ok(&"b".repeat(MAX_METHOD_BYTES + 1)));
        assert!(method_shape_ok(&"c".repeat(MAX_METHOD_BYTES)));
        // and the reserved names Loro may PRINT are Loro's own vocabulary
        for r in LORO_RESERVED_KNOWN {
            assert!(r.starts_with(LORO_PREFIX) && method_shape_ok(r));
        }
        // THE WIRING, source-text: the shape is checked BEFORE the name is queued,
        // and the queue is the only thing `ext.rs` can log from.
        let src = before_the_tests(include_str!("mcp.rs"));
        let at = src.find("fn spawn_reader(").expect("the reader");
        let body = &src[at..];
        let check = body
            .find("method_shape_ok(&method)")
            .expect("the shape check");
        let push = body.find("notes.push(&method)").expect("the queue");
        assert!(check < push, "an unshaped name must not reach the queue");
    }

    // A HANDLE THAT GOES OUT OF SCOPE MUST NOT LEAVE A PROCESS BEHIND.
    //
    // MEASURED before `impl Drop for McpClient` existed: this exact test failed
    // with the child still answering `kill -0` 400 ms after the drop — and in the
    // app that handle had also been removed from `st.procs`, so nothing could
    // reach it again for the rest of the session.
    //
    // HOW TO SEE IT RED: delete `impl Drop for McpClient`.
    #[cfg(unix)]
    #[test]
    fn a_dropped_client_does_not_leave_its_child_running() {
        let c = sh_client("sleep 30\n", 1_000);
        let pid = c.pid();
        assert!(alive_pid(pid), "the fixture is running before the drop");
        drop(c);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && alive_pid(pid) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !alive_pid(pid),
            "pid {pid} survived the drop of its McpClient"
        );
    }

    #[cfg(unix)]
    fn alive_pid(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    #[test]
    fn stderr_is_drained_and_bounded() {
        // BR-8 and the deadlock in one test.
        //
        // HOW TO SEE IT RED: move `spawn_stderr_drain` from `spawn` to
        // `stop_counting`. The child blocks after ~17 KiB, never reads stdin, and
        // `initialize` fails with err.ext_timeout:initialize after the handshake
        // budget — which is the hang chat.rs:562-576 paid for, reproduced.
        let c = sh_client(NOISY, 5_000);
        let info = c
            .initialize()
            .expect("a server that floods stderr still gets its reply through");
        assert_eq!(info.name, "fixture");
        // The drain is a thread: the reply can arrive before the last chunk has
        // been consumed, so the assertion waits for the marker instead of racing
        // it.
        let mut tail = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            tail = c.stderr_tail();
            if tail.contains("LAST-LINE-MARKER") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            tail.contains("LAST-LINE-MARKER"),
            "the ring keeps the LAST lines, and they are the ones a «não respondeu» screen shows"
        );
        assert!(
            tail.len() <= STDERR_TAIL_BYTES,
            "a process that lives for hours must not grow the host: {} bytes",
            tail.len()
        );
        assert!(
            !tail.contains("noise 0 "),
            "the first lines are gone, on purpose"
        );
        let _ = c.stop_counting(STOP_GRACE_MS, &[]);
    }

    #[cfg(unix)]
    #[test]
    fn stop_drops_stdin_before_it_kills() {
        // A server that ends when its stdin ends — which is every well-behaved one
        // — but that takes about a second to get there. That delay is what makes
        // this test able to FAIL, and it was not in the first version: MEASURED, a
        // fixture that exits instantly is already gone by the time a kill would
        // run, `kill -9` fails on a dead pid, the count is 0 either way, and the
        // assertion stayed green with the grace period deleted. A test that could
        // not have been red is worse than none, because it is believed.
        //
        // HOW TO SEE IT RED: replace the graceful branch in `stop_counting` with an
        // unconditional `kill_tree(pid, table)`. `kills` becomes 1 — a server that
        // was shutting down cleanly gets killed anyway, every time.
        let c = sh_client("while IFS= read -r l; do :; done\nsleep 1\n", 1_000);
        let pid = c.pid();
        // a snapshot in which the root IS a valid, LIVE target, so a 0 here means
        // the grace period ended it and not that there was nothing left to kill
        let table: Vec<(u32, u32, String)> = vec![(pid, 1, "sh".to_string())];
        let t0 = Instant::now();
        assert_eq!(
            c.stop_counting(STOP_GRACE_MS, &table),
            0,
            "dropping stdin is the stop signal; a process that took it must never be killed"
        );
        assert!(
            t0.elapsed() >= Duration::from_millis(500),
            "the grace period was actually waited out: {:?}",
            t0.elapsed()
        );
    }
}
