// Loro — extensions: the manifest, the supervisor and the three surfaces
// (ADR-0031, round R5a — source = a local directory only; nothing is downloaded
// and nothing is built).
//
// WHAT THIS FILE OWNS: `loro.json` v2, the install record `.loro/ext.json`, the
// settings files, the capability policy, the facts catalogue handed to the
// renderer, the process supervisor, and the thirteen `ext_*` commands. The
// JSON-RPC transport belongs to `crate::mcp`; nothing here knows about a pipe.
//
// FIVE RULES CARRY THE MODULE, and each one is a measurement rather than a
// preference:
//
//  1. NOTHING IS SPAWNED UNTIL SOMEBODY ASKS. `ext_list` never starts a process,
//     `ext_start` is the only door, and it is reached from a control a person
//     clicked. A fresh install with no extensions has to behave exactly like
//     today's app (ADR-0031 §3.9), and `a_fresh_install_with_no_extensions_spawns_nothing`
//     is what keeps it that way.
//
//  2. THE STATE IS A FACT, NEVER A SPINNER. `ExtRow.state` is one of the six
//     `EXT_STATES` and it is read from the registry, next to a `reason` that is a
//     stable `err.*` code. The registry is a MAP KEYED BY ID — deliberately not
//     `AppState`'s single `Mutex<Option<Child>>`, because `system_capture_start`
//     kills the previous child whenever a new one starts (`lib.rs:1062-1067`), and
//     copying that shape would mean «starting extension B stops extension A».
//     The precedents copied instead: `loops.rs:1156-1193` (a `HashMap` of
//     long-lived children plus a `turn` counter) and `meeting.rs:93` (a keyed map
//     for the long-lived sidecar).
//
//  3. NOBODY IS REAPED INSIDE THE LOCK. `chat.rs:438-451` held the state lock
//     across `wait()`, and every call — including the cancel that was the only
//     escape — then blocked on the main thread. Here the client is TAKEN out of
//     the map and stopped after the guard is dropped; `sweep()` only ever asks the
//     non-blocking `is_alive()`.
//
//  4. BR-1's ABSOLUTE HALF IS HELD BY ABSENCE. An extension has no audio API and
//     no filesystem API in R5a: when it needs a fact it reads one from §2's
//     catalogue, which LORO computed (`facts_from_graph` below) — nobody re-reads
//     markdown. A capability id naming `audio` is therefore a MANIFEST ERROR (the
//     capability does not exist), and a manifest declaring an audio-holding point
//     together with any `net.outbound` is refused at the door by name with
//     `err.ext_audio_network`: the one mutual exclusion with no consent path
//     (ADR-0031 §12 table, §8, `docs/adr/0031-…:882-884`).
//
//  5. BR-9: THE SECRET GATE IS AHEAD OF THE FIRST BYTE. A settings field naming a
//     credential refuses the whole install before anything is created, and every
//     planned write goes through `intake::scan` before it lands. The acervo is
//     versioned, so that door is one-way (ADR-0024).
//
// BR-8 ON THIS MODULE ITSELF: a log line here carries ids, counts and durations.
// Never a manifest value, never a view document, never a settings value, and
// never a path from inside somebody's home — `proc.rs:171` does not even log the
// PATH, because a home directory is PII.
//
// WHY THE FACTS GO THROUGH SERDE. `acervo::GraphNode` and `KnowledgeGraph` have
// PRIVATE fields (measured: `acervo.rs:2800-2834` — not one `pub`), and
// `acervo.rs` ends this round with a zero diff. The only additive read is the
// `#[derive(Serialize)]` those structs already carry, so `facts_from_graph` works
// over `serde_json::Value`. That is not a workaround: it is also what makes the
// facts builder a pure function a test can drive with a literal graph.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// the closed vocabularies
// ---------------------------------------------------------------------------

/// The six states a row may report. A `state` outside this list is a bug, and
/// `set_state` asserts it in debug: the screen paints a msgid per state, so an
/// unknown one would paint nothing and the row would lie by omission.
pub const EXT_STATES: [&str; 6] = [
    "stopped",
    "starting",
    "running",
    "no_answer",
    "crashed",
    "blocked",
];

/// The point set R5a implements. Everything else in `KNOWN_POINTS` is declared,
/// reported by name and installed by nobody (ADR-0031 §12).
pub const SUPPORTED_POINTS: [&str; 1] = ["surface"];
pub const SURFACE_POINT_VERSION: u32 = 1;

/// Every point ADR-0031 §12 names. Read so that a declaration can be REPORTED
/// instead of discarded: without the field, serde drops it in silence and the
/// install promises a path that does not exist (the lesson at `plugins.rs:100-102`).
pub const KNOWN_POINTS: [&str; 10] = [
    "surface",
    "tools",
    "facts",
    "material",
    "triage",
    "observable",
    "command",
    "transcriber",
    "renderer",
    "annotation",
];

/// The points whose process HOLDS AUDIO. ADR-0031 §12: a `transcriber` "is spawned
/// by Loro, holds audio, and is network-denied for its whole life".
pub const AUDIO_POINTS: [&str; 1] = ["transcriber"];

/// `kinds` is informational, exactly as it is today (`plugins.rs:455-470`): a value
/// outside this list is reported in `unsupported`, never an error.
pub const KNOWN_KINDS: [&str; 5] = ["skills", "seed", "loops", "program", "surface"];

/// The six settings kinds (§3.3). Anything else → `err.ext_settings_kind:<kind>`.
pub const SETTING_KINDS: [&str; 6] = ["string", "number", "bool", "enum", "path", "host"];

/// BR-9. A schema field whose `kind` is one of these, or whose `id` contains one,
/// refuses the whole install and NOTHING is written. Loro never asks for, stores
/// or logs a credential, so there is no field shape for one.
pub const SECRET_WORDS: [&str; 5] = ["secret", "token", "password", "key", "credential"];

/// Every `kind` a view node may carry (§1.2, §1.3, §1.4, §1.5). The renderer owns
/// the value alphabet; this module owns the boundary — an unknown primitive coming
/// off an untrusted reply is refused BY NAME here, before it crosses.
pub const VIEW_KINDS: [&str; 16] = [
    "stack", "row", "grid", "scroll", "text", "badge", "field", "button", "link", "doc", "divider",
    "spacer", "icon", "each", "when", "use",
];

/// §1.5's size ceiling, checked on the raw document before anything expands it.
pub const VIEW_NODE_MAX: usize = 2000;
/// A raw document may legally nest (a layout inside a layout); what it may not do
/// is nest deep enough to blow the stack of the walker that validates it. 64 is
/// the same order as the 1..=64 children each layout node admits.
pub const VIEW_TREE_DEPTH_MAX: u32 = 64;

// ---------------------------------------------------------------------------
// timeouts and the crash-loop budget
// ---------------------------------------------------------------------------
//
// WHERE THESE NUMBERS COME FROM, and what is still open. The four wire timeouts
// live in `mcp.rs` (re-exported below) and that file now carries the measurements:
// round trip on a running server n=300 p50 0.011 ms / p95 0.019 ms / worst 15.6 ms,
// spawn + first `initialize` n=10 p50 13.6 ms / p95 17.6 ms — so the ceilings are
// ~250x the worst spawn-and-answer observed, not budgets a healthy server brushes.
//
// STILL OPEN, and named instead of quietly satisfied: those figures were measured
// against FIXTURE servers, not against `examples/extensions/mcp-python` — which
// DOES exist in the tree now (`server/main.py`, `tests/protocol_test.py`) and is
// what §4.6 asks for the p50/p95 of the real `loro/describe`, `loro/view` and
// `loro/action` against. `RESTART_MAX`/`RESTART_WINDOW_MS` below remain the
// owner's call from ADR-0031 §4.8, unmeasured and labelled as such.
//
// (An earlier version of this comment said the fixture server «does not exist in
// the tree yet» and that the only measured timeout in the repo was `proc.rs:104`.
// Both were true when it was written and neither is true now — the note is
// corrected here rather than left for the next reader to act on. CLAUDE.md §7.1.)

// INTEGRATOR (E) — MEASURED, then fixed: the four wire timeouts had TWO
// definitions with the same values, here and at `mcp.rs:94-97`, and only THIS one
// was reachable — every call site below hands the ext.rs value to
// `mcp::McpConfig`, so editing `mcp::VIEW_MS` would have changed nothing while
// looking like it changed the deadline. Two definitions of one number is one of
// them being wrong later. `mcp` owns them (they are properties of the wire, and it
// is the side that enforces them); this re-export leaves every name below spelled
// exactly as it was. `RESTART_MAX`/`RESTART_WINDOW_MS` stay HERE: they are
// supervisor policy, not wire, and `mcp` deliberately does not define them.
pub use crate::mcp::{ACTION_MS, HANDSHAKE_MS, STOP_GRACE_MS, VIEW_MS};
/// How many spawns inside `RESTART_WINDOW_MS` before the supervisor stops trying.
/// Five retries spend the machine to learn what the first one already said.
pub const RESTART_MAX: u32 = 3;
pub const RESTART_WINDOW_MS: i64 = 60_000;

/// How often the notification drain thread of a running extension looks for a
/// `loro/view_invalidated`. It is a poll and not a blocking read because the
/// reader thread that owns the pipe is `mcp`'s, and this side must never hold the
/// registry lock while waiting for anything (rule 3).
const DRAIN_TICK_MS: u64 = 500;

// ---------------------------------------------------------------------------
// the types the screen sees
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtRow {
    pub id: String,
    pub name: String,
    pub version: String,
    /// one of EXT_STATES — a semantic enum; app.js turns it into a msgid at paint time
    pub state: String,
    /// stable err.* code when `state` is no_answer | crashed | blocked, else ""
    pub reason: String,
    /// epoch ms of the last successful reply, 0 when it never answered
    pub last_answer_ms: i64,
    pub has_surface: bool,
    pub has_program: bool,
    /// "" | "wide" — the surface's own layout choice (round 2), on the ROW so
    /// the tab can size the card before the first `ext_view` answers: a screen
    /// that jumps from 700px to wide after the fetch reads as a glitch.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub surface_layout: String,
    /// IS THERE A LIVE HANDLE TO STOP? Read from the registry, never deduced from
    /// `state`: `no_answer` means «it stopped ANSWERING», and `sweep` keeps the
    /// client precisely because the child is still alive. The screen used to offer
    /// «parar» for `running|starting` only, so the one control left for a hung
    /// program was «iniciar» — which spawned a SECOND child and dropped the first
    /// out of the registry, unreachable by `stop_all` for the rest of the session.
    pub can_stop: bool,
    pub kinds: Vec<String>,
    /// `.loro/ext.json` → source.path — where it was installed from
    pub origin: String,
    /// What «iniciar» would run, so the screen can NAME it before it runs. The
    /// record is versioned: the only screen that ever showed the command was the
    /// install sheet, which a pulled record never crosses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<ExtProgram>,
    /// Did somebody on THIS machine approve exactly this program? (see `trust_file`)
    pub trusted: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtProgram {
    pub protocol: String,
    pub server: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtSurfaceDecl {
    pub title: ExtI18n,
    pub served: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub view_file: String,
    /// "" (the 700px reading column, the default) | "wide" (the whole content
    /// column — owner decision 2026-08-20: a board is not reading, and 18
    /// columns in 700px is a wall). The pane rule holds either way: wide takes
    /// the COLUMN, never the window; overflow scrolls inside the view's own
    /// scroller. Same field for a manifest view and a served one — the layout
    /// is the surface's, not the transport's.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub layout: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ExtI18n {
    pub pt: String,
    pub en: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtCapabilityDecl {
    pub id: String,
    pub why: ExtI18n,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtSettingField {
    pub id: String,
    pub kind: String,
    pub escopo: String,
    pub label: ExtI18n,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<ExtI18n>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtCapability {
    pub id: String,
    pub label: String,
    /// "acervo" | "net" | "agent"
    pub kind: String,
    /// "" (never asked) | "granted" | "refused"
    pub decision: String,
    pub why: ExtI18n,
}

/// What the project decided, per extension id. Stored inside
/// `<acervo>/.loro/settings.json` under `ext`, beside the loops policy — project
/// policy travels with the project (ADR-0029 §4.18).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtPolicy {
    /// per extension id: capability ids the project granted
    #[serde(default)]
    pub permite: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub recusa: BTreeMap<String, Vec<String>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtPreview {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub source: String,
    pub kinds: Vec<String>,
    pub points: Vec<String>,
    /// declared-but-not-installed, said out loud (never dropped in silence)
    pub unsupported: Vec<String>,
    pub program: Option<ExtProgram>,
    pub surface: Option<ExtSurfaceDecl>,
    pub capabilities: Vec<ExtCapabilityDecl>,
    pub settings: Vec<ExtSettingField>,
    /// the declarative half, planned by crate::plugins::plan_for — one planner, not two
    pub writes: Vec<crate::plugins::PlannedWrite>,
    pub findings: Vec<crate::plugins::TriageFinding>,
    pub blocked: bool,
    pub conflicts: Vec<String>,
    pub installed: Option<String>,
    /// the trust sentence's subject: this extension will run a program on this machine
    pub trust: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtViewPayload {
    pub id: String,
    pub state: String,
    /// the ViewDocument, validated at the boundary; `null` when state != running
    pub view: Value,
    /// the facts catalogue of §2.1
    pub facts: Value,
    pub served_ms: i64,
    /// "manifest" (level 1) | "program" (level 2)
    pub source: String,
    /// the surface layout FROM THE ORIGIN's manifest ("" | "wide") — same
    /// re-read as the view, so a record older than the layout still paints it
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub surface_layout: String,
    /// the effective settings (declared defaults overlaid by what the person
    /// saved) — the HOST's copy, handed to the renderer as `ctx.settings` so a
    /// view can bind `{"$":"settings.<id>"}`. One copy for both levels; the
    /// extension's process never writes it (§5.5).
    pub settings: Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtActionOutcome {
    /// "ok" | "nothing" | "failed" — the loops vocabulary (loops.rs:2283-2330)
    pub outcome: String,
    pub message: ExtI18n,
    pub invalidate: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtInstallOutcome {
    pub id: String,
    pub version: String,
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    pub trust: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtRemoveOutcome {
    pub removed: Vec<String>,
    pub kept: Vec<String>,
    pub data_kept: bool,
    pub data_dir: String,
}

// ---------------------------------------------------------------------------
// the install record — <acervo>/.loro/ext.json
// ---------------------------------------------------------------------------
//
// IT IS VERSIONED, therefore IT IS UNTRUSTED INPUT. It is not in `GIT_IGNORED`
// (measured: 14 entries, `git.rs:2014-2029`, none of them `.loro/ext`), so it
// arrives in somebody else's commit — the same posture `brain_remove_plugin`
// takes at `plugins.rs:718-722`. Every path-shaped field is re-guarded at USE,
// and an EMPTY `sha256` means «I do not know», which is a reason to KEEP a file
// and never to delete it.

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtSource {
    /// `dir` in R5a. There is no other source: nothing is downloaded, nothing built.
    pub kind: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExt {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub source: ExtSource,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub points: Vec<String>,
    #[serde(default)]
    pub installed_at: String,
    /// the declarative half, exactly the shape plugins.rs records
    #[serde(default)]
    pub files: Vec<crate::plugins::InstalledFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<ExtProgram>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<ExtSurfaceDecl>,
    #[serde(default)]
    pub capabilities: Vec<ExtCapabilityDecl>,
    #[serde(default)]
    pub settings: Vec<ExtSettingField>,
}

fn record_path(base: &Path) -> PathBuf {
    base.join(".loro").join("ext.json")
}

/// A second record file, on purpose: `plugins::write_record` is private (measured,
/// `plugins.rs:231`) and `plugins.rs` ends this round with a zero diff. ONE WRITER
/// PER FILE. Stated consequence: `plugins::origin_of_file` will not attribute a
/// file an extension installed — which lies to nobody in R5a, because nothing an
/// extension installs is read by `loops::capabilities_of` (R5a writes no
/// `.mcp.json`). Collapsing the two records is R5b's decision, not a silent drift.
pub(crate) fn read_record(base: &Path) -> Vec<InstalledExt> {
    let all: Vec<InstalledExt> = std::fs::read_to_string(record_path(base))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<InstalledExt>>(&t).ok())
        .unwrap_or_default();
    let total = all.len();
    // THE DOOR OF THE RECORD. An entry whose id is not the shape `slugify`
    // produces is not an entry: it never came from `install_at`, and it is the
    // only field of this file that reaches a path sink without a guard of its own
    // (see `valid_ext_id`). Dropping it here is what makes `find_record` — which
    // every `*_at` calls first — the single choke point for the whole module.
    let list: Vec<InstalledExt> = all.into_iter().filter(|e| valid_ext_id(&e.id)).collect();
    if list.len() != total {
        // BR-8: a COUNT. The refused id is the untrusted value itself, and it can
        // be a home directory (`proc.rs:171` refuses that class of leak by name).
        warn!(
            refused = total - list.len(),
            "extension record entries refused: the id is not a name"
        );
    }
    list
}

fn write_record(base: &Path, list: &[InstalledExt]) -> Result<(), String> {
    let p = record_path(base);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "err.ext_write_failed".to_string())?;
    }
    std::fs::write(
        &p,
        serde_json::to_string_pretty(list).map_err(|_| "err.ext_write_failed".to_string())?,
    )
    .map_err(|_| "err.ext_write_failed".to_string())
}

/// THE CHOKE POINT. Every `*_at` core starts here, so an id that is not a name
/// stops at the door instead of reaching a `join`: the shape is checked on the
/// way in AND every entry of the record was checked on the way out
/// (`read_record`), which is what lets the path constructors below trust it.
fn find_record(base: &Path, id: &str) -> Result<InstalledExt, String> {
    if !valid_ext_id(id) {
        return Err("err.ext_not_found".to_string());
    }
    read_record(base)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "err.ext_not_found".to_string())
}

// ---------------------------------------------------------------------------
// the validators — pure, so every refusal is testable without a filesystem
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    crate::epoch_millis() as i64
}

/// `^[a-z][a-z0-9_-]{0,max}$` — the shape almost every id in this contract has.
fn ident_dash(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > max + 1 {
        return false;
    }
    if !b[0].is_ascii_lowercase() {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// THE ID OF AN INSTALLED EXTENSION, and the only shape a path may be built from.
///
/// It is exactly what produces it — `loops::slugify` → `git::sanitize_slug`
/// (`git.rs:1705-1723`): lowercase alphanumerics and `-`, never leading or
/// trailing, at most 50 characters. It is deliberately NOT `ident_dash`, which
/// requires a letter first and would refuse a legitimate `3d-mapa`.
///
/// WHY IT EXISTS. `.loro/ext.json` is versioned (`GIT_IGNORED` has 14 entries and
/// none of them is `.loro/ext` — `git.rs:2014-2029`), so this id arrives in
/// somebody else's change, and it is concatenated into system paths whose other
/// end is `remove_dir_all`. MEASURED, this machine, with the same `PathBuf::join`
/// the sinks use: `join("/private/tmp/absoluta")` is `/private/tmp/absoluta` — an
/// absolute right side DISCARDS the base — and `join("../../vitima")` is
/// `/Users/x/vitima`. An unguarded id therefore deletes any folder on the disk and
/// writes `settings.json` anywhere. `rel` was already guarded at USE for exactly
/// this reason (`remove_at`); the id was not.
fn valid_ext_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 50 {
        return false;
    }
    if b[0] == b'-' || b[b.len() - 1] == b'-' {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `^[a-z][a-z0-9_]{0,47}$` — a button's `action` (§1.3).
fn ident_snake(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > max + 1 {
        return false;
    }
    if !b[0].is_ascii_lowercase() {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// BR-9. True when this word names a credential — checked against the whole `kind`
/// and against any position of the `id`, case-insensitively (§3.3).
fn names_a_credential(s: &str) -> bool {
    let low = s.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| low.contains(w))
}

/// §5.8's capability grammar. It is the LOOPS vocabulary, not a second one
/// (ADR-0029 §4.15): the four `acervo.read` scopes are the same four a loop's
/// escopo already uses.
///
/// BR-1: anything containing `audio` is refused, at any position. The absolute
/// half of BR-1 is held by the ABSENCE of an API, so asking for it by name is a
/// manifest error and not a permission question.
pub fn valid_capability_id(id: &str) -> bool {
    if id.trim() != id || id.is_empty() || id.len() > 120 {
        return false;
    }
    if id.to_ascii_lowercase().contains("audio") {
        return false;
    }
    match id {
        "acervo.read:projeto" | "acervo.propose" | "agent.tools" => return true,
        _ => {}
    }
    if let Some(rest) = id.strip_prefix("acervo.read:ideia:") {
        return cap_slug(rest);
    }
    if let Some(rest) = id.strip_prefix("acervo.read:conhecimento:") {
        return cap_slug(rest);
    }
    if let Some(rest) = id.strip_prefix("acervo.read:pasta:") {
        return cap_rel(rest);
    }
    if let Some(rest) = id.strip_prefix("net.outbound:") {
        return cap_host(rest);
    }
    false
}

/// `safe_tool_name`-GRADE CHARACTERS (`loops.rs:769-771`), and only the characters:
/// that function also refuses `Bash` and a bare `*`, and both of those rules are
/// about a TOOL name. A knowledge slug called `bash` is a legitimate slug.
fn cap_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// An acervo-relative folder: no `..` segment, no leading `/`, forward slashes.
fn cap_rel(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('/')
        && !s.contains('\\')
        && !s.split('/').any(|seg| seg == ".." || seg.is_empty())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/'))
}

/// `^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$`. A BARE `*` IS REFUSED, exactly as
/// `safe_tool_name` refuses one (`loops.rs:775-777`): «tudo, sem perguntar» under
/// another spelling is still «tudo, sem perguntar».
fn cap_host(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 63 {
        return false;
    }
    let ok = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    if !ok(b[0]) || !ok(b[b.len() - 1]) {
        return false;
    }
    b.iter().all(|c| ok(*c) || *c == b'.' || *c == b'-')
}

/// "acervo" | "net" | "agent" — the family a capability belongs to, so the sheet
/// can group them. Derived from the id, never declared: a declared family would be
/// a second assertion to keep in step with the first.
fn capability_kind(id: &str) -> &'static str {
    if id.starts_with("net.") {
        "net"
    } else if id.starts_with("agent.") {
        "agent"
    } else {
        "acervo"
    }
}

/// §5.7 — one argv token. This is `loops::safe_cli_value` (`loops.rs:821`) WIDENED
/// for a relative path, never a relaxation of it: `safe_cli_value` stays untouched
/// and keeps governing the agent's own command line.
///
/// The tokens are LITERAL argv. There is no shell, no interpolation and no
/// redirection anywhere on this path, which is why the metacharacter list is a
/// refusal and not an escape.
pub fn valid_argv_token(t: &str) -> bool {
    if t.trim() != t || t.is_empty() || t.len() > 200 {
        return false;
    }
    if t.chars().any(|c| c.is_ascii_control()) {
        return false;
    }
    const REFUSED: [char; 12] = [';', '|', '&', '$', '`', '<', '>', '*', '?', '"', '\'', '\\'];
    if t.chars().any(|c| REFUSED.contains(&c)) {
        return false;
    }
    if t.starts_with('-') {
        // a flag: ^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*$ (an `=value` half is allowed
        // because that is one argv token, not two)
        let body = t.trim_start_matches('-');
        if t.len() - body.len() > 2 || body.is_empty() {
            return false;
        }
        let mut cs = body.chars();
        let first = cs.next().unwrap_or(' ');
        return first.is_ascii_alphanumeric()
            && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '='));
    }
    // a relative path token
    !t.starts_with('/') && !t.split('/').any(|seg| seg == "..")
}

/// §5.7 — THE PROGRAM HALF, VALIDATED. It is its own function because it has to
/// run TWICE, at two moments, over two different readings of the same data:
/// `parse_manifest` reads it from the pacote's `loro.json` at install time, and
/// `start_at` reads it back from `.loro/ext.json` — a VERSIONED file, therefore
/// untrusted input — immediately before the argv reaches a spawn.
///
/// MEASURED, and the reason this exists: `valid_argv_token` was reachable ONLY
/// from `parse_manifest`, and `parse_manifest` is called only by `manifest_view`
/// and `preview_at`. `start_at` cloned `rec.program.args` straight into
/// `McpConfig`, and `mcp::McpClient::spawn` re-guards only the COMMAND. So a record
/// arriving in somebody else's change with `{"command":"sh","args":["-c","curl …
/// | sh"]}` was executed at the first click on «iniciar» — no install, no trust
/// sheet, no triage. The order of the refusals is frozen because tests read it:
/// protocol → server → command → args → cwd.
pub(crate) fn validate_program(p: &ExtProgram) -> Result<(), String> {
    if p.protocol != "mcp/stdio" {
        return Err(format!("err.ext_protocol_unsupported:{}", p.protocol));
    }
    if !ident_dash(&p.server, 39) {
        return Err("err.ext_manifest_invalid".into());
    }
    if p.command.is_empty() {
        return Err("err.ext_manifest_invalid".into());
    }
    // ADR-0031 §3.6.1 — «a program name resolved through paths::which, never a
    // path, never a shell». `paths::which` itself branches on a separator
    // (`paths.rs:213-218`), so a value carrying one would silently become a
    // direct path instead of a lookup.
    if p.command.contains('/') || p.command.contains('\\') {
        return Err(format!("err.ext_program_path:{}", p.command));
    }
    // argv[0] IS an argv token: a name with a space, a quote, a control character
    // or a metacharacter in it was never a program name.
    if !valid_argv_token(&p.command) {
        return Err(format!("err.ext_program_arg:{}", p.command));
    }
    for (i, t) in p.args.iter().enumerate() {
        if i >= 32 || !valid_argv_token(t) {
            return Err(format!("err.ext_program_arg:{t}"));
        }
    }
    if !p.cwd.is_empty() && !cap_rel(&p.cwd) {
        return Err("err.ext_path_escape".into());
    }
    Ok(())
}

/// Both halves of an `I18n`, or the refusal that names WHERE the half is missing.
/// ADR-0031 §3 verbatim: «the person chose a language and an extension is not an
/// exception to it».
fn i18n_at(parent: &Value, key: &str, pointer: &str) -> Result<ExtI18n, String> {
    let v = parent.get(key);
    let pt = v
        .and_then(|o| o.get("pt"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let en = v
        .and_then(|o| o.get("en"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if pt.is_empty() || en.is_empty() {
        return Err(format!("err.ext_i18n_missing:{pointer}"));
    }
    Ok(ExtI18n { pt, en })
}

fn str_at(parent: &Value, key: &str) -> String {
    parent
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// the bounded pattern matcher (§3.3 `pattern`)
// ---------------------------------------------------------------------------
//
// A `pattern` is applied to a settings VALUE on `ext_settings_set`, so a field that
// declares one and never checks it is a control that lies. MEASURED: there is no
// regex engine in this crate — `desktop/src-tauri/Cargo.toml` lists tauri, serde,
// serde_json, tracing*, portable-pty and windows-sys, and nothing else — and
// adding a dependency is a contract change, not a local edit (§7.4).
//
// So this is a deliberately tiny, ANCHORED, NON-BACKTRACKING subset: a sequence of
// elements, each one a literal char, a `.`, or a class `[a-z0-9_-]` (with `^`
// negation), each optionally quantified by `*`, `+`, `?` or `{m,n}`. It is matched
// by a linear DP over (element, position), which is O(elements × chars) and CANNOT
// backtrack — the catastrophic-backtracking hang is the freeze class ADR-0022 §28
// names, and a pattern arrives from a manifest somebody else wrote.
//
// A pattern using anything outside the subset is not silently ignored: the SCHEMA
// is refused with `err.ext_settings_invalid:<id>`, because a promise the app cannot
// evaluate is worse than no promise.

#[derive(Clone, Debug, PartialEq)]
enum PatAtom {
    Any,
    Lit(char),
    Class { neg: bool, set: Vec<(char, char)> },
}

#[derive(Clone, Debug)]
struct PatElem {
    atom: PatAtom,
    min: u32,
    max: u32,
}

const PAT_MAX_REPEAT: u32 = 4096;

/// Parse the subset, or `None` when the pattern uses something outside it.
fn pattern_parse(pat: &str) -> Option<Vec<PatElem>> {
    if pat.len() > 120 {
        return None;
    }
    let cs: Vec<char> = pat.chars().collect();
    let mut i = 0usize;
    // Anchors are implicit: a settings value is matched WHOLE. A leading `^` and a
    // trailing `$` are therefore accepted and ignored, and one in the middle is not
    // in the subset.
    if cs.first() == Some(&'^') {
        i = 1;
    }
    let end = if cs.len() > i && cs.last() == Some(&'$') {
        cs.len() - 1
    } else {
        cs.len()
    };
    let mut out: Vec<PatElem> = Vec::new();
    while i < end {
        let atom = match cs[i] {
            '.' => {
                i += 1;
                PatAtom::Any
            }
            '[' => {
                let mut j = i + 1;
                let neg = cs.get(j) == Some(&'^');
                if neg {
                    j += 1;
                }
                let mut set: Vec<(char, char)> = Vec::new();
                while j < end && cs[j] != ']' {
                    let a = cs[j];
                    if a == '\\' || a == '[' {
                        return None;
                    }
                    if cs.get(j + 1) == Some(&'-') && cs.get(j + 2).is_some_and(|c| *c != ']') {
                        let b = cs[j + 2];
                        if b < a {
                            return None;
                        }
                        set.push((a, b));
                        j += 3;
                    } else {
                        set.push((a, a));
                        j += 1;
                    }
                }
                if j >= end || cs[j] != ']' || set.is_empty() {
                    return None;
                }
                i = j + 1;
                PatAtom::Class { neg, set }
            }
            '\\' => {
                let c = *cs.get(i + 1)?;
                // only an escaped metacharacter, never a class shorthand (\d, \w):
                // a shorthand is a second alphabet to keep in step with the first
                if !"\\.[]{}()*+?|^$".contains(c) {
                    return None;
                }
                i += 2;
                PatAtom::Lit(c)
            }
            '(' | ')' | '|' | '^' | '$' | '*' | '+' | '?' | '{' | '}' | ']' => return None,
            c => {
                i += 1;
                PatAtom::Lit(c)
            }
        };
        let (min, max) = match cs.get(i) {
            Some('*') => {
                i += 1;
                (0, PAT_MAX_REPEAT)
            }
            Some('+') => {
                i += 1;
                (1, PAT_MAX_REPEAT)
            }
            Some('?') => {
                i += 1;
                (0, 1)
            }
            Some('{') => {
                let close = (i..end).find(|k| cs[*k] == '}')?;
                let body: String = cs[i + 1..close].iter().collect();
                i = close + 1;
                let (a, b) = match body.split_once(',') {
                    None => {
                        let n: u32 = body.parse().ok()?;
                        (n, n)
                    }
                    Some((a, "")) => (a.parse().ok()?, PAT_MAX_REPEAT),
                    Some((a, b)) => (a.parse().ok()?, b.parse().ok()?),
                };
                if a > b || b > PAT_MAX_REPEAT {
                    return None;
                }
                (a, b)
            }
            _ => (1, 1),
        };
        out.push(PatElem { atom, min, max });
        if out.len() > 64 {
            return None;
        }
    }
    Some(out)
}

fn atom_matches(atom: &PatAtom, c: char) -> bool {
    match atom {
        PatAtom::Any => c != '\n',
        PatAtom::Lit(l) => *l == c,
        PatAtom::Class { neg, set } => {
            let hit = set.iter().any(|(a, b)| c >= *a && c <= *b);
            hit != *neg
        }
    }
}

/// Whole-string match. `reach[k]` = the set of input positions the first `k`
/// elements can consume up to; one forward pass, no recursion, no backtracking.
fn pattern_matches(elems: &[PatElem], value: &str) -> bool {
    let cs: Vec<char> = value.chars().collect();
    let n = cs.len();
    let mut reach = vec![false; n + 1];
    reach[0] = true;
    for e in elems {
        let mut next = vec![false; n + 1];
        for (start, _) in reach.iter().enumerate().filter(|(_, r)| **r) {
            let mut pos = start;
            let mut used = 0u32;
            loop {
                if used >= e.min {
                    next[pos] = true;
                }
                if used >= e.max || pos >= n || !atom_matches(&e.atom, cs[pos]) {
                    break;
                }
                pos += 1;
                used += 1;
            }
        }
        reach = next;
        if !reach.iter().any(|r| *r) {
            return false;
        }
    }
    reach[n]
}

// ---------------------------------------------------------------------------
// reading the pacote — private copies, because plugins.rs has a zero diff
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CcAuthor {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CcManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    author: Option<CcAuthor>,
}

/// Relative paths inside the pacote (bounded depth, forward slashes, directories
/// emitted with a TRAILING SLASH). The trailing slash is what makes a
/// directory-marker prefix match work — a copy of `plugins.rs:248-275`, private
/// there and therefore copied rather than called.
fn walk(dir: &Path, prefix: &str, depth: u32, out: &mut Vec<String>) {
    if depth == 0 || out.len() > 4000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let p = e.path();
        if p.is_dir() {
            out.push(format!("{rel}/"));
            walk(&p, &rel, depth - 1, out);
        } else if p.is_file() {
            out.push(rel);
        }
    }
}

/// A source string → the pacote's directory. R5a's source set is ONE entry long:
/// an existing local directory. The refusal set is `plugins.rs:401-422`'s, verbatim
/// in behaviour and renamed in code — an `http(s)://`, a `git@`, an `npm:`, an
/// `owner/repo`, a file, or a path that will not canonicalize all stop here.
fn resolve_source(source: &str) -> Result<PathBuf, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("err.ext_source_unsupported".into());
    }
    if s.starts_with("http://")
        || s.starts_with("https://")
        || s.starts_with("git@")
        || s.starts_with("npm:")
        || (s.contains('/') && !s.contains(std::path::MAIN_SEPARATOR) && !Path::new(s).exists())
    {
        return Err("err.ext_source_unsupported".into());
    }
    let p = PathBuf::from(s)
        .canonicalize()
        .map_err(|_| "err.ext_source_unsupported".to_string())?;
    if !p.is_dir() {
        return Err("err.ext_source_unsupported".into());
    }
    Ok(p)
}

/// A pacote file, guarded to the pacote's own root: `../` and a symlink out both
/// stop here. Same shape as `plugins.rs:533-542`.
fn guarded_src(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = dir
        .join(rel)
        .canonicalize()
        .map_err(|_| "err.ext_path_escape".to_string())?;
    if !p.starts_with(dir) {
        return Err("err.ext_path_escape".into());
    }
    Ok(p)
}

fn read_manifests(dir: &Path) -> Result<(CcManifest, Value), String> {
    let cc_txt = std::fs::read_to_string(dir.join(".claude-plugin/plugin.json"))
        .map_err(|_| "err.ext_manifest_invalid".to_string())?;
    let cc: CcManifest =
        serde_json::from_str(&cc_txt).map_err(|_| "err.ext_manifest_invalid".to_string())?;
    if cc.name.trim().is_empty() {
        return Err("err.ext_manifest_invalid".into());
    }
    // A pacote with no `loro.json` at all is a v1 pacote by definition, and the
    // version gate below names it. `Null` reads as `loro: 0`.
    let lm: Value = match std::fs::read_to_string(dir.join("loro.json")) {
        Ok(t) => serde_json::from_str(&t).map_err(|_| "err.ext_manifest_invalid".to_string())?,
        Err(_) => Value::Null,
    };
    Ok((cc, lm))
}

// ---------------------------------------------------------------------------
// loro.json v2
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub(crate) struct ParsedManifest {
    pub kinds: Vec<String>,
    pub points: BTreeMap<String, u32>,
    pub program: Option<ExtProgram>,
    pub surface: Option<ExtSurfaceDecl>,
    /// the inline level-1 document (`surface.view`), when that is the spelling used
    pub surface_view: Option<Value>,
    pub capabilities: Vec<ExtCapabilityDecl>,
    pub settings: Vec<ExtSettingField>,
    pub unsupported: Vec<String>,
}

/// Validate `loro.json` v2. PURE over the parsed JSON: every refusal below is a
/// unit test with no filesystem, and the order is the one the contract froze so
/// four implementers cannot disagree about which refusal a person sees.
///
/// THE ORDER, and why the first two are where they are:
///   1. the protocol version — a manifest written for a newer Loro is refused
///      before anything in it is interpreted;
///   2. BR-1's mutual exclusion — `err.ext_audio_network` comes BEFORE
///      `err.ext_point_unsupported` on purpose. «Not supported yet» invites the
///      person to wait for the next round; audio on a wire has no next round, and
///      no consent path (ADR-0031 §12 table).
///   3. points · 4. surface exclusivity · 5. settings (the credential refusal
///      FIRST, before anything is created) · 6. capability ids.
pub(crate) fn parse_manifest(lm: &Value) -> Result<ParsedManifest, String> {
    // 1 — the protocol version
    let loro = lm.get("loro").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if loro != 2 {
        // `> 2` is a manifest written for a newer Loro (ADR-0031 E6). `0`/`1` is a
        // v1 pacote, and the door for it is `brain_install_plugin` — refusing it
        // here BY THE VERSION is the same sentence `plugins.rs:392` says in the
        // other direction, and it keeps one door per protocol.
        return Err(format!("err.ext_protocol_unsupported:{loro}"));
    }

    let kinds: Vec<String> = lm
        .get("kinds")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|k| k.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let raw_caps: Vec<&str> = lm
        .get("capabilities")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("id").and_then(|i| i.as_str()))
                .collect()
        })
        .unwrap_or_default();

    let declared_points: Vec<(String, u32)> = lm
        .get("points")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.trim().to_string(), v.as_u64().unwrap_or(0) as u32))
                .collect()
        })
        .unwrap_or_default();

    // 2 — BR-1: a process that holds audio has no network capability and no
    // consent path to one. This is the one mutual exclusion with no dialog.
    let holds_audio = declared_points
        .iter()
        .any(|(p, _)| AUDIO_POINTS.contains(&p.as_str()));
    let wants_net = raw_caps.iter().any(|c| c.starts_with("net."));
    if holds_audio && wants_net {
        return Err("err.ext_audio_network".into());
    }

    // 3 — points. `points` is the REQUIRED set: declaring one is asserting the
    // extension needs it, so an unimplemented one is a refusal. A point merely
    // NAMED in the informational `kinds` is reported in `unsupported` instead
    // (§2.2 — «reported in unsupported; the error is raised only if it is declared
    // as required»).
    let has_surface_decl = lm.get("surface").is_some();
    let mut points: BTreeMap<String, u32> = BTreeMap::new();
    if declared_points.is_empty() {
        if has_surface_decl {
            points.insert("surface".into(), SURFACE_POINT_VERSION);
        }
    } else {
        for (p, v) in &declared_points {
            if !SUPPORTED_POINTS.contains(&p.as_str()) || *v != SURFACE_POINT_VERSION {
                return Err(format!("err.ext_point_unsupported:{p}@{v}"));
            }
            points.insert(p.clone(), *v);
        }
    }

    let mut unsupported: Vec<String> = Vec::new();
    for k in &kinds {
        // reported either way: a `kind` Loro does not know, and a point it knows and
        // does not implement in R5a, are both «declared and not installed»
        let unknown = !KNOWN_KINDS.contains(&k.as_str());
        let known_but_not_this_round =
            KNOWN_POINTS.contains(&k.as_str()) && !SUPPORTED_POINTS.contains(&k.as_str());
        if unknown || known_but_not_this_round {
            unsupported.push(k.clone());
        }
    }

    // 4 — program. Absent = a declarative or level-1 extension; present = a
    // supervised process, and it is what makes the install sheet say the sentence.
    let mut program: Option<ExtProgram> = None;
    if let Some(p) = lm.get("program") {
        let candidate = ExtProgram {
            protocol: str_at(p, "protocol"),
            server: str_at(p, "server"),
            command: str_at(p, "command"),
            args: p
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .map(|t| t.as_str().unwrap_or("<not a string>").to_string())
                        .collect()
                })
                .unwrap_or_default(),
            cwd: str_at(p, "cwd"),
        };
        // ONE VALIDATOR, TWO MOMENTS (see `validate_program`): the same function
        // runs again on the way to the spawn, so the manifest and the record are
        // held to the same rules.
        validate_program(&candidate)?;
        // R5b/R5c. READING them is the point: without the field serde discards
        // them in silence and the install promises a path that does not exist.
        for k in ["artifact", "build"] {
            if p.get(k).is_some() {
                unsupported.push(k.to_string());
            }
        }
        program = Some(candidate);
    }

    // 5 — surface, and the three exclusivity refusals, decided in the contract so
    // four implementers cannot disagree.
    let mut surface: Option<ExtSurfaceDecl> = None;
    let mut surface_view: Option<Value> = None;
    if let Some(s) = lm.get("surface") {
        let title = i18n_at(s, "title", "/surface/title")?;
        let served = s.get("served").and_then(|v| v.as_bool()).unwrap_or(false);
        let inline = s.get("view").cloned();
        let view_file = str_at(s, "viewFile");
        if inline.is_some() && !view_file.is_empty() {
            return Err("err.ext_surface_ambiguous".into());
        }
        if served && (inline.is_some() || !view_file.is_empty()) {
            return Err("err.ext_surface_ambiguous".into());
        }
        if served && program.is_none() {
            return Err("err.ext_surface_unserved".into());
        }
        if !served && inline.is_none() && view_file.is_empty() {
            return Err("err.ext_surface_missing".into());
        }
        if !view_file.is_empty() && !cap_rel(&view_file) {
            return Err("err.ext_path_escape".into());
        }
        let layout = str_at(s, "layout");
        if !layout.is_empty() && layout != "wide" && layout != "column" {
            return Err(format!("err.ext_surface_layout:{layout}"));
        }
        surface_view = inline;
        surface = Some(ExtSurfaceDecl {
            title,
            served,
            view_file,
            // "column" is the default spelled out; stored as "" so an old record
            // and an explicit one read the same
            layout: if layout == "column" {
                String::new()
            } else {
                layout
            },
        });
    }

    // 6 — settings. BR-9 FIRST: the credential scan runs over EVERY field before
    // any other settings rule, so a schema carrying one is refused before a single
    // directory is created. `plugins.rs:566-595` orders its two gates the same way.
    let raw_settings = lm
        .get("settings")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if let Some(over) = raw_settings.get(32) {
        return Err(format!("err.ext_settings_invalid:{}", str_at(over, "id")));
    }
    for f in &raw_settings {
        let kind = str_at(f, "kind");
        if names_a_credential(&kind) {
            return Err(format!("err.ext_settings_secret:{kind}"));
        }
        let id = str_at(f, "id");
        if names_a_credential(&id) {
            return Err(format!("err.ext_settings_secret:{id}"));
        }
    }
    let mut settings: Vec<ExtSettingField> = Vec::new();
    for (i, f) in raw_settings.iter().enumerate() {
        let id = str_at(f, "id");
        let kind = str_at(f, "kind");
        if !SETTING_KINDS.contains(&kind.as_str()) {
            return Err(format!("err.ext_settings_kind:{kind}"));
        }
        if !ident_dash(&id, 31) || settings.iter().any(|s| s.id == id) {
            return Err(format!("err.ext_settings_invalid:{id}"));
        }
        let label = i18n_at(f, "label", &format!("/settings/{i}/label"))?;
        let escopo = match str_at(f, "escopo").as_str() {
            "" | "projeto" => "projeto".to_string(),
            "maquina" => "maquina".to_string(),
            other => return Err(format!("err.ext_settings_invalid:{other}")),
        };
        let options: Vec<String> = f
            .get("options")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|o| o.as_str())
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();
        if kind == "enum" && (options.is_empty() || options.len() > 24) {
            return Err(format!("err.ext_settings_invalid:{id}"));
        }
        let pattern = str_at(f, "pattern");
        if !pattern.is_empty() && (kind != "string" || pattern_parse(&pattern).is_none()) {
            return Err(format!("err.ext_settings_invalid:{id}"));
        }
        let hint = match f.get("hint") {
            Some(_) => Some(i18n_at(f, "hint", &format!("/settings/{i}/hint"))?),
            None => None,
        };
        settings.push(ExtSettingField {
            id,
            kind,
            escopo,
            label,
            default: f.get("default").cloned(),
            options,
            pattern,
            hint,
        });
    }

    // 7 — capability ids. In R5a a capability is COPY ON THE INSTALL SHEET and
    // nothing else (ADR-0031 §3.7): there is no filesystem API, no net API and no
    // agent API for an extension, so nothing here could act on a grant. What is
    // real is the ANSWER — `ext_permit` stores it, and every enforcement point
    // lands in the round where a capability finally does something.
    let mut capabilities: Vec<ExtCapabilityDecl> = Vec::new();
    if let Some(list) = lm.get("capabilities").and_then(|v| v.as_array()) {
        for (i, c) in list.iter().enumerate() {
            let id = str_at(c, "id");
            if !valid_capability_id(&id) {
                return Err(format!("err.ext_capability_invalid:{id}"));
            }
            let why = i18n_at(c, "why", &format!("/capabilities/{i}/why"))?;
            capabilities.push(ExtCapabilityDecl { id, why });
        }
    }

    unsupported.sort();
    unsupported.dedup();
    Ok(ParsedManifest {
        kinds,
        points,
        program,
        surface,
        surface_view,
        capabilities,
        settings,
        unsupported,
    })
}

// ---------------------------------------------------------------------------
// §2 — the facts catalogue
// ---------------------------------------------------------------------------
//
// NOBODY RE-READS MARKDOWN. Facts are computed by Loro and handed to the renderer
// together with the view, in one object, so an extension never needs a filesystem
// API — which is how the absence in rule 4 stays an absence.
//
// BR-8 BY CONSTRUCTION, and it is the graph's property, not a promise this file
// makes: the whole graph section makes four filesystem calls, all rooted at
// `paths::contexts_dir`, with the file-name allowlist `CONTEXT_DOC_NAMES =
// ["context.md","guia.md"]` (`acervo.rs:2360`) and a depth bounded by
// `MAX_CONTEXT_DEPTH = 6`. `meetings/`, `notas/`, `pessoal/` and the trail are
// UNREACHABLE from this code, not merely unread.
//
// ONE CACHE, NOT TWO. `scan_contexts` is already mtime-fingerprint cached
// (`acervo.rs:2763-2794`) and this module adds no second cache: the comment at
// `acervo.rs:2765` records that a counter which does not recompute is an interface
// that lies.

fn count_rows(rows: Vec<Value>) -> Value {
    serde_json::json!({ "count": rows.len(), "rows": rows })
}

/// The four collections of §2.1, derived from a SERIALIZED `KnowledgeGraph`.
///
/// THREE PROPERTIES THAT ARE FACTS, NOT INTENTIONS:
///
///  * A HOTSPOT HAS NO TITLE. Measured: `struct DocHotspot { id: String }` — one
///    field, `acervo.rs:2401-2403` — and `hotspot_of` parses the id and discards
///    the rest of the line. `title` in a hotspot row is therefore the NODE's title.
///    A view that promised a hotspot's own title would be promising data the app
///    does not have.
///  * THE PREFIX IS NOT ALWAYS `contexts/`. `paths::contexts_dir` resolves
///    `contexts` OR the legacy `contextos` (`paths.rs:253-256`), so no consumer may
///    hardcode either: `rel` is whatever the graph produced.
///  * AN ORPHAN'S CONTEXT IS LOOKED UP, NOT PARSED. Measured: `graph.orphans` is
///    built as `nodes.iter().filter(|n| n.inlinks == 0).map(|n| n.rel)`
///    (`acervo.rs:2933-2937`), so every orphan rel IS a node rel and the node
///    already carries the context the graph itself computed. String surgery on the
///    path would be a second answer to a question that already has one.
pub(crate) fn facts_from_graph(graph: &Value) -> Value {
    let empty: Vec<Value> = Vec::new();
    let nodes = graph
        .get("nodes")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let mut hotspots: Vec<Value> = Vec::new();
    let mut contexts: Vec<Value> = Vec::new();
    for n in nodes {
        let rel = n.get("rel").and_then(|v| v.as_str()).unwrap_or_default();
        let context = n
            .get("context")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let title = n.get("title").and_then(|v| v.as_str()).unwrap_or_default();
        let hs = n
            .get("hotspots")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        // The AREA is the first path segment — the only grouping that fits a
        // board. MEASURED (2026-08-20, the owner's real acervo): 80 contexts,
        // 312 hotspots — a column per context painted at 12px; per area it is
        // 18 columns, median 17 cards.
        let area = context.split('/').next().unwrap_or_default();
        for h in &hs {
            let id = h.as_str().unwrap_or_default();
            // qualified as `<context>#<id>` at `acervo.rs:2919`; the bare id is the
            // part after the FIRST `#`, because a hotspot id may contain one
            let hotspot = id.split_once('#').map(|(_, r)| r).unwrap_or(id);
            hotspots.push(serde_json::json!({
                "id": id, "hotspot": hotspot, "context": context, "area": area,
                "rel": rel, "title": title,
                // filled by apply_kanban_points; defaults here so the bindings
                // always resolve — an absent field is a painted refusal
                "comments": 0, "status": "aberto",
            }));
        }
        contexts.push(serde_json::json!({
            "context": context, "area": area, "rel": rel, "title": title,
            "hotspots": hs.len(),
            "decisions": n.get("decisions").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
            "inlinks": n.get("inlinks").and_then(|v| v.as_u64()).unwrap_or(0),
            "outlinks": n.get("outlinks").and_then(|v| v.as_u64()).unwrap_or(0),
        }));
    }

    // acervo.areas — the aggregation, sorted by name (a BTreeMap so the board's
    // column order is stable across renders; a HashMap here made columns jump).
    let mut per_area: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
    for c in &contexts {
        let a = c.get("area").and_then(|v| v.as_str()).unwrap_or_default();
        if a.is_empty() {
            continue;
        }
        let e = per_area.entry(a.to_string()).or_insert((0, 0));
        e.0 += 1;
        e.1 += c.get("hotspots").and_then(|v| v.as_u64()).unwrap_or(0);
    }
    let areas: Vec<Value> = per_area
        .into_iter()
        .map(|(area, (cx, hs))| serde_json::json!({ "area": area, "contexts": cx, "hotspots": hs }))
        .collect();

    let orphans: Vec<Value> = graph
        .get("orphans")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty)
        .iter()
        .filter_map(|o| o.as_str())
        .map(|rel| {
            let context = nodes
                .iter()
                .find(|n| n.get("rel").and_then(|v| v.as_str()) == Some(rel))
                .and_then(|n| n.get("context").and_then(|v| v.as_str()))
                .unwrap_or_default();
            serde_json::json!({ "rel": rel, "context": context })
        })
        .collect();

    let broken: Vec<Value> = graph
        .get("broken")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty)
        .iter()
        .map(|b| {
            serde_json::json!({
                "from": b.get("from").and_then(|v| v.as_str()).unwrap_or_default(),
                "target": b.get("target").and_then(|v| v.as_str()).unwrap_or_default(),
            })
        })
        .collect();

    serde_json::json!({
        "acervo.hotspots": count_rows(hotspots),
        "acervo.contexts": count_rows(contexts),
        "acervo.orphans": count_rows(orphans),
        "acervo.broken": count_rows(broken),
        "acervo.areas": count_rows(areas),
    })
}

/// The four states of a point on the board. Closed on purpose: a column is a
/// place a person looks for work, and a free-text status scatters the work
/// across columns nobody opened. `aberto` is the default — a hotspot with no
/// kanban folder IS an open point.
pub const KANBAN_STATUSES: [&str; 4] = ["aberto", "em-pauta", "em-resolucao", "concluido"];

/// What the kanban folder says about each hotspot: (comments, status).
///
/// Comments are counted from FILE NAMES only (`kanban/<context>/<id>/*.md`,
/// minus `ponto.md`) — nothing is opened, the BR-8 posture the graph takes.
/// The ONE content read is `ponto.md`'s front-matter `status:` line, first KB:
/// a status is not derivable from a name, and it lives in a DOCUMENT (versioned,
/// reviewable, written by the `loro-kanban-move` habilidade the person triggers)
/// because that is where everything in this product lives — ADR-0029 §14, «an
/// ordinary document, all the way down». A status outside the four clamps to
/// `aberto` and never hides the card: a board that silently drops a point is
/// the worst failure a board has.
pub(crate) fn kanban_point_facts(base: &Path) -> std::collections::BTreeMap<String, (u64, String)> {
    let mut out: std::collections::BTreeMap<String, (u64, String)> = Default::default();
    let root = base.join("kanban");
    let mut stack = vec![(root.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        // deeper than any real `<context>/<hotspot>` nesting; a runaway link
        // farm stops here instead of hanging a view call (ADR-0022 §28)
        if depth > 8 {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                stack.push((path, depth + 1));
            } else if name.ends_with(".md") {
                let Ok(rel) = path.strip_prefix(&root) else {
                    continue;
                };
                let segs: Vec<String> = rel
                    .iter()
                    .map(|c| c.to_string_lossy().to_string())
                    .collect();
                // `<context…>/<hotspot-id>/<file>.md` — at least three segments
                if segs.len() < 3 {
                    continue;
                }
                let hotspot = &segs[segs.len() - 2];
                let context = segs[..segs.len() - 2].join("/");
                let entry = out
                    .entry(format!("{context}#{hotspot}"))
                    .or_insert((0, "aberto".to_string()));
                if name == "ponto.md" {
                    entry.1 = status_of_ponto(&path);
                } else {
                    entry.0 += 1;
                }
            }
        }
    }
    out
}

/// `status:` from the front-matter, first KB, clamped to KANBAN_STATUSES.
fn status_of_ponto(path: &Path) -> String {
    let Ok(txt) = std::fs::read_to_string(path) else {
        return "aberto".into();
    };
    for line in txt.lines().take(32) {
        if let Some(v) = line.strip_prefix("status:") {
            let v = v.trim();
            if KANBAN_STATUSES.contains(&v) {
                return v.to_string();
            }
            return "aberto".into();
        }
    }
    "aberto".into()
}

/// Stamp (comments, status) onto the hotspot rows. Separate from
/// `facts_from_graph` so that one stays a pure function of the graph and this
/// one is a pure function of (facts, points) — each testable without the
/// other's fixture.
pub(crate) fn apply_kanban_points(
    facts: &mut Value,
    points: &std::collections::BTreeMap<String, (u64, String)>,
) {
    let Some(rows) = facts
        .get_mut("acervo.hotspots")
        .and_then(|h| h.get_mut("rows"))
        .and_then(|r| r.as_array_mut())
    else {
        return;
    };
    for row in rows {
        let id = row.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if let Some((n, status)) = points.get(id) {
            row["comments"] = serde_json::json!(n);
            row["status"] = serde_json::json!(status);
        }
    }
}

/// One `brain_knowledge_graph()` per `ext_view` call, and there is deliberately no
/// `ext_facts` command: two doors to the same question is two answers to it.
///
/// MEASURED LEGAL: `tauri-macros-2.6.3` re-emits the annotated function verbatim
/// (`#function`, `src/command/wrapper.rs:312` — read on this machine), so a
/// command-annotated `pub async fn` is an ordinary Rust `async fn` and calling it
/// keeps `acervo.rs` at a zero diff. (The attribute is not spelled out here: the
/// command scanner in this module's tests matches that literal.)
async fn facts_now() -> Result<Value, String> {
    let graph = crate::acervo::brain_knowledge_graph().await?;
    let as_json = serde_json::to_value(&graph).map_err(|_| "err.ext_write_failed".to_string())?;
    let mut facts = facts_from_graph(&as_json);
    // comment counts ride along (file names only — see kanban_comment_counts);
    // an unreadable base means zero counts, never a failed view
    if let Ok(base) = base() {
        apply_kanban_points(&mut facts, &kanban_point_facts(&base));
    }
    Ok(facts)
}

// ---------------------------------------------------------------------------
// the view boundary
// ---------------------------------------------------------------------------
//
// TWO LAYERS, AND NEITHER ONE DROPS ANYTHING. This module checks the ENVELOPE and
// the primitive names — the things that decide whether a document is a document at
// all — and refuses the whole document by name when one fails, because a reply off
// a program is untrusted input crossing a boundary (ADR-0031 §13.2). The renderer
// owns the value alphabet (tone, step, cols, icon, refs) and surfaces its refusals
// per node in an `.extv-err` block (ADR-0029 §3.7). A node kind this file does not
// know cannot reach the page, and it cannot be silently missing from it either.

/// `Ok(())`, or the first named refusal. Iterative, with an explicit stack: a
/// hostile document is untrusted input and recursion over it is a stack overflow
/// waiting for an author (`err.ext_view_depth:<n>` bounds it either way).
pub(crate) fn validate_view_envelope(doc: &Value) -> Result<(), String> {
    let version = doc.get("loroView").and_then(|v| v.as_u64()).unwrap_or(0);
    if version != 1 {
        return Err(format!("err.ext_view_version:{version}"));
    }
    let top = match doc.get("view").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => return Err("err.ext_view_empty".into()),
    };

    let mut stack: Vec<(&Value, u32)> = Vec::new();
    for n in top {
        stack.push((n, 1));
    }
    if let Some(comps) = doc.get("components").and_then(|v| v.as_object()) {
        for (name, c) in comps {
            if !ident_dash(name, 31) {
                return Err(format!("err.ext_view_component:{name}"));
            }
            if let Some(body) = c.get("body") {
                stack.push((body, 1));
            }
        }
    }

    let mut seen = 0usize;
    while let Some((node, depth)) = stack.pop() {
        seen += 1;
        if seen > VIEW_NODE_MAX {
            return Err(format!("err.ext_view_size:{seen}"));
        }
        if depth > VIEW_TREE_DEPTH_MAX {
            return Err(format!("err.ext_view_depth:{depth}"));
        }
        let kind = node.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if !VIEW_KINDS.contains(&kind) {
            return Err(format!("err.ext_view_node:{kind}"));
        }
        for key in ["children", "then", "else"] {
            if let Some(list) = node.get(key).and_then(|v| v.as_array()) {
                for c in list {
                    stack.push((c, depth + 1));
                }
            }
        }
        if let Some(body) = node.get("body") {
            stack.push((body, depth + 1));
        }
    }
    Ok(())
}

/// Every `action` a button in this document declares. `ext_action` refuses an id
/// that is not here (`err.ext_action_unknown:<id>`): a call naming an action no node
/// asked for is not a button a person pressed.
pub(crate) fn actions_of(doc: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<&Value> = Vec::new();
    if let Some(a) = doc.get("view").and_then(|v| v.as_array()) {
        stack.extend(a.iter());
    }
    if let Some(c) = doc.get("components").and_then(|v| v.as_object()) {
        stack.extend(c.values().filter_map(|b| b.get("body")));
    }
    let mut guard = 0usize;
    while let Some(node) = stack.pop() {
        guard += 1;
        if guard > VIEW_NODE_MAX {
            break;
        }
        if node.get("kind").and_then(|v| v.as_str()) == Some("button") {
            let a = node.get("action").and_then(|v| v.as_str()).unwrap_or("");
            if ident_snake(a, 47) && !out.iter().any(|x| x == a) {
                out.push(a.to_string());
            }
        }
        for key in ["children", "then", "else"] {
            if let Some(list) = node.get(key).and_then(|v| v.as_array()) {
                stack.extend(list.iter());
            }
        }
        if let Some(body) = node.get("body") {
            stack.push(body);
        }
    }
    out.sort();
    out
}

/// The level-1 document of an installed extension, read from the pacote it was
/// installed from. R5a copies no view into the acervo: the pacote stays the source
/// of truth for its own screen, and the record's `source.path` is UNTRUSTED (it
/// arrives in somebody else's commit), so it goes through `resolve_source` and
/// `guarded_src` exactly like a fresh install does.
fn manifest_view(rec: &InstalledExt) -> Result<Value, String> {
    let dir = resolve_source(&rec.source.path)?;
    let (_, lm) = read_manifests(&dir)?;
    let parsed = parse_manifest(&lm)?;
    let surface = parsed.surface.ok_or("err.ext_surface_missing")?;
    if let Some(inline) = parsed.surface_view {
        return Ok(inline);
    }
    if surface.view_file.is_empty() {
        return Err("err.ext_surface_missing".into());
    }
    let p = guarded_src(&dir, &surface.view_file)?;
    let text = std::fs::read_to_string(&p)
        .map_err(|_| format!("err.ext_unreadable_file:{}", surface.view_file))?;
    serde_json::from_str::<Value>(&text)
        .map_err(|_| format!("err.ext_unreadable_file:{}", surface.view_file))
}

// ---------------------------------------------------------------------------
// the supervisor's registry
// ---------------------------------------------------------------------------
//
// Module-private, NEVER a field on `AppState` (rule 2). The `turn` counter exists
// for the same reason `chat.rs:45-49` has one: a late-finishing call must not reap
// the next one's process, and a drain thread left over from a previous spawn must
// not emit for the process that replaced it.

struct ExtProc {
    /// DEVIATION FROM THE CONTRACT'S PRIVATE SHAPE, and it is load-bearing: the
    /// contract froze `client: crate::mcp::McpClient`, but `stop` CONSUMES the
    /// client, so a crashed or stopped extension could not keep its slot — and the
    /// slot is where the state lives. `None` means «the record outlived the
    /// process», which is exactly what «the state is a fact, never a spinner»
    /// requires. It is also the only way a test can build a registry entry without
    /// a real child.
    /// Behind an `Arc` so a `loro/view` or `loro/action` can be called with the
    /// registry lock DROPPED (see the section header): the handle is cloned under
    /// the lock and used outside it.
    client: Option<std::sync::Arc<crate::mcp::McpClient>>,
    turn: u64,
    started_ms: i64,
    last_answer_ms: i64,
    restarts: u32,
    window_start_ms: i64,
    state: String,
    reason: String,
    /// the actions the last served view declared — see `actions_of`
    actions: Vec<String>,
}

#[derive(Default)]
struct ExtState {
    procs: HashMap<String, ExtProc>,
    turn: u64,
}

static EXT: Mutex<Option<ExtState>> = Mutex::new(None);

fn with_ext<T>(f: impl FnOnce(&mut ExtState) -> T) -> T {
    let mut g = EXT.lock().expect("ext registry poisoned");
    f(g.get_or_insert_with(ExtState::default))
}

fn set_state(p: &mut ExtProc, state: &str, reason: &str) {
    debug_assert!(
        EXT_STATES.contains(&state),
        "a state outside EXT_STATES paints nothing on the row"
    );
    p.state = state.to_string();
    p.reason = reason.to_string();
}

/// Reap nothing, block on nothing: only the non-blocking `is_alive()`, so `state`
/// never reports `running` for a process that already ended. A `wait()` here would
/// be `chat.rs:438-451` all over again — the lock held for the whole life of the
/// child, and every other command queued behind it on the main thread.
fn sweep() {
    with_ext(|st| {
        for p in st.procs.values_mut() {
            let alive = p.client.as_ref().map(|c| c.is_alive()).unwrap_or(false);
            if !alive && (p.state == "running" || p.state == "starting") {
                p.client = None;
                set_state(p, "no_answer", "err.ext_no_answer");
            }
        }
    })
}

/// The restart budget, as arithmetic: given the attempts already spent and when the
/// window opened, may another spawn happen? PURE, because the crash-loop rule has
/// to be testable without a process that crashes — and because a supervisor that
/// keeps trying is the one bug in this area that costs a machine.
///
/// Returns `(allowed, restarts_after, window_start_after)`.
pub(crate) fn budget_step(restarts: u32, window_start_ms: i64, now: i64) -> (bool, u32, i64) {
    // A window that has elapsed is a new window: three crashes an hour apart is
    // not a crash loop, and refusing to try again would be a state that lies.
    let (spent, opened) = if window_start_ms == 0 || now - window_start_ms > RESTART_WINDOW_MS {
        (0, now)
    } else {
        (restarts, window_start_ms)
    };
    if spent >= RESTART_MAX {
        return (false, spent, opened);
    }
    (true, spent + 1, opened)
}

/// What the registry knows about one extension right now. It is a struct and not a
/// tuple because `has_client` is a FOURTH fact that a reader must not confuse with
/// `state`: a hung program is `no_answer` AND still has a live handle.
#[derive(Clone)]
struct LiveState {
    state: String,
    reason: String,
    last_answer_ms: i64,
    has_client: bool,
}

/// Every running extension, as the screen would see it. Read-only.
fn states_now() -> HashMap<String, LiveState> {
    sweep();
    with_ext(|st| {
        st.procs
            .iter()
            .map(|(id, p)| {
                (
                    id.clone(),
                    LiveState {
                        state: p.state.clone(),
                        reason: p.reason.clone(),
                        last_answer_ms: p.last_answer_ms,
                        has_client: p.client.is_some(),
                    },
                )
            })
            .collect()
    })
}

fn emit_state(app: &AppHandle, id: &str, state: &str, reason: &str, last_answer_ms: i64) {
    let _ = app.emit(
        "ext-state",
        serde_json::json!({
            "id": id, "state": state, "reason": reason, "lastAnswerMs": last_answer_ms,
        }),
    );
}

/// Called from lib.rs's `RunEvent::ExitRequested` arm. Nothing kills spawned
/// children on quit today (`app.run` handles only `RunEvent::Reopen`,
/// `lib.rs:4863-4875`), so an extension left running would outlive the window that
/// started it — a process a person cannot see and cannot stop.
///
/// ONE process table snapshot for the whole sweep, and every `stop` happens after
/// the guard is dropped.
pub(crate) fn stop_all() {
    let taken: Vec<(String, std::sync::Arc<crate::mcp::McpClient>)> = with_ext(|st| {
        let ids: Vec<String> = st.procs.keys().cloned().collect();
        let mut out = Vec::new();
        for id in ids {
            if let Some(p) = st.procs.get_mut(&id) {
                if let Some(c) = p.client.take() {
                    out.push((id.clone(), c));
                }
                set_state(p, "stopped", "");
            }
        }
        out
    });
    if taken.is_empty() {
        return;
    }
    let table = crate::process_table();
    let n = taken.len();
    for (id, arc) in taken {
        let pid = arc.pid();
        match std::sync::Arc::try_unwrap(arc) {
            Ok(client) => client.stop(STOP_GRACE_MS, &table),
            // the app is going away; a call still in flight cannot be waited for
            Err(_) => {
                let killed = crate::mcp::kill_tree(pid, &table);
                warn!(id = %id, killed = killed, "extension killed on exit");
            }
        }
    }
    info!(stopped = n, "extensions stopped on exit");
}

// ---------------------------------------------------------------------------
// starting and stopping
// ---------------------------------------------------------------------------
//
// WHY THE CLIENT IS BEHIND AN `Arc`: a `loro/view` call may take up to `VIEW_MS`
// and a `loro/action` up to `ACTION_MS`. Holding the registry lock for that long
// would queue every other command behind it — `chat.rs:438-451` measured exactly
// that and the cancel button was one of the things that queued. So the call site
// CLONES the handle under the lock, drops the guard, and calls with nothing held.
// This requires `mcp::McpClient` to be `Send + Sync`, which the registry already
// requires of it: `static EXT` makes `&ExtProc` reachable from the drain thread.

/// Where a program is spawned: the pacote's own directory, or a relative `cwd`
/// inside it. Guarded, because `source.path` arrives in somebody else's commit.
fn program_cwd(rec: &InstalledExt, program: &ExtProgram) -> Result<PathBuf, String> {
    let dir = resolve_source(&rec.source.path)?;
    if program.cwd.is_empty() {
        return Ok(dir);
    }
    let p = guarded_src(&dir, &program.cwd)?;
    if !p.is_dir() {
        return Err("err.ext_path_escape".into());
    }
    Ok(p)
}

/// A refusal that a retry cannot fix is `blocked`; one that a retry might is
/// `crashed`, and `crashed` is what the restart budget counts.
///
/// This reconciles the two halves of the contract that cannot both hold: §4.2 says
/// a failed handshake leaves the extension "stopped with the reason stated", while
/// `ExtRow.reason` is defined as carrying a code only for `no_answer | crashed |
/// blocked`. The ROW's definition wins, because the row is what the screen reads —
/// a `stopped` row with a reason would either print a reason next to «parada» or
/// drop it, and dropping it is a state that lies.
fn state_for_reason(reason: &str) -> &'static str {
    if reason.starts_with("err.ext_protocol_unsupported")
        || reason.starts_with("err.ext_server_mismatch")
        || reason.starts_with("err.ext_reserved_name")
        || reason.starts_with("err.ext_describe_missing")
        || reason.starts_with("err.ext_program_missing")
        || reason.starts_with("err.ext_program_path")
        || reason.starts_with("err.ext_path_escape")
        || reason.starts_with("err.ext_source_unsupported")
    {
        "blocked"
    } else {
        "crashed"
    }
}

fn record_failure(app: &AppHandle, id: &str, reason: &str) {
    let state = state_for_reason(reason);
    let (spent, opened) =
        with_ext(|st| st.procs.get(id).map(|p| (p.restarts, p.window_start_ms))).unwrap_or((0, 0));
    let last = mark(id, state, reason, spent, opened);
    emit_state(app, id, state, reason, last);
}

/// The handshake of §4.2, in order, each step refusing BY NAME. A manifest is an
/// assertion; the process is the fact (ADR-0031 §2.2) — which is why step 3 exists
/// at all, and why it compares the server's own `serverInfo.name` against what the
/// manifest claimed instead of trusting either one alone.
fn handshake(
    client: &crate::mcp::McpClient,
    program: &ExtProgram,
    served: bool,
    lang: &str,
    settings: &Value,
) -> Result<(), String> {
    let info = client.initialize()?;
    if info.protocol_version != crate::mcp::PROTOCOL_VERSION {
        return Err(format!(
            "err.ext_protocol_unsupported:{}",
            info.protocol_version
        ));
    }
    if info.name != program.server {
        return Err(format!("err.ext_server_mismatch:{}", info.name));
    }
    let tools = client.list_tools()?;
    // THE `loro/` PREFIX IS LORO'S AND CANNOT BE SQUATTED. A server exposing
    // `loro/exec` is refused as a whole rather than having that one tool ignored:
    // a name in Loro's namespace that Loro does not define is a server asserting a
    // capability nobody granted.
    const R5A_TOOLS: [&str; 4] = ["loro/describe", "loro/view", "loro/action", "loro/settings"];
    for t in &tools {
        if t.starts_with("loro/") && !R5A_TOOLS.contains(&t.as_str()) {
            return Err(format!("err.ext_reserved_name:{t}"));
        }
    }
    if served && !tools.iter().any(|t| t == "loro/describe") {
        return Err("err.ext_describe_missing".into());
    }
    // A served surface whose server does not offer `loro/view` is NOT refused here:
    // R5a has no code for it, and borrowing `err.ext_describe_missing` would name
    // the wrong tool. The first `ext_view` then fails by name with `err.ext_rpc:<code>`
    // and the tab says so — a named refusal one call later, never a blank screen.
    // Still inside the handshake: the current settings once, then describe once.
    // Only then is the extension `running`.
    client.call_tool(
        "loro/settings",
        &serde_json::json!({ "values": settings }),
        HANDSHAKE_MS,
    )?;
    client.call_tool(
        "loro/describe",
        &serde_json::json!({ "lang": lang, "loroVersion": env!("CARGO_PKG_VERSION") }),
        HANDSHAKE_MS,
    )?;
    Ok(())
}

/// One background thread per running extension, whose only job is `loro/view_invalidated`.
///
/// It polls instead of blocking because the pipe belongs to `mcp`'s reader thread,
/// and it re-checks the `turn` before it emits: without that, a thread left over
/// from a previous spawn would invalidate the view of the process that replaced it
/// — the stale-turn bug `chat.rs:45-49` already paid for.
fn spawn_drain(app: AppHandle, id: String, turn: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(DRAIN_TICK_MS));
        // `drain_notifications` reads a buffer the reader thread filled; it never
        // waits on the child, so it is legal under the lock (rule 3 forbids a
        // `wait`, not a read).
        let (alive, methods) = with_ext(|st| match st.procs.get(&id) {
            Some(p) if p.turn == turn => match p.client.as_ref() {
                Some(c) => (true, c.drain_notifications()),
                None => (false, Vec::new()),
            },
            _ => (false, Vec::new()),
        });
        if !alive {
            break;
        }
        for m in methods {
            if m == "loro/view_invalidated" {
                let _ = app.emit("ext-view-invalidated", serde_json::json!({ "id": id }));
            } else if crate::mcp::LORO_RESERVED_KNOWN.contains(&m.as_str()) {
                // §4.4 — any other `loro/*` arriving FROM the server is refused by
                // name and the notification is dropped. `loro/propose_outbound` and
                // `loro/propose_material` take this path in R5a: a reserved name
                // that is not in the spec is refused, not queued.
                warn!(id = %id, code = %format!("err.ext_reserved_name:{m}"), "extension notification refused");
            } else {
                // BR-8, MEASURED AS A HOLE: the method is chosen entirely by the
                // extension's process, and the line above interpolated it into a
                // LOGGED field. An extension has full filesystem access (there is no
                // sandbox — ADR-0031 P2), so it could read `reuniao.md` and emit
                // `{"method":"loro/<200 KB of transcript>"}` every 500 ms: transcript
                // content inside the log a person attaches to a support request. The
                // name is printed ONLY when it is one of LORO'S OWN reserved names
                // (the branch above); anything else is a COUNT of bytes. `mcp.rs`
                // caps it at MAX_METHOD_BYTES on the way in — and a capped body is
                // still a body, which is why this branch does not print it either.
                warn!(id = %id, code = "err.ext_reserved_name", bytes = m.len(), "extension notification refused, name not printed");
            }
        }
    });
}

/// Write a slot's state, its reason and its budget in ONE place. Returns the
/// `last_answer_ms` the slot already had, because a program that stopped replying
/// must keep the last time it did — that is the whole content of a `no_answer` row.
///
/// It exists as its own function so the budget bookkeeping is testable: the first
/// version wrote the budget BEFORE the slot existed, and the write was silently
/// lost, which made the fourth spawn allowed.
fn mark(id: &str, state: &str, reason: &str, spent: u32, opened: i64) -> i64 {
    with_ext(|st| {
        let p = st.procs.entry(id.to_string()).or_insert_with(|| ExtProc {
            client: None,
            turn: 0,
            started_ms: 0,
            last_answer_ms: 0,
            restarts: 0,
            window_start_ms: 0,
            state: "stopped".into(),
            reason: String::new(),
            actions: Vec::new(),
        });
        p.client = None;
        p.restarts = spent;
        p.window_start_ms = opened;
        set_state(p, state, reason);
        p.last_answer_ms
    })
}

/// The slot exists, and says `starting`, before the spawn: a handshake may take up
/// to `HANDSHAKE_MS`, and a row that still reads «parada» during it is a state that
/// lies about what the person just did.
fn record_starting(app: &AppHandle, id: &str, spent: u32, opened: i64) {
    let last = mark(id, "starting", "", spent, opened);
    emit_state(app, id, "starting", "", last);
}

/// `approve` is the person's answer to the sentence that NAMES this program, and it
/// arrives only from a confirmation the screen showed (`err.ext_untrusted` is what
/// asks for it). It is not a flag an extension can set: nothing on the wire reaches
/// this argument.
fn start_at(app: &AppHandle, base: &Path, id: &str, approve: bool) -> Result<ExtRow, String> {
    let rec = find_record(base, id)?;
    let Some(program) = rec.program.clone() else {
        // nothing to start: the row carries `hasProgram: false` so the control is
        // never offered, and an invoke that arrives anyway is named, not ignored
        return Err("err.ext_stopped".into());
    };
    // THE ARGV IS REVALIDATED HERE, and this is the second of the two moments
    // `validate_program` exists for: everything above came out of a VERSIONED file,
    // and `mcp::McpClient::spawn` re-guards only the command (mcp.rs:446-450) — the
    // args went to `proc::command(exe).args(&cfg.args)` verbatim.
    validate_program(&program).inspect_err(|e| record_failure(app, id, e))?;
    // THE SECOND CONFIRMATION (ADR-0029 R5), and it is per MACHINE — see `trust_file`.
    // Nothing is spawned until somebody here has read this command and said yes.
    if trusted_program(id).as_ref() != Some(&program) {
        if !approve {
            return Err("err.ext_untrusted".to_string());
        }
        trust_program(id, &program)?;
    }
    sweep();
    if with_ext(|st| st.procs.get(id).map(|p| p.state == "running")).unwrap_or(false) {
        return row_at(base, id);
    }
    // NEVER TWO CHILDREN FOR ONE EXTENSION. A slot in any other state may still
    // hold a LIVE client — `no_answer` is exactly that case, because `sweep` nulls
    // the client only when the child is already dead — and `st.procs.insert` below
    // overwrites the slot. MEASURED: an `McpClient` dropped without `stop` left its
    // child running (`kill -0` on the pid succeeded 400 ms after the drop), and the
    // handle was no longer in `st.procs`, so neither `stop_client` nor `stop_all`
    // could ever reach it again. `impl Drop for McpClient` is now the floor under
    // this; taking the handle and stopping it here is the door.
    if let Some(old) = take_client(id) {
        shutdown(id, old);
    }

    // THE RESTART BUDGET, BEFORE THE SPAWN. Five retries spend the machine to learn
    // what the first one already said.
    let now = now_ms();
    let (restarts, window) =
        with_ext(|st| st.procs.get(id).map(|p| (p.restarts, p.window_start_ms))).unwrap_or((0, 0));
    let (allowed, spent, opened) = budget_step(restarts, window, now);
    if !allowed {
        let reason = format!("err.ext_crash_loop:{spent}");
        record_failure(app, id, &reason);
        return Err(reason);
    }

    // ADR-0030 — the probe and the spawn resolve through THE SAME lookup. `paths::which`
    // is what `mcp::McpClient::spawn` calls too, so this cannot answer «found» for a
    // program the spawn then fails to start, which is the exact bug that told a user
    // to install a `gh` that was already there.
    if crate::paths::which(&program.command).is_none() {
        let reason = format!("err.ext_program_missing:{}", program.command);
        record_failure(app, id, &reason);
        return Err(reason);
    }

    let cwd = program_cwd(&rec, &program).inspect_err(|e| {
        record_failure(app, id, e);
    })?;

    let turn = with_ext(|st| {
        st.turn += 1;
        st.turn
    });
    record_starting(app, id, spent, opened);
    let cfg = crate::mcp::McpConfig {
        program: program.command.clone(),
        args: program.args.clone(),
        cwd,
        handshake_ms: HANDSHAKE_MS,
    };
    let client = crate::mcp::McpClient::spawn(&cfg).inspect_err(|e| {
        // The spawn ATTEMPT is what the budget counts, so it stays recorded even
        // though no process survived it — that is what makes the fourth attempt
        // refuse instead of trying forever. `record_starting` already wrote the
        // budget into the slot, and `mark` carries it forward.
        record_failure(app, id, e);
    })?;

    let lang = crate::config::ui_lang();
    let settings = effective_settings(base, &rec);
    let served = rec.surface.as_ref().map(|s| s.served).unwrap_or(false);
    if let Err(e) = handshake(&client, &program, served, &lang, &settings) {
        // never half-started: the child is stopped before the refusal is reported
        let table = crate::process_table();
        client.stop(STOP_GRACE_MS, &table);
        record_failure(app, id, &e);
        return Err(e);
    }

    let pid = client.pid();
    with_ext(|st| {
        st.procs.insert(
            id.to_string(),
            ExtProc {
                client: Some(std::sync::Arc::new(client)),
                turn,
                started_ms: now,
                last_answer_ms: now,
                restarts: spent,
                window_start_ms: opened,
                state: "running".into(),
                reason: String::new(),
                actions: Vec::new(),
            },
        );
    });
    spawn_drain(app.clone(), id.to_string(), turn);
    emit_state(app, id, "running", "", now);
    // BR-8: an id, a pid and a count. Never an argv token, never a path.
    info!(id = %id, pid = pid, args = program.args.len(), "extension started");
    row_at(base, id)
}

fn stop_at(app: &AppHandle, base: &Path, id: &str) -> Result<ExtRow, String> {
    let _ = find_record(base, id)?;
    // Stopping also clears the restart budget: a person pressing «parar» is an
    // explicit act, so the next «iniciar» is a fresh decision and not a retry.
    stop_client(id);
    emit_state(app, id, "stopped", "", 0);
    info!(id = %id, "extension stopped");
    row_at(base, id)
}

/// The live handle, cloned under the lock and used outside it.
/// THE CODE SAYS WHICH STATE IT IS. Every non-running state used to collapse into
/// `err.ext_stopped`, whose sentence is «o programa desta extensão não está rodando
/// — inicie para ver a tela»: on a hung extension the screen then printed that
/// instruction directly under a chip reading «sem resposta», about a process that
/// was in fact alive (`sweep` keeps the client precisely because it is). Two
/// contradictory claims about one process in one viewport, and the false one was
/// the instruction that walked the person into a second spawn. DESIGN §1.
fn client_of(id: &str) -> Result<std::sync::Arc<crate::mcp::McpClient>, String> {
    sweep();
    with_ext(|st| match st.procs.get(id) {
        Some(p) if p.state == "running" => p.client.clone().ok_or("err.ext_stopped".to_string()),
        Some(p) if p.state == "no_answer" => Err("err.ext_no_answer".to_string()),
        Some(p) if p.state == "crashed" || p.state == "blocked" => {
            // the reason is the fact; `err.ext_stopped` would hide it behind «inicie»
            Err(if p.reason.is_empty() {
                "err.ext_stopped".to_string()
            } else {
                p.reason.clone()
            })
        }
        _ => Err("err.ext_stopped".to_string()),
    })
}

fn note_answer(id: &str, at: i64) {
    with_ext(|st| {
        if let Some(p) = st.procs.get_mut(id) {
            p.last_answer_ms = at;
        }
    })
}

/// A program that stopped replying becomes a STATE, with the last time it did
/// answer preserved — never a spinner, and never a silent retry.
fn note_timeout(app: &AppHandle, id: &str, reason: &str) {
    let last = with_ext(|st| {
        st.procs.get_mut(id).map(|p| {
            set_state(p, "no_answer", reason);
            p.last_answer_ms
        })
    });
    if let Some(last) = last {
        emit_state(app, id, "no_answer", reason, last);
    }
}

// ---------------------------------------------------------------------------
// the rows
// ---------------------------------------------------------------------------

/// `state` for an extension with NO program is `running`, and that is a decision
/// worth stating: there is no process, so nothing could be stopped, and the
/// extension is in effect right now. `hasProgram: false` is what tells the screen
/// not to offer «iniciar»/«parar» — a control for a process that does not exist is
/// a control that lies. Among the six states, `running` is the only one that means
/// «this is working», and the row must not read as broken.
fn row_of(rec: &InstalledExt, live: Option<&LiveState>) -> ExtRow {
    let has_program = rec.program.is_some();
    let (state, reason, last) = match live {
        Some(l) => (l.state.clone(), l.reason.clone(), l.last_answer_ms),
        None if !has_program => ("running".to_string(), String::new(), 0),
        None => {
            // Not started. It is `blocked` rather than `stopped` when the machine
            // cannot honour the record at all — the same lookup the spawn uses, so
            // the two can never disagree (ADR-0030).
            let missing = rec
                .program
                .as_ref()
                .filter(|p| crate::paths::which(&p.command).is_none())
                .map(|p| format!("err.ext_program_missing:{}", p.command));
            match missing {
                Some(reason) => ("blocked".to_string(), reason, 0),
                None => ("stopped".to_string(), String::new(), 0),
            }
        }
    };
    ExtRow {
        id: rec.id.clone(),
        name: rec.name.clone(),
        version: rec.version.clone(),
        state,
        reason,
        last_answer_ms: last,
        has_surface: rec.surface.is_some(),
        has_program,
        surface_layout: rec
            .surface
            .as_ref()
            .map(|su| su.layout.clone())
            .unwrap_or_default(),
        can_stop: live.map(|l| l.has_client).unwrap_or(false),
        kinds: rec.kinds.clone(),
        origin: rec.source.path.clone(),
        program: rec.program.clone(),
        trusted: rec
            .program
            .as_ref()
            .map(|p| trusted_program(&rec.id).as_ref() == Some(p))
            .unwrap_or(true),
    }
}

fn rows_at(base: &Path) -> Vec<ExtRow> {
    let live = states_now();
    let mut rows: Vec<ExtRow> = read_record(base)
        .iter()
        .map(|rec| row_of(rec, live.get(&rec.id)))
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

fn row_at(base: &Path, id: &str) -> Result<ExtRow, String> {
    let rec = find_record(base, id)?;
    let live = states_now();
    Ok(row_of(&rec, live.get(id)))
}

// ---------------------------------------------------------------------------
// settings — two files, split by escopo (§5.9)
// ---------------------------------------------------------------------------
//
// MEASURED CORRECTION to ADR-0031 §3.5, which says machine state is «inside the
// `GIT_IGNORED` quarantine `git.rs` already enforces». It is not: `GIT_IGNORED` has
// 14 entries and no `.loro/ext` (`git.rs:2014-2029`), and `~/.loro/` is not inside
// the acervo at all — so git quarantine is irrelevant to it and the guarantee comes
// from being OUTSIDE THE REPO. Conversely `<acervo>/.loro/ext/**` IS versioned
// today, which is exactly what `escopo: projeto` wants: a teammate reads the same
// setting in Revisão. `the_project_policy_travels_and_the_machine_state_does_not`
// keeps both halves a decision instead of an accident.

/// ONE CONSTRUCTOR for the machine-scoped folder of an extension, and it refuses
/// an id that is not a name (`valid_ext_id` carries the measurement). Every sink
/// that writes or deletes outside the project goes through here: `remove_dir_all`
/// on an unguarded `join` was one commit away from deleting an arbitrary folder.
fn machine_dir(id: &str) -> Result<PathBuf, String> {
    if !valid_ext_id(id) {
        return Err("err.ext_not_found".to_string());
    }
    Ok(crate::paths::loro_data_dir().join("ext").join(id))
}

/// The same, inside the project. `acervo::guarded_existing` cannot be used here:
/// the folder may not exist yet (it is created on the first write), and that guard
/// canonicalizes an EXISTING path. So the shape is checked instead — which is the
/// stronger half anyway, because it refuses the escape before it is built.
fn project_ext_dir(base: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_ext_id(id) {
        return Err("err.ext_not_found".to_string());
    }
    Ok(base.join(".loro").join("ext").join(id))
}

/// THE APPROVAL TO RUN, and it is MACHINE state on purpose — it must not travel.
///
/// The hole it closes, measured: `.loro/ext.json` is versioned (`GIT_IGNORED` has
/// no `.loro/ext`, `git.rs:2014-2029`) and it carries `program.command` and
/// `program.args`; `start_at` gated on the restart budget, `paths::which` and the
/// cwd and nothing else; and the ONLY screen that ever named the command was the
/// install sheet, which a pulled record never crosses. So a teammate who had only
/// pulled the project could spawn a binary nobody on their machine had approved.
/// ADR-0029's R5 row asks for «explicit second confirmation, contents named»; this
/// is where the answer lives, and the answer is per machine because the question is.
///
/// It stores the program VERBATIM rather than a digest, for two reasons: comparing
/// the four fields IS the whole check, and a file a person can open and read is
/// worth more here than a hash they cannot. An edit to the record's command, args
/// or cwd therefore invalidates the approval and the confirmation is asked again.
fn trust_file(id: &str) -> Result<PathBuf, String> {
    Ok(machine_dir(id)?.join("trust.json"))
}

fn trusted_program(id: &str) -> Option<ExtProgram> {
    let text = std::fs::read_to_string(trust_file(id).ok()?).ok()?;
    serde_json::from_str::<ExtProgram>(&text).ok()
}

fn trust_program(id: &str, program: &ExtProgram) -> Result<(), String> {
    let p = trust_file(id)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "err.ext_write_failed".to_string())?;
    }
    std::fs::write(
        &p,
        serde_json::to_string_pretty(program).map_err(|_| "err.ext_write_failed".to_string())?,
    )
    .map_err(|_| "err.ext_write_failed".to_string())?;
    // BR-8: an id and a COUNT. Never an argv token, never a path.
    info!(id = %id, args = program.args.len(), "extension program approved on this machine");
    Ok(())
}

fn settings_file(base: &Path, id: &str, escopo: &str) -> Result<PathBuf, String> {
    let dir = if escopo == "maquina" {
        machine_dir(id)?
    } else {
        project_ext_dir(base, id)?
    };
    Ok(dir.join("settings.json"))
}

fn read_settings_file(p: &Path) -> serde_json::Map<String, Value> {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Every declared setting with the value that is in effect. The value is read from
/// THE FILE ITS OWN `escopo` NAMES: reading both and merging would let one person's
/// machine value answer for a project field, which is the drift `escopo` exists to
/// prevent.
/// The settings SCHEMA, from the same place the level-1 view already comes
/// from: the pacote's origin, re-read per call, falling back to the record
/// when the origin is unreadable. MEASURED on the owner's acervo (2026-08-20,
/// `.loro/ext.json`): a record installed hours earlier carried `settings: []`
/// while the origin's manifest declared four — the re-read view bound
/// `settings.filtro`, the record-driven payload had no value for it, and the
/// screen painted one refusal per binding. Reading view and schema from TWO
/// sources is the second-artefact rule (ADR-0026) inside one feature: they
/// drift, and the drift lands on the person as «não funciona». The origin's
/// schema still crosses the SAME gates as an install (parse_manifest refuses a
/// credential field before this returns anything).
fn live_schema(rec: &InstalledExt) -> Vec<ExtSettingField> {
    resolve_source(&rec.source.path)
        .and_then(|dir| read_manifests(&dir).map(|(_, lm)| lm))
        .and_then(|lm| parse_manifest(&lm))
        .map(|pv| pv.settings)
        .unwrap_or_else(|_| rec.settings.clone())
}

fn effective_settings(base: &Path, rec: &InstalledExt) -> Value {
    let mut out = serde_json::Map::new();
    // An unreadable/refused path is an EMPTY map, which is what the caller already
    // handles: the declared default answers, and no setting is invented.
    let projeto = settings_file(base, &rec.id, "projeto")
        .map(|p| read_settings_file(&p))
        .unwrap_or_default();
    let maquina = settings_file(base, &rec.id, "maquina")
        .map(|p| read_settings_file(&p))
        .unwrap_or_default();
    for f in &live_schema(rec) {
        let stored = if f.escopo == "maquina" {
            maquina.get(&f.id)
        } else {
            projeto.get(&f.id)
        };
        let v = stored
            .cloned()
            .or_else(|| f.default.clone())
            .unwrap_or(Value::Null);
        out.insert(f.id.clone(), v);
    }
    Value::Object(out)
}

fn valid_setting_value(f: &ExtSettingField, v: &Value) -> bool {
    let plain_string = |s: &str| s.chars().count() <= 400 && !s.chars().any(|c| c.is_control());
    match f.kind.as_str() {
        "bool" => v.is_boolean(),
        "number" => v.is_number(),
        "enum" => v.as_str().is_some_and(|s| f.options.iter().any(|o| o == s)),
        "path" => v.as_str().is_some_and(cap_rel),
        "host" => v.as_str().is_some_and(cap_host),
        "string" => v.as_str().is_some_and(|s| {
            plain_string(s)
                && (f.pattern.is_empty()
                    || pattern_parse(&f.pattern)
                        .map(|e| pattern_matches(&e, s))
                        .unwrap_or(false))
        }),
        _ => false,
    }
}

/// THE EXTENSION CANNOT WRITE ITS OWN SETTINGS. There is no protocol method for it
/// (§4.3 has four calls and none of them writes), and this path is reachable only
/// from Configurações.
fn set_settings_at(base: &Path, id: &str, values: &Value) -> Result<Value, String> {
    let rec = find_record(base, id)?;
    let Some(obj) = values.as_object() else {
        return Err(format!("err.ext_settings_invalid:{id}"));
    };
    let mut per_escopo: HashMap<&str, Vec<(String, Value)>> = HashMap::new();
    for (k, v) in obj {
        // BR-9 again, on the WRITE side: the schema gate refuses a credential field
        // at install, and this one refuses a key that never went through it.
        if names_a_credential(k) {
            return Err(format!("err.ext_settings_secret:{k}"));
        }
        let schema = live_schema(&rec);
        let Some(f) = schema.iter().find(|f| &f.id == k) else {
            return Err(format!("err.ext_settings_invalid:{k}"));
        };
        if !valid_setting_value(f, v) {
            return Err(format!("err.ext_settings_invalid:{k}"));
        }
        per_escopo
            .entry(if f.escopo == "maquina" {
                "maquina"
            } else {
                "projeto"
            })
            .or_default()
            .push((k.clone(), v.clone()));
    }
    for (escopo, pairs) in per_escopo {
        let p = settings_file(base, id, escopo)?;
        // read-modify-write: the OTHER keys of this file are somebody else's
        // decision, and writing one must not erase them (config.rs:367-370)
        let mut current = read_settings_file(&p);
        for (k, v) in pairs {
            current.insert(k, v);
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "err.ext_write_failed".to_string())?;
        }
        std::fs::write(
            &p,
            serde_json::to_string_pretty(&Value::Object(current))
                .map_err(|_| "err.ext_write_failed".to_string())?,
        )
        .map_err(|_| "err.ext_write_failed".to_string())?;
    }
    // BR-8/BR-9: how many keys changed, never which value they took
    info!(id = %id, keys = obj.len(), "extension settings written");
    Ok(effective_settings(base, &rec))
}

// ---------------------------------------------------------------------------
// the capability policy
// ---------------------------------------------------------------------------
//
// IN R5a A CAPABILITY GRANTS NOTHING, AND THE SHEET SAYS SO. There is no
// filesystem API, no net API and no agent API for an extension in this round, so
// there is no code path that could act on a grant — and a permission screen that
// implies enforcement which does not exist is a state that lies (§5.8). What is
// real is the ANSWER: it is stored, it travels with the project, and «recusar» is
// a real no that is not asked again (ADR-0029 §4.18).

fn read_policy(base: &Path) -> ExtPolicy {
    crate::config::read_acervo_settings(base)
        .ext
        .unwrap_or_default()
}

/// NEVER CONSTRUCT A FRESH `AcervoSettings`. The comment at `config.rs:367-370`
/// records the incident: the autoContext toggle wrote a new struct, and with a
/// second key in the file (the loops policy) saving the first erased the second in
/// silence. Whoever changes one field reads the rest first.
fn write_policy(base: &Path, policy: &ExtPolicy) -> Result<(), String> {
    let mut settings = crate::config::read_acervo_settings(base);
    settings.ext = Some(policy.clone());
    crate::config::write_acervo_settings_full(base, &settings)
        .map_err(|_| "err.ext_write_failed".to_string())
}

fn capabilities_at(base: &Path, id: &str) -> Result<Vec<ExtCapability>, String> {
    let rec = find_record(base, id)?;
    let policy = read_policy(base);
    let granted = policy.permite.get(id).cloned().unwrap_or_default();
    let refused = policy.recusa.get(id).cloned().unwrap_or_default();
    Ok(rec
        .capabilities
        .iter()
        .map(|c| ExtCapability {
            id: c.id.clone(),
            // a capability id is not prose and is not translated; the sentence the
            // person reads is `why`, which the author had to write in both languages
            label: c.id.clone(),
            kind: capability_kind(&c.id).to_string(),
            decision: if granted.iter().any(|g| g == &c.id) {
                "granted".into()
            } else if refused.iter().any(|r| r == &c.id) {
                "refused".into()
            } else {
                String::new()
            },
            why: c.why.clone(),
        })
        .collect())
}

fn permit_at(base: &Path, id: &str, capability: &str, decision: &str) -> Result<ExtPolicy, String> {
    let rec = find_record(base, id)?;
    if !valid_capability_id(capability) {
        return Err(format!("err.ext_capability_invalid:{capability}"));
    }
    // A grant for something the manifest never asked for is an answer to a question
    // nobody put: the sheet only ever offers what `capabilities` declared.
    if !rec.capabilities.iter().any(|c| c.id == capability) {
        return Err(format!("err.ext_capability_invalid:{capability}"));
    }
    let mut policy = read_policy(base);
    for map in [&mut policy.permite, &mut policy.recusa] {
        if let Some(list) = map.get_mut(id) {
            list.retain(|c| c != capability);
        }
    }
    // the same three words `loops::loop_permit` uses (loops.rs:1622-1667), because
    // «esquecer» has to exist: a decision a person cannot take back is not a decision
    match decision.trim() {
        "permitir" => policy
            .permite
            .entry(id.to_string())
            .or_default()
            .push(capability.to_string()),
        "recusar" => policy
            .recusa
            .entry(id.to_string())
            .or_default()
            .push(capability.to_string()),
        "esquecer" => {}
        _ => return Err("err.ext_decision_invalid".into()),
    }
    for map in [&mut policy.permite, &mut policy.recusa] {
        map.retain(|_, list| {
            list.sort();
            list.dedup();
            !list.is_empty()
        });
    }
    write_policy(base, &policy)?;
    info!(id = %id, decision = %decision.trim(), "extension capability decided");
    Ok(policy)
}

// ---------------------------------------------------------------------------
// the view and the action
// ---------------------------------------------------------------------------

async fn view_at(
    app: &AppHandle,
    base: &Path,
    id: &str,
    lang: &str,
) -> Result<ExtViewPayload, String> {
    let rec = find_record(base, id)?;
    let surface = rec.surface.clone().ok_or("err.ext_surface_missing")?;
    let facts = facts_now().await?;
    let t0 = now_ms();

    let (doc, source) = if surface.served {
        let client = client_of(id)?;
        let doc = client
            .call_tool("loro/view", &serde_json::json!({ "lang": lang }), VIEW_MS)
            .inspect_err(|e| {
                if e.starts_with("err.ext_timeout") {
                    note_timeout(app, id, e);
                }
            })?;
        note_answer(id, now_ms());
        (doc, "program")
    } else {
        (manifest_view(&rec)?, "manifest")
    };

    // THE BOUNDARY. A reply off a program is untrusted input, and a level-1 file is
    // somebody else's commit: both are validated with the same walker before either
    // one reaches the renderer.
    validate_view_envelope(&doc)?;

    let actions = actions_of(&doc);
    with_ext(|st| {
        if let Some(p) = st.procs.get_mut(id) {
            p.actions = actions;
        }
    });

    let row = row_of(&rec, states_now().get(id));
    let settings = effective_settings(base, &rec);
    let surface_layout = resolve_source(&rec.source.path)
        .and_then(|dir| read_manifests(&dir).map(|(_, lm)| lm))
        .and_then(|lm| parse_manifest(&lm))
        .ok()
        .and_then(|pv| pv.surface.map(|su| su.layout))
        .unwrap_or_else(|| surface.layout.clone());
    Ok(ExtViewPayload {
        id: id.to_string(),
        state: row.state,
        view: doc,
        facts,
        served_ms: now_ms() - t0,
        source: source.to_string(),
        surface_layout,
        settings,
    })
}

/// One flat object: a `field` id and an `args` key share the namespace (§4.3), so a
/// key outside the grammar, a non-scalar value or more than 32 of them is refused
/// before it crosses.
fn valid_action_values(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    if o.len() > 32 {
        return false;
    }
    o.iter().all(|(k, val)| {
        ident_dash(k, 31)
            && match val {
                Value::String(s) => s.chars().count() <= 400 && !s.chars().any(|c| c.is_control()),
                Value::Number(_) | Value::Bool(_) | Value::Null => true,
                _ => false,
            }
    })
}

fn action_at(
    app: &AppHandle,
    base: &Path,
    id: &str,
    action: &str,
    values: &Value,
    lang: &str,
    now: &crate::loops::Now,
) -> Result<ExtActionOutcome, String> {
    let rec = find_record(base, id)?;
    if !ident_snake(action, 47) {
        return Err(format!("err.ext_action_unknown:{action}"));
    }
    if !valid_action_values(values) {
        return Err("err.ext_view_value:button.args".into());
    }
    // AN ACTION NO NODE DECLARED IS NOT A BUTTON A PERSON PRESSED. For a served
    // surface the set comes from the last document the program served; for a level-1
    // surface it is read straight off the pacote.
    let declared: Vec<String> = if rec.surface.as_ref().map(|s| s.served).unwrap_or(false) {
        with_ext(|st| st.procs.get(id).map(|p| p.actions.clone())).unwrap_or_default()
    } else {
        actions_of(&manifest_view(&rec)?)
    };
    if !declared.iter().any(|a| a == action) {
        return Err(format!("err.ext_action_unknown:{action}"));
    }
    if rec.program.is_none() {
        // a level-1 static view has nobody to answer a button; the refusal is named
        // rather than silent, and the author's own README is where the fix lives
        return Err("err.ext_stopped".into());
    }
    let client = client_of(id)?;
    let reply = client
        .call_tool(
            "loro/action",
            &serde_json::json!({ "action": action, "values": values, "lang": lang }),
            ACTION_MS,
        )
        .inspect_err(|e| {
            if e.starts_with("err.ext_timeout") {
                note_timeout(app, id, e);
            }
        })?;

    let outcome = reply
        .get("outcome")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !["ok", "nothing", "failed"].contains(&outcome.as_str()) {
        return Err("err.ext_bad_payload:loro/action".into());
    }
    let message = i18n_at(&reply, "message", "/message")?;
    let invalidate = reply
        .get("invalidate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // the person's own wall clock, as the frontend read it — the app never reads a
    // civil clock in the backend (loops.rs:169-175)
    let stamp = if now.epoch_ms > 0 {
        now.epoch_ms
    } else {
        now_ms()
    };
    note_answer(id, stamp);
    if invalidate {
        let _ = app.emit("ext-view-invalidated", serde_json::json!({ "id": id }));
    }
    // BR-8: the action id and the outcome word. Never a value the person typed.
    info!(id = %id, action = %action, outcome = %outcome, "extension action");
    Ok(ExtActionOutcome {
        outcome,
        message,
        invalidate,
    })
}

// ---------------------------------------------------------------------------
// preview, install, remove
// ---------------------------------------------------------------------------

/// The acervo-relative name of the knowledge folder. ADR-0026 §14: it may be
/// `contexts/` or, in an acervo nobody has migrated yet, `contextos/`. The plan has
/// to name the one that EXISTS — with a fixed name the preview promised one path,
/// the conflict check looked at another and the seeder wrote to a third.
fn contexts_rel(base: &Path) -> String {
    crate::paths::contexts_dir(base)
        .strip_prefix(base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| "contexts".into())
}

/// Every MCP server name already taken in this project: the `program.server` of
/// every installed extension, then the keys of `mcpServers` in `.mcp.json`.
///
/// R5a NEVER WRITES `.mcp.json` — Loro reads that file and never writes it
/// (`loops.rs:2392-2395`), and the `tools` point is out of this round. The check
/// exists anyway because `loops::capabilities_of` keys by server name
/// (`loops.rs:2362-2390`): a silent overwrite later would repoint a tool somebody
/// had ALREADY granted.
fn taken_server_names(base: &Path, except_id: &str) -> Vec<String> {
    let mut out: Vec<String> = read_record(base)
        .into_iter()
        .filter(|e| e.id != except_id)
        .filter_map(|e| e.program.map(|p| p.server))
        .collect();
    if let Ok(text) = std::fs::read_to_string(base.join(".mcp.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(o) = v.get("mcpServers").and_then(|m| m.as_object()) {
                out.extend(o.keys().cloned());
            }
        }
    }
    out
}

/// Read-only: what this pacote is, what it would write, and what the triage found.
/// Writes nothing, anywhere.
pub(crate) fn preview_at(base: &Path, source: &str) -> Result<ExtPreview, String> {
    let dir = resolve_source(source)?;
    let (cc, lm) = read_manifests(&dir)?;
    let parsed = parse_manifest(&lm)?;
    let id = crate::loops::slugify(&cc.name);
    if id.is_empty() {
        return Err("err.ext_manifest_invalid".into());
    }

    let mut entries: Vec<String> = Vec::new();
    walk(&dir, "", 6, &mut entries);
    entries.sort();

    // ONE PLANNER, NOT TWO: the declarative half is `plugins::plan_for`, called and
    // never copied, so a habilidade from an extension lands exactly where a
    // habilidade from a pacote lands.
    let seed_contexts: Vec<String> = lm
        .get("seed")
        .and_then(|s| s.get("contexts"))
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let writes = crate::plugins::plan_for(&entries, &seed_contexts, &contexts_rel(base));

    if parsed.surface.is_none() && parsed.program.is_none() && writes.is_empty() {
        return Err("err.ext_nothing_to_install".into());
    }

    // THE TRIAGE RUNS ON THE CONTENT THAT WOULD BE WRITTEN (ADR-0024), and it runs
    // through `intake::scan`/`::blocked` — never `brain_triage_files`, which is the
    // fila's, is synchronous, and SILENTLY SKIPS an unreadable file where this path
    // has to refuse it.
    let mut findings: Vec<crate::plugins::TriageFinding> = Vec::new();
    let mut blocked = false;
    for w in &writes {
        if w.src.is_empty() {
            continue; // a seeded context is written from the app's own template
        }
        let src = guarded_src(&dir, &w.src)?;
        let Ok(text) = std::fs::read_to_string(&src) else {
            return Err(format!("err.ext_unreadable_file:{}", w.src));
        };
        let f = crate::intake::scan(&text);
        if !f.is_empty() {
            blocked = blocked || crate::intake::blocked(&f);
            findings.push(crate::plugins::TriageFinding {
                rel: w.dest.clone(),
                findings: f,
            });
        }
    }

    if let Some(p) = &parsed.program {
        let taken = taken_server_names(base, &id);
        if taken.iter().any(|s| s == &p.server) {
            return Err(format!("err.ext_server_conflict:{}", p.server));
        }
    }

    let conflicts: Vec<String> = writes
        .iter()
        .filter(|w| base.join(&w.dest).exists())
        .map(|w| w.dest.clone())
        .collect();
    let installed = read_record(base)
        .into_iter()
        .find(|e| e.id == id)
        .map(|e| e.version);

    Ok(ExtPreview {
        id,
        name: cc.name.trim().to_string(),
        version: cc.version.trim().to_string(),
        author: cc.author.unwrap_or_default().name.trim().to_string(),
        source: dir.to_string_lossy().to_string(),
        kinds: parsed.kinds,
        points: parsed.points.keys().cloned().collect(),
        unsupported: parsed.unsupported,
        // `trust` is the subject of the install sheet's sentence: this extension
        // will run a program on this machine. Loro does not claim a sandbox
        // (ADR-0031 P2), so the sentence is the honest half of the offer.
        trust: parsed.program.is_some(),
        program: parsed.program,
        surface: parsed.surface,
        capabilities: parsed.capabilities,
        settings: parsed.settings,
        writes,
        findings,
        blocked,
        conflicts,
        installed,
    })
}

fn install_at(base: &Path, source: &str, hoje: &str) -> Result<ExtInstallOutcome, String> {
    // The frozen order: manifest → points → surface exclusivity → settings schema
    // (the credential refusal FIRST) → capability ids → source/paths → plan → triage
    // → id conflict → server conflict → every file readable → THEN the first byte.
    // `preview_at` is the first eight steps and it writes nothing, which is what
    // makes the two BR-9 gates provably ahead of any write.
    let pv = preview_at(base, source)?;
    if pv.blocked {
        let file = pv
            .findings
            .iter()
            .find(|f| crate::intake::blocked(&f.findings))
            .map(|f| f.rel.clone())
            .unwrap_or_default();
        return Err(format!("err.intake_secret:{file}"));
    }
    if let Some(v) = &pv.installed {
        return Err(format!("err.ext_id_conflict:{v}"));
    }
    let dir = resolve_source(source)?;
    let lang = crate::config::active_acervo_lang();

    // Validate ALL before writing ANY (the pattern the fila already uses): an error
    // halfway through left orphan files in the project and no record of them, and
    // the second attempt then hit «já existe».
    for w in &pv.writes {
        if w.src.is_empty() {
            continue;
        }
        let src = guarded_src(&dir, &w.src)?;
        if std::fs::read_to_string(&src).is_err() {
            return Err(format!("err.ext_unreadable_file:{}", w.src));
        }
    }

    let mut written: Vec<crate::plugins::InstalledFile> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for w in &pv.writes {
        let dest_abs = base.join(&w.dest);
        if w.kind == "skill" {
            // a habilidade may never shadow a built-in one
            let leaf = w.dest.rsplit('/').next().unwrap_or_default();
            if crate::acervo::BUILTIN_SKILLS.contains(&leaf) {
                skipped.push(w.dest.clone());
                continue;
            }
        }
        if dest_abs.exists() {
            skipped.push(w.dest.clone()); // never overwrite what is already there
            continue;
        }
        if let Some(parent) = dest_abs.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "err.ext_write_failed".to_string())?;
        }
        if w.kind == "context" {
            // the acervo's OWN scaffolding, through the one non-destructive seeder
            crate::seed_context(base, &w.label, &lang, None)?;
            let real = crate::paths::contexts_dir(base)
                .join(&w.label)
                .join("context.md");
            let rel = real
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| w.dest.clone());
            let sha = crate::models::sha256_of(&real).unwrap_or_default();
            written.push(crate::plugins::InstalledFile { rel, sha256: sha });
            continue;
        }
        let src = guarded_src(&dir, &w.src)?;
        let text = std::fs::read_to_string(&src).map_err(|_| "err.ext_write_failed".to_string())?;
        let body = if w.kind == "loop" {
            // a loop from a pacote arrives OFF; arming is the person's act
            crate::loops::disarm_markdown(&text)
        } else {
            text
        };
        std::fs::write(&dest_abs, &body).map_err(|_| "err.ext_write_failed".to_string())?;
        let sha = crate::models::sha256_of(&dest_abs).unwrap_or_default();
        written.push(crate::plugins::InstalledFile {
            rel: w.dest.clone(),
            sha256: sha,
        });
    }

    let mut rec = read_record(base);
    rec.retain(|e| e.id != pv.id);
    rec.push(InstalledExt {
        id: pv.id.clone(),
        name: pv.name.clone(),
        version: pv.version.clone(),
        source: ExtSource {
            kind: "dir".into(),
            path: pv.source.clone(),
        },
        kinds: pv.kinds.clone(),
        points: pv.points.clone(),
        installed_at: hoje.to_string(),
        files: written.clone(),
        program: pv.program.clone(),
        surface: pv.surface.clone(),
        capabilities: pv.capabilities.clone(),
        settings: pv.settings.clone(),
    });
    rec.sort_by(|a, b| a.id.cmp(&b.id));
    write_record(base, &rec)?;

    // THE INSTALL SHEET IS THE CONFIRMATION. It named this command and said the
    // sentence («isto vai rodar um programa nesta máquina»), and the person went
    // ahead — so the approval is recorded HERE, on this machine, and «iniciar» does
    // not ask a second time for the same program. A record that arrives by any
    // other route than this function has no approval and cannot start (`start_at`).
    if let Some(p) = &pv.program {
        // NOT fatal, and the direction of the failure is the safe one: everything
        // above is already on disk, so refusing the install here would report a
        // failure that happened after the fact. Without the approval on file
        // «iniciar» simply asks — which is the honest state, not a broken one.
        if let Err(e) = trust_program(&pv.id, p) {
            warn!(id = %pv.id, code = %e, "extension installed, approval not written");
        }
    }

    // BR-8/BR-9: ids and counts. Never a path from inside the pacote's content,
    // never a finding, never a settings value.
    info!(
        id = %pv.id,
        version = %pv.version,
        files = written.len(),
        skipped = skipped.len(),
        program = pv.program.is_some(),
        "extension installed"
    );
    Ok(ExtInstallOutcome {
        id: pv.id,
        version: pv.version,
        written: written.into_iter().map(|f| f.rel).collect(),
        skipped,
        trust: pv.trust,
    })
}

/// Take the client out of the map and stop it, with nothing held. Split out of
/// `stop_at` because `ext_remove` has no `AppHandle` in its frozen signature and
/// still has to stop the process BEFORE it rewrites the record — an orphan process
/// holding a port the user cannot see is worse than a slow uninstall.
fn stop_client(id: &str) {
    let taken = with_ext(|st| {
        st.procs.get_mut(id).and_then(|p| {
            let c = p.client.take();
            p.restarts = 0;
            p.window_start_ms = 0;
            p.actions.clear();
            set_state(p, "stopped", "");
            c
        })
    });
    if let Some(arc) = taken {
        shutdown(id, arc);
    }
}

/// Take the live handle out of the slot WITHOUT touching the budget or the state.
/// Split from `stop_client` because `start_at` has to retire a previous child
/// before it spawns, and `stop_client` resets `restarts` to 0 — calling it there
/// would have handed the crash-loop budget a fresh window on every attempt, which
/// is the one bug in a supervisor that costs a machine.
fn take_client(id: &str) -> Option<std::sync::Arc<crate::mcp::McpClient>> {
    with_ext(|st| st.procs.get_mut(id).and_then(|p| p.client.take()))
}

/// Stop a handle that is already out of the registry.
fn shutdown(id: &str, arc: std::sync::Arc<crate::mcp::McpClient>) {
    let table = crate::process_table();
    let pid = arc.pid();
    // BR-8: a DURATION, which is what tells whether a program died young or was
    // stopped by a person. Never an argv token and never a path.
    let uptime_ms = with_ext(|st| st.procs.get(id).map(|p| now_ms() - p.started_ms)).unwrap_or(0);
    info!(id = %id, pid = pid, uptime_ms = uptime_ms, "extension stopping");
    match std::sync::Arc::try_unwrap(arc) {
        // ORDER ON STOP (§4.7): drop the child's stdin (the graceful signal —
        // `lib.rs:1076` and `:1163` prove the shape), wait up to the grace, then kill
        // the tree. `mcp::stop` owns that sequence.
        Ok(client) => client.stop(STOP_GRACE_MS, &table),
        // A call is still in flight and holds a clone, so the graceful path is not
        // available: kill the tree from the snapshot instead. The in-flight call then
        // fails by name and drops its clone.
        Err(_) => {
            let killed = crate::mcp::kill_tree(pid, &table);
            warn!(id = %id, killed = killed, "extension stopped while a call was in flight");
        }
    }
}

fn remove_at(base: &Path, id: &str, also_data: bool) -> Result<ExtRemoveOutcome, String> {
    let rec = find_record(base, id)?;
    // the process goes first, and the map slot with it
    stop_client(id);
    with_ext(|st| st.procs.remove(id));

    let mut removed = Vec::new();
    let mut kept = Vec::new();
    for f in &rec.files {
        // THE RECORD IS UNTRUSTED INPUT. `.loro/ext.json` is versioned: it arrives in
        // somebody else's commit, and a `rel` like `../segredo.txt` would make this
        // removal delete a file OUTSIDE the project. The guard is the one every
        // acervo path crosses (canonicalize + starts_with) — the same test
        // `brain_remove_plugin` has one file over.
        let Ok(abs) = crate::acervo::guarded_existing(base, &f.rel) else {
            if base.join(&f.rel).exists() {
                kept.push(f.rel.clone());
            }
            continue;
        };
        let now = crate::models::sha256_of(&abs).unwrap_or_default();
        // An EMPTY digest means «I do not know what was here» (the machine had no
        // hash tool at install time). Not knowing is a reason to KEEP the file, never
        // to delete it: remove subtracts what the pacote brought, and what it brought
        // is what can be proved.
        if f.sha256.is_empty() || !now.eq_ignore_ascii_case(&f.sha256) {
            kept.push(f.rel.clone());
            continue;
        }
        if std::fs::remove_file(&abs).is_ok() {
            removed.push(f.rel.clone());
            if let Some(slug) = crate::loops::slug_of_rel(&f.rel) {
                crate::loops::forget_runtime(base, &slug);
            }
        } else {
            kept.push(f.rel.clone());
        }
    }

    let mut list = read_record(base);
    list.retain(|e| e.id != id);
    write_record(base, &list)?;

    // BOTH sides of the erase go through the guarded constructors: this is the
    // `remove_dir_all` the record's id used to reach unguarded, and `find_record`
    // above has already refused an id that is not a name.
    let machine_dir = machine_dir(id)?;
    if also_data {
        let _ = std::fs::remove_dir_all(&machine_dir);
        let _ = std::fs::remove_dir_all(project_ext_dir(base, id)?);
    }
    info!(id = %id, removed = removed.len(), kept = kept.len(), data_kept = !also_data, "extension removed");
    Ok(ExtRemoveOutcome {
        removed,
        kept,
        data_kept: !also_data,
        // shown to the person who owns the machine, so they can find what stayed.
        // BR-8: it is RETURNED, never logged — a home directory is PII (proc.rs:171).
        data_dir: machine_dir.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// IPC — thirteen commands, every one `pub async fn` (ADR-0022 §28)
// ---------------------------------------------------------------------------
//
// Each one is a thin wrapper over a `*_at(base, …)` core, which is what makes the
// cores testable against a temporary acervo instead of against the machine's own
// active project.

fn base() -> Result<PathBuf, String> {
    crate::acervo::acervo_base()
}

#[tauri::command]
pub async fn ext_list() -> Result<Vec<ExtRow>, String> {
    let base = base()?;
    Ok(rows_at(&base))
}

#[tauri::command]
pub async fn ext_preview(source: String) -> Result<ExtPreview, String> {
    let base = base()?;
    preview_at(&base, &source)
}

#[tauri::command]
pub async fn ext_install(source: String, hoje: String) -> Result<ExtInstallOutcome, String> {
    let base = base()?;
    install_at(&base, &source, hoje.trim())
}

#[tauri::command]
pub async fn ext_remove(id: String, also_data: bool) -> Result<ExtRemoveOutcome, String> {
    let base = base()?;
    remove_at(&base, id.trim(), also_data)
}

#[tauri::command]
pub async fn ext_start(
    app: tauri::AppHandle,
    id: String,
    approve: Option<bool>,
) -> Result<ExtRow, String> {
    let base = base()?;
    // `Option` and not `bool`: an older caller that sends no field means «I did not
    // approve anything», which is the safe answer and not a deserialization error.
    start_at(&app, &base, id.trim(), approve.unwrap_or(false))
}

#[tauri::command]
pub async fn ext_stop(app: tauri::AppHandle, id: String) -> Result<ExtRow, String> {
    let base = base()?;
    stop_at(&app, &base, id.trim())
}

#[tauri::command]
pub async fn ext_view(
    app: tauri::AppHandle,
    id: String,
    lang: String,
) -> Result<ExtViewPayload, String> {
    let base = base()?;
    let lang = crate::config::normalize_lang(&lang);
    view_at(&app, &base, id.trim(), &lang).await
}

#[tauri::command]
pub async fn ext_action(
    app: tauri::AppHandle,
    id: String,
    action: String,
    values: serde_json::Value,
    lang: String,
    now: crate::loops::Now,
) -> Result<ExtActionOutcome, String> {
    let base = base()?;
    let lang = crate::config::normalize_lang(&lang);
    action_at(&app, &base, id.trim(), action.trim(), &values, &lang, &now)
}

#[tauri::command]
pub async fn ext_settings_schema(id: String) -> Result<Vec<ExtSettingField>, String> {
    let base = base()?;
    Ok(live_schema(&find_record(&base, id.trim())?))
}

#[tauri::command]
pub async fn ext_settings_get(id: String) -> Result<serde_json::Value, String> {
    let base = base()?;
    let rec = find_record(&base, id.trim())?;
    Ok(effective_settings(&base, &rec))
}

#[tauri::command]
pub async fn ext_settings_set(
    id: String,
    values: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let base = base()?;
    set_settings_at(&base, id.trim(), &values)
}

#[tauri::command]
pub async fn ext_capabilities(id: String) -> Result<Vec<ExtCapability>, String> {
    let base = base()?;
    capabilities_at(&base, id.trim())
}

#[tauri::command]
pub async fn ext_permit(
    id: String,
    capability: String,
    decision: String,
) -> Result<ExtPolicy, String> {
    let base = base()?;
    permit_at(&base, id.trim(), capability.trim(), &decision)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the harness ------------------------------------------------------
    //
    // House style (`plugins.rs:786`, `presets.rs:398`): the helpers are copied per
    // module rather than shared, so batch A and batch B never touch one file.

    // LORO_HOME is process-global; serialize with the CRATE-WIDE lock — a
    // per-module lock serialized nothing against chat.rs (proc::TEST_ENV_LOCK).
    use crate::proc::TEST_ENV_LOCK as ENV_LOCK;

    fn nonce() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    fn tmp(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("loro-ext-{tag}-{}-{}", std::process::id(), nonce()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// A hermetic run: `LORO_HOME` points at a scratch dir, so nothing reads or
    /// writes the developer's own `~/.loro`.
    fn with_home<T>(f: impl FnOnce(&Path) -> T) -> T {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp("home");
        std::env::set_var("LORO_HOME", &home);
        let out = f(&home);
        std::env::remove_var("LORO_HOME");
        drop(guard);
        let _ = std::fs::remove_dir_all(&home);
        out
    }

    /// Drive one `async fn` to completion without a runtime. There is NO tokio and
    /// no dev-dependency in this crate (measured: `Cargo.toml` lists tauri, serde,
    /// serde_json, tracing*, portable-pty, windows-sys and nothing else), and adding
    /// one is a contract change. The poll budget is bounded ON PURPOSE: a suite that
    /// hangs is the failure mode ADR-0022 §28 exists to prevent, so this panics
    /// instead of spinning forever.
    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        unsafe fn noop(_: *const ()) {}
        unsafe fn clone_raw(p: *const ()) -> RawWaker {
            RawWaker::new(p, &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone_raw, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = std::pin::pin!(fut);
        for _ in 0..100_000 {
            if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v;
            }
            std::thread::yield_now();
        }
        panic!("the future never completed — a test must never hang (ADR-0022 §28)");
    }

    /// A pacote with the two manifests and nothing else.
    fn pacote(tag: &str, name: &str, loro_json: &str) -> PathBuf {
        let dir = tmp(tag);
        write(
            &dir.join(".claude-plugin/plugin.json"),
            &format!(r#"{{"name":"{name}","version":"1.0.0","author":{{"name":"Loro"}}}}"#),
        );
        write(&dir.join("loro.json"), loro_json);
        dir
    }

    const BOARD: &str = r#"{"loroView":1,"view":[{"kind":"text","text":{"pt":"oi","en":"hi"}}]}"#;

    /// A level-1 extension: a surface, a view file, zero code.
    fn pacote_level1(tag: &str, name: &str) -> PathBuf {
        let dir = pacote(
            tag,
            name,
            r#"{"loro":2,"kinds":["surface"],"points":{"surface":1},
                "surface":{"title":{"pt":"Painel","en":"Board"},"viewFile":"surface/board.json"}}"#,
        );
        write(&dir.join("surface/board.json"), BOARD);
        dir
    }

    fn manifest(json: &str) -> Result<ParsedManifest, String> {
        parse_manifest(&serde_json::from_str::<Value>(json).unwrap())
    }

    // ---- the wiring guard -------------------------------------------------

    // A command that is defined and never registered fails only at runtime, as an
    // invoke rejection — nothing else in the suite catches it. And ADR-0022 §28,
    // once more: heavy work in a SYNCHRONOUS command runs on the main thread and
    // freezes the window. These walk a pacote, hash files, read the whole knowledge
    // graph and talk to a child process. `lib.rs`'s own guard is a hand-written
    // 8-name list (`lib.rs:6763-6781`), so it does not see this module at all.
    //
    // The needles are assembled so this test cannot pass by matching itself.
    #[test]
    fn every_command_here_is_async_and_reachable_from_the_screen() {
        let mine = include_str!("ext.rs");
        let wiring = include_str!("lib.rs");
        let mut found = 0;
        let needle = format!("#[{}]", "tauri::command");
        for (i, _) in mine.match_indices(needle.as_str()) {
            let rest = &mine[i..];
            let decl = rest
                .lines()
                .nth(1)
                .expect("a command declaration follows the attribute");
            let name = decl
                .split("fn ")
                .nth(1)
                .and_then(|s| s.split('(').next())
                .expect("the command's name")
                .trim();
            assert!(
                decl.contains(&format!("pub {} fn", "async")),
                "{name} has to be async: it reads the acervo, hashes files or waits on a child"
            );
            assert!(
                wiring.contains(&format!("{}::{name},", "ext")),
                "{name} is defined but never registered in generate_handler"
            );
            found += 1;
        }
        assert_eq!(found, 13, "the scanner went blind: {found} commands");
    }

    #[test]
    fn the_state_vocabulary_is_closed() {
        // every state this module can set is one the screen knows how to paint
        for s in [
            "stopped",
            "starting",
            "running",
            "no_answer",
            "crashed",
            "blocked",
        ] {
            assert!(EXT_STATES.contains(&s));
        }
        assert_eq!(EXT_STATES.len(), 6);
        for reason in [
            "err.ext_protocol_unsupported:x",
            "err.ext_server_mismatch:x",
            "err.ext_reserved_name:loro/exec",
            "err.ext_describe_missing",
            "err.ext_program_missing:python3",
        ] {
            assert_eq!(state_for_reason(reason), "blocked", "{reason}");
        }
        for reason in [
            "err.ext_spawn",
            "err.ext_timeout:initialize",
            "err.ext_no_answer",
        ] {
            assert_eq!(state_for_reason(reason), "crashed", "{reason}");
        }
    }

    // ---- the manifest -----------------------------------------------------

    // How to see it red: raise the gate to `> 3` and the fixture installs half of a
    // manifest whose meaning this code does not know.
    #[test]
    fn a_manifest_written_for_a_newer_loro_is_refused_by_name() {
        assert_eq!(
            manifest(r#"{"loro":3,"surface":{"title":{"pt":"a","en":"a"},"view":[]}}"#)
                .unwrap_err(),
            "err.ext_protocol_unsupported:3"
        );
        // and a v1 pacote is refused here too: it has its own door
        assert_eq!(
            manifest(r#"{"loro":1,"kinds":["skills"]}"#).unwrap_err(),
            "err.ext_protocol_unsupported:1"
        );
        with_home(|_| {
            let base = tmp("newer-base");
            let dir = pacote("newer", "novo", r#"{"loro":3}"#);
            assert_eq!(
                install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap_err(),
                "err.ext_protocol_unsupported:3"
            );
            // NOTHING was written: the gate is ahead of the first byte
            assert!(!record_path(&base).exists());
        });
    }

    // The additivity guard. `plugins.rs` ends this round with a zero diff, so the
    // old door must answer exactly as it did — including its refusal of a v2
    // manifest, which is what the install sheet's copy points away from.
    #[test]
    fn a_v1_manifest_is_untouched_by_this_module() {
        with_home(|_| {
            let base = tmp("v1-base");
            let dir = tmp("v1-pacote");
            write(
                &dir.join(".claude-plugin/plugin.json"),
                r#"{"name":"juridico-br","version":"1.2.0","author":{"name":"OAB"}}"#,
            );
            write(
                &dir.join("loro.json"),
                r#"{"loro":1,"kinds":["skills"],"seed":{"contexts":[]}}"#,
            );
            write(&dir.join("commands/loro-parecer.md"), "# parecer\n");
            let pv = crate::plugins::preview(&base, dir.to_str().unwrap()).unwrap();
            assert_eq!(pv.id, "juridico-br");
            assert_eq!(pv.class, crate::plugins::CLASS_DECLARATIVE);
            assert_eq!(pv.writes.len(), 1);
            // and the v2 door refuses it BY NAME rather than installing it twice
            assert_eq!(
                preview_at(&base, dir.to_str().unwrap()).unwrap_err(),
                "err.ext_protocol_unsupported:1"
            );
        });
    }

    #[test]
    fn a_point_this_round_does_not_implement_is_refused_by_name() {
        assert_eq!(
            manifest(r#"{"loro":2,"points":{"tools":1}}"#).unwrap_err(),
            "err.ext_point_unsupported:tools@1"
        );
        assert_eq!(
            manifest(r#"{"loro":2,"points":{"surface":2},"surface":{"title":{"pt":"a","en":"b"},"view":[1]}}"#)
                .unwrap_err(),
            "err.ext_point_unsupported:surface@2"
        );
        // a point merely NAMED in the informational `kinds` is REPORTED, never dropped
        let m = manifest(
            r#"{"loro":2,"kinds":["surface","facts","transcriber","coisa"],
                "surface":{"title":{"pt":"a","en":"b"},"view":[1]}}"#,
        )
        .unwrap();
        assert_eq!(m.unsupported, vec!["coisa", "facts", "transcriber"]);
        // an absent `points` with a surface present reads as {"surface":1}
        assert_eq!(m.points.get("surface"), Some(&1));
    }

    #[test]
    fn artifact_and_build_are_read_so_they_can_be_reported() {
        let m = manifest(
            r#"{"loro":2,"program":{"protocol":"mcp/stdio","server":"s","command":"python3",
                "artifact":{"url":"x"},"build":{"cmd":"y"}}}"#,
        )
        .unwrap();
        assert!(m.unsupported.contains(&"artifact".to_string()));
        assert!(m.unsupported.contains(&"build".to_string()));
    }

    // How to see it red: drop one of the four checks and a manifest declaring two
    // sources for one screen installs, with the loser silently ignored.
    #[test]
    fn the_surface_exclusivity_refusals_are_named() {
        let cases = [
            (
                r#"{"loro":2,"surface":{"title":{"pt":"a","en":"b"},"view":[1],"viewFile":"x.json"}}"#,
                "err.ext_surface_ambiguous",
            ),
            (
                r#"{"loro":2,"program":{"protocol":"mcp/stdio","server":"s","command":"python3"},
                    "surface":{"title":{"pt":"a","en":"b"},"served":true,"viewFile":"x.json"}}"#,
                "err.ext_surface_ambiguous",
            ),
            (
                r#"{"loro":2,"surface":{"title":{"pt":"a","en":"b"},"served":true}}"#,
                "err.ext_surface_unserved",
            ),
            (
                r#"{"loro":2,"surface":{"title":{"pt":"a","en":"b"}}}"#,
                "err.ext_surface_missing",
            ),
        ];
        for (json, code) in cases {
            assert_eq!(manifest(json).unwrap_err(), code, "{json}");
        }
        // and a `program` with no `surface` is legal: an extension may be a process
        // with no screen
        assert!(manifest(
            r#"{"loro":2,"program":{"protocol":"mcp/stdio","server":"s","command":"python3"}}"#
        )
        .unwrap()
        .surface
        .is_none());
    }

    // How to see it red: accept a single-language pair, and the person's choice of
    // language becomes optional for an extension (ADR-0031 §3).
    #[test]
    fn an_i18n_missing_a_half_is_refused_with_its_pointer() {
        assert_eq!(
            manifest(r#"{"loro":2,"surface":{"title":{"pt":"Painel"},"view":[1]}}"#).unwrap_err(),
            "err.ext_i18n_missing:/surface/title"
        );
        assert_eq!(
            manifest(
                r#"{"loro":2,"surface":{"title":{"pt":"a","en":"b"},"view":[1]},
                    "settings":[{"id":"colecao","kind":"string","label":{"en":"collection"}}]}"#
            )
            .unwrap_err(),
            "err.ext_i18n_missing:/settings/0/label"
        );
    }

    #[test]
    fn a_program_command_is_a_name_never_a_path_and_never_a_shell() {
        for cmd in ["./bin/agent", "/usr/bin/python3", "server\\main.exe"] {
            let json = format!(
                r#"{{"loro":2,"program":{{"protocol":"mcp/stdio","server":"s","command":"{}"}}}}"#,
                cmd.replace('\\', "\\\\")
            );
            assert_eq!(
                manifest(&json).unwrap_err(),
                format!("err.ext_program_path:{cmd}"),
                "{cmd}"
            );
        }
        assert_eq!(
            manifest(
                r#"{"loro":2,"program":{"protocol":"http","server":"s","command":"python3"}}"#
            )
            .unwrap_err(),
            "err.ext_protocol_unsupported:http"
        );
    }

    // §5.7. How to see it red: accept a metacharacter, and an argv token becomes a
    // command line — the thing `loops::safe_cli_value` exists to prevent, one door
    // over.
    #[test]
    fn an_argv_token_is_literal_never_a_shell() {
        for good in [
            "server/main.py",
            "--port=8080",
            "-v",
            "utf8.json",
            "a.b_c-d",
        ] {
            assert!(valid_argv_token(good), "{good} is a plain token");
        }
        for bad in [
            "a; rm -rf /",
            "a|b",
            "a&b",
            "$HOME",
            "`id`",
            "a>b",
            "a<b",
            "*",
            "?",
            "../secrets",
            "/etc/passwd",
            "a\"b",
            "a'b",
            "a\nb",
            " leading",
            "",
            "--",
        ] {
            assert!(!valid_argv_token(bad), "{bad:?} must be refused");
        }
        let json = r#"{"loro":2,"program":{"protocol":"mcp/stdio","server":"s","command":"python3","args":["a; rm -rf /"]}}"#;
        assert_eq!(
            manifest(json).unwrap_err(),
            "err.ext_program_arg:a; rm -rf /"
        );
    }

    // ---- BR-9: the credential gate ---------------------------------------

    // How to see it red: check the schema AFTER writing, and `.loro/ext.json`
    // exists on a refusal — which is BR-9 broken, in a file that is versioned.
    #[test]
    fn a_settings_schema_with_a_credential_field_is_refused() {
        let cases = [
            (
                r#"{"id":"api","kind":"token","label":{"pt":"a","en":"b"}}"#,
                "token",
            ),
            (
                r#"{"id":"api","kind":"secret","label":{"pt":"a","en":"b"}}"#,
                "secret",
            ),
            (
                r#"{"id":"api_key","kind":"string","label":{"pt":"a","en":"b"}}"#,
                "api_key",
            ),
            (
                r#"{"id":"minha_password","kind":"string","label":{"pt":"a","en":"b"}}"#,
                "minha_password",
            ),
            (
                r#"{"id":"cred","kind":"credential","label":{"pt":"a","en":"b"}}"#,
                "credential",
            ),
        ];
        for (field, named) in cases {
            let json = format!(r#"{{"loro":2,"settings":[{field}]}}"#);
            assert_eq!(
                manifest(&json).unwrap_err(),
                format!("err.ext_settings_secret:{named}"),
                "{field}"
            );
        }
        with_home(|_| {
            let base = tmp("secret-base");
            let dir = pacote(
                "secret",
                "com-segredo",
                r#"{"loro":2,"settings":[{"id":"api_token","kind":"string","label":{"pt":"a","en":"b"}}]}"#,
            );
            assert_eq!(
                install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap_err(),
                "err.ext_settings_secret:api_token"
            );
            assert!(!record_path(&base).exists(), "nothing may be written");
            assert!(!base.join(".loro/ext").exists());
        });
    }

    #[test]
    fn a_settings_kind_outside_the_six_is_refused_by_name() {
        assert_eq!(
            manifest(
                r#"{"loro":2,"settings":[{"id":"x","kind":"json","label":{"pt":"a","en":"b"}}]}"#
            )
            .unwrap_err(),
            "err.ext_settings_kind:json"
        );
        // an enum with no options is a control with nothing to choose
        assert_eq!(
            manifest(
                r#"{"loro":2,"settings":[{"id":"x","kind":"enum","label":{"pt":"a","en":"b"}}]}"#
            )
            .unwrap_err(),
            "err.ext_settings_invalid:x"
        );
    }

    // How to see it red: copy the fila's `brain_triage_files` posture (a silent
    // skip) and a file nobody could read walks in unread — the hole ADR-0024 closed
    // on the other door.
    #[test]
    fn a_secret_in_a_planned_write_blocks_at_the_door() {
        with_home(|_| {
            let base = tmp("triage-base");
            let dir = pacote_level1("triage", "com-chave");
            write(
                &dir.join("commands/loro-x.md"),
                "# x\n-----BEGIN RSA PRIVATE KEY-----\n",
            );
            let err = install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap_err();
            assert_eq!(err, "err.intake_secret:.claude/commands/loro-x.md");
            assert!(!record_path(&base).exists());
            assert!(
                !base.join(".claude/commands/loro-x.md").exists(),
                "zero files written"
            );
        });
    }

    #[test]
    fn a_non_utf8_pacote_file_is_refused_not_skipped() {
        with_home(|_| {
            let base = tmp("utf8-base");
            let dir = pacote_level1("utf8", "com-binario");
            std::fs::create_dir_all(dir.join("commands")).unwrap();
            std::fs::write(
                dir.join("commands/loro-bin.md"),
                [0xff_u8, 0xfe, 0x00, 0x01],
            )
            .unwrap();
            // the REFUSAL IS AT THE TRIAGE DOOR, not only at the copy loop: a file
            // that cannot be read cannot be triaged, and installing untriaged is the
            // hole ADR-0024 closed on the other door (BR-9). Asserting it on the
            // read-only preview is what pins THAT door — `install_at` has a second
            // readability pass, so an install-only assertion stays green with the
            // triage refusal removed (measured).
            assert_eq!(
                preview_at(&base, dir.to_str().unwrap()).unwrap_err(),
                "err.ext_unreadable_file:commands/loro-bin.md"
            );
            assert_eq!(
                install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap_err(),
                "err.ext_unreadable_file:commands/loro-bin.md"
            );
            assert!(!record_path(&base).exists());
        });
    }

    // ---- BR-1: audio, network, and the absence of an API ------------------

    // How to see it red: allow the substring, and the absolute half of BR-1 becomes
    // a default instead of an absence.
    #[test]
    fn no_capability_can_name_audio() {
        for id in [
            "audio.read",
            "acervo.read:pasta:audio",
            "net.outbound:audio.example",
            "acervo.read:ideia:AUDIO",
        ] {
            assert!(!valid_capability_id(id), "{id} must be refused");
            let json = format!(
                r#"{{"loro":2,"capabilities":[{{"id":"{id}","why":{{"pt":"a","en":"b"}}}}]}}"#
            );
            assert_eq!(
                manifest(&json).unwrap_err(),
                format!("err.ext_capability_invalid:{id}")
            );
        }
    }

    // How to see it red: accept `*` and «tudo, sem perguntar» ships under another
    // spelling (`loops.rs:775-777` refuses exactly this).
    #[test]
    fn a_bare_wildcard_host_is_refused() {
        assert!(!valid_capability_id("net.outbound:*"));
        assert!(!valid_capability_id("net.outbound:*.example"));
        assert!(valid_capability_id("net.outbound:acervo.interno.example"));
        for good in [
            "acervo.read:projeto",
            "acervo.propose",
            "agent.tools",
            "acervo.read:ideia:contratos",
            "acervo.read:conhecimento:juridico",
            "acervo.read:pasta:contexts/juridico",
        ] {
            assert!(valid_capability_id(good), "{good}");
        }
        for bad in [
            "acervo.read",
            "acervo.read:pasta:../fora",
            "acervo.read:pasta:/abs",
            "",
        ] {
            assert!(!valid_capability_id(bad), "{bad}");
        }
    }

    // BR-1's ONE mutual exclusion, and it has no consent path. How to see it red:
    // move the check after the points gate, and the person is told the point is
    // «not supported yet» — which invites them to wait for a round that will never
    // grant it.
    #[test]
    fn an_audio_holding_point_never_gets_a_network_capability() {
        let json = r#"{"loro":2,"points":{"transcriber":1},
            "capabilities":[{"id":"net.outbound:api.example","why":{"pt":"a","en":"b"}}]}"#;
        assert_eq!(manifest(json).unwrap_err(), "err.ext_audio_network");
        // without the network half it is merely a point R5a does not implement
        assert_eq!(
            manifest(r#"{"loro":2,"points":{"transcriber":1}}"#).unwrap_err(),
            "err.ext_point_unsupported:transcriber@1"
        );
    }

    // The guarantee is the ABSENCE of an API, and an absence is only a guarantee
    // while somebody keeps checking. Source-text, because there is no way to assert
    // «this call does not exist» at runtime.
    /// The module's own code, without the test module: every guard below quotes the
    /// string it forbids, so a scanner that read its own source would always be red.
    fn code_only() -> &'static str {
        let mine = include_str!("ext.rs");
        let at = mine
            .find(&format!("#[{}(test)]", "cfg"))
            .expect("the test module marks the end of the code");
        &mine[..at]
    }

    #[test]
    fn the_extension_has_no_filesystem_api() {
        let mine = code_only();
        assert!(
            !mine.contains("File::open"),
            "no raw file handle in this module"
        );
        // no filesystem call takes a path derived from a reply, a view document or a
        // value somebody typed
        let tainted = ["reply", "payload", "doc,", "doc)", "values"];
        for (n, line) in mine.lines().enumerate() {
            if line.contains("read_to_string(")
                || line.contains("read_dir(")
                || line.contains("remove_file(")
            {
                for t in tainted {
                    assert!(
                        !line.contains(t),
                        "line {} builds a filesystem path from untrusted data: {line}",
                        n + 1
                    );
                }
            }
        }
    }

    // BR-8 on this module itself. How to see it red: add `values = ?values` to any
    // log line.
    #[test]
    fn no_body_is_ever_logged() {
        let mine = code_only();
        const BANNED: [&str; 8] = [
            "values", "payload", "message", "%text", "?text", "why", "secret =", "%body",
        ];
        for macro_name in ["info!(", "warn!("] {
            for (i, _) in mine.match_indices(macro_name) {
                let rest = &mine[i..];
                let end = rest
                    .find(");")
                    .map(|e| e + 2)
                    .unwrap_or(rest.len().min(400));
                let call = &rest[..end];
                for b in BANNED {
                    assert!(!call.contains(b), "a log carries a body: {call}");
                }
            }
        }
    }

    // ---- §2 the facts ----------------------------------------------------

    // How to see it red: invent a hotspot title field — it is data the app does not
    // have (`struct DocHotspot { id: String }`, one field, `acervo.rs:2401-2403`).
    #[test]
    fn the_facts_are_derived_from_the_graph_and_nothing_else() {
        let graph = serde_json::json!({
            "nodes": [
                { "rel": "contexts/assinatura/context.md", "context": "assinatura",
                  "title": "Assinatura",
                  "hotspots": ["assinatura#cancelamento-cdc", "assinatura#H-3"],
                  "decisions": ["D-2026-01-01-x", "D-2026-02-02-y"],
                  "inlinks": 2, "outlinks": 1 },
                { "rel": "contextos/frota/rastreamento/context.md", "context": "frota/rastreamento",
                  "title": "Rastreamento", "hotspots": [], "decisions": [],
                  "inlinks": 0, "outlinks": 3 }
            ],
            "edges": [],
            "broken": [{ "from": "contexts/a/context.md", "target": "../inexistente/context.md" }],
            "orphans": ["contextos/frota/rastreamento/context.md"]
        });
        let f = facts_from_graph(&graph);

        let hs = &f["acervo.hotspots"];
        assert_eq!(hs["count"], 2);
        assert_eq!(hs["rows"][0]["id"], "assinatura#cancelamento-cdc");
        assert_eq!(hs["rows"][0]["hotspot"], "cancelamento-cdc");
        assert_eq!(hs["rows"][0]["context"], "assinatura");
        assert_eq!(hs["rows"][0]["rel"], "contexts/assinatura/context.md");
        // the title is the NODE's — a hotspot has none
        assert_eq!(hs["rows"][0]["title"], "Assinatura");
        // mixed ids: the legacy `H-<n>` spelling is read exactly the same way
        assert_eq!(hs["rows"][1]["hotspot"], "H-3");

        let cx = &f["acervo.contexts"];
        assert_eq!(cx["count"], 2);
        assert_eq!(cx["rows"][0]["hotspots"], 2, "a COUNT, not the list");
        assert_eq!(cx["rows"][0]["decisions"], 2);
        assert_eq!(cx["rows"][0]["inlinks"], 2);
        assert_eq!(cx["rows"][0]["outlinks"], 1);

        // THE PREFIX IS NOT ALWAYS `contexts/` (paths.rs:253) — the legacy folder
        // round-trips verbatim, and the orphan's context is the node's own
        let orph = &f["acervo.orphans"];
        assert_eq!(orph["count"], 1);
        assert_eq!(
            orph["rows"][0]["rel"],
            "contextos/frota/rastreamento/context.md"
        );
        assert_eq!(orph["rows"][0]["context"], "frota/rastreamento");

        assert_eq!(
            f["acervo.broken"]["rows"][0]["target"],
            "../inexistente/context.md"
        );
        // the catalogue is CLOSED: five collections since round 2 (acervo.areas,
        // 2026-08-20 — a column per context measured 12px on the owner's real
        // 80-context acervo; the area is the grouping that fits a board)
        assert_eq!(f.as_object().unwrap().len(), 5);
    }

    // Round 2 — the area, on every row and aggregated. How this was seen red:
    // with the `area` line removed from the hotspot row, the first assert fails
    // with `null`; with the aggregation removed, `acervo.areas` is absent and
    // the count assert fails the same way. (Both runs done on 2026-08-20.)
    #[test]
    fn the_area_is_the_first_segment_and_areas_aggregate_it() {
        let graph = serde_json::json!({
            "nodes": [
                { "rel": "contexts/frota/eletrica/context.md", "context": "frota/eletrica",
                  "title": "Elétrica", "hotspots": ["frota/eletrica#H-1", "frota/eletrica#H-2"],
                  "decisions": [], "inlinks": 0, "outlinks": 0 },
                { "rel": "contexts/frota/danos/context.md", "context": "frota/danos",
                  "title": "Danos", "hotspots": ["frota/danos#H-9"],
                  "decisions": [], "inlinks": 0, "outlinks": 0 },
                { "rel": "contexts/assinatura/context.md", "context": "assinatura",
                  "title": "Assinatura", "hotspots": ["assinatura#cancelamento-cdc"],
                  "decisions": [], "inlinks": 0, "outlinks": 0 }
            ],
            "edges": [], "broken": [], "orphans": []
        });
        let f = facts_from_graph(&graph);
        assert_eq!(f["acervo.hotspots"]["rows"][0]["area"], "frota");
        assert_eq!(f["acervo.contexts"]["rows"][2]["area"], "assinatura");
        // rows are born with comments: 0, so the binding always resolves
        assert_eq!(f["acervo.hotspots"]["rows"][0]["comments"], 0);
        // aggregated, sorted by name (BTreeMap): assinatura before frota
        let areas = &f["acervo.areas"];
        assert_eq!(areas["count"], 2);
        assert_eq!(areas["rows"][0]["area"], "assinatura");
        assert_eq!(areas["rows"][0]["contexts"], 1);
        assert_eq!(areas["rows"][0]["hotspots"], 1);
        assert_eq!(areas["rows"][1]["area"], "frota");
        assert_eq!(areas["rows"][1]["contexts"], 2);
        assert_eq!(areas["rows"][1]["hotspots"], 3);
    }

    // Round 2 — kanban comments are counted from FILE NAMES only (BR-8 posture:
    // nothing is opened). The .txt and the dot-file are left out on purpose; a
    // nested context (`frota/eletrica`) reconstructs its id across segments.
    #[test]
    fn kanban_comments_are_counted_by_name_and_stamped_on_the_rows() {
        let base = tmp("kanban-base");
        write(
            &base.join("kanban/frota/eletrica/H-1/2026-08-20-dan.md"),
            "corpo que NUNCA é lido",
        );
        write(
            &base.join("kanban/frota/eletrica/H-1/2026-08-21-ana.md"),
            "x",
        );
        write(
            &base.join("kanban/frota/eletrica/H-1/rascunho.txt"),
            "fora: não é .md",
        );
        write(
            &base.join("kanban/frota/eletrica/H-1/.escondido.md"),
            "fora: dot-file",
        );
        write(
            &base.join("kanban/assinatura/cancelamento-cdc/2026-08-20-dan.md"),
            "x",
        );
        write(
            &base.join("kanban/solto.md"),
            "fora: raso demais para ter dono",
        );
        // ponto.md is the STATUS document (a document all the way down,
        // ADR-0029 §14) — it is not a comment, and its front-matter is the one
        // content read this walk does (a status is not derivable from a name)
        write(
            &base.join("kanban/frota/eletrica/H-1/ponto.md"),
            "---\nponto: frota/eletrica#H-1\nstatus: em-pauta\n---\nem pauta desde a reunião de 2026-08-19\n",
        );
        // an INVALID status must not hide the card: a board that silently drops
        // a point is the worst failure a board has — it clamps to aberto
        write(
            &base.join("kanban/assinatura/cancelamento-cdc/ponto.md"),
            "---\nstatus: acabou\n---\n",
        );
        let points = kanban_point_facts(&base);
        assert_eq!(
            points.get("frota/eletrica#H-1").unwrap().0,
            2,
            "ponto.md fora da contagem"
        );
        assert_eq!(points.get("frota/eletrica#H-1").unwrap().1, "em-pauta");
        assert_eq!(points.get("assinatura#cancelamento-cdc").unwrap().0, 1);
        assert_eq!(
            points.get("assinatura#cancelamento-cdc").unwrap().1,
            "aberto",
            "status inválido vira aberto, nunca some"
        );
        assert_eq!(points.len(), 2, "nada além dos dois pontos com pasta");

        let mut facts = serde_json::json!({
            "acervo.hotspots": { "count": 2, "rows": [
                { "id": "frota/eletrica#H-1", "comments": 0, "status": "aberto" },
                { "id": "assinatura#H-2", "comments": 0, "status": "aberto" }
            ] }
        });
        apply_kanban_points(&mut facts, &points);
        assert_eq!(facts["acervo.hotspots"]["rows"][0]["comments"], 2);
        assert_eq!(facts["acervo.hotspots"]["rows"][0]["status"], "em-pauta");
        // a point with no folder stays at the defaults — absence is not a hole
        assert_eq!(facts["acervo.hotspots"]["rows"][1]["comments"], 0);
        assert_eq!(facts["acervo.hotspots"]["rows"][1]["status"], "aberto");
        let _ = std::fs::remove_dir_all(&base);
    }

    // THE SHIPPED EXAMPLE, THROUGH THE REAL PIPELINE (2026-08-20, after the
    // owner's «ainda não está funcionando — teste ela antes»). This is the
    // exact sequence `ext_view` runs in the real app, minus only the AppHandle
    // (used solely by the served branch): install the REAL folder from the
    // repo, seed a REAL acervo, derive REAL facts, read the REAL board.json,
    // validate the REAL envelope, and cross-check every binding the view makes
    // against what the payload actually carries. The UI smoke stubs the
    // backend, so it can never catch a break on this half — this test exists
    // because two rounds shipped green while the real app painted refusals.
    #[test]
    fn the_shipped_example_survives_the_real_view_pipeline() {
        with_home(|home| {
            let base = tmp("e2e-base");
            // a real acervo: two areas, three hotspots, one status doc, one comment
            write(
                &base.join("contexts/frota/eletrica/context.md"),
                "# Elétrica

> [!HOTSPOT] H-1 — recarga noturna

> [!HOTSPOT] fonte-verdade-dados — quem manda
",
            );
            write(
                &base.join("contexts/assinatura/context.md"),
                "# Assinatura

> [!HOTSPOT] cancelamento-cdc — o prazo
",
            );
            write(
                &base.join("kanban/frota/eletrica/H-1/ponto.md"),
                "---
ponto: frota/eletrica#H-1
status: em-pauta
---
",
            );
            write(
                &base.join("kanban/frota/eletrica/H-1/2026-08-20-dan.md"),
                "---
autor: dan
---
comentário
",
            );
            write(
                &home.join("config.json"),
                &format!(
                    r#"{{"acervos":[{{"id":"t","name":"t","dir":"{}"}}],"active":"t"}}"#,
                    base.to_string_lossy()
                ),
            );

            // the REAL example folder, not a fixture of it
            let example = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../examples/extensions/hotspots-board")
                .canonicalize()
                .expect("the shipped example exists");
            let out = install_at(&base, example.to_str().unwrap(), "2026-08-20")
                .expect("the shipped example installs");
            let rec = find_record(&base, &out.id).unwrap();

            // the view the app would serve, through the same three gates
            let doc = manifest_view(&rec).expect("the shipped board.json is readable");
            validate_view_envelope(&doc).expect("the shipped board passes the envelope");
            let facts = block_on(facts_now()).unwrap();
            let settings = effective_settings(&base, &rec);

            // every settings.* the view binds EXISTS in the payload — the drift
            // that painted refusals on the owner's screen
            let doc_txt = serde_json::to_string(&doc).unwrap();
            for id in ["rotulo", "filtro", "mostrar_comentarios", "dica_de_uso"] {
                if doc_txt.contains(&format!("settings.{id}")) {
                    assert!(
                        settings.get(id).is_some_and(|v| !v.is_null()),
                        "the view binds settings.{id} and the payload has no value for it"
                    );
                }
            }
            // every row field the view binds exists on the real rows
            let row = &facts["acervo.hotspots"]["rows"][0];
            for field in [
                "id", "hotspot", "context", "area", "rel", "status", "comments",
            ] {
                assert!(!row[field].is_null(), "hotspot row lacks `{field}`");
            }
            // and the real derivation carried the kanban state in
            let rows = facts["acervo.hotspots"]["rows"].as_array().unwrap();
            let h1 = rows
                .iter()
                .find(|r| r["id"] == "frota/eletrica#H-1")
                .expect("H-1 derived from the seeded acervo");
            assert_eq!(h1["status"], "em-pauta", "ponto.md drove the column");
            assert_eq!(h1["comments"], 1, "the comment was counted by name");
            assert_eq!(facts["acervo.areas"]["count"], 2);
            // the wide layout crossed install → record → row
            assert_eq!(rec.surface.as_ref().unwrap().layout, "wide");
            let row_ui = row_of(&rec, None);
            assert_eq!(row_ui.surface_layout, "wide");
            with_ext(|st| st.procs.clear());
        });
    }

    // THE OWNER'S EXACT STATE (2026-08-20, read from turbo/.loro/ext.json):
    // a record installed BEFORE the manifest gained settings and the wide
    // layout — `settings: []`, `layout: None` — while the origin now declares
    // four settings. The view is re-read from the origin, so it binds
    // `settings.filtro`; a record-driven schema answers nothing and the screen
    // paints one refusal per binding, saving bounces with
    // err.ext_settings_invalid, and the board never goes wide. Seen red on
    // 2026-08-20 by reverting live_schema to `rec.settings.clone()`: the first
    // assert fails with `filtro = Null`.
    #[test]
    fn a_stale_record_answers_with_the_origin_schema_not_its_own() {
        with_home(|_| {
            let base = tmp("stale-base");
            // install a copy of the example WITHOUT settings/layout (the old manifest)
            let dir = pacote(
                "stale",
                "pontos",
                r#"{"loro":2,"kinds":["surface"],
                    "surface":{"title":{"pt":"Pontos","en":"Points"},"viewFile":"surface/board.json"}}"#,
            );
            write(&dir.join("surface/board.json"), BOARD);
            let out = install_at(&base, dir.to_str().unwrap(), "2026-08-20").unwrap();
            let rec0 = find_record(&base, &out.id).unwrap();
            assert!(
                rec0.settings.is_empty(),
                "the precondition: a record with no schema"
            );

            // the pacote evolves ON DISK, as the shipped example did today
            write(
                &dir.join("loro.json"),
                r#"{"loro":2,"kinds":["surface"],
                    "surface":{"title":{"pt":"Pontos","en":"Points"},"viewFile":"surface/board.json","layout":"wide"},
                    "settings":[{"id":"filtro","kind":"string","escopo":"maquina","default":"",
                                 "label":{"pt":"área","en":"area"}}]}"#,
            );

            let rec = find_record(&base, &out.id).unwrap();
            // 1 — the effective settings answer from the origin: the binding resolves
            let eff = effective_settings(&base, &rec);
            assert!(
                eff.get("filtro").is_some_and(|v| v.is_string()),
                "a stale record must not blank the origin's settings: {eff}"
            );
            // 2 — saving validates against the origin too (the dropdown persists)
            let saved = set_settings_at(&base, &out.id, &serde_json::json!({ "filtro": "frota" }))
                .expect("saving a setting the origin declares");
            assert_eq!(saved["filtro"], "frota");
            // 3 — the sheet shows the origin's schema
            let schema = live_schema(&rec);
            assert_eq!(schema.len(), 1);
            assert_eq!(schema[0].id, "filtro");
            // 4 — and BR-9 still guards the re-read: a credential field in the
            // evolved origin is refused, never served
            write(
                &dir.join("loro.json"),
                r#"{"loro":2,"kinds":["surface"],
                    "surface":{"title":{"pt":"Pontos","en":"Points"},"viewFile":"surface/board.json"},
                    "settings":[{"id":"token","kind":"string","escopo":"maquina",
                                 "label":{"pt":"token","en":"token"}}]}"#,
            );
            let rec2 = find_record(&base, &out.id).unwrap();
            // parse refuses -> fallback to the record's (empty) schema: the
            // credential never becomes an offered field
            assert!(
                live_schema(&rec2).is_empty(),
                "a refused origin must not serve fields"
            );
            with_ext(|st| st.procs.clear());
        });
    }

    // Round 2 — the wide surface is an enum, refused by name outside it. The
    // explicit "column" normalizes to "" so an old record and an explicit one
    // read the same.
    #[test]
    fn a_surface_layout_outside_the_enum_is_refused_by_name() {
        let wide = manifest(
            r#"{"loro":2,"kinds":["surface"],
                "surface":{"title":{"pt":"a","en":"b"},"viewFile":"surface/board.json","layout":"wide"}}"#,
        )
        .unwrap();
        assert_eq!(wide.surface.unwrap().layout, "wide");
        let col = manifest(
            r#"{"loro":2,"kinds":["surface"],
                "surface":{"title":{"pt":"a","en":"b"},"viewFile":"surface/board.json","layout":"column"}}"#,
        )
        .unwrap();
        assert_eq!(col.surface.unwrap().layout, "");
        let bad = manifest(
            r#"{"loro":2,"kinds":["surface"],
                "surface":{"title":{"pt":"a","en":"b"},"viewFile":"surface/board.json","layout":"sideways"}}"#,
        )
        .unwrap_err();
        assert_eq!(bad, "err.ext_surface_layout:sideways");
    }

    // BR-8. How to see it red: read a second folder — the fixture puts a needle in
    // every folder the facts must be unable to reach.
    #[test]
    fn facts_never_open_a_meeting_a_note_or_the_trail() {
        with_home(|home| {
            let base = tmp("facts-base");
            write(
                &base.join("contexts/assinatura/context.md"),
                "# Assinatura\n\n> [!HOTSPOT] cancelamento-cdc — o prazo\n\n> [!HOTSPOT] H-2 — outro\n",
            );
            write(
                &base.join("contexts/frota/context.md"),
                "# Frota\n\nver [assinatura](../assinatura/context.md)\n",
            );
            // every folder the graph must be unable to reach, each with a needle
            write(
                &base.join("meetings/2026-01-01-x/reuniao.md"),
                "NEEDLE-MEETING\n",
            );
            write(&base.join("notas/nota.md"), "NEEDLE-NOTE\n");
            write(&base.join("pessoal/diario.md"), "NEEDLE-TRAIL\n");
            write(
                &home.join("config.json"),
                &format!(
                    r#"{{"acervos":[{{"id":"t","name":"t","dir":"{}"}}],"active":"t"}}"#,
                    base.to_string_lossy()
                ),
            );
            let facts = block_on(facts_now()).unwrap();
            let text = serde_json::to_string(&facts).unwrap();
            for needle in [
                "NEEDLE-MEETING",
                "NEEDLE-NOTE",
                "NEEDLE-TRAIL",
                "reuniao",
                "pessoal",
                "notas",
            ] {
                assert!(!text.contains(needle), "{needle} reached the facts");
            }
            // and the real derivation did run: two contexts, two hotspots
            assert_eq!(facts["acervo.contexts"]["count"], 2);
            assert_eq!(facts["acervo.hotspots"]["count"], 2);
            let ids: Vec<&str> = facts["acervo.hotspots"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["hotspot"].as_str().unwrap())
                .collect();
            assert!(
                ids.contains(&"cancelamento-cdc") && ids.contains(&"H-2"),
                "{ids:?}"
            );
        });
    }

    // ---- the view boundary ------------------------------------------------

    // How to see it red: trust the reply, and an unknown node reaches the page.
    #[test]
    fn a_view_is_validated_before_it_crosses() {
        let bad = serde_json::json!({
            "loroView": 1,
            "view": [{ "kind": "stack", "children": [{ "kind": "iframe" }] }]
        });
        assert_eq!(
            validate_view_envelope(&bad).unwrap_err(),
            "err.ext_view_node:iframe"
        );
        assert_eq!(
            validate_view_envelope(&serde_json::json!({ "loroView": 2, "view": [] })).unwrap_err(),
            "err.ext_view_version:2"
        );
        assert_eq!(
            validate_view_envelope(&serde_json::json!({ "loroView": 1, "view": [] })).unwrap_err(),
            "err.ext_view_empty"
        );
        assert_eq!(
            validate_view_envelope(&serde_json::json!({
                "loroView": 1, "components": { "Card": { "body": { "kind": "text" } } },
                "view": [{ "kind": "text" }]
            }))
            .unwrap_err(),
            "err.ext_view_component:Card"
        );
        // the whole primitive set is accepted
        let all: Vec<Value> = VIEW_KINDS
            .iter()
            .map(|k| serde_json::json!({ "kind": k }))
            .collect();
        assert!(validate_view_envelope(&serde_json::json!({ "loroView": 1, "view": all })).is_ok());
    }

    // How to see it red: remove the ceilings and this test HANGS or allocates
    // without bound — which is the hang the ceiling exists for.
    #[test]
    fn a_hostile_document_stops_at_the_ceilings() {
        // deep: 200 nested stacks
        let mut node = serde_json::json!({ "kind": "text" });
        for _ in 0..200 {
            node = serde_json::json!({ "kind": "stack", "children": [node] });
        }
        let deep = serde_json::json!({ "loroView": 1, "view": [node] });
        assert!(validate_view_envelope(&deep)
            .unwrap_err()
            .starts_with("err.ext_view_depth:"));
        // wide: 3000 nodes
        let wide: Vec<Value> = (0..3000)
            .map(|_| serde_json::json!({ "kind": "text" }))
            .collect();
        let big = serde_json::json!({
            "loroView": 1,
            "view": [{ "kind": "stack", "children": wide }]
        });
        assert!(validate_view_envelope(&big)
            .unwrap_err()
            .starts_with("err.ext_view_size:"));
    }

    #[test]
    fn an_action_no_node_declared_is_not_a_button_a_person_pressed() {
        let doc = serde_json::json!({
            "loroView": 1,
            "components": { "card": { "body": { "kind": "button", "action": "abrir_tema" } } },
            "view": [{ "kind": "stack", "children": [
                { "kind": "button", "action": "arquivar" },
                { "kind": "when", "then": [{ "kind": "button", "action": "reabrir" }] }
            ] }]
        });
        assert_eq!(actions_of(&doc), vec!["abrir_tema", "arquivar", "reabrir"]);
        assert!(!actions_of(&doc).contains(&"inventada".to_string()));
    }

    // ---- the supervisor ---------------------------------------------------

    // How to see it red: remove the window counter and the loop never ends — three
    // is the number after which a fourth spawn only spends the machine.
    #[test]
    fn a_crash_loop_stops_with_the_reason_named() {
        let opened = 1_000_000i64;
        let (ok1, n1, w1) = budget_step(0, 0, opened);
        assert!(ok1 && n1 == 1 && w1 == opened);
        let (ok2, n2, _) = budget_step(n1, w1, opened + 100);
        assert!(ok2 && n2 == 2);
        let (ok3, n3, _) = budget_step(n2, w1, opened + 200);
        assert!(ok3 && n3 == 3);
        // the fourth is refused, and the reason names the count
        let (ok4, n4, _) = budget_step(n3, w1, opened + 300);
        assert!(!ok4, "no fourth spawn");
        assert_eq!(format!("err.ext_crash_loop:{n4}"), "err.ext_crash_loop:3");
        // a window that has ELAPSED is a new window: three crashes an hour apart is
        // not a crash loop, and refusing to try again would be a state that lies
        let (ok5, n5, w5) = budget_step(n3, w1, opened + RESTART_WINDOW_MS + 1);
        assert!(ok5 && n5 == 1 && w5 == opened + RESTART_WINDOW_MS + 1);
    }

    // The defect this registry exists to prevent. How to see it red: copy
    // `AppState`'s single slot, or `system_capture_start`'s kill-the-previous
    // (`lib.rs:1062-1067`), and starting B stops A.
    #[test]
    fn starting_b_does_not_stop_a() {
        fn slot(state: &str) -> ExtProc {
            ExtProc {
                client: None,
                turn: 1,
                started_ms: 0,
                last_answer_ms: 7,
                restarts: 0,
                window_start_ms: 0,
                state: state.to_string(),
                reason: String::new(),
                actions: Vec::new(),
            }
        }
        with_ext(|st| {
            st.procs.clear();
            st.procs.insert("ext-a".into(), slot("running"));
            // registering B is an INSERT into a map keyed by id — it touches no
            // other entry, and there is no «previous child» to kill
            st.procs.insert("ext-b".into(), slot("running"));
            assert_eq!(st.procs.len(), 2);
            assert_eq!(st.procs["ext-a"].state, "running");
            assert_eq!(st.procs["ext-b"].state, "running");
            st.procs.clear();
        });
    }

    // The bug this bookkeeping was refactored out of: the budget was written BEFORE
    // the slot existed and the write was silently lost, which made the fourth spawn
    // allowed. How to see it red: drop `p.restarts = spent` from `mark`.
    #[test]
    fn a_failure_keeps_the_budget_and_the_last_time_it_answered() {
        with_ext(|st| st.procs.clear());
        // it answered once, at 4242
        mark("ext-x", "running", "", 0, 0);
        with_ext(|st| st.procs.get_mut("ext-x").unwrap().last_answer_ms = 4242);
        // three attempts inside one window
        let last = mark("ext-x", "crashed", "err.ext_spawn", 3, 1_000);
        assert_eq!(
            last, 4242,
            "a no_answer row keeps the last time it did answer"
        );
        with_ext(|st| {
            let p = &st.procs["ext-x"];
            assert_eq!(p.restarts, 3, "the budget survived the failure");
            assert_eq!(p.window_start_ms, 1_000);
            assert_eq!(p.state, "crashed");
            assert_eq!(p.reason, "err.ext_spawn");
            assert!(p.client.is_none(), "no client is left behind on a failure");
        });
        // and the next start refuses without spawning
        let (allowed, n, _) = with_ext(|st| {
            budget_step(
                st.procs["ext-x"].restarts,
                st.procs["ext-x"].window_start_ms,
                1_100,
            )
        });
        assert!(!allowed && n == 3);
        with_ext(|st| st.procs.clear());
    }

    // Rule 3, as a source-text assertion: no `wait`, no `stop` and no `call_tool`
    // inside a `with_ext` closure. Each one held the lock across a wait in
    // `chat.rs:438-451`, and the cancel that was the only escape queued behind it.
    #[test]
    fn nothing_blocks_while_the_registry_lock_is_held() {
        let mine = code_only();
        let mut i = 0;
        let mut checked = 0;
        while let Some(at) = mine[i..].find("with_ext(|st| {") {
            let start = i + at;
            // the closure body up to its balanced end, approximated by the next
            // `\n    });` at the same nesting — enough to catch a call written inside
            let body_end = mine[start..]
                .find("\n    })")
                .map(|e| start + e)
                .unwrap_or(mine.len());
            let body = &mine[start..body_end];
            for banned in [
                ".wait(",
                ".stop(",
                ".call_tool(",
                ".initialize(",
                ".list_tools(",
            ] {
                assert!(
                    !body.contains(banned),
                    "{banned} is called while the registry lock is held"
                );
            }
            checked += 1;
            i = body_end;
        }
        assert!(checked >= 4, "the scanner went blind: {checked} closures");
    }

    // ADR-0031 §3.9. How to see it red: spawn eagerly at startup and N installed
    // extensions become N processes at launch.
    #[test]
    fn a_fresh_install_with_no_extensions_spawns_nothing() {
        with_home(|_| {
            let base = tmp("fresh-base");
            assert!(rows_at(&base).is_empty());
            assert!(!record_path(&base).exists(), "listing writes nothing");
            with_ext(|st| assert!(st.procs.is_empty(), "no process was created"));
        });
    }

    // ---- settings and the policy -----------------------------------------

    // The incident at `config.rs:367-370`, one file over. How to see it red:
    // construct a fresh `AcervoSettings` in `write_policy` and the loops policy
    // vanishes on the next grant.
    #[test]
    fn an_ext_settings_write_does_not_erase_the_loops_policy() {
        with_home(|_| {
            let base = tmp("policy-base");
            write(
                &base.join(".loro/settings.json"),
                r#"{"autoContext":true,"loops":{"maxArquivos":5,"maxCiclosDia":3,
                    "expiraDias":30,"paralelo":1,"permite":["WebSearch"],"recusa":[]}}"#,
            );
            let dir = pacote(
                "policy",
                "com-capacidade",
                r#"{"loro":2,"kinds":["surface"],
                    "surface":{"title":{"pt":"a","en":"b"},"viewFile":"surface/board.json"},
                    "capabilities":[{"id":"acervo.read:projeto","why":{"pt":"achar","en":"find"}}]}"#,
            );
            write(&dir.join("surface/board.json"), BOARD);
            let out = install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap();
            permit_at(&base, &out.id, "acervo.read:projeto", "permitir").unwrap();

            let after = crate::config::read_acervo_settings(&base);
            let loops = after.loops.expect("the loops policy survived");
            assert_eq!(loops.permite, vec!["WebSearch"]);
            assert!(after.auto_context, "and so did autoContext");
            assert!(after.ext.is_some());
        });
    }

    // ADR-0029 §4.18. How to see it red: make `recusar` a no-op, and a refusal
    // becomes «ask me again next time».
    #[test]
    fn a_grant_is_a_stored_answer_and_no_is_real() {
        with_home(|_| {
            let base = tmp("grant-base");
            let dir = pacote(
                "grant",
                "com-duas",
                r#"{"loro":2,"kinds":["surface"],
                    "surface":{"title":{"pt":"a","en":"b"},"viewFile":"surface/board.json"},
                    "capabilities":[
                      {"id":"acervo.read:projeto","why":{"pt":"achar","en":"find"}},
                      {"id":"agent.tools","why":{"pt":"usar","en":"use"}}]}"#,
            );
            write(&dir.join("surface/board.json"), BOARD);
            let id = install_at(&base, dir.to_str().unwrap(), "2026-08-19")
                .unwrap()
                .id;

            // never asked
            let caps = capabilities_at(&base, &id).unwrap();
            assert_eq!(caps.len(), 2);
            assert!(caps.iter().all(|c| c.decision.is_empty()));
            assert_eq!(caps[0].kind, "acervo");
            assert_eq!(caps[1].kind, "agent");

            permit_at(&base, &id, "acervo.read:projeto", "permitir").unwrap();
            permit_at(&base, &id, "agent.tools", "recusar").unwrap();
            let caps = capabilities_at(&base, &id).unwrap();
            assert_eq!(caps[0].decision, "granted");
            assert_eq!(caps[1].decision, "refused");

            // «esquecer» takes the decision away, so the question comes back
            permit_at(&base, &id, "agent.tools", "esquecer").unwrap();
            let caps = capabilities_at(&base, &id).unwrap();
            assert_eq!(caps[1].decision, "");
            let policy = read_policy(&base);
            assert!(
                !policy.recusa.contains_key(&id),
                "an empty list is not stored"
            );

            assert_eq!(
                permit_at(&base, &id, "acervo.read:projeto", "talvez").unwrap_err(),
                "err.ext_decision_invalid"
            );
            // a grant for something the manifest never asked for is an answer to a
            // question nobody put
            assert_eq!(
                permit_at(&base, &id, "acervo.propose", "permitir").unwrap_err(),
                "err.ext_capability_invalid:acervo.propose"
            );
        });
    }

    // How to see it red: swap the two escopos, and one person's endpoint becomes
    // everyone's on the next pull.
    // ================ the record is UNTRUSTED INPUT ======================

    /// One record entry, written by hand, the way somebody else's change would.
    fn hand_written_record(base: &Path, id: &str, program: Option<&str>) {
        let prog = program
            .map(|argv| {
                let mut it = argv.split(' ');
                let cmd = it.next().unwrap_or("");
                let args: Vec<String> = it.map(|a| format!("\"{a}\"")).collect();
                format!(
                    r#","program":{{"protocol":"mcp/stdio","server":"srv","command":"{cmd}","args":[{}],"cwd":""}}"#,
                    args.join(",")
                )
            })
            .unwrap_or_default();
        write(
            &record_path(base),
            &format!(
                r#"[{{"id":"{id}","name":"Relatorios","version":"1.0",
                    "source":{{"kind":"dir","path":"{}"}},"kinds":[],"points":[],
                    "installedAt":"2026-08-20","files":[],"settings":[],"capabilities":[]{prog}}}]"#,
                base.to_string_lossy()
            ),
        );
    }

    // How to see it red: drop the `valid_ext_id` filter in `read_record` (or the
    // guard in `find_record`) and the victim folder below is gone.
    //
    // MEASURED with the same `PathBuf::join` the sinks use: `join("/private/tmp/x")`
    // is `/private/tmp/x` — an absolute right side DISCARDS the base — and
    // `join("../../vitima")` is `<home>/vitima`. `.loro/ext.json` is versioned, so
    // this id arrives in somebody else's change, and `remove_at` hands it to
    // `remove_dir_all`.
    #[test]
    fn an_id_from_the_record_is_never_a_path() {
        with_home(|home| {
            let base = tmp("idguard-base");
            let victim_abs = tmp("idguard-victim");
            write(&victim_abs.join("importante.txt"), "nao apague");
            let inside_home = home.join("vitima");
            write(&inside_home.join("importante.txt"), "nao apague");

            for bad in [
                victim_abs.to_string_lossy().replace('\\', "/"),
                "../../vitima".to_string(),
                "-comeca-com-traco".to_string(),
                "MAIUSCULA".to_string(),
                "com espaco".to_string(),
            ] {
                hand_written_record(&base, &bad, None);
                // it never becomes a row: nothing to click, nothing to remove
                assert!(rows_at(&base).is_empty(), "{bad} became a row");
                assert_eq!(find_record(&base, &bad).unwrap_err(), "err.ext_not_found");
                assert!(machine_dir(&bad).is_err(), "{bad} became a machine path");
                assert!(project_ext_dir(&base, &bad).is_err());
                // and the one that mattered: the erase path refuses BEFORE it deletes
                assert_eq!(
                    remove_at(&base, &bad, true).unwrap_err(),
                    "err.ext_not_found",
                    "{bad}"
                );
            }
            assert!(
                victim_abs.join("importante.txt").exists(),
                "a folder outside the acervo was deleted by an id"
            );
            assert!(inside_home.join("importante.txt").exists());
            // and the shape a real install produces still passes, digits included
            for good in ["relatorios", "3d-mapa", "a", "x-1_"] {
                assert_eq!(good.len() <= 50, true);
                assert_eq!(
                    valid_ext_id(good),
                    !good.contains('_'),
                    "{good}: `slugify` emits only [a-z0-9-]"
                );
            }
            assert!(valid_ext_id(&"a".repeat(50)));
            assert!(!valid_ext_id(&"a".repeat(51)));
        });
    }

    // How to see it red: delete the `validate_program` call at the head of
    // `start_at`. The token below is the exact shape a hostile change carries, and
    // `mcp::McpClient::spawn` re-guards only the COMMAND (mcp.rs:446-450) — the
    // args reach `proc::command(exe).args(&cfg.args)` verbatim.
    #[test]
    fn the_argv_of_a_versioned_record_is_revalidated_before_the_spawn() {
        with_home(|_| {
            let base = tmp("argv-base");
            hand_written_record(&base, "hostil", Some("sh -c curl|sh"));
            let rec = find_record(&base, "hostil").unwrap();
            let program = rec.program.clone().expect("the record carries a program");
            // the same validator the manifest crosses, now on the way OUT of the file
            assert_eq!(
                validate_program(&program).unwrap_err(),
                "err.ext_program_arg:curl|sh"
            );
            // and `start_at` runs it BEFORE anything that could spawn. Source-text,
            // because a real spawn needs an AppHandle no unit test can build.
            let body = fn_body("fn start_at(");
            let at_validate = body.find("validate_program(&program)").expect("the call");
            let at_trust = body.find("trusted_program(id)").expect("the trust gate");
            // the CALL, not a mention of it: this file's comments name
            // `mcp::McpClient::spawn` too, and the first version of this assertion
            // matched the comment and passed for the wrong reason.
            let at_spawn = body.find("McpClient::spawn(&cfg)").expect("the spawn");
            assert!(
                at_validate < at_spawn,
                "the argv is validated before the spawn"
            );
            assert!(
                at_trust < at_spawn,
                "the approval is asked before the spawn"
            );
            assert!(
                body.find("err.ext_untrusted").unwrap() < at_spawn,
                "an unapproved program is refused by name, before any child exists"
            );
        });
    }

    // ADR-0029's R5 row: «explicit second confirmation, contents named». How to see
    // it red: make `start_at` proceed when `trusted_program` disagrees.
    #[test]
    fn a_program_this_machine_never_approved_is_not_trusted() {
        with_home(|_| {
            let base = tmp("trust-base");
            // installed HERE: the install sheet named the command, so the approval
            // is recorded and «iniciar» does not ask twice
            let dir = pacote(
                "trust-pac",
                "aprovada",
                r#"{"loro":2,"kinds":["program"],
                    "program":{"protocol":"mcp/stdio","server":"srv",
                               "command":"loro-nao-existe-mesmo","args":["a.py"]},
                    "surface":{"title":{"pt":"a","en":"b"},"served":true}}"#,
            );
            let out = install_at(&base, dir.to_str().unwrap(), "2026-08-20").unwrap();
            let rec = find_record(&base, &out.id).unwrap();
            let program = rec.program.clone().unwrap();
            assert_eq!(trusted_program(&out.id).as_ref(), Some(&program));
            assert!(rows_at(&base)[0].trusted, "the row says it is approved");
            // the approval is MACHINE state: it is not in the versioned record
            let record = std::fs::read_to_string(record_path(&base)).unwrap();
            // the KEY, not the word: `source.path` legitimately carries the pacote's
            // own folder name, and the first version of this assertion matched that.
            assert!(
                !record.contains("\"trust"),
                "an approval must not travel in the versioned record"
            );
            assert!(trust_file(&out.id)
                .unwrap()
                .starts_with(crate::paths::loro_data_dir()));

            // ONE EDIT TO THE RECORD AND THE APPROVAL IS GONE. This is the case the
            // gate exists for: a change that swaps the command reaches a machine
            // that had already approved the old one.
            let mut swapped = program.clone();
            swapped.command = "sh".into();
            assert_ne!(trusted_program(&out.id).as_ref(), Some(&swapped));

            // and a record that simply ARRIVED has no approval at all
            let other = tmp("trust-pulled");
            hand_written_record(&other, "vinda-de-fora", Some("python3 main.py"));
            let pulled = find_record(&other, "vinda-de-fora").unwrap();
            assert_eq!(trusted_program("vinda-de-fora"), None);
            assert!(
                !rows_at(&other)[0].trusted,
                "the row says it is NOT approved"
            );
            // the program itself is legal — the only thing missing is the person
            assert!(validate_program(&pulled.program.unwrap()).is_ok());
        });
    }

    // DESIGN §1. How to see it red: put `no_answer` back into the `_ =>` arm of
    // `client_of`, and the screen prints «não está rodando — inicie» under a chip
    // that says «sem resposta», about a process that is alive.
    #[test]
    fn a_hung_program_is_not_reported_as_stopped() {
        with_home(|_| {
            with_ext(|st| st.procs.clear());
            mark("mudo", "no_answer", "err.ext_timeout:5000", 0, 0);
            assert_eq!(client_of("mudo").err().unwrap(), "err.ext_no_answer");
            mark("caida", "crashed", "err.ext_spawn", 0, 0);
            assert_eq!(client_of("caida").err().unwrap(), "err.ext_spawn");
            mark("parada", "stopped", "", 0, 0);
            assert_eq!(client_of("parada").err().unwrap(), "err.ext_stopped");
            with_ext(|st| st.procs.clear());
        });
    }

    // The other half of the same defect: the SCREEN has to be offered «parar».
    // `can_stop` is read from the registry — a live handle — and never deduced from
    // `state`, because `sweep` keeps the handle precisely while the child is alive.
    #[test]
    fn the_row_says_whether_there_is_anything_to_stop() {
        let rec: InstalledExt = serde_json::from_str(
            r#"{"id":"x","name":"X","version":"1","source":{"kind":"dir","path":"/tmp"},
                "program":{"protocol":"mcp/stdio","server":"s","command":"python3","args":[]}}"#,
        )
        .unwrap();
        let live = |state: &str, has_client: bool| LiveState {
            state: state.to_string(),
            reason: String::new(),
            last_answer_ms: 0,
            has_client,
        };
        assert!(row_of(&rec, Some(&live("no_answer", true))).can_stop);
        assert!(row_of(&rec, Some(&live("running", true))).can_stop);
        assert!(!row_of(&rec, Some(&live("no_answer", false))).can_stop);
        assert!(!row_of(&rec, None).can_stop);
        // and a start never leaves two children behind: the handle is TAKEN and
        // stopped before the spawn, and taking it does not reset the budget
        let body = fn_body("fn start_at(");
        let at_take = body
            .find("take_client(id)")
            .expect("the old handle is taken");
        assert!(at_take < body.find("McpClient::spawn(&cfg)").unwrap());
        assert!(
            !fn_body("fn take_client(").contains("restarts = 0"),
            "resetting the budget here hands a crash loop a fresh window"
        );
    }

    // BR-8, and the hole it closes: the refusal branch used to be
    // `warn!(code = %format!("err.ext_reserved_name:{m}"))`, where `m` is a method
    // name the EXTENSION's process chose — unbounded and unshaped. An extension has
    // full filesystem access (no sandbox, ADR-0031 P2), so it could read a meeting
    // and emit `{"method":"loro/<200 KB of transcript>"}`: transcript content in
    // the log a person attaches to a support request.
    //
    // HOW TO SEE IT RED: interpolate `{m}` in the `else` branch of `spawn_drain`.
    #[test]
    fn a_refused_notification_name_is_printed_only_when_it_is_loros_own() {
        let body = fn_body("fn spawn_drain(");
        let guarded = body
            .find("LORO_RESERVED_KNOWN.contains(&m.as_str())")
            .expect("the closed set guards the printing branch");
        let interp = body
            .find("err.ext_reserved_name:{m}")
            .expect("Loro's own names are still named");
        assert!(
            guarded < interp,
            "the name is printed only inside the guard"
        );
        assert!(
            body.contains("bytes = m.len()"),
            "everything else is a COUNT, so the refusal is still visible"
        );
        // and there is exactly ONE interpolation of a method in the whole module
        assert_eq!(
            code_only().matches("{m}").count(),
            1,
            "a second one is a second way to print untrusted text"
        );
    }

    /// The source of ONE function of this module, for the wiring assertions above.
    fn fn_body(head: &str) -> String {
        let mine = code_only();
        let at = mine.find(head).unwrap_or_else(|| panic!("{head} exists"));
        let rest = &mine[at..];
        let end = rest.find("\n}\n").map(|e| e + 2).unwrap_or(rest.len());
        rest[..end].to_string()
    }

    #[test]
    fn the_project_policy_travels_and_the_machine_state_does_not() {
        with_home(|home| {
            let base = tmp("escopo-base");
            // MEASURED CORRECTION to ADR-0031 §3.5: `.loro/ext/**` is NOT in the git
            // quarantine (`GIT_IGNORED`, 14 entries, `git.rs:2014-2029`), which is
            // exactly what `escopo: projeto` wants — a teammate reads it in Revisão.
            assert!(!crate::git::is_quarantined(".loro/ext/x/settings.json"));
            assert!(!crate::git::is_quarantined(".loro/ext.json"));
            // and the machine half is guaranteed by being OUTSIDE the repo, not by git
            let maquina = settings_file(&base, "x", "maquina").unwrap();
            assert!(maquina.starts_with(crate::paths::loro_data_dir()));
            assert!(maquina.starts_with(home));
            assert!(!maquina.starts_with(&base));
            assert!(settings_file(&base, "x", "projeto")
                .unwrap()
                .starts_with(&base));
            // and an id that is not a name never becomes a path at all
            for bad in ["/private/tmp/absoluta", "../../vitima", "-x", "MAI", ""] {
                assert!(settings_file(&base, bad, "maquina").is_err(), "{bad}");
                assert!(settings_file(&base, bad, "projeto").is_err(), "{bad}");
            }
        });
    }

    #[test]
    fn a_settings_value_is_checked_against_its_own_schema() {
        with_home(|_| {
            let base = tmp("set-base");
            let dir = pacote(
                "set",
                "com-campos",
                r#"{"loro":2,"kinds":["surface"],
                    "surface":{"title":{"pt":"a","en":"b"},"viewFile":"surface/board.json"},
                    "settings":[
                      {"id":"colecao","kind":"enum","options":["juridico","produto"],
                       "default":"juridico","label":{"pt":"coleção","en":"collection"}},
                      {"id":"endpoint","kind":"host","escopo":"maquina",
                       "label":{"pt":"servidor","en":"server"}},
                      {"id":"prefixo","kind":"string","pattern":"^[a-z]{2,4}-[0-9]+$",
                       "label":{"pt":"prefixo","en":"prefix"}}]}"#,
            );
            write(&dir.join("surface/board.json"), BOARD);
            let id = install_at(&base, dir.to_str().unwrap(), "2026-08-19")
                .unwrap()
                .id;

            // the default is what is in effect before anybody types
            let eff = effective_settings(&base, &find_record(&base, &id).unwrap());
            assert_eq!(eff["colecao"], "juridico");
            assert_eq!(eff["endpoint"], Value::Null);

            // a value outside the enum, a bad host and a value failing the pattern
            for (k, v) in [
                ("colecao", serde_json::json!("financeiro")),
                ("endpoint", serde_json::json!("*")),
                ("prefixo", serde_json::json!("ABCD-1")),
                ("prefixo", serde_json::json!("ab-")),
            ] {
                let err =
                    set_settings_at(&base, &id, &serde_json::json!({ k: v.clone() })).unwrap_err();
                assert_eq!(err, format!("err.ext_settings_invalid:{k}"), "{k}={v}");
            }
            // and a key the schema never declared
            assert_eq!(
                set_settings_at(&base, &id, &serde_json::json!({ "inventado": 1 })).unwrap_err(),
                "err.ext_settings_invalid:inventado"
            );

            let out = set_settings_at(
                &base,
                &id,
                &serde_json::json!({ "colecao": "produto", "endpoint": "acervo.interno.example",
                                     "prefixo": "abc-42" }),
            )
            .unwrap();
            assert_eq!(out["colecao"], "produto");
            assert_eq!(out["prefixo"], "abc-42");
            // TWO FILES, SPLIT BY ESCOPO: the machine value never lands in the repo
            let projeto = read_settings_file(&settings_file(&base, &id, "projeto").unwrap());
            assert!(projeto.contains_key("colecao") && !projeto.contains_key("endpoint"));
            let maquina = read_settings_file(&settings_file(&base, &id, "maquina").unwrap());
            assert!(maquina.contains_key("endpoint") && !maquina.contains_key("colecao"));
        });
    }

    // The pattern is applied, and it is BOUNDED: a nested-quantifier pattern that
    // would make a backtracking engine hang is refused at the schema instead.
    #[test]
    fn a_settings_pattern_is_bounded_and_applied() {
        let p = pattern_parse("^[a-z]{2,4}-[0-9]+$").expect("in the subset");
        assert!(pattern_matches(&p, "abc-42"));
        assert!(!pattern_matches(&p, "abcde-42"));
        assert!(!pattern_matches(&p, "abc-"));
        assert!(!pattern_matches(&p, "abc-42x"));
        let any = pattern_parse("a.c").unwrap();
        assert!(pattern_matches(&any, "abc") && !pattern_matches(&any, "ac"));
        let neg = pattern_parse("[^0-9]+").unwrap();
        assert!(pattern_matches(&neg, "abc") && !pattern_matches(&neg, "a1"));
        // outside the subset → the SCHEMA is refused, never silently ignored
        for hostile in ["(a+)+b", "a|b", "^(x)$", "a{1,99999}"] {
            assert!(pattern_parse(hostile).is_none(), "{hostile}");
        }
        assert_eq!(
            manifest(
                r#"{"loro":2,"settings":[{"id":"x","kind":"string","pattern":"(a+)+b",
                    "label":{"pt":"a","en":"b"}}]}"#
            )
            .unwrap_err(),
            "err.ext_settings_invalid:x"
        );
    }

    // ---- install, list, remove -------------------------------------------

    // E1. How to see it red: drop the check, and a tool somebody had already
    // granted silently repoints — `loops::capabilities_of` keys by server NAME
    // (`loops.rs:2362-2390`).
    #[test]
    fn the_second_extension_with_the_same_server_name_is_refused() {
        with_home(|_| {
            let base = tmp("server-base");
            let decl = |name: &str| {
                format!(
                    r#"{{"loro":2,"kinds":["program"],
                        "program":{{"protocol":"mcp/stdio","server":"acervo-corporativo",
                                    "command":"python3","args":["server/main.py"]}},
                        "surface":{{"title":{{"pt":"{name}","en":"{name}"}},"served":true}}}}"#
                )
            };
            let a = pacote("srv-a", "primeira", &decl("A"));
            let b = pacote("srv-b", "segunda", &decl("B"));
            install_at(&base, a.to_str().unwrap(), "2026-08-19").unwrap();
            let before = std::fs::read_to_string(record_path(&base)).unwrap();
            assert_eq!(
                install_at(&base, b.to_str().unwrap(), "2026-08-19").unwrap_err(),
                "err.ext_server_conflict:acervo-corporativo"
            );
            // and the FIRST extension's record is unchanged
            assert_eq!(std::fs::read_to_string(record_path(&base)).unwrap(), before);
            // a `.mcp.json` key counts too: Loro reads that file and never writes it
            let c = pacote(
                "srv-c",
                "terceira",
                &decl("C").replace("acervo-corporativo", "slack"),
            );
            write(
                &base.join(".mcp.json"),
                r#"{"mcpServers":{"slack":{"command":"x"}}}"#,
            );
            assert_eq!(
                install_at(&base, c.to_str().unwrap(), "2026-08-19").unwrap_err(),
                "err.ext_server_conflict:slack"
            );
        });
    }

    #[test]
    fn an_extension_with_nothing_to_install_is_refused_by_name() {
        with_home(|_| {
            let base = tmp("nothing-base");
            let dir = pacote("nothing", "vazia", r#"{"loro":2,"kinds":["skills"]}"#);
            assert_eq!(
                install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap_err(),
                "err.ext_nothing_to_install"
            );
        });
    }

    #[test]
    fn a_source_that_is_not_a_local_directory_is_refused_by_name() {
        for src in [
            "",
            "https://example.com/x.zip",
            "git@example.com:a/b.git",
            "npm:coisa",
            "owner/repo",
            "/nao/existe/mesmo",
        ] {
            assert_eq!(
                resolve_source(src).unwrap_err(),
                "err.ext_source_unsupported",
                "{src}"
            );
        }
        let dir = tmp("src-ok");
        assert_eq!(resolve_source(dir.to_str().unwrap()).unwrap(), dir);
        // a file is not a pacote
        let f = dir.join("loro.json");
        write(&f, "{}");
        assert_eq!(
            resolve_source(f.to_str().unwrap()).unwrap_err(),
            "err.ext_source_unsupported"
        );
    }

    // A level-1 extension reads as `running` because there is nothing to start, and
    // `hasProgram: false` is what stops the screen offering a control with nothing
    // to act on. How to see it red: report `stopped` and a working extension paints
    // as broken next to an «iniciar» that does nothing.
    #[test]
    fn a_level_one_extension_needs_no_process_and_says_so() {
        with_home(|_| {
            let base = tmp("l1-base");
            let dir = pacote_level1("l1", "painel");
            let out = install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap();
            assert!(!out.trust, "no program: no trust sentence");
            let rows = rows_at(&base);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].state, "running");
            assert!(rows[0].has_surface && !rows[0].has_program);
            assert_eq!(rows[0].reason, "");
            assert_eq!(rows[0].origin, dir.to_string_lossy());
            // the record round-trips through serde
            let rec = find_record(&base, &out.id).unwrap();
            assert_eq!(rec.points, vec!["surface"]);
            assert_eq!(rec.surface.unwrap().view_file, "surface/board.json");
            // and starting it is refused by name rather than pretending
            with_ext(|st| st.procs.clear());
        });
    }

    // A program declared and not installed on this machine is `blocked`, with the
    // reason naming the command — the SAME lookup the spawn uses (ADR-0030), so the
    // row cannot say «found» for something the spawn then cannot start.
    #[test]
    fn a_program_that_is_not_on_this_machine_reads_as_blocked() {
        with_home(|_| {
            let base = tmp("blocked-base");
            let dir = pacote(
                "blocked",
                "sem-programa",
                r#"{"loro":2,"kinds":["program"],
                    "program":{"protocol":"mcp/stdio","server":"srv",
                               "command":"loro-nao-existe-mesmo","args":[]},
                    "surface":{"title":{"pt":"a","en":"b"},"served":true}}"#,
            );
            let out = install_at(&base, dir.to_str().unwrap(), "2026-08-19").unwrap();
            assert!(out.trust, "a program on this machine is what `trust` names");
            let rows = rows_at(&base);
            assert_eq!(rows[0].state, "blocked");
            assert_eq!(
                rows[0].reason,
                "err.ext_program_missing:loro-nao-existe-mesmo"
            );
        });
    }

    // How to see it red: delete on mismatch, and the app deletes what a person
    // wrote after the install.
    #[test]
    fn uninstall_subtracts_only_what_still_hashes_the_same() {
        with_home(|_| {
            let base = tmp("rm-base");
            let dir = pacote_level1("rm", "com-arquivos");
            write(&dir.join("commands/loro-a.md"), "# a\n");
            write(&dir.join("commands/loro-b.md"), "# b\n");
            let id = install_at(&base, dir.to_str().unwrap(), "2026-08-19")
                .unwrap()
                .id;
            assert!(base.join(".claude/commands/loro-a.md").exists());

            // the person edited one of them afterwards
            write(&base.join(".claude/commands/loro-b.md"), "# b, mas meu\n");
            let out = remove_at(&base, &id, false).unwrap();
            assert_eq!(out.removed, vec![".claude/commands/loro-a.md"]);
            assert_eq!(out.kept, vec![".claude/commands/loro-b.md"]);
            assert!(base.join(".claude/commands/loro-b.md").exists());
            assert!(read_record(&base).is_empty());
            // the data dir survives unless it was asked for
            assert!(out.data_kept);
            assert!(out.data_dir.contains("ext"));
        });
    }

    // An EMPTY digest means «I do not know what was here», and not knowing is a
    // reason to keep a file, never to delete it.
    #[test]
    fn uninstall_keeps_a_file_whose_digest_is_unknown() {
        with_home(|_| {
            let base = tmp("rm-sha-base");
            write(&base.join(".claude/commands/loro-x.md"), "# x\n");
            write(
                &record_path(&base),
                r#"[{"id":"x","name":"x","version":"1","source":{"kind":"dir","path":"/tmp"},
                     "files":[{"rel":".claude/commands/loro-x.md","sha256":""}]}]"#,
            );
            let out = remove_at(&base, "x", false).unwrap();
            assert_eq!(out.kept, vec![".claude/commands/loro-x.md"]);
            assert!(out.removed.is_empty());
            assert!(base.join(".claude/commands/loro-x.md").exists());
        });
    }

    // BR-9. `.loro/ext.json` is VERSIONED, so it arrives in somebody else's commit.
    // How to see it red: drop the guard, and a hand-edited record deletes a file
    // outside the project (`plugins.rs:719-748` is the same test one file over).
    #[test]
    fn a_hostile_record_cannot_delete_outside_the_project() {
        with_home(|_| {
            let base = tmp("hostile-base");
            let outside = tmp("hostile-outside");
            let victim = outside.join("segredo.txt");
            write(&victim, "meu\n");
            let sha = crate::models::sha256_of(&victim).unwrap_or_default();
            let rel = format!(
                "../{}/segredo.txt",
                outside.file_name().unwrap().to_string_lossy()
            );
            write(
                &record_path(&base),
                &format!(
                    r#"[{{"id":"x","name":"x","version":"1","source":{{"kind":"dir","path":"/tmp"}},
                         "files":[{{"rel":"{rel}","sha256":"{sha}"}}]}}]"#
                ),
            );
            let out = remove_at(&base, "x", false).unwrap();
            assert!(
                out.removed.is_empty(),
                "nothing outside the project is deleted"
            );
            assert!(victim.exists(), "the file a person owns is still there");
        });
    }

    #[test]
    fn an_unknown_id_is_refused_by_name_everywhere() {
        with_home(|_| {
            let base = tmp("unknown-base");
            assert_eq!(find_record(&base, "nada").unwrap_err(), "err.ext_not_found");
            assert_eq!(
                remove_at(&base, "nada", false).unwrap_err(),
                "err.ext_not_found"
            );
            assert_eq!(
                capabilities_at(&base, "nada").unwrap_err(),
                "err.ext_not_found"
            );
            assert_eq!(
                set_settings_at(&base, "nada", &serde_json::json!({})).unwrap_err(),
                "err.ext_not_found"
            );
        });
    }

    // The action values are one flat object of scalars: a `field` id and an `args`
    // key share the namespace (§4.3), and anything else is refused before it crosses.
    #[test]
    fn action_values_are_scalars_and_nothing_else() {
        assert!(valid_action_values(
            &serde_json::json!({ "tema": "x", "n": 3, "on": true })
        ));
        assert!(valid_action_values(&serde_json::json!({})));
        for bad in [
            serde_json::json!({ "a": { "b": 1 } }),
            serde_json::json!({ "a": [1, 2] }),
            serde_json::json!({ "Bad": 1 }),
            serde_json::json!({ "a-b c": 1 }),
            serde_json::json!([1]),
            serde_json::json!("x"),
        ] {
            assert!(!valid_action_values(&bad), "{bad}");
        }
    }

    // INTEGRATOR (E). The two modules each defined the four wire timeouts, with
    // equal values, and only ext.rs's were reachable. Shown red before the fix by
    // putting the four declarations back: a shadowing re-export does not compile
    // (E0252), and dropping the re-export instead makes the sweep below name the
    // number that stopped being the wire's. (The sweep reads this file's own text,
    // so this comment deliberately does not spell the declaration it looks for —
    // the first draft did, and the test failed on its own prose. Measured.)
    #[test]
    fn the_wire_timeouts_have_exactly_one_definition() {
        assert_eq!(HANDSHAKE_MS, crate::mcp::HANDSHAKE_MS);
        assert_eq!(VIEW_MS, crate::mcp::VIEW_MS);
        assert_eq!(ACTION_MS, crate::mcp::ACTION_MS);
        assert_eq!(STOP_GRACE_MS, crate::mcp::STOP_GRACE_MS);
        // and the file does not re-declare them: the grep IS the assertion, because
        // equal values today are exactly what makes a second definition invisible.
        let src = include_str!("ext.rs");
        for name in ["HANDSHAKE_MS", "VIEW_MS", "ACTION_MS", "STOP_GRACE_MS"] {
            assert!(
                !src.contains(&format!("pub const {name}")),
                "{name} is defined twice again — mcp.rs owns the wire timeouts"
            );
        }
        // the supervisor's own budget is NOT the wire's, and stays here
        assert!(src.contains("pub const RESTART_MAX"));
        assert!(src.contains("pub const RESTART_WINDOW_MS"));
    }
}
