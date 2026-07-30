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
const MARKER_TIPOS: [&str; 4] = ["duvida", "decisao", "investigacao", "pergunta"];

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

// The report seeds Resumo/Decisões/Dúvidas from markers only until the meeting AI
// fills them in; the placeholder tells the user exactly how to populate it (no
// internal ADR reference leaks into a user-facing report).
const DEFERRED_PROSE: &str = "_(resumo automático — rode “analisar” para preencher)_";
const DEFERRED_PROSE_EN: &str = "_(automatic summary — run “analyse” to fill it in)_";

fn deferred_prose(lang: &str) -> &'static str {
    if lang == "en" {
        DEFERRED_PROSE_EN
    } else {
        DEFERRED_PROSE
    }
}

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
// finalized WAV into the meeting's audio/system.wav.
fn syscap_pending() -> &'static Mutex<HashMap<String, PathBuf>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
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

// Assemble relatorio.md from the manifest (ADR-0010). Pure and IO-free. Owner
// decision (2026-07-28): the report carries ONLY the analysis sections — no
// Investigações/Dados/Linha do tempo/Transcrição/Referências/Estatísticas
// boilerplate. The transcript lives in reuniao.md (duplicating it here was
// noise) and the empty-count blocks were dropped everywhere. v1 seeds
// Resumo/Decisões/Dúvidas from MARKERS ONLY and never invents prose (BR-8 safe:
// it emits marker types + timecodes, never transcript text).
// The notebook is born in the active UI language (ADR-0002 §1); anything but
// "en" falls back to pt, the original.
fn assemble_notebook(m: &Manifest, lang: &str) -> String {
    let en = lang == "en";
    let prose = deferred_prose(lang);
    let mut out = String::new();

    out.push_str(&format!("# {}\n\n", m.titulo));
    out.push_str(if en {
        "## Header\n\n"
    } else {
        "## Cabeçalho\n\n"
    });
    // ADR-0013: the header is trimmed to what the reader needs — no
    // modelo/idioma/consentimento (audio is transient, inference is local-first).
    out.push_str(&format!(
        "- {}: {}\n",
        if en { "Title" } else { "Título" },
        m.titulo
    ));
    out.push_str(&format!("- Brainstorming: {}\n", m.tema));
    out.push_str(&format!(
        "- {}: {}\n\n",
        if en { "Date" } else { "Data" },
        m.criado_em
    ));

    // Summary (deferred prose)
    out.push_str(if en {
        "## Summary\n\n"
    } else {
        "## Resumo\n\n"
    });
    out.push_str(prose);
    out.push_str("\n\n");

    // Decisions / Q&A — seeded from markers only
    out.push_str(if en {
        "## Decisions\n\n"
    } else {
        "## Decisões\n\n"
    });
    out.push_str(prose);
    out.push('\n');
    push_marker_bullets(
        &mut out,
        m,
        "decisao",
        if en { "Decision" } else { "Decisão" },
        lang,
    );
    out.push('\n');

    out.push_str(if en {
        "## Questions & Answers\n\n"
    } else {
        "## Dúvidas & Respostas\n\n"
    });
    out.push_str(prose);
    out.push('\n');
    push_marker_bullets(
        &mut out,
        m,
        "duvida",
        if en { "Question" } else { "Dúvida" },
        lang,
    );
    out.push('\n');

    out
}

fn push_marker_bullets(out: &mut String, m: &Manifest, tipo: &str, label: &str, lang: &str) {
    let at = if lang == "en" { "at" } else { "em" };
    for mk in m.marcadores.iter().filter(|x| x.tipo == tipo) {
        match &mk.r#ref {
            Some(r) => out.push_str(&format!(
                "- {label} {at} {} (ref: {r})\n",
                fmt_timecode(mk.t_ms)
            )),
            None => out.push_str(&format!("- {label} {at} {}\n", fmt_timecode(mk.t_ms))),
        }
    }
}

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
        .insert(created.id.clone(), PathBuf::from(&sys_wav));

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
    let sys_dst = dir.join("audio").join("system.wav");
    if let Some(src) = syscap_pending().lock().unwrap().remove(&input.id) {
        if src.is_file() {
            let _ = move_file(&src, &sys_dst);
        }
    }

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
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;

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
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;

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
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;

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
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;

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
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
    let manifest = rename_meeting(&dir, &input.titulo)?;
    let _ = app.emit(
        "pessoal-changed",
        serde_json::json!({ "rel": rel_of(&base, &dir) }),
    );
    Ok(manifest)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOut {
    rel: String,
}

// Assemble relatorio.md from manifest + reuniao.md body (assemble_notebook) and
// set status:done. Charts/audio are emitted as acervo:// links the renderer
// resolves; the summary/decision/doubt sections are seeded from markers only
// (auto-authored prose deferred to ADR-0011).
#[tauri::command]
pub fn brain_meeting_build_notebook(app: AppHandle, id: String) -> Result<BuildOut, String> {
    let base = acervo_base()?;
    let dir = resolve_meeting_dir(&base, &id)?;
    let lock = meeting_lock(&id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;

    let mut manifest = manifest_read(&dir)?;
    // ADR-0013: fold any skill-written PII-free markers (marcadores.jsonl) into the
    // manifest BEFORE assembling, then consume the sidecar so a re-run never
    // double-counts. The app is still the only writer of manifest.json.
    let sidecar = dir.join("marcadores.jsonl");
    if sidecar.is_file() {
        manifest.marcadores = fold_markers_file(&dir, &manifest.marcadores);
        let _ = std::fs::remove_file(&sidecar);
    }
    let notebook = assemble_notebook(&manifest, &crate::config::ui_lang());
    std::fs::write(dir.join("relatorio.md"), notebook).map_err(|e| e.to_string())?;

    manifest.status = "done".into();
    manifest.atualizado_em = now_iso();
    manifest_write(&dir, &manifest)?;

    let rel = format!("{}/relatorio.md", rel_of(&base, &dir));
    let _ = app.emit("brainstorming-changed", serde_json::json!({ "rel": rel }));
    let _ = app.emit("pessoal-changed", serde_json::json!({ "rel": rel }));
    Ok(BuildOut { rel })
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
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
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
// The transcript (reuniao.md/relatorio.md) is the durable artifact; audio is only
// a means to it. Called after the authoritative stop-transcription. Idempotent.
fn purge_audio_core(dir: &Path) -> Result<Manifest, String> {
    let audio_dir = dir.join("audio");
    for file in ["mic.webm", "system.wav", "completo.wav"] {
        let path = audio_dir.join(file);
        if path.starts_with(&audio_dir) && path.is_file() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
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
    let dir = resolve_meeting_dir(&base, &input.id)?;
    let lock = meeting_lock(&input.id);
    let _guard = lock.lock().map_err(|_| "lock envenenado".to_string())?;
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
#[tauri::command]
pub fn brain_meeting_transcribe_tail(input: TranscribeTailInput) -> Result<TranscribeTail, String> {
    let base = acervo_base()?;
    let dir = resolve_meeting_dir(&base, &input.id)?;

    // The live source is the syscap sidecar's WAV while recording; after stop it
    // is the finalized audio/system.wav.
    let src = syscap_pending()
        .lock()
        .unwrap()
        .get(&input.id)
        .cloned()
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
    let snap = dir.join("audio").join(".tail.snapshot.wav");
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
#[tauri::command]
pub fn brain_meeting_transcribe_segment(
    input: TranscribeSegmentInput,
) -> Result<TranscribeSegment, String> {
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

    #[test]
    fn build_notebook_assembles_fixture_from_markers_only() {
        // fixture manifest with markers + artifacts; assert sections + counts and
        // that no transcript prose is invented (only the verbatim body appears)
        let m = Manifest {
            id: "2026-07-27-1430-x".into(),
            tema: "frota-2026".into(),
            titulo: "Semanal".into(),
            criado_em: "2026-07-27T14:30:00Z".into(),
            status: "transcribing".into(),
            modelo: "large-v3-turbo".into(),
            idioma: "pt".into(),
            marcadores: vec![
                Marker {
                    tipo: "decisao".into(),
                    t_ms: Some(65_000),
                    r#ref: None,
                },
                Marker {
                    tipo: "duvida".into(),
                    t_ms: Some(5_000),
                    r#ref: None,
                },
                Marker {
                    tipo: "duvida".into(),
                    t_ms: Some(9_000),
                    r#ref: None,
                },
            ],
            artifacts: vec![Artifact {
                id: "a1".into(),
                kind: "graficos".into(),
                name: "vendas.svg".into(),
                rel: "brainstorming/frota-2026/reunioes/2026-07-27-1430-x/artefatos/graficos/vendas.svg".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let nb = assemble_notebook(&m, "pt");

        for h in [
            "## Cabeçalho",
            "## Resumo",
            "## Decisões",
            "## Dúvidas & Respostas",
        ] {
            assert!(nb.contains(h), "missing section {h}");
        }
        // owner decision (2026-07-28): no boilerplate sections and no count
        // blocks — the transcript stays in reuniao.md, never duplicated here
        for h in [
            "## Investigações",
            "## Dados & Gráficos",
            "## Linha do tempo",
            "## Transcrição",
            "## Referências",
            "## Estatísticas",
            "sem marcadores",
            "sem referências",
            "Dúvidas: ",
            "Artefatos: ",
        ] {
            assert!(!nb.contains(h), "seção/contador removido reapareceu: {h}");
        }
        // ADR-0013: header is trimmed — no modelo/idioma/consentimento, no audio ref
        assert!(nb.contains("- Brainstorming: frota-2026"));
        assert!(!nb.contains("Modelo:"));
        assert!(!nb.contains("Idioma:"));
        assert!(!nb.contains("Consentimento:"));
        assert!(
            !nb.contains("[áudio]"),
            "audio is transient — never referenced"
        );
        // deferred prose is labelled honestly, not fabricated (no ADR ref leaks)
        assert!(nb.contains("resumo automático"));
        assert!(!nb.contains("ADR-0011"));
        // decisão bullet carries a timecode (65s -> 01:05), never text
        assert!(nb.contains("Decisão em 01:05"));
        // duvida bullets survive under Dúvidas & Respostas
        assert!(nb.contains("Dúvida em 00:05"));
    }

    // ADR-0002 §1 — the notebook is born in the active UI language.
    #[test]
    fn notebook_is_english_when_lang_is_en() {
        let m = Manifest {
            titulo: "Kickoff".into(),
            tema: "fleet-2026".into(),
            criado_em: "2026-07-28".into(),
            marcadores: vec![Marker {
                tipo: "decisao".into(),
                t_ms: Some(65_000),
                r#ref: None,
            }],
            ..Default::default()
        };
        let nb = assemble_notebook(&m, "en");
        for h in [
            "## Header",
            "## Summary",
            "## Decisions",
            "## Questions & Answers",
        ] {
            assert!(nb.contains(h), "missing section {h}");
        }
        assert!(!nb.contains("## Resumo") && !nb.contains("## Cabeçalho"));
        assert!(nb.contains("- Title: Kickoff"));
        assert!(nb.contains("- Brainstorming: fleet-2026"));
        assert!(nb.contains("automatic summary"));
        assert!(nb.contains("Decision at 01:05"));
        // unknown languages fall back to pt
        assert!(assemble_notebook(&m, "fr").contains("## Resumo"));
    }

    #[test]
    fn build_notebook_command_core_sets_status_done() {
        let base = tmp("build");
        let c = seed(&base);
        append_one(&c.dir, "[00:00] abertura").unwrap();
        // mirror brain_meeting_build_notebook's core (no AppHandle)
        let mut m = manifest_read(&c.dir).unwrap();
        let nb = assemble_notebook(&m, "pt");
        std::fs::write(c.dir.join("relatorio.md"), nb).unwrap();
        m.status = "done".into();
        manifest_write(&c.dir, &m).unwrap();

        assert!(c.dir.join("relatorio.md").is_file());
        assert_eq!(manifest_read(&c.dir).unwrap().status, "done");
        // the transcript stays in reuniao.md only — the report never duplicates it
        let report = std::fs::read_to_string(c.dir.join("relatorio.md")).unwrap();
        assert!(!report.contains("[00:00] abertura"));
        assert!(std::fs::read_to_string(c.dir.join("reuniao.md"))
            .unwrap()
            .contains("[00:00] abertura"));
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

        let tracked = std::process::Command::new("git")
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
}
