// ADR-0011 v1 CONTRACT-LOCK — the typed model-I/O choke-point that makes BR-1's
// cloud qualification hold BY CONSTRUCTION, *before* the (deferred) multi-agent
// graph exists. Nothing here performs a network call, vendors a model, or builds
// the orchestrator/agents: v1 ships ONLY the guardrails. When granted explicit,
// per-meeting, revocable consent, the ONLY thing that may ever leave the machine
// is the current meeting's bounded transcript excerpt (char-capped) plus
// context.md passages the user EXPLICITLY attaches — NEVER raw audio, NEVER
// another meeting's transcript, NEVER un-attached KB retrieval, NEVER pessoal/
// notes (ADR-0011 Decision (a)/(b)). The leak is closed by the TYPES below, not
// by convention: a `CloudInput` is un-constructible except through one validated
// constructor that requires a valid, non-revoked, meeting-bound `ConsentToken`.
//
// Clean-core (CLAUDE.md §5): model transport sits at the edge behind the
// `ModelRunner` trait; the domain never sees a framework or a socket.

use std::path::Path;

use serde::Serialize;
use tracing::info;

use crate::paths::which;

// ADR-0011 bounded excerpt: a hard char cap stands in for the token cap in v1
// (no tokenizer dependency is vendored). An over-cap excerpt is REJECTED at
// construction, so an unbounded transcript can never reach the cloud edge.
const MEETING_EXCERPT_MAX_CHARS: usize = 8000;

// A contiguous run of base64-alphabet characters this long, with no whitespace
// or punctuation break, is treated as an encoded blob (audio smuggled as text).
// Legitimate transcript prose breaks on spaces/punctuation long before this.
const BASE64_BLOB_MIN: usize = 512;

// Disclosure surfaced by ai_doctor and the pre-enable consent dialog: the
// resolved agent binary is a THIRD content sink Loro cannot redact (ADR-0011).
const AMBIENT_SINK_DISCLOSURE: &str = "Com a nuvem ativada, o binário do agente \
pode guardar trechos no seu próprio armazenamento local, fora da auditoria do \
Loro (ADR-0011).";

// ---- the edge trait ---------------------------------------------------------

// All model I/O sits behind this trait at the edge (ADR-0011, CLAUDE.md §5).
pub trait ModelRunner {
    fn run(&self, input: RunInput) -> Result<String, String>;
}

// The two shapes a runner may receive. The asymmetry IS the guardrail: local
// text is permissive (it never leaves the machine, BR-1 intact); cloud-bound
// text has exactly ONE inhabitant type, `CloudInput`, which cannot be forged.
pub enum RunInput {
    // Arbitrary LOCAL text — may carry anything (KB retrieval, any meeting,
    // pessoal/ notes) precisely because it stays on the machine.
    Local(String),
    // The ONLY cloud-bound shape. Un-constructible except via
    // `CloudInput::for_meeting`, so no local text / KB-retriever output / audio
    // can reach the cloud without a valid, non-revoked, meeting-bound token.
    Cloud(CloudInput),
}

// ---- consent token ----------------------------------------------------------

// Proof that cloud consent was granted for a SPECIFIC meeting. There is no public
// constructor that fabricates one: `from_consent` returns `None` unless the
// meeting's manifest actually granted cloud consent, and it is bound to that
// meeting id. Revocation flips `revoked`, which every guard re-checks — so a
// revoke halts external calls immediately (ADR-0011: consent is revocable at any
// instant). Fields are private: the only observable capability is `is_valid_for`.
pub struct ConsentToken {
    meeting_id: String,
    revoked: bool,
}

impl ConsentToken {
    // Build a token ONLY from a meeting's granted cloud consent. `None` when cloud
    // consent is off (default), so there is no path to a token without consent.
    pub fn from_consent(meeting_id: &str, cloud_consent_granted: bool) -> Option<ConsentToken> {
        if cloud_consent_granted && !meeting_id.is_empty() {
            Some(ConsentToken {
                meeting_id: meeting_id.to_string(),
                revoked: false,
            })
        } else {
            None
        }
    }

    // Revoke immediately (ADR-0011): any subsequent guard refuses.
    pub fn revoke(&mut self) {
        self.revoked = true;
    }

    // Valid only while non-revoked AND bound to THIS meeting — so a token for
    // meeting A can never authorize an excerpt tagged meeting B.
    pub fn is_valid_for(&self, meeting_id: &str) -> bool {
        !self.revoked && self.meeting_id == meeting_id
    }
}

// ---- the whitelisted cloud input --------------------------------------------

// The ONLY payload `CloudRunner` accepts. Every field is a WHITELISTED text field
// (ADR-0011 Decision (b)); there is deliberately NO `From`/`Into`, no public
// field, and no constructor other than `for_meeting`, so KB-retriever output or a
// raw string cannot be coerced into one — an attach is always explicit.
pub struct CloudInput {
    meeting_id: String,
    meeting_excerpt: String,
    attached_passages: Vec<String>,
    token: ConsentToken,
}

impl CloudInput {
    // The single validated constructor. Rejects (never proceeds) if: the token is
    // absent/revoked or bound to another meeting (BR-1 consent gate + cross-meeting
    // guard), the excerpt exceeds the cap (bounded excerpt), or any field looks
    // like audio/binary (data: URI, control bytes, or a base64-looking blob). The
    // `attached_passages` are whatever the user EXPLICITLY attached — never
    // populated from un-attached KB retrieval by any code path.
    pub fn for_meeting(
        meeting_id: &str,
        meeting_excerpt: String,
        attached_passages: Vec<String>,
        token: ConsentToken,
    ) -> Result<CloudInput, String> {
        if !token.is_valid_for(meeting_id) {
            return Err(
                "consent token absent/revoked or bound to another meeting (ADR-0011 BR-1)".into(),
            );
        }
        if meeting_excerpt.chars().count() > MEETING_EXCERPT_MAX_CHARS {
            return Err("meeting excerpt exceeds the char cap (ADR-0011 bounded excerpt)".into());
        }
        reject_binary_like(&meeting_excerpt)?;
        for p in &attached_passages {
            reject_binary_like(p)?;
        }
        Ok(CloudInput {
            meeting_id: meeting_id.to_string(),
            meeting_excerpt,
            attached_passages,
            token,
        })
    }

    // Read-only views for the (deferred) transport. No mutation surface exists.
    pub fn meeting_id(&self) -> &str {
        &self.meeting_id
    }
    pub fn meeting_excerpt(&self) -> &str {
        &self.meeting_excerpt
    }
    pub fn attached_passages(&self) -> &[String] {
        &self.attached_passages
    }
}

// Reject anything that looks like audio/binary rather than transcript text. The
// `String` type already excludes non-UTF8 raw audio bytes by construction; this
// adds three hand-rolled heuristics (no new crate): a data: URI prefix, control
// bytes that never occur in legitimate transcript prose, and a long unbroken
// base64-looking run. ADR-0011: raw audio NEVER leaves the machine.
fn reject_binary_like(s: &str) -> Result<(), String> {
    let trimmed = s.trim_start();
    if trimmed
        .as_bytes()
        .get(..5)
        .map(|b| b.eq_ignore_ascii_case(b"data:"))
        .unwrap_or(false)
    {
        return Err("input rejected: data: URI (possible audio/binary) — ADR-0011".into());
    }
    if s.bytes().any(is_disallowed_control) {
        return Err("input rejected: binary/control bytes — ADR-0011".into());
    }
    if looks_like_base64_blob(s) {
        return Err(
            "input rejected: base64-looking blob (possible audio/binary) — ADR-0011".into(),
        );
    }
    Ok(())
}

// Control bytes disallowed in transcript text (tab/LF/CR are allowed).
fn is_disallowed_control(b: u8) -> bool {
    matches!(b, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f)
}

// True when the longest contiguous base64-alphabet run reaches the blob floor.
fn looks_like_base64_blob(s: &str) -> bool {
    let mut run = 0usize;
    let mut max = 0usize;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' {
            run += 1;
            max = max.max(run);
        } else {
            run = 0;
        }
    }
    max >= BASE64_BLOB_MIN
}

// ---- the two runners (both edge, neither vendored) --------------------------

// Default runner — keeps BR-1 intact: it may carry ANY local text because nothing
// it touches leaves the machine. Resolved from LORO_LOCAL_LLM_BIN / PATH like
// ADR-0003's not-vendored precedent; v1 is a STUB (no network, no vendoring).
pub struct LocalRunner {
    bin: Option<String>,
}

impl LocalRunner {
    // Resolution only — nothing is spawned. The concrete local model server is a
    // separate later decision (ADR-0011 defers the runner choice).
    pub fn resolve() -> Self {
        let bin = std::env::var("LORO_LOCAL_LLM_BIN")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| which("llama-server"))
            .or_else(|| which("ollama"));
        LocalRunner { bin }
    }

    pub fn ready(&self) -> bool {
        self.bin.is_some()
    }

    // Basename only — never a full path (which could disclose the home layout).
    // A binary name is not a secret (BR-9).
    pub fn name(&self) -> String {
        self.bin
            .as_deref()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.to_string())
            })
            .unwrap_or_default()
    }
}

impl ModelRunner for LocalRunner {
    fn run(&self, input: RunInput) -> Result<String, String> {
        match input {
            // v1 stub: no local runner is wired yet (no vendoring, no network).
            RunInput::Local(_) => Err("local runner not configured".into()),
            // A cloud-bound payload must never be served by the local runner.
            RunInput::Cloud(_) => {
                Err("cloud input must be routed through CloudRunner (ADR-0011)".into())
            }
        }
    }
}

// Cloud runner — the choke-point. It accepts ONLY a `CloudInput` (whitelisted,
// capped, consent-gated). The GUARDS below are REAL and tested; the actual
// network transport and the multi-agent graph are DEFERRED to a later ADR, so
// after all guards pass v1 still refuses to proceed.
#[derive(Default)]
pub struct CloudRunner;

impl CloudRunner {
    // Whether a cloud agent binary is resolvable (ADR-0004 ambient-credential
    // model, like `gh`). Availability is NOT consent — a call still requires a
    // valid, non-revoked ConsentToken. Reads no secret, stores no credential.
    pub fn available() -> bool {
        which("claude").is_some() || which("ant").is_some()
    }
}

impl ModelRunner for CloudRunner {
    fn run(&self, input: RunInput) -> Result<String, String> {
        let cloud = match input {
            RunInput::Cloud(c) => c,
            // Refuse arbitrary local text by TYPE (BR-1): the cloud edge has no
            // path from a plain string / KB-retriever output.
            RunInput::Local(_) => {
                return Err("CloudRunner accepts only a consent-gated CloudInput (ADR-0011)".into())
            }
        };
        // Defense in depth: re-check the embedded token is still valid & bound —
        // a revoke between construction and dispatch halts the call immediately.
        if !cloud.token.is_valid_for(&cloud.meeting_id) {
            return Err(
                "consent revoked or token not bound to this meeting (ADR-0011 BR-1)".into(),
            );
        }
        // Guards passed; transport is deferred (ADR-0011 graph not built).
        Err("cloud runner deferred (ADR-0011 graph not built)".into())
    }
}

// ---- two-tier audit (ADR-0011 Decision (c)/(d)) -----------------------------

// One external-call record as read back from the meeting-LOCAL, content-bearing
// `audit.jsonl`. It MAY carry the exact excerpt sent (the file stays under
// pessoal/, quarantined by git.rs — never shared, never PR'd). The `callId` is an
// opaque correlator to the redacted shared-log line.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    when: String,
    target: String,
    kind: String,
    excerpt: String,
    tokens: u64,
    call_id: String,
}

// Read the external-call events from a meeting's local audit. Consent-set and
// other event kinds are skipped — this returns only content-bearing call records.
// Tolerant of malformed lines (skipped) so a single bad line never blocks a read.
fn read_audit(path: &Path) -> Vec<AuditEvent> {
    let txt = std::fs::read_to_string(path).unwrap_or_default();
    txt.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|v| v.get("event").and_then(|e| e.as_str()) == Some("external-call"))
        .map(|v| {
            let s = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            AuditEvent {
                when: if v.get("when").is_some() {
                    s("when")
                } else {
                    s("em")
                },
                target: s("target"),
                kind: s("kind"),
                excerpt: s("excerpt"),
                tokens: v.get("tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                call_id: s("callId"),
            }
        })
        .collect()
}

// The BR-8 shared-log line for an external call (~/.loro/logs): correlator +
// counts ONLY — NEVER the excerpt (that stays in the meeting-local audit). The
// callId is an OPAQUE random id, NOT a hash of the excerpt: a hash of a short,
// low-entropy excerpt is near-reversible and offers false safety (ADR-0011).
fn shared_call_log_line(
    when: &str,
    target: &str,
    kind: &str,
    tokens: u64,
    call_id: &str,
) -> String {
    serde_json::json!({
        "when": when,
        "target": target,
        "kind": kind,
        "tokens": tokens,
        "callId": call_id,
    })
    .to_string()
}

// Record ONE external call across BOTH tiers (ADR-0011): the content-bearing line
// (with the exact excerpt) into the meeting-local `audit.jsonl`, and the
// redacted correlator line into `~/.loro/logs`. Returns the opaque callId. No
// external call happens in v1, so this is exercised only by a unit test.
#[allow(dead_code)] // wired by the deferred ADR-0011 graph; contract locked now.
fn record_external_call(
    meeting_dir: &Path,
    logs_dir: &Path,
    when: &str,
    target: &str,
    kind: &str,
    excerpt: &str,
    tokens: u64,
) -> Result<String, String> {
    let call_id = new_call_id();
    append_line(
        &meeting_dir.join("audit.jsonl"),
        &serde_json::json!({
            "em": when,
            "event": "external-call",
            "target": target,
            "kind": kind,
            "excerpt": excerpt,
            "tokens": tokens,
            "callId": call_id,
        })
        .to_string(),
    )?;
    append_line(
        &logs_dir.join("ai-calls.jsonl"),
        &shared_call_log_line(when, target, kind, tokens, &call_id),
    )?;
    Ok(call_id)
}

fn append_line(path: &Path, line: &str) -> Result<(), String> {
    let mut cur = std::fs::read_to_string(path).unwrap_or_default();
    cur.push_str(line);
    cur.push('\n');
    std::fs::write(path, cur).map_err(|e| e.to_string())
}

// An opaque, non-reversible correlator derived from time/pid/counter (NOT from
// the excerpt). Dependency-free splitmix64 finalizer — this is a correlator, not
// a security token, so a PRNG-quality id suffices.
fn new_call_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = CTR.fetch_add(1, Ordering::Relaxed);
    let mut x =
        t ^ c.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (std::process::id() as u64).rotate_left(17);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    format!("{x:016x}")
}

// ---- Tauri commands ---------------------------------------------------------

// Booleans/strings only — reads NO secret and captures NO token (BR-9), mirroring
// env_doctor's posture. `analyseEnabled` is false in v1 (the análise surface is a
// disabled placeholder). `ambientBinarySink` discloses the third content sink.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDoctor {
    local_model_ready: bool,
    local_model_name: String,
    embeddings_ready: bool,
    cloud_available: bool,
    mcp_available: bool,
    analyse_enabled: bool,
    ambient_binary_sink: String,
}

#[tauri::command]
pub fn ai_doctor() -> AiDoctor {
    let local = LocalRunner::resolve();
    let cloud_available = CloudRunner::available();
    info!(
        target: "ai_doctor",
        local_ready = local.ready(),
        cloud_available,
        "ai posture"
    );
    AiDoctor {
        local_model_ready: local.ready(),
        local_model_name: local.name(),
        // Deferred in v1: no embeddings system dependency, no MCP wiring, and the
        // análise surface stays a disabled placeholder (ADR-0011).
        embeddings_ready: false,
        cloud_available,
        mcp_available: false,
        analyse_enabled: false,
        ambient_binary_sink: AMBIENT_SINK_DISCLOSURE.into(),
    }
}

// Read a meeting's LOCAL two-tier audit (content-bearing external-call records).
// Path-guarded via meeting::meeting_dir; the file never leaves pessoal/ (git.rs
// quarantine). Returns [] when no external call has been recorded (v1 default).
#[tauri::command]
pub fn brain_meeting_audit(id: String) -> Result<Vec<AuditEvent>, String> {
    let dir = crate::meeting::meeting_dir(&id)?;
    Ok(read_audit(&dir.join("audit.jsonl")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "loro-ai-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn token(id: &str) -> ConsentToken {
        ConsentToken::from_consent(id, true).expect("cloud consent granted")
    }

    // ---- property (a): no audio/base64/data: reaches a successful guard --------
    #[test]
    fn cloud_input_rejects_audio_and_binary_shaped_text() {
        let m = "2026-07-27-1430-x";
        // data: URI (base64-encoded audio smuggled as text)
        assert!(CloudInput::for_meeting(
            m,
            "data:audio/wav;base64,UklGRiQ".into(),
            vec![],
            token(m)
        )
        .is_err());
        // control/binary bytes
        assert!(CloudInput::for_meeting(m, "abc\u{0}def".into(), vec![], token(m)).is_err());
        // a long unbroken base64-looking blob
        let blob = "A".repeat(BASE64_BLOB_MIN + 1);
        assert!(CloudInput::for_meeting(m, blob.clone(), vec![], token(m)).is_err());
        // an attached passage is guarded too, not just the excerpt
        assert!(CloudInput::for_meeting(m, "ok".into(), vec![blob], token(m)).is_err());
        // a benign excerpt with normal punctuation/whitespace is accepted
        assert!(CloudInput::for_meeting(
            m,
            "Discutimos o orçamento da frota; ficou decidido rever em agosto.".into(),
            vec!["Contexto: metas 2026.".into()],
            token(m)
        )
        .is_ok());
    }

    // ---- property (b): no CloudInput without a valid, non-revoked token --------
    #[test]
    fn cloud_input_requires_valid_consent_token() {
        let m = "2026-07-27-1430-x";
        // no token can be built when consent is OFF (the v1 default)
        assert!(ConsentToken::from_consent(m, false).is_none());
        // a revoked token is refused at construction
        let mut t = token(m);
        t.revoke();
        assert!(CloudInput::for_meeting(m, "ok".into(), vec![], t).is_err());
        // and a live CloudRunner never proceeds without a valid token either
        let mut t2 = token(m);
        t2.revoke();
        // (cannot even build the input, so nothing reaches CloudRunner::run)
        assert!(CloudInput::for_meeting(m, "ok".into(), vec![], t2).is_err());
    }

    // ---- property (c): a token for A cannot authorize an excerpt tagged B ------
    #[test]
    fn token_is_bound_to_its_meeting() {
        let a = "2026-07-27-1430-a";
        let b = "2026-07-27-1500-b";
        let t_a = token(a);
        assert!(t_a.is_valid_for(a));
        assert!(!t_a.is_valid_for(b));
        // building a B input with A's token is rejected (cross-meeting guard)
        assert!(CloudInput::for_meeting(b, "ok".into(), vec![], t_a).is_err());
    }

    // ---- property (d): an over-cap excerpt is rejected -------------------------
    #[test]
    fn over_cap_excerpt_is_rejected() {
        let m = "2026-07-27-1430-x";
        // whitespace-broken prose exactly at the cap (avoids the blob heuristic)
        let at_cap = "palavra ".repeat(MEETING_EXCERPT_MAX_CHARS / 8);
        assert_eq!(at_cap.chars().count(), MEETING_EXCERPT_MAX_CHARS);
        assert!(CloudInput::for_meeting(m, at_cap, vec![], token(m)).is_ok());
        let over = format!("{}x", "palavra ".repeat(MEETING_EXCERPT_MAX_CHARS / 8));
        assert!(CloudInput::for_meeting(m, over, vec![], token(m)).is_err());
    }

    // ---- property (e): the ONLY path is an explicit attach + token -------------
    // There is no `From<String>`/`From<&str>` for CloudInput and its fields are
    // private, so KB-retriever output (a plain String) cannot be coerced into a
    // CloudInput; the sole constructor demands an explicit token and an explicit
    // `attached_passages` vec. This is a compile-time guarantee (privacy); the
    // test documents the runtime consequence: local text goes to LocalRunner,
    // and the cloud edge refuses a RunInput::Local.
    #[test]
    fn kb_or_local_text_cannot_reach_the_cloud_edge() {
        let kb_passage = String::from("un-attached KB retrieval output");
        // The local path ACCEPTS it as a local input (stays on the machine, BR-1
        // intact) — the error is only the v1 "not configured" stub, not a refusal.
        let local_err = LocalRunner::resolve()
            .run(RunInput::Local(kb_passage.clone()))
            .unwrap_err();
        assert!(local_err.contains("local runner not configured"));
        // ...and the cloud runner refuses a local input by type.
        let err = CloudRunner.run(RunInput::Local(kb_passage)).unwrap_err();
        assert!(err.contains("only a consent-gated CloudInput"));
    }

    // ---- randomized adversarial loop over the guards ---------------------------
    // Seeded, dependency-free PRNG: build adversarial excerpts and assert the
    // invariant holds every time — any data:/control/base64 shape is rejected,
    // and any accepted input is within the cap and carries a valid bound token.
    #[test]
    fn randomized_adversarial_inputs_never_leak() {
        let m = "2026-07-27-1430-r";
        let mut seed: u64 = 0x1234_5678_9abc_def0;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..2000 {
            let choice = next() % 5;
            let excerpt = match choice {
                0 => format!("data:audio/x;base64,{}", "Q".repeat((next() % 40) as usize)),
                1 => {
                    // inject a random control byte
                    let mut s = String::from("hello ");
                    s.push(char::from((next() % 0x1f) as u8));
                    s.push_str(" world");
                    s
                }
                2 => "z".repeat(BASE64_BLOB_MIN + (next() % 100) as usize),
                3 => "palavra ".repeat((next() % 900 + 1000) as usize), // over cap
                _ => "reunião normal com pontuação, ok.".to_string(),   // benign
            };
            let res = CloudInput::for_meeting(m, excerpt.clone(), vec![], token(m));
            match res {
                Ok(ci) => {
                    // Anything accepted must be benign: within cap, no binary shape.
                    assert!(ci.meeting_excerpt().chars().count() <= MEETING_EXCERPT_MAX_CHARS);
                    assert!(reject_binary_like(ci.meeting_excerpt()).is_ok());
                    assert!(ci.token.is_valid_for(m));
                }
                Err(_) => { /* rejected — the safe outcome for adversarial input */ }
            }
        }
    }

    // ---- CloudRunner: guards pass, transport deferred --------------------------
    #[test]
    fn cloud_runner_guards_pass_then_defers() {
        let m = "2026-07-27-1430-x";
        let ci = CloudInput::for_meeting(m, "resumo curto".into(), vec![], token(m)).unwrap();
        let err = CloudRunner.run(RunInput::Cloud(ci)).unwrap_err();
        assert!(err.contains("deferred"));
    }

    // ---- two-tier audit: content local, correlator-only shared -----------------
    #[test]
    fn two_tier_audit_keeps_excerpt_local_and_redacts_shared_log() {
        let mdir = tmp("audit-meeting");
        let logs = tmp("audit-logs");
        let call_id = record_external_call(
            &mdir,
            &logs,
            "2026-07-27T14:30:00Z",
            "cloud:claude",
            "analyse",
            "trecho confidencial da reunião",
            42,
        )
        .unwrap();

        // meeting-local audit is content-bearing
        let local = std::fs::read_to_string(mdir.join("audit.jsonl")).unwrap();
        assert!(local.contains("trecho confidencial da reunião"));
        assert!(local.contains(&call_id));

        // shared log carries the correlator + counts ONLY — never the excerpt
        let shared = std::fs::read_to_string(logs.join("ai-calls.jsonl")).unwrap();
        assert!(!shared.contains("trecho confidencial"));
        assert!(shared.contains(&call_id));
        let v: serde_json::Value = serde_json::from_str(shared.trim()).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["callId", "kind", "target", "tokens", "when"]);
        // callId is NOT a hash of the excerpt: it must not be derivable from it
        assert!(!call_id.is_empty() && call_id.len() == 16);

        // read_audit reconstructs the content-bearing record
        let events = read_audit(&mdir.join("audit.jsonl"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].excerpt, "trecho confidencial da reunião");
        assert_eq!(events[0].call_id, call_id);
        assert_eq!(events[0].tokens, 42);
    }

    // read_audit skips consent-set (non-call) lines — only call records surface
    #[test]
    fn read_audit_ignores_non_call_events() {
        let mdir = tmp("audit-mixed");
        let p = mdir.join("audit.jsonl");
        std::fs::write(
            &p,
            "{\"em\":\"2026-07-27T14:31:00Z\",\"event\":\"consent-set\",\"cloud\":true,\"mcp\":false}\n",
        )
        .unwrap();
        assert!(read_audit(&p).is_empty());
    }

    // call ids are opaque and unique across calls
    #[test]
    fn call_ids_are_opaque_and_unique() {
        let a = new_call_id();
        let b = new_call_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // ---- ai_doctor posture: booleans/strings, no secret, no token --------------
    #[test]
    fn ai_doctor_reports_v1_deferred_posture() {
        let d = ai_doctor();
        // deferred surfaces are honestly off in v1
        assert!(!d.embeddings_ready);
        assert!(!d.mcp_available);
        assert!(!d.analyse_enabled);
        // the third-sink disclosure is present and references the ADR
        assert!(d.ambient_binary_sink.contains("ADR-0011"));
    }

    // ---- BR-8 source lint: no content interpolated into AI/meeting logs --------
    // Enforce the redaction boundary WHERE IT MATTERS (ADR-0011): no log macro in
    // ai.rs / meeting.rs may interpolate a transcript/excerpt/passage/prompt
    // variable. The full event-code migration of client_log is a follow-up.
    #[test]
    fn no_content_variable_in_ai_or_meeting_logs() {
        // Positive control (built at runtime so this source stays lint-clean): the
        // extractor pulls a macro's args and the word-detector flags the leak.
        let leak = String::from("info!") + "(\"sent {}\", the_secret_excerpt);";
        assert!(
            log_macro_args(&leak)
                .iter()
                .any(|a| contains_banned_word(a)),
            "the lint must catch an obvious leak"
        );

        for file in ["ai.rs", "meeting.rs"] {
            let path = format!("{}/src/{file}", env!("CARGO_MANIFEST_DIR"));
            let src = std::fs::read_to_string(&path).unwrap();
            for args in log_macro_args(&src) {
                assert!(
                    !contains_banned_word(&args),
                    "{file}: a log macro interpolates transcript/content: {args}"
                );
            }
        }
    }

    // Extract the argument text of each log-macro invocation (paren-balanced).
    // Deliberately simple — it scans our own controlled sources, whose logs never
    // embed unbalanced parens inside string literals.
    fn log_macro_args(src: &str) -> Vec<String> {
        const MACROS: [&str; 6] = ["info!", "warn!", "error!", "debug!", "trace!", "log!"];
        let mut out = Vec::new();
        for mac in MACROS {
            let mut from = 0;
            while let Some(rel) = src[from..].find(mac) {
                let after = from + rel + mac.len();
                from = after;
                let rest = &src[after..];
                let Some(nz) = rest.find(|c: char| !c.is_whitespace()) else {
                    continue;
                };
                if rest.as_bytes()[nz] != b'(' {
                    continue;
                }
                let open = after + nz;
                if let Some(close) = match_paren(src, open) {
                    out.push(src[open + 1..close].to_string());
                    from = close + 1;
                }
            }
        }
        out
    }

    fn match_paren(src: &str, open: usize) -> Option<usize> {
        let b = src.as_bytes();
        let mut depth = 0i32;
        for (i, &ch) in b.iter().enumerate().skip(open) {
            match ch {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        None
    }

    // Conservative substring guard for content-bearing variable names.
    fn contains_banned_word(s: &str) -> bool {
        const BANNED: [&str; 6] = [
            "excerpt",
            "transcript",
            "passage",
            "chunk",
            "reuniao_body",
            "prompt",
        ];
        BANNED.iter().any(|w| s.contains(w))
    }
}
