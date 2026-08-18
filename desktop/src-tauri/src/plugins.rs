// Loro — plugins (pacotes de extensão, ADR-0029).
//
// A plugin IS a Claude Code plugin — `.claude-plugin/plugin.json` plus, at the
// plugin root, `commands/*.md` / `skills/<n>/SKILL.md` — with one extra file that
// is Loro's own: `loro.json` (seed contexts, loops). That file is inert for
// Claude Code, so one folder serves both, and Loro invents no format (§2.2).
//
// TWO RULES CARRY THE WHOLE MODULE:
//
//   1. THE CLASS IS READ FROM THE TREE, NEVER FROM THE MANIFEST (§3.2). A pacote
//      that declares `kinds: ["skills"]` and ships `hooks/hooks.json` is
//      executable. A manifest is an assertion by its author; the tree is the fact.
//      This is the lesson of ADR-0024, where `is_queueable` judged by file NAME
//      and a transcript walked in.
//   2. INSTALLING IS A CHANGE (§3.4). The files land in the working tree — never a
//      commit, never a push — so they appear in Revisão and the team approves a
//      pacote exactly as it approves knowledge. On the way in they pass the same
//      door as anything else: the intake triage (ADR-0024), where a credential
//      BLOCKS (BR-9) and a CPF warns.
//
// Nothing here is ever executed. A pacote is instructions: the user's own agent
// interprets them, under the permission mode the user chose (ADR-0021). The
// executable class is recognised BY NAME and refused, and the door for it opens
// in its own ADR (§4.3).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::acervo::BUILTIN_SKILLS;

/// What makes a pacote executable. Presence in the TREE decides, not the manifest.
/// `settings.json` is here because a plugin's settings can activate one of its own
/// agents as the main thread — a pacote could repoint the loop's system prompt.
pub const EXECUTABLE_MARKERS: [&str; 7] = [
    "hooks/",
    ".mcp.json",
    ".lsp.json",
    "monitors/",
    "bin/",
    "settings.json",
    "agents/",
];

pub const CLASS_DECLARATIVE: &str = "declarative";
pub const CLASS_EXECUTABLE: &str = "executable";

/// Declared parts Loro understands. Anything else is reported, never dropped in
/// silence (§3.7: an inert install that looks successful is the interface knowing
/// something it does not say).
pub const SUPPORTED_KINDS: [&str; 3] = ["skills", "seed", "loops"];

// ---------------------------------------------------------------------------
// the two manifests
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Author {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CcManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    author: Option<Author>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LoroSeed {
    #[serde(default)]
    contexts: Vec<String>,
    #[serde(default)]
    agents_extra: String,
    #[serde(default)]
    inbox_prompt: String,
    #[serde(default)]
    context_mold: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LoroManifest {
    #[serde(default)]
    loro: u32,
    #[serde(default)]
    kinds: Vec<String>,
    #[serde(default)]
    seed: LoroSeed,
    /// Regras de triagem ADITIVAS (§3.3). Esta versão não as aplica — e é por isso
    /// que ela é LIDA: sem o campo, serde a descartava em silêncio e o pacote
    /// instalava prometendo uma regra que nunca ia existir.
    #[serde(default)]
    triage: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// what the screen shows before anything is written
// ---------------------------------------------------------------------------

/// One file the install would write: where it comes from inside the pacote, where
/// it lands in the project, and what it is.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlannedWrite {
    pub src: String,
    pub dest: String,
    /// `skill` | `loop` | `context`
    pub kind: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Brings {
    pub skills: Vec<String>,
    pub contexts: Vec<String>,
    pub loops: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TriageFinding {
    pub rel: String,
    pub findings: Vec<crate::intake::Finding>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreview {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub source: String,
    /// What `loro.json` declared (informational).
    pub kinds: Vec<String>,
    pub class: String,
    /// Which executable markers were found in the tree — the reason a refusal can
    /// name the class instead of failing generically.
    pub executable: Vec<String>,
    pub brings: Brings,
    pub writes: Vec<PlannedWrite>,
    /// Declared parts this version does not install yet (never dropped silently).
    pub unsupported: Vec<String>,
    pub findings: Vec<TriageFinding>,
    /// A credential was found: the install refuses (BR-9).
    pub blocked: bool,
    /// Destinations that already exist. Never overwritten (§3.5 non-destructive).
    pub conflicts: Vec<String>,
    /// Version already installed under this id, if any.
    pub installed: Option<String>,
}

// ---------------------------------------------------------------------------
// the install record (.loro/plugins.json — versioned: it is project policy)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFile {
    pub rel: String,
    /// The bytes as installed. What makes uninstall able to keep a file the person
    /// edited afterwards (§3.5).
    #[serde(default)]
    pub sha256: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    /// `dir` today; `github` when round 3 lands.
    pub kind: String,
    pub path: String,
    #[serde(rename = "ref", default, skip_serializing_if = "String::is_empty")]
    pub git_ref: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub source: PluginSource,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub installed_at: String,
    #[serde(default)]
    pub files: Vec<InstalledFile>,
    #[serde(default)]
    pub brings: Brings,
}

fn record_path(base: &Path) -> PathBuf {
    base.join(".loro").join("plugins.json")
}

pub fn read_record(base: &Path) -> Vec<InstalledPlugin> {
    std::fs::read_to_string(record_path(base))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<InstalledPlugin>>(&t).ok())
        .unwrap_or_default()
}

/// Which pacote wrote this file, if one did. «De onde isto veio» is the question
/// that matters when something misbehaves — ADR-0029 §5.1 asks it of a habilidade,
/// and `loops::capabilities_of` asks it of an MCP server (§4.17).
pub fn origin_of_file(base: &Path, rel: &str) -> Option<String> {
    read_record(base)
        .into_iter()
        .find(|p| p.files.iter().any(|f| f.rel == rel))
        .map(|p| p.name)
}

fn write_record(base: &Path, list: &[InstalledPlugin]) -> Result<(), String> {
    let p = record_path(base);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::paths::folder_write_error(&e))?;
    }
    std::fs::write(
        &p,
        serde_json::to_string_pretty(list).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "err.plugin_write_failed".to_string())
}

// ---------------------------------------------------------------------------
// reading the pacote
// ---------------------------------------------------------------------------

/// Relative paths inside the pacote (files only, bounded depth, forward slashes).
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

/// Which executable markers this tree carries. Pure: the whole class decision is
/// one function over a listing, so it can be exercised without a filesystem.
pub fn executable_markers(entries: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for m in EXECUTABLE_MARKERS {
        let hit = entries.iter().any(|e| {
            if let Some(dir) = m.strip_suffix('/') {
                // a directory marker matches the folder itself or anything in it
                e == m || e.starts_with(&format!("{dir}/"))
            } else {
                // a file marker matches only at the plugin ROOT
                e == m
            }
        });
        if hit {
            found.push(m.to_string());
        }
    }
    found
}

pub fn class_of(entries: &[String]) -> &'static str {
    if executable_markers(entries).is_empty() {
        CLASS_DECLARATIVE
    } else {
        CLASS_EXECUTABLE
    }
}

/// Where a pacote file lands, and what it is. Pure so the whole plan is testable.
/// `commands/x.md` and `skills/x/SKILL.md` are the two spellings of one thing (a
/// habilidade); the nested one is normalized on the way in.
pub fn plan_for(
    entries: &[String],
    seed_contexts: &[String],
    contexts_dir: &str,
) -> Vec<PlannedWrite> {
    let mut out: Vec<PlannedWrite> = Vec::new();
    for e in entries {
        if let Some(name) = e.strip_prefix("commands/") {
            if let Some(stem) = name.strip_suffix(".md") {
                if !stem.is_empty() && !stem.contains('/') {
                    out.push(PlannedWrite {
                        src: e.clone(),
                        dest: format!(".claude/commands/{stem}.md"),
                        kind: "skill".into(),
                        label: format!("/{stem}"),
                    });
                }
            }
        } else if let Some(rest) = e.strip_prefix("skills/") {
            if let Some(stem) = rest.strip_suffix("/SKILL.md") {
                if !stem.is_empty() && !stem.contains('/') {
                    out.push(PlannedWrite {
                        src: e.clone(),
                        dest: format!(".claude/commands/{stem}.md"),
                        kind: "skill".into(),
                        label: format!("/{stem}"),
                    });
                }
            }
        } else if let Some(name) = e.strip_prefix("loops/") {
            if let Some(stem) = name.strip_suffix(".md") {
                if !stem.is_empty() && !stem.contains('/') {
                    out.push(PlannedWrite {
                        src: e.clone(),
                        dest: format!("loops/{stem}.md"),
                        kind: "loop".into(),
                        label: stem.to_string(),
                    });
                }
            }
        }
    }
    for c in seed_contexts {
        let raw = c.trim();
        // A seed name is refused, never reinterpreted: trimming a leading "/" off
        // "/abs" would turn an absolute path into a context called "abs".
        if raw.is_empty()
            || raw.starts_with('/')
            || raw.starts_with('~')
            || raw.contains("..")
            || raw.contains('\\')
            || raw.contains(':')
        {
            continue;
        }
        let clean = raw.trim_matches('/').to_string();
        if clean.is_empty() {
            continue;
        }
        out.push(PlannedWrite {
            src: String::new(),
            dest: format!("{contexts_dir}/{clean}/context.md"),
            kind: "context".into(),
            label: clean,
        });
    }
    out.sort_by(|a, b| a.dest.cmp(&b.dest));
    out.dedup_by(|a, b| a.dest == b.dest);
    out
}

fn read_manifests(dir: &Path) -> Result<(CcManifest, LoroManifest), String> {
    let cc_txt = std::fs::read_to_string(dir.join(".claude-plugin/plugin.json"))
        .map_err(|_| "err.plugin_manifest_invalid".to_string())?;
    let cc: CcManifest =
        serde_json::from_str(&cc_txt).map_err(|_| "err.plugin_manifest_invalid".to_string())?;
    if cc.name.trim().is_empty() {
        return Err("err.plugin_manifest_invalid".into());
    }
    let lm: LoroManifest = match std::fs::read_to_string(dir.join("loro.json")) {
        Ok(t) => serde_json::from_str(&t).map_err(|_| "err.plugin_manifest_invalid".to_string())?,
        Err(_) => LoroManifest::default(),
    };
    if lm.loro > 1 {
        // written for a newer Loro: refusing by name beats installing half of it
        return Err("err.plugin_schema_unsupported".into());
    }
    Ok((cc, lm))
}

/// A source string → the pacote's directory. Only a local directory is supported
/// in this round; anything else fails BY NAME (§3.6).
fn resolve_source(source: &str) -> Result<PathBuf, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("err.plugin_source_unsupported".into());
    }
    if s.starts_with("http://")
        || s.starts_with("https://")
        || s.starts_with("git@")
        || s.starts_with("npm:")
        || (s.contains('/') && !s.contains(std::path::MAIN_SEPARATOR) && !Path::new(s).exists())
    {
        return Err("err.plugin_source_unsupported".into());
    }
    let p = PathBuf::from(s);
    let p = p
        .canonicalize()
        .map_err(|_| "err.plugin_source_unsupported".to_string())?;
    if !p.is_dir() {
        return Err("err.plugin_source_unsupported".into());
    }
    Ok(p)
}

/// Read-only: what this pacote is, what it would write, and what the triage found.
/// Writes nothing, anywhere.
pub fn preview(base: &Path, source: &str) -> Result<PluginPreview, String> {
    let dir = resolve_source(source)?;
    let (cc, lm) = read_manifests(&dir)?;
    let mut entries: Vec<String> = Vec::new();
    walk(&dir, "", 6, &mut entries);
    entries.sort();
    let executable = executable_markers(&entries);
    let class = class_of(&entries);
    // ADR-0026 §14 — a pasta do conhecimento pode ser `contexts/` ou, num acervo
    // ainda não migrado, `contextos/`. O plano tem de nomear a que EXISTE: com o
    // nome fixo, o preview prometia `contexts/juridico/context.md`, a conferência
    // de conflito olhava um caminho inexistente e o seeder escrevia no outro —
    // três respostas para uma pergunta.
    let ctx_dir = crate::paths::contexts_dir(base)
        .strip_prefix(base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| "contexts".into());
    let writes = plan_for(&entries, &lm.seed.contexts, &ctx_dir);

    let mut brings = Brings::default();
    for w in &writes {
        match w.kind.as_str() {
            "skill" => brings.skills.push(w.label.clone()),
            "loop" => brings.loops.push(w.label.clone()),
            _ => brings.contexts.push(w.label.clone()),
        }
    }

    // declared-but-not-installed, said out loud
    let mut unsupported: Vec<String> = lm
        .kinds
        .iter()
        .filter(|k| !SUPPORTED_KINDS.contains(&k.as_str()))
        .cloned()
        .collect();
    for (present, label) in [
        (lm.triage.is_some(), "triage"),
        (!lm.seed.agents_extra.is_empty(), "agentsExtra"),
        (!lm.seed.inbox_prompt.is_empty(), "inboxPrompt"),
        (!lm.seed.context_mold.is_empty(), "contextMold"),
    ] {
        if present {
            unsupported.push(label.to_string());
        }
    }

    // the triage runs on the CONTENT that would be written (ADR-0024)
    let mut findings: Vec<TriageFinding> = Vec::new();
    let mut blocked = false;
    for w in &writes {
        if w.src.is_empty() {
            continue; // a seeded context is written from the app's own template
        }
        let Ok(src) = guarded_src(&dir, &w.src) else {
            return Err("err.plugin_path_escape".into());
        };
        let Ok(text) = std::fs::read_to_string(&src) else {
            // A triagem é de TEXTO, e uma habilidade/loop É texto. Um arquivo que
            // não se lê como UTF-8 não pode ser triado — e instalar sem triar é o
            // buraco que a ADR-0024 fechou na outra porta (BR-9). Recusa pelo nome,
            // em vez de entrar sem ser lido.
            return Err(format!("err.plugin_unreadable_file:{}", w.src));
        };
        let f = crate::intake::scan(&text);
        if !f.is_empty() {
            blocked = blocked || crate::intake::blocked(&f);
            findings.push(TriageFinding {
                rel: w.dest.clone(),
                findings: f,
            });
        }
    }

    let conflicts: Vec<String> = writes
        .iter()
        .filter(|w| base.join(&w.dest).exists())
        .map(|w| w.dest.clone())
        .collect();

    let id = crate::loops::slugify(&cc.name);
    let installed = read_record(base)
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.version);

    Ok(PluginPreview {
        id,
        name: cc.name.trim().to_string(),
        description: cc.description.trim().to_string(),
        version: cc.version.trim().to_string(),
        author: cc.author.unwrap_or_default().name.trim().to_string(),
        source: dir.to_string_lossy().to_string(),
        kinds: lm.kinds,
        class: class.to_string(),
        executable,
        brings,
        writes,
        unsupported,
        findings,
        blocked,
        conflicts,
        installed,
    })
}

/// A pacote file, guarded to the pacote's own root: `../` and a symlink out both
/// stop here (§8, `err.plugin_path_escape`).
fn guarded_src(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = dir
        .join(rel)
        .canonicalize()
        .map_err(|_| "err.plugin_path_escape".to_string())?;
    if !p.starts_with(dir) {
        return Err("err.plugin_path_escape".into());
    }
    Ok(p)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub id: String,
    pub version: String,
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    pub brings: Brings,
}

/// Copy the declarative parts in, and record what was written. Nothing is
/// committed and nothing is pushed: the files land in the working tree, where
/// Revisão already shows them (§3.4).
pub fn install(base: &Path, source: &str, today: &str) -> Result<InstallOutcome, String> {
    let pv = preview(base, source)?;
    if pv.class == CLASS_EXECUTABLE {
        // the refusal names the class, so the screen can say WHY (§3.2)
        return Err(format!(
            "err.plugin_kind_unsupported:{}",
            pv.executable.join(" · ")
        ));
    }
    if pv.blocked {
        let file = pv
            .findings
            .iter()
            .find(|f| crate::intake::blocked(&f.findings))
            .map(|f| f.rel.clone())
            .unwrap_or_default();
        return Err(format!("err.intake_secret:{file}"));
    }
    if pv.writes.is_empty() {
        return Err("err.plugin_nothing_to_install".into());
    }
    if let Some(v) = &pv.installed {
        return Err(format!("err.plugin_id_conflict:{v}"));
    }
    let dir = resolve_source(source)?;
    let lang = crate::config::active_acervo_lang();

    // Validar TODOS antes de escrever QUALQUER um (o padrão que o envio para a fila
    // já usa): um erro no meio deixava arquivos órfãos no projeto e nenhum registro
    // deles — e a segunda tentativa então batia em «já existe».
    for w in &pv.writes {
        if w.src.is_empty() {
            continue;
        }
        let src = guarded_src(&dir, &w.src)?;
        if std::fs::read_to_string(&src).is_err() {
            return Err(format!("err.plugin_unreadable_file:{}", w.src));
        }
    }

    let mut written: Vec<InstalledFile> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for w in &pv.writes {
        let dest_abs = base.join(&w.dest);
        // a habilidade may never shadow a built-in one
        if w.kind == "skill" {
            let leaf = w.dest.rsplit('/').next().unwrap_or_default();
            if BUILTIN_SKILLS.contains(&leaf) {
                skipped.push(w.dest.clone());
                continue;
            }
        }
        if dest_abs.exists() {
            // never overwrite what is already there (§3.5)
            skipped.push(w.dest.clone());
            continue;
        }
        if let Some(parent) = dest_abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| crate::paths::folder_write_error(&e))?;
        }
        // A seeded context is the acervo's OWN scaffolding: the same non-destructive
        // seeder every other route uses (folder + CHANGELOG + the language's mold,
        // and the legacy folder name respected), never a second implementation.
        if w.kind == "context" {
            crate::seed_context(base, &w.label, &lang, None)?;
            let real = crate::paths::contexts_dir(base)
                .join(&w.label)
                .join("context.md");
            let rel = real
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| w.dest.clone());
            let sha = crate::models::sha256_of(&real).unwrap_or_default();
            written.push(InstalledFile { rel, sha256: sha });
            continue;
        }
        let src = guarded_src(&dir, &w.src)?;
        let text = std::fs::read_to_string(&src).map_err(|_| "err.plugin_write_failed")?;
        let body = if w.kind == "loop" {
            // a loop from a pacote arrives OFF; arming is the person's act (§3.8.1)
            crate::loops::disarm_markdown(&text)
        } else {
            text
        };
        std::fs::write(&dest_abs, &body).map_err(|_| "err.plugin_write_failed".to_string())?;
        let sha = crate::models::sha256_of(&dest_abs).unwrap_or_default();
        written.push(InstalledFile {
            rel: w.dest.clone(),
            sha256: sha,
        });
    }

    if written.is_empty() {
        return Err("err.plugin_nothing_to_install".into());
    }

    let mut rec = read_record(base);
    rec.retain(|p| p.id != pv.id);
    rec.push(InstalledPlugin {
        id: pv.id.clone(),
        name: pv.name.clone(),
        version: pv.version.clone(),
        source: PluginSource {
            kind: "dir".into(),
            path: pv.source.clone(),
            git_ref: String::new(),
            sha: String::new(),
        },
        kinds: pv.kinds.clone(),
        installed_at: today.to_string(),
        files: written.clone(),
        brings: pv.brings.clone(),
    });
    rec.sort_by(|a, b| a.id.cmp(&b.id));
    write_record(base, &rec)?;

    // BR-8/BR-9: counts and ids only — never a path from inside the pacote's
    // content, never a finding
    info!(
        id = %pv.id,
        version = %pv.version,
        files = written.len(),
        skipped = skipped.len(),
        "plugin installed"
    );
    Ok(InstallOutcome {
        id: pv.id,
        version: pv.version,
        written: written.into_iter().map(|f| f.rel).collect(),
        skipped,
        brings: pv.brings,
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub removed: Vec<String>,
    /// Files the person edited after the install. They stay, and the screen says
    /// which (§3.5 — remove subtracts what the pacote added, never what a person
    /// wrote).
    pub kept: Vec<String>,
}

pub fn remove(base: &Path, id: &str) -> Result<RemoveOutcome, String> {
    let mut rec = read_record(base);
    let Some(pos) = rec.iter().position(|p| p.id == id) else {
        return Err("err.plugin_not_found".into());
    };
    let plugin = rec.remove(pos);
    // §3.10 F3 — um ciclo EM CURSO é cancelado, nunca orfanado: sem isto a thread
    // do ciclo terminava depois da remoção, lia o registro que já não existia e o
    // recriava — histórico de um loop que não existe mais.
    for f in &plugin.files {
        if let Some(slug) = crate::loops::slug_of_rel(&f.rel) {
            if crate::loops::is_running(&slug) {
                crate::loops::stop_cycle(base, &slug);
            }
        }
    }
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    for f in &plugin.files {
        // O REGISTRO É ENTRADA NÃO CONFIÁVEL. `.loro/plugins.json` é versionado:
        // ele chega no commit de outra pessoa, e um `rel` como `../segredo.txt`
        // fazia esta remoção apagar um arquivo FORA do projeto. O guard é o mesmo
        // que todo caminho do acervo atravessa (canonicaliza + starts_with).
        let Ok(abs) = crate::acervo::guarded_existing(base, &f.rel) else {
            if base.join(&f.rel).exists() {
                kept.push(f.rel.clone());
            }
            continue;
        };
        let now = crate::models::sha256_of(&abs).unwrap_or_default();
        // Um digest VAZIO significa "não sei o que estava aqui" (a máquina não
        // tinha a ferramenta de hash na instalação). Não saber é motivo para
        // GUARDAR o arquivo, nunca para apagá-lo: remover subtrai o que o pacote
        // trouxe, e o que ele trouxe é o que se pode provar (§3.5).
        if f.sha256.is_empty() || !now.eq_ignore_ascii_case(&f.sha256) {
            kept.push(f.rel.clone());
            continue;
        }
        if std::fs::remove_file(&abs).is_ok() {
            removed.push(f.rel.clone());
            // a loop's runtime record (and its lock) go with its definition
            if let Some(slug) = crate::loops::slug_of_rel(&f.rel) {
                crate::loops::forget_runtime(base, &slug);
            }
        } else {
            kept.push(f.rel.clone());
        }
    }
    write_record(base, &rec)?;
    info!(id = %id, removed = removed.len(), kept = kept.len(), "plugin removed");
    Ok(RemoveOutcome { removed, kept })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

fn base() -> Result<PathBuf, String> {
    crate::acervo::acervo_base()
}

#[tauri::command]
pub async fn brain_plugin_manifest(source: String) -> Result<PluginPreview, String> {
    let base = base()?;
    preview(&base, &source)
}

#[tauri::command]
pub async fn brain_install_plugin(source: String, hoje: String) -> Result<InstallOutcome, String> {
    let base = base()?;
    install(&base, &source, hoje.trim())
}

#[tauri::command]
pub async fn brain_list_plugins() -> Result<Vec<InstalledPlugin>, String> {
    let base = base()?;
    Ok(read_record(&base))
}

#[tauri::command]
pub async fn brain_remove_plugin(id: String) -> Result<RemoveOutcome, String> {
    let base = base()?;
    remove(&base, id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A command that is defined and never registered fails only at runtime, as an
    // invoke rejection — nothing else in the suite catches it. And ADR-0022 §28,
    // for the sixth time: heavy work in a SYNCHRONOUS command runs on the main
    // thread and freezes the window. These read the whole loops folder, hash files
    // and spawn the agent. The needles are assembled so this test cannot pass by
    // matching itself.
    #[test]
    fn every_command_here_is_async_and_reachable_from_the_screen() {
        let mine = include_str!("plugins.rs");
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
                "{name} has to be async: it walks a folder, reads every planned file and hashes each one"
            );
            assert!(
                wiring.contains(&format!("{}::{name},", "plugins")),
                "{name} is defined but never registered in generate_handler"
            );
            found += 1;
        }
        assert!(found >= 4, "the scanner went blind: only {found} commands");
    }

    fn tmp(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "loro-plugins-{tag}-{}-{}",
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

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// A minimal declarative pacote: one habilidade, one loop, one seed context.
    fn pacote(tag: &str) -> PathBuf {
        let dir = tmp(tag);
        write(
            &dir.join(".claude-plugin/plugin.json"),
            r#"{"name":"juridico-br","description":"habilidades juridicas","version":"1.2.0","author":{"name":"OAB"}}"#,
        );
        write(
            &dir.join("loro.json"),
            r#"{"loro":1,"kinds":["skills","seed","loops"],"seed":{"contexts":["juridico","juridico/contratos"]}}"#,
        );
        write(
            &dir.join("commands/loro-parecer.md"),
            "# parecer\nescreva um parecer\n",
        );
        write(
            &dir.join("loops/revisao-de-prazos.md"),
            "---\nloop: revisao-de-prazos\ntitulo: revisao\nritmo: semana:1:09:00\nligado: true\n---\n\nolhe os prazos\n",
        );
        dir
    }

    // §3.2 — the class is a function of the TREE. This is the ADR-0024 lesson
    // applied to a second door: a manifest is an assertion, the tree is the fact.
    #[test]
    fn the_class_is_read_from_the_tree_never_from_the_manifest() {
        let declarative = vec![
            "commands/".to_string(),
            "commands/x.md".to_string(),
            "loro.json".to_string(),
        ];
        assert_eq!(class_of(&declarative), CLASS_DECLARATIVE);
        for marker in EXECUTABLE_MARKERS {
            let mut e = declarative.clone();
            e.push(marker.to_string());
            if marker.ends_with('/') {
                e.push(format!("{}file.json", marker));
            }
            assert_eq!(
                class_of(&e),
                CLASS_EXECUTABLE,
                "{marker} makes a pacote executable"
            );
            assert!(executable_markers(&e).contains(&marker.to_string()));
        }
        // a file marker only counts at the ROOT: a habilidade may legitimately
        // mention one deeper in the tree
        let nested = vec![
            "commands/x.md".to_string(),
            "docs/settings.json".to_string(),
        ];
        assert_eq!(class_of(&nested), CLASS_DECLARATIVE);
    }

    #[test]
    fn both_spellings_of_a_habilidade_normalize_to_the_same_destination() {
        let plan = plan_for(
            &[
                "commands/a.md".to_string(),
                "skills/b/SKILL.md".to_string(),
                "skills/b/reference.md".to_string(),
                "loops/c.md".to_string(),
                "README.md".to_string(),
            ],
            &["juridico".to_string()],
            "contexts",
        );
        let dests: Vec<&str> = plan.iter().map(|w| w.dest.as_str()).collect();
        assert_eq!(
            dests,
            vec![
                ".claude/commands/a.md",
                ".claude/commands/b.md",
                "contexts/juridico/context.md",
                "loops/c.md",
            ]
        );
        assert!(plan.iter().any(|w| w.kind == "loop" && w.label == "c"));
        // a seed path that tries to escape is dropped, not sanitized into something
        let plan2 = plan_for(
            &[],
            &["../../etc".to_string(), "/abs".to_string()],
            "contexts",
        );
        assert!(plan2.is_empty());
    }

    #[test]
    fn a_preview_writes_nothing_and_says_what_it_would_write() {
        let acervo = tmp("preview-acervo");
        let dir = pacote("preview");
        let pv = preview(&acervo, dir.to_str().unwrap()).unwrap();
        assert_eq!(pv.id, "juridico-br");
        assert_eq!(pv.version, "1.2.0");
        assert_eq!(pv.author, "OAB");
        assert_eq!(pv.class, CLASS_DECLARATIVE);
        assert_eq!(pv.brings.skills, vec!["/loro-parecer".to_string()]);
        assert_eq!(pv.brings.loops, vec!["revisao-de-prazos".to_string()]);
        assert_eq!(
            pv.brings.contexts,
            vec!["juridico".to_string(), "juridico/contratos".to_string()]
        );
        assert!(pv.findings.is_empty() && !pv.blocked);
        // nothing was written by a read
        assert!(!acervo.join(".claude").exists());
        assert!(!acervo.join("loops").exists());
        assert!(!acervo.join(".loro").exists());
    }

    #[test]
    fn an_executable_pacote_is_refused_by_name() {
        let acervo = tmp("exec-acervo");
        let dir = pacote("exec");
        write(&dir.join("hooks/hooks.json"), "{}");
        write(&dir.join("bin/run.sh"), "echo hi\n");
        let pv = preview(&acervo, dir.to_str().unwrap()).unwrap();
        assert_eq!(pv.class, CLASS_EXECUTABLE);
        let err = install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap_err();
        assert!(
            err.starts_with("err.plugin_kind_unsupported:"),
            "the refusal names the class: {err}"
        );
        assert!(err.contains("hooks/") && err.contains("bin/"));
        assert!(!acervo.join(".claude/commands/loro-parecer.md").exists());
    }

    // BR-9 — a credential inside a pacote blocks the WHOLE install, and the error
    // names the file and the rule, never the finding. The sample is assembled at
    // runtime: a token-shaped literal in the source is refused by GitHub's own
    // push protection (the ADR-0024 lesson).
    #[test]
    fn br9_a_credential_inside_a_pacote_blocks_the_install() {
        let acervo = tmp("secret-acervo");
        let dir = pacote("secret");
        let token = format!("{}{}", "ghp_", "A".repeat(36));
        write(
            &dir.join("commands/loro-token.md"),
            &format!("use este token: {token}\n"),
        );
        let pv = preview(&acervo, dir.to_str().unwrap()).unwrap();
        assert!(pv.blocked, "a credential blocks");
        let err = install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap_err();
        assert!(err.starts_with("err.intake_secret:"), "{err}");
        assert!(
            !err.contains(&token),
            "BR-8/BR-9: the finding never travels"
        );
        assert!(!acervo.join(".claude/commands/loro-parecer.md").exists());
        assert!(!acervo.join(".loro/plugins.json").exists());
    }

    #[test]
    fn installing_writes_the_declarative_parts_and_records_them() {
        let acervo = tmp("install-acervo");
        let dir = pacote("install");
        let out = install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap();
        assert_eq!(out.id, "juridico-br");
        assert!(acervo.join(".claude/commands/loro-parecer.md").is_file());
        assert!(acervo.join("contexts/juridico/context.md").is_file());
        assert!(acervo.join("contexts/juridico/CHANGELOG.md").is_file());
        // §3.8.1 — a loop from a pacote arrives OFF
        let loop_txt = std::fs::read_to_string(acervo.join("loops/revisao-de-prazos.md")).unwrap();
        assert!(loop_txt.contains("ligado: false"), "{loop_txt}");
        assert!(!loop_txt.contains("ligado: true"));
        // the record knows what it wrote, with a digest per file
        let rec = read_record(&acervo);
        assert_eq!(rec.len(), 1);
        assert_eq!(rec[0].installed_at, "2026-08-17");
        assert!(rec[0]
            .files
            .iter()
            .any(|f| f.rel == "loops/revisao-de-prazos.md"));
        // installing twice is refused by name instead of duplicating anything
        let err = install(&acervo, dir.to_str().unwrap(), "2026-08-18").unwrap_err();
        assert_eq!(err, "err.plugin_id_conflict:1.2.0");
    }

    #[test]
    fn install_never_overwrites_and_never_shadows_a_builtin() {
        let acervo = tmp("noover-acervo");
        let dir = pacote("noover");
        write(&dir.join("commands/loro-context.md"), "nao deve entrar\n");
        write(
            &acervo.join(".claude/commands/loro-parecer.md"),
            "meu parecer\n",
        );
        let out = install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap();
        assert!(out
            .skipped
            .contains(&".claude/commands/loro-parecer.md".to_string()));
        assert!(out
            .skipped
            .contains(&".claude/commands/loro-context.md".to_string()));
        assert_eq!(
            std::fs::read_to_string(acervo.join(".claude/commands/loro-parecer.md")).unwrap(),
            "meu parecer\n",
            "what was already there is untouched"
        );
    }

    // §3.5 — removing subtracts what the pacote added, and keeps what the person
    // edited afterwards, saying which.
    #[test]
    fn removing_keeps_the_file_the_person_edited_after_the_install() {
        let acervo = tmp("remove-acervo");
        let dir = pacote("remove");
        install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap();
        let edited = acervo.join(".claude/commands/loro-parecer.md");
        std::fs::write(&edited, "eu mudei isto depois\n").unwrap();
        let out = remove(&acervo, "juridico-br").unwrap();
        assert!(out
            .kept
            .contains(&".claude/commands/loro-parecer.md".to_string()));
        assert!(out
            .removed
            .contains(&"loops/revisao-de-prazos.md".to_string()));
        assert!(edited.is_file(), "an edited file survives its pacote");
        assert!(!acervo.join("loops/revisao-de-prazos.md").exists());
        assert!(read_record(&acervo).is_empty());
        assert_eq!(
            remove(&acervo, "juridico-br").unwrap_err(),
            "err.plugin_not_found"
        );
    }

    // BR-9/§3.5 — `.loro/plugins.json` é VERSIONADO: ele chega no commit de outra
    // pessoa. Um `rel` hostil no registro fazia a remoção apagar um arquivo FORA
    // do projeto. Achado por revisão adversarial da própria implementação.
    #[test]
    fn br9_a_hostile_record_can_never_delete_outside_the_project() {
        let root = tmp("hostile-root");
        let acervo = root.join("acervo");
        std::fs::create_dir_all(&acervo).unwrap();
        let victim = root.join("segredo.txt");
        std::fs::write(&victim, "dados sensiveis\n").unwrap();
        write(
            &acervo.join(".loro/plugins.json"),
            r#"[{"id":"trojan","name":"trojan","version":"1.0.0","source":{"kind":"dir","path":"x"},"kinds":["skills"],"installedAt":"2026-08-17","files":[{"rel":"../segredo.txt","sha256":""}]}]"#,
        );
        let out = remove(&acervo, "trojan").unwrap();
        assert!(victim.is_file(), "um arquivo fora do projeto foi apagado");
        assert!(out.removed.is_empty(), "e nada foi reportado como removido");
        assert!(
            out.kept.contains(&"../segredo.txt".to_string()),
            "o que não pôde ser tocado é dito, não engolido: {out:?}"
        );
    }

    // §3.5 — um digest vazio significa "não sei o que estava aqui" (a máquina não
    // tinha a ferramenta de hash na instalação). Não saber guarda o arquivo.
    #[test]
    fn an_unknown_digest_keeps_the_file_instead_of_deleting_it() {
        let acervo = tmp("nodigest");
        write(&acervo.join(".claude/commands/loro-x.md"), "conteudo\n");
        write(
            &acervo.join(".loro/plugins.json"),
            r#"[{"id":"p","name":"p","version":"1","source":{"kind":"dir","path":"x"},"kinds":["skills"],"installedAt":"2026-08-17","files":[{"rel":".claude/commands/loro-x.md","sha256":""}]}]"#,
        );
        let out = remove(&acervo, "p").unwrap();
        assert!(acervo.join(".claude/commands/loro-x.md").is_file());
        assert_eq!(out.kept, vec![".claude/commands/loro-x.md".to_string()]);
        assert!(out.removed.is_empty());
    }

    // ADR-0026 §14 — num acervo ainda não migrado a pasta do conhecimento é
    // `contextos/`. O plano tem de nomear a que EXISTE: com o nome fixo o preview
    // prometia um caminho, a conferência de conflito olhava outro e o seeder
    // escrevia num terceiro.
    #[test]
    fn a_pre_migration_acervo_keeps_its_own_knowledge_folder() {
        let acervo = tmp("legacy");
        write(
            &acervo.join("contextos/juridico/context.md"),
            "# juridico\nescrito pela pessoa\n",
        );
        let dir = pacote("legacy-pac");
        let pv = preview(&acervo, dir.to_str().unwrap()).unwrap();
        let dests: Vec<&str> = pv.writes.iter().map(|w| w.dest.as_str()).collect();
        assert!(
            dests.contains(&"contextos/juridico/context.md"),
            "o plano tem de apontar para a pasta que existe: {dests:?}"
        );
        assert!(
            pv.conflicts
                .contains(&"contextos/juridico/context.md".to_string()),
            "e o conflito com o que a pessoa escreveu tem de ser visto: {:?}",
            pv.conflicts
        );
        install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap();
        assert!(
            !acervo.join("contexts").exists(),
            "nenhuma segunda pasta de conhecimento é criada"
        );
        assert_eq!(
            std::fs::read_to_string(acervo.join("contextos/juridico/context.md")).unwrap(),
            "# juridico\nescrito pela pessoa\n",
            "e o que a pessoa escreveu fica intacto"
        );
    }

    #[test]
    fn a_manifest_that_is_missing_or_broken_is_refused_by_name() {
        let acervo = tmp("bad-acervo");
        let dir = tmp("bad");
        assert_eq!(
            preview(&acervo, dir.to_str().unwrap()).unwrap_err(),
            "err.plugin_manifest_invalid"
        );
        write(&dir.join(".claude-plugin/plugin.json"), "{ not json");
        assert_eq!(
            preview(&acervo, dir.to_str().unwrap()).unwrap_err(),
            "err.plugin_manifest_invalid"
        );
        write(
            &dir.join(".claude-plugin/plugin.json"),
            r#"{"description":"x"}"#,
        );
        assert_eq!(
            preview(&acervo, dir.to_str().unwrap()).unwrap_err(),
            "err.plugin_manifest_invalid"
        );
        write(&dir.join(".claude-plugin/plugin.json"), r#"{"name":"x"}"#);
        write(&dir.join("loro.json"), r#"{"loro":2}"#);
        assert_eq!(
            preview(&acervo, dir.to_str().unwrap()).unwrap_err(),
            "err.plugin_schema_unsupported"
        );
    }

    // §3.10 E1/BR-9 — a triagem é de TEXTO, e uma habilidade É texto. Um arquivo
    // que não se lê como UTF-8 entrava sem ser triado, e o install ainda quebrava
    // no meio deixando órfãos: agora ele é recusado pelo nome, ANTES de escrever.
    #[test]
    fn br9_a_file_that_cannot_be_read_as_text_is_refused_before_anything_is_written() {
        let acervo = tmp("cp1252-acervo");
        let dir = pacote("cp1252");
        // um .md em cp1252: 0xE7 é "ç" nessa página de código e não é UTF-8 válido
        std::fs::write(
            dir.join("commands/loro-acao.md"),
            [b'a', b'c', 0xE7, b'a', b'o', b'\n'],
        )
        .unwrap();
        let err = install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap_err();
        assert!(
            err.starts_with("err.plugin_unreadable_file:"),
            "recusa nomeando o arquivo: {err}"
        );
        // e NADA foi escrito: nem o arquivo bom, nem o registro
        assert!(!acervo.join(".claude/commands/loro-parecer.md").exists());
        assert!(!acervo.join(".loro/plugins.json").exists());
        assert!(!acervo.join("loops").exists());
    }

    // §3.3/§3.7 — o manifesto declara `triage` (a ADR mostra isso no §3.1) e esta
    // versão não a aplica. serde a descartava calada, e o módulo promete o oposto.
    #[test]
    fn a_declared_triage_rule_is_reported_instead_of_being_dropped() {
        let acervo = tmp("triage-decl-acervo");
        let dir = pacote("triage-decl");
        write(
            &dir.join("loro.json"),
            r#"{"loro":1,"kinds":["skills"],"triage":{"warn":[{"rule":"oab","pattern":"x","why":"y"}]}}"#,
        );
        let pv = preview(&acervo, dir.to_str().unwrap()).unwrap();
        assert!(
            pv.unsupported.contains(&"triage".to_string()),
            "a regra declarada tem de ser dita: {:?}",
            pv.unsupported
        );
    }

    #[test]
    fn a_source_that_is_not_a_local_folder_fails_by_name() {
        let acervo = tmp("src-acervo");
        for bad in [
            "",
            "https://example.com/p.zip",
            "git@github.com:org/repo.git",
            "org/repo",
            "npm:thing",
        ] {
            assert_eq!(
                preview(&acervo, bad).unwrap_err(),
                "err.plugin_source_unsupported",
                "{bad}"
            );
        }
    }

    #[test]
    fn a_declared_part_this_version_does_not_install_is_reported_not_dropped() {
        let acervo = tmp("unsup-acervo");
        let dir = pacote("unsup");
        write(
            &dir.join("loro.json"),
            r#"{"loro":1,"kinds":["skills","mcp"],"seed":{"agentsExtra":"pt/AGENTS.md"}}"#,
        );
        let pv = preview(&acervo, dir.to_str().unwrap()).unwrap();
        assert!(pv.unsupported.contains(&"mcp".to_string()));
        assert!(pv.unsupported.contains(&"agentsExtra".to_string()));
    }

    #[test]
    fn a_pacote_with_nothing_installable_says_so() {
        let acervo = tmp("empty-acervo");
        let dir = tmp("empty");
        write(
            &dir.join(".claude-plugin/plugin.json"),
            r#"{"name":"vazio"}"#,
        );
        assert_eq!(
            install(&acervo, dir.to_str().unwrap(), "2026-08-17").unwrap_err(),
            "err.plugin_nothing_to_install"
        );
    }

    // The record is the acervo's policy and travels with it — so its shape is the
    // IPC contract the frontend reads, pinned here instead of by memory.
    #[test]
    fn the_record_serializes_the_agreed_shape() {
        let p = InstalledPlugin {
            id: "x".into(),
            name: "X".into(),
            version: "1.0.0".into(),
            source: PluginSource {
                kind: "dir".into(),
                path: "/tmp/x".into(),
                git_ref: String::new(),
                sha: String::new(),
            },
            kinds: vec!["skills".into()],
            installed_at: "2026-08-17".into(),
            files: vec![InstalledFile {
                rel: ".claude/commands/a.md".into(),
                sha256: "abc".into(),
            }],
            brings: Brings::default(),
        };
        let v = serde_json::to_value(&p).unwrap();
        let o = v.as_object().unwrap();
        for k in [
            "id",
            "name",
            "version",
            "source",
            "kinds",
            "installedAt",
            "files",
            "brings",
        ] {
            assert!(o.contains_key(k), "missing {k}");
        }
        assert_eq!(o["source"]["kind"], "dir");
        // an empty ref/sha is not serialized: a local install writes no git noise
        assert!(o["source"].as_object().unwrap().get("ref").is_none());
    }
}
