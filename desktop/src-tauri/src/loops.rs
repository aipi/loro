// Loro — loops: standing AI work, with a place for what it produces (ADR-0029 §3.8).
//
// A loop is TWO things, on purpose:
//
//   • the DEFINITION the person reads and edits — `loops/<slug>.md`: front matter
//     (rhythm, scope, destination, brakes) plus the instruction in prose. It is an
//     ordinary versioned document, so it shows up in Revisão like any other change
//     and stays legible after five adjustments (§3.8.9).
//   • the RUNTIME the machine owns — `.loro/loops/<slug>.json`: when it ran, how
//     long it took, which files came out, whether it failed. Quarantined from git
//     (`git::GIT_IGNORED`), exactly like the intake's own bookkeeping (ADR-0027),
//     because every cycle rewrites it and it says nothing to a teammate.
//
// THE CLOCK IS THE OPEN APP (§4.6, option a). The frontend ticks and hands this
// module the LOCAL civil time (`Now`), which buys two things a timezone database
// would otherwise be needed for: a weekly rhythm is compared in the person's own
// calendar, and a rhythm under a day is a DURATION since the last run — which is
// what makes it immune to a DST jump (§3.10 B3/B4). Nothing here reads the system
// clock to DECIDE; `Now` is the only source, so every decision is a pure function
// with a test.
//
// BR-1 — the cycle runs the user's own agent CLI, locally, and only while the app
// is open. BR-8 — the runtime record carries when / how long / which files / an
// `err.*` code, NEVER the produced text and never a transcript quote. BR-9 — no
// credential is requested, stored or logged; the agent uses the person's own.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::info;

use crate::config::{active_acervo, read_loro_config, AcervoSettings};

// ---------------------------------------------------------------------------
// the definition
// ---------------------------------------------------------------------------

/// Where a cycle's material lands. The knowledge destination PROPOSES — the
/// change appears in Revisão and nothing becomes official without the person
/// (§3.8.6).
pub const DEST_FOLDER: &str = "pasta";
pub const DEST_KNOWLEDGE: &str = "conhecimento";
pub const DEST_IDEA_PREFIX: &str = "ideia:";

/// Scope: what the cycle is allowed to read.
pub const SCOPE_PROJECT: &str = "projeto";
/// A scope POINTED at one place: one folder of the acervo (`pasta:<rel>`) or one
/// knowledge context (`conhecimento:<slug>`). A pointed scope is not a filter the
/// agent may widen — the prompt says «read ONLY this», because a loop whose scope
/// is a folder was created to look at that folder (§4.15).
pub const SCOPE_FOLDER_PREFIX: &str = "pasta:";
pub const SCOPE_KNOWLEDGE_PREFIX: &str = "conhecimento:";
/// What `projeto` reads — the whole readable tree, as the prompt names it.
pub const SCOPE_ALL: &str = "brainstorming/ e contexts/";

/// A loop's own file, as the person reads it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopDef {
    pub slug: String,
    pub titulo: String,
    /// A habilidade the loop cites (`/loro-digest`), or empty for instruction-only.
    #[serde(default)]
    pub habilidade: String,
    /// The instruction, in prose. Adjustments made by talking to the loop are
    /// appended here as dated lines, so the loop stays readable (§3.8.9).
    #[serde(default)]
    pub instrucao: String,
    /// `min:<n>` · `dia:<hh>:<mm>` · `semana:<dow 0-6, 0=Sunday>:<hh>:<mm>`
    pub ritmo: String,
    /// `projeto` | `ideia:<slug>` — declared once at creation (§4.8).
    #[serde(default)]
    pub escopo: String,
    /// `pasta` | `ideia:<slug>` | `conhecimento`
    #[serde(default)]
    pub destino: String,
    /// Which model a cycle runs with and how hard it thinks — the agent CLI's own
    /// values (`sonnet`, `high`), never a translated label. EMPTY means «whatever
    /// the agent already uses»: an empty `--model` makes the CLI refuse the whole
    /// turn, so nothing is passed at all (the lesson chat.rs paid for). A loop is a
    /// standing cost, so this is per loop and not a project-wide setting (§4.16).
    #[serde(default)]
    pub modelo: String,
    #[serde(default)]
    pub esforco: String,
    #[serde(default)]
    pub ligado: bool,
    #[serde(default)]
    pub criado: String,
    /// Local date (YYYY-MM-DD) after which the loop turns itself off (§3.10 F2).
    #[serde(default)]
    pub expira: String,
    #[serde(default)]
    pub max_arquivos: u32,
    #[serde(default)]
    pub max_ciclos_dia: u32,
}

/// One recorded cycle. Structure only — BR-8 binds this struct.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopCycle {
    pub started_ms: i64,
    pub ended_ms: i64,
    pub started_date: String,
    /// `ok` · `nothing` · `failed` · `skipped` · `stopped`
    pub outcome: String,
    /// Acervo-relative paths the cycle created. A path is an address, not content.
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub steps: u32,
    /// Stable `err.*` code when the outcome is `failed`/`stopped`.
    #[serde(default)]
    pub err: String,
}

/// What the machine knows about a loop. Never versioned.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoopRuntime {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub last_run_ms: i64,
    #[serde(default)]
    pub last_run_date: String,
    #[serde(default)]
    pub last_outcome: String,
    #[serde(default)]
    pub fail_streak: u32,
    /// Epoch ms before which a failing loop does not try again (backoff).
    #[serde(default)]
    pub next_attempt_ms: i64,
    #[serde(default)]
    pub runs_date: String,
    #[serde(default)]
    pub runs_today: u32,
    /// Cycles, newest first, capped at `HISTORY_CAP`.
    #[serde(default)]
    pub cycles: Vec<LoopCycle>,
    /// Windows the app was closed for, counted the first time it is noticed
    /// (§3.10 B1 — a `próxima execução` in the past is a lie).
    #[serde(default)]
    pub missed: u32,
    /// The `err.*` code of something only a PERSON can settle — a permission the
    /// cycle asked for (§3.10 C4), or a credential the triage found in what the
    /// cycle wrote (§3.10 E1). Empty when there is nothing waiting. It is NOT a
    /// transient failure: retrying five times would spend the AI on a question
    /// nobody but the person can answer, and then disarm a loop that was never
    /// broken. The person clears it by deciding something (ligar, rodar agora,
    /// ajustar a instrução).
    #[serde(default)]
    pub needs_person: String,
}

pub const HISTORY_CAP: usize = 60;
/// Consecutive failures after which the loop turns itself off and says so.
pub const STOP_AFTER_FAILURES: u32 = 5;

// ---------------------------------------------------------------------------
// local civil time — supplied by the caller, never read from the system here
// ---------------------------------------------------------------------------

/// The person's own wall clock, as the frontend read it.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Now {
    pub epoch_ms: i64,
    /// Local date, YYYY-MM-DD.
    pub date: String,
    pub hh: u32,
    pub mi: u32,
    /// 0 = Sunday … 6 = Saturday.
    pub weekday: u32,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Rhythm {
    Every { minutes: u32 },
    Daily { hh: u32, mi: u32 },
    Weekly { dow: u32, hh: u32, mi: u32 },
}

pub fn parse_rhythm(s: &str) -> Option<Rhythm> {
    let mut it = s.trim().split(':');
    match it.next()? {
        "min" => {
            let minutes: u32 = it.next()?.trim().parse().ok()?;
            (1..=24 * 60)
                .contains(&minutes)
                .then_some(Rhythm::Every { minutes })
        }
        "dia" => {
            let hh: u32 = it.next()?.trim().parse().ok()?;
            let mi: u32 = it.next()?.trim().parse().ok()?;
            (hh < 24 && mi < 60).then_some(Rhythm::Daily { hh, mi })
        }
        "semana" => {
            let dow: u32 = it.next()?.trim().parse().ok()?;
            let hh: u32 = it.next()?.trim().parse().ok()?;
            let mi: u32 = it.next()?.trim().parse().ok()?;
            (dow < 7 && hh < 24 && mi < 60).then_some(Rhythm::Weekly { dow, hh, mi })
        }
        _ => None,
    }
}

/// days since 1970-01-01 for a civil date — Howard Hinnant's algorithm, the
/// inverse of the `civil_from_days` the acervo already uses. Pure, so comparing
/// two local dates never needs a calendar library.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// YYYY-MM-DD → days since the epoch. `None` for anything else.
pub fn day_of(date: &str) -> Option<i64> {
    let mut it = date.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Whole days between two local dates (`b - a`), or 0 when either is unreadable.
pub fn days_between(a: &str, b: &str) -> i64 {
    match (day_of(a), day_of(b)) {
        (Some(x), Some(y)) => y - x,
        _ => 0,
    }
}

fn at_or_past(now: &Now, hh: u32, mi: u32) -> bool {
    now.hh * 60 + now.mi >= hh * 60 + mi
}

/// The scheduled moment for this period has arrived and this period has not run.
fn on_time(def: &LoopDef, rt: &LoopRuntime, now: &Now) -> bool {
    match parse_rhythm(&def.ritmo) {
        Some(Rhythm::Every { minutes }) => {
            rt.last_run_ms == 0 || now.epoch_ms - rt.last_run_ms >= i64::from(minutes) * 60_000
        }
        Some(Rhythm::Daily { hh, mi }) => at_or_past(now, hh, mi) && rt.last_run_date != now.date,
        Some(Rhythm::Weekly { dow, hh, mi }) => {
            now.weekday == dow && at_or_past(now, hh, mi) && rt.last_run_date != now.date
        }
        None => false,
    }
}

/// A window went by while the app was closed. Worth exactly ONE catch-up run —
/// never a storm (§3.10 B2). Duration rhythms need no catch-up: `on_time` already
/// fires the moment the app comes back.
pub fn missed_window(def: &LoopDef, rt: &LoopRuntime, now: &Now) -> bool {
    if rt.last_run_ms == 0 || rt.last_run_date.is_empty() {
        return false;
    }
    let gap = days_between(&rt.last_run_date, &now.date);
    match parse_rhythm(&def.ritmo) {
        Some(Rhythm::Daily { .. }) => gap >= 2,
        Some(Rhythm::Weekly { .. }) => gap >= 8,
        _ => false,
    }
}

/// How many scheduled windows went by unrun — what the screen counts instead of
/// showing a next run that is already in the past.
pub fn missed_count(def: &LoopDef, rt: &LoopRuntime, now: &Now) -> u32 {
    if rt.last_run_ms == 0 || rt.last_run_date.is_empty() {
        return 0;
    }
    let gap = days_between(&rt.last_run_date, &now.date);
    if gap <= 0 {
        return 0;
    }
    let n = match parse_rhythm(&def.ritmo) {
        Some(Rhythm::Daily { .. }) => gap - 1,
        Some(Rhythm::Weekly { .. }) => (gap - 1) / 7,
        _ => 0,
    };
    n.clamp(0, i64::from(u32::MAX)) as u32
}

/// Um loop que sai da fila pode ter sido desligado ou vencido enquanto esperava.
/// Uma leitura só, para o dreno da fila e para quem mais precisar dela.
pub fn queue_still_valid(def: &LoopDef, now: &Now) -> bool {
    def.ligado && !expired(def, now)
}

pub fn expired(def: &LoopDef, now: &Now) -> bool {
    !def.expira.is_empty() && days_between(&def.expira, &now.date) > 0
}

/// Which brake stopped this cycle, if any. `files_this_cycle` is what the cycle
/// has ALREADY created — the check runs during the cycle, so a brake ends it
/// instead of reporting it afterwards (§3.10 D2).
pub fn ceiling_hit(
    def: &LoopDef,
    rt: &LoopRuntime,
    now: &Now,
    files_this_cycle: u32,
) -> Option<&'static str> {
    if def.max_arquivos > 0 && files_this_cycle > def.max_arquivos {
        return Some("err.loop_ceiling_files");
    }
    if def.max_ciclos_dia > 0 && rt.runs_date == now.date && rt.runs_today >= def.max_ciclos_dia {
        return Some("err.loop_ceiling_runs");
    }
    None
}

/// Whether the clock may start this loop now. Everything a test needs is in the
/// arguments; nothing here touches the filesystem or the clock.
pub fn due(def: &LoopDef, rt: &LoopRuntime, now: &Now) -> bool {
    if !def.ligado || expired(def, now) {
        return false;
    }
    if rt.next_attempt_ms > 0 && now.epoch_ms < rt.next_attempt_ms {
        return false; // backing off after a failure
    }
    if ceiling_hit(def, rt, now, 0).is_some() {
        return false;
    }
    on_time(def, rt, now) || missed_window(def, rt, now)
}

/// What the surfaces say about a loop. `loop_status` is the only authority the
/// row, the header mark and the screen read (§3.9), and this is where it decides.
///
/// Order is deliberate: a cycle that IS running is reported as running even when
/// the person just switched the loop off — the state names what is true now, and
/// the cycle it started keeps going to its end.
pub fn state_of(def: &LoopDef, rt: &LoopRuntime, now: &Now, ctx: &StateCtx) -> &'static str {
    if ctx.running {
        return "running";
    }
    if ctx.queued {
        return "queued";
    }
    // «expirou» vem ANTES de «desligado»: o tique desliga o loop ao expirar, então
    // lido na outra ordem o estado dizia «desligado» e a pessoa nunca sabia que ele
    // tinha chegado ao fim do prazo (e o botão «religar» nunca aparecia).
    if expired(def, now) {
        return "expired";
    }
    if !def.ligado {
        return "off";
    }
    if ctx.blocked.is_some() {
        return "blocked";
    }
    if rt.fail_streak > 0 {
        return "failing";
    }
    "armed"
}

#[derive(Default, Clone, Debug)]
pub struct StateCtx {
    pub running: bool,
    pub queued: bool,
    /// A stable `err.*` code naming WHY it cannot run: armed and able-to-run are
    /// different facts, and painting armed over an impediment is the interface
    /// knowing something it does not say (§3.9).
    pub blocked: Option<String>,
}

/// Minutes to wait after `streak` consecutive failures (exponential, capped).
pub fn backoff_minutes(streak: u32) -> u32 {
    match streak {
        0 => 0,
        s if s >= 6 => 60,
        s => 1u32 << (s - 1),
    }
}

// ---------------------------------------------------------------------------
// the definition file: front matter + prose
// ---------------------------------------------------------------------------

pub fn loops_dir(base: &Path) -> PathBuf {
    base.join("loops")
}

fn def_path(base: &Path, slug: &str) -> PathBuf {
    loops_dir(base).join(format!("{slug}.md"))
}

fn runtime_path(base: &Path, slug: &str) -> PathBuf {
    base.join(".loro/loops").join(format!("{slug}.json"))
}

/// `loops/<slug>.md` for a slug — the rel the UI opens as a tab.
pub fn def_rel(slug: &str) -> String {
    format!("loops/{slug}.md")
}

/// The slug a `loops/<slug>.md` rel names, if it is one.
pub fn slug_of_rel(rel: &str) -> Option<String> {
    let rel = rel.replace('\\', "/");
    let name = rel.strip_prefix("loops/")?;
    let stem = name.strip_suffix(".md")?;
    (!stem.is_empty() && !stem.contains('/')).then(|| stem.to_string())
}

/// The slug of a folder in this acervo — the SAME function every other name goes
/// through (`git::sanitize_slug`, ASCII-only). A second implementation that kept
/// accents derived `brainstorming/lançamento-q3` for an idea that lives at
/// `brainstorming/lan-amento-q3`: a destination that does not exist.
pub fn slugify(s: &str) -> String {
    crate::git::sanitize_slug(s).unwrap_or_default()
}

fn fm_line(key: &str, value: &str) -> String {
    format!("{key}: {value}\n")
}

/// Serialize a definition back to the document the person reads. Deterministic:
/// the same definition always writes the same bytes, so an unchanged loop never
/// shows up as a pending change.
pub fn to_markdown(def: &LoopDef) -> String {
    let mut s = String::from("---\n");
    s.push_str(&fm_line("loro", "1"));
    s.push_str(&fm_line("tipo", "loop"));
    s.push_str(&fm_line("loop", &def.slug));
    s.push_str(&fm_line("titulo", &def.titulo));
    s.push_str(&fm_line("habilidade", &def.habilidade));
    s.push_str(&fm_line("ritmo", &def.ritmo));
    s.push_str(&fm_line("escopo", &def.escopo));
    s.push_str(&fm_line("destino", &def.destino));
    s.push_str(&fm_line("modelo", &def.modelo));
    s.push_str(&fm_line("esforco", &def.esforco));
    s.push_str(&fm_line(
        "ligado",
        if def.ligado { "true" } else { "false" },
    ));
    s.push_str(&fm_line("criado", &def.criado));
    s.push_str(&fm_line("expira", &def.expira));
    s.push_str(&fm_line("maxArquivos", &def.max_arquivos.to_string()));
    s.push_str(&fm_line("maxCiclosDia", &def.max_ciclos_dia.to_string()));
    s.push_str("---\n\n");
    s.push_str(def.instrucao.trim_end());
    s.push('\n');
    s
}

/// Parse the document back into a definition. Unknown keys are ignored on
/// purpose: a loop written by a newer Loro (or by hand) must not fail to open.
pub fn from_markdown(slug: &str, text: &str) -> LoopDef {
    let mut def = LoopDef {
        slug: slug.to_string(),
        titulo: slug.to_string(),
        ritmo: "semana:1:09:00".into(),
        escopo: SCOPE_PROJECT.into(),
        destino: DEST_FOLDER.into(),
        ..Default::default()
    };
    let body_start;
    // `split_inclusive` mantém o terminador de linha: contar `len() + 1` sobre
    // `lines()` (que come o `\r`) desalinhava o corpo em 1 byte por linha num
    // arquivo salvo por um editor do Windows, e a instrução voltava com pedaços do
    // front matter dentro dela.
    let mut lines = text.split_inclusive('\n');
    if text.starts_with("---") {
        let first = lines.next().unwrap_or_default();
        let mut consumed = first.len();
        for raw in lines.by_ref() {
            consumed += raw.len();
            let line = raw.trim_end_matches(['\n', '\r']);
            if line.trim() == "---" {
                break;
            }
            let Some((k, v)) = line.split_once(':') else {
                continue;
            };
            let key = k.trim();
            let val = v.trim().to_string();
            match key {
                "loop" => {
                    if !val.is_empty() {
                        def.slug = val;
                    }
                }
                "titulo" => def.titulo = val,
                "habilidade" => def.habilidade = val,
                "ritmo" => def.ritmo = val,
                "escopo" => def.escopo = val,
                "destino" => def.destino = val,
                "modelo" => def.modelo = val,
                "esforco" | "esforço" => def.esforco = val,
                "ligado" => def.ligado = val == "true",
                "criado" => def.criado = val,
                "expira" => def.expira = val,
                "maxArquivos" => def.max_arquivos = val.parse().unwrap_or(0),
                "maxCiclosDia" => def.max_ciclos_dia = val.parse().unwrap_or(0),
                _ => {}
            }
        }
        body_start = consumed.min(text.len());
    } else {
        body_start = 0;
    }
    def.instrucao = text[body_start..].trim().to_string();
    if def.titulo.is_empty() {
        def.titulo = def.slug.clone();
    }
    def
}

/// A loop that arrives inside a plugin arrives OFF — arming is the person's act
/// (§3.8.1). Rewriting the front matter line is enough, and it keeps whatever else the
/// author wrote. A pacote cannot hand a loop a PERMISSION either, and that needs no
/// rewriting here: the grants live in `.loro/settings.json` (§4.18), and an install's
/// destinations are built by Loro, so a package has no path to that file.
pub fn disarm_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_fm = text.starts_with("---");
    let mut fences = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if in_fm && trimmed == "---" {
            fences += 1;
            if fences == 2 {
                in_fm = false;
            }
            out.push_str(line);
            continue;
        }
        // A chave é reconhecida COMO O PARSER a reconhece (`from_markdown` faz
        // `k.trim()`): " ligado: true", "\tligado: true" e "ligado : true" passavam
        // por aqui intactos e o pacote entregava um loop LIGADO — o oposto de
        // §3.8.1, e o único lugar da ADR onde um descuido vira trabalho autônomo
        // que ninguém armou.
        if in_fm
            && trimmed
                .split_once(':')
                .is_some_and(|(k, _)| k.trim() == "ligado")
        {
            out.push_str("ligado: false");
            if line.ends_with('\n') {
                out.push('\n');
            }
            continue;
        }
        out.push_str(line);
    }
    out
}

// ---------------------------------------------------------------------------
// disk
// ---------------------------------------------------------------------------

fn base() -> Result<PathBuf, String> {
    crate::acervo::acervo_base()
}

fn read_runtime(base: &Path, slug: &str) -> LoopRuntime {
    let mut rt = std::fs::read_to_string(runtime_path(base, slug))
        .ok()
        .and_then(|t| serde_json::from_str::<LoopRuntime>(&t).ok())
        .unwrap_or_default();
    rt.slug = slug.to_string();
    rt
}

fn write_runtime(base: &Path, rt: &LoopRuntime) -> Result<(), String> {
    let p = runtime_path(base, &rt.slug);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &p,
        serde_json::to_string_pretty(rt).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Every loop the acervo carries, by slug (sorted).
pub fn list_defs(base: &Path) -> Vec<LoopDef> {
    let dir = loops_dir(base);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() || p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        out.push(from_markdown(stem, &text));
    }
    let policy = policy_of(&crate::config::read_acervo_settings(base));
    let mut out: Vec<LoopDef> = out.into_iter().map(|d| with_brakes(d, &policy)).collect();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

pub fn read_def(base: &Path, slug: &str) -> Result<LoopDef, String> {
    let p = def_path(base, slug);
    let text = std::fs::read_to_string(&p).map_err(|_| "err.loop_not_found".to_string())?;
    let policy = policy_of(&crate::config::read_acervo_settings(base));
    Ok(with_brakes(from_markdown(slug, &text), &policy))
}

/// A definition with NO brakes has the project's, never none. `ceiling_hit` and
/// `expired` are guarded by `> 0` / non-empty, so a file written by hand — or by a
/// pacote that omitted them — would have had no file cap, no daily cap and no
/// life. The floor is applied on READ, in memory: writing it back would turn every
/// open into a pending change.
pub fn with_brakes(mut def: LoopDef, policy: &LoopPolicy) -> LoopDef {
    if def.max_arquivos == 0 {
        def.max_arquivos = policy.max_arquivos;
    }
    if def.max_ciclos_dia == 0 {
        def.max_ciclos_dia = policy.max_ciclos_dia;
    }
    def
}

fn write_def(base: &Path, def: &LoopDef) -> Result<String, String> {
    let dir = loops_dir(base);
    std::fs::create_dir_all(&dir).map_err(|e| crate::paths::folder_write_error(&e))?;
    let p = def_path(base, &def.slug);
    std::fs::write(&p, to_markdown(def)).map_err(|e| crate::paths::folder_write_error(&e))?;
    Ok(def_rel(&def.slug))
}

// ---------------------------------------------------------------------------
// where a cycle writes, and what it may read
// ---------------------------------------------------------------------------

/// The destination folder, as an acervo-relative path. Guarded by construction:
/// the only shapes it can produce are the loop's own folder, an idea's
/// attachments, or `contexts/` (where a cycle PROPOSES, §3.8.6).
pub fn dest_rel(def: &LoopDef) -> String {
    if def.destino == DEST_KNOWLEDGE {
        return "contexts".into();
    }
    if let Some(idea) = def.destino.strip_prefix(DEST_IDEA_PREFIX) {
        let slug = slugify(idea);
        if !slug.is_empty() {
            return format!("brainstorming/{slug}/attachments");
        }
    }
    format!("loops/{}", def.slug)
}

/// An acervo-relative FOLDER, normalized — or "" when the path escapes the acervo
/// or says nothing. Pure, and the same rule the save, the block and the prompt all
/// read: a typed path is checked in ONE place or it is checked in none.
pub fn scope_folder(rel: &str) -> String {
    // O caminho é DIGITADO: ele chega com a barra sobrando, com o espaço do lado do
    // que se colou e com a barra do Windows. Cada pedaço é aparado antes de a regra
    // de escape decidir — senão «pasta: contexts/produto» virava uma pasta chamada
    // " contexts", que não existe, e o loop nascia impedido sem dizer por quê.
    let cleaned = rel
        .replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    crate::acervo::normalize_rel(&cleaned).unwrap_or_default()
}

/// The single folder a POINTED scope names, when the scope points at one:
/// `Some(rel)` for a folder or a context, `Some("")` when what it says is not a
/// usable path, `None` for the whole project or an idea (which has its own rule).
pub fn pointed_scope(def: &LoopDef) -> Option<String> {
    if let Some(rel) = def.escopo.strip_prefix(SCOPE_FOLDER_PREFIX) {
        return Some(scope_folder(rel));
    }
    if let Some(slug) = def.escopo.strip_prefix(SCOPE_KNOWLEDGE_PREFIX) {
        let slug = slugify(slug);
        return Some(if slug.is_empty() {
            String::new()
        } else {
            format!("contexts/{slug}")
        });
    }
    None
}

/// What the cycle is told to read.
pub fn read_scope(def: &LoopDef) -> String {
    if let Some(idea) = def.escopo.strip_prefix(DEST_IDEA_PREFIX) {
        let slug = slugify(idea);
        if !slug.is_empty() {
            return format!("brainstorming/{slug}");
        }
    }
    match pointed_scope(def) {
        Some(rel) if !rel.is_empty() => rel,
        _ => SCOPE_ALL.into(),
    }
}

/// Does the scope name ONE place? Then the cycle reads that and nothing else. The
/// distinction is the prompt's: «leia X» invites the agent to look around when it
/// feels short of context, and «leia SOMENTE X» does not (§4.15).
pub fn scope_is_pointed(def: &LoopDef) -> bool {
    read_scope(def) != SCOPE_ALL
}

/// Tools a cycle NEVER gets, whatever anyone grants. `Bash` is arbitrary execution: with
/// it, «a loop never runs git» (§3.8) and «permissão: ler e editar o projeto» are prose
/// the agent may follow, not facts the machine keeps.
///
/// MEASURED, NOT ASSUMED (2026-08-18, the owner's own session log): a cycle running with
/// `--permission-mode acceptEdits` executed `find /Users/…/Desktop` and `ls -la` with
/// `is_error: false`. `acceptEdits` auto-approves Bash in this CLI — so the mode alone
/// never was the boundary the screen claimed it was. `--disallowedTools` is what makes it
/// one. Scoped execution (`Bash(git *)`) is a door the owner may open later; it is §4.3's
/// door, and it does not open by omission.
pub const NEVER_FOR_A_CYCLE: [&str; 1] = ["Bash"];

/// The tool flags of a cycle's turn, in order. Pure, so what a cycle may reach is a fact
/// with a test instead of a claim in a comment.
pub fn cycle_tool_flags(permite: &[String], recusa: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let allowed = clean_tools(permite);
    if !allowed.is_empty() {
        out.push("--allowedTools".into());
        out.push(allowed.join(","));
    }
    // o que a pessoa recusou, MAIS o que nunca é de um ciclo. Um `--disallowedTools`
    // vazio é um argumento que o CLI recusa, mas esta lista nunca é vazia: `Bash` está
    // sempre nela.
    let mut refused = clean_refusals(recusa);
    for t in NEVER_FOR_A_CYCLE {
        if !refused.iter().any(|r| r == t) {
            refused.push(t.to_string());
        }
    }
    out.push("--disallowedTools".into());
    out.push(refused.join(","));
    out
}

/// A tool name a cycle may be granted — or "" when it is not one Loro will pass on.
///
/// WHAT IS REFUSED HERE IS THE POINT (§4.17). `Bash` is arbitrary execution: that is
/// the executable door of §4.3, and it does not open through a checkbox on a loop.
/// A `*` is accepted only as a whole MCP server's suffix (`mcp__slack__*`), never
/// alone — «tudo, sem perguntar» is refused for a cycle by name (§4.9), and a bare
/// wildcard would be exactly that under another spelling.
pub fn safe_tool_name(v: &str) -> String {
    let v = v.trim();
    if v.is_empty() || v.len() > 80 {
        return String::new();
    }
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '*');
    if !v.chars().all(plain) {
        return String::new();
    }
    if v.eq_ignore_ascii_case("bash") || v.starts_with('-') {
        return String::new();
    }
    if v.contains('*') && !(v.starts_with("mcp__") && v.ends_with("__*") && v.len() > 8) {
        return String::new();
    }
    v.to_string()
}

/// A list of tool names, cleaned. Every list that reaches the agent's command line goes
/// through here at SPAWN TIME, never trusted as read: `.loro/settings.json` is
/// versioned, so it arrives in someone else's commit and is treated as untrusted input
/// (the same posture `brain_remove_plugin` takes).
pub fn clean_tools(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in list {
        let t = safe_tool_name(t);
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// The same cleaning for a list of tools being REFUSED. `safe_tool_name` exists to say
/// what may be GRANTED, so it drops `Bash` — dropping it from a deny list would do the
/// opposite of what the person asked.
pub fn clean_refusals(list: &[String]) -> Vec<String> {
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '*');
    let mut out: Vec<String> = Vec::new();
    for t in list {
        let t = t.trim();
        if t.is_empty() || t.len() > 80 || t.starts_with('-') || !t.chars().all(plain) {
            continue;
        }
        if !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// A value that ends up on the agent's COMMAND LINE. The definition is a document
/// a person can hand-edit, so what it says is never passed on verbatim: anything
/// that is not a plain token is dropped, and the cycle runs with the agent's own
/// default instead of with a surprise in `argv`.
pub fn safe_cli_value(v: &str) -> String {
    let v = v.trim();
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':');
    if v.is_empty() || v.len() > 40 || v.starts_with('-') || !v.chars().all(plain) {
        return String::new();
    }
    v.to_string()
}

/// A file and its FINGERPRINT (length + mtime in ms), acervo-relative. The
/// fingerprint is what lets the record say a cycle changed an existing document:
/// comparing names alone reported «nada novo» for a knowledge cycle that rewrote
/// `context.md` — a proposal the person would never have been told about. It never
/// reads a byte of the content (BR-8).
type Stamp = (String, u64, i64);

fn stamp_of(base: &Path, rel: &str) -> Option<Stamp> {
    let md = std::fs::metadata(base.join(rel)).ok()?;
    if !md.is_file() {
        return None;
    }
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    Some((rel.to_string(), md.len(), mtime))
}

fn listing(base: &Path, rel: &str) -> Vec<Stamp> {
    let dir = base.join(rel);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<Stamp> = rd
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().to_str().map(|n| format!("{rel}/{n}")))
        .filter_map(|r| stamp_of(base, &r))
        .collect();
    out.sort();
    out
}

/// Recursive listing for the knowledge destination, where a proposal lands
/// inside `contexts/<ctx>/`.
fn listing_deep(base: &Path, rel: &str, depth: u32, out: &mut Vec<Stamp>) {
    if depth == 0 {
        return;
    }
    let dir = base.join(rel);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let Some(name) = e.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let child = format!("{rel}/{name}");
        if p.is_dir() {
            listing_deep(base, &child, depth - 1, out);
        } else if let Some(st) = stamp_of(base, &child) {
            out.push(st);
        }
    }
}

fn snapshot(base: &Path, def: &LoopDef) -> Vec<Stamp> {
    let rel = dest_rel(def);
    if def.destino == DEST_KNOWLEDGE {
        let mut out = Vec::new();
        listing_deep(base, &rel, 4, &mut out);
        out.sort();
        out
    } else {
        listing(base, &rel)
    }
}

/// What the cycle TOUCHED: a file that appeared, or one whose length/mtime moved.
/// A knowledge cycle proposes by rewriting a document that already existed, so
/// "created" alone would have reported it as a quiet cycle.
fn changed_since(before: &[Stamp], after: &[Stamp], since_ms: i64) -> Vec<String> {
    after
        .iter()
        .filter(|st| !before.iter().any(|b| b == *st))
        // §3.10 — o destino «conhecimento» é uma árvore que OUTRAS mãos também
        // escrevem (a pessoa noutra aba, outro loop). Sem a hora, a mudança de
        // outro escritor era atribuída a este ciclo — e podia até bater o freio
        // dele. Só o que se moveu depois de o ciclo começar é dele.
        .filter(|(_, _, mtime)| since_ms == 0 || *mtime >= since_ms - 1000)
        .map(|(rel, _, _)| rel.clone())
        .collect()
}

/// Quantos `tool_use` uma linha do stream anuncia — contados do bloco da mensagem
/// do agente, que é o único lugar onde cada um aparece uma vez.
fn tool_uses_in(line: &str) -> u32 {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return 0;
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return 0;
    }
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                .count() as u32
        })
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// the prompt — pure, so what a cycle is told can be read in a test
// ---------------------------------------------------------------------------

/// Did the cycle write something the intake refuses? §3.8.3/§3.10 E1 — A LOOP IS
/// NOT A PRIVILEGED WRITER: a credential in a cycle's material would reach a commit
/// exactly as one pasted by hand (BR-9), and the "conhecimento" destination IS the
/// versioned tree. The file is NOT deleted — it is the agent's work, and deleting it
/// in silence would be worse than saying so. The cycle ends blocked, the state turns
/// amber and the reason names the file. The finding itself never travels (BR-8).
pub fn intake_block_of(base: &Path, files: &[String]) -> Option<String> {
    for rel in files {
        let Ok(text) = std::fs::read_to_string(base.join(rel)) else {
            continue; // binário ou ilegível: a triagem é de texto
        };
        if crate::intake::blocked(&crate::intake::scan(&text)) {
            return Some(format!("err.intake_secret:{rel}"));
        }
    }
    None
}

/// What this loop ALREADY produced, newest first, deduped and capped. Names and dates
/// from the runtime record — never content (BR-8), and no directory listing needed.
///
/// It exists because of a contradiction the prompt carried: the cycle was told «never read
/// your own output folder» AND «if there is nothing new, write nothing». Nothing new *than
/// what?* Blind, the agent chose silence — measured in the owner's acervo on 2026-08-18:
/// four cycles, 4/10/8 steps, every tool call fine, seven documents read, and the answer
/// «nada novo» each time, while the person waited for the insights they had asked for.
pub fn recent_output(rt: &LoopRuntime, cap: usize) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for c in &rt.cycles {
        for f in &c.files {
            if out.len() >= cap {
                return out;
            }
            if !out.iter().any(|(rel, _)| rel == f) {
                out.push((f.clone(), c.started_date.clone()));
            }
        }
    }
    out
}

/// The turn a cycle sends to the agent. It states the destination, the reading
/// scope (excluding the loop's OWN output — a loop whose output is inside its
/// input feeds itself, §3.10 D3), the file brake, and the acts a loop never
/// performs (§3.8: no git, no version, no send for review, nothing outbound).
pub fn cycle_prompt(
    def: &LoopDef,
    lang: &str,
    allowed: &[String],
    recent: &[(String, String)],
) -> String {
    let dest = dest_rel(def);
    let scope = read_scope(def);
    let cap = if def.max_arquivos > 0 {
        def.max_arquivos
    } else {
        1
    };
    let mut p = String::new();
    if !def.habilidade.trim().is_empty() {
        p.push_str(def.habilidade.trim());
        p.push_str("\n\n");
    }
    if lang == "en" {
        p.push_str(&format!(
            "This is one cycle of the Loro loop \"{}\". Do what the instruction asks and nothing else.\n\nINSTRUCTION\n{}\n\nRULES FOR THIS CYCLE\n",
            def.slug,
            def.instrucao.trim()
        ));
        if scope_is_pointed(def) {
            p.push_str(&format!("- Read ONLY {scope} and what it contains — nothing outside it. Your output folder ({dest}) is NOT material: what is there you wrote yourself.\n"));
        } else {
            p.push_str(&format!("- Read: {scope}. Your output folder ({dest}) is NOT material: what is there you wrote yourself.\n"));
        }
        if def.destino == DEST_KNOWLEDGE {
            p.push_str("- Write your proposal straight into the knowledge documents (contexts/**/context.md). It is a PROPOSAL: the person reviews it before it becomes official.\n");
        } else {
            p.push_str(&format!(
                "- Write whatever you produce ONLY inside {dest}.\n"
            ));
        }
        p.push_str(&format!("- At most {cap} file(s) in this cycle.\n"));
        if !allowed.is_empty() {
            p.push_str(&format!(
                "- Outside the project you may only use: {}. Nothing else, and never to SEND anything — only to read.\n",
                allowed.join(", ")
            ));
        }
        // «nothing new» is only offered when the cycle has something to compare WITH. On a
        // first cycle it would be an invitation to say nothing about a job never done.
        if recent.is_empty() {
            p.push_str("- This is this loop's FIRST cycle: there is nothing of yours to compare against, so produce what the instruction asks for.\n");
        } else {
            let list = recent
                .iter()
                .map(|(rel, date)| format!("{rel} ({date})"))
                .collect::<Vec<_>>()
                .join(", ");
            p.push_str(&format!("- You already produced, in earlier cycles: {list}. OPEN the most recent one before deciding, so you do not repeat what is already said there — that is the only use you make of your own output.\n"));
            p.push_str("- You may UPDATE that file with whatever is new or better — that is preferable to creating another one like it beside it.\n");
            p.push_str("- If, after looking, there is nothing to add and nothing to correct, write nothing and answer only \"nothing new\".\n");
        }
        p.push_str("- Never run git, never save a version, never send anything for review or outside: those are the person's acts.\n");
        return p;
    }
    p.push_str(&format!(
        "Este é um ciclo do loop \"{}\" do Loro. Faça o que a instrução pede e nada além disso.\n\nINSTRUÇÃO\n{}\n\nREGRAS DESTE CICLO\n",
        def.slug,
        def.instrucao.trim()
    ));
    if scope_is_pointed(def) {
        p.push_str(&format!("- Leia SOMENTE {scope} e o que está dentro dela — nada fora dela. A sua pasta de saída ({dest}) NÃO é material: o que está lá foi você que escreveu.\n"));
    } else {
        p.push_str(&format!("- Leia: {scope}. A sua pasta de saída ({dest}) NÃO é material: o que está lá foi você que escreveu.\n"));
    }
    if def.destino == DEST_KNOWLEDGE {
        p.push_str("- Escreva a sua proposta direto nos documentos de conhecimento (contexts/**/context.md). É uma PROPOSTA: a pessoa revisa antes de virar oficial.\n");
    } else {
        p.push_str(&format!(
            "- Escreva o que produzir SOMENTE dentro de {dest}.\n"
        ));
    }
    p.push_str(&format!("- No máximo {cap} arquivo(s) neste ciclo.\n"));
    if !allowed.is_empty() {
        p.push_str(&format!(
            "- Fora do projeto você só pode usar: {}. Nada além disso, e nunca para ENVIAR algo — só para ler.\n",
            allowed.join(", ")
        ));
    }
    // «nada novo» só é oferecido quando há com o que comparar. No primeiro ciclo, ela é um
    // convite a não fazer o trabalho que ninguém fez ainda.
    if recent.is_empty() {
        p.push_str("- Este é o PRIMEIRO ciclo deste loop: não há nada seu para comparar, então produza o que a instrução pede.\n");
    } else {
        let list = recent
            .iter()
            .map(|(rel, date)| format!("{rel} ({date})"))
            .collect::<Vec<_>>()
            .join(", ");
        p.push_str(&format!("- Você já produziu, em ciclos anteriores: {list}. ABRA o mais recente antes de decidir, para não repetir o que já está dito lá — é o único uso que você faz do que você mesmo escreveu.\n"));
        // O TERCEIRO CAMINHO. O prompt oferecia dois — escrever um arquivo novo ou dizer
        // «nada novo» — e para uma instrução generativa («me dê insights sobre o tema») o
        // certo é o que faltava: melhorar o documento que já existe. Sem esta linha, um
        // loop de insights sobre material estático ficava quieto para sempre depois do
        // primeiro ciclo (medido: quatro ciclos, sete documentos lidos, zero arquivos).
        // `changed_since` já reconhece um arquivo reescrito (comprimento + mtime), então
        // uma atualização conta como o que o ciclo produziu.
        p.push_str("- Você pode ATUALIZAR esse arquivo com o que houver de novo ou melhor — isso é preferível a criar outro parecido ao lado.\n");
        p.push_str("- Se, depois de olhar, não houver nada a acrescentar nem a corrigir, não escreva nada e responda apenas \"nada novo\".\n");
    }
    p.push_str("- Nunca rode git, nunca salve versão, nunca envie nada para revisão nem para fora: isso é ato da pessoa.\n");
    p
}

// ---------------------------------------------------------------------------
// project policy (.loro/settings.json)
// ---------------------------------------------------------------------------

/// Defaults a NEW loop is born with, and how many cycles may run at once — the
/// only loop settings that are the project's rather than one loop's (§4.11).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoopPolicy {
    pub max_arquivos: u32,
    pub max_ciclos_dia: u32,
    pub expira_dias: u32,
    pub paralelo: u32,
    /// WHAT EVERY CYCLE OF EVERY LOOP MAY USE beyond reading and editing the project:
    /// exact agent tool names (`WebFetch`) or a whole MCP server (`mcp__slack__*`).
    ///
    /// IT LIVES IN THE PROJECT, not on the loop (§4.18). The set of tools is unbounded
    /// and cannot be enumerated in advance — a person cannot declare what they have not
    /// been asked for — so a grant is given when a cycle ASKS, and once given it holds
    /// for the next cycles: «uma vez dado, o usuário concedeu». It applies to cycles
    /// ONLY: the Chat has its own control, and a grant made for unattended work must
    /// not quietly widen what the person's own conversation may do.
    ///
    /// A pacote cannot write here: install destinations are built by Loro
    /// (`.claude/commands/…`, `loops/…`, `contexts/…`), so `.loro/settings.json` is
    /// unreachable from a package by construction — which is what keeps §8.1's promise
    /// («arming is the person's act») true of granting too.
    #[serde(default)]
    pub permite: Vec<String>,
    /// «Não, e não pergunte mais»: passed as `--disallowedTools`, so the cycle does not
    /// spend steps on a door the person already closed, and the request stops coming
    /// back. Without it, refusing a request would only mean «ask me again next cycle».
    #[serde(default)]
    pub recusa: Vec<String>,
}

impl Default for LoopPolicy {
    fn default() -> Self {
        Self {
            max_arquivos: 3,
            max_ciclos_dia: 8,
            expira_dias: 30,
            paralelo: 1,
            permite: Vec::new(),
            recusa: Vec::new(),
        }
    }
}

pub fn policy_of(settings: &AcervoSettings) -> LoopPolicy {
    settings.loops.clone().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// running cycles
// ---------------------------------------------------------------------------

struct Active {
    child: Option<Child>,
    turn: u64,
    started_ms: i64,
}

#[derive(Default)]
struct RunState {
    active: HashMap<String, Active>,
    queue: Vec<String>,
    turn: u64,
}

static RUN: Mutex<Option<RunState>> = Mutex::new(None);

fn with_run<T>(f: impl FnOnce(&mut RunState) -> T) -> T {
    let mut g = RUN.lock().expect("loop run state poisoned");
    f(g.get_or_insert_with(RunState::default))
}

/// Reap finished children so `running` never reports a cycle that already ended.
fn sweep() {
    with_run(|st| {
        let mut done: Vec<String> = Vec::new();
        for (slug, a) in st.active.iter_mut() {
            let finished = match a.child.as_mut() {
                Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                None => true,
            };
            if finished {
                done.push(slug.clone());
            }
        }
        for s in done {
            st.active.remove(&s);
        }
    })
}

pub fn running_slugs() -> Vec<String> {
    sweep();
    let mut v = with_run(|st| st.active.keys().cloned().collect::<Vec<_>>());
    v.sort();
    v
}

/// A running cycle and when it started — what lets the panel say «rodando · 2m40s»
/// after a window reload, instead of a spinner with no age (§3.9, distance 3).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunningCycle {
    pub slug: String,
    pub started_ms: i64,
}

pub fn running_cycles() -> Vec<RunningCycle> {
    sweep();
    let mut v = with_run(|st| {
        st.active
            .iter()
            .map(|(slug, a)| RunningCycle {
                slug: slug.clone(),
                started_ms: a.started_ms,
            })
            .collect::<Vec<_>>()
    });
    v.sort_by(|a, b| a.slug.cmp(&b.slug));
    v
}

// ---------------------------------------------------------------------------
// the lock: two app PROCESSES, one acervo (§3.10 A4)
// ---------------------------------------------------------------------------

/// A lock older than this is treated as gone. The holder REFRESHES it while its
/// cycle runs (once a minute at most), so the window can be short: an app killed
/// mid-cycle used to block its own loop for half an hour, and the person had no
/// way to tell that from another window really holding it.
pub const LOCK_TTL_MS: i64 = 3 * 60 * 1000;
/// How often the holder re-stamps the lock while the cycle runs.
pub const LOCK_BEAT_MS: i64 = 60 * 1000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct CycleLock {
    pid: u32,
    started_ms: i64,
}

fn lock_path(base: &Path, slug: &str) -> PathBuf {
    base.join(".loro/loops").join(format!("{slug}.lock"))
}

/// Whether ANOTHER live app process is running this loop right now. Two windows of
/// the same app share a process and are already serialized in memory; two app
/// processes over one acervo are what this catches.
pub fn locked_elsewhere(base: &Path, slug: &str, now_ms: i64) -> bool {
    let Ok(txt) = std::fs::read_to_string(lock_path(base, slug)) else {
        return false;
    };
    let Ok(l) = serde_json::from_str::<CycleLock>(&txt) else {
        return false;
    };
    l.pid != std::process::id() && now_ms.saturating_sub(l.started_ms) < LOCK_TTL_MS
}

fn take_lock(base: &Path, slug: &str, now_ms: i64) {
    let p = lock_path(base, slug);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let l = CycleLock {
        pid: std::process::id(),
        started_ms: now_ms,
    };
    if let Ok(txt) = serde_json::to_string(&l) {
        let _ = std::fs::write(&p, txt);
    }
}

fn drop_lock(base: &Path, slug: &str) {
    let _ = std::fs::remove_file(lock_path(base, slug));
}

/// Re-stamp our own lock. Called from the cycle's reader thread, at most once per
/// `LOCK_BEAT_MS` — the TTL is what makes a crash recoverable, and a heartbeat is
/// what makes a long, healthy cycle survive a short TTL.
fn beat_lock(base: &Path, slug: &str, now_ms: i64, last: &mut i64) {
    if now_ms - *last < LOCK_BEAT_MS {
        return;
    }
    *last = now_ms;
    take_lock(base, slug, now_ms);
}

pub fn queued_slugs() -> Vec<String> {
    with_run(|st| st.queue.clone())
}

// ---------------------------------------------------------------------------
// IPC — views
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoopView {
    #[serde(flatten)]
    pub def: LoopDef,
    pub rel: String,
    pub dest: String,
    pub scope: String,
    pub state: String,
    pub blocked: Option<String>,
    pub missed: u32,
    pub runtime: LoopRuntime,
}

/// A cycle asked for a tool it did not have, and that question is WAITING. It is the
/// project's question, not the loop's — the loop is only where it came up (§4.18).
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoopRequest {
    /// The tool as the agent named it — what a decision is about.
    pub tool: String,
    /// The loops that ran into it, so the person knows what it is for.
    pub loops: Vec<String>,
    /// When it was asked, from the cycle's own record (0 when unknown).
    pub at_ms: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoopsStatus {
    pub loops: Vec<LoopView>,
    pub running: Vec<String>,
    pub cycles: Vec<RunningCycle>,
    pub queued: Vec<String>,
    /// The person is using the agent, so a due cycle waits (§4.10).
    pub agent_busy: bool,
    pub paralelo: u32,
    /// What a cycle asked for and nobody has answered yet (§4.18). One entry per TOOL,
    /// because one answer settles it for every loop that asked.
    pub requests: Vec<LoopRequest>,
    /// What every cycle of this project may use, and what was refused for good.
    pub permite: Vec<String>,
    pub recusa: Vec<String>,
}

/// The pending questions, folded by tool. Pure over the views, so the panel and the
/// loop's screen cannot disagree about what is waiting.
pub fn requests_of(loops: &[LoopView]) -> Vec<LoopRequest> {
    let mut out: Vec<LoopRequest> = Vec::new();
    for v in loops {
        let Some(tool) = v
            .runtime
            .needs_person
            .strip_prefix("err.loop_permission_refused:")
            .map(safe_tool_name)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        // quando o pedido veio (o ciclo mais recente que o registrou)
        let at = v
            .runtime
            .cycles
            .iter()
            .find(|c| c.err == v.runtime.needs_person)
            .map(|c| c.started_ms)
            .unwrap_or_default();
        match out.iter_mut().find(|r| r.tool == tool) {
            Some(r) => {
                if !r.loops.contains(&v.def.slug) {
                    r.loops.push(v.def.slug.clone());
                }
                r.at_ms = r.at_ms.max(at);
            }
            None => out.push(LoopRequest {
                tool,
                loops: vec![v.def.slug.clone()],
                at_ms: at,
            }),
        }
    }
    out.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then(a.tool.cmp(&b.tool)));
    out
}

/// Why this loop cannot run right now, as a stable code. Armed and able-to-run
/// are different facts (§3.9).
fn blocked_reason(base: &Path, def: &LoopDef, now: &Now) -> Option<String> {
    if crate::active_agent().trim().is_empty() {
        return Some("err.loop_no_agent".into());
    }
    if locked_elsewhere(base, &def.slug, now.epoch_ms) {
        return Some("err.loop_locked".into());
    }
    let rt = read_runtime(base, &def.slug);
    // §3.10 C4/E1 — o que espera uma decisão de pessoa é IMPEDIMENTO, não falha
    if !rt.needs_person.is_empty() {
        return Some(rt.needs_person.clone());
    }
    // §3.9 — «um teto de escrita foi atingido» é uma das razões que a ADR lista.
    // Sem esta linha o loop lia «ligado · próxima execução em 30 min» pelo resto
    // do dia, e a próxima execução não ia acontecer.
    if let Some(code) = ceiling_hit(def, &rt, now, 0) {
        return Some(code.into());
    }
    let skill = def.habilidade.trim().trim_start_matches('/');
    if !skill.is_empty() {
        let p = base.join(".claude/commands").join(format!("{skill}.md"));
        if !p.is_file() {
            return Some(format!("err.loop_skill_missing:{skill}"));
        }
    }
    // §4.15 — um escopo APONTADO que não existe é impedimento, não falha: o ciclo
    // não tem o que ler, e gastar a IA cinco vezes para descobrir isso desligaria
    // um loop que não está quebrado.
    if let Some(rel) = pointed_scope(def) {
        if rel.is_empty() {
            return Some("err.loop_scope_invalid".into());
        }
        if !base.join(&rel).is_dir() {
            return Some(format!("err.loop_scope_missing:{rel}"));
        }
    }
    for spec in [def.escopo.as_str(), def.destino.as_str()] {
        if let Some(idea) = spec.strip_prefix(DEST_IDEA_PREFIX) {
            let slug = slugify(idea);
            if !slug.is_empty() && !base.join("brainstorming").join(&slug).is_dir() {
                return Some(format!("err.loop_target_missing:{slug}"));
            }
        }
    }
    None
}

fn view_of(
    base: &Path,
    def: LoopDef,
    now: &Now,
    running: &[String],
    queued: &[String],
) -> LoopView {
    let rt = read_runtime(base, &def.slug);
    let blocked = if def.ligado {
        blocked_reason(base, &def, now)
    } else {
        None
    };
    let ctx = StateCtx {
        running: running.contains(&def.slug),
        queued: queued.contains(&def.slug),
        blocked: blocked.clone(),
    };
    let state = state_of(&def, &rt, now, &ctx).to_string();
    LoopView {
        rel: def_rel(&def.slug),
        dest: dest_rel(&def),
        scope: read_scope(&def),
        missed: missed_count(&def, &rt, now),
        state,
        blocked,
        runtime: rt,
        def,
    }
}

/// THE authority (§3.9): the row, the header mark, the panel and the loop's own
/// screen all read this one answer, so they cannot disagree.
#[tauri::command]
pub async fn loop_status(now: Now) -> Result<LoopsStatus, String> {
    let base = base()?;
    let running = running_slugs();
    let queued = queued_slugs();
    let settings = crate::config::read_acervo_settings(&base);
    let loops: Vec<LoopView> = list_defs(&base)
        .into_iter()
        .map(|d| view_of(&base, d, &now, &running, &queued))
        .collect();
    let policy = policy_of(&settings);
    Ok(LoopsStatus {
        requests: requests_of(&loops),
        permite: clean_tools(&policy.permite),
        recusa: clean_tools(&policy.recusa),
        loops,
        cycles: running_cycles(),
        running,
        queued,
        agent_busy: crate::chat::agent_busy(),
        paralelo: policy.paralelo.max(1),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSaveInput {
    #[serde(default)]
    pub slug: String,
    pub titulo: String,
    #[serde(default)]
    pub habilidade: String,
    #[serde(default)]
    pub instrucao: String,
    pub ritmo: String,
    #[serde(default)]
    pub escopo: String,
    #[serde(default)]
    pub destino: String,
    #[serde(default)]
    pub modelo: String,
    #[serde(default)]
    pub esforco: String,
    #[serde(default)]
    pub ligado: bool,
    #[serde(default)]
    pub expira: String,
    #[serde(default)]
    pub max_arquivos: u32,
    #[serde(default)]
    pub max_ciclos_dia: u32,
    /// Today, in the person's own calendar (the backend keeps no clock of its own).
    #[serde(default)]
    pub hoje: String,
}

/// The scope as it is written down, or a refusal. A shape nobody recognizes is
/// REFUSED instead of falling back to `projeto`: silently widening a scope from one
/// folder to the whole project is the one mistake this field must not make.
fn clean_scope(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() || s == SCOPE_PROJECT {
        return Ok(SCOPE_PROJECT.into());
    }
    if let Some(rel) = s.strip_prefix(SCOPE_FOLDER_PREFIX) {
        let rel = scope_folder(rel);
        if rel.is_empty() {
            return Err("err.loop_scope_invalid".into());
        }
        return Ok(format!("{SCOPE_FOLDER_PREFIX}{rel}"));
    }
    for (prefix, slug) in [
        (
            SCOPE_KNOWLEDGE_PREFIX,
            s.strip_prefix(SCOPE_KNOWLEDGE_PREFIX),
        ),
        (DEST_IDEA_PREFIX, s.strip_prefix(DEST_IDEA_PREFIX)),
    ] {
        if let Some(raw) = slug {
            let slug = slugify(raw);
            if slug.is_empty() {
                return Err("err.loop_scope_invalid".into());
            }
            return Ok(format!("{prefix}{slug}"));
        }
    }
    Err("err.loop_scope_invalid".into())
}

/// Create or update a loop. The scope is declared once, at creation, and an
/// update never moves it — re-pointing is another loop (§4.8). The model and the
/// effort are NOT frozen that way: they are how much the cycle costs, not what the
/// instruction assumes, so the edit reopens them (§4.16).
#[tauri::command]
pub async fn loop_save(input: LoopSaveInput) -> Result<String, String> {
    let base = base()?;
    if parse_rhythm(&input.ritmo).is_none() {
        return Err("err.loop_rhythm_invalid".into());
    }
    if input.instrucao.trim().is_empty() && input.habilidade.trim().is_empty() {
        return Err("err.loop_instruction_required".into());
    }
    let editing = !input.slug.is_empty();
    let slug = if editing {
        slugify(&input.slug)
    } else {
        slugify(&input.titulo)
    };
    if slug.is_empty() {
        return Err("err.loop_name_invalid".into());
    }
    let previous = editing.then(|| read_def(&base, &slug).ok()).flatten();
    if !editing && def_path(&base, &slug).exists() {
        return Err(format!("err.loop_exists:{slug}"));
    }
    let def = LoopDef {
        slug: slug.clone(),
        titulo: if input.titulo.trim().is_empty() {
            slug.clone()
        } else {
            input.titulo.trim().to_string()
        },
        habilidade: input.habilidade.trim().to_string(),
        instrucao: input.instrucao.trim().to_string(),
        ritmo: input.ritmo.trim().to_string(),
        // the scope of an existing loop is not re-openable (§4.8)
        escopo: match previous
            .as_ref()
            .map(|p| p.escopo.clone())
            .filter(|s| !s.is_empty())
        {
            Some(kept) => kept,
            None => clean_scope(&input.escopo)?,
        },
        destino: if input.destino.trim().is_empty() {
            DEST_FOLDER.into()
        } else {
            input.destino.trim().to_string()
        },
        modelo: safe_cli_value(&input.modelo),
        esforco: safe_cli_value(&input.esforco),
        ligado: input.ligado,
        criado: previous
            .as_ref()
            .map(|p| p.criado.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| input.hoje.clone()),
        expira: input.expira.trim().to_string(),
        max_arquivos: input.max_arquivos,
        max_ciclos_dia: input.max_ciclos_dia,
    };
    let rel = write_def(&base, &def)?;
    info!(slug = %def.slug, armed = def.ligado, "loop saved");
    Ok(rel)
}

/// Decide about ONE tool, for every cycle of this project (§4.18).
///
/// `permitir` grants it, `recusar` closes the door and stops the request coming back,
/// `esquecer` takes the decision away so the next cycle asks again. A person answers
/// the question that was actually asked, by name — never «liberar tudo e repetir»,
/// which is what the chat offers someone who is WATCHING. Nobody watches a cycle.
///
/// ONE DECISION CLEARS THE QUESTION ON EVERY LOOP THAT ASKED IT: the pending question
/// is «may a cycle use X», not «may THIS loop use X», so answering it once is what the
/// person meant — «uma vez dado, o usuário concedeu».
///
/// It does NOT run a cycle: deciding and running are two decisions.
#[tauri::command]
pub async fn loop_permit(tool: String, decision: String) -> Result<LoopPolicy, String> {
    let base = base()?;
    let tool = safe_tool_name(&tool);
    if tool.is_empty() {
        return Err("err.loop_tool_invalid".into());
    }
    let mut settings = crate::config::read_acervo_settings(&base);
    let mut policy = policy_of(&settings);
    policy.permite.retain(|t| t != &tool);
    policy.recusa.retain(|t| t != &tool);
    match decision.trim() {
        "permitir" => policy.permite.push(tool.clone()),
        "recusar" => policy.recusa.push(tool.clone()),
        "esquecer" => {}
        _ => return Err("err.loop_tool_invalid".into()),
    }
    policy.permite = clean_tools(&policy.permite);
    policy.recusa = clean_tools(&policy.recusa);
    settings.loops = Some(policy.clone());
    crate::config::write_acervo_settings_full(&base, &settings)?;
    // a pergunta pendente era ESTA, em qualquer loop que a tenha feito
    for def in list_defs(&base) {
        let mut rt = read_runtime(&base, &def.slug);
        if rt.needs_person == format!("err.loop_permission_refused:{tool}") {
            rt.needs_person = String::new();
            rt.fail_streak = 0;
            rt.next_attempt_ms = 0;
            let _ = write_runtime(&base, &rt);
        }
    }
    info!(tool = %tool, decision = %decision.trim(), "loop tool decided");
    Ok(policy)
}

#[tauri::command]
pub async fn loop_arm(slug: String, on: bool) -> Result<(), String> {
    let base = base()?;
    let mut def = read_def(&base, &slug)?;
    def.ligado = on;
    write_def(&base, &def)?;
    if !on {
        // desligar sai da fila na hora: um loop desligado esperando a vez é um
        // controle que reporta um estado que ele não cumpre
        with_run(|st| st.queue.retain(|s| s != &slug));
    }
    // ligar é a pessoa decidindo tentar de novo: o recuo e a pendência de
    // permissão saem com a decisão dela
    if on {
        let mut rt = read_runtime(&base, &slug);
        rt.fail_streak = 0;
        rt.next_attempt_ms = 0;
        rt.needs_person = String::new();
        let _ = write_runtime(&base, &rt);
    }
    info!(slug = %slug, armed = on, "loop armed");
    Ok(())
}

/// An adjustment made by talking to the loop. It becomes a DATED line inside the
/// instruction — the loop stays one readable document instead of a pile of
/// diffs — and it takes effect on the NEXT cycle (§3.10 F1).
#[tauri::command]
pub async fn loop_enrich(slug: String, texto: String, hoje: String) -> Result<String, String> {
    let base = base()?;
    let texto = texto.trim();
    if texto.is_empty() {
        return Err("err.loop_instruction_required".into());
    }
    let mut def = read_def(&base, &slug)?;
    let stamp = if hoje.trim().is_empty() {
        String::new()
    } else {
        format!("a partir de {}: ", hoje.trim())
    };
    if !def.instrucao.is_empty() {
        def.instrucao.push_str("\n\n");
    }
    def.instrucao.push_str(&stamp);
    def.instrucao.push_str(texto);
    write_def(&base, &def)?;
    Ok(def.instrucao)
}

#[tauri::command]
pub async fn loop_delete(slug: String) -> Result<(), String> {
    let base = base()?;
    let slug = slugify(&slug);
    if slug.is_empty() {
        return Err("err.loop_name_invalid".into());
    }
    if running_slugs().contains(&slug) {
        return Err("err.loop_running".into());
    }
    let p = def_path(&base, &slug);
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    // the runtime record goes with it; what the loop PRODUCED stays (§3.10 F4)
    let _ = std::fs::remove_file(runtime_path(&base, &slug));
    info!(slug = %slug, "loop deleted");
    Ok(())
}

/// Parar o ciclo de um loop, de dentro do processo. `plugins::remove` chama isto
/// antes de apagar a definição: §3.10 F3 pede que um ciclo em curso seja
/// CANCELADO, nunca orfanado — sem isto a thread do ciclo terminava, lia o
/// runtime que já não existia e o recriava, deixando um registro de um loop que
/// não existe mais.
pub(crate) fn stop_cycle(base: &Path, slug: &str) {
    let child = with_run(|st| {
        st.turn += 1;
        st.queue.retain(|s| s != slug);
        st.active.get_mut(slug).and_then(|a| a.child.take())
    });
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    sweep();
    drop_lock(base, slug);
}

/// Está rodando um ciclo deste loop agora?
pub(crate) fn is_running(slug: &str) -> bool {
    running_slugs().iter().any(|s| s == slug)
}

/// Apagar o registro de execução de um loop (quando a definição dele sai).
pub(crate) fn forget_runtime(base: &Path, slug: &str) {
    let _ = std::fs::remove_file(runtime_path(base, slug));
    drop_lock(base, slug);
}

#[tauri::command]
pub async fn loop_stop(slug: String) -> Result<(), String> {
    let child = with_run(|st| {
        st.turn += 1;
        st.queue.retain(|s| s != &slug);
        st.active.get_mut(&slug).and_then(|a| a.child.take())
    });
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    sweep();
    if let Ok(base) = base() {
        drop_lock(&base, &slug);
    }
    info!(slug = %slug, "loop cycle stopped");
    Ok(())
}

// ---------------------------------------------------------------------------
// the tick: the open app's clock asks, this decides
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub started: Vec<String>,
    pub queued: Vec<String>,
    /// Loops whose turn came but were skipped, with the reason, so a skipped
    /// tick is never silence (§3.10 A1).
    pub skipped: Vec<String>,
}

#[tauri::command]
pub async fn loop_tick(now: Now) -> Result<TickReport, String> {
    let base = base()?;
    let mut report = TickReport::default();
    let settings = crate::config::read_acervo_settings(&base);
    let paralelo = policy_of(&settings).paralelo.max(1) as usize;
    for def in list_defs(&base) {
        let mut rt = read_runtime(&base, &def.slug);
        if expired(&def, &now) && def.ligado {
            // one last run already happened; the loop turns itself off and says so
            let mut off = def.clone();
            off.ligado = false;
            let _ = write_def(&base, &off);
            rt.last_outcome = "expired".into();
            // o fim de vida é um ciclo no histórico, não um silêncio
            rt.cycles.insert(
                0,
                LoopCycle {
                    started_ms: now.epoch_ms,
                    ended_ms: now.epoch_ms,
                    started_date: now.date.clone(),
                    outcome: "expired".into(),
                    err: "err.loop_expired".into(),
                    ..Default::default()
                },
            );
            rt.cycles.truncate(HISTORY_CAP);
            let _ = write_runtime(&base, &rt);
            report
                .skipped
                .push(format!("{}:err.loop_expired", def.slug));
            continue;
        }
        if !due(&def, &rt, &now) {
            continue;
        }
        if running_slugs().contains(&def.slug) {
            // a cycle of THIS loop is still going: the tick is skipped, recorded,
            // and never doubled (§3.10 A1)
            record_skip(&base, &mut rt, &now, "err.loop_overlap");
            report
                .skipped
                .push(format!("{}:err.loop_overlap", def.slug));
            continue;
        }
        if let Some(code) = blocked_reason(&base, &def, &now) {
            report.skipped.push(format!("{}:{code}", def.slug));
            continue;
        }
        if crate::chat::agent_busy() || running_slugs().len() + report.started.len() >= paralelo {
            with_run(|st| {
                if !st.queue.contains(&def.slug) {
                    st.queue.push(def.slug.clone());
                }
            });
            report.queued.push(def.slug.clone());
            continue;
        }
        report.started.push(def.slug.clone());
    }
    // the queue drains in arrival order, one per tick per free slot
    let ready: Vec<String> = with_run(|st| {
        let free = paralelo
            .saturating_sub(st.active.len())
            .saturating_sub(report.started.len());
        if free == 0 || crate::chat::agent_busy() {
            return Vec::new();
        }
        let take: Vec<String> = st.queue.iter().take(free).cloned().collect();
        st.queue.retain(|s| !take.contains(s));
        take
    });
    for slug in ready {
        // A fila é RE-CONFERIDA antes de drenar: entre entrar nela e chegar a sua
        // vez, a pessoa pode ter desligado o loop, apagado a ideia dele ou o prazo
        // pode ter vencido. Sem esta leitura, esperar na fila era um jeito de
        // rodar um loop que a pessoa já havia desligado.
        let Ok(def) = read_def(&base, &slug) else {
            continue;
        };
        if !queue_still_valid(&def, &now) {
            report.skipped.push(format!("{slug}:err.loop_off"));
            continue;
        }
        if !report.started.contains(&slug) {
            report.started.push(slug);
        }
    }
    Ok(report)
}

fn record_skip(base: &Path, rt: &mut LoopRuntime, now: &Now, err: &str) {
    rt.cycles.insert(
        0,
        LoopCycle {
            started_ms: now.epoch_ms,
            ended_ms: now.epoch_ms,
            started_date: now.date.clone(),
            outcome: "skipped".into(),
            err: err.to_string(),
            ..Default::default()
        },
    );
    rt.cycles.truncate(HISTORY_CAP);
    rt.last_outcome = "skipped".into();
    let _ = write_runtime(base, rt);
}

// ---------------------------------------------------------------------------
// the cycle
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CycleEvent {
    slug: String,
    /// `started` | `ended`
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    err: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    started_ms: i64,
}

/// Run one cycle now. The clock calls it for a due loop; the person calls it from
/// «rodar agora». Either way it is ONE agent turn, in the acervo, with
/// `acceptEdits` — never `bypassPermissions`, which is refused for an unattended
/// cycle (§4.9).
#[tauri::command]
pub async fn loop_run_now(app: AppHandle, slug: String, now: Now) -> Result<(), String> {
    let base = base()?;
    let def = read_def(&base, &slug)?;
    start_cycle(&app, &base, &def, &now)
}

fn start_cycle(app: &AppHandle, base: &Path, def: &LoopDef, now: &Now) -> Result<(), String> {
    if crate::chat::agent_busy() {
        return Err("err.loop_agent_busy".into());
    }
    // O TETO DE PARALELISMO É DECIDIDO AQUI, não no tique: o tique só devolve quem
    // está na hora, e quem dispara é a tela, um por chamada. Lido só lá, dois loops
    // vencidos no mesmo minuto abriam dois processos do agente com «um por vez»
    // configurado.
    let paralelo = policy_of(&crate::config::read_acervo_settings(base))
        .paralelo
        .max(1) as usize;
    // A VAGA É RESERVADA SOB A TRAVA, antes de qualquer trabalho: entre conferir
    // "estou rodando?" e inserir a entrada havia leitura de settings, snapshot do
    // destino e um spawn — dois «rodar agora» no mesmo instante passavam os dois
    // pelo teste. Quem reserva é quem devolve a vaga se algo falhar.
    let reserved = with_run(|st| {
        if st.active.contains_key(&def.slug) {
            return Err("err.loop_running".to_string());
        }
        if st.active.len() >= paralelo {
            return Err("err.loop_parallel_full".to_string());
        }
        st.turn += 1;
        st.active.insert(
            def.slug.clone(),
            Active {
                child: None,
                turn: st.turn,
                started_ms: now.epoch_ms,
            },
        );
        Ok(st.turn)
    });
    let my_turn = reserved?;
    // qualquer recusa a partir daqui devolve a vaga reservada
    let release = |code: String| -> String {
        with_run(|st| {
            if st.active.get(&def.slug).map(|a| a.turn) == Some(my_turn) {
                st.active.remove(&def.slug);
            }
        });
        code
    };
    if let Some(code) = blocked_reason(base, def, now) {
        return Err(release(code));
    }
    let rt = read_runtime(base, &def.slug);
    if let Some(code) = ceiling_hit(def, &rt, now, 0) {
        return Err(release(code.into()));
    }
    let agent = crate::active_agent();
    if agent.trim().is_empty() {
        return Err(release("err.loop_no_agent".into()));
    }
    let dir = {
        let cfg = read_loro_config();
        match active_acervo(&cfg).map(|a| a.dir.clone()) {
            Some(d) => d,
            None => return Err(release("err.acervo_not_configured".into())),
        }
    };
    let lang = crate::config::active_acervo_lang();
    // §4.18 — o que os ciclos podem usar é do PROJETO, e é lido aqui, agora: a pessoa
    // pode ter concedido entre o tique e este ciclo.
    let policy = policy_of(&crate::config::read_acervo_settings(base));
    let allowed = clean_tools(&policy.permite);
    let recent = recent_output(&read_runtime(base, &def.slug), 3);
    let prompt = cycle_prompt(def, &lang, &allowed, &recent);
    let dest = dest_rel(def);
    // the destination has to exist before the agent is asked to write in it
    let _ = std::fs::create_dir_all(base.join(&dest));
    let before = snapshot(base, def);

    let mut parts = agent.split_whitespace();
    let bin = parts.next().unwrap_or("claude").to_string();
    let base_args: Vec<String> = parts.map(str::to_string).collect();
    let claude = crate::chat::agent_is_claude(&agent);

    let mut cmd = crate::proc::command(&bin);
    cmd.current_dir(&dir);
    cmd.args(&base_args);
    if claude {
        // an unattended cycle never gets "bypassPermissions" (§4.9). The model and
        // the effort are the loop's own (§4.16), re-checked HERE and not only on
        // save: the definition is a document a hand or a pacote can rewrite.
        cmd.args(crate::chat::claude_args(
            &safe_cli_value(&def.modelo),
            &safe_cli_value(&def.esforco),
            "acceptEdits",
            None,
        ));
        // §4.18 — o que a pessoa concedeu, o que ela recusou, e o que nunca é de um
        // ciclo. Uma função pura, porque isto é o limite do que um trabalho sem ninguém
        // olhando alcança — e ele merece teste, não um comentário.
        cmd.args(cycle_tool_flags(&policy.permite, &policy.recusa));
        cmd.stdin(Stdio::piped());
    } else {
        cmd.arg(&prompt);
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(release(format!("err.agent_spawn:{e}"))),
    };
    if claude {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
            drop(stdin);
        }
    }
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err(release("err.agent_spawn".into()));
    };
    // stderr is drained in its own thread: a full pipe buffer deadlocks the child
    // for good (the lesson chat.rs paid for).
    if let Some(e) = child.stderr.take() {
        std::thread::spawn(
            move || {
                for _ in BufReader::new(e).lines().map_while(Result::ok) {}
            },
        );
    }
    with_run(|st| {
        if let Some(a) = st.active.get_mut(&def.slug) {
            if a.turn == my_turn {
                a.child = Some(child);
            }
        }
    });
    // A EXECUÇÃO É MARCADA AGORA, não no fim. Sem isto `due()` continuava
    // verdadeiro durante todo o ciclo e cada tique de 30s gravava mais um
    // "pulado" — o histórico de um ciclo de quatro minutos ganhava oito linhas
    // que não eram ciclos.
    {
        let mut rt = read_runtime(base, &def.slug);
        rt.last_run_ms = now.epoch_ms;
        rt.last_run_date = now.date.clone();
        rt.last_outcome = "running".into();
        rt.missed = 0;
        if rt.runs_date == now.date {
            rt.runs_today = rt.runs_today.saturating_add(1);
        } else {
            rt.runs_date = now.date.clone();
            rt.runs_today = 1;
        }
        let _ = write_runtime(base, &rt);
    }
    take_lock(base, &def.slug, now.epoch_ms);
    let _ = app.emit(
        "loop-cycle",
        CycleEvent {
            slug: def.slug.clone(),
            phase: "started".into(),
            outcome: None,
            err: None,
            files: Vec::new(),
            started_ms: now.epoch_ms,
        },
    );
    info!(slug = %def.slug, "loop cycle started");

    let app2 = app.clone();
    let base2 = base.to_path_buf();
    let def2 = def.clone();
    let now2 = now.clone();
    std::thread::spawn(move || {
        let mut done = crate::chat::StreamOutcome::default();
        let mut steps = 0u32;
        let mut brake: Option<&'static str> = None;
        let mut beat = now2.epoch_ms;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // o relógio do sistema entra aqui e só aqui: para dizer "ainda estou
            // vivo". Nenhuma DECISÃO usa este tempo (elas usam o `Now` da pessoa).
            let elapsed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(now2.epoch_ms);
            beat_lock(&base2, &def2.slug, elapsed, &mut beat);
            if claude {
                if crate::chat::handle_stream_line(
                    &app2,
                    &line,
                    &mut done,
                    "loop",
                    Some(&def2.slug),
                )
                .is_some()
                {
                    // a session id is of no use to a cycle: each one is its own turn
                }
                // Um passo é contado UMA vez: `--include-partial-messages` faz o
                // mesmo tool_use aparecer no delta e na mensagem do agente, e um
                // `contains` cru dobrava a conta que a tela mostra.
                steps = steps.saturating_add(tool_uses_in(&line));
                // O freio é conferido DURANTE o ciclo (§3.10 D2) — mas não a cada
                // linha do stream: eram dezenas de leituras de diretório por
                // segundo. Ele é conferido quando um passo TERMINA, que é quando um
                // arquivo pode ter nascido.
                if brake.is_none() && def2.max_arquivos > 0 && line.contains("tool_result") {
                    let made = changed_since(&before, &snapshot(&base2, &def2), now2.epoch_ms).len()
                        as u32;
                    if made > def2.max_arquivos {
                        brake = Some("err.loop_ceiling_files");
                        let child = with_run(|st| {
                            st.active.get_mut(&def2.slug).and_then(|a| a.child.take())
                        });
                        if let Some(mut c) = child {
                            let _ = c.kill();
                            let _ = c.wait();
                        }
                    }
                }
            }
        }
        let mine = with_run(|st| match st.active.get_mut(&def2.slug) {
            Some(a) if a.turn == my_turn => a.child.take(),
            _ => None,
        });
        // Ninguém para colher = o ciclo foi PARADO (ou substituído). Sem esta
        // distinção o registro dizia «nada novo» de um ciclo que a pessoa
        // interrompeu — a tela afirmando um resultado que não houve.
        let cancelled = mine.is_none();
        let code = match mine.map(|mut c| c.wait()) {
            Some(Ok(s)) => s.code().unwrap_or(-1),
            Some(Err(_)) => -1,
            None => 0,
        };
        with_run(|st| {
            if st.active.get(&def2.slug).map(|a| a.turn) == Some(my_turn) {
                st.active.remove(&def2.slug);
            }
        });

        drop_lock(&base2, &def2.slug);
        let after = snapshot(&base2, &def2);
        let files = changed_since(&before, &after, now2.epoch_ms);
        // §3.8.3/§3.10 E1 — UM LOOP NÃO É UM ESCRITOR PRIVILEGIADO. O que ele
        // escreveu passa pela mesma triagem de qualquer coisa que entra: uma
        // credencial no material de um ciclo iria para o commit exatamente como
        // uma colada à mão (BR-9), e o destino «conhecimento» é a árvore versionada.
        // O arquivo NÃO é apagado — é trabalho do agente, e apagá-lo em silêncio
        // seria pior do que dizer. O ciclo termina impedido, o estado fica âmbar e
        // a razão nomeia o arquivo. O achado nunca viaja (BR-8).
        let intake_block = intake_block_of(&base2, &files).unwrap_or_default();
        let ended_ms = now2.epoch_ms + 1; // the record's own ordering, not a clock
                                          // A POLÍTICA MORA EM `cycle_outcome`, que é pura e tem teste: a ordem dos ramos
                                          // é o que vence o quê, e ela já errou duas vezes (§14).
        let (outcome, err) = cycle_outcome(&CycleEnd {
            cancelled,
            intake_block: intake_block.clone(),
            brake: brake.map(str::to_string),
            permission: done
                .permission
                .then(|| done.permission_tool.clone().unwrap_or_default()),
            ok: done.ok,
            code,
            agent_error: done.error.clone(),
            files: files.len(),
        });

        let mut rt = read_runtime(&base2, &def2.slug);
        // a contagem do dia já foi feita quando o ciclo começou (uma execução, uma
        // contagem): somar aqui de novo gastaria o teto diário em metade dos ciclos
        rt.last_outcome = outcome.to_string();
        rt.needs_person = if outcome == "blocked" {
            err.clone()
        } else {
            String::new()
        };
        if outcome == "failed" {
            rt.fail_streak = rt.fail_streak.saturating_add(1);
            rt.next_attempt_ms =
                now2.epoch_ms + i64::from(backoff_minutes(rt.fail_streak)) * 60_000;
        } else {
            rt.fail_streak = 0;
            rt.next_attempt_ms = 0;
        }
        rt.cycles.insert(
            0,
            LoopCycle {
                started_ms: now2.epoch_ms,
                ended_ms,
                started_date: now2.date.clone(),
                outcome: outcome.to_string(),
                files: files.clone(),
                steps,
                err: err.clone(),
            },
        );
        rt.cycles.truncate(HISTORY_CAP);
        let stop = rt.fail_streak >= STOP_AFTER_FAILURES;
        let _ = write_runtime(&base2, &rt);
        if stop {
            // it keeps failing: turning itself off is the honest end, and the
            // screen says so instead of retrying forever (§3.10 C2)
            if let Ok(mut d) = read_def(&base2, &def2.slug) {
                d.ligado = false;
                let _ = write_def(&base2, &d);
            }
        }
        // BR-8: the log carries the outcome, the count and the code — never text
        info!(slug = %def2.slug, outcome, files = files.len(), steps, "loop cycle ended");
        let _ = app2.emit(
            "loop-cycle",
            CycleEvent {
                slug: def2.slug.clone(),
                phase: "ended".into(),
                outcome: Some(outcome.to_string()),
                err: (!err.is_empty()).then_some(err),
                files,
                started_ms: now2.epoch_ms,
            },
        );
    });
    Ok(())
}

/// Everything that decides how a finished cycle is RECORDED. A struct because the
/// ORDER of the branches is the policy — what beats what — and that order has been
/// wrong twice (§14).
pub struct CycleEnd {
    /// The person (or an uninstall) killed it mid-run.
    pub cancelled: bool,
    /// The intake refused what it wrote (`err.intake_secret:<file>`), or empty.
    pub intake_block: String,
    /// A brake ended it (`err.loop_ceiling_*`), or none.
    pub brake: Option<String>,
    /// A tool was refused. Carries the tool's name when the agent said which.
    pub permission: Option<String>,
    pub ok: bool,
    pub code: i32,
    /// The agent's own error code, when it gave one.
    pub agent_error: Option<String>,
    /// How many files the cycle actually touched.
    pub files: usize,
}

/// How a finished cycle is recorded: `(outcome, err)`. Pure, so the policy has a test.
///
/// THE BRANCH THAT MATTERS MOST is the permission one. A refusal in the MIDDLE of a
/// cycle does not erase the work: nine steps that wrote the file and, somewhere along
/// the way, asked for a tool the loop did not have, produced a FILE — and recording
/// «impedido» reported a cycle that did not happen, then left a pending question that
/// froze the loop until the person turned it off and on. Measured in the owner's own
/// acervo on 2026-08-18: `outcome: blocked`, `files: [insights-20260818.md]`, and an
/// insight sitting in the folder that the screen said had never been produced. When
/// files came out, the refusal is a NOTE on a cycle that worked (§4.17).
pub fn cycle_outcome(end: &CycleEnd) -> (&'static str, String) {
    if end.cancelled {
        return ("stopped", "err.loop_stopped".into());
    }
    if !end.intake_block.is_empty() {
        return ("blocked", end.intake_block.clone());
    }
    if let Some(b) = &end.brake {
        return ("stopped", b.clone());
    }
    if let Some(tool) = &end.permission {
        let code = match safe_tool_name(tool) {
            t if t.is_empty() => "err.loop_permission_refused".to_string(),
            t => format!("err.loop_permission_refused:{t}"),
        };
        // produziu algo ⇒ o ciclo aconteceu, e a permissão é uma nota, não um bloqueio
        return if end.files == 0 {
            ("blocked", code)
        } else {
            ("ok", code)
        };
    }
    if !end.ok || end.code != 0 {
        return (
            "failed",
            end.agent_error.clone().unwrap_or_else(|| {
                if end.code == 0 {
                    "err.chat_agent_failed".into()
                } else {
                    "err.loop_cycle_failed".into()
                }
            }),
        );
    }
    if end.files == 0 {
        return ("nothing", String::new());
    }
    ("ok", String::new())
}

/// One thing a loop can be allowed to use, as the screen offers it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopCapability {
    /// The exact value that goes into `permite` (`mcp__slack__*`, `WebFetch`).
    pub id: String,
    /// What to call it on screen. For a server, its own name — the person named it.
    pub label: String,
    /// `mcp` | `web`
    pub kind: String,
    /// Which pacote brought it, when one did — «de onde isto veio» is the question
    /// that matters when a loop misbehaves (the same question §5.1 asks of a
    /// habilidade). Empty for what the agent has on its own.
    pub origin: String,
}

/// WHAT THIS PROJECT CAN OFFER A LOOP — discovered, never a list of connector names
/// hard-coded in Loro (§4.17). Everything here is something the person or a pacote
/// already put in the project: an MCP server declared in `.mcp.json`, plus the
/// agent's own outward tools. A connector Loro has never heard of shows up the day
/// it is installed, with no release of Loro in between.
///
/// `Bash` is deliberately absent: arbitrary execution is the executable door of
/// §4.3, and it does not open through a checkbox on a loop.
#[tauri::command]
pub async fn loop_capabilities() -> Result<Vec<LoopCapability>, String> {
    let base = base()?;
    Ok(capabilities_of(&base))
}

fn capabilities_of(base: &Path) -> Vec<LoopCapability> {
    let mut out = vec![
        LoopCapability {
            id: "WebFetch".into(),
            label: "WebFetch".into(),
            kind: "web".into(),
            origin: String::new(),
        },
        LoopCapability {
            id: "WebSearch".into(),
            label: "WebSearch".into(),
            kind: "web".into(),
            origin: String::new(),
        },
    ];
    for (name, origin) in mcp_servers(base) {
        let id = format!("mcp__{name}__*");
        if safe_tool_name(&id).is_empty() {
            continue; // um nome de servidor que não vira ferramenta não é oferecido
        }
        out.push(LoopCapability {
            id,
            label: name,
            kind: "mcp".into(),
            origin,
        });
    }
    out
}

/// The MCP servers this project declares, each with the pacote that brought it (when
/// the install record knows). Reads `.mcp.json` — the file the ecosystem already
/// uses, which is also why `.mcp.json` inside a pacote makes it EXECUTABLE (§2):
/// Loro reads this file, it never writes it.
fn mcp_servers(base: &Path) -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(base.join(".mcp.json")) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(map) = v.get("mcpServers").and_then(|m| m.as_object()) else {
        return Vec::new();
    };
    let brought = crate::plugins::origin_of_file(base, ".mcp.json");
    let mut out: Vec<(String, String)> = map
        .keys()
        .map(|k| (k.clone(), brought.clone().unwrap_or_default()))
        .collect();
    out.sort();
    out
}

/// The folders a scope can be pointed at, acervo-relative. The field lets a person
/// TYPE a path — this is what lets them choose one instead (§4.15). Three levels
/// deep and nothing hidden: a picker that lists a thousand rows is not a picker, and
/// `.loro`/`.git` are the machine's, never a reading scope.
#[tauri::command]
pub async fn loop_folders() -> Result<Vec<String>, String> {
    let base = base()?;
    let mut out = Vec::new();
    collect_dirs(&base, "", 3, &mut out);
    out.sort();
    Ok(out)
}

fn collect_dirs(base: &Path, rel: &str, depth: u32, out: &mut Vec<String>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(base.join(rel)) else {
        return;
    };
    for e in rd.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let Some(name) = e.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let child = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        collect_dirs(base, &child, depth - 1, out);
        out.push(child);
    }
}

/// The project's loop policy, for Configurações → Loops.
#[tauri::command]
pub async fn loop_policy() -> Result<LoopPolicy, String> {
    let base = base()?;
    Ok(policy_of(&crate::config::read_acervo_settings(&base)))
}

#[tauri::command]
pub async fn loop_set_policy(policy: LoopPolicy) -> Result<LoopPolicy, String> {
    let base = base()?;
    let mut settings = crate::config::read_acervo_settings(&base);
    let clean = LoopPolicy {
        permite: clean_tools(&policy.permite),
        recusa: clean_tools(&policy.recusa),
        max_arquivos: policy.max_arquivos.clamp(1, 50),
        max_ciclos_dia: policy.max_ciclos_dia.clamp(1, 96),
        expira_dias: policy.expira_dias.clamp(1, 365),
        paralelo: policy.paralelo.clamp(1, 4),
    };
    settings.loops = Some(clean.clone());
    crate::config::write_acervo_settings_full(&base, &settings)?;
    Ok(clean)
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
        let mine = include_str!("loops.rs");
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
                "{name} has to be async: it walks the loops folder and spawns the agent; on the main thread that is a frozen window"
            );
            assert!(
                wiring.contains(&format!("{}::{name},", "loops")),
                "{name} is defined but never registered in generate_handler"
            );
            found += 1;
        }
        assert!(found >= 10, "the scanner went blind: only {found} commands");
    }

    // pasta de rascunho própria (a convenção de cada módulo de teste aqui)
    fn tmp(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "loro-loops-{tag}-{}-{}",
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

    fn now_at(date: &str, hh: u32, mi: u32, weekday: u32, epoch_ms: i64) -> Now {
        Now {
            epoch_ms,
            date: date.into(),
            hh,
            mi,
            weekday,
        }
    }

    fn weekly() -> LoopDef {
        LoopDef {
            slug: "o-que-falta".into(),
            titulo: "o que falta".into(),
            ritmo: "semana:1:14:30".into(),
            escopo: SCOPE_PROJECT.into(),
            destino: DEST_FOLDER.into(),
            ligado: true,
            max_arquivos: 3,
            max_ciclos_dia: 8,
            instrucao: "escreva o que falta decidir".into(),
            ..Default::default()
        }
    }

    #[test]
    fn rhythm_parses_the_three_shapes_and_refuses_the_rest() {
        assert_eq!(parse_rhythm("min:30"), Some(Rhythm::Every { minutes: 30 }));
        assert_eq!(
            parse_rhythm("dia:09:00"),
            Some(Rhythm::Daily { hh: 9, mi: 0 })
        );
        assert_eq!(
            parse_rhythm("semana:1:14:30"),
            Some(Rhythm::Weekly {
                dow: 1,
                hh: 14,
                mi: 30
            })
        );
        for bad in [
            "",
            "min:0",
            "min:2000",
            "dia:24:00",
            "semana:7:1:1",
            "hora:1",
            "min:x",
        ] {
            assert!(parse_rhythm(bad).is_none(), "{bad} must be refused");
        }
    }

    // §3.10 B4 — a rhythm under a day is a DURATION since the last run, so an
    // offset change (DST) cannot make it fire twice or skip.
    #[test]
    fn a_sub_daily_rhythm_counts_duration_not_wall_clock() {
        let def = LoopDef {
            ritmo: "min:30".into(),
            ligado: true,
            ..weekly()
        };
        let mut rt = LoopRuntime {
            last_run_ms: 1_000_000,
            last_run_date: "2026-10-25".into(),
            ..Default::default()
        };
        // 29 minutes later: not yet
        assert!(!due(
            &def,
            &rt,
            &now_at("2026-10-25", 1, 29, 0, 1_000_000 + 29 * 60_000)
        ));
        // 30 minutes later: due — even though the wall clock went BACKWARDS an hour
        assert!(due(
            &def,
            &rt,
            &now_at("2026-10-25", 0, 59, 0, 1_000_000 + 30 * 60_000)
        ));
        rt.last_run_ms = 0;
        assert!(
            due(&def, &rt, &now_at("2026-10-25", 0, 0, 0, 10)),
            "never run: due now"
        );
    }

    // §3.10 B3 — six hours asleep fires ONCE, not six times: the rhythm is read
    // from the wall-clock gap, never from a tick count.
    #[test]
    fn a_long_sleep_fires_one_cycle_not_one_per_missed_tick() {
        let def = LoopDef {
            ritmo: "min:30".into(),
            ..weekly()
        };
        let rt = LoopRuntime {
            last_run_ms: 1_000_000,
            last_run_date: "2026-08-17".into(),
            ..Default::default()
        };
        let six_hours = now_at("2026-08-17", 12, 0, 1, 1_000_000 + 6 * 3_600_000);
        assert!(due(&def, &rt, &six_hours));
        // and after it runs once, the next check is quiet again
        let after = LoopRuntime {
            last_run_ms: six_hours.epoch_ms,
            ..rt.clone()
        };
        assert!(!due(&def, &after, &six_hours));
    }

    #[test]
    fn a_weekly_loop_is_due_on_its_weekday_after_its_time_and_only_once() {
        let def = weekly();
        let rt = LoopRuntime::default();
        assert!(
            !due(&def, &rt, &now_at("2026-08-17", 14, 29, 1, 1)),
            "before the time"
        );
        assert!(
            due(&def, &rt, &now_at("2026-08-17", 14, 30, 1, 1)),
            "at the time"
        );
        assert!(
            !due(&def, &rt, &now_at("2026-08-18", 15, 0, 2, 1)),
            "another weekday"
        );
        let ran = LoopRuntime {
            last_run_ms: 5,
            last_run_date: "2026-08-17".into(),
            ..Default::default()
        };
        assert!(
            !due(&def, &ran, &now_at("2026-08-17", 23, 0, 1, 9)),
            "already ran today"
        );
    }

    // §3.10 B1/B2 — the app was closed for three weeks: ONE catch-up, and the
    // missed windows are counted instead of shown as a next run in the past.
    #[test]
    fn a_closed_app_gets_one_catch_up_and_the_missed_windows_are_counted() {
        let def = weekly();
        let rt = LoopRuntime {
            last_run_ms: 5,
            last_run_date: "2026-07-27".into(),
            ..Default::default()
        };
        let thursday = now_at("2026-08-20", 9, 0, 4, 100);
        assert!(missed_window(&def, &rt, &thursday), "a Monday went by");
        assert!(due(&def, &rt, &thursday), "one catch-up, on any weekday");
        assert_eq!(missed_count(&def, &rt, &thursday), 3);
        let after = LoopRuntime {
            last_run_ms: 100,
            last_run_date: "2026-08-20".into(),
            ..Default::default()
        };
        assert!(
            !due(&def, &after, &thursday),
            "and only one — never a storm"
        );
        assert_eq!(missed_count(&def, &after, &thursday), 0);
    }

    #[test]
    fn a_daily_loop_that_missed_a_day_catches_up_once() {
        let def = LoopDef {
            ritmo: "dia:09:00".into(),
            ..weekly()
        };
        let rt = LoopRuntime {
            last_run_ms: 5,
            last_run_date: "2026-08-15".into(),
            ..Default::default()
        };
        // 17th, before 09:00: the window of the 16th was missed
        let early = now_at("2026-08-17", 7, 0, 1, 50);
        assert!(due(&def, &rt, &early));
        assert_eq!(missed_count(&def, &rt, &early), 1);
    }

    #[test]
    fn brakes_stop_the_loop_and_name_themselves() {
        let def = weekly();
        let rt = LoopRuntime {
            runs_date: "2026-08-17".into(),
            runs_today: 8,
            ..Default::default()
        };
        let now = now_at("2026-08-17", 14, 30, 1, 1);
        assert_eq!(
            ceiling_hit(&def, &rt, &now, 0),
            Some("err.loop_ceiling_runs")
        );
        assert!(!due(&def, &rt, &now), "a brake is not a suggestion");
        assert_eq!(
            ceiling_hit(&def, &LoopRuntime::default(), &now, 4),
            Some("err.loop_ceiling_files")
        );
        assert_eq!(ceiling_hit(&def, &LoopRuntime::default(), &now, 3), None);
    }

    #[test]
    fn a_loop_expires_and_stops_being_due() {
        let def = LoopDef {
            expira: "2026-08-16".into(),
            ..weekly()
        };
        let now = now_at("2026-08-17", 14, 30, 1, 1);
        assert!(expired(&def, &now));
        assert!(!due(&def, &LoopRuntime::default(), &now));
        assert_eq!(
            state_of(&def, &LoopRuntime::default(), &now, &StateCtx::default()),
            "expired"
        );
    }

    // §3.9 — "armed" and "able to run" are different facts, and `blocked` is the
    // state every scheduler forgets.
    #[test]
    fn blocked_never_reads_as_armed_and_running_wins_over_off() {
        let def = weekly();
        let rt = LoopRuntime::default();
        let now = now_at("2026-08-17", 14, 30, 1, 1);
        let blocked = StateCtx {
            blocked: Some("err.loop_no_agent".into()),
            ..Default::default()
        };
        assert_eq!(state_of(&def, &rt, &now, &blocked), "blocked");
        assert_eq!(state_of(&def, &rt, &now, &StateCtx::default()), "armed");
        let running = StateCtx {
            running: true,
            ..Default::default()
        };
        let off = LoopDef {
            ligado: false,
            ..weekly()
        };
        assert_eq!(
            state_of(&off, &rt, &now, &running),
            "running",
            "a cycle that IS running is reported as running"
        );
        assert_eq!(state_of(&off, &rt, &now, &StateCtx::default()), "off");
        let failing = LoopRuntime {
            fail_streak: 2,
            ..Default::default()
        };
        assert_eq!(
            state_of(&def, &failing, &now, &StateCtx::default()),
            "failing"
        );
        let queued = StateCtx {
            queued: true,
            ..Default::default()
        };
        assert_eq!(state_of(&def, &rt, &now, &queued), "queued");
    }

    #[test]
    fn a_failing_loop_backs_off_and_the_wait_grows() {
        assert_eq!(backoff_minutes(0), 0);
        assert_eq!(backoff_minutes(1), 1);
        assert_eq!(backoff_minutes(3), 4);
        assert_eq!(backoff_minutes(6), 60);
        assert_eq!(backoff_minutes(60), 60);
        let def = weekly();
        let rt = LoopRuntime {
            fail_streak: 2,
            next_attempt_ms: 10_000,
            ..Default::default()
        };
        assert!(!due(&def, &rt, &now_at("2026-08-17", 14, 30, 1, 9_000)));
        assert!(due(&def, &rt, &now_at("2026-08-17", 14, 30, 1, 10_000)));
    }

    // §3.8.1 — o único lugar da ADR onde um descuido vira trabalho autônomo que
    // ninguém armou. A chave é reconhecida como o PARSER a reconhece.
    #[test]
    fn a_pacote_loop_never_arrives_armed_whatever_the_spelling() {
        for line in [
            "ligado: true",
            " ligado: true",
            "\tligado: true",
            "ligado : true",
        ] {
            let text = format!("---\nloop: x\n{line}\nritmo: dia:09:00\n---\n\nfaça algo\n");
            let out = disarm_markdown(&text);
            assert!(
                !from_markdown("x", &out).ligado,
                "«{line}» chegou LIGADO: {out}"
            );
        }
        // e uma linha do CORPO que começa igual não é front matter
        let body = "---\nloop: x\n---\n\nligado: true no corpo\n";
        assert!(disarm_markdown(body).contains("ligado: true no corpo"));
    }

    // §4.11 — uma definição sem freios tem os do projeto, nunca nenhum: ceiling_hit
    // e expired são guardados por `> 0`, então zero era «sem limite».
    #[test]
    fn a_definition_with_no_brakes_inherits_the_project_s() {
        let policy = LoopPolicy {
            permite: Vec::new(),
            recusa: Vec::new(),
            max_arquivos: 2,
            max_ciclos_dia: 4,
            expira_dias: 15,
            paralelo: 1,
        };
        let bare = LoopDef {
            slug: "x".into(),
            ritmo: "dia:09:00".into(),
            ..Default::default()
        };
        let def = with_brakes(bare, &policy);
        assert_eq!((def.max_arquivos, def.max_ciclos_dia), (2, 4));
        // o que a pessoa escolheu não é sobrescrito
        let mine = LoopDef {
            max_arquivos: 9,
            max_ciclos_dia: 1,
            ..def.clone()
        };
        let kept = with_brakes(mine, &policy);
        assert_eq!((kept.max_arquivos, kept.max_ciclos_dia), (9, 1));
    }

    // §3.10 C4/E1 — o que espera uma pessoa é IMPEDIMENTO, não falha: repetir
    // cinco vezes gastaria a IA numa pergunta que só a pessoa responde, e depois
    // desligaria um loop que nunca esteve quebrado.
    #[test]
    fn what_waits_for_a_person_blocks_instead_of_failing() {
        let base = tmp("needs-person");
        let def = weekly();
        let mut rt = LoopRuntime {
            slug: def.slug.clone(),
            needs_person: "err.loop_permission_refused".into(),
            ..Default::default()
        };
        write_runtime(&base, &rt).unwrap();
        let now = now_at("2026-08-17", 14, 30, 1, 1);
        assert_eq!(
            blocked_reason(&base, &def, &now).as_deref(),
            Some("err.loop_permission_refused")
        );
        // e o estado NÃO é «falhando»: fail_streak fica em zero
        assert_eq!(rt.fail_streak, 0);
        let ctx = StateCtx {
            blocked: blocked_reason(&base, &def, &now),
            ..Default::default()
        };
        assert_eq!(state_of(&def, &rt, &now, &ctx), "blocked");
        // a pessoa decide, e a pendência sai
        rt.needs_person = String::new();
        write_runtime(&base, &rt).unwrap();
        assert_eq!(blocked_reason(&base, &def, &now), None);
    }

    // §3.8.3/§3.10 E1 — um loop NÃO é escritor privilegiado: o que ele escreveu
    // passa pela mesma triagem de qualquer coisa que entra. A amostra é montada em
    // tempo de execução (ADR-0024: um literal com forma de token é recusado pela
    // própria proteção de push do GitHub).
    #[test]
    fn br9_what_a_cycle_wrote_passes_the_same_triage() {
        let base = tmp("cycle-intake");
        std::fs::create_dir_all(base.join("loops/x")).unwrap();
        std::fs::write(base.join("loops/x/limpo.md"), "uma nota comum\n").unwrap();
        assert_eq!(
            intake_block_of(&base, &["loops/x/limpo.md".to_string()]),
            None
        );
        let token = format!("{}{}", "ghp_", "B".repeat(36));
        std::fs::write(
            base.join("loops/x/vazado.md"),
            format!("o token é {token}\n"),
        )
        .unwrap();
        let hit = intake_block_of(
            &base,
            &[
                "loops/x/limpo.md".to_string(),
                "loops/x/vazado.md".to_string(),
            ],
        )
        .expect("uma credencial no material do ciclo tem de barrar");
        assert_eq!(hit, "err.intake_secret:loops/x/vazado.md");
        assert!(!hit.contains(&token), "BR-8: o achado nunca viaja");
        // e o arquivo FICA: apagar o trabalho do agente em silêncio seria pior
        assert!(base.join("loops/x/vazado.md").is_file());
    }

    // §3.9 — «um teto de escrita foi atingido» é uma das razões que a ADR lista.
    // Sem ela o loop lia «ligado · próxima execução em 30 min» pelo resto do dia.
    #[test]
    fn a_loop_that_hit_its_daily_ceiling_reads_as_impedido() {
        let base = tmp("ceiling-blocked");
        let def = weekly();
        let rt = LoopRuntime {
            slug: def.slug.clone(),
            runs_date: "2026-08-17".into(),
            runs_today: 8,
            ..Default::default()
        };
        write_runtime(&base, &rt).unwrap();
        let now = now_at("2026-08-17", 14, 30, 1, 1);
        assert_eq!(
            blocked_reason(&base, &def, &now).as_deref(),
            Some("err.loop_ceiling_runs"),
            "ligado e incapaz de rodar são fatos diferentes"
        );
    }

    // §3.10 F1/M — entre entrar na fila e chegar a vez, a pessoa pode ter
    // desligado o loop. Esperar a vez não é um jeito de rodar o que ela desligou.
    #[test]
    fn a_queued_loop_is_re_checked_before_it_drains() {
        let now = now_at("2026-08-17", 14, 30, 1, 1);
        assert!(queue_still_valid(&weekly(), &now));
        assert!(!queue_still_valid(
            &LoopDef {
                ligado: false,
                ..weekly()
            },
            &now
        ));
        assert!(!queue_still_valid(
            &LoopDef {
                expira: "2026-08-16".into(),
                ..weekly()
            },
            &now
        ));
    }

    #[test]
    fn the_definition_round_trips_through_the_document_the_person_reads() {
        let def = weekly();
        let text = to_markdown(&def);
        assert!(text.starts_with("---\nloro: 1\ntipo: loop\n"));
        assert!(text.contains("ritmo: semana:1:14:30\n"));
        // §4.16 — o modelo e o esforço são do loop, e estão no documento que a
        // pessoa lê (não numa configuração invisível)
        let escolhido = LoopDef {
            modelo: "opus".into(),
            esforco: "xhigh".into(),
            ..weekly()
        };
        let escrito = to_markdown(&escolhido);
        assert!(escrito.contains("modelo: opus\n"));
        assert!(escrito.contains("esforco: xhigh\n"));
        assert_eq!(from_markdown("o-que-falta", &escrito), escolhido);
        let back = from_markdown("o-que-falta", &text);
        assert_eq!(back, def);
        // and writing what was read is byte-identical: an untouched loop is never
        // a pending change
        assert_eq!(to_markdown(&back), text);
    }

    #[test]
    fn an_unknown_front_matter_key_is_ignored_instead_of_failing_to_open() {
        let text = "---\nloop: x\ntitulo: X\nritmo: min:15\nfuturo: 42\n---\n\nfaça algo\n";
        let def = from_markdown("x", text);
        assert_eq!(def.ritmo, "min:15");
        assert_eq!(def.instrucao, "faça algo");
    }

    // §3.8.1 — a loop that arrives inside a plugin arrives OFF.
    #[test]
    fn disarming_a_definition_keeps_everything_else_the_author_wrote() {
        let text = "---\nloop: x\nligado: true\nritmo: dia:09:00\n---\n\ninstrução\n";
        let out = disarm_markdown(text);
        assert!(out.contains("ligado: false\n"));
        assert!(out.contains("ritmo: dia:09:00\n"));
        assert!(out.ends_with("instrução\n"));
        assert!(!out.contains("ligado: true"));
        // a body line that merely starts with the same word is not front matter
        let body = "---\nloop: x\n---\n\nligado: true no corpo\n";
        assert!(disarm_markdown(body).contains("ligado: true no corpo"));
    }

    #[test]
    fn the_destination_and_the_reading_scope_are_derived_never_typed() {
        let mut def = weekly();
        assert_eq!(dest_rel(&def), "loops/o-que-falta");
        // the slug is the acervo's own (ASCII-only): this is where the folder IS
        def.destino = "ideia:Lançamento Q3".into();
        assert_eq!(dest_rel(&def), "brainstorming/lan-amento-q3/attachments");
        def.destino = DEST_KNOWLEDGE.into();
        assert_eq!(dest_rel(&def), "contexts");
        def.escopo = "ideia:lancamento-q3".into();
        assert_eq!(read_scope(&def), "brainstorming/lancamento-q3");
        // a destination that tries to escape becomes the loop's own folder
        def.destino = "ideia:../../etc".into();
        assert_eq!(dest_rel(&def), "brainstorming/etc/attachments");
    }

    // §4.15 — o loop pode ser APONTADO para uma pasta ou para um conhecimento, e
    // então ele lê aquilo e nada mais. As duas metades da promessa: o que o ciclo
    // recebe como escopo, e a palavra SOMENTE no que ele é mandado fazer.
    #[test]
    fn a_pointed_scope_reads_that_place_and_says_only() {
        let mut def = weekly();
        assert!(!scope_is_pointed(&def), "o projeto inteiro não é apontado");
        assert!(cycle_prompt(&def, "pt", &[], &[]).contains("- Leia: brainstorming/ e contexts/"));

        def.escopo = "pasta:brainstorming/lancamento-q3/meetings".into();
        assert_eq!(read_scope(&def), "brainstorming/lancamento-q3/meetings");
        assert!(scope_is_pointed(&def));
        let p = cycle_prompt(&def, "pt", &[], &[]);
        assert!(p.contains("Leia SOMENTE brainstorming/lancamento-q3/meetings"));
        assert!(p.contains("nada fora dela"));
        assert!(cycle_prompt(&def, "en", &[], &[])
            .contains("Read ONLY brainstorming/lancamento-q3/meetings"));

        def.escopo = "conhecimento:produto".into();
        assert_eq!(read_scope(&def), "contexts/produto");
        assert!(scope_is_pointed(&def));

        // uma pasta que tenta sair do projeto não vira escopo nenhum: a leitura
        // volta a ser a do projeto, e o `blocked_reason` recusa antes de rodar
        def.escopo = "pasta:../../etc".into();
        assert_eq!(pointed_scope(&def), Some(String::new()));
        assert_eq!(read_scope(&def), SCOPE_ALL);
        // e uma pasta escrita com sobras de caminho é normalizada, não recusada
        def.escopo = "pasta:./contexts/produto/".into();
        assert_eq!(read_scope(&def), "contexts/produto");
    }

    #[test]
    fn a_pointed_scope_that_is_not_there_blocks_instead_of_failing() {
        let base = tmp("scope-missing");
        std::fs::create_dir_all(base.join("contexts/produto")).unwrap();
        let now = now_at("2026-08-17", 15, 0, 1, 1);
        let existe = LoopDef {
            escopo: "pasta:contexts/produto".into(),
            ..weekly()
        };
        // sem agente configurado o teste não alcança a linha do escopo: é a
        // primeira razão de `blocked_reason`, e ela vale para todos
        if crate::active_agent().trim().is_empty() {
            return;
        }
        assert_eq!(blocked_reason(&base, &existe, &now), None);
        let sumiu = LoopDef {
            escopo: "pasta:contexts/que-nao-existe".into(),
            ..weekly()
        };
        assert_eq!(
            blocked_reason(&base, &sumiu, &now),
            Some("err.loop_scope_missing:contexts/que-nao-existe".into())
        );
        let torto = LoopDef {
            escopo: "pasta:../fora".into(),
            ..weekly()
        };
        assert_eq!(
            blocked_reason(&base, &torto, &now),
            Some("err.loop_scope_invalid".into())
        );
    }

    // §4.15 — um formato que ninguém reconhece é RECUSADO, nunca rebaixado para «o
    // projeto»: alargar o escopo de uma pasta para o acervo inteiro em silêncio é o
    // único erro que este campo não pode cometer.
    #[test]
    fn the_scope_is_written_down_normalized_and_an_unknown_shape_is_refused() {
        assert_eq!(clean_scope(""), Ok(SCOPE_PROJECT.into()));
        assert_eq!(clean_scope("projeto"), Ok(SCOPE_PROJECT.into()));
        assert_eq!(
            clean_scope("pasta: brainstorming/lancamento-q3//meetings/ "),
            Ok("pasta:brainstorming/lancamento-q3/meetings".into())
        );
        assert_eq!(
            clean_scope("conhecimento:Produto"),
            Ok("conhecimento:produto".into())
        );
        assert_eq!(
            clean_scope("ideia:Lançamento Q3"),
            Ok("ideia:lan-amento-q3".into())
        );
        assert_eq!(
            clean_scope("pasta:../.."),
            Err("err.loop_scope_invalid".into())
        );
        assert_eq!(clean_scope("pasta:"), Err("err.loop_scope_invalid".into()));
        assert_eq!(clean_scope("tudo"), Err("err.loop_scope_invalid".into()));
    }

    // A ORDEM DOS RAMOS É A POLÍTICA. Este teste existe porque ela errou duas vezes, e
    // a segunda foi no acervo do dono (2026-08-18): um ciclo de 9 passos escreveu o
    // arquivo pedido, um passo pelo caminho pediu uma ferramenta que o loop não tinha, e
    // o registro dizia «impedido» — a tela negava um trabalho que estava na pasta, e a
    // pergunta pendente travava o loop até desligar e ligar.
    #[test]
    fn a_refusal_in_the_middle_does_not_erase_the_work_the_cycle_did() {
        let base_end = || CycleEnd {
            cancelled: false,
            intake_block: String::new(),
            brake: None,
            permission: None,
            ok: true,
            code: 0,
            agent_error: None,
            files: 0,
        };
        // pediu permissão E produziu: o resultado é o arquivo, e o pedido é uma NOTA
        let (outcome, err) = cycle_outcome(&CycleEnd {
            permission: Some("mcp__slack__ler".into()),
            files: 1,
            ..base_end()
        });
        assert_eq!(outcome, "ok");
        assert_eq!(err, "err.loop_permission_refused:mcp__slack__ler");

        // pediu permissão e NÃO produziu nada: aí sim é impedimento, e ele espera a pessoa
        let (outcome, err) = cycle_outcome(&CycleEnd {
            permission: Some("mcp__slack__ler".into()),
            ..base_end()
        });
        assert_eq!(outcome, "blocked");
        assert_eq!(err, "err.loop_permission_refused:mcp__slack__ler");

        // sem nome, o código fica sem sufixo (a tela não tem o que oferecer, e diz isso)
        let (_, err) = cycle_outcome(&CycleEnd {
            permission: Some(String::new()),
            ..base_end()
        });
        assert_eq!(err, "err.loop_permission_refused");
        // e um nome que não é ferramenta nenhuma não entra no código
        let (_, err) = cycle_outcome(&CycleEnd {
            permission: Some("write; rm -rf /".into()),
            ..base_end()
        });
        assert_eq!(err, "err.loop_permission_refused");

        // o resto da ordem, que não mudou
        assert_eq!(
            cycle_outcome(&CycleEnd {
                cancelled: true,
                files: 3,
                ..base_end()
            })
            .0,
            "stopped",
            "cancelar vence tudo"
        );
        assert_eq!(
            cycle_outcome(&CycleEnd {
                intake_block: "err.intake_secret:x.md".into(),
                permission: Some("WebFetch".into()),
                files: 1,
                ..base_end()
            })
            .0,
            "blocked",
            "uma credencial no material vence uma permissão pedida (BR-9)"
        );
        assert_eq!(
            cycle_outcome(&CycleEnd {
                brake: Some("err.loop_ceiling_files".into()),
                files: 9,
                ..base_end()
            })
            .0,
            "stopped"
        );
        assert_eq!(
            cycle_outcome(&CycleEnd {
                ok: false,
                ..base_end()
            })
            .0,
            "failed"
        );
        assert_eq!(cycle_outcome(&base_end()).0, "nothing");
        assert_eq!(
            cycle_outcome(&CycleEnd {
                files: 2,
                ..base_end()
            })
            .0,
            "ok"
        );
    }

    // §4.17 — O QUE UM LOOP PODE USAR. A lista não é um vocabulário de conectores no
    // código do Loro: ela é o nome exato da ferramenta do agente, e o que a tela
    // OFERECE vem do projeto (um pacote instalado, um `.mcp.json` escrito à mão).
    #[test]
    fn what_a_loop_may_use_is_a_tool_name_and_bash_is_not_one_of_them() {
        assert_eq!(safe_tool_name("WebFetch"), "WebFetch");
        assert_eq!(
            safe_tool_name(" mcp__slack__read_channel "),
            "mcp__slack__read_channel"
        );
        assert_eq!(safe_tool_name("mcp__slack__*"), "mcp__slack__*");
        // arbitrary execution is §4.3's door, and it does not open through a checkbox
        assert_eq!(safe_tool_name("Bash"), "");
        assert_eq!(safe_tool_name("bash"), "");
        // «tudo, sem perguntar» sob outra grafia é a mesma coisa, e é recusada (§4.9)
        assert_eq!(safe_tool_name("*"), "");
        assert_eq!(safe_tool_name("mcp__*"), "");
        assert_eq!(safe_tool_name("Web*"), "");
        // e nada que não seja um nome de ferramenta
        assert_eq!(safe_tool_name("WebFetch; rm -rf /"), "");
        assert_eq!(safe_tool_name("--allowedTools"), "");
        assert_eq!(safe_tool_name(""), "");

        // uma lista é limpa E não repete, e o que ela larga fica de fora
        let parsed = clean_tools(&[
            "WebFetch".into(),
            " mcp__slack__* ".into(),
            "Bash".into(),
            "WebFetch".into(),
            String::new(),
            "*".into(),
        ]);
        assert_eq!(parsed, vec!["WebFetch", "mcp__slack__*"]);

        // o que vai para o turno é limpo DE NOVO no spawn: `.loro/settings.json` é
        // versionado, então ele chega no commit de outra pessoa
        let allowed = clean_tools(&["WebFetch".into(), "Bash".into(), "mcp__drive__ler".into()]);
        assert_eq!(allowed, vec!["WebFetch", "mcp__drive__ler"]);
        // e o ciclo é DITO o que pode usar, com o limite que continua valendo
        let p = cycle_prompt(&weekly(), "pt", &allowed, &[]);
        assert!(p.contains("Fora do projeto você só pode usar: WebFetch, mcp__drive__ler"));
        assert!(p.contains("nunca para ENVIAR"));
        assert!(!p.contains("Bash"));
        // sem permissão nenhuma o ciclo não ganha a linha (é o padrão do projeto)
        assert!(!cycle_prompt(&weekly(), "pt", &[], &[]).contains("Fora do projeto"));
    }

    // §4.18/§8.1 — um pacote não arma um loop, e não tem como lhe dar permissão: as
    // concessões moram em `.loro/settings.json`, e o destino de cada arquivo de um
    // pacote é MONTADO pelo Loro (`.claude/commands/…`, `loops/…`, `contexts/…`), então
    // não existe caminho de um pacote até aquele arquivo. A guarda é estrutural, não uma
    // conferência que alguém pode esquecer.
    #[test]
    fn a_pacote_never_ships_an_armed_loop_and_has_no_path_to_the_grants() {
        let doc = "---\nloop: x\nligado: true\nritmo: min:30\n---\n\nleia o slack\n";
        let def = from_markdown("x", &disarm_markdown(doc));
        assert!(!def.ligado, "§8.1");
        assert_eq!(def.instrucao, "leia o slack", "e o resto do autor fica");
        // uma linha `permite:` deixada por uma versão anterior é INERTE: a definição não
        // tem mais esse campo, então ela não concede nada, e sai no próximo salvamento
        let velho =
            "---\nloop: x\nligado: false\npermite: mcp__slack__*\nritmo: min:30\n---\n\nx\n";
        assert!(!to_markdown(&from_markdown("x", velho)).contains("permite"));
        // e o destino de um pacote é montado pelo Loro — nenhum deles é `.loro/`
        let plugins = include_str!("plugins.rs");
        for dest in [
            "dest: format!(\".claude/commands/{stem}.md\")",
            "dest: format!(\"loops/{stem}.md\")",
        ] {
            assert!(plugins.contains(dest), "o destino {dest} mudou de forma");
        }
        assert!(
            !plugins.contains(".loro/settings.json"),
            "um pacote passou a alcançar o arquivo das concessões"
        );
    }

    // §4.18 — O PEDIDO É DO PROJETO, e a pergunta pendente é «um ciclo pode usar X»,
    // nunca «este loop pode usar X»: dois loops que tropeçaram na mesma ferramenta são
    // UM pedido, e uma resposta resolve os dois.
    #[test]
    fn two_loops_that_asked_for_the_same_tool_are_one_request() {
        let mk = |slug: &str, tool: &str, at: i64| LoopView {
            rel: def_rel(slug),
            dest: format!("loops/{slug}"),
            scope: SCOPE_ALL.into(),
            state: "blocked".into(),
            blocked: Some(format!("err.loop_permission_refused:{tool}")),
            missed: 0,
            runtime: LoopRuntime {
                slug: slug.into(),
                needs_person: format!("err.loop_permission_refused:{tool}"),
                cycles: vec![LoopCycle {
                    started_ms: at,
                    outcome: "blocked".into(),
                    err: format!("err.loop_permission_refused:{tool}"),
                    ..Default::default()
                }],
                ..Default::default()
            },
            def: LoopDef {
                slug: slug.into(),
                ..weekly()
            },
        };
        let reqs = requests_of(&[
            mk("a", "mcp__slack__ler", 10),
            mk("b", "mcp__slack__ler", 30),
            mk("c", "WebFetch", 20),
        ]);
        assert_eq!(reqs.len(), 2, "um pedido por FERRAMENTA");
        assert_eq!(reqs[0].tool, "mcp__slack__ler", "o mais recente primeiro");
        assert_eq!(
            reqs[0].loops,
            vec!["a", "b"],
            "e ele diz quais loops pararam"
        );
        assert_eq!(reqs[0].at_ms, 30);
        assert_eq!(reqs[1].tool, "WebFetch");

        // um impedimento que NÃO é pedido de ferramenta não entra na lista
        let mut outro = mk("d", "x", 1);
        outro.runtime.needs_person = "err.intake_secret:contexts/x.md".into();
        assert!(requests_of(&[outro]).is_empty());
        // nem um pedido sem nome, que ninguém tem como conceder
        let mut sem = mk("e", "x", 1);
        sem.runtime.needs_person = "err.loop_permission_refused".into();
        assert!(requests_of(&[sem]).is_empty());
    }

    // O LIMITE DO QUE UM CICLO ALCANÇA, medido em vez de afirmado. O log de sessão do
    // dono (2026-08-18) mostrou um ciclo com `--permission-mode acceptEdits` rodando
    // `find /Users/…/Desktop` e `ls -la` com `is_error: false`: o modo NUNCA foi a
    // fronteira que a tela dizia ser, e três promessas eram prosa — «ler e editar o
    // projeto», «comandos livres não são de um ciclo» e «um loop nunca roda git» (§3.8).
    #[test]
    fn a_cycle_never_gets_bash_whatever_anyone_granted() {
        // sem concessão nenhuma, a única bandeira é a que fecha a porta
        let flags = cycle_tool_flags(&[], &[]);
        assert_eq!(flags, vec!["--disallowedTools", "Bash"]);
        // com concessões, as duas bandeiras — e `Bash` continua na de recusa
        let flags = cycle_tool_flags(
            &["WebFetch".into(), "mcp__slack__*".into()],
            &["mcp__antigo__*".into()],
        );
        assert_eq!(
            flags,
            vec![
                "--allowedTools",
                "WebFetch,mcp__slack__*",
                "--disallowedTools",
                "mcp__antigo__*,Bash",
            ]
        );
        // e NÃO dá para conceder Bash por nenhum caminho: nem pela lista do projeto…
        let flags = cycle_tool_flags(&["Bash".into()], &[]);
        assert_eq!(
            flags,
            vec!["--disallowedTools", "Bash"],
            "Bash entrou como concedido"
        );
        // …nem escrito de outra forma no arquivo
        for grafia in ["bash", "Bash(git *)", " Bash "] {
            let flags = cycle_tool_flags(&[grafia.into()], &[]);
            assert!(
                !flags.iter().any(|f| f == "--allowedTools"),
                "«{grafia}» virou uma concessão"
            );
        }
        // a lista de recusa aceita o que a de concessão recusa: recusar é o oposto
        assert_eq!(clean_refusals(&["Bash".into()]), vec!["Bash"]);
        assert!(clean_tools(&["Bash".into()]).is_empty());
    }

    // §4.18 — uma decisão sobre uma ferramenta é do PROJETO, e ela limpa a pergunta em
    // todo loop que a fez. «Recusar» não é «pergunte de novo»: ela fecha a porta, e o
    // ciclo nem gasta passo tentando (`--disallowedTools`).
    #[test]
    fn one_decision_settles_the_question_for_every_loop_that_asked() {
        let mut policy = LoopPolicy::default();
        // permitir → entra na lista de permitidos e sai da de recusados
        policy.recusa.push("WebFetch".into());
        policy.permite.retain(|t| t != "WebFetch");
        policy.recusa.retain(|t| t != "WebFetch");
        policy.permite.push("WebFetch".into());
        assert_eq!(clean_tools(&policy.permite), vec!["WebFetch"]);
        assert!(clean_tools(&policy.recusa).is_empty());
        // as duas listas nunca carregam a mesma ferramenta: a decisão é uma
        assert!(!policy.recusa.contains(&"WebFetch".to_string()));
    }

    // §4.17 — o que a TELA oferece vem do projeto, nunca de uma lista no Loro.
    #[test]
    fn what_the_screen_offers_is_discovered_from_the_project() {
        let base = tmp("caps");
        // sem `.mcp.json`, só as ferramentas que o próprio agente tem
        let bare = capabilities_of(&base);
        assert_eq!(
            bare.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["WebFetch", "WebSearch"]
        );
        assert!(
            !bare.iter().any(|c| c.id.contains("Bash")),
            "execução arbitrária não é uma caixinha (§4.3)"
        );
        // um conector que o Loro nunca ouviu falar aparece no dia em que é instalado
        std::fs::write(
            base.join(".mcp.json"),
            r#"{"mcpServers":{"slack":{"command":"x"},"qualquer-coisa":{"command":"y"}}}"#,
        )
        .unwrap();
        let caps = capabilities_of(&base);
        let ids: Vec<&str> = caps.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"mcp__slack__*"));
        assert!(ids.contains(&"mcp__qualquer-coisa__*"));
        // e cada um diz de onde veio (vazio quando foi a própria pessoa)
        assert!(caps.iter().all(|c| c.origin.is_empty()));
    }

    // §4.16 — o que vai para a LINHA DE COMANDO do agente. A definição é um
    // documento que uma mão (ou um pacote) reescreve: um valor que não é um token
    // simples é descartado, e o ciclo roda com o padrão do agente.
    #[test]
    fn what_goes_on_the_agent_command_line_is_a_plain_token() {
        assert_eq!(safe_cli_value("opus"), "opus");
        assert_eq!(safe_cli_value("  high  "), "high");
        assert_eq!(safe_cli_value("ollama:llama3.1"), "ollama:llama3.1");
        assert_eq!(safe_cli_value(""), "");
        assert_eq!(safe_cli_value("opus; rm -rf /"), "");
        assert_eq!(safe_cli_value("--dangerously-skip-permissions"), "");
        assert_eq!(safe_cli_value("opus $(whoami)"), "");
        assert_eq!(safe_cli_value(&"o".repeat(41)), "");
        // e o turno de um ciclo só carrega as bandeiras quando há o que carregar:
        // um `--model` vazio faz o CLI recusar o turno inteiro
        let vazio = crate::chat::claude_args("", "", "acceptEdits", None).join(" ");
        assert!(!vazio.contains("--model"));
        let com = crate::chat::claude_args(
            &safe_cli_value("opus"),
            &safe_cli_value("xhigh"),
            "acceptEdits",
            None,
        )
        .join(" ");
        assert!(com.contains("--model opus"));
        assert!(com.contains("--effort xhigh"));
        // §4.9 — e o modo continua sendo o único que um ciclo sem ninguém aceita.
        // Dito por afirmação, e não negando a palavra: um teste que a escrevesse
        // faria a varredura de loops.test.js encontrá-la neste arquivo.
        assert!(com.contains("--permission-mode acceptEdits"));
    }

    // §3.10 D3 — a loop whose output sits inside its own input feeds itself. The
    // prompt says so, and §3.8 lists the acts a loop never performs.
    // O CICLO QUE LEU TUDO E NÃO ESCREVEU NADA (acervo do dono, 2026-08-18): quatro
    // ciclos, 4/10/8 passos, sete documentos lidos, toda ferramenta OK — e «nada novo» em
    // todos. O prompt dizia «nunca leia a sua pasta de saída» E «se não houver nada novo,
    // não escreva»: nada novo em relação a QUÊ? Às cegas, o agente escolhe o silêncio.
    #[test]
    fn nothing_new_is_only_offered_when_there_is_something_to_compare_with() {
        let def = weekly();
        // primeiro ciclo: a saída não é uma opção, porque não há nada seu para comparar
        let primeiro = cycle_prompt(&def, "pt", &[], &[]);
        assert!(primeiro.contains("PRIMEIRO ciclo"));
        assert!(
            !primeiro.contains("nada novo"),
            "convidou a não fazer o trabalho que ninguém fez ainda"
        );
        assert!(cycle_prompt(&def, "en", &[], &[]).contains("FIRST cycle"));
        assert!(!cycle_prompt(&def, "en", &[], &[]).contains("nothing new"));

        // com histórico: ele SABE o que já disse, e aí «nada novo» é uma decisão
        let recent = vec![
            (
                "loops/o-que-falta/a.md".to_string(),
                "2026-08-18".to_string(),
            ),
            (
                "loops/o-que-falta/b.md".to_string(),
                "2026-08-11".to_string(),
            ),
        ];
        let com = cycle_prompt(&def, "pt", &[], &recent);
        assert!(com.contains("Você já produziu, em ciclos anteriores: loops/o-que-falta/a.md (2026-08-18), loops/o-que-falta/b.md (2026-08-11)"));
        assert!(com.contains("ABRA o mais recente"));
        assert!(
            com.contains("pode ATUALIZAR"),
            "o terceiro caminho: melhorar o que já existe"
        );
        assert!(com.contains("nada novo"));
        let en = cycle_prompt(&def, "en", &[], &recent);
        assert!(en.contains("OPEN the most recent"));
        assert!(en.contains("may UPDATE"));
        // e a pasta de saída continua fora do MATERIAL, que é a regra que D3 protege
        assert!(com.contains("NÃO é material"));

        // a lista vem do registro, sem repetir e com teto
        let rt = LoopRuntime {
            cycles: vec![
                LoopCycle {
                    started_date: "2026-08-18".into(),
                    files: vec!["a.md".into(), "b.md".into()],
                    ..Default::default()
                },
                LoopCycle {
                    started_date: "2026-08-11".into(),
                    files: vec!["b.md".into(), "c.md".into(), "d.md".into()],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            recent_output(&rt, 3),
            vec![
                ("a.md".to_string(), "2026-08-18".to_string()),
                ("b.md".to_string(), "2026-08-18".to_string()),
                ("c.md".to_string(), "2026-08-11".to_string()),
            ]
        );
        assert!(recent_output(&LoopRuntime::default(), 3).is_empty());
    }

    // O CASO REAL, montado do disco do dono (loops/teste.md + .loro/loops/teste.json,
    // 2026-08-18): ritmo min:30, escopo apontado numa pasta, destino nos anexos de uma
    // ideia, um arquivo produzido às 10:33 e quatro ciclos «nada novo» depois dele. Este
    // teste é a garantia pedida: o que ESTE loop recebe no próximo ciclo.
    #[test]
    fn the_owners_own_loop_gets_all_three_paths_and_no_way_out_of_the_project() {
        let def = LoopDef {
            slug: "teste".into(),
            titulo: "Teste".into(),
            instrucao: "Leia os arquivos do desktop e me de insights do tema".into(),
            ritmo: "min:30".into(),
            escopo: "pasta:brainstorming/abertura-e-fechamento".into(),
            destino: "ideia:abertura-e-fechamento".into(),
            modelo: "haiku".into(),
            esforco: "low".into(),
            max_arquivos: 3,
            max_ciclos_dia: 8,
            ..Default::default()
        };
        let rt = LoopRuntime {
            cycles: vec![LoopCycle {
                started_date: "2026-08-18".into(),
                outcome: "ok".into(),
                files: vec![
                    "brainstorming/abertura-e-fechamento/attachments/insights-20260818.md".into(),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let p = cycle_prompt(&def, "pt", &[], &recent_output(&rt, 3));

        // OS TRÊS CAMINHOS, e o terceiro é o que faltava
        assert!(
            p.contains("insights-20260818.md (2026-08-18)"),
            "ele sabe o que já disse"
        );
        assert!(p.contains("ABRA o mais recente antes de decidir"));
        assert!(
            p.contains("pode ATUALIZAR esse arquivo"),
            "o caminho que não existia"
        );
        assert!(p.contains("não houver nada a acrescentar nem a corrigir"));
        // e o escopo/destino do caso real seguem ditos
        assert!(p.contains("Leia SOMENTE brainstorming/abertura-e-fechamento"));
        assert!(p.contains("SOMENTE dentro de brainstorming/abertura-e-fechamento/attachments"));
        assert!(p.contains("No máximo 3 arquivo(s)"));
        // sem concessão nenhuma, nada fora do projeto é oferecido…
        assert!(!p.contains("Fora do projeto você só pode usar"));
        // …e comando nenhum chega ao turno, seja o que for que esteja no arquivo
        assert_eq!(
            cycle_tool_flags(&[], &[]),
            vec!["--disallowedTools", "Bash"]
        );
    }

    #[test]
    fn the_cycle_prompt_excludes_its_own_output_and_forbids_the_person_s_acts() {
        let def = weekly();
        let p = cycle_prompt(&def, "pt", &[], &[]);
        // a pasta de saída não é MATERIAL — a regra que §3.10 D3 protege é essa, e não
        // «não abra»: sem poder conferir o que já disse, o ciclo decidia às cegas
        assert!(p.contains("A sua pasta de saída (loops/o-que-falta) NÃO é material"));
        assert!(p.contains("SOMENTE dentro de loops/o-que-falta"));
        assert!(p.contains("No máximo 3 arquivo(s)"));
        assert!(p.contains("Nunca rode git"));
        assert!(p.contains("nunca envie nada para revisão"));
        let en = cycle_prompt(&def, "en", &[], &[]);
        assert!(en.contains("Your output folder (loops/o-que-falta) is NOT material"));
        assert!(en.contains("Never run git"));
    }

    #[test]
    fn a_knowledge_cycle_proposes_instead_of_publishing() {
        let def = LoopDef {
            destino: DEST_KNOWLEDGE.into(),
            ..weekly()
        };
        let p = cycle_prompt(&def, "pt", &[], &[]);
        assert!(p.contains("É uma PROPOSTA"));
        assert!(p.contains("Nunca rode git"));
    }

    #[test]
    fn a_cited_habilidade_leads_the_prompt() {
        let def = LoopDef {
            habilidade: "/loro-digest".into(),
            ..weekly()
        };
        assert!(cycle_prompt(&def, "pt", &[], &[]).starts_with("/loro-digest\n\n"));
    }

    #[test]
    fn slug_and_rel_agree_in_both_directions() {
        assert_eq!(slugify("O que Falta Decidir!"), "o-que-falta-decidir");
        assert_eq!(slugify("  "), "");
        assert_eq!(
            slugify("Lançamento Q3"),
            "lan-amento-q3",
            "the acervo's own slug"
        );
        assert_eq!(def_rel("x"), "loops/x.md");
        assert_eq!(slug_of_rel("loops/x.md").as_deref(), Some("x"));
        assert_eq!(slug_of_rel("loops/sub/x.md"), None);
        assert_eq!(slug_of_rel("contexts/x.md"), None);
        assert_eq!(slug_of_rel("loops/.md"), None);
    }

    // Um ciclo de conhecimento PROPÕE reescrevendo um documento que já existia:
    // comparar só nomes reportava «nada novo» para uma proposta que a pessoa nunca
    // seria avisada de rever. Achado por revisão adversarial.
    #[test]
    fn what_a_cycle_touched_covers_the_file_it_rewrote() {
        let a = ("loops/x/a.md".to_string(), 10u64, 1i64);
        let b = ("loops/x/b.md".to_string(), 5u64, 2i64);
        let a2 = ("loops/x/a.md".to_string(), 40u64, 9i64); // o mesmo, reescrito
                                                            // 0 = sem recorte de tempo; a variante com recorte vem no teste seguinte
        assert_eq!(
            changed_since(&[a.clone()], &[a.clone(), b.clone()], 0),
            vec!["loops/x/b.md".to_string()],
            "um arquivo novo conta"
        );
        assert_eq!(
            changed_since(&[a.clone()], &[a2.clone()], 0),
            vec!["loops/x/a.md".to_string()],
            "e um arquivo reescrito também"
        );
        assert!(
            changed_since(&[a.clone(), b.clone()], &[a.clone()], 0).is_empty(),
            "sumir não é produzir"
        );
        // §3.10 — o destino «conhecimento» é escrito por outras mãos também: só o
        // que se moveu DEPOIS do ciclo começar é atribuído a ele (a folga de 1s
        // cobre a resolução do mtime do sistema de arquivos)
        let outro = ("contexts/produto/context.md".to_string(), 7u64, 5_000i64);
        let meu = ("contexts/juridico/context.md".to_string(), 9u64, 90_000i64);
        assert_eq!(
            changed_since(&[], &[outro, meu], 60_000),
            vec!["contexts/juridico/context.md".to_string()],
            "a mudança de outro escritor não é do ciclo"
        );
    }

    #[test]
    fn days_between_two_local_dates_survives_month_and_year_ends() {
        assert_eq!(days_between("2026-08-17", "2026-08-24"), 7);
        assert_eq!(days_between("2026-12-31", "2027-01-01"), 1);
        assert_eq!(days_between("2024-02-28", "2024-03-01"), 2); // leap year
        assert_eq!(days_between("", "2026-01-01"), 0);
    }

    // BR-8 — the record is structure: when, how long, which files, a code. A
    // serialized cycle must not be able to carry the produced text.
    #[test]
    fn br8_the_cycle_record_has_no_field_for_content() {
        let c = LoopCycle {
            started_ms: 1,
            ended_ms: 2,
            started_date: "2026-08-17".into(),
            outcome: "ok".into(),
            files: vec!["loops/x/a.md".into()],
            steps: 3,
            err: String::new(),
        };
        let v = serde_json::to_value(&c).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = vec![
            "startedMs",
            "endedMs",
            "startedDate",
            "outcome",
            "files",
            "steps",
            "err",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        for forbidden in [
            "text",
            "texto",
            "content",
            "conteudo",
            "output",
            "transcript",
        ] {
            assert!(!keys.contains(&forbidden), "{forbidden} must not exist");
        }
    }

    #[test]
    fn the_policy_is_born_from_the_project_and_is_clamped() {
        let p = LoopPolicy::default();
        assert_eq!(
            (p.max_arquivos, p.max_ciclos_dia, p.expira_dias, p.paralelo),
            (3, 8, 30, 1)
        );
        let s = AcervoSettings::default();
        assert_eq!(policy_of(&s).paralelo, 1);
    }
}
