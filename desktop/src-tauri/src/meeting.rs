// Meetings as living files, artifacts and a built notebook (ADR-0010, extending
// ADR-0005). A meeting is a folder under the ADR-0013 Brainstorming tree
// `brainstorming/<slug>/reunioes/<AAAA-MM-DD-HHMM>-<slug>/`, so the single
// `brainstorming/` gitignore line (git.rs) already quarantines all meeting audio,
// transcript and audit — nothing here is ever versioned. Everything is local
// (BR-1, unconditional for audio here); markers/logs carry no transcript text or
// PII (BR-8); no secrets are handled (BR-9).
//
// Clean-core (CLAUDE.md §5): the audio capture/mix path REUSES the ADR-0005
// functions in lib.rs unchanged and is GUI/permission-verified, not unit-tested.
// Everything else (slug/dir naming, manifest read/edit, the notebook assembler,
// the append-below-marker edit, marker validation) is factored into pure
// functions covered by `cargo test` with no live audio.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::config::read_brain_config;
use crate::git::sanitize_slug;
use crate::paths::{ffmpeg_not_found_err, which};
use crate::AppState;

// ---- constants --------------------------------------------------------------

// The living file appends transcript/AI blocks below this stable marker so the
// tail is always well-defined for the append (ADR-0010 append-only living file).
const TRANSCRIPT_MARKER: &str = "<!-- loro:transcricao -->";

// Marker kinds are the ONLY thing a marker stores (plus a timecode/ref) — never
// transcript text (BR-8). Unknown kinds are rejected.
//
// ADR-0020 collapsed the four typed markers into ONE ("momento") in the UI, but
// this list was never updated: `momento` was refused, so every "marcar momento"
// answered "tipo de marcador inválido" and the feature was dead from the day the
// redesign shipped. `momento` leads because it is the only kind still written;
// the four legacy kinds stay accepted so a manifest recorded before the redesign
// keeps validating.
const MARKER_TIPOS: [&str; 5] = ["momento", "duvida", "decisao", "investigacao", "pergunta"];

// The `artefatos/` operational-memory folders (ADR-0010). An artifact kind must
// be one of these, which also path-guards the write to a fixed subtree.
const ARTIFACT_KINDS: [&str; 8] = [
    "respostas",
    "investigacoes",
    "graficos",
    "consultas",
    "prompts",
    "documentos",
    "tabelas",
    "mcp",
];

// ---- base + per-meeting serialization ---------------------------------------

// The active acervo root, canonicalized — the single trust boundary for every FS
// path below (same guard the other brain_* commands use).
fn acervo_base() -> Result<PathBuf, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())
}

// One lock per meeting id: manifest writes (shared mutable state) are serialized
// so no two commands interleave a read-modify-write (ADR-0010 consequences).
//
// The lock is keyed by ID, never by path, precisely because the path MOVES
// (#44). Hence the discipline every mutating command follows: take the lock
// FIRST, resolve the directory after — see `resolve_meeting_dir`.
fn meeting_lock(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

// The syscap sidecar (ADR-0005 start_system_capture) writes into recordings_dir
// and returns that path; we remember it per meeting so stop() can move the
// finalized WAV into the meeting's audio/.
//
// It is a LIST, not a single path: pausing stops the sidecar for real (nothing
// is captured while paused — a pause that kept recording would be the lie this
// feature exists to avoid), and resuming spawns a new one, which writes a new
// file. The last entry is the live segment; every entry has to be moved at stop
// so purge can clean it.
fn syscap_pending() -> &'static Mutex<HashMap<String, Vec<PathBuf>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Vec<PathBuf>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

// Where a captured system segment lands inside the meeting: the first keeps the
// historical name, the rest are numbered. Naming is what makes the segments
// discoverable by purge (BR-8: the audio must be deletable).
pub(crate) fn system_segment_name(i: usize) -> String {
    if i == 0 {
        "system.wav".into()
    } else {
        format!("system-{}.wav", i + 1)
    }
}

// A meeting id is `<AAAA-MM-DD-HHMM>-<slug>` — only [a-z0-9-], so it can never be
// a traversal segment. Validating it up front keeps resolve_meeting_dir safe.
fn valid_meeting_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// Locate a meeting dir from its id by scanning brainstorming/*/reunioes/<id>/
// (ADR-0013), falling back to the legacy pessoal/temas/*/reunioes/<id>/ for
// un-migrated acervos; stateless and path-guarded (canonicalize + starts_with).
//
// The result is only valid while the meeting's lock is HELD: `move_meeting_dir`
// renames the directory, so a caller that resolves before locking blocks on the
// move and then writes into a folder that no longer exists — recreating it as an
// orphan. A mutating caller therefore locks first and calls this second (#44).
fn resolve_meeting_dir(base: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_meeting_id(id) {
        return Err("err.invalid_meeting_id".into());
    }
    // (roots to scan, whether the <id> sits directly under `reunioes/`)
    let roots = [
        base.join("brainstorming"),
        base.join("pessoal").join("temas"),
    ];
    for root in roots {
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in rd.flatten() {
            let cand = entry.path().join("reunioes").join(id);
            if cand.join("manifest.json").is_file() {
                let canon = cand.canonicalize().map_err(|e| e.to_string())?;
                if !canon.starts_with(base) {
                    return Err("err.outside_acervo".into());
                }
                return Ok(canon);
            }
        }
    }
    Err("err.meeting_not_found".into())
}

// Resolve a meeting's on-disk dir by id for cross-module readers (ADR-0011
// two-tier audit: `ai::brain_meeting_audit` reads the meeting-local
// `auditoria.jsonl`). Reuses the SAME acervo base + path guard as every meeting
// command, so no caller can traverse outside the quarantined `pessoal/` tree.
pub(crate) fn meeting_dir(id: &str) -> Result<PathBuf, String> {
    resolve_meeting_dir(&acervo_base()?, id)
}

fn rel_of(base: &Path, p: &Path) -> String {
    p.strip_prefix(base)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().replace('\\', "/"))
}

// ---- clock (dependency-free, UTC) -------------------------------------------

// (dir stamp `AAAA-MM-DD-HHMM`, ISO 8601 datetime `...Z`). Kept tiny/dep-free;
// the pure cores take the strings so tests stay deterministic.
fn now_stamp_iso() -> (String, String) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    let (h, min, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    (
        format!("{y:04}-{m:02}-{d:02}-{h:02}{min:02}"),
        format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}Z"),
    )
}

fn now_iso() -> String {
    now_stamp_iso().1
}

// days since 1970-01-01 -> (year, month, day). Howard Hinnant's civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---- manifest ---------------------------------------------------------------

// The ONE join-table for a meeting: references + metadata + PII-free stat markers
// (ADR-0010). `modelo`/`idioma` are captured from the start cfg so the notebook
// Cabeçalho can render model/lang without a live-audio dependency; `atualizadoEm`
// records the last living-file/manifest write. No field ever holds transcript
// text (BR-8) or a credential (BR-9).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completo: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    rel: String,
    #[serde(default)]
    refs: Vec<String>,
    #[serde(default)]
    cloud: bool,
    #[serde(default)]
    em: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    #[serde(default)]
    tipo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    t_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    r#ref: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
    #[serde(default)]
    cloud: bool,
    #[serde(default)]
    mcp: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    tipo: String,
    #[serde(default)]
    caminho: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    id: String,
    #[serde(default)]
    tema: String,
    #[serde(default)]
    titulo: String,
    #[serde(default)]
    criado_em: String,
    #[serde(default)]
    atualizado_em: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    modelo: String,
    #[serde(default)]
    idioma: String,
    #[serde(default)]
    audio: Audio,
    #[serde(default)]
    artifacts: Vec<Artifact>,
    #[serde(default)]
    marcadores: Vec<Marker>,
    #[serde(default)]
    consent: Consent,
    #[serde(default)]
    refs: Vec<RefItem>,
}

// #44 — the meeting lock, reachable from `acervo::move_meeting_dir` so the rename
// and the metadata rewrite happen under the SAME lock. Locking only the rewrite
// left the original race open: `brain_meeting_append` resolves the directory
// before it locks, so a rename slipping in between made its write land on a path
// that no longer exists and the transcript chunk was lost.
pub(crate) fn lock_for(id: &str) -> Arc<Mutex<()>> {
    meeting_lock(id)
}

// The meeting's lifecycle status (`done` once the recording was finalized).
pub(crate) fn status_of(dir: &Path) -> Result<String, String> {
    Ok(manifest_read(dir)?.status)
}

// #44 — a moved meeting must stop naming the brainstorming it came from AND stop
// pointing at its own old path. It records both in `manifest.json` — `tema`, and
// the acervo-relative paths of its audio, artifacts and refs — and the
// brainstorming's name once more in `reuniao.md`'s front matter (`tema:`).
//
// This lives here because this module owns the manifest format and its write
// discipline. The CALLER must already hold `lock_for(<id>)` — the mutex is not
// reentrant, so taking it again here would deadlock.
//
// Only `tema` and paths under `old_rel` change; the transcript body is never
// touched, and a ref pointing OUTSIDE the meeting did not move and is left alone.
pub(crate) fn remap_meeting_locked(
    dir: &Path,
    new_tema: &str,
    old_rel: &str,
    new_rel: &str,
) -> Result<(), String> {
    let mut manifest = manifest_read(dir)?;
    manifest.tema = new_tema.to_string();
    for slot in [
        &mut manifest.audio.mic,
        &mut manifest.audio.system,
        &mut manifest.audio.completo,
    ] {
        if let Some(next) = slot.as_deref().and_then(|p| repath(p, old_rel, new_rel)) {
            *slot = Some(next);
        }
    }
    for a in &mut manifest.artifacts {
        if let Some(next) = repath(&a.rel, old_rel, new_rel) {
            a.rel = next;
        }
        for r in &mut a.refs {
            if let Some(next) = repath(r, old_rel, new_rel) {
                *r = next;
            }
        }
    }
    for r in &mut manifest.refs {
        if let Some(next) = repath(&r.caminho, old_rel, new_rel) {
            r.caminho = next;
        }
    }
    manifest_write(dir, &manifest)?;

    let living = dir.join("reuniao.md");
    match std::fs::read_to_string(&living) {
        Ok(txt) => {
            let out = retema_front_matter(&txt, new_tema);
            if out != txt {
                std::fs::write(&living, out).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        // an unreadable living file is reported, never swallowed (D9)
        Err(e) if living.exists() => Err(format!("err.living_unreadable:{e}")),
        Err(_) => Ok(()),
    }
}

// Re-root an acervo-relative path that lived under `old_rel`. `None` when the
// path is not the moved meeting's — matching on whole SEGMENTS, so `…/m10` is
// never mistaken for `…/m1`.
fn repath(p: &str, old_rel: &str, new_rel: &str) -> Option<String> {
    if p == old_rel {
        return Some(new_rel.to_string());
    }
    p.strip_prefix(old_rel)
        .filter(|tail| tail.starts_with('/'))
        .map(|tail| format!("{new_rel}{tail}"))
}

// Rewrite (or insert) the `tema:` line inside the FIRST front-matter block.
// Handles both LF and CRLF openers, and keeps the file's own line ending on the
// line it rewrites or inserts. Pure, so the edge cases are unit-covered: a file
// with no front matter comes back untouched.
pub(crate) fn retema_front_matter(content: &str, new_tema: &str) -> String {
    let (opener, eol) = if content.starts_with("---\r\n") {
        ("---\r\n", "\r\n")
    } else if content.starts_with("---\n") {
        ("---\n", "\n")
    } else {
        return content.to_string();
    };
    let rest = &content[opener.len()..];
    let close = format!("{eol}---");
    let Some(end) = rest.find(&close) else {
        return content.to_string();
    };
    let (fm, tail) = rest.split_at(end);
    let mut lines: Vec<String> = fm.split(eol).map(|l| l.to_string()).collect();
    // `tema` is a TOP-LEVEL key. An indented `tema:` belongs to whatever mapping
    // it is nested in (a ref entry, say) — rewriting it would change the wrong
    // value and, re-emitted at column 0, break the block it lived in.
    match lines.iter().position(|l| l.starts_with("tema:")) {
        Some(i) => lines[i] = format!("tema: {new_tema}"),
        None => lines.push(format!("tema: {new_tema}")),
    }
    format!("{opener}{}{}", lines.join(eol), tail)
}

// Read the meeting manifest. Absent/corrupt is an error (never a silent default)
// so a caller never edits a phantom manifest.
fn manifest_read(dir: &Path) -> Result<Manifest, String> {
    let txt = std::fs::read_to_string(dir.join("manifest.json"))
        .map_err(|_| "err.manifest_not_found".to_string())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

// Atomic manifest write: serialize to a temp file then rename, so a reader never
// observes a partial file (ADR-0010 consequences). Callers hold the meeting lock.
fn manifest_write(dir: &Path, m: &Manifest) -> Result<(), String> {
    let body = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    let final_path = dir.join("manifest.json");
    let tmp = dir.join("manifest.json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())
}

// ---- pure helpers: names, front-matter, markers -----------------------------

// Living-file header: YAML front-matter (loro,id,tema,criado_em,audio:[],refs:[])
// + the title + the stable transcript marker appends land below.
fn living_header(id: &str, tema: &str, titulo: &str, criado_em: &str) -> String {
    format!(
        "---\nloro: 1\nid: {id}\ntema: {tema}\ncriado_em: {criado_em}\naudio: []\nrefs: []\n---\n\n# {titulo}\n\n{TRANSCRIPT_MARKER}\n"
    )
}

// Append a transcript/AI block below the stable marker (append-only). If the
// marker is somehow absent it is (re)created, so the tail is always defined.
fn append_below_marker(content: &str, chunk: &str) -> String {
    let mut out = content.trim_end().to_string();
    if !out.contains(TRANSCRIPT_MARKER) {
        out.push_str("\n\n");
        out.push_str(TRANSCRIPT_MARKER);
    }
    out.push_str("\n\n");
    out.push_str(chunk.trim_end());
    out.push('\n');
    out
}

// ADR-0013: each live block carries a hidden timecode comment so the transcript
// stays CHRONOLOGICAL across devices (mic = "você", system = "sistema" arrive out
// of order). The human label is [mm:ss · fonte]; the comment `<!-- loro:t=NNN -->`
// (an HTML comment the renderer hides) is the sort key.
const SEG_PREFIX: &str = "<!-- loro:t=";

fn src_label(src: Option<&str>) -> Option<&'static str> {
    match src {
        Some("mic") => Some("você"),
        Some("system") => Some("sistema"),
        _ => None,
    }
}

// Build one timed block: the hidden sort-key comment + a [mm:ss · fonte] label line
// + the text. Pure.
fn timed_block(t_ms: u64, src: Option<&str>, text: &str) -> String {
    let tc = fmt_timecode(Some(t_ms));
    let head = match src_label(src) {
        Some(l) => format!("[{tc} · {l}]"),
        None => format!("[{tc}]"),
    };
    format!("{SEG_PREFIX}{t_ms} -->\n{head} {}", text.trim())
}

// The sort key of a stored block (its `<!-- loro:t=NNN -->`); untimed blocks sink
// to the end (u64::MAX) so legacy/skill appends never scramble the timeline.
fn block_time(block: &str) -> u64 {
    block
        .lines()
        .find_map(|l| {
            l.trim()
                .strip_prefix(SEG_PREFIX)?
                .strip_suffix(" -->")?
                .trim()
                .parse()
                .ok()
        })
        .unwrap_or(u64::MAX)
}

// Insert a timed block below the marker, keeping blocks ordered by timecode
// (stable: equal times preserve arrival order). Pure — the living file is always
// chronologically sorted, so both the live surface and the built report read in
// conversation order.
fn insert_timed_block(content: &str, t_ms: u64, src: Option<&str>, text: &str) -> String {
    let base = if content.contains(TRANSCRIPT_MARKER) {
        content.trim_end().to_string()
    } else {
        format!("{}\n\n{TRANSCRIPT_MARKER}", content.trim_end())
    };
    let idx = base.find(TRANSCRIPT_MARKER).unwrap() + TRANSCRIPT_MARKER.len();
    let head = &base[..idx];
    let body = &base[idx..];

    // split the body into blocks, each starting at a SEG_PREFIX line
    let mut blocks: Vec<String> = Vec::new();
    for line in body.lines() {
        if line.trim_start().starts_with(SEG_PREFIX) {
            blocks.push(String::new());
        }
        if let Some(cur) = blocks.last_mut() {
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(line);
        }
    }
    let new_block = timed_block(t_ms, src, text);
    // stable insert: before the first existing block whose time is greater
    let pos = blocks
        .iter()
        .position(|b| block_time(b) > t_ms)
        .unwrap_or(blocks.len());
    blocks.insert(pos, new_block);

    let mut out = head.to_string();
    for b in &blocks {
        out.push_str("\n\n");
        out.push_str(b.trim());
    }
    out.push('\n');
    out
}

fn valid_tipo(tipo: &str) -> bool {
    MARKER_TIPOS.contains(&tipo)
}

// ADR-0013: the meeting-AI skills can't touch manifest.json (the app owns the
// atomic writer), so they append PII-free markers to a `marcadores.jsonl` sidecar
// which the app FOLDS into the manifest at build time. Pure: parse each JSONL line
// as a Marker, keep only known `tipo`s (BR-8: a text field would never parse into
// Marker — only tipo/t_ms/ref exist), and append them to the existing markers.
fn fold_markers(existing: &[Marker], lines: &str) -> Vec<Marker> {
    let mut out = existing.to_vec();
    for line in lines.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Ok(mk) = serde_json::from_str::<Marker>(t) {
            if valid_tipo(&mk.tipo) {
                out.push(mk);
            }
        }
    }
    out
}

// Read `<dir>/marcadores.jsonl` (if any) and return the manifest markers folded
// with it. Idempotency is the caller's concern (the sidecar is consumed/cleared
// after a successful fold so a re-run does not double-count).
fn fold_markers_file(dir: &Path, existing: &[Marker]) -> Vec<Marker> {
    match std::fs::read_to_string(dir.join("marcadores.jsonl")) {
        Ok(lines) => fold_markers(existing, &lines),
        Err(_) => existing.to_vec(),
    }
}

fn valid_kind(kind: &str) -> bool {
    ARTIFACT_KINDS.contains(&kind)
}

// Sanitize an artifact filename to `<slug>.<ext>` ([a-z0-9-] stem, alnum ext) so
// the write can never traverse out of artefatos/<kind>/.
fn safe_artifact_name(name: &str) -> Result<String, String> {
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let slug = sanitize_slug(stem)?;
    if ext.is_empty() {
        return Ok(slug);
    }
    let e: String = ext
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if e.is_empty() {
        Ok(slug)
    } else {
        Ok(format!("{slug}.{e}"))
    }
}

fn fmt_timecode(t_ms: Option<u64>) -> String {
    match t_ms {
        Some(ms) => {
            let s = ms / 1000;
            format!("{:02}:{:02}", s / 60, s % 60)
        }
        None => "--:--".into(),
    }
}

// ---- notebook assembler (pure) ----------------------------------------------

// ---- meeting creation (fs, testable with a temp dir) ------------------------

pub struct Created {
    id: String,
    dir: PathBuf,
    living_rel: String,
}

// Scaffold the meeting home + manifest(status:recording) + reuniao.md header. No
// audio here (that reuses ADR-0005 in the command). Pure w.r.t. the injected
// clock/cfg so it is unit-tested against a temp acervo base.
#[allow(clippy::too_many_arguments)]
fn create_meeting(
    base: &Path,
    tema: &str,
    titulo: Option<&str>,
    dir_stamp: &str,
    iso: &str,
    modelo: &str,
    idioma: &str,
) -> Result<Created, String> {
    let tema_slug = sanitize_slug(tema)?;
    let titulo = titulo.map(str::trim).filter(|t| !t.is_empty());
    let title_slug = sanitize_slug(titulo.unwrap_or("reuniao"))?;
    let titulo_display = titulo.unwrap_or("Reunião").to_string();
    let id = format!("{dir_stamp}-{title_slug}");

    // ADR-0013: meetings live under the flat brainstorming/<slug>/reunioes/ tree.
    let dir = base
        .join("brainstorming")
        .join(&tema_slug)
        .join("reunioes")
        .join(&id);
    if dir.exists() {
        return Err("err.meeting_id_exists".into());
    }
    std::fs::create_dir_all(dir.join("audio")).map_err(|e| e.to_string())?;
    for k in ARTIFACT_KINDS {
        std::fs::create_dir_all(dir.join("artefatos").join(k)).map_err(|e| e.to_string())?;
    }

    let header = living_header(&id, &tema_slug, &titulo_display, iso);
    std::fs::write(dir.join("reuniao.md"), header).map_err(|e| e.to_string())?;

    let manifest = Manifest {
        id: id.clone(),
        tema: tema_slug,
        titulo: titulo_display,
        criado_em: iso.to_string(),
        atualizado_em: iso.to_string(),
        status: "recording".into(),
        modelo: modelo.to_string(),
        idioma: idioma.to_string(),
        ..Default::default()
    };
    manifest_write(&dir, &manifest)?;

    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    if !dir.starts_with(base) {
        return Err("err.outside_acervo".into());
    }
    let living_rel = format!("{}/reuniao.md", rel_of(base, &dir));
    Ok(Created {
        id,
        dir,
        living_rel,
    })
}

// ---- Tauri commands ---------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStartInput {
    tema: String,
    #[serde(default)]
    titulo: Option<String>,
    #[serde(default)]
    cfg: Option<crate::StartCfg>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStart {
    id: String,
    dir: String,
    living_rel: String,
}

// Create the meeting home + manifest(recording) + reuniao.md and start the
// ScreenCaptureKit sidecar into system audio by REUSING ADR-0005
// start_system_capture (its WAV is moved into audio/system.wav on stop). Capture
// is attempted first so a permission denial leaves no orphan meeting on disk.
#[tauri::command]
pub fn brain_meeting_start(
    app: AppHandle,
    state: State<AppState>,
    input: MeetingStartInput,
) -> Result<MeetingStart, String> {
    let base = acervo_base()?;
    let (modelo, idioma) = input
        .cfg
        .as_ref()
        .map(|c| (c.model.clone(), c.lang.clone()))
        .unwrap_or_default();

    let (dir_stamp, iso) = now_stamp_iso();
    let created = create_meeting(
        &base,
        &input.tema,
        input.titulo.as_deref(),
        &dir_stamp,
        &iso,
        &modelo,
        &idioma,
    )?;

    // ADR-0005 sidecar: fails fast on a Screen Recording denial — clean up the
    // just-scaffolded meeting so a denial leaves no orphan on disk.
    let sys_wav = match crate::system_capture_start(&app, &state) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&created.dir);
            return Err(e);
        }
    };

    syscap_pending()
        .lock()
        .unwrap()
        .insert(created.id.clone(), vec![PathBuf::from(&sys_wav)]);

    // A reunião também é uma gravação: sem isto o ícone da bandeja não piscava
    // durante uma reunião — só a gravação avulsa (que passa por `start`) o fazia.
    crate::set_tray_recording(&state, true);

    let dir_rel = rel_of(&base, &created.dir);
    let tema_slug = sanitize_slug(&input.tema).unwrap_or_default();
    let _ = app.emit("tema-changed", serde_json::json!({ "slug": tema_slug }));
    let _ = app.emit("pessoal-changed", serde_json::json!({ "rel": dir_rel }));

    Ok(MeetingStart {
        id: created.id,
        dir: dir_rel,
        living_rel: created.living_rel,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStopInput {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStop {
    living_rel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    completo_rel: Option<String>,
}

// Close the sidecar (REUSE stop_system_capture), keep the tracks as
// audio/{system.wav,mic.webm}, MIX them into audio/completo.wav (REUSE
// mix_to_wav; degrades if one is absent) and set status:transcribing. It does NOT
// transcribe: transcribe_wav emits the global transcript-line and returns no text
// (ADR-0010) — the frontend persists lines via brain_meeting_append.
#[tauri::command]
pub fn brain_meeting_stop(
    app: AppHandle,
    state: State<AppState>,
    input: MeetingStopInput,
) -> Result<MeetingStop, String> {
    let base = acervo_base()?;
    let dir = resolve_meeting_dir(&base, &input.id)?;

    crate::system_capture_stop(&state);

    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let mut manifest = manifest_read(&dir)?;

    // ADR-0012 model A + ADR-0013: the transcript was already built live from the
    // rotated mic segments + system tail windows — there is NO separate full-audio
    // pass. Audio is transient and purged right after (brain_meeting_purge_audio),
    // so we DO NOT mix here: the old ffmpeg mix_to_wav was wasted work that could
    // block the stop flow (the app froze when the live loop closed). We just move
    // the finalized system WAV into the meeting so purge can clean it, and mark the
    // meeting as transcribing.
    if let Some(srcs) = syscap_pending().lock().unwrap().remove(&input.id) {
        for (i, src) in srcs.iter().enumerate() {
            if src.is_file() {
                let _ = move_file(src, &dir.join("audio").join(system_segment_name(i)));
            }
        }
    }
    crate::set_tray_recording(&state, false);

    manifest.status = "transcribing".into();
    manifest.atualizado_em = now_iso();
    manifest_write(&dir, &manifest)?;

    let living_rel = format!("{}/reuniao.md", rel_of(&base, &dir));
    let _ = app.emit("pessoal-changed", serde_json::json!({ "rel": living_rel }));
    Ok(MeetingStop {
        living_rel,
        completo_rel: None,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAppendInput {
    id: String,
    chunk: String,
    // ADR-0013: optional timecode (ms from meeting start) + source (mic|system) so
    // the live transcript stays chronological across devices. Absent → appended at
    // the tail (skills / legacy).
    #[serde(default)]
    t_ms: Option<u64>,
    #[serde(default)]
    source: Option<String>,
}

// Append a transcript/AI block below the stable marker in reuniao.md (append-only)
// and bump the manifest atomically. This is the boundary the deferred pseudo-stream
// (ADR-0010) will reuse.
#[tauri::command]
pub fn brain_meeting_append(app: AppHandle, input: MeetingAppendInput) -> Result<(), String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &input.id)?;

    let living = dir.join("reuniao.md");
    let content = std::fs::read_to_string(&living).map_err(|e| e.to_string())?;
    // ADR-0013: a timecoded chunk is inserted in chronological order (mic + system
    // interleave correctly); an untimed one (skills/legacy) appends at the tail.
    let updated = match input.t_ms {
        Some(t) => insert_timed_block(&content, t, input.source.as_deref(), &input.chunk),
        None => append_below_marker(&content, &input.chunk),
    };
    std::fs::write(&living, &updated).map_err(|e| e.to_string())?;

    let mut manifest = manifest_read(&dir)?;
    manifest.atualizado_em = now_iso();
    manifest_write(&dir, &manifest)?;

    let living_rel = format!("{}/reuniao.md", rel_of(&base, &dir));
    let bytes = input.chunk.len();
    let _ = app.emit(
        "meeting-appended",
        serde_json::json!({ "meetingRel": living_rel, "bytes": bytes }),
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactInput {
    id: String,
    kind: String,
    name: String,
    content: String,
    #[serde(default)]
    refs: Option<Vec<String>>,
    #[serde(default)]
    cloud: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactOut {
    rel: String,
    id: String,
}

// Write an artifact into artefatos/<kind>/ and record it in manifest.artifacts[].
// Path-guarded to the meeting dir (kind + sanitized name). May carry JSON/txt/svg
// text bytes (guarded — bypasses the .md/.txt-only rule safely, ADR-0010).
#[tauri::command]
pub fn brain_meeting_write_artifact(
    app: AppHandle,
    input: WriteArtifactInput,
) -> Result<WriteArtifactOut, String> {
    if !valid_kind(&input.kind) {
        return Err("err.invalid_artifact_type".into());
    }
    let name = safe_artifact_name(&input.name)?;
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &input.id)?;

    let kind_dir = dir.join("artefatos").join(&input.kind);
    std::fs::create_dir_all(&kind_dir).map_err(|e| e.to_string())?;
    let path = kind_dir.join(&name);
    // Final guard: the resolved parent must stay inside the meeting dir.
    if !path.starts_with(&dir) {
        return Err("err.outside_meeting".into());
    }
    std::fs::write(&path, input.content.as_bytes()).map_err(|e| e.to_string())?;

    let mut manifest = manifest_read(&dir)?;
    let art_id = format!("a{}", manifest.artifacts.len() + 1);
    let rel = rel_of(&base, &path);
    manifest.artifacts.push(Artifact {
        id: art_id.clone(),
        kind: input.kind,
        name,
        rel: rel.clone(),
        refs: input.refs.unwrap_or_default(),
        cloud: input.cloud.unwrap_or(false),
        em: now_iso(),
    });
    manifest.atualizado_em = now_iso();
    manifest_write(&dir, &manifest)?;

    let _ = app.emit("pessoal-changed", serde_json::json!({ "rel": rel }));
    Ok(WriteArtifactOut { rel, id: art_id })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPauseInput {
    id: String,
}

// Pausar é PARAR de capturar — o sidecar morre e nada entra no disco enquanto
// a pausa dura. A alternativa (seguir capturando e só esconder o texto) diria ao
// usuário que a reunião parou enquanto ela continuava sendo gravada.
//
// O trecho que estava sendo escrito continua na lista: a última janela dele
// ainda vai ser transcrita pelo frontend antes de a pausa valer.
#[tauri::command]
pub fn brain_meeting_pause(state: State<AppState>, input: MeetingPauseInput) -> Result<(), String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    resolve_meeting_dir(&base, &input.id)?;
    if !syscap_pending().lock().unwrap().contains_key(&input.id) {
        return Err("err.meeting_not_recording".into());
    }
    crate::system_capture_stop(&state);
    crate::set_tray_recording(&state, false);
    Ok(())
}

// Continuar abre um NOVO trecho de captura. O relógio da reunião (dono do
// frontend) desconta a pausa, e o novo trecho começa em `tailBase` — as duas
// linhas do tempo (microfone e sistema) excluem a pausa do mesmo jeito, então
// continuam alinhadas.
#[tauri::command]
pub fn brain_meeting_resume(
    app: AppHandle,
    state: State<AppState>,
    input: MeetingPauseInput,
) -> Result<(), String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    resolve_meeting_dir(&base, &input.id)?;
    let sys_wav = crate::system_capture_start(&app, &state)?;
    syscap_pending()
        .lock()
        .unwrap()
        .entry(input.id.clone())
        .or_default()
        .push(PathBuf::from(&sys_wav));
    crate::set_tray_recording(&state, true);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerInput {
    id: String,
    tipo: String,
    t_ms: u64,
    #[serde(default)]
    r#ref: Option<String>,
}

// Append a PII-FREE marker (type + timecode + optional ref) to
// manifest.marcadores. Rejects an unknown type; NEVER stores transcript text
// (BR-8) — the struct has no text field by construction.
#[tauri::command]
pub fn brain_meeting_marker(input: MarkerInput) -> Result<(), String> {
    if !valid_tipo(&input.tipo) {
        return Err("err.invalid_marker_type".into());
    }
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &input.id)?;

    let mut manifest = manifest_read(&dir)?;
    manifest.marcadores.push(Marker {
        tipo: input.tipo,
        t_ms: Some(input.t_ms),
        r#ref: input.r#ref,
    });
    manifest.atualizado_em = now_iso();
    manifest_write(&dir, &manifest)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentInput {
    id: String,
    cloud: bool,
    mcp: bool,
}

// Record per-meeting consent (DEFAULT OFF) into manifest.consent plus an
// event-oriented, PII-free audit line in the meeting's auditoria.jsonl (local,
// never versioned/shared). This is the v1 CONTRACT LOCK for ADR-0011.
#[tauri::command]
pub fn brain_meeting_set_consent(input: ConsentInput) -> Result<Consent, String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &input.id)?;

    let mut manifest = manifest_read(&dir)?;
    manifest.consent = Consent {
        cloud: input.cloud,
        mcp: input.mcp,
    };
    manifest.atualizado_em = now_iso();
    manifest_write(&dir, &manifest)?;

    append_audit(
        &dir,
        &serde_json::json!({
            "em": now_iso(),
            "event": "consent-set",
            "cloud": input.cloud,
            "mcp": input.mcp,
        }),
    )?;
    Ok(manifest.consent)
}

// Append one JSON event line to the meeting's local audit (ADR-0011 two-tier
// logging). Event-oriented and PII-free (BR-8); stays under pessoal/ (quarantined).
fn append_audit(dir: &Path, event: &serde_json::Value) -> Result<(), String> {
    let path = dir.join("auditoria.jsonl");
    let mut cur = std::fs::read_to_string(&path).unwrap_or_default();
    cur.push_str(&event.to_string());
    cur.push('\n');
    std::fs::write(&path, cur).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn brain_meeting_manifest(id: String) -> Result<Manifest, String> {
    let base = acervo_base()?;
    let dir = resolve_meeting_dir(&base, &id)?;
    manifest_read(&dir)
}

// Replace the living file's title heading (the first `# ` line after the
// front-matter) keeping everything else — transcript, markers — intact. Pure.
fn replace_title_heading(md: &str, titulo: &str) -> String {
    let mut out = Vec::new();
    let mut fm_delims = 0usize;
    let mut replaced = false;
    for line in md.lines() {
        let in_front_matter = fm_delims < 2 && (line.trim() == "---" || fm_delims == 1);
        if line.trim() == "---" && fm_delims < 2 {
            fm_delims += 1;
        }
        if !replaced && !in_front_matter && line.starts_with("# ") {
            out.push(format!("# {titulo}"));
            replaced = true;
            continue;
        }
        out.push(line.to_string());
    }
    let mut s = out.join("\n");
    if md.ends_with('\n') {
        s.push('\n');
    }
    s
}

// Rename a meeting: manifest `titulo` + the living file's heading. The folder id
// stays stable on purpose — open tabs, artefatos/ and auditoria.jsonl paths keep
// working; only the display title changes.
fn rename_meeting(dir: &Path, titulo: &str) -> Result<Manifest, String> {
    let t = titulo.trim();
    if t.is_empty() {
        return Err("err.title_required".into());
    }
    let mut m = manifest_read(dir)?;
    m.titulo = t.to_string();
    m.atualizado_em = now_iso();
    manifest_write(dir, &m)?;
    let living = dir.join("reuniao.md");
    if let Ok(txt) = std::fs::read_to_string(&living) {
        std::fs::write(&living, replace_title_heading(&txt, t)).map_err(|e| e.to_string())?;
    }
    Ok(m)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRenameInput {
    id: String,
    titulo: String,
}

#[tauri::command]
pub fn brain_meeting_rename(app: AppHandle, input: MeetingRenameInput) -> Result<Manifest, String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let manifest = rename_meeting(&dir, &input.titulo)?;
    let _ = app.emit(
        "pessoal-changed",
        serde_json::json!({ "rel": rel_of(&base, &dir) }),
    );
    Ok(manifest)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishOut {
    rel: String,
}

// ADR-0018 — close a meeting: `status: "done"`, and nothing is authored. The
// report this command used to assemble is gone; the meeting's output is the
// analysis in `notas/`, written by the habilidade when the USER asks for it.
//
// `done` is what enables **analisar** and **enviar para a fila** in the `⋯` menu,
// so it stays exactly as it was — it simply stopped being a side effect of
// building a document.
//
// ADR-0013's sidecar incorporation SURVIVES here: folding `marcadores.jsonl` into
// the manifest was never about the report, and the app remains the only writer of
// `manifest.json`. Its reach is unchanged too — the fold happens when the
// recording ends, so markers a habilidade appends later stay in the sidecar,
// which is where ADR-0013 keeps them anyway.
//
// Returns the rel of `reuniao.md`: the transcript is what the user gets back.
#[tauri::command]
pub fn brain_meeting_finish(app: AppHandle, id: String) -> Result<FinishOut, String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &id)?;

    let mut manifest = manifest_read(&dir)?;
    let sidecar = dir.join("marcadores.jsonl");
    if sidecar.is_file() {
        manifest.marcadores = fold_markers_file(&dir, &manifest.marcadores);
        let _ = std::fs::remove_file(&sidecar);
    }

    manifest.status = "done".into();
    manifest.atualizado_em = now_iso();
    manifest_write(&dir, &manifest)?;

    let rel = format!("{}/reuniao.md", rel_of(&base, &dir));
    let _ = app.emit("brainstorming-changed", serde_json::json!({ "rel": rel }));
    let _ = app.emit("pessoal-changed", serde_json::json!({ "rel": rel }));
    Ok(FinishOut { rel })
}

// ---- audio management (ADR-0010: audio must be manageable/deletable) --------

// Map a track selector to its fixed on-disk filename. The whitelist is the guard:
// only these three literals ever become a path, so no `which` value can traverse
// out of the meeting's audio/ dir.
fn audio_filename(which: &str) -> Result<&'static str, String> {
    match which {
        "mic" => Ok("mic.webm"),
        "system" => Ok("system.wav"),
        "completo" => Ok("completo.wav"),
        _ => Err("err.invalid_audio_track".into()),
    }
}

// Delete a meeting audio track and clear its manifest key, atomically. BR-1 keeps
// audio local; deleting it never leaves a dangling manifest reference. A no-op if
// the file is already gone (the key is still cleared). Path-guarded to audio/.
fn delete_audio_core(dir: &Path, which: &str) -> Result<Manifest, String> {
    let file = audio_filename(which)?;
    let audio_dir = dir.join("audio");
    let path = audio_dir.join(file);
    if !path.starts_with(&audio_dir) {
        return Err("err.outside_meeting".into());
    }
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let mut manifest = manifest_read(dir)?;
    match which {
        "mic" => manifest.audio.mic = None,
        "system" => manifest.audio.system = None,
        "completo" => manifest.audio.completo = None,
        _ => unreachable!("whitelisted by audio_filename"),
    }
    manifest.atualizado_em = now_iso();
    manifest_write(dir, &manifest)?;
    Ok(manifest)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAudioInput {
    id: String,
    which: String,
}

// Delete one of a meeting's audio tracks (mic/system/completo) and return the
// updated manifest (ADR-0010). Serialized under the per-meeting lock like every
// other manifest write.
#[tauri::command]
pub fn brain_meeting_delete_audio(
    app: AppHandle,
    input: DeleteAudioInput,
) -> Result<Manifest, String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let manifest = delete_audio_core(&dir, &input.which)?;
    let _ = app.emit(
        "pessoal-changed",
        serde_json::json!({ "rel": rel_of(&base, &dir) }),
    );
    Ok(manifest)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeAudioInput {
    id: String,
}

// Owner decision (2026-07-27): meeting audio is TRANSIENT — never stored long-term.
// Deletes every track under the meeting's audio/ dir and clears all audio keys.
// The transcript (reuniao.md) and the analyses in notas/ are the durable
// artifacts; audio is only
// a means to it. Called after the authoritative stop-transcription. Idempotent.
fn purge_audio_core(dir: &Path) -> Result<Manifest, String> {
    let audio_dir = dir.join("audio");
    for file in ["mic.webm", "system.wav", "completo.wav"] {
        let path = audio_dir.join(file);
        if path.starts_with(&audio_dir) && path.is_file() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    // pause/resume segments (system-2.wav, system-3.wav, …): audio is transient
    // whatever its count — a resumed meeting must purge as clean as a plain one.
    if let Ok(entries) = std::fs::read_dir(&audio_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let transiente = (name.starts_with("system-") && name.ends_with(".wav"))
                || name.starts_with(".tail.snapshot."); // carve interrompido
            if transiente && entry.path().is_file() {
                std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
    }
    let mut manifest = manifest_read(dir)?;
    manifest.audio.mic = None;
    manifest.audio.system = None;
    manifest.audio.completo = None;
    manifest.atualizado_em = now_iso();
    manifest_write(dir, &manifest)?;
    Ok(manifest)
}

// Delete ALL of a meeting's audio (transient by owner decision) and return the
// updated manifest. Serialized under the per-meeting lock.
#[tauri::command]
pub fn brain_meeting_purge_audio(
    app: AppHandle,
    input: PurgeAudioInput,
) -> Result<Manifest, String> {
    let base = acervo_base()?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let manifest = purge_audio_core(&dir)?;
    let _ = app.emit(
        "pessoal-changed",
        serde_json::json!({ "rel": rel_of(&base, &dir) }),
    );
    Ok(manifest)
}

// ---- pseudo-stream tail (ADR-0010 promoted by ADR-0012) ---------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeTailInput {
    id: String,
    from_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeTail {
    text: String,
    next_ms: u64,
}

// BEST-EFFORT live preview of the system-audio tail (ADR-0012 promoted the
// ADR-0010 pseudo-stream). Snapshots the CONTINUOUSLY-WRITTEN system.wav (the
// syscap sidecar keeps appending to it) to a stable temp, measures its current
// end from the actual bytes, transcribes the window [fromMs, end] via
// transcribe_wav_window and returns the new text + the new offset. The FRONTEND
// drives the interval and persists lines via brain_meeting_append.
//
// This preview may be IMPERFECT at window edges; the authoritative mic+system
// mix+transcription at brain_meeting_stop stays the source of truth and
// reconciles it. No global transcript-line event is emitted here.
//
// ASSÍNCRONO por necessidade, não por estilo. Um `#[tauri::command]` síncrono roda
// na THREAD PRINCIPAL, e este aqui copia o WAV, corta com ffmpeg e transcreve com
// whisper — medido em 1,7s para uma janela de 18s de tom puro, e é o PISO: com
// fala de verdade demora mais, e o segmento de microfone faz o mesmo trabalho no
// mesmo instante. A cada 18 segundos a janela inteira congelava por segundos.
// Mesmo defeito, mesma cura do `env_doctor` (ADR-0022 §4).
#[tauri::command]
pub async fn brain_meeting_transcribe_tail(
    input: TranscribeTailInput,
) -> Result<TranscribeTail, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_tail_blocking(input))
        .await
        .map_err(|e| e.to_string())?
}

fn transcribe_tail_blocking(input: TranscribeTailInput) -> Result<TranscribeTail, String> {
    let base = acervo_base()?;
    let dir = resolve_meeting_dir(&base, &input.id)?;

    // The live source is the syscap sidecar's WAV while recording; after stop it
    // is the finalized audio/system.wav.
    // The LIVE segment is the last one: after a pause/resume the earlier segments
    // are already fully transcribed, and the frontend rebases its window offset
    // to the new segment (`tailBase`), so reading anything but the last would
    // replay audio that is already in the transcript.
    let src = syscap_pending()
        .lock()
        .unwrap()
        .get(&input.id)
        .and_then(|v| v.last().cloned())
        .unwrap_or_else(|| dir.join("audio").join("system.wav"));
    let unchanged = TranscribeTail {
        text: String::new(),
        next_ms: input.from_ms,
    };
    if !src.is_file() {
        return Ok(unchanged);
    }

    // Snapshot so a growing file cannot shift under the carve. Stays under
    // pessoal/ (quarantined) and is removed right after.
    // Nome ÚNICO por chamada: com um caminho fixo, duas janelas concorrentes
    // (pausar logo depois de um tick, por exemplo) copiavam por cima uma da
    // outra e a primeira a terminar apagava o arquivo debaixo da segunda.
    let snap = dir.join("audio").join(format!(
        ".tail.snapshot.{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::copy(&src, &snap).map_err(|e| e.to_string())?;
    let end_ms = std::fs::read(&snap)
        .ok()
        .and_then(|b| crate::wav_duration_ms_from_bytes(&b))
        .unwrap_or(0);
    if end_ms <= input.from_ms {
        let _ = std::fs::remove_file(&snap);
        return Ok(unchanged);
    }

    let manifest = manifest_read(&dir)?;
    if manifest.modelo.is_empty() {
        let _ = std::fs::remove_file(&snap);
        return Err("err.live_model_unavailable".into());
    }
    let ffmpeg = which("ffmpeg").ok_or_else(ffmpeg_not_found_err)?;
    let cli = crate::paths::whisper_cli_bin();
    let model = crate::paths::model_path(&manifest.modelo);
    let lang = if manifest.idioma.is_empty() {
        "auto"
    } else {
        &manifest.idioma
    };
    let segments = crate::transcribe_wav_window(
        &PathBuf::from(ffmpeg),
        &snap,
        &cli,
        &model,
        lang,
        false,
        "8",
        input.from_ms,
        Some(end_ms),
    );
    let _ = std::fs::remove_file(&snap);
    Ok(TranscribeTail {
        text: segments?.join(" "),
        next_ms: end_ms,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeSegmentInput {
    id: String,
    data: Vec<u8>,
}

#[derive(Serialize)]
pub struct TranscribeSegment {
    text: String,
}

// ADR-0012 pseudo-stream (model A — the live preview IS the transcript): the
// frontend rotates a mic MediaRecorder and hands each complete segment here as
// bytes. We write it to a transient temp under the (quarantined) meeting dir,
// transcribe the WHOLE segment, delete the temp, and return the text — audio is
// never stored (owner decision). The frontend filters hallucinations and appends.
// Mesma razão do tail acima: escreve um temporário, roda ffmpeg e whisper. Os
// dois disparam no MESMO tique de 18s, então somavam o congelamento.
#[tauri::command]
pub async fn brain_meeting_transcribe_segment(
    input: TranscribeSegmentInput,
) -> Result<TranscribeSegment, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_segment_blocking(input))
        .await
        .map_err(|e| e.to_string())?
}

fn transcribe_segment_blocking(input: TranscribeSegmentInput) -> Result<TranscribeSegment, String> {
    let base = acervo_base()?;
    let dir = resolve_meeting_dir(&base, &input.id)?;
    if input.data.is_empty() {
        return Ok(TranscribeSegment {
            text: String::new(),
        });
    }
    let manifest = manifest_read(&dir)?;
    if manifest.modelo.is_empty() {
        return Err("err.live_model_unavailable".into());
    }
    let audio_dir = dir.join("audio");
    std::fs::create_dir_all(&audio_dir).map_err(|e| e.to_string())?;
    let seg = audio_dir.join(".seg.webm");
    std::fs::write(&seg, &input.data).map_err(|e| e.to_string())?;
    let ffmpeg = which("ffmpeg").ok_or_else(ffmpeg_not_found_err)?;
    let cli = crate::paths::whisper_cli_bin();
    let model = crate::paths::model_path(&manifest.modelo);
    let lang = if manifest.idioma.is_empty() {
        "auto"
    } else {
        &manifest.idioma
    };
    // Whole segment: window [0, None] carves the entire file (ffmpeg reads webm).
    let segments = crate::transcribe_wav_window(
        &PathBuf::from(ffmpeg),
        &seg,
        &cli,
        &model,
        lang,
        false,
        "8",
        0,
        None,
    );
    let _ = std::fs::remove_file(&seg);
    Ok(TranscribeSegment {
        text: segments?.join(" "),
    })
}

// Move a file, falling back to copy+remove across filesystems.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "loro-meeting-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn seed(base: &Path) -> Created {
        create_meeting(
            base,
            "Frota 2026!",
            Some("Semanal de custos"),
            "2026-07-27-1430",
            "2026-07-27T14:30:00Z",
            "large-v3-turbo",
            "pt",
        )
        .unwrap()
    }

    #[test]
    fn create_meeting_scaffolds_tree_and_recording_manifest() {
        let base = tmp("create");
        let c = seed(&base);
        assert_eq!(c.id, "2026-07-27-1430-semanal-de-custos");
        let dir = base.join("brainstorming/frota-2026/reunioes/2026-07-27-1430-semanal-de-custos");
        assert!(dir.join("audio").is_dir());
        for k in ARTIFACT_KINDS {
            assert!(dir.join("artefatos").join(k).is_dir());
        }
        // living file header: front-matter + title + stable marker
        let living = std::fs::read_to_string(dir.join("reuniao.md")).unwrap();
        assert!(living.starts_with("---\nloro: 1\n"));
        assert!(living.contains("id: 2026-07-27-1430-semanal-de-custos"));
        assert!(living.contains("tema: frota-2026"));
        assert!(living.contains("audio: []"));
        assert!(living.contains(TRANSCRIPT_MARKER));
        // manifest: status recording, cfg captured, consent OFF by default
        let m = manifest_read(&dir).unwrap();
        assert_eq!(m.status, "recording");
        assert_eq!(m.tema, "frota-2026");
        assert_eq!(m.modelo, "large-v3-turbo");
        assert_eq!(m.idioma, "pt");
        assert!(!m.consent.cloud && !m.consent.mcp);
        // the meeting lives under brainstorming/ (the gitignore quarantine covers it)
        assert!(c.living_rel.starts_with("brainstorming/"));
    }

    #[test]
    fn rename_meeting_updates_titulo_in_manifest_and_heading() {
        let base = tmp("rename");
        let c = seed(&base);
        append_one(&c.dir, "[00:00] fala preservada").unwrap();
        let m = rename_meeting(&c.dir, "  Custos da frota — revisão  ").unwrap();
        assert_eq!(m.titulo, "Custos da frota — revisão");
        // id/folder untouched: open tabs and artefatos keep resolving
        assert_eq!(m.id, c.id);
        assert!(c.dir.join("manifest.json").is_file());
        let living = std::fs::read_to_string(c.dir.join("reuniao.md")).unwrap();
        assert!(living.contains("# Custos da frota — revisão"));
        assert!(!living.contains("# Semanal de custos"));
        // transcript and front-matter survive the heading swap
        assert!(living.contains("[00:00] fala preservada"));
        assert!(living.starts_with("---\nloro: 1\n"));
        // empty titles are refused (never a blank heading)
        assert!(rename_meeting(&c.dir, "   ").is_err());
    }

    #[test]
    fn replace_title_heading_ignores_front_matter_and_body_headings() {
        // only the FIRST body `# ` line is the title; later `# ` lines (e.g. a
        // pasted transcript heading) stay untouched
        let md = "---\nid: x\n---\n\n# Velho\n\ntexto\n# Não sou título\n";
        let out = replace_title_heading(md, "Novo");
        assert!(out.contains("# Novo"));
        assert!(!out.contains("# Velho"));
        assert!(out.contains("# Não sou título"));
    }

    #[test]
    fn insert_timed_block_orders_speech_chronologically_across_devices() {
        // ADR-0013: mic ("você") and system ("sistema") arrive out of order; the
        // living file must read in conversation order (by timecode), not arrival.
        let header = living_header("i", "t", "T", "2026-07-27T00:00:00Z");
        // arrive: system@10s, then mic@2s, then system@6s
        let a = insert_timed_block(&header, 10_000, Some("system"), "participante fala");
        let b = insert_timed_block(&a, 2_000, Some("mic"), "operador abre");
        let c = insert_timed_block(&b, 6_000, Some("system"), "participante responde");
        let body = c.split(TRANSCRIPT_MARKER).nth(1).unwrap();
        let i_op = body.find("operador abre").unwrap();
        let i_resp = body.find("participante responde").unwrap();
        let i_fala = body.find("participante fala").unwrap();
        // chronological: 2s < 6s < 10s regardless of arrival order
        assert!(
            i_op < i_resp && i_resp < i_fala,
            "falas fora de ordem cronológica"
        );
        // human labels carry the source; the sort-key comment is present (hidden)
        assert!(body.contains("[00:02 · você]"));
        assert!(body.contains("[00:06 · sistema]"));
        assert!(body.contains("<!-- loro:t=10000 -->"));
        // an untimed append (skill/legacy) sinks to the end, never scrambling
        let d = append_below_marker(&c, "nota do skill");
        let body2 = d.split(TRANSCRIPT_MARKER).nth(1).unwrap();
        assert!(body2.rfind("nota do skill").unwrap() > body2.find("participante fala").unwrap());
    }

    #[test]
    fn append_writes_below_marker_and_manifest_stays_valid() {
        // pure edit lands the chunk after the stable marker
        let header = living_header("i", "t", "T", "2026-07-27T00:00:00Z");
        let once = append_below_marker(&header, "[00:00] olá");
        let (before, after) = once.split_once(TRANSCRIPT_MARKER).unwrap();
        assert!(!before.contains("olá"));
        assert!(after.contains("[00:00] olá"));
        // a second append accretes; both survive, marker not duplicated
        let twice = append_below_marker(&once, "[00:01] tudo bem");
        assert!(twice.contains("[00:00] olá") && twice.contains("[00:01] tudo bem"));
        assert_eq!(twice.matches(TRANSCRIPT_MARKER).count(), 1);

        // fs path: manifest is rewritten atomically and always parses
        let base = tmp("append");
        let c = seed(&base);
        let before_at = manifest_read(&c.dir).unwrap().atualizado_em;
        std::thread::sleep(std::time::Duration::from_millis(1100));
        append_one(&c.dir, "[00:00] linha").unwrap();
        let living = std::fs::read_to_string(c.dir.join("reuniao.md")).unwrap();
        assert!(living
            .split(TRANSCRIPT_MARKER)
            .nth(1)
            .unwrap()
            .contains("[00:00] linha"));
        let m = manifest_read(&c.dir).unwrap(); // parses => not partial
        assert_ne!(m.atualizado_em, before_at); // bumped
        assert!(!c.dir.join("manifest.json.tmp").exists()); // temp renamed away
    }

    // Small fs helper mirroring brain_meeting_append without the AppHandle/emit.
    fn append_one(dir: &Path, chunk: &str) -> Result<(), String> {
        let living = dir.join("reuniao.md");
        let content = std::fs::read_to_string(&living).map_err(|e| e.to_string())?;
        std::fs::write(&living, append_below_marker(&content, chunk)).map_err(|e| e.to_string())?;
        let mut m = manifest_read(dir)?;
        m.atualizado_em = now_iso();
        manifest_write(dir, &m)
    }

    #[test]
    fn fold_marcadores_folds_sidecar_and_rejects_bad_tipo_and_text() {
        // ADR-0013: skills append PII-free markers to marcadores.jsonl; the app
        // folds them into the manifest markers. Unknown tipo dropped; a line with a
        // text field never parses into a Marker (BR-8) — so it is ignored.
        let existing = vec![Marker {
            tipo: "duvida".into(),
            t_ms: None,
            r#ref: None,
        }];
        let lines = "\
{\"tipo\":\"decisao\",\"ref\":\"artefatos/investigacoes/a.md\"}\n\
{\"tipo\":\"investigacao\",\"tMs\":1200}\n\
{\"tipo\":\"segredo\"}\n\
\n\
{\"tipo\":\"pergunta\",\"texto\":\"dado sensível de cliente\"}\n";
        let folded = fold_markers(&existing, lines);
        // 1 existing + decisao + investigacao + pergunta = 4 (segredo rejected)
        let tipos: Vec<&str> = folded.iter().map(|m| m.tipo.as_str()).collect();
        assert_eq!(tipos, vec!["duvida", "decisao", "investigacao", "pergunta"]);
        // the marker carrying a "texto" field still parsed only its known fields —
        // no marker ever stores transcript text
        let json = serde_json::to_string(&folded[3]).unwrap();
        assert!(!json.contains("texto") && !json.contains("sensível"));
    }

    #[test]
    fn marker_rejects_unknown_tipo_and_never_stores_text() {
        assert!(valid_tipo("duvida") && valid_tipo("decisao"));
        assert!(valid_tipo("investigacao") && valid_tipo("pergunta"));
        assert!(!valid_tipo("segredo") && !valid_tipo(""));
        // BR-8: a marker serializes to type/timecode/ref only — no text field
        let mk = Marker {
            tipo: "duvida".into(),
            t_ms: Some(1500),
            r#ref: None,
        };
        let json = serde_json::to_string(&mk).unwrap();
        assert_eq!(json, r#"{"tipo":"duvida","tMs":1500}"#);
        assert!(!json.contains("text") && !json.contains("texto"));
    }

    #[test]
    fn set_consent_defaults_off_and_writes_clean_audit_line() {
        let base = tmp("consent");
        let c = seed(&base);
        // default OFF straight from create
        let m = manifest_read(&c.dir).unwrap();
        assert!(!m.consent.cloud && !m.consent.mcp);
        // turning cloud on records consent + a PII-free audit event
        let mut m = manifest_read(&c.dir).unwrap();
        m.consent = Consent {
            cloud: true,
            mcp: false,
        };
        manifest_write(&c.dir, &m).unwrap();
        append_audit(
            &c.dir,
            &serde_json::json!({"em":"2026-07-27T14:31:00Z","event":"consent-set","cloud":true,"mcp":false}),
        )
        .unwrap();
        let audit = std::fs::read_to_string(c.dir.join("auditoria.jsonl")).unwrap();
        assert!(audit.contains("\"event\":\"consent-set\""));
        assert!(audit.contains("\"cloud\":true"));
        // BR-8: the audit event is structural only — no transcript/prose fields
        let v: serde_json::Value = serde_json::from_str(audit.trim()).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["cloud", "em", "event", "mcp"]);
    }

    #[test]
    fn write_artifact_records_in_manifest_under_kind_dir() {
        let base = tmp("artifact");
        let c = seed(&base);
        // simulate the command's core (no AppHandle): validate + write + record
        assert!(!valid_kind("../etc"));
        assert!(valid_kind("graficos"));
        let name = safe_artifact_name("Vendas 2026.svg").unwrap();
        assert_eq!(name, "vendas-2026.svg");
        let path = c.dir.join("artefatos").join("graficos").join(&name);
        std::fs::write(&path, "<svg/>").unwrap();
        let mut m = manifest_read(&c.dir).unwrap();
        m.artifacts.push(Artifact {
            id: "a1".into(),
            kind: "graficos".into(),
            name: name.clone(),
            rel: rel_of(&base, &path),
            refs: vec![],
            cloud: false,
            em: "2026-07-27T14:32:00Z".into(),
        });
        manifest_write(&c.dir, &m).unwrap();
        let m = manifest_read(&c.dir).unwrap();
        assert_eq!(m.artifacts.len(), 1);
        assert!(m.artifacts[0]
            .rel
            .contains("artefatos/graficos/vendas-2026.svg"));
    }

    // T-1 · T-2 · AC-1 (ADR-0018) — finishing a meeting sets `done` and authors
    // NOTHING. The report is gone: the meeting's output is the analysis the user
    // asks for, in `notas/`.
    #[test]
    fn finish_sets_status_done_and_writes_no_report() {
        let base = tmp("finish");
        let c = seed(&base);
        append_one(&c.dir, "[00:00] abertura").unwrap();

        // mirror brain_meeting_finish's core (no AppHandle)
        let mut m = manifest_read(&c.dir).unwrap();
        m.status = "done".into();
        manifest_write(&c.dir, &m).unwrap();

        assert_eq!(manifest_read(&c.dir).unwrap().status, "done");
        assert!(
            !c.dir.join("relatorio.md").exists(),
            "no report is ever authored"
        );
        // the transcript is untouched and remains the only place it lives
        assert!(std::fs::read_to_string(c.dir.join("reuniao.md"))
            .unwrap()
            .contains("[00:00] abertura"));
    }

    // T-2 — finishing adds no file to the meeting folder. The assembler and its
    // command are gone (that part is enforced by the compiler); what a test can
    // still catch is a future path quietly authoring a document again.
    #[test]
    fn finish_adds_no_file_to_the_meeting_folder() {
        let base = tmp("finish-nofile");
        let c = seed(&base);
        append_one(&c.dir, "[00:00] abertura").unwrap();
        let listar = || {
            let mut v: Vec<String> = std::fs::read_dir(&c.dir)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            v.sort();
            v
        };
        let antes = listar();

        let mut m = manifest_read(&c.dir).unwrap();
        m.status = "done".into();
        manifest_write(&c.dir, &m).unwrap();

        assert_eq!(listar(), antes, "finishing authors nothing");
    }

    #[test]
    fn resolve_meeting_dir_finds_by_id_and_refuses_bad_id() {
        let base = tmp("resolve");
        let c = seed(&base);
        let found = resolve_meeting_dir(&base, &c.id).unwrap();
        assert_eq!(found, c.dir);
        assert!(resolve_meeting_dir(&base, "../../etc").is_err());
        assert!(resolve_meeting_dir(&base, "nao/existe").is_err());
        assert!(resolve_meeting_dir(&base, "inexistente-2026").is_err());
    }

    #[test]
    fn delete_audio_removes_file_and_manifest_key_guarded() {
        let base = tmp("delaudio");
        let c = seed(&base);
        let audio = c.dir.join("audio");
        std::fs::write(audio.join("mic.webm"), b"webm").unwrap();
        std::fs::write(audio.join("system.wav"), b"RIFF").unwrap();
        let mut m = manifest_read(&c.dir).unwrap();
        m.audio.mic = Some(rel_of(&base, &audio.join("mic.webm")));
        m.audio.system = Some(rel_of(&base, &audio.join("system.wav")));
        manifest_write(&c.dir, &m).unwrap();

        // deleting mic removes the file AND clears the key; system is untouched
        let m = delete_audio_core(&c.dir, "mic").unwrap();
        assert!(!audio.join("mic.webm").exists());
        assert!(m.audio.mic.is_none());
        assert!(m.audio.system.is_some());
        assert!(audio.join("system.wav").exists());

        // no-op when the file is already gone (the key is still cleared, no error)
        let m = delete_audio_core(&c.dir, "mic").unwrap();
        assert!(m.audio.mic.is_none());

        // refuses an unknown track — the whitelist means no path outside the
        // meeting's audio/ dir can ever be constructed
        assert!(audio_filename("../../etc/passwd").is_err());
        assert!(delete_audio_core(&c.dir, "../etc").is_err());
        assert!(audio_filename("system").is_ok() && audio_filename("completo").is_ok());
    }

    #[test]
    fn the_marker_the_ui_actually_sends_is_accepted() {
        // ADR-0020 deixou UM tipo na interface; a lista aqui ficou com os quatro
        // antigos, então todo marcador era recusado. O teste amarra os dois lados.
        assert!(
            valid_tipo("momento"),
            "'momento' é o único tipo que a UI envia"
        );
        for legado in ["duvida", "decisao", "investigacao", "pergunta"] {
            assert!(
                valid_tipo(legado),
                "manifest anterior ao redesign tem {legado}"
            );
        }
        assert!(
            !valid_tipo("qualquer"),
            "tipo desconhecido continua recusado"
        );
    }

    // Terceira aparição da MESMA classe de bug: trabalho pesado dentro de um
    // `#[tauri::command]` síncrono, que roda na thread principal e congela a
    // janela. Foi o `env_doctor` (ADR-0022 §4) e foram estes dois, que disparam a
    // cada 18 segundos de gravação — o usuário relatou a aplicação travando "para
    // gerar o texto". Um comentário não impede a quarta; este teste impede.
    #[test]
    fn the_transcription_commands_never_run_on_the_main_thread() {
        let src = include_str!("meeting.rs");
        for cmd in [
            "brain_meeting_transcribe_tail",
            "brain_meeting_transcribe_segment",
        ] {
            let assinatura = format!("pub async fn {cmd}");
            assert!(
                src.contains(&assinatura),
                "{cmd} precisa ser async: ele roda ffmpeg + whisper (medido: 1,7s \
                 para uma janela de 18s de tom puro, e é o piso) a cada tique da \
                 gravação. Síncrono, isso congela a janela inteira."
            );
        }
        // O trabalho pesado tem de viver num núcleo separado, fora do comando.
        // As agulhas são MONTADAS: escritas por extenso, elas apareceriam neste
        // próprio arquivo e o teste passaria sozinho — foi o que aconteceu na
        // primeira versão, e só apareceu porque tentei fazê-lo falhar de verdade.
        for nucleo in ["transcribe_tail", "transcribe_segment"] {
            let agulha = format!("fn {nucleo}_{}", "blocking");
            assert!(
                src.contains(&agulha),
                "o núcleo bloqueante de {nucleo} sumiu — sem ele o comando volta \
                 a fazer o trabalho pesado dentro do próprio turno"
            );
        }
        assert!(src.contains(&format!("spawn_{}", "blocking")));
    }

    #[test]
    fn pause_resume_segments_are_named_and_purged() {
        // Naming: the first segment keeps the historical name, so a meeting that
        // never pauses is byte-identical to before this feature existed.
        assert_eq!(system_segment_name(0), "system.wav");
        assert_eq!(system_segment_name(1), "system-2.wav");
        assert_eq!(system_segment_name(2), "system-3.wav");

        // Purge: audio is transient whatever the segment count (owner decision
        // 2026-07-27) — a resumed meeting purges as clean as a plain one.
        let base = tmp("purge-segments");
        let c = seed(&base);
        let audio = c.dir.join("audio");
        for f in ["system.wav", "system-2.wav", "system-3.wav", "mic.webm"] {
            std::fs::write(audio.join(f), b"x").unwrap();
        }
        purge_audio_core(&c.dir).unwrap();
        let left: Vec<_> = std::fs::read_dir(&audio).unwrap().flatten().collect();
        assert!(left.is_empty(), "audio survived the purge: {left:?}");
    }

    #[test]
    fn meeting_stays_under_brainstorming_and_is_never_versioned() {
        // ADR-0013 quarantine: the whole meeting (reuniao.md + *.wav) lives under
        // brainstorming/, which the single gitignore line excludes — reuse the
        // git guard, do not weaken it.
        use crate::git::{git_init_repo, set_identity, stage_and_commit, GIT_IGNORED};
        assert!(GIT_IGNORED.contains(&"brainstorming/"));
        if which("git").is_none() {
            return; // git is a system dependency; skip if absent
        }
        let base = tmp("quar");
        let c = seed(&base);
        // drop an audio file where stop() would place it
        std::fs::write(c.dir.join("audio").join("system.wav"), b"RIFF").unwrap();

        git_init_repo(&base).unwrap();
        set_identity(&base, "Teste", "teste@localhost").unwrap();
        // a versioned file so the commit is non-empty
        std::fs::write(base.join("contextos-README.md"), "x").unwrap();
        stage_and_commit(&base, "base".into()).unwrap();

        let tracked = crate::proc::command("git")
            .args(["ls-files"])
            .current_dir(&base)
            .output()
            .unwrap();
        let files = String::from_utf8_lossy(&tracked.stdout);
        assert!(
            !files.contains("brainstorming"),
            "brainstorming/ is never versioned"
        );
        assert!(
            !files.contains("reuniao.md"),
            "the transcript is never versioned"
        );
        assert!(!files.contains(".wav"), "audio is never versioned");
    }

    // #44 — front-matter edges when rewriting `tema`.
    #[test]
    fn retema_front_matter_rewrites_inserts_and_preserves_line_endings() {
        // the ordinary case
        let doc = "---\nloro: 1\ntema: origem\nid: m1\n---\n\ncorpo\n";
        let out = super::retema_front_matter(doc, "destino");
        assert!(out.contains("tema: destino"));
        assert!(!out.contains("tema: origem"));
        assert!(out.ends_with("\n---\n\ncorpo\n"), "corpo intacto: {out}");

        // no `tema:` line — AC-2 requires the field, so it is inserted
        let sem = "---\nloro: 1\nid: m1\n---\n\ncorpo\n";
        assert!(super::retema_front_matter(sem, "destino").contains("tema: destino"));

        // Real CRLF: a `---\r\n` opener, which is what a Windows editor produces. The
        // earlier version of this test used a `---\n…\r\n` hybrid no editor emits,
        // so it never exercised the path it claimed to.
        let crlf = "---\r\nloro: 1\r\ntema: origem\r\n---\r\n\r\ncorpo\r\n";
        let out = super::retema_front_matter(crlf, "destino");
        assert!(out.contains("tema: destino\r\n"), "CRLF: {out:?}");
        assert!(!out.contains("tema: origem"));
        assert!(
            out.ends_with("---\r\n\r\ncorpo\r\n"),
            "corpo CRLF intacto: {out:?}"
        );
        // and an LF file never gains a \r
        let lf = super::retema_front_matter("---\nid: m1\n---\n\nx\n", "destino");
        assert!(!lf.contains('\r'), "LF must not become CRLF: {lf:?}");

        // no front matter — returned identical, never corrupted
        let nada = "# só um título\n\ncorpo\n";
        assert_eq!(super::retema_front_matter(nada, "destino"), nada);
    }

    // `tema` is a TOP-LEVEL key. A `tema:` nested inside another mapping (a ref
    // entry, say) belongs to that entry and is not the meeting's — rewriting it
    // both changes the wrong value and, being re-emitted at column 0, breaks the
    // block it lived in. Only column 0 is the meeting's own `tema`.
    #[test]
    fn retema_front_matter_only_touches_the_top_level_key() {
        let doc = "---\nloro: 1\ntema: origem\nrefs:\n  - id: r1\n    tema: outro\n---\n\ncorpo\n";
        let out = super::retema_front_matter(doc, "destino");
        assert!(out.contains("\ntema: destino\n"), "top level: {out:?}");
        assert!(
            out.contains("\n    tema: outro\n"),
            "the nested entry is left alone: {out:?}"
        );
        assert!(!out.contains("tema: origem"));

        // and a file whose ONLY `tema:` is nested gains its own at top level
        // instead of hijacking the nested one
        let so_aninhado = "---\nrefs:\n  - tema: outro\n---\n\ncorpo\n";
        let out = super::retema_front_matter(so_aninhado, "destino");
        assert!(out.contains("\n  - tema: outro\n"), "intacto: {out:?}");
        assert!(out.contains("\ntema: destino\n"), "inserido: {out:?}");
    }

    // #44 — a moved meeting also stops pointing at its OWN old path. The manifest
    // stores acervo-relative paths (audio, artifacts, refs); left untouched they
    // name a directory that no longer exists.
    #[test]
    fn remap_meeting_rewrites_the_manifest_paths_under_the_old_rel() {
        let dir = std::env::temp_dir().join(format!("loro-remap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let velho = "brainstorming/origem/reunioes/m1";
        let novo = "brainstorming/destino/reunioes/m1";
        let m = Manifest {
            id: "m1".into(),
            tema: "origem".into(),
            status: "done".into(),
            audio: Audio {
                mic: Some(format!("{velho}/audio/mic.webm")),
                system: Some(format!("{velho}/audio/sys.webm")),
                completo: None,
            },
            artifacts: vec![Artifact {
                id: "a1".into(),
                kind: "notas".into(),
                name: "n.md".into(),
                rel: format!("{velho}/artefatos/notas/n.md"),
                ..Default::default()
            }],
            refs: vec![
                RefItem {
                    id: "r1".into(),
                    tipo: "anexo".into(),
                    caminho: format!("{velho}/notas/analise.md"),
                },
                // a ref OUTSIDE the meeting is not the move's business
                RefItem {
                    id: "r2".into(),
                    tipo: "anexo".into(),
                    caminho: "brainstorming/origem/anexos/planilha.csv".into(),
                },
            ],
            ..Default::default()
        };
        manifest_write(&dir, &m).unwrap();
        std::fs::write(dir.join("reuniao.md"), "---\ntema: origem\n---\n\nx\n").unwrap();

        super::remap_meeting_locked(&dir, "destino", velho, novo).unwrap();

        let back = manifest_read(&dir).unwrap();
        assert_eq!(back.tema, "destino");
        assert_eq!(back.audio.mic.unwrap(), format!("{novo}/audio/mic.webm"));
        assert_eq!(back.audio.system.unwrap(), format!("{novo}/audio/sys.webm"));
        assert_eq!(
            back.artifacts[0].rel,
            format!("{novo}/artefatos/notas/n.md")
        );
        assert_eq!(back.refs[0].caminho, format!("{novo}/notas/analise.md"));
        assert_eq!(
            back.refs[1].caminho, "brainstorming/origem/anexos/planilha.csv",
            "a path outside the meeting is left alone"
        );
    }

    // A prefix that merely LOOKS like the old rel is a different meeting.
    #[test]
    fn repath_matches_only_whole_segments() {
        let velho = "brainstorming/origem/reunioes/m1";
        let novo = "brainstorming/destino/reunioes/m1";
        assert_eq!(super::repath(velho, velho, novo).as_deref(), Some(novo));
        assert_eq!(
            super::repath(&format!("{velho}/audio/a.webm"), velho, novo).as_deref(),
            Some(format!("{novo}/audio/a.webm").as_str())
        );
        assert_eq!(
            super::repath("brainstorming/origem/reunioes/m10/x.md", velho, novo),
            None,
            "m10 is not m1"
        );
        assert_eq!(super::repath("outro/caminho.md", velho, novo), None);
    }

    // The manifest is rewritten through the TYPE, so field order follows the
    // declaration instead of turning alphabetical. An unknown key does not survive
    // the roundtrip (`Manifest` has no `flatten`), as in every `manifest_write`.
    #[test]
    fn retema_meeting_preserves_the_manifest_shape() {
        let dir = std::env::temp_dir().join(format!("loro-retema-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let m = Manifest {
            id: "m1".into(),
            tema: "origem".into(),
            titulo: "T".into(),
            criado_em: "2026-08-08".into(),
            atualizado_em: "2026-08-08".into(),
            status: "done".into(),
            modelo: "small".into(),
            idioma: "pt".into(),
            audio: Default::default(),
            artifacts: vec![],
            ..Default::default()
        };
        manifest_write(&dir, &m).unwrap();
        std::fs::write(dir.join("reuniao.md"), "---\ntema: origem\n---\n\nx\n").unwrap();

        super::remap_meeting_locked(
            &dir,
            "destino",
            "brainstorming/origem/reunioes/m1",
            "brainstorming/destino/reunioes/m1",
        )
        .unwrap();

        let back = manifest_read(&dir).unwrap();
        assert_eq!(back.tema, "destino");
        assert_eq!(back.id, "m1", "the DECLARED fields survive");
        assert_eq!(back.status, "done");
        let txt = std::fs::read_to_string(dir.join("manifest.json")).unwrap();
        assert!(
            txt.find("\"id\"").unwrap() < txt.find("\"tema\"").unwrap(),
            "field order follows the type, not the alphabet"
        );
    }
}
