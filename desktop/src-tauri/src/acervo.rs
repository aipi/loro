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

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::config::read_brain_config;
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
fn guarded_existing(base: &Path, rel: &str) -> Result<PathBuf, String> {
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
    is_audio(&l) || l == "auditoria.jsonl" || l == "meta.json" || l == "manifest.json"
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
    for sub in [
        "",
        "reunioes",
        "investigacoes",
        "perguntas",
        "notas",
        "relatorios",
        "apresentacoes",
        "anexos",
    ] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| e.to_string())?;
    }
    let indice = dir.join("indice.md");
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
    reunioes: usize,
    atualizado_em: String,
}

// ADR-0007: brainstormings created before apresentacoes/anexos existed never
// got those folders — self-heal on every list call (cheap, idempotent,
// create-if-absent) instead of requiring an explicit migration step. Mirrors
// the "respect existing structure, fill only gaps" premise already used for
// skill files (ensure_meeting_skills).
fn ensure_brainstorming_subfolders(dir: &Path) {
    for sub in ["apresentacoes", "anexos"] {
        let _ = std::fs::create_dir_all(dir.join(sub));
    }
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
                        reunioes: count_entries(&e.path().join("reunioes")),
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
}

fn list_meetings(base: &Path, slug: &str) -> Vec<MeetingListItem> {
    let dir = brainstorming_dir(base).join(slug).join("reunioes");
    let mut out: Vec<MeetingListItem> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().join("manifest.json").is_file())
                .map(|e| {
                    let id = e.file_name().to_string_lossy().to_string();
                    let man: MeetingManifestLite =
                        std::fs::read_to_string(e.path().join("manifest.json"))
                            .ok()
                            .and_then(|t| serde_json::from_str(&t).ok())
                            .unwrap_or_default();
                    MeetingListItem {
                        rel: format!("brainstorming/{slug}/reunioes/{id}"),
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

// ---- user tools (ADR-0006 §E) -----------------------------------------------
// A tool is any `.md` in `.claude/commands/` that is NOT one of the 7 built-in
// skills — the filename IS the slash-command (`minha-ferramenta.md` ->
// `/minha-ferramenta`). This deny-list is the only thing that keeps a custom
// tool from shadowing/deleting a built-in one; it must stay in sync with the
// skill list materialized by ensure_acervo_structure/ensure_meeting_skills.
pub const BUILTIN_SKILLS: [&str; 9] = [
    "loro-context.md",
    "loro-analyse.md",
    "loro-question.md",
    "loro-ask.md",
    "loro-note.md",
    "loro-sync.md",
    "loro-tool.md",
    "loro-presentation.md",
    "loro-artifact.md",
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

#[tauri::command]
pub fn brain_new_tool(nome: String, conteudo: String) -> Result<String, String> {
    new_tool(&acervo_base()?, &nome, &conteudo)
}

#[tauri::command]
pub fn brain_delete_tool(rel: String) -> Result<(), String> {
    delete_tool(&acervo_base()?, &rel)
}

// Create a notebook (.md) with living front-matter. Under a brainstorming's notas/
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
                brainstorming_dir(base).join(t).join("notas"),
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
        });
    }
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
    let ctx_dir = base.join("contextos").join(dest_context);
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
                staged.push(format!("contextos/{dest_context}/referencias/{stub_name}"));
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
        staged.push(format!(
            "contextos/{dest_context}/referencias/{target_name}"
        ));
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
    staged.push(format!("contextos/{dest_context}/context.md"));

    // CHANGELOG entry.
    let changelog_entry = format!(
        "## {today} — promovido: {title}\n\nConteúdo promovido da produção pessoal para o contexto `{dest_context}`."
    );
    append_changelog(&ctx_dir.join("CHANGELOG.md"), &changelog_entry)?;
    staged.push(format!("contextos/{dest_context}/CHANGELOG.md"));

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

// ---- consolidated brainstorming report (ADR-0013) ---------------------------
//
// The user selects parts of a brainstorming (some meetings / investigations /
// questions / notes) and the app builds ONE consolidated report merging ALL of
// them together — NEVER the raw transcript or audio. That single report is what
// gets sent to the fila (inbox/). It references the source meetings via acervo://.

// Now as `AAAA-MM-DD-HHMM` (UTC), for the report filename. Dependency-free.
fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let tod = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}-{:02}{:02}",
        tod / 3600,
        (tod % 3600) / 60
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelItem {
    kind: String, // reuniao | investigacao | pergunta | nota
    rel: String,  // acervo-relative source (meeting dir/file, or a note file)
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

// A gathered part ready for the pure assembler.
struct ReportPart {
    title: String,
    rel: String, // acervo:// anchor to the source
    resumo: String,
    decisoes: String,
    duvidas: String,
    investigacoes: String,
    notas: String,
    dados: String,
}

// Prose under a `## <heading>` up to the next `## `, trimmed. The DEFERRED_PROSE
// placeholder ("resumo automático — em breve") is treated as empty (no real prose
// yet). Returns "" when the section is absent/empty. Pure.
// Source parts may be pt- or en-headed (ADR-0002 §1 allows mixed-language
// acervos), so extraction tries every known name for a section.
fn extract_section_any(md: &str, headings: &[&str]) -> String {
    for h in headings {
        let s = extract_section(md, h);
        if !s.is_empty() {
            return s;
        }
    }
    String::new()
}

fn extract_section(md: &str, heading: &str) -> String {
    let mut lines = md.lines();
    let want = format!("## {heading}");
    let mut found = false;
    let mut body = String::new();
    for line in lines.by_ref() {
        if !found {
            if line.trim() == want {
                found = true;
            }
            continue;
        }
        if line.starts_with("## ") {
            break;
        }
        body.push_str(line);
        body.push('\n');
    }
    let cleaned: String = body
        .lines()
        .filter(|l| !l.contains("resumo automático") && !l.contains("automatic summary"))
        .collect::<Vec<_>>()
        .join("\n");
    cleaned.trim().to_string()
}

// Gather one selected part into a ReportPart. Meetings read their manifest
// (titulo + markers) and relatorio.md sections; standalone items read their body.
fn gather_part(base: &Path, item: &SelItem) -> Result<ReportPart, String> {
    let rel = normalize_rel(&item.rel)?;
    if item.kind == "reuniao" {
        // rel may point at the meeting dir or a file inside it — resolve to the dir
        let abs = base.join(&rel);
        let dir = if abs.is_dir() {
            abs
        } else {
            abs.parent().map(|p| p.to_path_buf()).unwrap_or(abs)
        };
        if !dir.starts_with(base) || !dir.join("manifest.json").is_file() {
            return Err("err.meeting_not_found".into());
        }
        let dir_rel = dir
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or(rel);
        let man: MeetingManifestLite = std::fs::read_to_string(dir.join("manifest.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let relatorio = std::fs::read_to_string(dir.join("relatorio.md")).unwrap_or_default();
        let title = if man.titulo.is_empty() {
            dir.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("reunião")
                .to_string()
        } else {
            man.titulo
        };
        Ok(ReportPart {
            title,
            rel: dir_rel,
            resumo: extract_section_any(&relatorio, &["Resumo", "Summary"]),
            decisoes: extract_section_any(&relatorio, &["Decisões", "Decisions"]),
            duvidas: extract_section_any(
                &relatorio,
                &["Dúvidas & Respostas", "Questions & Answers"],
            ),
            investigacoes: extract_section_any(&relatorio, &["Investigações", "Investigations"]),
            notas: String::new(),
            dados: extract_section_any(&relatorio, &["Dados & Gráficos", "Data & Charts"]),
        })
    } else {
        let abs = guarded_existing(base, &rel)?;
        if !abs.is_file() {
            return Err("err.item_not_found".into());
        }
        let content = content_of(&abs)?;
        let (_, body) = split_front_matter(&content);
        let title = notebook_title(&rel, &body);
        let corpo = body.trim().to_string();
        // route the body into the section matching the item kind
        let (duvidas, investigacoes, notas) = match item.kind.as_str() {
            "pergunta" => (corpo.clone(), String::new(), String::new()),
            "investigacao" => (String::new(), corpo.clone(), String::new()),
            _ => (String::new(), String::new(), corpo.clone()), // nota
        };
        Ok(ReportPart {
            title,
            rel,
            resumo: String::new(),
            decisoes: String::new(),
            duvidas,
            investigacoes,
            notas,
            dados: String::new(),
        })
    }
}

// Emit one `## <title>` section with a `### <part title>` block per part that has
// prose for `sel`. Empty across all parts -> a single "_(sem registros)_".
fn push_report_section(
    out: &mut String,
    title: &str,
    empty_note: &str,
    parts: &[ReportPart],
    sel: impl Fn(&ReportPart) -> &str,
) {
    out.push_str(&format!("## {title}\n\n"));
    let mut any = false;
    for p in parts {
        let s = sel(p).trim();
        if !s.is_empty() {
            out.push_str(&format!("### {}\n\n{}\n\n", p.title, s));
            any = true;
        }
    }
    if !any {
        out.push_str(empty_note);
        out.push_str("\n\n");
    }
}

// Assemble ONE consolidated report merging all parts. Pure/IO-free. NEVER contains
// a `## Transcrição` section nor any audio reference (ADR-0013 / BR-8).
// The report is born in the active UI language (ADR-0002 §1); anything but
// "en" falls back to pt, the original.
fn assemble_brainstorm_report(slug: &str, today: &str, parts: &[ReportPart], lang: &str) -> String {
    let en = lang == "en";
    let empty_note = if en {
        "_(no entries)_"
    } else {
        "_(sem registros)_"
    };
    let mut out = String::new();
    out.push_str(&format!(
        "# {} — {slug}\n\n",
        if en { "Report" } else { "Relatório" }
    ));
    out.push_str(if en {
        "_Consolidated report (ADR-0013) — summary, decisions, questions, investigations and data from the selected parts. No transcript, no audio. This is what goes to the context-generation queue._\n\n"
    } else {
        "_Relatório consolidado (ADR-0013) — resumo, decisões, dúvidas, investigações e dados das partes selecionadas. Sem transcrição nem áudio. É isto que segue para a fila de geração de contexto._\n\n"
    });
    out.push_str(&format!("- Brainstorming: {slug}\n"));
    out.push_str(&format!(
        "- {}: {today}\n",
        if en { "Date" } else { "Data" }
    ));
    out.push_str(&format!(
        "- {}: {}\n\n",
        if en { "Parts" } else { "Partes" },
        parts.len()
    ));

    // Origin — links back to the source parts (references, not the transcript)
    out.push_str(if en { "## Origin\n\n" } else { "## Origem\n\n" });
    if parts.is_empty() {
        out.push_str(if en {
            "_(no parts selected)_\n\n"
        } else {
            "_(nenhuma parte selecionada)_\n\n"
        });
    } else {
        for p in parts {
            out.push_str(&format!("- [{}](acervo://{})\n", p.title, p.rel));
        }
        out.push('\n');
    }

    let s = |pt: &'static str, en_h: &'static str| if en { en_h } else { pt };
    push_report_section(&mut out, s("Resumo", "Summary"), empty_note, parts, |p| {
        &p.resumo
    });
    push_report_section(
        &mut out,
        s("Decisões", "Decisions"),
        empty_note,
        parts,
        |p| &p.decisoes,
    );
    push_report_section(
        &mut out,
        s("Dúvidas & Respostas", "Questions & Answers"),
        empty_note,
        parts,
        |p| &p.duvidas,
    );
    push_report_section(
        &mut out,
        s("Investigações", "Investigations"),
        empty_note,
        parts,
        |p| &p.investigacoes,
    );
    push_report_section(&mut out, s("Notas", "Notes"), empty_note, parts, |p| {
        &p.notas
    });
    push_report_section(&mut out, s("Dados", "Data"), empty_note, parts, |p| {
        &p.dados
    });
    // owner decision (2026-07-28): no "## Estatísticas" counter block — the
    // counts carried no meaning for the reader and were dropped everywhere.
    out
}

// If the selection is empty, gather ALL parts of the brainstorming: every meeting
// under reunioes/ plus every file under investigacoes/, perguntas/, notas/.
fn all_parts_of(base: &Path, slug: &str) -> Vec<SelItem> {
    let root = brainstorming_dir(base).join(slug);
    let mut items = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root.join("reunioes")) {
        for e in rd.flatten().filter(|e| e.path().is_dir()) {
            let id = e.file_name().to_string_lossy().to_string();
            items.push(SelItem {
                kind: "reuniao".into(),
                rel: format!("brainstorming/{slug}/reunioes/{id}"),
            });
        }
    }
    for (sub, kind) in [
        ("investigacoes", "investigacao"),
        ("perguntas", "pergunta"),
        ("notas", "nota"),
        ("apresentacoes", "apresentacao"),
        ("anexos", "anexo"),
    ] {
        if let Ok(rd) = std::fs::read_dir(root.join(sub)) {
            for e in rd.flatten().filter(|e| e.path().is_file()) {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with('.') {
                    continue;
                }
                items.push(SelItem {
                    kind: kind.into(),
                    rel: format!("brainstorming/{slug}/{sub}/{n}"),
                });
            }
        }
    }
    items
}

// Testable core: gather + assemble + write the report under relatorios/. Returns
// the acervo-relative rel of the written report.
fn build_brainstorm_report(
    base: &Path,
    slug: &str,
    selection: &[SelItem],
    today: &str,
    stamp: &str,
    lang: &str,
) -> Result<String, String> {
    if !valid_context(slug) {
        return Err("err.invalid_brainstorm".into());
    }
    let root = brainstorming_dir(base).join(slug);
    if !root.is_dir() {
        return Err("err.brainstorm_not_found".into());
    }
    // empty selection == all parts of the brainstorming
    let owned_all;
    let items: &[SelItem] = if selection.is_empty() {
        owned_all = all_parts_of(base, slug);
        &owned_all
    } else {
        selection
    };
    let mut parts = Vec::new();
    for it in items {
        parts.push(gather_part(base, it)?);
    }
    let report = assemble_brainstorm_report(slug, today, &parts, lang);
    let dir = root.join("relatorios");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let fname = format!("{stamp}-relatorio.md");
    std::fs::write(dir.join(&fname), report).map_err(|e| e.to_string())?;
    Ok(format!("brainstorming/{slug}/relatorios/{fname}"))
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
// contextos/ path) and path-guarded (canonicalize + starts_with base + starts_with
// brainstorming/). The legacy `pessoal/` prefix is still accepted so un-migrated
// acervos can prune. Recursive for folders.
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
// confinement as delete (never a versioned contextos/ path); the new name is a
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
    std::process::Command::new("open")
        .arg(&p)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// An external ref (loro-sync, e.g. a Drive doc link) is only ever http(s) —
// never a local path, shell metacharacter, or other scheme (js:, file:, …).
fn is_openable_link(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

// Open an external link (e.g. a Drive doc from a `tipo: drive` ref) in the OS
// default browser. Restricted to http(s); fixed args, no shell.
#[tauri::command]
pub fn brain_open_link(url: String) -> Result<(), String> {
    if !is_openable_link(&url) {
        return Err("err.unsupported_link_scheme".into());
    }
    std::process::Command::new("open")
        .arg(&url)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildReportOut {
    rel: String,
}

// ADR-0013: build ONE consolidated report from the selected brainstorming parts
// (empty selection == all parts). The report is written under the brainstorming's
// relatorios/ (visible/openable) and is what the user then sends to the fila.
#[tauri::command]
pub fn brain_brainstorm_build_report(
    app: AppHandle,
    slug: String,
    selection: Vec<SelItem>,
) -> Result<BuildReportOut, String> {
    let base = acervo_base()?;
    let rel = build_brainstorm_report(
        &base,
        &slug,
        &selection,
        &today_iso(),
        &now_stamp(),
        &crate::config::ui_lang(),
    )?;
    emit_brainstorming_changed(&app, serde_json::json!({ "slug": slug, "rel": rel }));
    Ok(BuildReportOut { rel })
}

// ADR-0013: `brain_promote` (direct personal->context copy) is NO LONGER on the
// primary path — the fila (brain_send_report_to_queue -> /loro-context) is THE
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
        assert_eq!(ref_tipo("notas/x.md"), "doc");
        assert_eq!(ref_tipo("a/chart.png"), "image");
        assert_eq!(ref_tipo("a/audio.wav"), "audio");
        assert_eq!(ref_tipo("a/planilha.xlsx"), "other");
    }

    // ADR-0007: a brainstorming created before apresentacoes/anexos existed
    // (simulated here by building the old, narrower folder set by hand) must
    // self-heal the missing folders the next time it's listed — no explicit
    // migration command required.
    #[test]
    fn list_brainstormings_backfills_missing_subfolders() {
        let base = tmp("bs-backfill");
        let dir = base.join("brainstorming/legado");
        for sub in [
            "reunioes",
            "investigacoes",
            "perguntas",
            "notas",
            "relatorios",
        ] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        assert!(!dir.join("apresentacoes").exists());
        assert!(!dir.join("anexos").exists());
        let list = list_brainstormings(&base);
        assert_eq!(list.len(), 1);
        assert!(dir.join("apresentacoes").is_dir());
        assert!(dir.join("anexos").is_dir());
    }

    #[test]
    fn create_brainstorming_and_list_and_status() {
        let base = tmp("bs");
        let t = create_brainstorming(&base, "Frota 2026!", Some("produto"), "2026-07-27").unwrap();
        assert_eq!(t.slug, "frota-2026");
        assert_eq!(t.rel, "brainstorming/frota-2026");
        assert!(base.join("brainstorming/frota-2026/reunioes").is_dir());
        assert!(base.join("brainstorming/frota-2026/relatorios").is_dir());
        assert!(base.join("brainstorming/frota-2026/apresentacoes").is_dir());
        assert!(base.join("brainstorming/frota-2026/anexos").is_dir());
        assert!(base.join("brainstorming/frota-2026/indice.md").is_file());
        assert!(base.join("brainstorming/frota-2026/meta.json").is_file());

        // scaffold a meeting + a notebook to exercise the counters
        std::fs::create_dir_all(base.join("brainstorming/frota-2026/reunioes/2026-07-27-1000-x"))
            .unwrap();
        new_notebook(&base, Some("frota-2026"), "primeira nota", "2026-07-27").unwrap();

        let list = list_brainstormings(&base);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].nome, "Frota 2026!");
        assert_eq!(list[0].categoria.as_deref(), Some("produto"));
        assert_eq!(list[0].reunioes, 1);
    }

    #[test]
    fn list_meetings_reads_titulo_from_manifest_and_sorts_recent_first() {
        let base = tmp("mtgs");
        create_brainstorming(&base, "Frota", None, "2026-07-27").unwrap();
        let root = base.join("brainstorming/frota/reunioes");
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
            "brainstorming/frota/reunioes/2026-07-28-1000-recente"
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
        let (out2, id2) = add_ref_to_content(&out, "doc", "acervo://notas/y.md", None);
        assert_eq!(id2, "r2");
        assert_eq!(parse_refs(&split_front_matter(&out2).0.unwrap()).len(), 2);
    }

    #[test]
    fn resolve_ref_resolves_anchored_and_relative() {
        let base = tmp("resolve");
        std::fs::create_dir_all(base.join("pessoal/temas/x/notas")).unwrap();
        std::fs::write(base.join("pessoal/temas/x/chart.png"), b"P").unwrap();
        // anchored form
        let a = resolve_ref(
            &base,
            "pessoal/temas/x/notas/n.md",
            "acervo://pessoal/temas/x/chart.png",
        )
        .unwrap();
        assert_eq!(a.rel, "pessoal/temas/x/chart.png");
        assert_eq!(a.tipo, "image");
        assert!(a.exists);
        // relative to the source dir
        let b = resolve_ref(&base, "pessoal/temas/x/notas/n.md", "../chart.png").unwrap();
        assert_eq!(b.rel, "pessoal/temas/x/chart.png");
        assert!(b.exists);
        // a missing target resolves but reports exists:false
        let c = resolve_ref(&base, "pessoal/temas/x/notas/n.md", "../missing.md").unwrap();
        assert!(!c.exists);
        // traversal past the root is refused
        assert!(resolve_ref(&base, "a/b.md", "../../../etc/passwd").is_err());
    }

    #[test]
    fn anchor_path_leaves_http_urls_untouched() {
        assert_eq!(
            anchor_path("https://docs.google.com/document/d/ID/edit"),
            "https://docs.google.com/document/d/ID/edit"
        );
        assert_eq!(anchor_path("http://example.com/x"), "http://example.com/x");
        // local paths still get anchored as before
        assert_eq!(anchor_path("notas/x.md"), "acervo://notas/x.md");
    }

    #[test]
    fn resolve_ref_treats_https_url_as_external_link() {
        let base = tmp("resolve-link");
        let r = resolve_ref(
            &base,
            "pessoal/temas/x/notas/n.md",
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
        assert!(!is_openable_link("notas/x.md"));
        assert!(!is_openable_link("acervo://notas/x.md"));
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
        let dir = base.join("brainstorming/vendas/r1/artefatos/investigacoes");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("analise-1.md"), "corpo").unwrap();
        let rel = "brainstorming/vendas/r1/artefatos/investigacoes/analise-1.md";
        let out = rename_pessoal_file(&base, rel, "riscos do contrato").unwrap();
        assert_eq!(
            out,
            "brainstorming/vendas/r1/artefatos/investigacoes/riscos do contrato.md"
        );
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
        std::fs::create_dir_all(base.join("contextos/c")).unwrap();
        std::fs::write(base.join("contextos/c/context.md"), "x").unwrap();
        // versioned world is off-limits
        assert_eq!(
            rename_pessoal_file(&base, "contextos/c/context.md", "y").unwrap_err(),
            "err.outside_brainstorm"
        );
        // traversal in rel and in the new name
        assert!(
            rename_pessoal_file(&base, "brainstorming/../contextos/c/context.md", "y").is_err()
        );
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

    // ADR-0013: build a fixture brainstorming with 2 meetings (each with a
    // relatorio.md + manifest markers) + one investigacao/pergunta/nota, then build
    // the consolidated report and assert it merges ALL parts and never carries
    // transcript/audio.
    fn seed_report_fixture(base: &Path, slug: &str) {
        let root = base.join("brainstorming").join(slug);
        for m in ["2026-07-27-1000-planejamento", "2026-07-27-1400-custos"] {
            let d = root.join("reunioes").join(m);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("manifest.json"),
                format!(
                    r#"{{"titulo":"{m}","marcadores":[{{"tipo":"decisao"}},{{"tipo":"duvida"}},{{"tipo":"investigacao"}}]}}"#
                ),
            )
            .unwrap();
            std::fs::write(
                d.join("relatorio.md"),
                format!("# {m}\n\n## Resumo\n\nResumo de {m}.\n\n## Decisões\n\nDecidimos X em {m}.\n\n## Transcrição\n\n[00:00] fala secreta\n"),
            )
            .unwrap();
            // an audio file on disk must never surface in the consolidated report
            std::fs::create_dir_all(d.join("audio")).unwrap();
            std::fs::write(d.join("audio/system.wav"), b"RIFF").unwrap();
        }
        std::fs::create_dir_all(root.join("investigacoes")).unwrap();
        std::fs::write(
            root.join("investigacoes/analise-a.md"),
            "---\nloro: 1\n---\n\n# Custo por rota\n\nDados apontam alta de 12%.\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("perguntas")).unwrap();
        std::fs::write(
            root.join("perguntas/q1.md"),
            "# Qual o prazo?\n\nEm aberto.\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("notas")).unwrap();
        std::fs::write(
            root.join("notas/n1.md"),
            "# Nota rápida\n\nLembrar do fornecedor.\n",
        )
        .unwrap();
    }

    #[test]
    fn assemble_brainstorm_report_merges_all_parts_and_aggregates_stats() {
        let base = tmp("report");
        seed_report_fixture(&base, "frota-2026");
        let rel = build_brainstorm_report(
            &base,
            "frota-2026",
            &[],
            "2026-07-28",
            "2026-07-28-0900",
            "pt",
        )
        .unwrap();
        assert_eq!(
            rel,
            "brainstorming/frota-2026/relatorios/2026-07-28-0900-relatorio.md"
        );
        let r = std::fs::read_to_string(base.join(&rel)).unwrap();

        // all expected sections present — and NO counter block (owner decision
        // 2026-07-28: "Estatísticas" was dropped everywhere)
        for h in [
            "## Origem",
            "## Resumo",
            "## Decisões",
            "## Dúvidas & Respostas",
            "## Investigações",
            "## Notas",
            "## Dados",
        ] {
            assert!(r.contains(h), "missing {h}");
        }
        assert!(!r.contains("## Estatísticas"));
        // merges BOTH meetings' prose + the standalone items
        assert!(r.contains("Resumo de 2026-07-27-1000-planejamento"));
        assert!(r.contains("Resumo de 2026-07-27-1400-custos"));
        assert!(r.contains("Custo por rota")); // investigacao body under Investigações
        assert!(r.contains("Qual o prazo?")); // pergunta body under Dúvidas
                                              // nota body lands under its own "## Notas" section, not in Resumo
        let notas_sec = r.split("## Notas").nth(1).unwrap_or("");
        assert!(notas_sec.contains("Lembrar do fornecedor"));
        // references the source meetings, never the transcript/audio (BR-8)
        assert!(r.contains("acervo://brainstorming/frota-2026/reunioes/"));
        assert!(!r.contains("## Transcrição"));
        assert!(!r.contains("fala secreta"));
        assert!(!r.contains(".wav") && !r.contains("[áudio]"));
        // no aggregated marker counters either
        assert!(!r.contains("- Decisões: ") && !r.contains("- Dúvidas: "));
    }

    // ADR-0002 §1 — generated content is born in the active UI language.
    #[test]
    fn brainstorm_report_is_english_when_lang_is_en() {
        let base = tmp("report-en");
        seed_report_fixture(&base, "frota-2026");
        let rel = build_brainstorm_report(
            &base,
            "frota-2026",
            &[],
            "2026-07-28",
            "2026-07-28-0900",
            "en",
        )
        .unwrap();
        let r = std::fs::read_to_string(base.join(&rel)).unwrap();
        for h in [
            "## Origin",
            "## Summary",
            "## Decisions",
            "## Questions & Answers",
            "## Investigations",
            "## Notes",
            "## Data",
        ] {
            assert!(r.contains(h), "missing {h}");
        }
        assert!(!r.contains("## Resumo"));
        // pt-authored source meetings still feed an en report (tolerant extraction)
        assert!(r.contains("Resumo de 2026-07-27-1000-planejamento"));
    }

    #[test]
    fn extract_section_any_reads_pt_or_en_headings() {
        let en = "## Summary\n\nAll good.\n\n## Decisions\n\nShip it.\n";
        assert_eq!(extract_section_any(en, &["Resumo", "Summary"]), "All good.");
        let pt = "## Resumo\n\nTudo bem.\n";
        assert_eq!(extract_section_any(pt, &["Resumo", "Summary"]), "Tudo bem.");
        assert_eq!(extract_section_any(pt, &["Decisões", "Decisions"]), "");
    }

    #[test]
    fn build_report_subset_selection_only_includes_chosen_parts() {
        let base = tmp("report-sub");
        seed_report_fixture(&base, "frota-2026");
        let sel = vec![SelItem {
            kind: "pergunta".into(),
            rel: "brainstorming/frota-2026/perguntas/q1.md".into(),
        }];
        let rel = build_brainstorm_report(
            &base,
            "frota-2026",
            &sel,
            "2026-07-28",
            "2026-07-28-1000",
            "pt",
        )
        .unwrap();
        let r = std::fs::read_to_string(base.join(&rel)).unwrap();
        assert!(r.contains("Qual o prazo?"));
        // a meeting NOT selected must not leak in
        assert!(!r.contains("Resumo de 2026-07-27-1000-planejamento"));
        assert!(r.contains("- Partes: 1"));
    }

    // ADR-0007: anexos/ and apresentacoes/ are new brainstorming subfolders —
    // all_parts_of must enumerate them (empty selection = "everything") and
    // gather_part's unknown-kind fallback routes them into "## Notas", with no
    // further code needed (confirmed by this test, not just by reading).
    #[test]
    fn all_parts_of_includes_anexos_and_apresentacoes() {
        let base = tmp("report-anexos");
        create_brainstorming(&base, "Frota 2026", None, "2026-07-28").unwrap();
        std::fs::write(
            base.join("brainstorming/frota-2026/anexos/ata-drive.md"),
            "---\nloro: 1\nfonte: drive\n---\n\n# Ata da reunião externa\n\nPontos discutidos no Drive.\n",
        )
        .unwrap();
        std::fs::write(
            base.join("brainstorming/frota-2026/apresentacoes/deck-v1.md"),
            "---\nloro: 1\n---\n\n# Deck v1\n\n## Slide 1\n\nProposta inicial.\n",
        )
        .unwrap();
        let rel = build_brainstorm_report(
            &base,
            "frota-2026",
            &[],
            "2026-07-28",
            "2026-07-28-1100",
            "pt",
        )
        .unwrap();
        let r = std::fs::read_to_string(base.join(&rel)).unwrap();
        assert!(r.contains("Pontos discutidos no Drive."));
        assert!(r.contains("Proposta inicial."));
    }

    #[test]
    fn extract_section_ignores_placeholder_and_stops_at_next_heading() {
        let md = "## Resumo\n\n_(resumo automático — rode “analisar” para preencher)_\n\n## Decisões\n\nDecidiu-se X.\n";
        assert_eq!(extract_section(md, "Resumo"), "");
        assert_eq!(extract_section(md, "Decisões"), "Decidiu-se X.");
        assert_eq!(extract_section(md, "Ausente"), "");
    }

    #[test]
    fn promote_never_leaks_into_pessoal_and_respects_deny_list() {
        // The headline ADR-0009 guard: promotion copies NO denied file into
        // contextos/ and leaves NO ref pointing back into the git-ignored world.
        let base = tmp("promote");
        // destination context
        std::fs::create_dir_all(base.join("contextos/frota")).unwrap();
        std::fs::write(
            base.join("contextos/frota/context.md"),
            "# frota\n\n## 6 · Hotspots\n\n(sem registros ainda)\n",
        )
        .unwrap();
        // source notebook with allowed + denied refs
        let src_dir = base.join("pessoal/temas/x/notas");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(base.join("pessoal/temas/x/reunioes/r1")).unwrap();
        std::fs::write(base.join("pessoal/temas/x/chart.png"), b"PNGDATA").unwrap();
        std::fs::write(base.join("pessoal/temas/x/reunioes/r1/audio.wav"), b"RIFF").unwrap();
        std::fs::write(
            base.join("pessoal/temas/x/reunioes/r1/auditoria.jsonl"),
            "{}\n",
        )
        .unwrap();
        let nb = "---\nloro: 1\nid: x\ntema: x\nrefs:\n\
            \x20 - id: r1\n    tipo: image\n    caminho: acervo://pessoal/temas/x/chart.png\n\
            \x20 - id: r2\n    tipo: audio\n    caminho: acervo://pessoal/temas/x/reunioes/r1/audio.wav\n\
            \x20 - id: r3\n    tipo: other\n    caminho: acervo://pessoal/temas/x/reunioes/r1/auditoria.jsonl\n\
            ---\n\n# Descoberta\n\nVer grafico [gráfico](ref:r1), audio [áudio](ref:r2) e [audit](ref:r3).\n";
        std::fs::write(src_dir.join("n.md"), nb).unwrap();

        let rep = promote(
            &base,
            "pessoal/temas/x/notas/n.md",
            "frota",
            "hotspot",
            "rfc/frota",
            "2026-07-27",
        )
        .unwrap();

        // allowed asset copied; audio became a text stub; audit NEVER copied
        assert!(base.join("contextos/frota/referencias/chart.png").is_file());
        assert!(base
            .join("contextos/frota/referencias/audio.wav.txt")
            .is_file());
        assert!(!base.join("contextos/frota/referencias/audio.wav").exists());
        assert!(!base
            .join("contextos/frota/referencias/auditoria.jsonl")
            .exists());

        // no staged file under contextos/ carries a PATH into the git-ignored
        // world (the real leak: "pessoal/" or an "acervo://pessoal" ref)
        let leaks = |t: &str| t.contains("pessoal/") || t.contains("acervo://pessoal");
        for rel in &rep.staged_files {
            let txt = std::fs::read_to_string(base.join(rel)).unwrap_or_default();
            assert!(!leaks(&txt), "staged {rel} leaked a path into pessoal/");
        }
        // context.md carries the prose with rewritten refs, no pessoal path
        let ctx = std::fs::read_to_string(base.join("contextos/frota/context.md")).unwrap();
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
        let stamped = std::fs::read_to_string(base.join("pessoal/temas/x/notas/n.md")).unwrap();
        assert!(stamped.contains("promovido:"));
        assert!(stamped.contains("para: frota"));
        assert!(base.join("contextos/frota/CHANGELOG.md").is_file());
    }
}
