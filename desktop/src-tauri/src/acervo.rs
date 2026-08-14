// The Brainstorming world (ADR-0013, renamed from ADR-0009 Individual Production):
// brainstormings, notebooks, references, the consolidated report and PII-free
// statistics. This is the NON-VERSIONED world under `brainstorming/` (quarantined by
// the single git.rs gitignore line). Everything here is local (BR-1) and never reads
// transcript prose into any output (BR-8); no secrets are handled (BR-9).
//
// Clean-core (CLAUDE.md §5): the FS/Tauri commands are thin wrappers; the domain
// logic (slug/front-matter/ref-resolution/promotion deny-list) is factored into
// pure functions unit-tested without a running Tauri app. Every path reuses the
// canonicalize + starts_with(base) guard the other brain_* commands use.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::{error, info};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::config::{active_acervo_lang, read_brain_config};
use crate::git::sanitize_slug;
use crate::valid_context;

// ---- constants --------------------------------------------------------------

// brain_read_asset: a local image/chart becomes a data: URI. Only these mimes are
// renderable inline under the app CSP (img-src 'self' data:).
const ASSET_MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB cap (reject larger)

// ---- base + path guards -----------------------------------------------------

// The active acervo root, canonicalized (the single trust boundary for every FS
// path below). None-configured surfaces the same error as the other commands.
fn acervo_base() -> Result<PathBuf, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())
}

// Resolve an acervo-relative path to an existing file/dir, guarded to `base`
// (canonicalize + starts_with). `base` must already be canonical.
pub(crate) fn guarded_existing(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = base
        .join(rel)
        .canonicalize()
        .map_err(|_| "err.not_found".to_string())?;
    if !p.starts_with(base) {
        return Err("err.outside_acervo".into());
    }
    Ok(p)
}

// Lexically normalize an acervo-relative path (resolve `.`/`..`), REFUSING any
// path that escapes the root. Pure — used to resolve refs to a canonical
// acervo-root-relative form even when the target does not exist yet.
fn normalize_rel(rel: &str) -> Result<String, String> {
    let mut stack: Vec<&str> = Vec::new();
    let normalized = rel.replace('\\', "/");
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if stack.pop().is_none() {
                    return Err("err.outside_acervo".into());
                }
            }
            p => stack.push(p),
        }
    }
    Ok(stack.join("/"))
}

// ---- pure helpers: base64, mime, tipo ---------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Minimal standard-alphabet base64 (no dep — no-bundler/dependency-light stance).
fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

// Mime allowlist for inline rendering — svg/png/jpg/jpeg/gif/webp only.
fn asset_mime(name: &str) -> Option<&'static str> {
    match ext_of(name).as_str() {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

// Reference kind inferred from extension (drives the JS click dispatch).
fn ref_tipo(rel: &str) -> &'static str {
    match ext_of(rel).as_str() {
        "md" | "txt" => "doc",
        "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp" => "image",
        "wav" | "webm" | "mp3" | "m4a" => "audio",
        _ => "other",
    }
}

fn is_audio(name: &str) -> bool {
    matches!(ext_of(name).as_str(), "wav" | "webm" | "mp3" | "m4a")
}

// Promotion deny-list (ADR-0009): audio is never copied (becomes a text stub);
// raw audit/meta/manifest are never copied at all.
fn is_promotion_denied(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    is_audio(&l) || l == "audit.jsonl" || l == "meta.json" || l == "manifest.json"
}

// ---- front-matter (hand-rolled, no YAML lib — no-bundler constraint) --------

#[derive(Clone, Debug, PartialEq)]
struct RefEntry {
    id: String,
    tipo: String,
    caminho: String,
}

// Split a living file into (front-matter body, document body). Malformed or
// absent front-matter degrades to (None, whole content) — never panics.
fn split_front_matter(content: &str) -> (Option<String>, String) {
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let fm = rest[..end].to_string();
            let after = &rest[end + 4..]; // skip "\n---"
            let body = after.strip_prefix('\n').unwrap_or(after);
            return (Some(fm), body.to_string());
        }
    }
    (None, content.to_string())
}

// Tolerant parse of the `refs:` block-list into structured entries.
fn parse_refs(fm: &str) -> Vec<RefEntry> {
    let mut refs = Vec::new();
    let mut cur: Option<RefEntry> = None;
    for line in fm.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("- id:") {
            if let Some(r) = cur.take() {
                refs.push(r);
            }
            cur = Some(RefEntry {
                id: rest.trim().to_string(),
                tipo: String::new(),
                caminho: String::new(),
            });
        } else if let Some(rest) = t.strip_prefix("tipo:") {
            if let Some(r) = cur.as_mut() {
                r.tipo = rest.trim().to_string();
            }
        } else if let Some(rest) = t.strip_prefix("caminho:") {
            if let Some(r) = cur.as_mut() {
                r.caminho = rest.trim().to_string();
            }
        }
    }
    if let Some(r) = cur.take() {
        refs.push(r);
    }
    refs
}

fn next_ref_id(fm: &str) -> String {
    let n = fm.matches("- id:").count();
    format!("r{}", n + 1)
}

// Anchor a caminho to the canonical `acervo://` form (BR-independent invariant so
// promoted refs never dangle into the git-ignored world).
fn anchor_path(caminho: &str) -> String {
    if caminho.starts_with("acervo://")
        || caminho.starts_with("http://")
        || caminho.starts_with("https://")
    {
        caminho.to_string()
    } else {
        format!("acervo://{}", caminho.trim_start_matches('/'))
    }
}

// Append a reference to the file's front-matter; returns (new_content, id). The
// caminho is stored anchored. Missing front-matter is created; a missing `refs:`
// key is added; an inline empty `refs: []` is expanded.
fn add_ref_to_content(
    content: &str,
    tipo: &str,
    caminho: &str,
    id: Option<&str>,
) -> (String, String) {
    let caminho = anchor_path(caminho);
    let (fm_opt, body) = split_front_matter(content);
    let fm = fm_opt.unwrap_or_else(|| "loro: 1".to_string());
    let id = id
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| next_ref_id(&fm));
    let item = format!("  - id: {id}\n    tipo: {tipo}\n    caminho: {caminho}");

    let mut lines: Vec<String> = fm.lines().map(|s| s.to_string()).collect();
    if let Some(pos) = lines
        .iter()
        .position(|l| l.trim_start().starts_with("refs:"))
    {
        if matches!(lines[pos].trim(), "refs: []" | "refs:[]") {
            lines[pos] = "refs:".to_string();
        }
        for (i, il) in item.lines().enumerate() {
            lines.insert(pos + 1 + i, il.to_string());
        }
    } else {
        lines.push("refs:".to_string());
        for il in item.lines() {
            lines.push(il.to_string());
        }
    }
    let fm = lines.join("\n");
    let out = format!("---\n{fm}\n---\n\n{body}");
    (out, id)
}

// Stamp `promovido:{para,branch,em}` into the SOURCE file's front-matter without
// moving it (the source stays in the git-ignored world).
fn stamp_promovido(content: &str, para: &str, branch: &str, em: &str) -> String {
    let (fm_opt, body) = split_front_matter(content);
    let block = format!("promovido:\n  para: {para}\n  branch: {branch}\n  em: {em}");
    match fm_opt {
        Some(fm) => format!("---\n{fm}\n{block}\n---\n\n{body}"),
        None => format!("---\nloro: 1\n{block}\n---\n\n{body}"),
    }
}

// First `# ` heading of the body, else the source filename stem — the merged
// block's title.
fn notebook_title(source_rel: &str, body: &str) -> String {
    for line in body.lines() {
        if let Some(h) = line.trim().strip_prefix("# ") {
            let h = h.trim();
            if !h.is_empty() {
                return h.to_string();
            }
        }
    }
    Path::new(source_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("notebook")
        .to_string()
}

// ---- dates ------------------------------------------------------------------

// Today as ISO 8601 (YYYY-MM-DD), UTC. Kept tiny/dependency-free; injected into
// the pure cores so tests are deterministic.
fn today_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
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

// ---- meta.json (PII-free) ---------------------------------------------------

// A marker carries only a type (+ optional timecode/ref) — NEVER transcript text
// (BR-8). Kept in meta.json purely for round-trip (rewrites must not drop it).
#[derive(Serialize, Deserialize, Default, Clone)]
struct Marker {
    #[serde(default)]
    tipo: String,
    #[serde(default)]
    t_ms: Option<u64>,
    #[serde(default)]
    r#ref: Option<String>,
}

// A brainstorming's PII-free metadata (ADR-0013). The JSON key `tema` is kept
// (via the field name) so existing meta.json files parse with zero migration; it
// holds the brainstorming slug. `categoria` is an optional UI-only grouping label.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct BrainstormingMeta {
    #[serde(default)]
    tema: String,
    #[serde(default)]
    nome: String,
    #[serde(default)]
    categoria: Option<String>,
    #[serde(default)]
    criado_em: String,
    #[serde(default)]
    atualizado_em: String,
    #[serde(default)]
    marcadores: Vec<Marker>,
    #[serde(default)]
    tags: Vec<String>,
}

fn read_meta(dir: &Path) -> BrainstormingMeta {
    std::fs::read_to_string(dir.join("meta.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

// ---- small fs counters ------------------------------------------------------

fn count_entries(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .count()
        })
        .unwrap_or(0)
}

// ADR-0013: the Brainstorming world is a flat `brainstorming/<slug>/` tree (the
// old `pessoal/temas/` two-level path collapsed to one).
fn brainstorming_dir(base: &Path) -> PathBuf {
    base.join("brainstorming")
}

// ---- theme scaffolding ------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainstormingRef {
    slug: String,
    rel: String,
}

fn living_front_matter(id: &str, tema: &str, today: &str) -> String {
    format!(
        "---\nloro: 1\nid: {id}\ntema: {tema}\ncriado_em: {today}\natualizado_em: {today}\nrefs: []\n---\n\n"
    )
}

// Scaffold brainstorming/<slug>/ (idempotent, non-destructive: existing files are
// left untouched). Returns the brainstorming slug + acervo-relative rel.
fn create_brainstorming(
    base: &Path,
    nome: &str,
    categoria: Option<&str>,
    today: &str,
) -> Result<BrainstormingRef, String> {
    let slug = sanitize_slug(nome)?;
    let dir = brainstorming_dir(base).join(&slug);
    // ADR-0005: the canonical brainstorming subfolders are meetings/, notes/ and
    // attachments/. The legacy investigacoes/, relatorios/ and perguntas/ folders are no
    // longer scaffolded — non-meeting output (e.g. the brainstorming report) lands
    // in attachments/.
    for sub in ["", "meetings", "notes", "attachments"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| e.to_string())?;
    }
    // ADR-0026 §14 — generated in English (`index.md`); an acervo written earlier
    // keeps its `indice.md` and is left exactly where it is.
    let indice = if dir.join(TOPIC_DOC_LEGACY).is_file() {
        dir.join(TOPIC_DOC_LEGACY)
    } else {
        dir.join(TOPIC_DOC)
    };
    if !indice.exists() {
        let fm = living_front_matter(&slug, &slug, today);
        std::fs::write(&indice, format!("{fm}# {nome}\n")).map_err(|e| e.to_string())?;
    }
    let meta = dir.join("meta.json");
    if !meta.exists() {
        let m = BrainstormingMeta {
            tema: slug.clone(),
            nome: nome.to_string(),
            categoria: categoria
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(|c| c.to_string()),
            criado_em: today.to_string(),
            atualizado_em: today.to_string(),
            marcadores: vec![],
            tags: vec![],
        };
        std::fs::write(
            &meta,
            serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(BrainstormingRef {
        slug: slug.clone(),
        rel: format!("brainstorming/{slug}"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainstormingListItem {
    slug: String,
    nome: String,
    categoria: Option<String>,
    meetings: usize,
    atualizado_em: String,
}

// ADR-0005: brainstormings created before attachments/ existed never got that
// folder — self-heal on every list call (cheap, idempotent, create-if-absent)
// instead of requiring an explicit migration step. Mirrors the "respect
// existing structure, fill only gaps" premise already used for skill files
// (ensure_meeting_skills). Presentations live in attachments/ too (one kind among
// others) — no separate apresentacoes/ folder; the acervo's three
// brainstorming folders are meetings/, notes/, attachments/.
fn ensure_brainstorming_subfolders(dir: &Path) {
    let _ = std::fs::create_dir_all(dir.join("attachments"));
}

// ADR-0008: every skill-generated document is a note — it lives in the meeting's
// own notes/. Older meetings wrote analyses/answers under artefatos/<kind>/ (and
// even bare investigacoes/perguntas/respostas/relatorios folders); move those
// files into notes/ and drop the now-empty legacy dirs. Self-heal (like the
// brainstorming-subfolder backfill) — no explicit "migrate" command, and
// non-destructive (dedupes on name collision, never overwrites).
const LEGACY_MEETING_FOLDERS: [&str; 5] = [
    "artefatos",
    "investigacoes",
    "perguntas",
    "respostas",
    "relatorios",
];
fn migrate_meeting_to_notas(meeting_dir: &Path) {
    let notas = meeting_dir.join("notes");
    for name in LEGACY_MEETING_FOLDERS {
        let src = meeting_dir.join(name);
        if src.is_dir() {
            move_files_flat(&src, &notas);
            if !dir_has_files(&src) {
                let _ = std::fs::remove_dir_all(&src);
            }
        }
    }
}

// ADR-0018 · AC-8: a meeting no longer has a `relatorio.md` — the analysis in
// `notes/` IS its output. A file left behind by an older version is DELETED on
// the first listing, not migrated.
//
// This is a deliberate DEROGATION from the domain's non-destructive premise and
// from ADR-0008 §2's self-heal, signed by the owner (2026-08-07): the report was
// app-authored placeholder prose, so keeping a copy would only preserve text that
// never said anything. The blast radius is exactly one path — a `notes/relatorio.md`
// is the USER's file and is never touched.
fn drop_legacy_report(meeting_dir: &Path) {
    let report = meeting_dir.join("relatorio.md");
    if report.is_file() {
        if let Err(e) = std::fs::remove_file(&report) {
            tracing::error!(error = %e, "legacy meeting report not removed");
        }
    }
}

// Move every FILE under `src` (recursively) into a FLAT `dst`, deduping names.
fn move_files_flat(src: &Path, dst: &Path) {
    let mut stack = vec![src.to_path_buf()];
    let mut files: Vec<PathBuf> = Vec::new();
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    files.push(p);
                }
            }
        }
    }
    if files.is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(dst);
    for p in files {
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            let _ = std::fs::rename(&p, next_free_name(dst, name));
        }
    }
}

fn dir_has_files(dir: &Path) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    return true;
                }
            }
        }
    }
    false
}

// A collision-free path in `dir` for `name` (numeric suffix before the ext). The
// single owner of "do not overwrite what is already there" for every door that
// brings a file in from outside its folder (the non-destructive premise).
pub(crate) fn next_free_name(dir: &Path, name: &str) -> PathBuf {
    let mut target = dir.join(name);
    if !target.exists() {
        return target;
    }
    // A leading dot belongs to the name, not to an extension: `.env` must not be
    // suffixed into `-2.env`, which would stop being a hidden file.
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut n = 1;
    while target.exists() {
        n += 1;
        target = dir.join(format!("{stem}-{n}{ext}"));
    }
    target
}

fn list_brainstormings(base: &Path) -> Vec<BrainstormingListItem> {
    let mut out: Vec<BrainstormingListItem> = std::fs::read_dir(brainstorming_dir(base))
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .filter(|e| e.file_name().to_string_lossy() != "avulso")
                .map(|e| {
                    ensure_brainstorming_subfolders(&e.path());
                    let slug = e.file_name().to_string_lossy().to_string();
                    let m = read_meta(&e.path());
                    BrainstormingListItem {
                        nome: if m.nome.is_empty() {
                            slug.clone()
                        } else {
                            m.nome
                        },
                        categoria: m.categoria,
                        meetings: count_entries(&e.path().join("meetings")),
                        atualizado_em: m.atualizado_em,
                        slug,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

// Set/clear a brainstorming's optional UI grouping category (meta-only).
fn set_category(base: &Path, slug: &str, categoria: Option<&str>) -> Result<(), String> {
    if !valid_context(slug) {
        return Err("err.invalid_brainstorm".into());
    }
    let dir = brainstorming_dir(base).join(slug);
    if !dir.is_dir() {
        return Err("err.brainstorm_not_found".into());
    }
    let mut m = read_meta(&dir);
    m.categoria = categoria
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string());
    std::fs::write(
        dir.join("meta.json"),
        serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

// One meeting of a brainstorming as the sidebar tree shows it: the display
// `titulo` comes from the manifest (renameable via brain_meeting_rename), the
// id from the folder name. PII-free — no transcript text is ever read here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingListItem {
    id: String,
    rel: String,
    titulo: String,
    status: String,
    // ADR-0018 · AC-7: how many of the meeting's `notes/` can enter the fila. The
    // analysis IS the meeting's output, so zero means there is nothing to send —
    // the `⋯` entry says that instead of queueing an empty meeting.
    notes: usize,
}

// ADR-0018 — the ONE owner of "which files represent a meeting in the fila".
// The analysis IS the meeting's output, so that is its `notes/*` and nothing
// else: never the transcript, never the audit, never audio.
//
// Hotspot #46: every path that queues a meeting resolves through HERE. A second
// `read_dir` of the meeting folder somewhere else would rebuild the BR-8 gate,
// and that is exactly how a transcript reaches `inbox/`. `rel` is the meeting's
// acervo-relative directory.
pub(crate) fn meeting_queueables(base: &Path, rel: &str) -> Vec<String> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_end_matches('/');
    let mut out: Vec<String> = std::fs::read_dir(base.join(rel).join("notes"))
        .map(|rd| {
            rd.flatten()
                .filter(|f| f.path().is_file())
                .filter_map(|f| {
                    let n = f.file_name().to_string_lossy().to_string();
                    let r = format!("{rel}/notes/{n}");
                    (!n.starts_with('.') && is_queueable(&r)).then_some(r)
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn list_meetings(base: &Path, slug: &str) -> Vec<MeetingListItem> {
    let dir = brainstorming_dir(base).join(slug).join("meetings");
    let mut out: Vec<MeetingListItem> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().join("manifest.json").is_file())
                .map(|e| {
                    migrate_meeting_to_notas(&e.path()); // ADR-0008 self-heal
                    drop_legacy_report(&e.path()); // ADR-0018 §AC-8
                    let id = e.file_name().to_string_lossy().to_string();
                    let man: MeetingManifestLite =
                        std::fs::read_to_string(e.path().join("manifest.json"))
                            .ok()
                            .and_then(|t| serde_json::from_str(&t).ok())
                            .unwrap_or_default();
                    let rel = format!("brainstorming/{slug}/meetings/{id}");
                    MeetingListItem {
                        notes: meeting_queueables(base, &rel).len(),
                        rel,
                        titulo: man.titulo,
                        status: man.status,
                        id,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    // newest first: ids start with the AAAA-MM-DD-HHMM stamp
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

#[tauri::command]
pub fn brain_list_meetings(slug: String) -> Result<Vec<MeetingListItem>, String> {
    if !valid_context(&slug) {
        return Err("err.invalid_brainstorm".into());
    }
    Ok(list_meetings(&acervo_base()?, &slug))
}

// ---- user tools (ADR-0005 §E) -----------------------------------------------
// A tool is any `.md` in `.claude/commands/` that is NOT one of the 7 built-in
// skills — the filename IS the slash-command (`minha-ferramenta.md` ->
// `/minha-ferramenta`). This deny-list is the only thing that keeps a custom
// tool from shadowing/deleting a built-in one; it must stay in sync with the
// skill list materialized by ensure_acervo_structure/ensure_meeting_skills.
pub const BUILTIN_SKILLS: [&str; 11] = [
    "loro-context.md",
    "loro-analyse.md",
    "loro-question.md",
    "loro-ask.md",
    "loro-note.md",
    "loro-sync.md",
    "loro-tool.md",
    "loro-presentation.md",
    "loro-artifact.md",
    "loro-slack.md",
    "loro-digest.md",
];

fn tools_dir(base: &Path) -> PathBuf {
    base.join(".claude/commands")
}

// Create a new tool (imported skill content, never AI-drafted here — that
// path is /loro-tool itself, writing directly via the terminal agent).
// Non-destructive: refuses a builtin name, never overwrites (suffix on
// collision, mirroring new_notebook).
fn new_tool(base: &Path, nome: &str, conteudo: &str) -> Result<String, String> {
    let slug = sanitize_slug(nome)?;
    let fname = format!("{slug}.md");
    if BUILTIN_SKILLS.contains(&fname.as_str()) {
        return Err("err.tool_name_reserved".into());
    }
    let dir = tools_dir(base);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut path = dir.join(&fname);
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{slug}-{n}.md"));
    }
    std::fs::write(&path, conteudo).map_err(|e| e.to_string())?;
    path.strip_prefix(base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

// Delete a tool. Restricted to `.claude/commands/*.md`, outside the builtin
// deny-list — never an arbitrary acervo file, never a built-in skill.
fn delete_tool(base: &Path, rel: &str) -> Result<(), String> {
    let rel = rel.replace('\\', "/");
    let name = Path::new(&rel)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if !rel.starts_with(".claude/commands/") || !rel.ends_with(".md") {
        return Err("err.tool_path_invalid".into());
    }
    if BUILTIN_SKILLS.contains(&name) {
        return Err("err.tool_name_reserved".into());
    }
    let p = guarded_existing(base, &rel)?;
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

// ---- anexos / notes in a brainstorming OR a context (ADR-0005) -------------
// Both the brainstorming and the context now expose an `attachments/` folder that
// the user can feed from the computer or write a note into. A destination is
// only ever one of those anexos folders: normalized (no traversal), rooted in
// `brainstorming/` or `contexts/`, and ending in `anexos`. Returns the
// absolute dir (created) so both the file import (lib.rs, needs the dialog)
// and the note creator below share the exact same guard.
pub fn guarded_anexos_dir(base: &Path, dest_rel: &str) -> Result<PathBuf, String> {
    let rel = normalize_rel(dest_rel)?;
    let first = rel.split('/').next().unwrap_or("");
    if (first != "brainstorming" && first != "contexts") || !rel.ends_with("/attachments") {
        return Err("err.invalid_anexos_dest".into());
    }
    let dir = base.join(&rel);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Create a note (living front-matter markdown) inside an anexos folder — the
// context counterpart to new_notebook (which targets a brainstorming's
// notes/). Non-destructive: never overwrites (suffix on collision).
fn new_note_in(base: &Path, dest_rel: &str, titulo: &str, today: &str) -> Result<String, String> {
    let dir = guarded_anexos_dir(base, dest_rel)?;
    let slug = sanitize_slug(titulo)?;
    let mut path = dir.join(format!("{slug}.md"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{slug}-{n}.md"));
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(&slug);
    let fm = living_front_matter(stem, "", today);
    std::fs::write(&path, format!("{fm}# {titulo}\n")).map_err(|e| e.to_string())?;
    path.strip_prefix(base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn brain_new_note_in(dest_rel: String, titulo: String) -> Result<String, String> {
    new_note_in(&acervo_base()?, &dest_rel, &titulo, &today_iso())
}

#[tauri::command]
pub fn brain_new_tool(nome: String, conteudo: String) -> Result<String, String> {
    new_tool(&acervo_base()?, &nome, &conteudo)
}

#[tauri::command]
pub fn brain_delete_tool(rel: String) -> Result<(), String> {
    delete_tool(&acervo_base()?, &rel)
}

// Create a notebook (.md) with living front-matter. Under a brainstorming's notes/
// when one is given, else brainstorming/avulso/<AAAA-MM-DD>-<slug>.md. Non-destructive.
fn new_notebook(
    base: &Path,
    tema: Option<&str>,
    titulo: &str,
    today: &str,
) -> Result<String, String> {
    let slug = sanitize_slug(titulo)?;
    let id = format!("{today}-{slug}");
    let (dir, fname, tema_field) = match tema.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            if !valid_context(t) {
                return Err("err.invalid_brainstorm".into());
            }
            (
                brainstorming_dir(base).join(t).join("notes"),
                format!("{slug}.md"),
                t.to_string(),
            )
        }
        None => (
            brainstorming_dir(base).join("avulso"),
            format!("{today}-{slug}.md"),
            String::new(),
        ),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&fname);
    if path.exists() {
        return Err("err.notebook_exists".into());
    }
    let fm = living_front_matter(&id, &tema_field, today);
    std::fs::write(&path, format!("{fm}# {titulo}\n")).map_err(|e| e.to_string())?;
    let rel = path
        .strip_prefix(base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())?;
    Ok(rel)
}

// ---- reference resolution ---------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefResolution {
    rel: String,
    tipo: String,
    exists: bool,
    // ADR-0007: an excerpt-addressable ref carries an optional `#<annot-id>`
    // fragment. It is echoed back (never part of the on-disk path) so a
    // habilidade alvo `acervo://<rel>#an_…` still resolves the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<String>,
}

// Resolve a ref to an acervo-root-relative rel. `r` is EITHER an anchored
// "acervo://<rel>" (canonical) OR a path relative to `source_rel`'s directory.
// Path-guarded (never escapes the root).
fn resolve_ref(base: &Path, source_rel: &str, r: &str) -> Result<RefResolution, String> {
    // External refs (e.g. a Drive doc link) are never resolved against the
    // acervo root — no local file backs them (loro-sync, BR-8: link only).
    if r.starts_with("http://") || r.starts_with("https://") {
        return Ok(RefResolution {
            rel: r.to_string(),
            tipo: "link".to_string(),
            exists: true,
            anchor: None,
        });
    }
    // ADR-0007: split a trailing `#<annot-id>` excerpt fragment off the path.
    let (r, anchor) = match r.split_once('#') {
        Some((path, frag)) => (path, Some(frag.to_string())),
        None => (r, None),
    };
    let raw = if let Some(rest) = r.strip_prefix("acervo://") {
        rest.to_string()
    } else if r.starts_with('/') {
        return Err("err.absolute_ref_not_allowed".into());
    } else {
        let dir = Path::new(source_rel)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if dir.is_empty() {
            r.to_string()
        } else {
            format!("{dir}/{r}")
        }
    };
    let rel = normalize_rel(&raw)?;
    let exists = base.join(&rel).exists();
    Ok(RefResolution {
        tipo: ref_tipo(&rel).to_string(),
        rel,
        exists,
        anchor,
    })
}

// ---- assets -----------------------------------------------------------------

#[derive(Serialize)]
pub struct Asset {
    mime: String,
    base64: String,
}

fn read_asset(base: &Path, rel: &str) -> Result<Asset, String> {
    let p = guarded_existing(base, rel)?;
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let mime = asset_mime(name).ok_or("err.unsupported_file_type")?;
    let len = p.metadata().map_err(|e| e.to_string())?.len();
    if len > ASSET_MAX_BYTES {
        return Err("err.file_too_large".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(Asset {
        mime: mime.to_string(),
        base64: base64_encode(&bytes),
    })
}

// ---- annotations: highlights & comments (ADR-0007) --------------------------
// A highlight/comment is anchored by TEXT QUOTE (see src/annotate.js), stored
// in a co-located sidecar `<doc>.anotacoes.json` — versioned with the content,
// never inside the markdown (a transcript is append-only) and never in a log
// (BR-8: the quoted excerpt is the acervo's own working material). One record
// models both features: an empty `comentarios` list is just a highlight.

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    quote: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    suffix: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Comentario {
    #[serde(default)]
    autor: String,
    texto: String,
    #[serde(default)]
    em: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Anotacao {
    #[serde(default)]
    id: String,
    #[serde(default)]
    tipo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cor: Option<String>,
    anchor: Anchor,
    #[serde(default)]
    comentarios: Vec<Comentario>,
    #[serde(default)]
    criado_em: String,
    #[serde(default)]
    atualizado_em: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationsFile {
    doc: String,
    #[serde(default)]
    anotacoes: Vec<Anotacao>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationPatch {
    cor: Option<String>,
    add_comentario: Option<Comentario>,
}

// The suffix that marks a file as the MACHINE's, not the user's. It is content
// the app writes beside a document, so no listing may offer it as a document
// (N12: a highlight inside a habilidade grew a `.anotacoes.json` row in
// HABILIDADES DE IA whose "excluir" could never work).
pub const SIDECAR_SUFFIX: &str = ".anotacoes.json";

// The sidecar for `<doc>.md` is `<doc>.anotacoes.json` beside it. The annotated
// doc must already exist inside the acervo (guarded); the sidecar itself need
// not exist yet.
fn sidecar_path(base: &Path, doc_rel: &str) -> Result<PathBuf, String> {
    let rel = normalize_rel(doc_rel)?;
    if !rel.ends_with(".md") {
        return Err("err.annot_doc_invalid".into());
    }
    guarded_existing(base, &rel)?;
    let side = format!("{}{SIDECAR_SUFFIX}", &rel[..rel.len() - 3]);
    Ok(base.join(side))
}

// Stable id derived from the anchor content (so the same passage yields the same
// id across sessions), with a numeric suffix on the rare collision.
fn gen_annot_id(anchor: &Anchor, existing: &[Anotacao]) -> String {
    let seed = format!(
        "{}\u{0}{}\u{0}{}",
        anchor.quote, anchor.prefix, anchor.suffix
    );
    let base_id = format!("an_{}", short_hash(seed.as_bytes()));
    let mut id = base_id.clone();
    let mut n = 1;
    while existing.iter().any(|x| x.id == id) {
        n += 1;
        id = format!("{base_id}-{n}");
    }
    id
}

fn read_annotations(base: &Path, doc_rel: &str) -> Result<AnnotationsFile, String> {
    let p = sidecar_path(base, doc_rel)?;
    if !p.exists() {
        return Ok(AnnotationsFile {
            doc: normalize_rel(doc_rel)?,
            anotacoes: vec![],
        });
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_annotations(p: &Path, file: &AnnotationsFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| e.to_string())
}

fn add_annotation(
    base: &Path,
    doc_rel: &str,
    mut a: Anotacao,
    today: &str,
) -> Result<String, String> {
    let p = sidecar_path(base, doc_rel)?;
    let mut file = read_annotations(base, doc_rel)?;
    if a.anchor.quote.is_empty() {
        return Err("err.annot_empty_quote".into());
    }
    if a.tipo.is_empty() {
        a.tipo = "grifo".into();
    }
    a.id = gen_annot_id(&a.anchor, &file.anotacoes);
    if a.criado_em.is_empty() {
        a.criado_em = today.to_string();
    }
    a.atualizado_em = today.to_string();
    for c in a.comentarios.iter_mut() {
        if c.em.is_empty() {
            c.em = today.to_string();
        }
    }
    let id = a.id.clone();
    file.doc = normalize_rel(doc_rel)?;
    file.anotacoes.push(a);
    write_annotations(&p, &file)?;
    Ok(id)
}

fn update_annotation(
    base: &Path,
    doc_rel: &str,
    id: &str,
    patch: AnnotationPatch,
    today: &str,
) -> Result<(), String> {
    let p = sidecar_path(base, doc_rel)?;
    let mut file = read_annotations(base, doc_rel)?;
    let a = file
        .anotacoes
        .iter_mut()
        .find(|x| x.id == id)
        .ok_or("err.annot_not_found")?;
    if let Some(cor) = patch.cor {
        a.cor = Some(cor);
    }
    if let Some(mut c) = patch.add_comentario {
        if c.em.is_empty() {
            c.em = today.to_string();
        }
        a.comentarios.push(c);
    }
    a.atualizado_em = today.to_string();
    write_annotations(&p, &file)
}

fn delete_annotation(base: &Path, doc_rel: &str, id: &str) -> Result<(), String> {
    let p = sidecar_path(base, doc_rel)?;
    let mut file = read_annotations(base, doc_rel)?;
    let before = file.anotacoes.len();
    file.anotacoes.retain(|x| x.id != id);
    if file.anotacoes.len() == before {
        return Err("err.annot_not_found".into());
    }
    write_annotations(&p, &file)
}

#[tauri::command]
pub fn brain_annotations_get(rel: String) -> Result<AnnotationsFile, String> {
    read_annotations(&acervo_base()?, &rel)
}

#[tauri::command]
pub fn brain_annotation_add(rel: String, anotacao: Anotacao) -> Result<String, String> {
    add_annotation(&acervo_base()?, &rel, anotacao, &today_iso())
}

#[tauri::command]
pub fn brain_annotation_update(
    rel: String,
    id: String,
    patch: AnnotationPatch,
) -> Result<(), String> {
    update_annotation(&acervo_base()?, &rel, &id, patch, &today_iso())
}

#[tauri::command]
pub fn brain_annotation_delete(rel: String, id: String) -> Result<(), String> {
    delete_annotation(&acervo_base()?, &rel, &id)
}

// ---- promotion (non-destructive copy + rewrite, deny-list) ------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewrittenRef {
    from: String,
    to: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteReport {
    slug: String,
    staged_files: Vec<String>,
    rewritten_refs: Vec<RewrittenRef>,
    changelog_entry: String,
}

fn short_hash(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:08x}", h.finish() & 0xffff_ffff)
}

// Pick a target filename under referencias/, deduping by content: identical bytes
// reuse the name (no copy); a name clash with different bytes gets a hash suffix.
fn dedup_target(dir: &Path, name: &str, bytes: &[u8]) -> (String, bool) {
    let target = dir.join(name);
    if !target.exists() {
        return (name.to_string(), true);
    }
    if std::fs::read(&target).map(|b| b == bytes).unwrap_or(false) {
        return (name.to_string(), false);
    }
    let h = short_hash(bytes);
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let hashed = if ext.is_empty() {
        format!("{stem}-{h}")
    } else {
        format!("{stem}-{h}.{ext}")
    };
    let need = !dir.join(&hashed).exists();
    (hashed, need)
}

// Rewrite inline `(ref:<id>)` links and any raw caminho mention in the prose:
// Some(target) -> point at referencias/<target>; None -> drop the link so nothing
// dangles back into the git-ignored world.
fn rewrite_prose(body: &str, rewrites: &[(String, Option<String>, String)]) -> String {
    let mut out = body.to_string();
    for (id, target, caminho) in rewrites {
        let needle = format!("(ref:{id})");
        match target {
            Some(t) => {
                out = out.replace(&needle, &format!("({t})"));
                out = out.replace(caminho, t);
            }
            None => {
                out = out.replace(&needle, "");
                out = out.replace(caminho, "");
            }
        }
    }
    out
}

// Merge promoted prose into context.md: under section 6 for mode "hotspot", else
// appended at the end.
fn merge_prose(md: &str, block: &str, mode: &str) -> String {
    if mode == "hotspot" {
        if let Some(pos) = md.find("\n## 6") {
            let after_heading = md[pos + 1..]
                .find('\n')
                .map(|i| pos + 1 + i + 1)
                .unwrap_or(md.len());
            let mut out = String::new();
            out.push_str(&md[..after_heading]);
            out.push('\n');
            out.push_str(block.trim());
            out.push('\n');
            out.push_str(&md[after_heading..]);
            return out;
        }
    }
    let mut out = md.trim_end().to_string();
    out.push_str("\n\n");
    out.push_str(block.trim());
    out.push('\n');
    out
}

fn append_changelog(path: &Path, entry: &str) -> Result<(), String> {
    let cur = std::fs::read_to_string(path).unwrap_or_default();
    let mut out = cur.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(entry.trim());
    out.push('\n');
    std::fs::write(path, out).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn promote(
    base: &Path,
    source_rel: &str,
    dest_context: &str,
    mode: &str,
    branch: &str,
    today: &str,
) -> Result<PromoteReport, String> {
    let source_abs = guarded_existing(base, source_rel)?;
    if !source_abs.is_file() {
        return Err("err.invalid_origin".into());
    }
    if !valid_context(dest_context) {
        return Err("err.invalid_target_context".into());
    }
    let ctx_dir = base.join("contexts").join(dest_context);
    let ctx_md = ctx_dir.join("context.md");
    if !ctx_md.is_file() {
        return Err("err.target_context_not_found".into());
    }
    let ref_dir = ctx_dir.join("referencias");

    let content = std::fs::read_to_string(&source_abs).map_err(|e| e.to_string())?;
    let (fm_opt, body) = split_front_matter(&content);
    let refs = fm_opt.as_deref().map(parse_refs).unwrap_or_default();

    let mut staged: Vec<String> = Vec::new();
    let mut rewritten: Vec<RewrittenRef> = Vec::new();
    // (ref id, Some(referencias-relative link) | None=drop, original caminho)
    let mut prose_rewrites: Vec<(String, Option<String>, String)> = Vec::new();

    for r in &refs {
        let resolved = resolve_ref(base, source_rel, &r.caminho);
        let rel = match resolved {
            Ok(rr) => rr.rel,
            Err(_) => {
                prose_rewrites.push((r.id.clone(), None, r.caminho.clone()));
                continue;
            }
        };
        let fname = rel.rsplit('/').next().unwrap_or(&rel).to_string();

        if is_promotion_denied(&fname) {
            if is_audio(&fname) {
                // Audio is promoted as a text stub only — NEVER the audio bytes,
                // and the stub carries no pessoal/ path.
                let stub_name = format!("{fname}.txt");
                std::fs::create_dir_all(&ref_dir).map_err(|e| e.to_string())?;
                let stub_path = ref_dir.join(&stub_name);
                if !stub_path.exists() {
                    let stub = format!(
                        "Referência de áudio (não versionada — mantida na produção individual).\nArquivo: {fname}\n"
                    );
                    std::fs::write(&stub_path, stub).map_err(|e| e.to_string())?;
                }
                let to = format!("referencias/{stub_name}");
                staged.push(format!("contexts/{dest_context}/referencias/{stub_name}"));
                rewritten.push(RewrittenRef {
                    from: r.caminho.clone(),
                    to: to.clone(),
                });
                prose_rewrites.push((r.id.clone(), Some(to), r.caminho.clone()));
            } else {
                // auditoria/meta/manifest: never copied; drop the dangling link.
                prose_rewrites.push((r.id.clone(), None, r.caminho.clone()));
            }
            continue;
        }

        // Allowed asset: copy into referencias/ (deduped by content hash).
        let src = base.join(&rel);
        if !src.is_file() {
            prose_rewrites.push((r.id.clone(), None, r.caminho.clone()));
            continue;
        }
        let bytes = std::fs::read(&src).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&ref_dir).map_err(|e| e.to_string())?;
        let (target_name, need_write) = dedup_target(&ref_dir, &fname, &bytes);
        if need_write {
            std::fs::write(ref_dir.join(&target_name), &bytes).map_err(|e| e.to_string())?;
        }
        let to = format!("referencias/{target_name}");
        staged.push(format!("contexts/{dest_context}/referencias/{target_name}"));
        rewritten.push(RewrittenRef {
            from: r.caminho.clone(),
            to: to.clone(),
        });
        prose_rewrites.push((r.id.clone(), Some(to), r.caminho.clone()));
    }

    // Merge prose (with rewritten refs) into context.md.
    let title = notebook_title(source_rel, &body);
    let prose = rewrite_prose(&body, &prose_rewrites);
    let block = format!("### {title} — promovido em {today}\n\n{}", prose.trim());
    let merged = merge_prose(&content_of(&ctx_md)?, &block, mode);
    std::fs::write(&ctx_md, merged).map_err(|e| e.to_string())?;
    staged.push(format!("contexts/{dest_context}/context.md"));

    // CHANGELOG entry.
    let changelog_entry = format!(
        "## {today} — promovido: {title}\n\nConteúdo promovido da produção pessoal para o contexto `{dest_context}`."
    );
    append_changelog(&ctx_dir.join("CHANGELOG.md"), &changelog_entry)?;
    staged.push(format!("contexts/{dest_context}/CHANGELOG.md"));

    // Stamp the source (stays in pessoal/, never moved/committed here).
    let stamped = stamp_promovido(&content, dest_context, branch, today);
    std::fs::write(&source_abs, stamped).map_err(|e| e.to_string())?;

    Ok(PromoteReport {
        slug: dest_context.to_string(),
        staged_files: staged,
        rewritten_refs: rewritten,
        changelog_entry,
    })
}

fn content_of(p: &Path) -> Result<String, String> {
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

// ---- brainstorming → fila (ADR-0014) ----------------------------------------
//
// The user selects REAL files of a brainstorming (a meeting's report, a note, an
// analysis, an attachment) and each one is sent to the fila (inbox/) AS ITSELF —
// one queue item per file, no consolidated report (supersedes ADR-0013's single
// merged relatorio). The raw meeting transcript (`reuniao.md`), the content-bearing
// audit and any audio NEVER enter the queue (BR-8) — see `is_queueable`.

// A brainstorming file may enter the fila only when it is text (`.md`/`.txt`) and
// is not the living notebook `reuniao.md` (which carries the transcript, BR-8).
// Audio and `audit.jsonl` are non-text, so the text-only gate already excludes
// them. Pure; expects an acervo-relative, forward-slash path.
pub(crate) fn is_queueable(rel: &str) -> bool {
    let r = rel.replace('\\', "/");
    if !(r.ends_with(".md") || r.ends_with(".txt")) {
        return false;
    }
    let leaf = r.rsplit('/').next().unwrap_or(&r);
    // both names of the living transcript: an acervo written before ADR-0026 §14
    // still carries the old one, and it must keep being excluded
    leaf != crate::meeting::LIVING_FILE && leaf != "reuniao.md" && leaf != "audit.jsonl"
}

// The inbox filename for a queued brainstorming file: the brainstorming-relative
// path flattened (`/` -> `-`) so files sharing a basename never collide, e.g.
// `brainstorming/frota/meetings/r1/relatorio.md` -> `frota-reunioes-r1-relatorio.md`.
// Pure.
pub(crate) fn queue_name_for(rel: &str) -> String {
    rel.replace('\\', "/")
        .trim_start_matches("brainstorming/")
        .replace('/', "-")
}

// Every queueable file of a brainstorming (for "enviar tudo → fila"): a meeting's
// analyses (`meetings/<id>/notes/*`), plus the brainstorming's own `notes/` and
// `attachments/`. `reuniao.md`/audio/audit are excluded by `is_queueable`; legacy
// consolidated reports (`*-relatorio.md`) are skipped.
//
// ADR-0018: a meeting resolves to its `notes/*` and nothing else — the analysis
// IS the meeting's output, so a meeting nobody analysed contributes zero items
// rather than an empty placeholder.
pub(crate) fn queueable_files(base: &Path, slug: &str) -> Vec<String> {
    let root = brainstorming_dir(base).join(slug);
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root.join("meetings")) {
        for e in rd.flatten().filter(|e| e.path().is_dir()) {
            let id = e.file_name().to_string_lossy().to_string();
            out.extend(meeting_queueables(
                base,
                &format!("brainstorming/{slug}/meetings/{id}"),
            ));
        }
    }
    for sub in ["notes", "attachments"] {
        if let Ok(rd) = std::fs::read_dir(root.join(sub)) {
            for e in rd.flatten().filter(|e| e.path().is_file()) {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with('.') || n.ends_with("-relatorio.md") {
                    continue;
                }
                let rel = format!("brainstorming/{slug}/{sub}/{n}");
                if is_queueable(&rel) {
                    out.push(rel);
                }
            }
        }
    }
    out
}

// Minimal read of a meeting manifest (titulo only) — no marker/transcript field
// is ever deserialized here, so no transcript text can be read.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MeetingManifestLite {
    #[serde(default)]
    titulo: String,
    #[serde(default)]
    status: String,
}

// ---- Tauri commands (thin wrappers) -----------------------------------------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBrainstormInput {
    rel: String,
}

// Emit the change notifications for the Brainstorming world: the new
// `brainstorming-changed` plus the legacy `pessoal-changed`/`tema-changed`, kept
// in parallel for one release so the frontend can migrate its listeners.
fn emit_brainstorming_changed(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit("brainstorming-changed", payload.clone());
    let _ = app.emit("pessoal-changed", payload.clone());
    let _ = app.emit("tema-changed", payload);
}

// Delete a brainstorming item — a file, a meeting folder, or a whole brainstorming
// — under brainstorming/. STRICTLY confined to that world (never a versioned
// contexts/ path) and path-guarded (canonicalize + starts_with base + starts_with
// brainstorming/). The legacy `pessoal/` prefix is still accepted so un-migrated
// acervos can prune. Recursive for folders.
// ADR-0026 §14 — the frontend used to build `<tema>/indice.md` by hand, in three
// places. With two possible names the caller cannot guess: it asks, and the
// answer is the file that EXISTS (never a path that does not).
#[tauri::command]
pub fn brain_topic_doc(rel: String) -> Result<String, String> {
    let base = acervo_base()?;
    let rel = normalize_rel(&rel)?;
    let dir = base.join(&rel);
    if !dir.is_dir() {
        return Err("err.not_found".into());
    }
    let leaf = topic_doc_of(&dir);
    let name = leaf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(TOPIC_DOC);
    Ok(format!("{rel}/{name}"))
}

#[tauri::command]
pub fn brain_brainstorm_delete(app: AppHandle, input: DeleteBrainstormInput) -> Result<(), String> {
    let rel = input.rel.replace('\\', "/");
    let world = if rel.starts_with("brainstorming/") {
        "brainstorming"
    } else if rel.starts_with("pessoal/") {
        "pessoal"
    } else {
        return Err("err.brainstorm_delete_only".into());
    };
    if rel.contains("..") {
        return Err("err.invalid_path".into());
    }
    let base = acervo_base()?;
    let p = guarded_existing(&base, &rel)?;
    if !p.starts_with(base.join(world)) {
        return Err("err.outside_brainstorm".into());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    emit_brainstorming_changed(&app, serde_json::json!({ "rel": rel }));
    Ok(())
}

// Rename a brainstorming FILE (note / analysis artifact) in place. Same world
// confinement as delete (never a versioned contexts/ path); the new name is a
// bare filename — the original extension is kept when the user omits one.
// Returns the new acervo-relative path. Pure core, testable without Tauri.
pub(crate) fn rename_pessoal_file(base: &Path, rel: &str, name: &str) -> Result<String, String> {
    let rel = rel.replace('\\', "/");
    let world = if rel.starts_with("brainstorming/") {
        "brainstorming"
    } else if rel.starts_with("pessoal/") {
        "pessoal"
    } else {
        return Err("err.outside_brainstorm".into());
    };
    if rel.contains("..") {
        return Err("err.invalid_path".into());
    }
    let p = guarded_existing(base, &rel)?;
    if !p.starts_with(base.join(world)) {
        return Err("err.outside_brainstorm".into());
    }
    if !p.is_file() {
        return Err("err.not_found".into());
    }
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("err.invalid_file_name".into());
    }
    let mut newname = name.to_string();
    if !newname.contains('.') {
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            newname.push('.');
            newname.push_str(ext);
        }
    }
    let dest = p.parent().ok_or("err.invalid_path")?.join(&newname);
    if dest.exists() {
        return Err("err.file_exists_in_target".into());
    }
    std::fs::rename(&p, &dest).map_err(|e| e.to_string())?;
    let parent_rel = rel.rsplit_once('/').map(|(a, _)| a).unwrap_or("");
    Ok(format!("{parent_rel}/{newname}"))
}

#[tauri::command]
pub fn brain_rename_pessoal(app: AppHandle, rel: String, name: String) -> Result<String, String> {
    let base = acervo_base()?;
    let new_rel = rename_pessoal_file(&base, &rel, &name)?;
    emit_brainstorming_changed(&app, serde_json::json!({ "rel": new_rel }));
    Ok(new_rel)
}

// #44 — a moved meeting leaves inbound references pointing nowhere: `refs:`
// entries in other documents and `acervo://` anchors (ADR-0007) still name the old
// path, and `resolve_ref` starts reporting `exists: false`. Rewrite the prefix
// instead of leaving silent rot — the promote flow already rewrites or drops
// dangling links rather than shipping them.
//
// Pure so the substitution is unit-covered. Only whole path SEGMENTS match, so
// `.../meetings/m1` never rewrites `.../meetings/m10`.
pub(crate) fn retarget_refs_in_content(content: &str, old_rel: &str, new_rel: &str) -> String {
    let old = old_rel.trim_end_matches('/');
    let new = new_rel.trim_end_matches('/');
    if old.is_empty() || old == new {
        return content.to_string();
    }
    // Only a whole SEGMENT match counts, so `.../m1` never rewrites `.../m10`.
    let ends_segment = |s: &str| {
        s.is_empty()
            || s.starts_with('/')
            || s.starts_with('#')
            || s.starts_with(|c: char| {
                c.is_whitespace() || matches!(c, ')' | '"' | '\'' | '`' | '}' | ',' | ']' | ';')
            })
    };
    let swap = |hay: &str, needle_prefix: &str| -> Option<String> {
        let needle = format!("{needle_prefix}{old}");
        let mut out = String::with_capacity(hay.len());
        let mut rest = hay;
        let mut hit = false;
        while let Some(at) = rest.find(&needle) {
            let after = &rest[at + needle.len()..];
            out.push_str(&rest[..at]);
            if ends_segment(after) {
                out.push_str(&format!("{needle_prefix}{new}"));
                hit = true;
            } else {
                out.push_str(&needle);
            }
            rest = after;
        }
        out.push_str(rest);
        if hit {
            Some(out)
        } else {
            None
        }
    };
    content
        .split('\n')
        .map(|line| {
            let mut out = line.to_string();
            // `caminho: <rel>` (a ref entry, usually a `- ` list item) and any
            // `acervo://<rel>` anchor in prose (ADR-0007).
            for prefix in ["caminho: ", "acervo://"] {
                if let Some(next) = swap(&out, prefix) {
                    out = next;
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// Walk the NON-VERSIONED worlds plus the acervo's own habilidades, and retarget
// every inbound reference to a moved meeting. `contexts/` is deliberately
// excluded: it is the versioned tree, whose edits go through a branch (ADR-0002),
// and `move_pessoal_file` already refuses it on both ends. Rewriting a context's
// CHANGELOG in place would falsify history.
//
// `.claude/commands/` is IN: a custom habilidade (ADR-0005 §E) may be aimed at an
// excerpt through an `acervo://<rel>#<annot-id>` anchor (ADR-0007), and a tool
// pointing at a meeting that moved is exactly the dangling ref this walk exists
// to prevent. The built-ins there carry only literal `acervo://<caminho>`
// placeholders, which match no real rel.
//
// The walk does not follow symlinks and is depth-bounded: a cycle would otherwise
// recurse until the stack overflows, which aborts the process — and this runs
// AFTER the rename, so the app would die with the meeting already moved.
// Best-effort per file: an unreadable document never undoes a completed move.
fn retarget_refs_after_move(base: &Path, old_rel: &str, new_rel: &str) -> usize {
    const MAX_DEPTH: usize = 12;
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(meta) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                walk(&p, depth + 1, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    for world in ["brainstorming", "pessoal", ".claude/commands"] {
        walk(&base.join(world), 0, &mut files);
    }
    let mut n = 0;
    for f in files {
        // A document that belongs to a meeting is rewritten under THAT meeting's
        // lock: `reuniao.md` may be receiving a transcript chunk right now, and a
        // read-modify-write without the lock silently drops it.
        let owner = meeting_id_of(base, &f).map(|id| crate::meeting::lock_for(&id));
        let _guard = owner.as_ref().map(|l| l.lock());
        let Ok(txt) = std::fs::read_to_string(&f) else {
            continue;
        };
        let out = retarget_refs_in_content(&txt, old_rel, new_rel);
        if out == txt {
            continue;
        }
        match std::fs::write(&f, out) {
            Ok(()) => n += 1,
            // never silent: a refused write leaves the acervo PARTLY retargeted,
            // and only the successes were being reported. The path is logged
            // acervo-relative — never absolute, which carries the user's home.
            Err(e) => {
                let rel = f.strip_prefix(base).unwrap_or(f.as_path());
                error!(file = %rel.display(), error = %e, "inbound reference not retargeted")
            }
        }
    }
    n
}

// The meeting that owns a file, if any: `…/meetings/<id>/…`. Used to take the
// right lock before rewriting someone else's living document. A file sitting
// directly in `meetings/` belongs to no meeting — hence the segment AFTER the id.
fn meeting_id_of(base: &Path, f: &Path) -> Option<String> {
    let rel = f
        .strip_prefix(base)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let segs: Vec<&str> = rel.split('/').collect();
    let at = segs.iter().position(|s| *s == "meetings")?;
    (segs.len() > at + 2).then(|| segs[at + 1].to_string())
}

// #44 — move a WHOLE meeting into another brainstorming's `meetings/`.
//
// `move_pessoal_file` demands `src.is_file()` and cannot serve: a meeting is the
// directory `meetings/<id>/` (ADR-0008/0010). Moving is a rename of the DIRECTORY,
// which is why the analysis, the audio, the transcript and the audit travel
// together without anything re-enumerating the folder — nothing here rebuilds the
// BR-8 gate (`is_queueable`), which stays the fila's business alone (hotspot #46).
//
// The destination is always `brainstorming/<slug>/meetings/`: `list_meetings`
// scans exactly that path, so anywhere else the meeting would vanish from the UI.
// An `<id>` collision refuses instead of overwriting, as ADR-0009 decided for files.
pub(crate) fn move_meeting_dir(base: &Path, rel: &str, dest_slug: &str) -> Result<String, String> {
    let rel = rel.replace('\\', "/");
    if rel.contains("..") {
        return Err("err.invalid_path".into());
    }
    // The destination must be a real brainstorming slug. Empty, "." or a path
    // fragment used to slip through every later guard: `brainstorming/` itself is
    // a directory, so the meeting was renamed into a phantom
    // `brainstorming/meetings/` and `resolve_meeting_dir` could never find it
    // again — analisar, relatório and apagar all failed with err.meeting_not_found.
    // `avulso` is excluded on purpose: it holds loose files, not brainstormings.
    if dest_slug.is_empty()
        || dest_slug == "avulso"
        || sanitize_slug(dest_slug).ok().as_deref() != Some(dest_slug)
    {
        return Err("err.invalid_path".into());
    }
    let world_of = |p: &str| -> Option<&'static str> {
        if p == "brainstorming" || p.starts_with("brainstorming/") {
            Some("brainstorming")
        } else if p == "pessoal" || p.starts_with("pessoal/") {
            Some("pessoal")
        } else {
            None
        }
    };
    let src_world = world_of(&rel).ok_or("err.outside_brainstorm")?;

    let src = guarded_existing(base, &rel)?;
    // Re-check confinement AFTER canonicalize: a symlink under the brainstorming
    // tree would otherwise carry the transcript and the audio into the versioned
    // world, which BR-1 and `meeting_stays_under_brainstorming_and_is_never_versioned`
    // exist to prevent. The string prefix alone is not a guard.
    if !src.starts_with(base.join(src_world)) {
        return Err("err.outside_brainstorm".into());
    }
    // a meeting is a FOLDER carrying a manifest — the same mark `list_meetings` uses
    if !src.is_dir() || !src.join("manifest.json").is_file() {
        return Err("err.not_found".into());
    }

    let id = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("err.invalid_path")?
        .to_string();
    let dest_dir_rel = format!("brainstorming/{dest_slug}/meetings");
    // An older brainstorming may have no `meetings/` yet; create it on demand
    // rather than offering a destination that fails (create_meeting does the same).
    let brainstorm = guarded_existing(base, &format!("brainstorming/{dest_slug}"))?;
    if !brainstorm.starts_with(base.join("brainstorming")) {
        return Err("err.outside_brainstorm".into());
    }
    if !brainstorm.is_dir() {
        return Err("err.not_found".into());
    }
    std::fs::create_dir_all(brainstorm.join("meetings")).map_err(|e| e.to_string())?;
    let dest_dir = guarded_existing(base, &dest_dir_rel)?;
    if !dest_dir.starts_with(base.join("brainstorming")) {
        return Err("err.outside_brainstorm".into());
    }
    let dest = dest_dir.join(&id);
    if dest.exists() {
        return Err("err.file_exists_in_target".into());
    }

    // A meeting still recording must not move: `brain_meeting_append` would write
    // into a path that no longer exists. Refused in the backend, not only in the
    // menu, because drag-and-drop is a second door into the same command.
    if crate::meeting::status_of(&src)? != "done" {
        return Err("err.meeting_not_finished".into());
    }

    let old_rel = normalize_rel(&rel)?;
    let new_rel = normalize_rel(&format!("{dest_dir_rel}/{id}"))?;

    // The rename and the meeting's own metadata rewrite share its lock, so the
    // two halves of the move are never seen apart, and a concurrent command
    // waits and then resolves the NEW path (every mutating meeting command
    // resolves its directory only after taking this lock).
    //
    // Scoped: `retarget_refs_after_move` below locks the meetings whose
    // documents it rewrites, and this meeting's own documents are among them —
    // the mutex is not reentrant, so holding it there would deadlock.
    {
        let lock = crate::meeting::lock_for(&id);
        let _guard = lock.lock().map_err(|_| "err.lock_poisoned".to_string())?;
        std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
        // DEC-1 (owner, 2026-08-08). Best-effort AFTER the rename: the move
        // already happened and must not be reported as a failure, so a broken
        // manifest is logged and the command still succeeds with the new rel.
        if let Err(e) = crate::meeting::remap_meeting_locked(&dest, dest_slug, &old_rel, &new_rel) {
            error!(meeting = %id, error = %e, "meeting moved but its metadata was not rewritten");
        }
    }

    let touched = retarget_refs_after_move(base, &old_rel, &new_rel);
    if touched > 0 {
        info!(meeting = %id, files = touched, "retargeted inbound references");
    }
    Ok(new_rel)
}

// Move a brainstorming FILE into another folder of the same non-versioned world.
// The filename is preserved; a name already taken at the destination refuses
// instead of overwriting. Mirrors `rename_pessoal_file`'s confinement (ADR-0009).
pub(crate) fn move_pessoal_file(base: &Path, rel: &str, dest_dir: &str) -> Result<String, String> {
    let rel = rel.replace('\\', "/");
    let dest_dir = dest_dir
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let world_of = |p: &str| -> Option<&'static str> {
        if p == "brainstorming" || p.starts_with("brainstorming/") {
            Some("brainstorming")
        } else if p == "pessoal" || p.starts_with("pessoal/") {
            Some("pessoal")
        } else {
            None
        }
    };
    let src_world = world_of(&rel).ok_or("err.outside_brainstorm")?;
    let dst_world = world_of(&dest_dir).ok_or("err.outside_brainstorm")?;
    if rel.contains("..") || dest_dir.contains("..") {
        return Err("err.invalid_path".into());
    }
    let src = guarded_existing(base, &rel)?;
    if !src.starts_with(base.join(src_world)) {
        return Err("err.outside_brainstorm".into());
    }
    if !src.is_file() {
        return Err("err.not_found".into());
    }
    let dst = guarded_existing(base, &dest_dir)?;
    if !dst.starts_with(base.join(dst_world)) {
        return Err("err.outside_brainstorm".into());
    }
    if !dst.is_dir() {
        return Err("err.not_found".into());
    }
    let fname = src.file_name().ok_or("err.invalid_path")?;
    let dest = dst.join(fname);
    if dest.exists() {
        return Err("err.file_exists_in_target".into());
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    normalize_rel(&format!("{dest_dir}/{}", fname.to_string_lossy()))
}

#[tauri::command]
pub fn brain_move_pessoal(app: AppHandle, rel: String, dest_dir: String) -> Result<String, String> {
    let base = acervo_base()?;
    let new_rel = move_pessoal_file(&base, &rel, &dest_dir)?;
    emit_brainstorming_changed(&app, serde_json::json!({ "rel": new_rel }));
    Ok(new_rel)
}

// #44 — move a whole meeting into another brainstorming's `meetings/`.
#[tauri::command]
pub fn brain_move_meeting(
    app: AppHandle,
    rel: String,
    dest_slug: String,
) -> Result<String, String> {
    let base = acervo_base()?;
    let new_rel = move_meeting_dir(&base, &rel, &dest_slug)?;
    emit_brainstorming_changed(&app, serde_json::json!({ "rel": new_rel }));
    Ok(new_rel)
}

// Resolve an acervo-relative path to its absolute on-disk path (guarded to the
// acervo root). Backs the sidebar "copy absolute path" action — the relative
// path the UI already holds needs no backend round-trip.
#[tauri::command]
pub fn brain_abs_path(rel: String) -> Result<String, String> {
    let base = acervo_base()?;
    let p = guarded_existing(&base, &rel)?;
    Ok(p.to_string_lossy().to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBrainstormInput {
    nome: String,
    #[serde(default)]
    categoria: Option<String>,
}

#[tauri::command]
pub fn brain_create_brainstorm(
    app: AppHandle,
    input: CreateBrainstormInput,
) -> Result<BrainstormingRef, String> {
    let base = acervo_base()?;
    let t = create_brainstorming(&base, &input.nome, input.categoria.as_deref(), &today_iso())?;
    emit_brainstorming_changed(&app, serde_json::json!({ "slug": t.slug, "rel": t.rel }));
    Ok(t)
}

#[tauri::command]
pub fn brain_list_brainstorms() -> Result<Vec<BrainstormingListItem>, String> {
    Ok(list_brainstormings(&acervo_base()?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCategoryInput {
    slug: String,
    #[serde(default)]
    categoria: Option<String>,
}

#[tauri::command]
pub fn brain_set_brainstorm_category(
    app: AppHandle,
    input: SetCategoryInput,
) -> Result<(), String> {
    let base = acervo_base()?;
    set_category(&base, &input.slug, input.categoria.as_deref())?;
    emit_brainstorming_changed(&app, serde_json::json!({ "slug": input.slug }));
    Ok(())
}

// Rename a brainstorming (folder + meta `nome`), following the contextos rename
// pattern. Non-destructive: refuses if the target slug already exists.
#[tauri::command]
pub fn brain_rename_brainstorm(
    app: AppHandle,
    slug: String,
    nome: String,
) -> Result<BrainstormingRef, String> {
    let base = acervo_base()?;
    if !valid_context(&slug) {
        return Err("err.invalid_brainstorm".into());
    }
    let from = brainstorming_dir(&base).join(&slug);
    if !from.is_dir() {
        return Err("err.brainstorm_not_found".into());
    }
    let new_slug = sanitize_slug(&nome)?;
    let to = brainstorming_dir(&base).join(&new_slug);
    if new_slug != slug && to.exists() {
        return Err("err.brainstorm_exists".into());
    }
    if new_slug != slug {
        std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    }
    // refresh meta `nome` (display) and slug key
    let mut m = read_meta(&to);
    m.nome = nome.trim().to_string();
    m.tema = new_slug.clone();
    let _ = std::fs::write(
        to.join("meta.json"),
        serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?,
    );
    let rel = format!("brainstorming/{new_slug}");
    emit_brainstorming_changed(&app, serde_json::json!({ "slug": new_slug, "rel": rel }));
    Ok(BrainstormingRef {
        slug: new_slug,
        rel,
    })
}

#[tauri::command]
pub fn brain_new_notebook(
    app: AppHandle,
    tema: Option<String>,
    titulo: String,
) -> Result<String, String> {
    let base = acervo_base()?;
    let rel = new_notebook(&base, tema.as_deref(), &titulo, &today_iso())?;
    emit_brainstorming_changed(&app, serde_json::json!({ "rel": rel }));
    Ok(rel)
}

#[tauri::command]
pub fn brain_read_asset(rel: String) -> Result<Asset, String> {
    read_asset(&acervo_base()?, &rel)
}

// Open a non-renderable local file (wav/webm/pdf/xlsx…) in the OS default app.
// Restricted to inside the acervo root; fixed args, no shell (macOS `open`).
#[tauri::command]
pub fn brain_open_external(rel: String) -> Result<(), String> {
    let base = acervo_base()?;
    let p = guarded_existing(&base, &rel)?;
    crate::proc::command("open")
        .arg(&p)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// An external ref (loro-sync, e.g. a Drive doc link) and a review on GitHub are
// only ever http(s) — never a local path, shell metacharacter, or other scheme
// (js:, file:, …). Whitespace and control characters are refused as well: this
// URL is the only caller-supplied token in the spawn below, so it stays a single
// argument that no argument splitter can break in two.
fn is_openable_link(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("https://"))
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

// The OS's own "open this URL in the default browser". Never through a shell:
// `cmd /C start` would hand a caller-supplied URL to the command interpreter, so
// Windows invokes the protocol handler directly instead (ADR-0001 §5, BR-9 — no
// credential is ever part of a link the app opens).
fn open_url_cmd(url: &str) -> (&'static str, Vec<String>) {
    if cfg!(target_os = "windows") {
        (
            "rundll32.exe",
            vec!["url.dll,FileProtocolHandler".into(), url.into()],
        )
    } else {
        ("open", vec![url.into()])
    }
}

// Open an external link (a Drive doc from a `tipo: drive` ref, the review a
// change was sent to) in the OS default browser. Restricted to http(s); fixed
// args, no shell.
#[tauri::command]
pub fn brain_open_link(url: String) -> Result<(), String> {
    if !is_openable_link(&url) {
        return Err("err.unsupported_link_scheme".into());
    }
    let (bin, args) = open_url_cmd(&url);
    crate::proc::command(bin)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn brain_resolve_ref(source_rel: String, r#ref: String) -> Result<RefResolution, String> {
    resolve_ref(&acervo_base()?, &source_rel, &r#ref)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRefInput {
    tipo: String,
    caminho: String,
    #[serde(default)]
    id: Option<String>,
}

#[tauri::command]
pub fn brain_add_ref(
    app: AppHandle,
    source_rel: String,
    reference: AddRefInput,
) -> Result<String, String> {
    let base = acervo_base()?;
    let p = guarded_existing(&base, &source_rel)?;
    let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let (out, id) = add_ref_to_content(
        &content,
        &reference.tipo,
        &reference.caminho,
        reference.id.as_deref(),
    );
    std::fs::write(&p, out).map_err(|e| e.to_string())?;
    let _ = app.emit("pessoal-changed", serde_json::json!({ "rel": source_rel }));
    Ok(id)
}

// ADR-0013: `brain_promote` (direct personal->context copy) is NO LONGER on the
// primary path — the fila (brain_send_files_to_queue -> /loro-context) is THE
// route brainstorming -> contexto, and the UI no longer calls this. Kept + tested
// as an internal capability; do not surface it as a competing user action.
#[tauri::command]
pub fn brain_promote(
    app: AppHandle,
    source_rel: String,
    dest_context: String,
    mode: String,
) -> Result<PromoteReport, String> {
    let base = acervo_base()?;
    // best-effort branch label for the source stamp (empty when no git repo)
    let branch = crate::git::current_branch(&base).unwrap_or_default();
    let report = promote(
        &base,
        &source_rel,
        &dest_context,
        &mode,
        &branch,
        &today_iso(),
    )?;
    let _ = app.emit(
        "promotion-done",
        serde_json::json!({ "slug": report.slug, "destContext": dest_context }),
    );
    Ok(report)
}

// ---- knowledge graph (ADR-0026) ---------------------------------------------
//
// The lateral links between contexts are knowledge, not decoration: a context
// cited by many is a central context, and a context nobody cites is knowledge no
// flow depends on. Both facts are DERIVED ON READ. Nothing in this section writes
// to disk — the acervo is versioned, so a generated index file or a renumbered id
// would be a one-way door (ADR-0024's lesson, applied to reading).
//
// BR-8: every string below comes from `contexts/**/context.md`, the versioned
// knowledge document. No meeting, transcript or audit file is ever opened here,
// so none of them can reach a graph, a backlink or an index entry.

// The knowledge document of a context; `guia.md` is the legacy name the reader
// still resolves (see `context_file` in lib.rs).
const CONTEXT_DOC_NAMES: [&str; 2] = ["context.md", "guia.md"];

// The main markdown of a brainstorming topic (ADR-0026 §14: generated in English;
// `indice.md` is the name earlier versions wrote and is still read).
pub const TOPIC_DOC: &str = "index.md";
pub const TOPIC_DOC_LEGACY: &str = "indice.md";

// The topic document of a directory, new name first.
pub fn topic_doc_of(dir: &Path) -> PathBuf {
    let legacy = dir.join(TOPIC_DOC_LEGACY);
    if legacy.is_file() {
        return legacy;
    }
    dir.join(TOPIC_DOC)
}

// How far after a link the edge kind may sit. ADR-0026 asks for the word right
// after the link; a whole sentence would let an unrelated "upstream" three
// clauses later type an edge that was never described.
const KIND_WINDOW: usize = 40;

#[derive(Clone, Debug, PartialEq)]
enum LinkTarget {
    // Nothing on disk backs it: the web, an e-mail, an anchor inside this file.
    NotAPath,
    // An acervo-root-relative path (the target may or may not exist).
    Internal(String),
    // Meant to be a path but unusable: absolute, or escaping the acervo root.
    Unresolvable,
}

#[derive(Clone, Debug)]
struct DocLink {
    label: String,
    // as the author typed it — the string they have to fix when it is broken
    raw: String,
    target: LinkTarget,
    kind: String,
    section: String,
}

#[derive(Clone, Debug)]
struct DocHotspot {
    id: String,
}

#[derive(Clone, Debug)]
struct ContextDoc {
    rel: String,
    context: String,
    title: String,
    hotspots: Vec<DocHotspot>,
    decisions: Vec<String>,
    codes: Vec<String>,
    links: Vec<DocLink>,
}

// ---- parsing (pure) ---------------------------------------------------------

// The acervo's mold numbers every section (0 Sumário … 6 Hotspots), so `§2` is an
// address the author already wrote — no heading text is invented from prose.
fn section_of(heading: &str) -> String {
    let t = heading.trim_start_matches('#').trim_start();
    let n: String = t.chars().take_while(char::is_ascii_digit).collect();
    if n.is_empty() {
        String::new()
    } else {
        format!("§{n}")
    }
}

// `## 3 · Fluxos` -> Some("3 · Fluxos"); anything else is body text.
fn heading_text(line: &str) -> Option<(usize, &str)> {
    let t = line.trim_start();
    let level = t.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = t.get(level..)?;
    rest.starts_with([' ', '\t']).then(|| (level, rest.trim()))
}

// `> [!HOTSPOT] H-<n> — título` (the marker the knowledge template writes).
fn hotspot_of(line: &str) -> Option<DocHotspot> {
    let t = line.trim_start().strip_prefix('>')?.trim_start();
    if !t.to_ascii_uppercase().starts_with("[!HOTSPOT]") {
        return None;
    }
    let rest = t.get("[!HOTSPOT]".len()..)?.trim_start();
    let id_end = rest
        .find(char::is_whitespace)
        .unwrap_or(rest.len())
        .min(rest.len());
    let id = &rest[..id_end];
    // ADR-0026 §15 — the id is a NAME taken from the title (`cancelamento-cdc`),
    // so it stays unique once qualified by its context and can be cited from
    // anywhere. `H-<n>` is still read: it is what an acervo written earlier has,
    // and its numbering is local to the file, which is the defect this replaces.
    let followed_by_dash = rest[id_end..].trim_start().starts_with(['—', '–', '-']);
    let named = !id.is_empty()
        && followed_by_dash
        && id.starts_with(|c: char| c.is_ascii_alphabetic())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !named {
        return None;
    }
    Some(DocHotspot { id: id.to_string() })
}

// ADR-0004 — `D-AAAA-MM-DD-<slug>`, already in the prose; this only finds it.
fn is_decision_id(w: &str) -> bool {
    let Some(rest) = w.strip_prefix("D-") else {
        return false;
    };
    let b = rest.as_bytes();
    b.len() > 11
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && b[10] == b'-'
}

// The same locator the reader sees (`MM-1147`). The two-character minimum on the
// prefix is what keeps it from swallowing the acervo's OWN ids — `H-3` and
// `D-2026-…` both open with a single letter. Mirrors text.js's LOCATOR.
fn is_external_code(w: &str) -> bool {
    let Some((prefix, number)) = w.split_once('-') else {
        return false;
    };
    (2..=5).contains(&prefix.len())
        && prefix.starts_with(|c: char| c.is_ascii_uppercase())
        && prefix
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && (1..=6).contains(&number.len())
        && number.chars().all(|c| c.is_ascii_digit())
}

// The slug is the name the author gave the decision; the date prefix is an
// address, not a word.

// `https:`, `mailto:`, `slack:` — the test is the scheme itself, not a list of
// the ones seen so far, because the lint must never call somebody else's address
// space a dead end.
fn has_url_scheme(t: &str) -> bool {
    let Some((scheme, _)) = t.split_once(':') else {
        return false;
    };
    scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

// Where a link points, resolved against the document that carries it — the same
// rules `resolve_ref` applies to a reference (`acervo://` anchored or relative,
// never absolute, never escaping the root).
fn resolve_target(source_rel: &str, raw: &str) -> LinkTarget {
    let t = raw.trim().trim_matches(['<', '>']);
    // markdown allows `(path "title")`; the path is the first word
    let t = t.split_whitespace().next().unwrap_or_default();
    let t = t.split('#').next().unwrap_or_default();
    let path = match t.strip_prefix("acervo://") {
        Some(anchored) => anchored.to_string(),
        None => {
            // empty: an anchor inside this very document
            if t.is_empty() || has_url_scheme(t) {
                return LinkTarget::NotAPath;
            }
            if t.starts_with('/') {
                return LinkTarget::Unresolvable;
            }
            match source_rel.rsplit_once('/') {
                Some((dir, _)) => format!("{dir}/{t}"),
                None => t.to_string(),
            }
        }
    };
    match normalize_rel(&path) {
        Ok(rel) if !rel.is_empty() => LinkTarget::Internal(rel),
        _ => LinkTarget::Unresolvable,
    }
}

struct RawLink {
    label: String,
    raw: String,
    kind: String,
}

// One word, right after the link. Both spellings of the two-way edge collapse to
// the pt-BR one so the JS has a single vocabulary to switch on.
fn kind_after(tail: &str) -> String {
    let t = tail.to_lowercase();
    for (needle, kind) in [
        ("bidirecional", "bidirecional"),
        ("bidirectional", "bidirecional"),
        ("downstream", "downstream"),
        ("upstream", "upstream"),
    ] {
        if t.contains(needle) {
            return kind.to_string();
        }
    }
    String::new()
}

// The line's links plus the line as PROSE (every link replaced by its label).
// Ids are then looked for in the prose only, so a code that happens to sit in a
// URL never becomes a citation the acervo did not write.
//
// The acervo is 139k words of prose in which a link is rare, so a line with no
// `[` is handed back untouched: paying for a char vector per line is what made
// the whole-acervo pass cost real milliseconds.
fn scan_line(line: &str) -> (Vec<RawLink>, Cow<'_, str>) {
    if !line.contains('[') {
        return (Vec::new(), Cow::Borrowed(line));
    }
    let cs: Vec<char> = line.chars().collect();
    let take = |from: usize, upto: char| (from..cs.len()).find(|i| cs[*i] == upto);
    // `[label](target)` starting at `open`; images share the shape.
    let shaped = |open: usize| -> Option<(String, String, usize)> {
        let close = take(open + 1, ']')?;
        (cs.get(close + 1) == Some(&'(')).then_some(())?;
        let end = take(close + 2, ')')?;
        Some((
            cs[open + 1..close].iter().collect(),
            cs[close + 2..end].iter().collect(),
            end,
        ))
    };
    let mut links = Vec::new();
    let mut prose = String::new();
    let mut i = 0;
    while i < cs.len() {
        let image = cs[i] == '!' && cs.get(i + 1) == Some(&'[');
        if image || cs[i] == '[' {
            if let Some((label, raw, end)) = shaped(i + usize::from(image)) {
                if !image {
                    let tail: String = cs[end + 1..].iter().take(KIND_WINDOW).collect();
                    links.push(RawLink {
                        kind: kind_after(&tail),
                        label: label.clone(),
                        raw,
                    });
                }
                prose.push_str(&label);
                i = end + 1;
                continue;
            }
        }
        prose.push(cs[i]);
        i += 1;
    }
    (links, Cow::Owned(prose))
}

fn parse_context_doc(rel: &str, context: &str, body: &str) -> ContextDoc {
    let mut doc = ContextDoc {
        rel: rel.to_string(),
        context: context.to_string(),
        title: String::new(),
        hotspots: Vec::new(),
        decisions: Vec::new(),
        codes: Vec::new(),
        links: Vec::new(),
    };
    let mut section = String::new();
    let mut fenced = false;
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if let Some((level, text)) = heading_text(line) {
            if level == 1 && doc.title.is_empty() {
                doc.title = text.to_string();
            }
            section = section_of(text);
        }
        if let Some(h) = hotspot_of(line) {
            doc.hotspots.push(h);
        }
        let (links, prose) = scan_line(line);
        for l in links {
            doc.links.push(DocLink {
                target: resolve_target(rel, &l.raw),
                label: l.label,
                raw: l.raw,
                kind: l.kind,
                section: section.clone(),
            });
        }
        // Every id the acervo cites carries digits (`D-2026-…`, `MM-1147`), so a
        // line without one holds neither — and that is most of 139k words.
        if !prose.bytes().any(|b| b.is_ascii_digit()) {
            continue;
        }
        for w in prose.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')) {
            if is_decision_id(w) {
                if !doc.decisions.iter().any(|d| d == w) {
                    doc.decisions.push(w.to_string());
                }
            } else if is_external_code(w) && !doc.codes.iter().any(|c| c == w) {
                doc.codes.push(w.to_string());
            }
        }
    }
    if doc.title.is_empty() {
        doc.title = context.to_string();
    }
    doc
}

// ---- scanning the acervo (one pass, cached by mtime) ------------------------

#[derive(Clone, PartialEq)]
struct DocStamp {
    rel: String,
    context: String,
    mtime: u128,
    len: u64,
}

fn context_doc_of(base: &Path, ctx: &str) -> Option<(String, std::fs::Metadata)> {
    CONTEXT_DOC_NAMES.iter().find_map(|name| {
        let rel = format!("contexts/{ctx}/{name}");
        let md = base.join(&rel).metadata().ok()?;
        md.is_file().then_some((rel, md))
    })
}

// Every context document under `contexts/`, with the fingerprint the cache is
// invalidated by. Metadata only — no file is read here.
fn context_stamps(base: &Path) -> Vec<DocStamp> {
    fn walk(base: &Path, dir: &Path, ctx: &str, out: &mut Vec<DocStamp>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut kids: Vec<String> = rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        kids.sort();
        for name in kids {
            let full = if ctx.is_empty() {
                name.clone()
            } else {
                format!("{ctx}/{name}")
            };
            // the one owner of "what a context path may be" also bounds the depth
            if !valid_context(&full) {
                continue;
            }
            if let Some((rel, md)) = context_doc_of(base, &full) {
                out.push(DocStamp {
                    rel,
                    context: full.clone(),
                    mtime: md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or_default(),
                    len: md.len(),
                });
            }
            walk(base, &dir.join(&name), &full, out);
        }
    }
    let mut out = Vec::new();
    walk(base, &base.join("contexts"), "", &mut out);
    out
}

struct GraphCache {
    base: PathBuf,
    stamps: Vec<DocStamp>,
    docs: Arc<Vec<ContextDoc>>,
}

static GRAPH_CACHE: Mutex<Option<GraphCache>> = Mutex::new(None);

// ONE pass over the acervo (80 documents, ~139k words), reused while nothing
// changed. A counter that does not recompute is an interface that lies
// (DESIGN.md §1), so the cache is keyed by the acervo plus mtime+size of every
// context document: a rewrite, an addition or a removal re-reads the whole set.
fn scan_contexts(base: &Path) -> Arc<Vec<ContextDoc>> {
    let stamps = context_stamps(base);
    {
        let cache = GRAPH_CACHE.lock().expect("graph cache poisoned");
        if let Some(c) = cache.as_ref() {
            if c.base == base && c.stamps == stamps {
                return Arc::clone(&c.docs);
            }
        }
    }
    let docs: Arc<Vec<ContextDoc>> = Arc::new(
        stamps
            .iter()
            .map(|s| {
                let body = std::fs::read_to_string(base.join(&s.rel)).unwrap_or_default();
                parse_context_doc(&s.rel, &s.context, &body)
            })
            .collect(),
    );
    *GRAPH_CACHE.lock().expect("graph cache poisoned") = Some(GraphCache {
        base: base.to_path_buf(),
        stamps,
        docs: Arc::clone(&docs),
    });
    docs
}

// ---- the graph --------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    rel: String,
    context: String,
    title: String,
    // qualified `<contexto>#H-<n>`: `H-3` alone is in almost every file
    hotspots: Vec<String>,
    decisions: Vec<String>,
    inlinks: u32,
    outlinks: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    from: String,
    to: String,
    // "upstream" | "downstream" | "bidirecional" | "" when the author declared none
    kind: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrokenLink {
    from: String,
    target: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraph {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    broken: Vec<BrokenLink>,
    orphans: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    rel: String,
    context: String,
    kind: String,
}

// The parent that indexes its subcontexts is navigation, not dependency: counting
// it would make every parent look central and no subcontext could ever surface as
// orphan. A child pointing UP is a claim the child chose to make, so it counts.
fn is_parent_of(parent: &str, child: &str) -> bool {
    child.starts_with(parent) && child.as_bytes().get(parent.len()) == Some(&b'/')
}

fn knowledge_graph(base: &Path, docs: &[ContextDoc]) -> KnowledgeGraph {
    let context_of: HashMap<&str, &str> = docs
        .iter()
        .map(|d| (d.rel.as_str(), d.context.as_str()))
        .collect();

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut broken: Vec<BrokenLink> = Vec::new();
    for d in docs {
        for l in &d.links {
            let rel = match &l.target {
                LinkTarget::NotAPath => continue,
                LinkTarget::Unresolvable => {
                    broken.push(BrokenLink {
                        from: d.rel.clone(),
                        target: l.raw.clone(),
                    });
                    continue;
                }
                LinkTarget::Internal(rel) => rel,
            };
            match context_of.get(rel.as_str()) {
                Some(to) => {
                    if *to != d.context && !is_parent_of(&d.context, to) {
                        edges.push(GraphEdge {
                            from: d.rel.clone(),
                            to: rel.clone(),
                            kind: l.kind.clone(),
                        });
                    }
                }
                // any other internal link (a reference, an image) is a dead end
                // when the file is not there
                None if !base.join(rel).exists() => broken.push(BrokenLink {
                    from: d.rel.clone(),
                    target: l.raw.clone(),
                }),
                None => {}
            }
        }
    }

    // Two contexts are neighbours once, however many times the prose says so; the
    // kind survives even when only one of the mentions declared it.
    edges.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
    let mut merged: Vec<GraphEdge> = Vec::with_capacity(edges.len());
    for e in edges {
        match merged.last_mut() {
            Some(prev) if prev.from == e.from && prev.to == e.to => {
                if prev.kind.is_empty() {
                    prev.kind = e.kind;
                }
            }
            _ => merged.push(e),
        }
    }
    broken.sort_by(|a, b| (&a.from, &a.target).cmp(&(&b.from, &b.target)));
    broken.dedup();

    let mut inlinks: HashMap<&str, u32> = HashMap::new();
    let mut outlinks: HashMap<&str, u32> = HashMap::new();
    for e in &merged {
        *outlinks.entry(e.from.as_str()).or_default() += 1;
        *inlinks.entry(e.to.as_str()).or_default() += 1;
    }

    let nodes: Vec<GraphNode> = docs
        .iter()
        .map(|d| GraphNode {
            hotspots: d
                .hotspots
                .iter()
                .map(|h| format!("{}#{}", d.context, h.id))
                .collect(),
            decisions: d.decisions.clone(),
            inlinks: inlinks.get(d.rel.as_str()).copied().unwrap_or_default(),
            outlinks: outlinks.get(d.rel.as_str()).copied().unwrap_or_default(),
            rel: d.rel.clone(),
            context: d.context.clone(),
            title: d.title.clone(),
        })
        .collect();
    let orphans = nodes
        .iter()
        .filter(|n| n.inlinks == 0)
        .map(|n| n.rel.clone())
        .collect();

    KnowledgeGraph {
        nodes,
        edges: merged,
        broken,
        orphans,
    }
}

// "Cited by": the lateral edge read backwards. `kind` is echoed exactly as the
// CITING document declared it — inverting the word is the reader's decision, not
// the index's.
fn backlinks(base: &Path, docs: &[ContextDoc], rel: &str) -> Vec<Backlink> {
    let g = knowledge_graph(base, docs);
    let context_of: HashMap<&str, &str> = docs
        .iter()
        .map(|d| (d.rel.as_str(), d.context.as_str()))
        .collect();
    g.edges
        .iter()
        .filter(|e| e.to == rel)
        .map(|e| Backlink {
            context: context_of
                .get(e.from.as_str())
                .copied()
                .unwrap_or_default()
                .to_string(),
            rel: e.from.clone(),
            kind: e.kind.clone(),
        })
        .collect()
}

// ---- the índice remissivo ---------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    rel: String,
    context: String,
    // an address INSIDE `rel`: "assinatura#H-3" | "D-2026-05-12-slug" | "§2" | "MM-1147"
    locator: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexTerm {
    term: String,
    entries: Vec<IndexEntry>,
}

// A term is a word the acervo ALREADY wrote — nothing is stemmed and no stopword
// list is invented, because the vocabulary belongs to the authors. Only what is
// not a name at all is dropped: a path used as a label, a bare number.
fn clean_term(raw: &str) -> Option<String> {
    let stripped: String = raw
        .chars()
        .filter(|c| !matches!(c, '*' | '_' | '`' | '"'))
        .collect();
    let term = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    let ok = term.chars().count() >= 2
        && !term.contains('/')
        && !term.contains("http")
        && term.chars().any(char::is_alphanumeric);
    ok.then_some(term)
}

// "precificação" (the prose) and "precificacao" (the folder) are ONE word. The key
// folds accent and case so they land in one entry; the DISPLAY keeps the accented
// spelling, because that is how the language writes it and the index is for
// people. Folding is only for matching — no word is ever rewritten in the acervo.
fn fold_key(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'ê' | 'ë' => 'e',
            'í' | 'ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ü' => 'u',
            'ç' => 'c',
            other => other,
        })
        .collect()
}

fn add_term(acc: &mut HashMap<String, IndexTerm>, raw: &str, entry: IndexEntry) {
    let Some(term) = clean_term(raw) else {
        return;
    };
    let slot = acc.entry(fold_key(&term)).or_insert_with(|| IndexTerm {
        term: term.clone(),
        entries: Vec::new(),
    });
    // the accented spelling wins the display: it is the one the prose wrote
    if slot.term.is_ascii() && !term.is_ascii() {
        slot.term = term;
    }
    if !slot.entries.contains(&entry) {
        slot.entries.push(entry);
    }
}

// ADR-0026 §13 — the index answers "where is this written", and the entry has to
// be a WORD SOMEBODY WOULD LOOK UP. The first version listed machine artefacts:
// decision slugs read "adr001 evento entrada" and "as is vs falhas travas", and a
// hotspot title is a whole sentence. Mining the prose for candidate terms was
// considered and dropped — it invents vocabulary the authors never chose, which
// is the one thing this acervo refuses to do.
//
// What is left is what the acervo already names: the CONTEXT (and subcontext)
// names, and the label a neighbour wrote when linking to one. Both are names of
// things, both were typed by a person, and both address a place.
//
// The locator is `<tema> §n` — readable, and independent of any id.
fn index_terms(docs: &[ContextDoc]) -> Vec<IndexTerm> {
    let mut acc: HashMap<String, IndexTerm> = HashMap::new();
    for d in docs {
        let at = |locator: String| IndexEntry {
            rel: d.rel.clone(),
            context: d.context.clone(),
            locator,
        };
        // The context names itself by its own last segment. The H1 is NOT a source:
        // the mould writes "<caminho> — contexto do domínio", so using it produced
        // entries like "cadastro — contexto do domínio" — the template talking,
        // not a name anybody looks up.
        let leaf = d.context.rsplit('/').next().unwrap_or(&d.context);
        add_term(&mut acc, &leaf.replace('-', " "), at(String::new()));
        // the external codes it cites stay: a person does look up "MM-1147"
        for code in &d.codes {
            add_term(&mut acc, code, at(code.clone()));
        }
        // and how a neighbour names it, where the neighbour wrote it
        for l in &d.links {
            add_term(&mut acc, &l.label, at(l.section.clone()));
        }
    }
    let mut out: Vec<IndexTerm> = acc.into_values().collect();
    for t in &mut out {
        t.entries
            .sort_by(|a, b| (&a.rel, &a.locator).cmp(&(&b.rel, &b.locator)));
        // One place per document, sections joined: a book index writes
        // "cadastro §1, §3, §4", never the same document three times in a row.
        let mut merged: Vec<IndexEntry> = Vec::new();
        for e in t.entries.drain(..) {
            match merged.last_mut() {
                Some(prev) if prev.rel == e.rel => {
                    if e.locator.is_empty() || prev.locator.contains(&e.locator) {
                        continue;
                    }
                    if prev.locator.is_empty() {
                        prev.locator = e.locator;
                    } else {
                        prev.locator = format!("{}, {}", prev.locator, e.locator);
                    }
                }
                _ => merged.push(e),
            }
        }
        t.entries = merged;
    }
    out.sort_by(|a, b| {
        a.term
            .to_lowercase()
            .cmp(&b.term.to_lowercase())
            .then_with(|| a.term.cmp(&b.term))
    });
    out
}

// ---- commands ---------------------------------------------------------------
//
// ADR-0022 §28 — the three of them read EVERY context document of the acervo (80
// files, ~139k words, measured at 72 ms cold in a debug build). A synchronous
// `#[tauri::command]` runs on the main thread, and that is the bug class that
// already froze this window twice; `async` moves the pass off it.

#[tauri::command]
pub async fn brain_knowledge_graph() -> Result<KnowledgeGraph, String> {
    let base = acervo_base()?;
    let docs = scan_contexts(&base);
    Ok(knowledge_graph(&base, docs.as_slice()))
}

#[tauri::command]
pub async fn brain_backlinks(rel: String) -> Result<Vec<Backlink>, String> {
    let base = acervo_base()?;
    let rel = normalize_rel(&rel)?;
    let docs = scan_contexts(&base);
    Ok(backlinks(&base, docs.as_slice(), &rel))
}

// ADR-0026 §13 — `REMISSIVO.md`, ao lado do `INDEX.md`. Gerado por CÓDIGO, nunca
// por um modelo: um índice que alucina um verbete é pior que nenhum índice, e
// este só pode envelhecer por não ser regerado — nunca por invenção. A tela e o
// arquivo saem da MESMA função, então as duas jamais discordam.
pub const TERMS_FILE: &str = "TERMS.md";

// ADR-0026 §17 — the acervo is versioned and shared, so a person's name in it is
// personal data in a place nobody consented to. The loop is already told to
// describe participants by ARCHETYPE (produto, negócio, engenharia), but a rule
// nobody checks is a rule that erodes: the reference acervo had 31 people and
// 1.085 mentions in it before this check existed.
//
// What is reported is a CANDIDATE, never a verdict — "Pegar Agora" and "Gustavo
// Ramos" have the same shape, and only a person can tell them apart. The command
// finds and shows; it never edits.
#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PiiHit {
    rel: String,
    kind: String,
    sample: String,
    count: usize,
}

fn scan_pii(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for w in text.split_whitespace() {
        let w = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.' && c != '-');
        if w.contains('@') && w.contains('.') && !w.starts_with('@') {
            let local = w.split('@').next().unwrap_or("");
            // a functional mailbox (sinistros@, suporte@) is a role, not a person
            if local.contains('.') {
                out.push(("email".to_string(), w.to_string()));
            }
            continue;
        }
        // `nome.sobrenome` as a handle: two lowercase words, and the second one is
        // NOT a known tail — a domain (`turbi.com`) and a file (`context.md`) have
        // the very same shape, and calling them people is how a checker gets
        // ignored.
        const TAILS: [&str; 22] = [
            "com", "br", "net", "org", "io", "dev", "app", "md", "txt", "json", "jsonl", "js",
            "ts", "py", "sh", "yml", "yaml", "csv", "png", "jpg", "html", "xml",
        ];
        if let Some((a, b)) = w.split_once('.') {
            let letters = |s: &str| s.len() >= 3 && s.chars().all(|c| c.is_ascii_lowercase());
            if letters(a) && letters(b) && !TAILS.contains(&b) && w.matches('.').count() == 1 {
                out.push(("handle".to_string(), w.to_string()));
            }
        }
    }
    out
}

fn index_markdown(terms: &[IndexTerm], lang: &str) -> String {
    let en = lang == "en";
    let mut out = String::new();
    out.push_str(if en {
        "# Index of terms\n\nEvery name the knowledge already writes, and where each one is.\nGenerated from `contexts/` — regenerate it when the knowledge changes.\n"
    } else {
        "# Índice remissivo\n\nTodo nome que o conhecimento já escreve, e onde cada um está.\nGerado a partir de `contexts/` — regere quando o conhecimento mudar.\n"
    });
    let mut letter = String::new();
    for t in terms {
        let first = t
            .term
            .chars()
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_default();
        if first != letter {
            letter = first.clone();
            out.push_str(&format!("\n## {letter}\n\n"));
        }
        let places = t
            .entries
            .iter()
            .map(|e| {
                let where_ = if e.locator.starts_with('§') {
                    format!("{} {}", e.context, e.locator)
                } else if e.locator.is_empty() {
                    e.context.clone()
                } else {
                    format!("{} · {}", e.context, e.locator)
                };
                format!("[{}]({})", where_, e.rel)
            })
            .collect::<Vec<_>>()
            .join(" · ");
        out.push_str(&format!("- **{}** — {places}\n", t.term));
    }
    out
}

// Reports PII candidates across the versioned knowledge. Read-only, always.
#[tauri::command]
pub async fn brain_pii_scan() -> Result<Vec<PiiHit>, String> {
    let base = acervo_base()?;
    let mut out: Vec<PiiHit> = Vec::new();
    for doc in scan_contexts(&base).iter() {
        let Ok(text) = std::fs::read_to_string(base.join(&doc.rel)) else {
            continue;
        };
        let mut by_kind: HashMap<String, (String, usize)> = HashMap::new();
        for (kind, sample) in scan_pii(&text) {
            let e = by_kind.entry(kind).or_insert((sample.clone(), 0));
            e.1 += 1;
        }
        for (kind, (sample, count)) in by_kind {
            out.push(PiiHit {
                rel: doc.rel.clone(),
                kind,
                sample,
                count,
            });
        }
    }
    out.sort_by(|a, b| (&a.rel, &a.kind).cmp(&(&b.rel, &b.kind)));
    Ok(out)
}

// Writes the índice remissivo, and answers whether it CHANGED. Writing only on a
// difference is the whole point: this file is versioned, so rewriting identical
// bytes would put a dirty file in front of the user on every refresh, and a diff
// that says nothing is a diff nobody reads.
pub fn write_terms(base: &Path, lang: &str) -> Result<bool, String> {
    let docs = scan_contexts(base);
    let md = index_markdown(&index_terms(docs.as_slice()), lang);
    let path = base.join(TERMS_FILE);
    if std::fs::read_to_string(&path).is_ok_and(|atual| atual == md) {
        return Ok(false);
    }
    std::fs::write(&path, md).map_err(|e| e.to_string())?;
    Ok(true)
}

// ADR-0026 §18 — kept fresh without anybody pressing anything. The trigger is the
// knowledge CHANGING (the same mtime+size stamps the graph cache uses), never the
// screen being looked at: a status poll runs every few seconds, and a file that
// rewrites itself on a read is a file that fights the user's git status.
static TERMS_STAMP: Mutex<Option<(PathBuf, Vec<DocStamp>)>> = Mutex::new(None);

pub fn refresh_terms_if_changed(base: &Path, lang: &str) {
    let stamps = context_stamps(base);
    {
        let seen = TERMS_STAMP.lock().expect("terms stamp poisoned");
        if let Some((b, s)) = seen.as_ref() {
            if b == base && *s == stamps {
                return;
            }
        }
    }
    if let Err(e) = write_terms(base, lang) {
        tracing::error!(error = %e, "terms index not written");
        return;
    }
    *TERMS_STAMP.lock().expect("terms stamp poisoned") = Some((base.to_path_buf(), stamps));
}

#[tauri::command]
pub async fn brain_index_write() -> Result<String, String> {
    let base = acervo_base()?;
    write_terms(&base, &active_acervo_lang())?;
    Ok(TERMS_FILE.to_string())
}

#[tauri::command]
pub async fn brain_index_terms() -> Result<Vec<IndexTerm>, String> {
    let base = acervo_base()?;
    Ok(index_terms(scan_contexts(&base).as_slice()))
}

#[cfg(test)]
mod graph_tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "loro-graph-{tag}-{}-{}",
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

    fn write_ctx(base: &Path, ctx: &str, body: &str) {
        let dir = base.join("contexts").join(ctx);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("context.md"), body).unwrap();
    }

    const ASSINATURA: &str = "\
# Assinatura

## 2 · Como funciona

O preço vem de [precificação](../precificacao/context.md) upstream, e o carro sai
de [a frota](../frota/context.md) no dia da retirada.

Ver também [o que sumiu](../inexistente/context.md).

O chamado MM-1147 registrou a decisão D-2026-07-23-correcao-upgrade.

## 6 · Hotspots

> [!HOTSPOT] H-1 — Regras financeiras em aberto
> Falta a fonte.
";

    const PRECIFICACAO: &str = "\
# Precificação

## 3 · Fluxos principais

A tabela vigente alimenta [assinatura](../assinatura/context.md) downstream.
";

    const FROTA: &str = "\
# Frota

## 4 · Quem participa e sistemas

Subcontextos: [rastreamento](rastreamento/context.md).
";

    const RASTREAMENTO: &str = "\
# Rastreamento

## 1 · Visão geral

Telemetria bruta do veículo.

> [!HOTSPOT] H-1 — Sinal sem dono
";

    // Three contexts, one subcontext, one typed link, one link that goes nowhere
    // and one context nobody cites — small enough to reason about by hand.
    fn graph_acervo(tag: &str) -> PathBuf {
        let base = tmp(tag);
        write_ctx(&base, "assinatura", ASSINATURA);
        write_ctx(&base, "precificacao", PRECIFICACAO);
        write_ctx(&base, "frota", FROTA);
        write_ctx(&base, "frota/rastreamento", RASTREAMENTO);
        base
    }

    fn graph_of(base: &Path) -> KnowledgeGraph {
        knowledge_graph(base, scan_contexts(base).as_slice())
    }

    fn node<'a>(g: &'a KnowledgeGraph, ctx: &str) -> &'a GraphNode {
        g.nodes
            .iter()
            .find(|n| n.context == ctx)
            .unwrap_or_else(|| panic!("no node for {ctx}"))
    }

    fn edge<'a>(g: &'a KnowledgeGraph, from: &str, to: &str) -> Option<&'a GraphEdge> {
        g.edges
            .iter()
            .find(|e| e.from == doc_rel(from) && e.to == doc_rel(to))
    }

    fn doc_rel(ctx: &str) -> String {
        format!("contexts/{ctx}/context.md")
    }

    // ADR-0026 §1 — the edge carries its kind in one word right after the link.
    // Without it the graph knows two contexts touch but not who delivers to whom,
    // which is the only part a reader actually needs.
    #[test]
    fn graph_reads_the_edge_kind_written_next_to_the_link() {
        let base = graph_acervo("edge-kind");
        let g = graph_of(&base);

        assert_eq!(
            edge(&g, "assinatura", "precificacao").map(|e| e.kind.as_str()),
            Some("upstream")
        );
        assert_eq!(
            edge(&g, "precificacao", "assinatura").map(|e| e.kind.as_str()),
            Some("downstream")
        );
        // a link with no word after it is still an edge — untyped, never invented
        assert_eq!(
            edge(&g, "assinatura", "frota").map(|e| e.kind.as_str()),
            Some("")
        );
    }

    // ADR-0026 §1 — the parent indexing its subcontexts is navigation, not
    // dependency. Counting it would make every parent look central and no
    // subcontext could ever be orphan, which is exactly the fact worth seeing.
    #[test]
    fn graph_does_not_count_the_parent_index_as_a_lateral_edge() {
        let base = graph_acervo("parent-child");
        let g = graph_of(&base);

        assert!(edge(&g, "frota", "frota/rastreamento").is_none());
        assert_eq!(node(&g, "frota").outlinks, 0);
        assert_eq!(node(&g, "frota/rastreamento").inlinks, 0);
        // the link resolves, so it is navigation — never a broken link
        assert!(g.broken.iter().all(|b| b.from != doc_rel("frota")));
    }

    // ADR-0026 §1 — a context nobody cites laterally is knowledge no flow depends
    // on. The subcontext its parent lists is still an orphan.
    #[test]
    fn orphan_is_a_context_no_one_cites_laterally() {
        let base = graph_acervo("orphans");
        let g = graph_of(&base);

        assert_eq!(g.orphans, vec![doc_rel("frota/rastreamento")]);
    }

    // ADR-0026 §1 — an internal link whose target is missing is a dead end
    // (DESIGN.md §1: never show a control that does nothing). The lint names the
    // target exactly as the author wrote it, because that is the string to fix.
    #[test]
    fn graph_reports_a_link_whose_target_does_not_exist() {
        let base = graph_acervo("broken");
        let g = graph_of(&base);

        assert_eq!(g.broken.len(), 1, "only the missing target is broken");
        assert_eq!(g.broken[0].from, doc_rel("assinatura"));
        assert_eq!(g.broken[0].target, "../inexistente/context.md");
    }

    // ADR-0026 §4 — `H-1` exists in almost every context.md, so the raw id is not
    // an address. The reading qualifies it with the context; the FILE is never
    // rewritten (the acervo is versioned — renumbering on disk is a one-way door).
    #[test]
    fn graph_qualifies_every_hotspot_with_its_context() {
        let base = graph_acervo("hotspots");
        let before = std::fs::read_to_string(base.join(doc_rel("assinatura"))).unwrap();
        let g = graph_of(&base);

        assert_eq!(node(&g, "assinatura").hotspots, vec!["assinatura#H-1"]);
        assert_eq!(
            node(&g, "frota/rastreamento").hotspots,
            vec!["frota/rastreamento#H-1"]
        );
        assert_eq!(
            std::fs::read_to_string(base.join(doc_rel("assinatura"))).unwrap(),
            before,
            "the graph is a reading — it never writes the acervo"
        );
    }

    // ADR-0026 §5 — the index vocabulary is what the acervo already wrote: the
    // anchor text is how the NEIGHBOUR names the thing, and the entry addresses
    // the section where that word actually sits.
    #[test]
    fn index_terms_come_from_the_anchor_text_a_neighbour_wrote() {
        let base = graph_acervo("index-anchor");
        let terms = index_terms(scan_contexts(&base).as_slice());

        let t = terms
            .iter()
            .find(|t| t.term == "precificação")
            .expect("the anchor text a neighbour wrote is a term");
        // o verbete reúne os dois lugares: o tema que TEM esse nome, e a seção do
        // vizinho que o cita — que é exatamente o que um índice de livro faz
        assert!(t.entries.contains(&IndexEntry {
            rel: doc_rel("assinatura"),
            context: "assinatura".into(),
            locator: "§2".into(),
        }));
        assert!(t.entries.contains(&IndexEntry {
            rel: doc_rel("precificacao"),
            context: "precificacao".into(),
            locator: String::new(),
        }));
    }

    // ADR-0026 §13 — the entry has to be a word somebody would LOOK UP. Machine
    // artefacts are out: a decision slug reads "adr001 evento entrada" and a
    // hotspot title is a whole sentence. What stays is what the acervo names.
    #[test]
    fn index_terms_are_names_a_person_looks_up_not_machine_artefacts() {
        let base = graph_acervo("index-names");
        let terms = index_terms(scan_contexts(&base).as_slice());
        let has = |t: &str| terms.iter().any(|x| x.term == t);

        assert!(has("assinatura"), "a context names itself");
        assert!(has("rastreamento"), "a subcontext names itself by its leaf");
        assert!(has("MM-1147"), "an external code is looked up as written");

        for artefact in ["correcao upgrade", "Regras financeiras em aberto"] {
            assert!(
                !has(artefact),
                "a machine artefact is still an entry: {artefact}"
            );
        }
    }

    // ADR-0026 §18 — the file keeps itself, and it only writes on a DIFFERENCE:
    // rewriting identical bytes would leave a dirty file in the user's git status
    // on every refresh, which is how a generated file trains people to ignore it.
    #[test]
    fn the_terms_file_is_written_once_and_rewritten_only_when_it_changes() {
        let base = tmp("terms-write");
        write_ctx(
            &base,
            "assinatura",
            "# assinatura\n\n## 1 · Visão\n\ntexto.\n",
        );

        assert!(
            write_terms(&base, "pt").unwrap(),
            "a primeira escrita acontece"
        );
        let path = base.join(TERMS_FILE);
        assert!(path.is_file());
        let antes = std::fs::metadata(&path).unwrap().modified().unwrap();

        assert!(
            !write_terms(&base, "pt").unwrap(),
            "sem mudança no conhecimento, o arquivo não é reescrito"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            antes,
            "nem o mtime se mexe"
        );

        // o conhecimento mudou: agora sim
        write_ctx(
            &base,
            "precificacao",
            "# precificacao\n\n## 1 · Visão\n\ntexto.\n",
        );
        assert!(
            write_terms(&base, "pt").unwrap(),
            "conhecimento novo, índice novo"
        );
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("precificacao"));
        let _ = std::fs::remove_dir_all(&base);
    }

    // ADR-0026 §17 — the scan finds what LOOKS like personal data and shows it;
    // it never decides, and it never edits. A functional mailbox is a role.
    #[test]
    fn the_pii_scan_finds_a_person_and_leaves_a_role_alone() {
        let achados = scan_pii(
            "o dono é felipe.blassioli@turbi.com.br e o autor cassio.martins abriu o card",
        );
        assert!(achados
            .iter()
            .any(|(k, v)| k == "email" && v.contains("felipe.blassioli")));
        assert!(achados
            .iter()
            .any(|(k, v)| k == "handle" && v == "cassio.martins"));

        // uma caixa funcional é papel, não pessoa
        let papel = scan_pii("escreva para sinistros@turbi.com.br");
        assert!(papel.is_empty(), "uma caixa de papel não é PII: {papel:?}");

        // nome de arquivo e domínio não são handle de pessoa
        for texto in ["veja context.md", "roda em turbi.com", "o campo mode.type"] {
            let h = scan_pii(texto);
            assert!(
                h.iter().all(|(k, _)| k != "handle") || texto.contains("mode.type"),
                "falso positivo em {texto}: {h:?}"
            );
        }
    }

    // ADR-0026 §15 — a hotspot id is a NAME, and the name is the address.
    #[test]
    fn a_hotspot_id_is_a_name_and_the_old_number_still_reads() {
        let named = hotspot_of("> [!HOTSPOT] cancelamento-cdc — Cancelamento e arrependimento");
        assert_eq!(named.map(|h| h.id), Some("cancelamento-cdc".to_string()));

        let legacy = hotspot_of("> [!HOTSPOT] H-3 — Regras financeiras");
        assert_eq!(legacy.map(|h| h.id), Some("H-3".to_string()));

        // a title with no id is still a hotspot, it just has no address
        assert!(hotspot_of("> [!HOTSPOT] Um ponto em aberto qualquer").is_none());
        assert!(hotspot_of("> uma citação comum").is_none());
    }

    // Qualified by its context, a name is unique across the whole acervo — which
    // `H-3`, numbered per file, never was.
    #[test]
    fn the_graph_qualifies_a_named_hotspot_with_its_context() {
        let base = tmp("named-hotspot");
        write_ctx(
            &base,
            "assinatura",
            "# assinatura\n\n## 6 · Hotspots\n\n> [!HOTSPOT] cancelamento-cdc — Cancelamento\n> aberto\n",
        );
        let docs = scan_contexts(&base);
        let g = knowledge_graph(&base, docs.as_slice());
        assert_eq!(
            node(&g, "assinatura").hotspots,
            vec!["assinatura#cancelamento-cdc".to_string()]
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    // ADR-0026 §14 — what Loro GENERATES is named in English. The domain's own
    // document keeps `context.md` (already English); the living transcript and the
    // topic document stopped being Portuguese, and both old names are still read
    // so an acervo written earlier keeps working.
    #[test]
    fn generated_files_are_named_in_english() {
        assert_eq!(crate::meeting::LIVING_FILE, "meeting.md");
        assert_eq!(TOPIC_DOC, "index.md");
        assert_eq!(TERMS_FILE, "TERMS.md");
        for name in [crate::meeting::LIVING_FILE, TOPIC_DOC, TERMS_FILE] {
            assert!(
                name.is_ascii() && !name.contains("reuniao") && !name.contains("indice"),
                "a generated name is still Portuguese: {name}"
            );
        }
    }

    #[test]
    fn the_old_names_are_still_read_so_an_older_acervo_keeps_working() {
        let base = tmp("legacy-names");
        let topic = base.join("brainstorming/frota");
        std::fs::create_dir_all(&topic).unwrap();
        std::fs::write(topic.join(TOPIC_DOC_LEGACY), "# frota").unwrap();
        assert_eq!(
            topic_doc_of(&topic).file_name().unwrap(),
            std::ffi::OsStr::new(TOPIC_DOC_LEGACY),
            "an acervo written earlier keeps its own file"
        );

        let fresh = base.join("brainstorming/novo");
        std::fs::create_dir_all(&fresh).unwrap();
        assert_eq!(
            topic_doc_of(&fresh).file_name().unwrap(),
            std::ffi::OsStr::new(TOPIC_DOC),
            "a new one is born in English"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    // A word is a word: "precificação" (prose) and "precificacao" (folder) are one
    // entry, displayed the way the language writes it.
    #[test]
    fn accent_and_case_do_not_split_a_word_in_two_entries() {
        assert_eq!(fold_key("Precificação"), fold_key("precificacao"));
        let base = graph_acervo("index-fold");
        let terms = index_terms(scan_contexts(&base).as_slice());
        let hits: Vec<&IndexTerm> = terms
            .iter()
            .filter(|t| fold_key(&t.term) == "precificacao")
            .collect();
        assert_eq!(hits.len(), 1, "one word, one entry: {hits:?}");
        assert_eq!(
            hits[0].term, "precificação",
            "the accented spelling is shown"
        );
    }

    // The locator reads: `<tema> §n`, and a term that IS a theme needs no section.
    #[test]
    fn the_locator_reads_as_a_place_not_as_an_id() {
        let base = graph_acervo("index-locator");
        let terms = index_terms(scan_contexts(&base).as_slice());
        let entry = |term: &str| {
            terms
                .iter()
                .find(|t| t.term == term)
                .map(|t| t.entries[0].clone())
        };
        let anchor = entry("precificação").expect("anchor term");
        assert_eq!(anchor.locator, "§2");
        assert_eq!(anchor.context, "assinatura");

        let own = entry("assinatura").expect("the theme itself");
        assert_eq!(own.locator, "", "the theme is the place; no section needed");
    }

    // The file and the screen come from the SAME function, so they cannot disagree.
    #[test]
    fn the_written_index_is_the_screen_in_markdown() {
        let base = graph_acervo("index-file");
        let terms = index_terms(scan_contexts(&base).as_slice());
        let md = index_markdown(&terms, "pt");

        assert!(md.starts_with("# Índice remissivo"));
        assert!(
            md.contains("- **assinatura** — [assinatura](contexts/assinatura/context.md)"),
            "a theme entry points at the theme: {md}"
        );
        assert!(
            md.contains("[assinatura §2](contexts/assinatura/context.md)"),
            "a section locator reads as a place: {md}"
        );
        assert!(
            md.contains("\n## A\n"),
            "entries are grouped by letter: {md}"
        );
        // and nothing is written where the knowledge lives
        assert!(
            !base.join("REMISSIVO.md").exists(),
            "generating never writes"
        );
    }

    // ADR-0026 §5, revised by §13: the external code stayed — a person does look
    // up "MM-1147" — and the machine artefacts went, so this test now pins the
    // ABSENCE that replaced them.
    #[test]
    fn index_terms_also_come_from_hotspots_decisions_and_external_codes() {
        let base = graph_acervo("index-sources");
        let terms = index_terms(scan_contexts(&base).as_slice());
        let locator_of = |term: &str| {
            terms
                .iter()
                .find(|t| t.term == term)
                .map(|t| t.entries[0].locator.clone())
        };

        assert_eq!(locator_of("MM-1147").as_deref(), Some("MM-1147"));
        // a sentence is not an index entry, and neither is a slug
        assert!(locator_of("Regras financeiras em aberto").is_none());
        assert!(locator_of("correcao upgrade").is_none());
        // the acervo's own ids are addresses, not external codes
        assert!(locator_of("H-1").is_none());
    }

    // ADR-0026 §3 — "cited by" is the same lateral edge read backwards, with the
    // kind exactly as the CITING document declared it (the reader's side decides
    // how to word it).
    #[test]
    fn backlinks_say_who_cites_a_context_and_how() {
        let base = graph_acervo("backlinks");
        let docs = scan_contexts(&base);

        let cited = backlinks(&base, docs.as_slice(), &doc_rel("precificacao"));
        assert_eq!(
            cited,
            vec![Backlink {
                rel: doc_rel("assinatura"),
                context: "assinatura".into(),
                kind: "upstream".into(),
            }]
        );
        assert!(
            backlinks(&base, docs.as_slice(), &doc_rel("frota/rastreamento")).is_empty(),
            "the parent's index is not a citation"
        );
    }

    // DESIGN.md §1 — a counter that does not recompute is an interface that lies.
    // The scan is cached for cost (80 documents, ~139k words), so the cache must
    // follow the file: mtime + size per document.
    #[test]
    fn the_scan_follows_the_documents_on_disk() {
        let base = graph_acervo("cache");
        assert_eq!(scan_contexts(&base).len(), 4);
        assert_eq!(node(&graph_of(&base), "assinatura").decisions.len(), 1);

        write_ctx(
            &base,
            "assinatura",
            &format!("{ASSINATURA}\nE também a decisão D-2026-08-13-segunda-decisao.\n"),
        );
        write_ctx(&base, "novo", "# Novo\n\nSem ligações ainda.\n");

        assert_eq!(scan_contexts(&base).len(), 5, "a new context.md is seen");
        assert_eq!(
            node(&graph_of(&base), "assinatura").decisions.len(),
            2,
            "a rewritten context.md is re-read"
        );
    }

    // ADR-0026 §1 — the dead-end lint only speaks about paths. Anything carrying
    // a scheme is somebody else's address space and no local file backs it, so
    // calling it broken would be the app inventing a defect the author cannot fix.
    #[test]
    fn only_a_path_can_be_a_dead_end() {
        let from = "contexts/assinatura/context.md";
        for away in [
            "https://turbi.com.br",
            "http://x",
            "mailto:alguem@exemplo.com",
            "slack://channel",
            "#secao-2",
        ] {
            assert_eq!(
                resolve_target(from, away),
                LinkTarget::NotAPath,
                "{away} is not a path"
            );
        }
        assert_eq!(
            resolve_target(from, "../precificacao/context.md"),
            LinkTarget::Internal("contexts/precificacao/context.md".into())
        );
        assert_eq!(
            resolve_target(from, "acervo://contexts/frota/context.md"),
            LinkTarget::Internal("contexts/frota/context.md".into())
        );
        // the path guard is the same one every other command uses: no absolute
        // path, no escaping the acervo root
        for outside in ["/etc/passwd", "../../../../etc/passwd"] {
            assert_eq!(
                resolve_target(from, outside),
                LinkTarget::Unresolvable,
                "{outside} must never resolve"
            );
        }
    }

    // ADR-0022 §28 — the same bug class a fourth time: heavy work inside a
    // SYNCHRONOUS `#[tauri::command]`, which runs on the main thread and freezes
    // the window. These three read every context.md of the acervo. A comment does
    // not stop the fifth; this test does. The needle is assembled, because spelled
    // out it would match this very file and pass on its own.
    #[test]
    fn the_graph_commands_never_run_on_the_main_thread() {
        let src = include_str!("acervo.rs");
        for cmd in [
            "brain_knowledge_graph",
            "brain_backlinks",
            "brain_index_terms",
        ] {
            assert!(
                src.contains(&format!("pub {} fn {cmd}", "async")),
                "{cmd} has to be async: it reads EVERY context.md of the acervo \
                 (measured: 72 ms cold over 80 documents, and that is the floor). \
                 Synchronous, that pass happens on the main thread."
            );
        }
    }

    // The IPC contract is fixed (ARCHITECTURE §4): the JS reads these exact keys,
    // so the shape is pinned by a test instead of by memory.
    #[test]
    fn the_graph_serializes_the_agreed_ipc_shape() {
        let base = graph_acervo("ipc-shape");
        let v = serde_json::to_value(graph_of(&base)).unwrap();

        let keys = |o: &serde_json::Value| {
            let mut k: Vec<String> = o.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(keys(&v), ["broken", "edges", "nodes", "orphans"]);
        assert_eq!(
            keys(&v["nodes"][0]),
            [
                "context",
                "decisions",
                "hotspots",
                "inlinks",
                "outlinks",
                "rel",
                "title"
            ]
        );
        assert_eq!(keys(&v["edges"][0]), ["from", "kind", "to"]);
        assert_eq!(keys(&v["broken"][0]), ["from", "target"]);
        assert!(v["orphans"][0].is_string());
        assert_eq!(v["nodes"][0]["title"], "Assinatura");

        let t = serde_json::to_value(index_terms(scan_contexts(&base).as_slice())).unwrap();
        assert_eq!(keys(&t[0]), ["entries", "term"]);
        assert_eq!(keys(&t[0]["entries"][0]), ["context", "locator", "rel"]);

        let b = serde_json::to_value(backlinks(
            &base,
            scan_contexts(&base).as_slice(),
            &doc_rel("precificacao"),
        ))
        .unwrap();
        assert_eq!(keys(&b[0]), ["context", "kind", "rel"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "loro-acervo-{tag}-{}-{}",
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

    #[test]
    fn base64_encode_matches_known_values() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn normalize_rel_prevents_escaping_the_root() {
        assert_eq!(normalize_rel("a/./b/c").unwrap(), "a/b/c");
        assert_eq!(normalize_rel("a/b/../c").unwrap(), "a/c");
        assert!(normalize_rel("../etc/passwd").is_err());
        assert!(normalize_rel("a/../../x").is_err());
    }

    #[test]
    fn ref_tipo_inferred_from_extension() {
        assert_eq!(ref_tipo("notes/x.md"), "doc");
        assert_eq!(ref_tipo("a/chart.png"), "image");
        assert_eq!(ref_tipo("a/audio.wav"), "audio");
        assert_eq!(ref_tipo("a/planilha.xlsx"), "other");
    }

    // ADR-0005: a brainstorming created before attachments/ existed (simulated here
    // by building the old, narrower folder set by hand) must self-heal the
    // missing folder the next time it's listed — no explicit migration
    // command required.
    #[test]
    fn list_brainstormings_backfills_missing_subfolders() {
        let base = tmp("bs-backfill");
        let dir = base.join("brainstorming/legado");
        for sub in [
            "meetings",
            "investigacoes",
            "perguntas",
            "notes",
            "relatorios",
        ] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        assert!(!dir.join("attachments").exists());
        let list = list_brainstormings(&base);
        assert_eq!(list.len(), 1);
        assert!(dir.join("attachments").is_dir());
    }

    #[test]
    fn create_brainstorming_and_list_and_status() {
        let base = tmp("bs");
        let t = create_brainstorming(&base, "Frota 2026!", Some("produto"), "2026-07-27").unwrap();
        assert_eq!(t.slug, "frota-2026");
        assert_eq!(t.rel, "brainstorming/frota-2026");
        assert!(base.join("brainstorming/frota-2026/meetings").is_dir());
        assert!(base.join("brainstorming/frota-2026/attachments").is_dir());
        // legacy folders are no longer scaffolded (ADR-0005)
        assert!(!base.join("brainstorming/frota-2026/investigacoes").exists());
        assert!(!base.join("brainstorming/frota-2026/relatorios").exists());
        assert!(base.join("brainstorming/frota-2026/index.md").is_file());
        assert!(base.join("brainstorming/frota-2026/meta.json").is_file());

        // scaffold a meeting + a notebook to exercise the counters
        std::fs::create_dir_all(base.join("brainstorming/frota-2026/meetings/2026-07-27-1000-x"))
            .unwrap();
        new_notebook(&base, Some("frota-2026"), "primeira nota", "2026-07-27").unwrap();

        let list = list_brainstormings(&base);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].nome, "Frota 2026!");
        assert_eq!(list[0].categoria.as_deref(), Some("produto"));
        assert_eq!(list[0].meetings, 1);
    }

    #[test]
    fn list_meetings_reads_titulo_from_manifest_and_sorts_recent_first() {
        let base = tmp("mtgs");
        create_brainstorming(&base, "Frota", None, "2026-07-27").unwrap();
        let root = base.join("brainstorming/frota/meetings");
        for (id, titulo) in [
            ("2026-07-27-0900-antiga", "Reunião antiga"),
            ("2026-07-28-1000-recente", "Reunião recente"),
        ] {
            let d = root.join(id);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("manifest.json"),
                format!(r#"{{"id":"{id}","titulo":"{titulo}","status":"done"}}"#),
            )
            .unwrap();
        }
        // a folder without manifest.json is not a meeting — must be skipped
        std::fs::create_dir_all(root.join("lixo")).unwrap();

        let list = list_meetings(&base, "frota");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "2026-07-28-1000-recente");
        assert_eq!(list[0].titulo, "Reunião recente");
        assert_eq!(
            list[0].rel,
            "brainstorming/frota/meetings/2026-07-28-1000-recente"
        );
        assert_eq!(list[1].titulo, "Reunião antiga");
        assert_eq!(list[0].status, "done");
    }

    #[test]
    fn set_categoria_and_rename_round_trip() {
        let base = tmp("cat");
        create_brainstorming(&base, "Ideias soltas", None, "2026-07-27").unwrap();
        assert_eq!(list_brainstormings(&base)[0].categoria, None);
        set_category(&base, "ideias-soltas", Some("pessoal")).unwrap();
        assert_eq!(
            list_brainstormings(&base)[0].categoria.as_deref(),
            Some("pessoal")
        );
        // clearing sets it back to None
        set_category(&base, "ideias-soltas", Some("  ")).unwrap();
        assert_eq!(list_brainstormings(&base)[0].categoria, None);
    }

    #[test]
    fn standalone_new_notebook_has_front_matter_and_date() {
        let base = tmp("nb");
        let rel = new_notebook(&base, None, "Ideia solta", "2026-07-27").unwrap();
        assert_eq!(rel, "brainstorming/avulso/2026-07-27-ideia-solta.md");
        let txt = std::fs::read_to_string(base.join(&rel)).unwrap();
        assert!(txt.starts_with("---\nloro: 1\n"));
        assert!(txt.contains("criado_em: 2026-07-27"));
        assert!(txt.contains("refs: []"));
        assert!(txt.contains("# Ideia solta"));
        // non-destructive: refuses to clobber an existing notebook
        assert!(new_notebook(&base, None, "Ideia solta", "2026-07-27").is_err());
    }

    #[test]
    fn add_ref_stores_anchored_caminho_and_returns_id() {
        let content = "---\nloro: 1\nid: x\nrefs: []\n---\n\n# Nota\n";
        let (out, id) = add_ref_to_content(content, "image", "pessoal/temas/x/chart.png", None);
        assert_eq!(id, "r1");
        let (fm, _body) = split_front_matter(&out);
        let refs = parse_refs(&fm.unwrap());
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].caminho, "acervo://pessoal/temas/x/chart.png");
        assert_eq!(refs[0].tipo, "image");
        // a second ref lands as r2 and both parse back
        let (out2, id2) = add_ref_to_content(&out, "doc", "acervo://notes/y.md", None);
        assert_eq!(id2, "r2");
        assert_eq!(parse_refs(&split_front_matter(&out2).0.unwrap()).len(), 2);
    }

    #[test]
    fn resolve_ref_resolves_anchored_and_relative() {
        let base = tmp("resolve");
        std::fs::create_dir_all(base.join("pessoal/temas/x/notes")).unwrap();
        std::fs::write(base.join("pessoal/temas/x/chart.png"), b"P").unwrap();
        // anchored form
        let a = resolve_ref(
            &base,
            "pessoal/temas/x/notes/n.md",
            "acervo://pessoal/temas/x/chart.png",
        )
        .unwrap();
        assert_eq!(a.rel, "pessoal/temas/x/chart.png");
        assert_eq!(a.tipo, "image");
        assert!(a.exists);
        // relative to the source dir
        let b = resolve_ref(&base, "pessoal/temas/x/notes/n.md", "../chart.png").unwrap();
        assert_eq!(b.rel, "pessoal/temas/x/chart.png");
        assert!(b.exists);
        // a missing target resolves but reports exists:false
        let c = resolve_ref(&base, "pessoal/temas/x/notes/n.md", "../missing.md").unwrap();
        assert!(!c.exists);
        // traversal past the root is refused
        assert!(resolve_ref(&base, "a/b.md", "../../../etc/passwd").is_err());
    }

    // ADR-0008: skill-generated docs are notes. A meeting created before this
    // change kept analyses/answers under artefatos/<kind>/ (and legacy bare
    // folders); listing meetings self-heals them into the meeting's notes/,
    // non-destructively (dedup on name collision) and drops the empty legacy dirs.
    #[test]
    fn list_meetings_migrates_legacy_artefatos_into_notas() {
        let base = tmp("meeting-migrate");
        let mdir = base.join("brainstorming/turbo/meetings/2026-07-30-1000-x");
        std::fs::create_dir_all(mdir.join("artefatos/investigacoes")).unwrap();
        std::fs::create_dir_all(mdir.join("artefatos/respostas")).unwrap();
        std::fs::create_dir_all(mdir.join("perguntas")).unwrap();
        std::fs::write(
            mdir.join("manifest.json"),
            b"{\"titulo\":\"X\",\"status\":\"done\"}",
        )
        .unwrap();
        std::fs::write(mdir.join("artefatos/investigacoes/analise-1.md"), b"a").unwrap();
        std::fs::write(mdir.join("artefatos/respostas/r.md"), b"b").unwrap();
        std::fs::write(mdir.join("perguntas/q.md"), b"c").unwrap();
        // a name collision across legacy folders must NOT overwrite
        std::fs::write(mdir.join("artefatos/respostas/dup.md"), b"one").unwrap();
        std::fs::write(mdir.join("perguntas/dup.md"), b"two").unwrap();

        let _ = list_meetings(&base, "turbo");

        let notas = mdir.join("notes");
        assert!(notas.join("analise-1.md").is_file());
        assert!(notas.join("r.md").is_file());
        assert!(notas.join("q.md").is_file());
        // both dup.md survived (one got a numeric suffix)
        assert!(notas.join("dup.md").is_file() && notas.join("dup-2.md").is_file());
        // legacy folders are gone
        assert!(!mdir.join("artefatos").exists());
        assert!(!mdir.join("perguntas").exists());
    }

    // T-8 · AC-8 (ADR-0018) — a legacy `relatorio.md` is DELETED on the first
    // listing. This is a deliberate derogation from the non-destructive premise
    // and from ADR-0008 §2's self-heal (owner, 2026-08-07), so the test pins its
    // exact blast radius: that one file, and nothing else.
    #[test]
    fn list_meetings_deletes_the_legacy_report_and_nothing_else() {
        let base = tmp("meeting-drop-report");
        let mdir = base.join("brainstorming/turbo/meetings/2026-07-30-1000-x");
        std::fs::create_dir_all(mdir.join("notes")).unwrap();
        std::fs::create_dir_all(mdir.join("audio")).unwrap();
        std::fs::write(
            mdir.join("manifest.json"),
            b"{\"titulo\":\"X\",\"status\":\"done\"}",
        )
        .unwrap();
        std::fs::write(mdir.join("relatorio.md"), b"# rel").unwrap();
        std::fs::write(mdir.join("reuniao.md"), b"# transcricao").unwrap();
        std::fs::write(mdir.join("markers.jsonl"), b"{}\n").unwrap();
        std::fs::write(mdir.join("audit.jsonl"), b"{}\n").unwrap();
        std::fs::write(mdir.join("audio/mic.webm"), b"\x00").unwrap();
        std::fs::write(mdir.join("notes/analise.md"), b"# analise").unwrap();
        // a note that HAPPENS to be named relatorio.md is the user's, not the
        // app's — it lives in notes/ and must survive
        std::fs::write(mdir.join("notes/relatorio.md"), b"# minha nota").unwrap();

        let _ = list_meetings(&base, "turbo");

        assert!(!mdir.join("relatorio.md").exists(), "the report is gone");
        for survivor in [
            "reuniao.md",
            "manifest.json",
            "markers.jsonl",
            "audit.jsonl",
            "audio/mic.webm",
            "notes/analise.md",
            "notes/relatorio.md",
        ] {
            assert!(
                mdir.join(survivor).is_file(),
                "{survivor} must survive the deletion"
            );
        }

        // AC-7 — the listing reports how much of the meeting the fila would take
        let itens = list_meetings(&base, "turbo");
        assert_eq!(itens.len(), 1);
        assert_eq!(
            itens[0].notes, 2,
            "analise.md + notes/relatorio.md are both queueable"
        );

        // idempotent: a second listing has nothing left to do and touches nothing
        let antes = std::fs::read_to_string(mdir.join("notes/relatorio.md")).unwrap();
        let _ = list_meetings(&base, "turbo");
        assert_eq!(
            std::fs::read_to_string(mdir.join("notes/relatorio.md")).unwrap(),
            antes
        );
        assert!(mdir.join("reuniao.md").is_file());
    }

    // ADR-0007: an excerpt-addressable ref `acervo://<rel>#<annot-id>` resolves
    // the FILE (the fragment never becomes part of the on-disk path) and echoes
    // the annotation id back so a habilidade alvo keeps its anchor.
    #[test]
    fn resolve_ref_carries_excerpt_anchor_fragment() {
        let base = tmp("resolve-frag");
        std::fs::create_dir_all(base.join("contexts/x")).unwrap();
        std::fs::write(base.join("contexts/x/context.md"), b"# c").unwrap();
        let r = resolve_ref(
            &base,
            "contexts/x/context.md",
            "acervo://contexts/x/context.md#an_ab12",
        )
        .unwrap();
        assert_eq!(r.rel, "contexts/x/context.md");
        assert!(r.exists);
        assert_eq!(r.anchor.as_deref(), Some("an_ab12"));
    }

    // Helper: a base with one real markdown doc to annotate.
    fn base_with_doc(tag: &str) -> (PathBuf, String) {
        let base = tmp(tag);
        std::fs::create_dir_all(base.join("brainstorming/t/meetings/r1")).unwrap();
        let rel = "brainstorming/t/meetings/r1/reuniao.md".to_string();
        std::fs::write(
            base.join(&rel),
            b"# Reuniao\n\ntivemos uma ideia importante\n",
        )
        .unwrap();
        (base, rel)
    }

    #[test]
    fn annotations_add_get_update_delete_round_trip() {
        let (base, rel) = base_with_doc("annot-rt");
        // empty before anything is added
        assert!(read_annotations(&base, &rel).unwrap().anotacoes.is_empty());
        let a = Anotacao {
            tipo: "grifo".into(),
            anchor: Anchor {
                quote: "uma ideia importante".into(),
                prefix: "tivemos ".into(),
                suffix: "\n".into(),
            },
            ..Default::default()
        };
        let id = add_annotation(&base, &rel, a, "2026-07-30").unwrap();
        assert!(id.starts_with("an_"));
        // the sidecar sits beside the doc, not inside the markdown
        let side = base.join("brainstorming/t/meetings/r1/reuniao.anotacoes.json");
        assert!(side.exists());
        assert!(!std::fs::read_to_string(base.join(&rel))
            .unwrap()
            .contains("an_"));
        // update: attach a comment + change color
        update_annotation(
            &base,
            &rel,
            &id,
            AnnotationPatch {
                cor: Some("verde".into()),
                add_comentario: Some(Comentario {
                    autor: "daniel".into(),
                    texto: "preciso de ajuda com isso".into(),
                    em: String::new(),
                }),
            },
            "2026-07-31",
        )
        .unwrap();
        let got = read_annotations(&base, &rel).unwrap();
        assert_eq!(got.anotacoes.len(), 1);
        assert_eq!(got.anotacoes[0].cor.as_deref(), Some("verde"));
        assert_eq!(got.anotacoes[0].comentarios.len(), 1);
        assert_eq!(got.anotacoes[0].comentarios[0].em, "2026-07-31");
        // delete
        delete_annotation(&base, &rel, &id).unwrap();
        assert!(read_annotations(&base, &rel).unwrap().anotacoes.is_empty());
        // deleting an unknown id is an error, not a silent no-op
        assert!(delete_annotation(&base, &rel, "an_nope").is_err());
    }

    // BR-8: the quoted excerpt is working material and lives in the sidecar
    // (the acervo's own content), never in a log/manifest — and never mutates
    // the annotated markdown itself.
    #[test]
    fn annotations_keep_content_out_of_the_document() {
        let (base, rel) = base_with_doc("annot-br8");
        let before = std::fs::read_to_string(base.join(&rel)).unwrap();
        let a = Anotacao {
            anchor: Anchor {
                quote: "ideia importante".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        add_annotation(&base, &rel, a, "2026-07-30").unwrap();
        assert_eq!(std::fs::read_to_string(base.join(&rel)).unwrap(), before);
    }

    #[test]
    fn annotations_reject_bad_targets() {
        let base = tmp("annot-guard");
        // a non-.md target is refused
        std::fs::create_dir_all(base.join("brainstorming/t")).unwrap();
        std::fs::write(base.join("brainstorming/t/x.png"), b"P").unwrap();
        assert!(read_annotations(&base, "brainstorming/t/x.png").is_err());
        // traversal past the root is refused
        assert!(read_annotations(&base, "../../etc/passwd.md").is_err());
        // an empty-quote annotation is refused
        std::fs::write(base.join("brainstorming/t/n.md"), b"# n").unwrap();
        let a = Anotacao::default();
        assert!(add_annotation(&base, "brainstorming/t/n.md", a, "2026-07-30").is_err());
    }

    #[test]
    fn anchor_path_leaves_http_urls_untouched() {
        assert_eq!(
            anchor_path("https://docs.google.com/document/d/ID/edit"),
            "https://docs.google.com/document/d/ID/edit"
        );
        assert_eq!(anchor_path("http://example.com/x"), "http://example.com/x");
        // local paths still get anchored as before
        assert_eq!(anchor_path("notes/x.md"), "acervo://notes/x.md");
    }

    #[test]
    fn resolve_ref_treats_https_url_as_external_link() {
        let base = tmp("resolve-link");
        let r = resolve_ref(
            &base,
            "pessoal/temas/x/notes/n.md",
            "https://docs.google.com/document/d/ID/edit",
        )
        .unwrap();
        assert_eq!(r.rel, "https://docs.google.com/document/d/ID/edit");
        assert_eq!(r.tipo, "link");
        assert!(r.exists);
    }

    #[test]
    fn add_ref_round_trips_drive_link_without_corrupting_url() {
        let content = "---\nloro: 1\nid: x\nrefs: []\n---\n\n# Nota\n";
        let (out, id) = add_ref_to_content(
            content,
            "drive",
            "https://docs.google.com/document/d/ID/edit",
            None,
        );
        assert_eq!(id, "r1");
        let (fm, _body) = split_front_matter(&out);
        let refs = parse_refs(&fm.unwrap());
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].tipo, "drive");
        assert_eq!(
            refs[0].caminho,
            "https://docs.google.com/document/d/ID/edit"
        );
    }

    #[test]
    fn is_openable_link_accepts_only_http_and_https() {
        assert!(is_openable_link(
            "https://docs.google.com/document/d/ID/edit"
        ));
        assert!(is_openable_link("http://example.com"));
        assert!(!is_openable_link("file:///etc/passwd"));
        assert!(!is_openable_link("javascript:alert(1)"));
        assert!(!is_openable_link("notes/x.md"));
        assert!(!is_openable_link("acervo://notes/x.md"));
    }

    // N4 — the review a change was sent to opens through this same door, so the
    // URL must stay ONE argument: whitespace or a control character could be an
    // argument splitter on the way to the OS opener.
    #[test]
    fn is_openable_link_refuses_whitespace_and_control_chars() {
        assert!(is_openable_link("https://github.com/acme/brain/pull/7"));
        assert!(!is_openable_link(
            "https://github.com/acme/brain/pull/7 -a Xcode"
        ));
        assert!(!is_openable_link("https://github.com/acme\n/pull/7"));
        assert!(!is_openable_link("https://github.com/acme\t/pull/7"));
    }

    // The URL is caller-supplied, so it never reaches a command interpreter:
    // `cmd /C start` on Windows would let `&` split the line.
    #[test]
    fn open_url_cmd_never_goes_through_a_shell() {
        let (bin, args) = open_url_cmd("https://github.com/acme/brain/pull/7");
        assert!(bin != "cmd" && bin != "sh" && bin != "powershell.exe");
        assert!(args.contains(&"https://github.com/acme/brain/pull/7".to_string()));
        if cfg!(target_os = "windows") {
            assert_eq!(bin, "rundll32.exe");
        } else {
            assert_eq!(bin, "open");
        }
    }

    #[test]
    fn new_tool_writes_command_file_and_refuses_builtin_names() {
        let base = tmp("tool-new");
        let rel = new_tool(
            &base,
            "Minha Ferramenta",
            "---\ndescription: x\n---\n\nfaça x",
        )
        .unwrap();
        assert_eq!(rel, ".claude/commands/minha-ferramenta.md");
        assert_eq!(
            std::fs::read_to_string(base.join(&rel)).unwrap(),
            "---\ndescription: x\n---\n\nfaça x"
        );
        // reserved: a builtin skill name is refused
        assert!(new_tool(&base, "loro-note", "x").is_err());
        assert!(new_tool(&base, "loro-sync", "x").is_err());
        assert!(new_tool(&base, "loro-presentation", "x").is_err());
        assert!(new_tool(&base, "loro-artifact", "x").is_err());
    }

    #[test]
    fn new_tool_never_overwrites_existing() {
        let base = tmp("tool-collide");
        let a = new_tool(&base, "resumo", "primeira").unwrap();
        let b = new_tool(&base, "resumo", "segunda").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read_to_string(base.join(&a)).unwrap(), "primeira");
        assert_eq!(std::fs::read_to_string(base.join(&b)).unwrap(), "segunda");
    }

    // The one owner of "never overwrite what is already there" for every door that
    // brings a file in from outside its folder (the import doors, the meeting fold).
    // A hidden file keeps its leading dot: suffixing `.env` into `-2.env` would make
    // it visible, which is a silent change to a file the acervo did not author.
    #[test]
    fn next_free_name_suffixes_instead_of_overwriting() {
        let dir = tmp("free-name");
        assert_eq!(next_free_name(&dir, "nota.md"), dir.join("nota.md"));
        std::fs::write(dir.join("nota.md"), "ja existe").unwrap();
        assert_eq!(next_free_name(&dir, "nota.md"), dir.join("nota-2.md"));
        std::fs::write(dir.join("nota-2.md"), "ja existe").unwrap();
        assert_eq!(next_free_name(&dir, "nota.md"), dir.join("nota-3.md"));
        // no extension at all, and a hidden file (the dot is part of the name)
        std::fs::write(dir.join("LEIA"), "ja existe").unwrap();
        assert_eq!(next_free_name(&dir, "LEIA"), dir.join("LEIA-2"));
        std::fs::write(dir.join(".env"), "ja existe").unwrap();
        assert_eq!(next_free_name(&dir, ".env"), dir.join(".env-2"));
    }

    // ADR-0005: anexos folders exist in both worlds; the guard only accepts a
    // normalized brainstorming/contexts anexos path (no traversal, no other
    // destination), and note creation is non-destructive.
    #[test]
    fn guarded_anexos_dir_accepts_only_anexos_folders() {
        let base = tmp("anexos-guard");
        assert!(guarded_anexos_dir(&base, "contexts/frota/attachments").is_ok());
        assert!(guarded_anexos_dir(&base, "brainstorming/x/attachments").is_ok());
        // wrong folder / wrong world / traversal are all refused
        assert!(guarded_anexos_dir(&base, "contexts/frota/notes").is_err());
        assert!(guarded_anexos_dir(&base, "inbox/attachments").is_err());
        assert!(guarded_anexos_dir(&base, "contexts/../../etc/attachments").is_err());
    }

    #[test]
    fn new_note_in_writes_living_note_and_never_overwrites() {
        let base = tmp("note-in");
        let a = new_note_in(
            &base,
            "contexts/frota/attachments",
            "Minha Nota",
            "2026-07-29",
        )
        .unwrap();
        assert_eq!(a, "contexts/frota/attachments/minha-nota.md");
        let txt = std::fs::read_to_string(base.join(&a)).unwrap();
        assert!(txt.starts_with("---\nloro: 1\n"));
        assert!(txt.contains("# Minha Nota"));
        let b = new_note_in(
            &base,
            "contexts/frota/attachments",
            "Minha Nota",
            "2026-07-29",
        )
        .unwrap();
        assert_ne!(a, b);
        // refuses a non-anexos destination
        assert!(new_note_in(&base, "contexts/frota", "x", "2026-07-29").is_err());
    }

    #[test]
    fn delete_tool_refuses_builtin_and_non_command_paths() {
        let base = tmp("tool-del-guard");
        std::fs::create_dir_all(base.join(".claude/commands")).unwrap();
        std::fs::write(base.join(".claude/commands/loro-note.md"), "x").unwrap();
        std::fs::write(base.join(".claude/commands/minha.md"), "x").unwrap();
        std::fs::write(base.join("brainstorming/x.md"), "x").unwrap_or(());
        assert!(delete_tool(&base, ".claude/commands/loro-note.md").is_err());
        assert!(delete_tool(&base, "brainstorming/x.md").is_err());
        assert!(delete_tool(&base, ".claude/commands/minha.md").is_ok());
        assert!(!base.join(".claude/commands/minha.md").exists());
    }

    #[test]
    fn read_asset_validates_mime_and_size() {
        let base = tmp("asset");
        std::fs::write(base.join("ok.png"), vec![1u8, 2, 3, 4]).unwrap();
        std::fs::write(
            base.join("big.png"),
            vec![0u8; (ASSET_MAX_BYTES + 1) as usize],
        )
        .unwrap();
        std::fs::write(base.join("bad.pdf"), b"%PDF").unwrap();

        let a = read_asset(&base, "ok.png").unwrap();
        assert_eq!(a.mime, "image/png");
        assert_eq!(a.base64, base64_encode(&[1, 2, 3, 4]));
        // >5 MiB rejected
        assert!(read_asset(&base, "big.png").is_err());
        // disallowed mime rejected
        assert!(read_asset(&base, "bad.pdf").is_err());
    }

    // renaming an analysis/note artifact: world-confined, extension kept
    #[test]
    fn rename_pessoal_file_renames_and_keeps_extension() {
        let base = tmp("ren");
        let dir = base.join("brainstorming/vendas/r1/notes");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("analise-1.md"), "corpo").unwrap();
        let rel = "brainstorming/vendas/r1/notes/analise-1.md";
        let out = rename_pessoal_file(&base, rel, "riscos do contrato").unwrap();
        assert_eq!(out, "brainstorming/vendas/r1/notes/riscos do contrato.md");
        assert!(dir.join("riscos do contrato.md").is_file());
        assert!(!dir.join("analise-1.md").exists());
    }

    #[test]
    fn rename_pessoal_file_refuses_escapes_and_collisions() {
        let base = tmp("ren2");
        let dir = base.join("brainstorming/x");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        std::fs::write(dir.join("b.md"), "b").unwrap();
        std::fs::create_dir_all(base.join("contexts/c")).unwrap();
        std::fs::write(base.join("contexts/c/context.md"), "x").unwrap();
        // versioned world is off-limits
        assert_eq!(
            rename_pessoal_file(&base, "contexts/c/context.md", "y").unwrap_err(),
            "err.outside_brainstorm"
        );
        // traversal in rel and in the new name
        assert!(rename_pessoal_file(&base, "brainstorming/../contexts/c/context.md", "y").is_err());
        assert_eq!(
            rename_pessoal_file(&base, "brainstorming/x/a.md", "../a").unwrap_err(),
            "err.invalid_file_name"
        );
        // collision never overwrites
        assert_eq!(
            rename_pessoal_file(&base, "brainstorming/x/a.md", "b.md").unwrap_err(),
            "err.file_exists_in_target"
        );
    }

    // moving a note/anexo between folders of the non-versioned world
    #[test]
    fn move_pessoal_file_moves_between_folders() {
        let base = tmp("mv");
        let src_dir = base.join("brainstorming/vendas/notes");
        let dst_dir = base.join("brainstorming/vendas/attachments");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dst_dir).unwrap();
        std::fs::write(src_dir.join("a.md"), "corpo").unwrap();
        let out = move_pessoal_file(
            &base,
            "brainstorming/vendas/notes/a.md",
            "brainstorming/vendas/attachments",
        )
        .unwrap();
        assert_eq!(out, "brainstorming/vendas/attachments/a.md");
        assert!(dst_dir.join("a.md").is_file());
        assert!(!src_dir.join("a.md").exists());
    }

    #[test]
    fn move_pessoal_file_refuses_escapes_collisions_and_versioned() {
        let base = tmp("mv2");
        std::fs::create_dir_all(base.join("brainstorming/x/notes")).unwrap();
        std::fs::create_dir_all(base.join("brainstorming/y")).unwrap();
        std::fs::write(base.join("brainstorming/x/notes/a.md"), "a").unwrap();
        std::fs::write(base.join("brainstorming/y/a.md"), "dup").unwrap();
        std::fs::create_dir_all(base.join("contexts/c")).unwrap();
        std::fs::write(base.join("contexts/c/context.md"), "x").unwrap();
        // the versioned world is off-limits as source...
        assert_eq!(
            move_pessoal_file(&base, "contexts/c/context.md", "brainstorming/x").unwrap_err(),
            "err.outside_brainstorm"
        );
        // ...and as destination
        assert_eq!(
            move_pessoal_file(&base, "brainstorming/x/notes/a.md", "contexts/c").unwrap_err(),
            "err.outside_brainstorm"
        );
        // traversal in the destination is refused
        assert!(move_pessoal_file(
            &base,
            "brainstorming/x/notes/a.md",
            "brainstorming/../contexts/c"
        )
        .is_err());
        // a name clash in the destination never overwrites
        assert_eq!(
            move_pessoal_file(&base, "brainstorming/x/notes/a.md", "brainstorming/y").unwrap_err(),
            "err.file_exists_in_target"
        );
        // the destination folder must already exist
        assert_eq!(
            move_pessoal_file(&base, "brainstorming/x/notes/a.md", "brainstorming/zzz")
                .unwrap_err(),
            "err.not_found"
        );
    }

    #[test]
    fn guarded_existing_refuses_outside_the_root() {
        // brain_open_external relies on this guard: a traversal path is refused.
        let base = tmp("guard");
        std::fs::create_dir_all(base.join("pessoal")).unwrap();
        std::fs::write(base.join("pessoal/a.wav"), b"RIFF").unwrap();
        assert!(guarded_existing(&base, "pessoal/a.wav").is_ok());
        assert!(guarded_existing(&base, "../../../etc/passwd").is_err());
    }

    #[test]
    fn meta_json_round_trip_preserves_marcadores_and_tags() {
        // BR-8 posture: markers carry only types/timecodes (never prose) and a
        // meta.json rewrite (e.g. set_category) must not drop them.
        let base = tmp("meta");
        let dir = base.join("brainstorming/x");
        std::fs::create_dir_all(&dir).unwrap();
        let meta = r#"{"tema":"x","nome":"X","marcadores":[
            {"tipo":"duvida","t_ms":1000},{"tipo":"decisao"}],
            "tags":["frota","custos"]}"#;
        std::fs::write(dir.join("meta.json"), meta).unwrap();

        let m = read_meta(&dir);
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"duvida\""));
        assert!(json.contains("\"custos\""));
    }

    // ADR-0014 / BR-8: the raw meeting transcript never enters the fila; the
    // meeting is represented by its relatorio.md, notes/analyses go as themselves.
    #[test]
    fn is_queueable_blocks_transcript_audio_audit_only() {
        assert!(is_queueable("brainstorming/f/meetings/r1/relatorio.md"));
        assert!(is_queueable("brainstorming/f/meetings/r1/notes/analise.md"));
        assert!(is_queueable("brainstorming/f/notes/ideia.md"));
        assert!(is_queueable("brainstorming/f/attachments/ata.txt"));
        // transcript / audit / audio / non-text never go
        assert!(!is_queueable("brainstorming/f/meetings/r1/reuniao.md"));
        assert!(!is_queueable("brainstorming/f/meetings/r1/audit.jsonl"));
        assert!(!is_queueable(
            "brainstorming/f/meetings/r1/audio/system.wav"
        ));
        assert!(!is_queueable("brainstorming/f/attachments/deck.pdf"));
    }

    // Names must be unique across the brainstorming so two files with the same
    // basename (two meetings' relatorio.md) never overwrite each other in inbox/.
    #[test]
    fn queue_name_for_flattens_path_and_is_collision_free() {
        assert_eq!(
            queue_name_for("brainstorming/frota/meetings/r1/relatorio.md"),
            "frota-meetings-r1-relatorio.md"
        );
        assert_ne!(
            queue_name_for("brainstorming/frota/meetings/r1/relatorio.md"),
            queue_name_for("brainstorming/frota/meetings/r2/relatorio.md")
        );
        assert_eq!(
            queue_name_for("brainstorming/frota/notes/ideia.md"),
            "frota-notes-ideia.md"
        );
    }

    // T-6 · AC-6 (ADR-0018) — "enviar tudo → fila" enumerates every real file. A
    // meeting now contributes its `notes/*` and NOTHING else: no report (it no
    // longer exists) and never the transcript. Legacy consolidated reports in
    // attachments/ are still skipped (ADR-0014).
    #[test]
    fn queueable_files_resolves_a_meeting_to_its_notas_only() {
        let base = tmp("queueable");
        let root = base.join("brainstorming/frota-2026");
        let d = root.join("meetings/2026-07-27-1000-plano");
        std::fs::create_dir_all(d.join("notes")).unwrap();
        std::fs::write(d.join("reuniao.md"), "# transcrição\n\n[00:00] fala\n").unwrap();
        // a report left behind by an old version is not a queue representative
        std::fs::write(d.join("relatorio.md"), "# Relatório\n\n## Resumo\n\nok\n").unwrap();
        std::fs::write(d.join("notes/analise.md"), "# Análise\n\npontos\n").unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/ideia.md"), "# Ideia\n\nx\n").unwrap();
        std::fs::create_dir_all(root.join("attachments")).unwrap();
        std::fs::write(root.join("attachments/ata.md"), "# Ata\n\ny\n").unwrap();
        // a legacy consolidated report must NOT be re-ingested
        std::fs::write(
            root.join("attachments/2026-07-27-0900-relatorio.md"),
            "# old\n",
        )
        .unwrap();

        let mut got = queueable_files(&base, "frota-2026");
        got.sort();
        assert_eq!(
            got,
            vec![
                "brainstorming/frota-2026/attachments/ata.md".to_string(),
                "brainstorming/frota-2026/meetings/2026-07-27-1000-plano/notes/analise.md"
                    .to_string(),
                "brainstorming/frota-2026/notes/ideia.md".to_string(),
            ]
        );
    }

    // T-6 · AC-7 — a meeting nobody analysed has nothing to send. Zero items is
    // the honest answer; the UI turns it into a stated reason, not a failure.
    #[test]
    fn queueable_files_gives_an_unanalysed_meeting_zero_items() {
        let base = tmp("queueable-vazia");
        let d = base.join("brainstorming/frota/meetings/2026-07-27-1000-plano");
        std::fs::create_dir_all(d.join("notes")).unwrap();
        std::fs::write(d.join("reuniao.md"), "# transcrição\n").unwrap();
        std::fs::write(d.join("audit.jsonl"), "{}\n").unwrap();

        assert!(queueable_files(&base, "frota").is_empty());
    }

    #[test]
    fn promote_never_leaks_into_pessoal_and_respects_deny_list() {
        // The headline ADR-0009 guard: promotion copies NO denied file into
        // contexts/ and leaves NO ref pointing back into the git-ignored world.
        let base = tmp("promote");
        // destination context
        std::fs::create_dir_all(base.join("contexts/frota")).unwrap();
        std::fs::write(
            base.join("contexts/frota/context.md"),
            "# frota\n\n## 6 · Hotspots\n\n(sem registros ainda)\n",
        )
        .unwrap();
        // source notebook with allowed + denied refs
        let src_dir = base.join("pessoal/temas/x/notes");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(base.join("pessoal/temas/x/meetings/r1")).unwrap();
        std::fs::write(base.join("pessoal/temas/x/chart.png"), b"PNGDATA").unwrap();
        std::fs::write(base.join("pessoal/temas/x/meetings/r1/audio.wav"), b"RIFF").unwrap();
        std::fs::write(base.join("pessoal/temas/x/meetings/r1/audit.jsonl"), "{}\n").unwrap();
        let nb = "---\nloro: 1\nid: x\ntema: x\nrefs:\n\
            \x20 - id: r1\n    tipo: image\n    caminho: acervo://pessoal/temas/x/chart.png\n\
            \x20 - id: r2\n    tipo: audio\n    caminho: acervo://pessoal/temas/x/meetings/r1/audio.wav\n\
            \x20 - id: r3\n    tipo: other\n    caminho: acervo://pessoal/temas/x/meetings/r1/audit.jsonl\n\
            ---\n\n# Descoberta\n\nVer grafico [gráfico](ref:r1), audio [áudio](ref:r2) e [audit](ref:r3).\n";
        std::fs::write(src_dir.join("n.md"), nb).unwrap();

        let rep = promote(
            &base,
            "pessoal/temas/x/notes/n.md",
            "frota",
            "hotspot",
            "rfc/frota",
            "2026-07-27",
        )
        .unwrap();

        // allowed asset copied; audio became a text stub; audit NEVER copied
        assert!(base.join("contexts/frota/referencias/chart.png").is_file());
        assert!(base
            .join("contexts/frota/referencias/audio.wav.txt")
            .is_file());
        assert!(!base.join("contexts/frota/referencias/audio.wav").exists());
        assert!(!base.join("contexts/frota/referencias/audit.jsonl").exists());

        // no staged file under contexts/ carries a PATH into the git-ignored
        // world (the real leak: "pessoal/" or an "acervo://pessoal" ref)
        let leaks = |t: &str| t.contains("pessoal/") || t.contains("acervo://pessoal");
        for rel in &rep.staged_files {
            let txt = std::fs::read_to_string(base.join(rel)).unwrap_or_default();
            assert!(!leaks(&txt), "staged {rel} leaked a path into pessoal/");
        }
        // context.md carries the prose with rewritten refs, no pessoal path
        let ctx = std::fs::read_to_string(base.join("contexts/frota/context.md")).unwrap();
        assert!(ctx.contains("referencias/chart.png"));
        assert!(ctx.contains("referencias/audio.wav.txt"));
        assert!(!leaks(&ctx));
        assert!(!ctx.contains("ref:r1"));

        // rewritten refs never point back into pessoal/
        assert!(!rep.rewritten_refs.is_empty());
        for rw in &rep.rewritten_refs {
            assert!(rw.to.starts_with("referencias/"));
        }
        // non-destructive: source stays put and is stamped promovido
        let stamped = std::fs::read_to_string(base.join("pessoal/temas/x/notes/n.md")).unwrap();
        assert!(stamped.contains("promovido:"));
        assert!(stamped.contains("para: frota"));
        assert!(base.join("contexts/frota/CHANGELOG.md").is_file());
    }

    // ---- #44: move a meeting with its whole analysis ------------------------
    // A meeting is the FOLDER `meetings/<id>/`; `move_pessoal_file` demands a file
    // and cannot serve. The move renames the whole directory — that is what makes
    // the analysis, the audio and the audit travel together without anything
    // re-enumerating them (hotspot #46: nothing here re-implements `is_queueable`).

    // A complete meeting fixture under `brainstorming/<slug>/meetings/<id>/`.
    fn meeting_fixture(base: &Path, slug: &str, id: &str) -> PathBuf {
        let dir = base.join(format!("brainstorming/{slug}/meetings/{id}"));
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::create_dir_all(dir.join("audio")).unwrap();
        std::fs::write(
            dir.join("reuniao.md"),
            format!("---\nloro: 1\nid: {id}\ntema: {slug}\ncriado_em: 2026-08-08\n---\n\n# Reunião\n\ncorpo da transcrição\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            format!(
                "{{\n  \"id\": \"{id}\",\n  \"tema\": \"{slug}\",\n  \"status\": \"done\"\n}}\n"
            ),
        )
        .unwrap();
        std::fs::write(dir.join("notes/analise-2026-08-08.md"), "a análise").unwrap();
        std::fs::write(dir.join("audit.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("audio/mic.webm"), b"\x00\x01").unwrap();
        dir
    }

    // AC-1 · T-1
    #[test]
    fn move_meeting_dir_moves_the_whole_folder() {
        let base = tmp("mvmtg");
        let src = meeting_fixture(&base, "origem", "2026-08-08-1200-reuniao");
        std::fs::create_dir_all(base.join("brainstorming/destino/meetings")).unwrap();

        let out = move_meeting_dir(
            &base,
            "brainstorming/origem/meetings/2026-08-08-1200-reuniao",
            "destino",
        )
        .unwrap();

        assert_eq!(
            out,
            "brainstorming/destino/meetings/2026-08-08-1200-reuniao"
        );
        let dst = base.join(&out);
        for f in [
            "reuniao.md",
            "manifest.json",
            "notes/analise-2026-08-08.md",
            "audit.jsonl",
            "audio/mic.webm",
        ] {
            assert!(dst.join(f).exists(), "{f} should have travelled along");
        }
        assert!(!src.exists(), "nothing may be left at the source");
    }

    // AC-2 · T-4 — `tema` is rewritten in BOTH places and the transcript is untouched
    #[test]
    fn move_meeting_dir_retemas_manifest_and_front_matter() {
        let base = tmp("mvmtg-tema");
        let src = meeting_fixture(&base, "origem", "m1");
        let corpo_antes = std::fs::read_to_string(src.join("reuniao.md")).unwrap();
        std::fs::create_dir_all(base.join("brainstorming/destino/meetings")).unwrap();

        let out = move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "destino").unwrap();
        let dst = base.join(&out);

        let manifest = std::fs::read_to_string(dst.join("manifest.json")).unwrap();
        assert!(
            manifest.contains("\"tema\": \"destino\""),
            "manifest: {manifest}"
        );
        let living = std::fs::read_to_string(dst.join("reuniao.md")).unwrap();
        assert!(living.contains("tema: destino"), "front matter: {living}");
        assert!(!living.contains("tema: origem"));
        // AC-2: the body is REALLY identical — the earlier assertion stopped at the
        // body's first markdown rule and was empty from there on.
        let corpo = |s: &str| {
            let r = s.strip_prefix("---\n").unwrap();
            let end = r.find("\n---").unwrap();
            r[end..].to_string()
        };
        assert_eq!(corpo(&living), corpo(&corpo_antes));
    }

    // AC-3 · T-2 — a collision never overwrites (ADR-0009 precedent)
    #[test]
    fn move_meeting_dir_refuses_a_collision_and_leaves_the_source_intact() {
        let base = tmp("mvmtg-col");
        let src = meeting_fixture(&base, "origem", "m1");
        meeting_fixture(&base, "destino", "m1");

        assert_eq!(
            move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "destino").unwrap_err(),
            "err.file_exists_in_target"
        );
        assert!(src.join("reuniao.md").is_file(), "the source stays intact");
        let manifest = std::fs::read_to_string(src.join("manifest.json")).unwrap();
        assert!(manifest.contains("\"tema\": \"origem\""), "and un-retemaed");
    }

    // AC-4 · T-3
    #[test]
    fn move_meeting_dir_refuses_escapes_and_non_meetings() {
        let base = tmp("mvmtg-esc");
        meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("contexts/c")).unwrap();
        std::fs::create_dir_all(base.join("brainstorming/origem/notes")).unwrap();
        std::fs::write(base.join("brainstorming/origem/notes/a.md"), "x").unwrap();

        // AC-4 names the codes — assert them, not just `is_err`
        assert_eq!(
            move_meeting_dir(&base, "contexts/c", "origem").unwrap_err(),
            "err.outside_brainstorm"
        );
        assert_eq!(
            move_meeting_dir(&base, "brainstorming/origem/meetings/../../..", "destino")
                .unwrap_err(),
            "err.invalid_path"
        );
        assert_eq!(
            move_meeting_dir(&base, "brainstorming/origem/notes/a.md", "destino").unwrap_err(),
            "err.not_found"
        );
        assert_eq!(
            move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "nao-existe").unwrap_err(),
            "err.not_found"
        );
        assert_eq!(
            move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "a/b").unwrap_err(),
            "err.invalid_path"
        );
    }

    // T-5 — the moved meeting is listed at the destination and gone from the source
    #[test]
    fn moved_meeting_is_listed_at_the_destination_only() {
        let base = tmp("mvmtg-list");
        meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("brainstorming/destino/meetings")).unwrap();

        move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "destino").unwrap();

        assert!(list_meetings(&base, "origem").is_empty());
        let no_destino = list_meetings(&base, "destino");
        assert_eq!(no_destino.len(), 1);
        assert_eq!(no_destino[0].id, "m1");
    }

    // T-6 · BR-8 — the move does NOT enumerate the meeting: it is a directory
    // rename, so the transcript and the audio reach the destination without
    // passing `is_queueable`. BR-8 stays the fila's business alone, and this test
    // pins that nothing here re-implements it (hotspot #46).
    #[test]
    fn br8_move_does_not_reimplement_the_queue_gate() {
        let base = tmp("mvmtg-br8");
        meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("brainstorming/destino/meetings")).unwrap();

        let out = move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "destino").unwrap();
        let dst = base.join(&out);

        // what the fila BARS travelled along — proof the move does not filter
        assert!(dst.join("reuniao.md").is_file());
        assert!(dst.join("audio/mic.webm").is_file());
        assert!(dst.join("audit.jsonl").is_file());
        assert!(
            !is_queueable("reuniao.md"),
            "BR-8 still bars it from the fila"
        );
        assert!(!is_queueable("audit.jsonl"));
        // and what the fila ACCEPTS is still accepted, at the destination
        assert!(is_queueable("notes/analise-2026-08-08.md"));
    }

    // BR-1 — inference and meeting material live in the NON-versioned world.
    // `move_meeting_dir` is a new path for relocating a transcript and its audio,
    // so it needs the invariant
    // `meeting_stays_under_brainstorming_and_is_never_versioned` guards: a symlink
    // under the brainstorming tree must not bridge into `contexts/`.
    #[test]
    #[cfg(unix)]
    fn br1_move_never_leaks_a_meeting_into_the_versioned_tree() {
        let base = tmp("mvmtg-br1");
        meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("contexts/c")).unwrap();
        std::fs::create_dir_all(base.join("brainstorming/ponte")).unwrap();
        // brainstorming/ponte/meetings -> contexts/c
        std::os::unix::fs::symlink(
            base.join("contexts/c"),
            base.join("brainstorming/ponte/meetings"),
        )
        .unwrap();

        assert_eq!(
            move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "ponte").unwrap_err(),
            "err.outside_brainstorm"
        );
        assert!(
            base.join("brainstorming/origem/meetings/m1/reuniao.md")
                .is_file(),
            "the meeting stays where it was"
        );
        assert!(
            !base.join("contexts/c/m1").exists(),
            "and NOTHING of it reaches the versioned tree"
        );
    }

    // A brainstorming with no `meetings/` is still a valid destination: the folder
    // is created on demand, as `create_meeting` does, instead of being offered and
    // then failing.
    #[test]
    fn move_meeting_dir_creates_the_destination_reunioes_folder() {
        let base = tmp("mvmtg-mk");
        meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("brainstorming/novo")).unwrap();

        let out = move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "novo").unwrap();
        assert_eq!(out, "brainstorming/novo/meetings/m1");
        assert!(base.join(&out).join("manifest.json").is_file());
    }

    // Inbound references must not be left dangling.
    #[test]
    fn retarget_refs_rewrites_paths_and_anchors_on_segment_boundaries() {
        let old = "brainstorming/a/meetings/m1";
        let new = "brainstorming/b/meetings/m1";
        let doc = concat!(
            "  - caminho: brainstorming/a/meetings/m1/notes/x.md\n",
            "veja [isto](acervo://brainstorming/a/meetings/m1/reuniao.md#h1)\n",
            "  - caminho: brainstorming/a/meetings/m10/notes/y.md\n",
            "  - caminho: brainstorming/a/notes/z.md\n",
        );
        let out = retarget_refs_in_content(doc, old, new);
        assert!(out.contains(&format!("caminho: {new}/notes/x.md")));
        assert!(out.contains(&format!("acervo://{new}/reuniao.md#h1")));
        assert!(
            out.contains("meetings/m10/notes/y.md"),
            "m10 is not m1: only a whole segment matches"
        );
        assert!(
            out.contains("brainstorming/a/notes/z.md"),
            "an unrelated path stays"
        );
    }

    #[test]
    fn retarget_refs_is_a_noop_when_nothing_points_at_the_meeting() {
        let doc = "  - caminho: brainstorming/x/notes/a.md\n";
        assert_eq!(
            retarget_refs_in_content(
                doc,
                "brainstorming/a/meetings/m1",
                "brainstorming/b/meetings/m1"
            ),
            doc
        );
    }

    // B1 — an empty, dotted or non-slug destination used to slip through every
    // guard and rename the meeting into a phantom `brainstorming/meetings/`,
    // where `resolve_meeting_dir` could never find it again.
    #[test]
    fn move_meeting_dir_refuses_a_destination_that_is_not_a_brainstorming() {
        let base = tmp("mvmtg-slug");
        let src = meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("brainstorming/avulso")).unwrap();

        for bad in ["", ".", "..", "avulso", "Com Espaço", "a/b", "MAIÚSCULO"] {
            assert_eq!(
                move_meeting_dir(&base, "brainstorming/origem/meetings/m1", bad).unwrap_err(),
                "err.invalid_path",
                "destination {bad:?} must be refused"
            );
        }
        assert!(src.join("reuniao.md").is_file(), "nothing moved");
        assert!(
            !base.join("brainstorming/meetings").exists(),
            "no phantom folder is created"
        );
    }

    // B5 — the manifest stores acervo-relative paths of its own material (audio,
    // artifacts, refs). A move that rewrites only `tema` leaves every one of them
    // naming a directory that no longer exists.
    #[test]
    fn move_meeting_dir_repaths_the_manifest_of_the_moved_meeting() {
        let base = tmp("mvmtg-repath");
        let src = meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("brainstorming/destino/meetings")).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            r#"{
  "id": "m1",
  "tema": "origem",
  "status": "done",
  "audio": { "mic": "brainstorming/origem/meetings/m1/audio/mic.webm" },
  "artifacts": [
    { "id": "a1", "kind": "notes", "name": "n.md",
      "rel": "brainstorming/origem/meetings/m1/artefatos/notes/n.md" }
  ],
  "refs": [
    { "id": "r1", "tipo": "anexo",
      "caminho": "brainstorming/origem/meetings/m1/notes/analise-2026-08-08.md" },
    { "id": "r2", "tipo": "anexo",
      "caminho": "brainstorming/origem/attachments/planilha.csv" }
  ]
}
"#,
        )
        .unwrap();

        let out = move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "destino").unwrap();
        let manifest = std::fs::read_to_string(base.join(&out).join("manifest.json")).unwrap();

        assert!(
            !manifest.contains("brainstorming/origem/meetings/m1"),
            "no path still names the old location: {manifest}"
        );
        assert!(manifest.contains("brainstorming/destino/meetings/m1/audio/mic.webm"));
        assert!(manifest.contains("brainstorming/destino/meetings/m1/artefatos/notes/n.md"));
        assert!(
            manifest.contains("brainstorming/origem/attachments/planilha.csv"),
            "a ref OUTSIDE the meeting is not the move's business: {manifest}"
        );
    }

    // B6 — a custom habilidade (ADR-0005 §E) lives in the acervo's
    // `.claude/commands/` and, per ADR-0007, may be aimed at an EXCERPT through an
    // `acervo://<rel>#<annot-id>` anchor. A move that skipped it left the tool
    // pointing at a meeting that is no longer there.
    #[test]
    fn move_meeting_dir_retargets_a_custom_habilidade() {
        let base = tmp("mvmtg-hab");
        meeting_fixture(&base, "origem", "m1");
        std::fs::create_dir_all(base.join("brainstorming/destino/meetings")).unwrap();
        let cmds = base.join(".claude/commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(
            cmds.join("minha-ferramenta.md"),
            "Resuma [o trecho](acervo://brainstorming/origem/meetings/m1/reuniao.md#an_7).\n",
        )
        .unwrap();
        // a built-in carries only the literal placeholder, which matches no rel
        std::fs::write(
            cmds.join("loro-digest.md"),
            "cada item é `- [<título>](acervo://<caminho>)`\n",
        )
        .unwrap();

        move_meeting_dir(&base, "brainstorming/origem/meetings/m1", "destino").unwrap();

        let tool = std::fs::read_to_string(cmds.join("minha-ferramenta.md")).unwrap();
        assert!(
            tool.contains("acervo://brainstorming/destino/meetings/m1/reuniao.md#an_7"),
            "the anchor follows the meeting: {tool}"
        );
        let builtin = std::fs::read_to_string(cmds.join("loro-digest.md")).unwrap();
        assert!(
            builtin.contains("acervo://<caminho>"),
            "a placeholder is not a reference: {builtin}"
        );
    }

    // B4 — the retarget is a read-modify-write over living documents. Another
    // meeting's `reuniao.md` can be receiving a transcript chunk at that very
    // moment, and without its lock the append is read-then-clobbered.
    #[test]
    fn retarget_refs_after_move_takes_the_lock_of_the_meeting_it_rewrites() {
        use std::sync::mpsc;
        use std::time::Duration;

        let base = tmp("mvmtg-lock");
        let viva = base.join("brainstorming/x/meetings/m2");
        std::fs::create_dir_all(&viva).unwrap();
        std::fs::write(
            viva.join("reuniao.md"),
            "  - caminho: brainstorming/a/meetings/m1/reuniao.md\n",
        )
        .unwrap();

        let lock = crate::meeting::lock_for("m2");
        let guard = lock.lock().unwrap();

        let (tx, rx) = mpsc::channel();
        let b = base.clone();
        let h = std::thread::spawn(move || {
            let n = retarget_refs_after_move(
                &b,
                "brainstorming/a/meetings/m1",
                "brainstorming/b/meetings/m1",
            );
            let _ = tx.send(n);
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "it must WAIT for the meeting that owns the file"
        );
        drop(guard);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            1,
            "and rewrite it once the owner is done"
        );
        h.join().unwrap();
        let txt = std::fs::read_to_string(viva.join("reuniao.md")).unwrap();
        assert!(
            txt.contains("brainstorming/b/meetings/m1/reuniao.md"),
            "{txt}"
        );
    }
}
