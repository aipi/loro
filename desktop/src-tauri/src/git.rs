// Optional versioning of the acervo. Git stays a system dependency (resolved
// from PATH); nothing is vendored. This module owns the git/GitHub concern so
// lib.rs keeps only Tauri wiring — see the "git" split target in CLAUDE.md.
//
// Invocation policy (security): always `crate::proc::command("git"|"gh").args([...])`
// with fixed tokens — never `sh -c`, never interpolate user input into a shell
// string. Values coming from the user are passed as isolated positional args.
// Logs never carry tokens/PII (BR: structured logs, no secrets).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Output;

use tracing::info;

use crate::config::read_brain_config;
use crate::diff::FileDiff;
use crate::paths::which;

// ---- gh (GitHub CLI) — read layer -----------------------------------------
// Opt-in remote collaboration. gh stays a system dependency (from PATH); the
// app stores NO credentials — it only reads whether the environment is ready
// and surfaces public PR/review metadata. Tokens are never captured or logged.

pub fn gh_available() -> bool {
    which("gh").is_some()
}

// Run gh in the acervo, with prompts and update-notifier disabled so output is
// deterministic and never blocks. Fixed args only (no shell, no interpolation).
fn gh(base: &Path, args: &[&str]) -> Result<Output, String> {
    crate::proc::command("gh")
        .args(args)
        .current_dir(base)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .output()
        .map_err(|e| e.to_string())
}

fn tool_version(bin: &str) -> Option<(u32, u32, u32)> {
    let out = crate::proc::command(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_semver(&String::from_utf8_lossy(&out.stdout))
}

// First `\d+.\d+[.\d+]` token in a version string. Handles "git version 2.50.1"
// and "gh version 2.83.2 (2025-12-10)".
pub fn parse_semver(s: &str) -> Option<(u32, u32, u32)> {
    for tok in s.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
        let parts: Vec<&str> = tok.split('.').collect();
        if parts.len() >= 2 && !parts[0].is_empty() && parts[0].chars().all(|c| c.is_ascii_digit())
        {
            let a = parts[0].parse().ok()?;
            let b = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(0);
            let c = parts.get(2).and_then(|x| x.parse().ok()).unwrap_or(0);
            return Some((a, b, c));
        }
    }
    None
}

// version >= floor, comparing major then minor (patch ignored).
pub fn version_meets(v: (u32, u32, u32), floor: (u32, u32)) -> bool {
    v.0 > floor.0 || (v.0 == floor.0 && v.1 >= floor.1)
}

pub fn git_version() -> Option<(u32, u32, u32)> {
    tool_version("git")
}
pub fn gh_version() -> Option<(u32, u32, u32)> {
    tool_version("gh")
}

pub fn version_str(v: Option<(u32, u32, u32)>) -> String {
    v.map(|(a, b, c)| format!("{a}.{b}.{c}"))
        .unwrap_or_default()
}

// gh is authenticated when `gh auth status` exits 0. We never read the token.
pub fn gh_authed() -> bool {
    crate::proc::command("gh")
        .args(["auth", "status"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// The public GitHub login (not a secret) — used to target notifications at "me".
pub fn gh_account() -> Option<String> {
    let out = crate::proc::command("gh")
        .args(["api", "user", "-q", ".login"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

// Git protocol reported by gh (ssh | https) — reveals whether SSH or a PAT/HTTPS
// credential is wired. Parsed from `gh auth status`; never captures the token.
pub fn gh_protocol() -> Option<String> {
    let out = crate::proc::command("gh")
        .args(["auth", "status"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .ok()?;
    let text =
        String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    parse_auth_protocol(&text)
}

// Extracts "ssh" / "https" from the "Git operations protocol: <p>" line.
pub fn parse_auth_protocol(s: &str) -> Option<String> {
    for line in s.lines() {
        let l = line.to_ascii_lowercase();
        if l.contains("protocol") {
            if l.contains("ssh") {
                return Some("ssh".into());
            }
            if l.contains("https") {
                return Some("https".into());
            }
        }
    }
    None
}

// (user.name, user.email) as resolved by git (global + local); None when unset.
pub fn git_identity(base: &Path) -> (Option<String>, Option<String>) {
    let read = |key: &str| -> Option<String> {
        let out = crate::proc::command("git")
            .args(["config", key])
            .current_dir(base)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    (read("user.name"), read("user.email"))
}

// Is this text an e-mail ADDRESS? The identity signs every version the team
// reads and is how GitHub attributes a commit to a person, so "seu@email" — the
// example the sheet itself used to pre-fill as a value — cannot be accepted just
// because it is not empty. Shape only: exactly one `@`, both halves non-empty, a
// dotted domain, and none of the characters that would break the author line
// (whitespace, control, `<`, `>`, `,`, `;`, `"`).
fn is_email_shaped(email: &str) -> bool {
    let e = email.trim();
    let Some((local, domain)) = e.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !e
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "<>,;\"".contains(c))
}

// Safe, idempotent onboarding fix: set the git identity locally in the acervo
// repo (scoped; no system-wide change). Values are plain positional args.
pub fn set_identity(base: &Path, name: &str, email: &str) -> Result<(), String> {
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err("err.git_identity_required".into());
    }
    if !is_email_shaped(email) {
        return Err("err.git_identity_invalid_email".into());
    }
    git_init_repo(base)?;
    for (key, val) in [("user.name", name.trim()), ("user.email", email.trim())] {
        let out = crate::proc::command("git")
            .args(["config", key, val])
            .current_dir(base)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    Ok(())
}

pub fn git_remote_url(base: &Path) -> Option<String> {
    let out = crate::proc::command("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(base)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

// Why the remote could not be reached. A bool collapsed "you have not connected
// a repository" and "this machine has no network right now" into the same
// answer, so five minutes offline made the app blame the user's setup (N6).
#[derive(PartialEq, Debug, Clone, Copy)]
pub enum RemoteAccess {
    Ok,
    Denied,
    Offline,
}

// A transport failure names itself in gh's stderr; anything else is an answer
// FROM GitHub (404/403/not found), which is a real access problem. `git push`
// goes through here too (ADR-0027), and git words the same failure its own way
// ("Could not resolve host" / "Could not resolve hostname").
fn looks_offline(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    [
        "dial tcp",
        "no such host",
        "could not resolve host",
        "network is unreachable",
        "temporary failure in name resolution",
        "connection refused",
        "connection reset",
        "i/o timeout",
        "timeout awaiting",
        "tls handshake",
        "proxyconnect",
        "server misbehaving",
        "eof",
    ]
    .iter()
    .any(|needle| s.contains(needle))
}

// Read access to the remote confirmed without writing anything.
pub fn gh_repo_accessible(base: &Path) -> RemoteAccess {
    match gh(base, &["repo", "view", "--json", "nameWithOwner"]) {
        Ok(o) if o.status.success() => RemoteAccess::Ok,
        Ok(o) => {
            if looks_offline(&String::from_utf8_lossy(&o.stderr)) {
                RemoteAccess::Offline
            } else {
                RemoteAccess::Denied
            }
        }
        // gh itself did not run: nothing was asked of the network
        Err(_) => RemoteAccess::Denied,
    }
}

// Used by create_branch to branch off the default branch.
pub fn default_branch(base: &Path) -> String {
    gh(
        base,
        &[
            "repo",
            "view",
            "--json",
            "defaultBranchRef",
            "-q",
            ".defaultBranchRef.name",
        ],
    )
    .ok()
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "main".into())
}

// ---- branch-first flow (ADR-0002 §2) ----------------------------------------
// Local view of the git graph: everything here resolves without network or gh,
// so the studio stays responsive offline. gh remains only on the propose path.

fn ref_exists(base: &Path, r: &str) -> bool {
    crate::proc::command("git")
        .args(["rev-parse", "--verify", "--quiet", r])
        .current_dir(base)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn ref_sha(base: &Path, r: &str) -> Option<String> {
    let out = crate::proc::command("git")
        .args(["rev-parse", "--verify", "--quiet", r])
        .current_dir(base)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// Default branch resolved locally (no network, no gh): origin/HEAD when the
// clone recorded it, else the conventional local head, else "main".
pub fn local_default_branch(base: &Path) -> String {
    if let Ok(out) = crate::proc::command("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .current_dir(base)
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(b) = s.strip_prefix("refs/remotes/origin/") {
                if !b.is_empty() {
                    return b.to_string();
                }
            }
        }
    }
    for cand in ["main", "master"] {
        if ref_exists(base, &format!("refs/heads/{cand}")) {
            return cand.into();
        }
    }
    "main".into()
}

// "Dirty" is what refuses a draft switch and a fast-forward, so it has to be the
// SAME question «o que você mudou» answers. ADR-0027: on an acervo whose
// `.gitignore` predates this release the intake's own untracked bookkeeping
// counted as pending work, which refused every switch while the screen said
// there was nothing to save — a dead end built out of two files nobody wrote.
pub fn is_dirty(base: &Path) -> bool {
    !pending_entries(base).is_empty()
}

// Local branches, most recently committed first.
pub fn list_branches(base: &Path) -> Result<Vec<String>, String> {
    let out = crate::proc::command("git")
        .args([
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)",
            "--sort=-committerdate",
        ])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

// What a branch actually HOLDS, in documents — the only honest way for the
// picker to talk about it. A project that started versioning after setup has an
// empty default branch (Baseline::Empty commits nothing), so the row the UI
// labels "(principal)" can be an empty room: leaving the draft for it takes
// every document off the disk. Git keeps the content safe on the draft commit,
// but the screen goes empty, so the price has to be stated before the click
// (DESIGN.md §1). Dot-folders are the machine's own (.github/, .claude/,
// .gitignore) — the user never sees them as documents, so they are not counted.
fn tracked_documents(base: &Path, rev: &str) -> Vec<String> {
    let out = crate::proc::command("git")
        .args(["ls-tree", "-r", "--name-only", rev])
        .current_dir(base)
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.split('/').any(|p| p.starts_with('.')))
        .collect()
}

pub fn documents_on(base: &Path, rev: &str) -> usize {
    tracked_documents(base, rev).len()
}

// Documents that leave the screen when the user goes from `rev` to `target`.
pub fn documents_leaving(base: &Path, rev: &str, target: &str) -> usize {
    let there: std::collections::HashSet<String> =
        tracked_documents(base, target).into_iter().collect();
    tracked_documents(base, rev)
        .into_iter()
        .filter(|f| !there.contains(f))
        .count()
}

// Would moving to `target` leave every byte of the working tree where it is?
// `git diff --quiet HEAD <target>` compares the two TREES, so exit 0 means the
// move is invisible on disk — documents, `.github/` and the `.gitignore` alike.
// `documents_leaving` answers what the person LOSES and is what the price copy
// counts; this answers whether there is a price at all. Any other exit status
// (including a rev git cannot read) is read as "there is", which is the safe way
// round: it keeps the work in front of the user.
fn move_is_invisible_on_disk(base: &Path, target: &str) -> bool {
    crate::proc::command("git")
        .args(["diff", "--quiet", "HEAD", target, "--"])
        .current_dir(base)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// QUEM DECIDE SE A TROCA PODE É O GIT, não uma pré-checagem mais severa que ele.
// Isto recusava QUALQUER árvore suja antes de perguntar — e `git checkout` só recusa
// quando sobrescreveria a modificação; no caso comum (o arquivo é o mesmo nos dois
// rascunhos, ou não é rastreado) ele leva a mudança com você e nada se perde. O
// resultado da recusa preventiva era um beco: gravar um documento deixa a árvore
// suja, e desde que salvar o arquivo parou de commitar (round 8) essa é a situação
// NORMAL — então todas as linhas do seletor viviam apagadas.
//
// Agora a tentativa acontece e a recusa, quando vem, é a do git: ela nomeia o que
// seria perdido, e o remédio (salvar uma versão) é dito com ela.
pub fn switch_branch(base: &Path, branch: &str) -> Result<(), String> {
    if !ref_exists(base, &format!("refs/heads/{branch}")) {
        return Err("err.branch_not_found".into());
    }
    // O único caminho para `err.switch_would_lose_change` é casar o texto do git, e
    // um git localizado (o do Homebrew traz catálogos gettext) responderia em
    // pt-BR — a recusa cairia no ramo genérico e a prosa crua do git chegaria ao
    // toast, que é exatamente o que este mapeamento existe para evitar. `LC_ALL=C`
    // fixa a língua da SAÍDA que nós lemos; nada do que a pessoa vê vem daqui.
    let out = crate::proc::command("git")
        .args(["checkout", branch])
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    // o único caso que o git recusa aqui é a sobrescrita — e é o único em que
    // «salve uma versão primeiro» é o conserto certo
    if err.contains("would be overwritten") || err.contains("local changes") {
        return Err("err.switch_would_lose_change".into());
    }
    Err(err.trim().to_string())
}

#[derive(PartialEq, Debug)]
pub enum SyncOutcome {
    Updated,
    AlreadyUpToDate,
    NoRemote,
    Offline,
    Diverged,
    SkippedDirty,
}

// Best-effort fast-forward of the local default branch from origin. Never an
// error: every failure degrades to an outcome the caller can surface as a
// warning. The local default branch is never rewritten outside fast-forward.
pub fn sync_default_branch(base: &Path) -> SyncOutcome {
    if git_remote_url(base).is_none() {
        return SyncOutcome::NoRemote;
    }
    let default = local_default_branch(base);
    // low-speed limits keep a flaky network from hanging the UI
    let fetch = crate::proc::command("git")
        .args([
            "-c",
            "http.lowSpeedLimit=1",
            "-c",
            "http.lowSpeedTime=10",
            "fetch",
            "origin",
            &default,
        ])
        .current_dir(base)
        .output();
    match fetch {
        Ok(o) if o.status.success() => {}
        _ => return SyncOutcome::Offline,
    }
    let local_ref = format!("refs/heads/{default}");
    if current_branch(base).as_deref() == Some(default.as_str()) {
        if is_dirty(base) {
            return SyncOutcome::SkippedDirty;
        }
        let before = ref_sha(base, &local_ref);
        let merge = crate::proc::command("git")
            .args(["merge", "--ff-only", &format!("origin/{default}")])
            .current_dir(base)
            .output();
        match merge {
            Ok(o) if o.status.success() => {
                if ref_sha(base, &local_ref) == before {
                    SyncOutcome::AlreadyUpToDate
                } else {
                    SyncOutcome::Updated
                }
            }
            _ => SyncOutcome::Diverged,
        }
    } else {
        // not on the default branch: fetch refspec updates it fast-forward-only
        let before = ref_sha(base, &local_ref);
        let out = crate::proc::command("git")
            .args(["fetch", "origin", &format!("{default}:{default}")])
            .current_dir(base)
            .output();
        match out {
            Ok(o) if o.status.success() => {
                if ref_sha(base, &local_ref) == before {
                    SyncOutcome::AlreadyUpToDate
                } else {
                    SyncOutcome::Updated
                }
            }
            _ => SyncOutcome::Diverged,
        }
    }
}

// ---- timeline (abstracted git history) -------------------------------------
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub when: String,
    pub author: String,
    pub label: String,
}

// Field separator is the ASCII unit separator (0x1f) so subjects with spaces or
// pipes are safe to split.
pub fn parse_log_line(line: &str) -> Option<Commit> {
    let mut it = line.split('\u{1f}');
    let id = it.next()?.to_string();
    let when = it.next().unwrap_or_default().to_string();
    let author = it.next().unwrap_or_default().to_string();
    let label = it.next().unwrap_or_default().to_string();
    if id.is_empty() {
        return None;
    }
    Some(Commit {
        id,
        when,
        author,
        label,
    })
}

pub fn git_log(base: &Path, rel: Option<&str>, limit: usize) -> Vec<Commit> {
    let n = format!("-{limit}");
    let mut args = vec![
        "log".to_string(),
        n,
        "--pretty=format:%H\u{1f}%aI\u{1f}%an\u{1f}%s".to_string(),
    ];
    if let Some(r) = rel {
        args.push("--".to_string());
        args.push(r.to_string());
    }
    let out = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(parse_log_line)
            .collect(),
        _ => Vec::new(),
    }
}

// ---- Pull Requests (the RFCs) ----------------------------------------------
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    #[serde(default)]
    pub login: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
}

impl Reviewer {
    pub fn handle(&self) -> Option<&str> {
        self.login
            .as_deref()
            .or(self.slug.as_deref())
            .or(self.name.as_deref())
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub head_ref_name: String,
    #[serde(default)]
    pub author: Author,
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub review_requests: Vec<Reviewer>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub state: Option<String>,
    // Os dois fatos que dizem se a mudança está BLOQUEADA, no mesmo `gh pr list`:
    // a linha do time não podia dizer de quem é a vez sem eles.
    #[serde(default)]
    pub mergeable: String,
    // O gh manda `statusCheckRollup` com os valores dele (SUCCESS/FAILURE/…); a
    // tela lê `checks` com os valores do produto (ok/failed/running). Os dois
    // existem porque são coisas diferentes: um é o que chega, o outro é o que a
    // regra do app entende. `pr_list` traduz um no outro — sem isso a linha do
    // time lia `pr.checks` como undefined e uma mudança com CI vermelha aparecia
    // igual a uma limpa, que é exatamente o que ela existe para não fazer.
    #[serde(default, skip_serializing)]
    pub status_check_rollup: Vec<GhCheck>,
    #[serde(default, skip_deserializing)]
    pub checks: Vec<CheckRun>,
}

// A LISTA TEM DE PODER DIZER DE QUEM É A VEZ. Sem `statusCheckRollup` e
// `mergeable` a linha do time não sabia se a mudança está bloqueada por
// verificação ou em conflito com o oficial — que é exatamente o que F6 existe para
// mostrar de relance (visto no turbo: duas linhas sem chip nenhum). São dois
// campos no MESMO `gh pr list`, sem processo a mais.
const PR_FIELDS: &str = "number,title,headRefName,author,reviewDecision,reviewRequests,\
updatedAt,url,state,mergeable,statusCheckRollup";

// O gh manda `statusCheckRollup` com os valores dele; a tela lê `checks` com os do
// produto. A tradução mora AQUI, num nome, e os dois caminhos que trazem PrInfo do
// remote passam por ela — era o esquecimento dela em `pr_list` que fazia a linha do
// time nunca mostrar chip.
pub fn with_normalized_checks(mut prs: Vec<PrInfo>) -> Vec<PrInfo> {
    for p in &mut prs {
        p.checks = check_runs(std::mem::take(&mut p.status_check_rollup));
    }
    prs
}

pub fn pr_list(base: &Path) -> Result<Vec<PrInfo>, String> {
    let out = gh(base, &["pr", "list", "--json", PR_FIELDS, "--limit", "50"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let prs: Vec<PrInfo> = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(with_normalized_checks(prs))
}

// UMA LEITURA DO REMOTE, UMA FONTE DA VERDADE. `gh pr list` custa ~1,7s de rede,
// e dois comandos independentes pediam a MESMA lista no mesmo clique: o destino
// Revisão (`gh_pr_list`) e a caixa de avisos (`brain_notifications`, que chama
// `pr_list` por dentro). Duas idas à rede para responder a mesma pergunta.
//
// Duas propriedades, uma trava:
//   - CACHE com idade: quem pede aceita uma leitura de até `max_age`, e recebe
//     junto a IDADE dela, porque a tela promete não mentir sobre o que mostra
//     (DESIGN.md §1) — é ela que decide dizer «esta lista é a última leitura».
//   - SINGLE-FLIGHT: a trava é mantida DURANTE a busca, então um segundo
//     chamador concorrente espera a primeira terminar e encontra o resultado
//     pronto, em vez de abrir um segundo processo. É a cura do efeito manada
//     entre o tique de 10s e um clique que caem juntos.
//
// A trava é um Mutex bloqueante mantido através de uma chamada bloqueante: isto
// só pode ser chamado de dentro de `spawn_blocking`, NUNCA da main thread — que
// é a regra que valia desde o começo e não estava sendo cumprida.
pub struct PrCacheRead {
    pub prs: Vec<PrInfo>,
    pub age_ms: u128,
}

struct PrCache {
    key: PathBuf,
    at: std::time::Instant,
    prs: Vec<PrInfo>,
}

fn pr_cache() -> &'static std::sync::Mutex<Option<PrCache>> {
    static C: std::sync::OnceLock<std::sync::Mutex<Option<PrCache>>> = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(None))
}

// Uma escrita no acervo invalida a leitura na hora: enviar para revisão, aprovar,
// pedir mudanças, juntar. Sem isto a tela mostraria o mundo de antes da própria
// ação de quem está olhando — o pior tipo de dado velho.
pub fn pr_cache_invalidate() {
    if let Ok(mut g) = pr_cache().lock() {
        *g = None;
    }
}

pub fn pr_list_cached(base: &Path, max_age: std::time::Duration) -> Result<PrCacheRead, String> {
    // envenenamento da trava não pode derrubar uma leitura: cai para o caminho direto
    let Ok(mut slot) = pr_cache().lock() else {
        return pr_list(base).map(|prs| PrCacheRead { prs, age_ms: 0 });
    };
    if let Some(c) = slot.as_ref() {
        let age = c.at.elapsed();
        if c.key == base && age <= max_age {
            return Ok(PrCacheRead {
                prs: c.prs.clone(),
                age_ms: age.as_millis(),
            });
        }
    }
    let prs = pr_list(base)?; // o erro SOBE: quem chama já mantém a última leitura
    *slot = Some(PrCache {
        key: base.to_path_buf(),
        at: std::time::Instant::now(),
        prs: prs.clone(),
    });
    Ok(PrCacheRead { prs, age_ms: 0 })
}

pub fn pr_status(base: &Path, number: u64) -> Result<PrInfo, String> {
    let n = number.to_string();
    let out = gh(base, &["pr", "view", &n, "--json", PR_FIELDS])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let p: PrInfo = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(with_normalized_checks(vec![p]).remove(0))
}

// ---- reading a review INSIDE the app (ADR-0027) -----------------------------
// Everything below shells out; the parsing of what comes back is pure and lives
// either in `diff.rs` or in a `pub fn` with its own #[test] beside it.
//
// BR-9: no token is requested, stored or logged. gh runs with the machine's
// ambient credential, exactly as `pr_list` already does.
// BR-8: the log lines here carry counts, PR numbers and err codes — never a
// diff row, a description or a review comment.

// The ONE place a failed gh call becomes an error the screen can translate. A
// transport failure is not the user's setup (N6), so it keeps the existing
// `err.github_unreachable`; anything else takes the stable code of the act that
// failed. Raw gh English never reaches a toast — the same rule `create_branch`
// states for git.
fn gh_failure(out: &Output, code: &str) -> String {
    if looks_offline(&String::from_utf8_lossy(&out.stderr)) {
        "err.github_unreachable".into()
    } else {
        code.into()
    }
}

// owner/repo of the acervo's remote. Needed because `gh api graphql` has no
// {owner}/{repo} substitution (REST paths do). This is the PUBLIC repository
// name, not a credential — BR-9 is untouched.
pub fn repo_slug(base: &Path) -> Result<(String, String), String> {
    let out = gh(
        base,
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ],
    )?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_read_failed"));
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match s.split_once('/') {
        Some((o, r)) if !o.is_empty() && !r.is_empty() => Ok((o.to_string(), r.to_string())),
        _ => Err("err.pr_read_failed".into()),
    }
}

// ---- the working tree, as a diff --------------------------------------------

// Reading is bounded: a file past the acervo's existing 5 MiB ceiling is
// reported as `binary` (the honest card) instead of being loaded into the UI.
const DIFF_READ_MAX_BYTES: u64 = 5 * 1024 * 1024;

// Lexical guard for a path that comes from the screen. `acervo::guarded_existing`
// cannot serve here: this command is asked about documents that were DELETED,
// and canonicalize requires the file to exist. Refuses the same escape with the
// same code the acervo's own normalizer uses.
fn guard_rel(rel: &str) -> Result<(), String> {
    let r = rel.replace('\\', "/");
    let absolute = r.starts_with('/') || r.chars().nth(1) == Some(':');
    if absolute || r.split('/').any(|p| p == "..") {
        return Err("err.outside_acervo".into());
    }
    Ok(())
}

fn untracked_files(base: &Path) -> Vec<String> {
    pending_entries(base)
        .into_iter()
        .filter(|e| e.code == "??")
        .map(|e| e.path)
        .collect()
}

fn untracked_diff(base: &Path, rel: &str) -> FileDiff {
    let abs = base.join(rel);
    let readable = std::fs::metadata(&abs)
        .map(|m| m.is_file() && m.len() <= DIFF_READ_MAX_BYTES)
        .unwrap_or(false);
    if !readable {
        return crate::diff::binary_added(rel);
    }
    match std::fs::read(&abs) {
        Ok(bytes) if !crate::diff::is_binary(&bytes) => match String::from_utf8(bytes) {
            Ok(text) => crate::diff::added_file(rel, &text),
            Err(_) => crate::diff::binary_added(rel),
        },
        _ => crate::diff::binary_added(rel),
    }
}

// The working tree against HEAD, parsed. Untracked files are APPENDED as
// all-add diffs, which is why this read command never touches the index: a read
// that stages something is not a read.
//
// ADR-0009/BR-8: every candidate goes through `is_versioning_denied` — the SAME
// authority the save path uses (`unstage_versioning_denied`), so the screen
// shows exactly what a version would carry. Without it an untracked
// `contexts/<ctx>/audio.wav`, which no GIT_IGNORED pattern covers, would be read
// and painted onto the screen.
pub fn working_diff(base: &Path, rel: Option<&str>) -> Result<Vec<FileDiff>, String> {
    if let Some(r) = rel {
        guard_rel(r)?;
    }
    let mut out: Vec<FileDiff> = Vec::new();
    if head_commit_exists(base) {
        let mut args: Vec<&str> = vec![
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-U3",
            "HEAD",
        ];
        if let Some(r) = rel {
            args.push("--");
            args.push(r);
        }
        let o = crate::proc::command("git")
            .args(&args)
            .current_dir(base)
            .output()
            .map_err(|e| e.to_string())?;
        if !o.status.success() {
            // Same posture as `list_branches`: a read that should not fail
            // reports what git said rather than inventing a code the user
            // cannot act on (ARCHITECTURE §4 error contract).
            return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
        }
        out.extend(
            crate::diff::parse_unified_diff(&String::from_utf8_lossy(&o.stdout))
                .into_iter()
                .filter(|f| !is_versioning_denied(&f.path)),
        );
    }
    for path in untracked_files(base) {
        if is_versioning_denied(&path) {
            continue;
        }
        if let Some(r) = rel {
            let r = r.trim_end_matches('/');
            if path != r && !path.starts_with(&format!("{r}/")) {
                continue;
            }
        }
        out.push(untracked_diff(base, &path));
    }
    info!(target: "review", files = out.len(), "working tree read");
    Ok(out)
}

// ---- an open review, whole --------------------------------------------------

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrSection {
    pub label: String,
    pub text: String,
    // The section's `<!-- … -->` line: invisible in rendered markdown, and the
    // only place the template says WHAT to write in that field. It used to be
    // parsed out and dropped, so the send-for-review sheet asked for six
    // sections and explained none of them (ADR-0027).
    pub hint: String,
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    pub author: String,
    pub state: String,
    pub body: String,
    pub when: String,
    // the review was submitted against an earlier version of the change
    pub stale: bool,
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Ok,
    Failed,
    Running,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub name: String,
    pub state: CheckState,
    pub url: String,
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub author: String,
    pub body: String,
    pub when: String,
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrThread {
    pub id: u64,
    pub path: String,
    pub line: Option<u32>,
    pub resolved: bool,
    pub outdated: bool,
    pub excerpt: String,
    pub comments: Vec<PrComment>,
}

// What the review screen receives. Deliberately NOT gh's own key set: the app
// chooses its field names, so no unexpected gh field can ride along to the
// screen and no key mismatch can hide behind a shared struct.
//
// There is deliberately no `approvalsRequired`: branch protection is not
// readable by a non-admin, so the denominator of "%1 de %2 aprovações" is the
// people IN the review (`approvals + reviewRequests.len()`) — a fact, not a
// guess. `mergeStateStatus` is the truthful signal for whether the change can
// land, which is why it is returned raw.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub sections: Vec<PrSection>,
    pub author: Author,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub state: String,
    pub url: String,
    pub updated_at: String,
    pub mergeable: String,
    pub merge_state_status: String,
    pub is_draft: bool,
    pub mine: bool,
    pub approvals: usize,
    pub changes_requested: usize,
    pub review_requests: Vec<Reviewer>,
    pub reviews: Vec<PrReview>,
    pub files: Vec<PrFile>,
    pub checks: Vec<CheckRun>,
    pub threads: Vec<PrThread>,
    #[serde(default)]
    pub review_decision: Option<String>,
}

// gh's payload, private on purpose: `statusCheckRollup` is gh's key and `checks`
// is the app's, and `checks`, `mine`, `sections`, `stale` and `threads` do not
// exist in gh's JSON at all. Two structs is the honest shape.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GhPrView {
    #[serde(default)]
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: Author,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    mergeable: String,
    #[serde(default)]
    merge_state_status: String,
    #[serde(default)]
    review_requests: Vec<Reviewer>,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    files: Vec<GhFile>,
    #[serde(default)]
    status_check_rollup: Vec<GhCheck>,
    // Pedido em PR_DETAIL_FIELDS desde o começo e nunca lido: sem ele o guarda de
    // `reviewState` («se o remote diz que falta revisão, o denominador é ≥ 1») via
    // undefined e a tela seguia dizendo «0 de 0 aprovações» num PR que o GitHub
    // bloqueia — o defeito que aquele fix existia para consertar.
    #[serde(default)]
    review_decision: Option<String>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GhFile {
    #[serde(default)]
    path: String,
    #[serde(default)]
    additions: usize,
    #[serde(default)]
    deletions: usize,
}

// The rollup mixes two GraphQL types: a CheckRun (name/status/conclusion/
// detailsUrl) and a StatusContext (context/state/targetUrl). Both spellings are
// read so a legacy status is not silently dropped from the chip.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhCheck {
    #[serde(default)]
    name: String,
    #[serde(default)]
    context: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    details_url: String,
    #[serde(default)]
    target_url: String,
}

const PR_DETAIL_FIELDS: &str = "number,title,body,author,headRefName,baseRefName,state,url,\
updatedAt,mergeable,mergeStateStatus,reviewDecision,reviewRequests,isDraft,files,statusCheckRollup";

// An unknown gh conclusion is never painted green: that is the whole rule.
pub fn check_state(status: &str, conclusion: &str) -> CheckState {
    let s = status.to_ascii_uppercase();
    let c = conclusion.to_ascii_uppercase();
    if matches!(c.as_str(), "SUCCESS" | "NEUTRAL" | "SKIPPED") {
        return CheckState::Ok;
    }
    const RUNNING: [&str; 5] = ["QUEUED", "IN_PROGRESS", "PENDING", "REQUESTED", "WAITING"];
    if RUNNING.contains(&s.as_str()) || RUNNING.contains(&c.as_str()) {
        return CheckState::Running;
    }
    CheckState::Failed
}

// The decision each reviewer is CURRENTLY holding. A reviewer who requested
// changes and later approved counts once, as approved. A plain comment does not
// dismiss an earlier approval — GitHub does not treat it as a decision, and
// neither does the chip.
pub fn latest_by_author(reviews: &[PrReview]) -> Vec<PrReview> {
    let mut out: Vec<PrReview> = Vec::new();
    for r in reviews {
        if !matches!(
            r.state.as_str(),
            "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"
        ) {
            continue;
        }
        out.retain(|k| k.author != r.author);
        out.push(r.clone());
    }
    out
}

// The last `n` lines of the quoted excerpt a thread hangs off.
//
// O `diffHunk` do GitHub começa pelo cabeçalho `@@ -3,35 +3,107 @@`, que é sintaxe
// de máquina e chegava à tela dentro da folha de resposta (visto no #6 do turbo).
// DESIGN.md §5: a sintaxe da máquina não chega à superfície. O trecho citado é a
// LINHA comentada e o contexto dela — o cabeçalho não é nem uma nem outro.
fn last_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.starts_with("@@")).collect();
    let from = lines.len().saturating_sub(n);
    lines[from..].join("\n")
}

// A FIXED literal — never interpolated. The variables travel as isolated
// positional args, which is this module's no-shell policy.
//
// GraphQL is the only route that carries `isResolved` (REST
// pulls/{n}/comments does not) and the only one that carries each review's
// commit oid, without which "aprovação de versão anterior" could not be told
// from a current approval. `first: 50` is a deliberate ceiling (KISS): a
// knowledge review past that size has left the app's premise, and nothing in
// PrDetail claims completeness.
const REVIEW_THREADS_QUERY: &str = "query($owner:String!,$repo:String!,$number:Int!){\
viewer{login}\
repository(owner:$owner,name:$repo){pullRequest(number:$number){\
headRefOid \
reviews(last:50){nodes{state body submittedAt author{login} commit{oid}}} \
reviewThreads(first:50){nodes{isResolved isOutdated path line \
comments(first:50){nodes{databaseId author{login} body createdAt diffHunk}}}}\
}}}";

#[derive(serde::Deserialize, Default)]
struct GqlResponse {
    #[serde(default)]
    data: GqlData,
}

#[derive(serde::Deserialize, Default)]
struct GqlData {
    #[serde(default)]
    viewer: GqlViewer,
    #[serde(default)]
    repository: Option<GqlRepo>,
}

#[derive(serde::Deserialize, Default)]
struct GqlViewer {
    #[serde(default)]
    login: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlRepo {
    #[serde(default)]
    pull_request: Option<GqlPr>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlPr {
    #[serde(default)]
    head_ref_oid: String,
    #[serde(default)]
    reviews: GqlReviewConn,
    #[serde(default)]
    review_threads: GqlThreadConn,
}

#[derive(serde::Deserialize, Default)]
struct GqlReviewConn {
    #[serde(default)]
    nodes: Vec<GqlReview>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlReview {
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: String,
    #[serde(default)]
    author: Option<Author>,
    #[serde(default)]
    commit: Option<GqlOid>,
}

#[derive(serde::Deserialize, Default)]
struct GqlOid {
    #[serde(default)]
    oid: String,
}

#[derive(serde::Deserialize, Default)]
struct GqlThreadConn {
    #[serde(default)]
    nodes: Vec<GqlThread>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlThread {
    #[serde(default)]
    is_resolved: bool,
    #[serde(default)]
    is_outdated: bool,
    #[serde(default)]
    path: String,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    comments: GqlCommentConn,
}

#[derive(serde::Deserialize, Default)]
struct GqlCommentConn {
    #[serde(default)]
    nodes: Vec<GqlComment>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlComment {
    #[serde(default)]
    database_id: u64,
    #[serde(default)]
    author: Option<Author>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    diff_hunk: String,
}

#[derive(Default)]
struct Conversation {
    viewer: String,
    reviews: Vec<PrReview>,
    threads: Vec<PrThread>,
}

// Pure: the GraphQL payload -> the shapes the screen reads. Separated from the
// call so the mapping can be tested without gh.
fn conversation_from(resp: GqlResponse) -> Conversation {
    let viewer = resp.data.viewer.login;
    let pr = resp
        .data
        .repository
        .and_then(|r| r.pull_request)
        .unwrap_or_default();
    let head = pr.head_ref_oid;
    let reviews = pr
        .reviews
        .nodes
        .into_iter()
        .map(|r| {
            let oid = r.commit.map(|c| c.oid).unwrap_or_default();
            PrReview {
                author: r.author.map(|a| a.login).unwrap_or_default(),
                state: r.state,
                body: r.body,
                when: r.submitted_at,
                stale: !oid.is_empty() && !head.is_empty() && oid != head,
            }
        })
        .collect();
    let threads = pr
        .review_threads
        .nodes
        .into_iter()
        .map(|t| PrThread {
            // the id `gh_pr_reply` posts to is the FIRST comment of the thread
            id: t.comments.nodes.first().map(|c| c.database_id).unwrap_or(0),
            excerpt: t
                .comments
                .nodes
                .first()
                .map(|c| last_lines(&c.diff_hunk, 6))
                .unwrap_or_default(),
            path: t.path,
            line: t.line,
            resolved: t.is_resolved,
            outdated: t.is_outdated,
            comments: t
                .comments
                .nodes
                .into_iter()
                .map(|c| PrComment {
                    author: c.author.map(|a| a.login).unwrap_or_default(),
                    body: c.body,
                    when: c.created_at,
                })
                .collect(),
        })
        .collect();
    Conversation {
        viewer,
        reviews,
        threads,
    }
}

fn pr_conversation(
    base: &Path,
    owner: &str,
    repo: &str,
    number: u64,
) -> Result<Conversation, String> {
    let query = format!("query={REVIEW_THREADS_QUERY}");
    let owner = format!("owner={owner}");
    let repo = format!("repo={repo}");
    let number = format!("number={number}");
    let out = gh(
        base,
        &[
            "api", "graphql", "-f", &query, "-f", &owner, "-f", &repo, "-F", &number,
        ],
    )?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_read_failed"));
    }
    let resp: GqlResponse =
        serde_json::from_slice(&out.stdout).map_err(|_| "err.pr_read_failed".to_string())?;
    Ok(conversation_from(resp))
}

// Pure: gh's PR payload + the conversation -> what the app receives.
// UMA REGRA, DOIS CAMINHOS. A lista e o detalhe leem o mesmo `statusCheckRollup`
// do gh, e duas cópias desta tradução divergem — foi assim que a lista ficou sem
// poder dizer que uma mudança está bloqueada.
pub fn check_runs(raw: Vec<GhCheck>) -> Vec<CheckRun> {
    raw.into_iter()
        .map(|c| CheckRun {
            state: check_state(
                &c.status,
                if c.conclusion.is_empty() {
                    &c.state
                } else {
                    &c.conclusion
                },
            ),
            name: if c.name.is_empty() { c.context } else { c.name },
            url: if c.details_url.is_empty() {
                c.target_url
            } else {
                c.details_url
            },
        })
        .collect()
}

fn detail_from(view: GhPrView, conv: Conversation) -> PrDetail {
    let latest = latest_by_author(&conv.reviews);
    PrDetail {
        sections: pr_body_sections(&view.body),
        mine: !conv.viewer.is_empty() && conv.viewer == view.author.login,
        approvals: latest.iter().filter(|r| r.state == "APPROVED").count(),
        changes_requested: latest
            .iter()
            .filter(|r| r.state == "CHANGES_REQUESTED")
            .count(),
        files: view
            .files
            .into_iter()
            .map(|f| PrFile {
                path: f.path,
                additions: f.additions,
                deletions: f.deletions,
            })
            .collect(),
        checks: check_runs(view.status_check_rollup),
        review_decision: view.review_decision,
        reviews: conv.reviews,
        threads: conv.threads,
        number: view.number,
        title: view.title,
        body: view.body,
        author: view.author,
        head_ref_name: view.head_ref_name,
        base_ref_name: view.base_ref_name,
        state: view.state,
        url: view.url,
        updated_at: view.updated_at,
        mergeable: view.mergeable,
        merge_state_status: view.merge_state_status,
        is_draft: view.is_draft,
        review_requests: view.review_requests,
    }
}

// THREE gh calls, no more. `reviews` is deliberately not asked of `gh pr view`:
// that field carries no commit oid, so an approval of an earlier version could
// not be told from a current one.
pub fn pr_detail(base: &Path, number: u64) -> Result<PrDetail, String> {
    let (owner, repo) = repo_slug(base)?;
    let n = number.to_string();
    let out = gh(base, &["pr", "view", &n, "--json", PR_DETAIL_FIELDS])?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_read_failed"));
    }
    let view: GhPrView =
        serde_json::from_slice(&out.stdout).map_err(|_| "err.pr_read_failed".to_string())?;
    let conv = pr_conversation(base, &owner, &repo, number)?;
    let detail = detail_from(view, conv);
    info!(
        target: "review",
        pr = number,
        files = detail.files.len(),
        threads = detail.threads.len(),
        "review read"
    );
    Ok(detail)
}

// The proposed change itself, through the same parser the working tree uses.
pub fn pr_diff(base: &Path, number: u64) -> Result<Vec<FileDiff>, String> {
    let n = number.to_string();
    let out = gh(base, &["pr", "diff", &n])?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_read_failed"));
    }
    let files = crate::diff::parse_unified_diff(&String::from_utf8_lossy(&out.stdout));
    info!(target: "review", pr = number, files = files.len(), "review read");
    Ok(files)
}

// ---- deciding on a review ---------------------------------------------------

// Typed, so an unknown value fails at DESERIALIZATION — before any subprocess
// runs. No string ever reaches gh unvalidated, and no `err.*_invalid_action`
// code is needed.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAction {
    Approve,
    RequestChanges,
    Comment,
}

impl ReviewAction {
    fn flag(&self) -> &'static str {
        match self {
            ReviewAction::Approve => "--approve",
            ReviewAction::RequestChanges => "--request-changes",
            ReviewAction::Comment => "--comment",
        }
    }
}

pub fn pr_review(base: &Path, number: u64, action: ReviewAction, body: &str) -> Result<(), String> {
    // The backend refuses on its own instead of leaning on the UI's toast:
    // asking for changes with nothing written is not a decision anyone can act on.
    if action != ReviewAction::Approve && body.trim().is_empty() {
        return Err("err.pr_review_body_required".into());
    }
    let n = number.to_string();
    let mut args: Vec<&str> = vec!["pr", "review", &n, action.flag()];
    if !body.trim().is_empty() {
        args.push("--body");
        args.push(body);
    }
    let out = gh(base, &args)?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_review_failed"));
    }
    info!(target: "review", pr = number, decision = action.flag(), "decision sent");
    Ok(())
}

// Squash, because the copy promises that merging creates THE version in the
// official knowledge (singular), and --delete-branch because it promises the
// draft is closed.
//
// Guard: --delete-branch makes gh check out the default branch when the user is
// standing on the head branch, so a dirty tree is refused FIRST with the
// existing code whose pt-BR text already names the remedy. Otherwise the merge
// would either fail mid-way or move the tree under the user — the same
// refuse-before-you-move rule `switch_branch` obeys.
//
// Named, so the refusal AND its scope are both testable without gh: refusing a
// merge the user is not standing in would block a landing for no reason.
fn merge_would_move_the_working_tree(base: &Path, head_ref: &str) -> bool {
    current_branch(base).as_deref() == Some(head_ref) && is_dirty(base)
}

pub fn pr_merge(base: &Path, number: u64, head_ref: &str) -> Result<(), String> {
    if merge_would_move_the_working_tree(base, head_ref) {
        return Err("err.working_tree_dirty".into());
    }
    let n = number.to_string();
    let out = gh(base, &["pr", "merge", &n, "--squash", "--delete-branch"])?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_merge_failed"));
    }
    info!(target: "review", pr = number, "merged into the official knowledge");
    Ok(())
}

// {owner}/{repo} are gh's own REST placeholders, so no slug round trip is needed.
pub fn pr_reply(base: &Path, number: u64, comment_id: u64, body: &str) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("err.pr_review_body_required".into());
    }
    let route = format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments/{comment_id}/replies");
    let field = format!("body={body}");
    let out = gh(base, &["api", "--method", "POST", &route, "-f", &field])?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_reply_failed"));
    }
    // BR-8: the number of the review is enough to trace the event. Neither the
    // thread's id nor a single character of what was written is logged.
    info!(target: "review", pr = number, "reply sent");
    Ok(())
}

// ---- the team's review template ---------------------------------------------
// A review description is written against the team's own template, so its `## `
// headings ARE its structure. The rule lives here, once, instead of once in Rust
// and once in the screen's JS.

fn strip_html_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("<!--") {
        out.push_str(&rest[..i]);
        rest = match rest[i..].find("-->") {
            Some(j) => &rest[i + j + 3..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

// The FIRST guidance comment of a block, as one line: the sentence that sits
// under the heading is what the field's placeholder says. Only the first, because
// a template can carry a note of its own further down (a team's link to its
// review checklist), and joining them printed that note inside the placeholder of
// the field above it. A placeholder with newlines is not a placeholder either, so
// the whitespace is collapsed here — once — instead of on the screen.
fn html_comment_text(s: &str) -> String {
    let mut rest = s;
    while let Some(i) = rest.find("<!--") {
        let after = &rest[i + 4..];
        let (inner, tail) = match after.find("-->") {
            Some(j) => (&after[..j], &after[j + 3..]),
            None => (after, ""),
        };
        let one = inner.split_whitespace().collect::<Vec<_>>().join(" ");
        if !one.is_empty() {
            return one;
        }
        rest = tail;
    }
    String::new()
}

// The template as the TEAM wrote it: the block before the first `## ` heading
// (an H1, a welcome paragraph — the frame the sheet never shows) and, per
// heading, its label with the lines under it VERBATIM. Both projections below are
// built from this one walk, so the reader and the writer can never disagree about
// what a section is — and the writer can put back what it was never shown.
struct RawSection {
    label: String,
    body: String,
}

fn split_raw_sections(md: &str) -> (String, Vec<RawSection>) {
    let mut preamble: Vec<String> = Vec::new();
    let mut out: Vec<RawSection> = Vec::new();
    let mut buf: Vec<String> = Vec::new();
    let mut label: Option<String> = None;
    let mut fenced = false;
    for line in md.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
        } else if !fenced {
            if let Some(h) = t.strip_prefix("## ") {
                match label.take() {
                    Some(l) => out.push(RawSection {
                        label: l,
                        body: buf.join("\n"),
                    }),
                    None => preamble = std::mem::take(&mut buf),
                }
                buf = Vec::new();
                label = Some(h.trim().to_string());
                continue;
            }
        }
        buf.push(line.to_string());
    }
    match label {
        Some(l) => out.push(RawSection {
            label: l,
            body: buf.join("\n"),
        }),
        None => preamble = buf,
    }
    (preamble.join("\n"), out)
}

pub fn pr_body_sections(md: &str) -> Vec<PrSection> {
    let (preamble, raw) = split_raw_sections(md);
    // No heading at all is not one nameless section: it is a description with no
    // structure, and the screen renders it whole.
    if raw.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<PrSection> = Vec::new();
    let text = strip_html_comments(&preamble).trim().to_string();
    if !text.is_empty() {
        out.push(PrSection {
            label: String::new(),
            text,
            hint: html_comment_text(&preamble),
        });
    }
    for s in raw {
        out.push(PrSection {
            label: s.label,
            text: strip_html_comments(&s.body).trim().to_string(),
            hint: html_comment_text(&s.body),
        });
    }
    out
}

// What a field in the send-for-review sheet needs: its label AND the sentence
// that says what to write in it. Built in ONE walk and returned as a pair,
// because two lists the caller has to keep aligned are two lists that drift.
pub fn pr_template_fields(md: &str) -> (Vec<String>, Vec<String>) {
    pr_body_sections(md)
        .into_iter()
        .filter(|s| !s.label.is_empty())
        .map(|s| (s.label, s.hint))
        .unzip()
}

// Rewriting the team's template from a list of labels must not delete what the
// sheet never showed. The sheet shows LABELS, so everything else in the file is
// content this control was never given a chance to display: the guidance line
// under each heading (which is what the field's placeholder says), an H1, a
// welcome paragraph, a link to the team's own checklist. A section the edit kept
// is therefore written back with its block untouched, and the block before the
// first heading stays at the top; only a section the person removed goes, and a
// section they added arrives empty. `previous` is the file as it stands.
pub fn render_pr_body_template(labels: &[String], previous: &str) -> String {
    let (preamble, kept) = split_raw_sections(previous);
    let mut out = String::new();
    let frame = trim_trailing_blank_lines(&preamble);
    if !frame.is_empty() {
        out.push_str(&frame);
        out.push_str("\n\n");
    }
    for l in labels {
        let label = l.trim();
        let body = kept
            .iter()
            .find(|s| s.label == label)
            .map(|s| trim_trailing_blank_lines(&s.body))
            .unwrap_or_default();
        out.push_str(&format!("## {label}\n"));
        if !body.is_empty() {
            out.push_str(&body);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

fn trim_trailing_blank_lines(s: &str) -> String {
    s.trim_end_matches(['\n', '\r', ' ', '\t']).to_string()
}

// ---- write flow: Versionar (local) then Propor (remote + PR) ---------------

// ASCII-only branch slug ([a-z0-9-], no leading dash). Security: the sanitized
// value is the only user input in the branch name, so it can never be read as a
// flag or a shell metachar.
pub fn sanitize_slug(s: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let slug: String = out.trim_matches('-').chars().take(50).collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        return Err("err.change_description_required".into());
    }
    Ok(slug)
}

pub fn current_branch(base: &Path) -> Option<String> {
    let out = crate::proc::command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(base)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty() && s != "HEAD").then_some(s)
}

// Does HEAD resolve to a commit? False on a repo that was only `git init`ed:
// its default branch is UNBORN, so no ref points at anything yet.
fn head_commit_exists(base: &Path) -> bool {
    crate::proc::command("git")
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .current_dir(base)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// What the baseline commit contains.
// `Seeded`: the acervo exactly as setup created it — the official starting point
// of the knowledge, so a later draft carries only the user's own changes.
// `Empty`: a repo that reached the versioning flow with no baseline at all (it
// was created before this rule). Its whole working tree IS the version the user
// is saving right now, so the baseline takes nothing and the draft keeps every
// change to propose.
pub enum Baseline {
    Seeded,
    Empty,
}

// The project's official branch has to EXIST before the first draft: on an
// unborn repo `git checkout -b rfc/<slug>` renames the unborn branch instead of
// branching off it, so the default branch is never created — the branch picker
// calls a non-existent branch the default, switching to it fails, the sync can
// never fast-forward, and the promise "quando o time aprova, vira oficial" has
// nothing to become official into. Idempotent: a no-op once HEAD has a commit.
pub fn ensure_baseline_commit(base: &Path, kind: Baseline) -> Result<(), String> {
    if head_commit_exists(base) {
        return Ok(());
    }
    // Name the unborn branch after the default THIS app resolves, so the branch
    // the picker labels "(principal)" is the one on disk whatever the machine's
    // init.defaultBranch happens to be.
    let default = local_default_branch(base);
    let _ = crate::proc::command("git")
        .args(["symbolic-ref", "HEAD", &format!("refs/heads/{default}")])
        .current_dir(base)
        .output();
    match kind {
        Baseline::Seeded => stage_and_commit(base, BASELINE_MESSAGE.into()).map(|_| ()),
        Baseline::Empty => commit_empty_baseline(base),
    }
}

// The timeline prints commit subjects verbatim, so the baseline names itself in
// the user's words (DESIGN.md §4: acervo → projeto).
const BASELINE_MESSAGE: &str = "base do projeto";

fn commit_empty_baseline(base: &Path) -> Result<(), String> {
    let (name, email) = git_identity(base);
    let mut args = identity_args(name.as_deref(), email.as_deref());
    args.push("-c".into());
    args.push("commit.gpgsign=false".into());
    args.push("commit".into());
    args.push("--allow-empty".into());
    args.push("-m".into());
    args.push(BASELINE_MESSAGE.into());
    let out = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// Versionar step 1: create (or switch to) rfc/<slug>.
//
// A draft starts from the work in front of the user. With pending edits the new
// draft branches off HEAD, never off the default branch: `checkout -b <new>
// <default>` moves those edits onto another base, so a version already saved on
// the current draft disappears from the open document (and, when the same file
// is touched twice, git refuses the checkout altogether).
//
// With a clean tree the draft starts from the locally-resolved default so it
// stays independent of the draft the user happens to be on (ADR-0002 §2; the
// propose path still asks gh for the authoritative default) — but ONLY while that
// changes nothing on disk. ADR-0027: on a project whose knowledge lives on a
// draft (every project until a review lands, because `Baseline::Empty` commits
// nothing), the default branch is an empty room, so naming a new draft took every
// document, `.github/` and the `.gitignore` off the disk. The screen went empty,
// the sidebar said the knowledge had never been created, and «mudanças de agora»
// filled with rows nobody wrote. Naming a draft is not a price the user agreed to
// pay, so a draft that would cost a single byte starts from HEAD — which is what
// the copy already promises ("um rascunho novo leva a mudança com você").
pub fn create_branch(base: &Path, slug: &str) -> Result<String, String> {
    git_init_repo(base)?;
    ensure_baseline_commit(base, Baseline::Empty)?;
    let branch = format!("rfc/{slug}");
    if current_branch(base).as_deref() == Some(branch.as_str()) {
        return Ok(branch);
    }
    // `None` = branch off HEAD, i.e. off the work in front of the user.
    let start: Option<String> = if is_dirty(base) {
        None
    } else {
        let default = local_default_branch(base);
        (ref_exists(base, &format!("refs/heads/{default}"))
            && move_is_invisible_on_disk(base, &default))
        .then_some(default)
    };
    let mut args: Vec<&str> = vec!["checkout", "-b", &branch];
    if let Some(start) = start.as_deref() {
        args.push(start);
    }
    let create = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if create.status.success() {
        return Ok(branch);
    }
    // branch already exists → switch to it (append more commits to the same RFC)
    let switch = crate::proc::command("git")
        .args(["checkout", &branch])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if switch.status.success() {
        return Ok(branch);
    }
    // The one failure left that the user can act on is pending work blocking the
    // checkout: say it as a code the UI translates, instead of forwarding git's
    // raw multi-line English into a toast.
    if is_dirty(base) {
        Err("err.working_tree_dirty".into())
    } else {
        Err(String::from_utf8_lossy(&create.stderr).trim().to_string())
    }
}

// Pushing the draft is what an OPEN review reads: the commit the team sees is
// the one on the remote branch, so this is also the whole of "update the review"
// (ADR-0027). A transport failure takes the same code as everywhere else instead
// of putting git's English into a pt-BR toast.
pub fn push_branch(base: &Path, branch: &str) -> Result<(), String> {
    let out = crate::proc::command("git")
        .args(["push", "-u", "origin", branch])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if looks_offline(&err) {
        return Err("err.github_unreachable".into());
    }
    Err(err.trim().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub number: u64,
    pub url: String,
    // The draft already had an open review and this act pushed the new version
    // INTO it, instead of opening a second one. The screen says a different
    // sentence for each outcome, so the fact travels with the number.
    pub updated: bool,
}

// What "enviar para revisão do time" must do, decided before any process runs.
// A draft that is already under review cannot get a second one: `gh pr create`
// answers that with English prose, which is how the only failure path the author
// had came back untranslated (ADR-0027). Pure, so the decision has a test
// without gh — and `Create` is the only door to `pr_create`.
pub enum ProposeAct {
    Create,
    UpdateOpenReview { number: u64, url: String },
}

pub fn propose_act(prs: &[PrInfo], branch: &str) -> ProposeAct {
    let open = prs.iter().find(|p| {
        p.head_ref_name == branch
            && p.state
                .as_deref()
                .map(|s| s.eq_ignore_ascii_case("open"))
                .unwrap_or(true)
    });
    match open {
        Some(p) => ProposeAct::UpdateOpenReview {
            number: p.number,
            url: p.url.clone(),
        },
        None => ProposeAct::Create,
    }
}

// The open reviews of ONE draft. `--head` is gh's own filter, so the answer does
// not depend on the 50-row window `pr_list` reads.
pub fn open_reviews_for_branch(base: &Path, branch: &str) -> Result<Vec<PrInfo>, String> {
    let out = gh(
        base,
        &[
            "pr", "list", "--head", branch, "--state", "open", "--json", PR_FIELDS,
        ],
    )?;
    if !out.status.success() {
        return Err(gh_failure(&out, "err.pr_read_failed"));
    }
    serde_json::from_slice(&out.stdout).map_err(|_| "err.pr_read_failed".to_string())
}

// Propor step 2: open the PR (the RFC). title/body are positional args (no
// shell); body carries the filled PR template.
pub fn pr_create(base: &Path, branch: &str, title: &str, body: &str) -> Result<PrRef, String> {
    let out = gh(
        base,
        &[
            "pr", "create", "--head", branch, "--title", title, "--body", body,
        ],
    )?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if looks_offline(&err) {
            return Err("err.github_unreachable".into());
        }
        return Err(err.trim().to_string());
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(PrRef {
        number,
        url,
        updated: false,
    })
}

pub fn git_available() -> bool {
    which("git").is_some()
}

// BR: the queue and other ephemeral sources NEVER enter default versioning.
// ADR-0013: the whole Brainstorming world (`brainstorming/`) is quarantined by
// this single entry — one gitignore line disjoints it from the versioned tree.
// The legacy `pessoal/` line stays as a safety belt for acervos not yet migrated
// (ADR-0009 named that world `pessoal/`); either line alone quarantines its world.
// Owner decision (2026-07-28): root `notes/` is personal too — the `/notes/`
// pattern is anchored so only the acervo-root folder is ignored, never a
// `notes/` that a context might legitimately version.
// ADR-0026 §14 renamed these folders, and the legacy names stay for the same
// reason `pessoal/` does: an acervo that has not been migrated still has
// `reunioes/` on disk, and a .gitignore written by the new version would stop
// quarantining it — which is how a raw transcript reaches a versioned tree (BR-8).
// ADR-0027: the intake's own bookkeeping joins the same local world. Every
// intake run rewrites `.brain/state.json` and appends to `.brain/activity.log`
// (the acervo instructions, templates.rs step 4), so versioning them put two
// rows the person never wrote at the top of «o que você mudou» on every single
// run. Their inputs (`inbox/`) and outputs (`processed/`) are already
// quarantined, which leaves nothing for a teammate to read in either file — and
// the activity log is prose an agent wrote over raw queue items, so pushing it
// is one more route from a transcript to a shared remote (BR-8).
pub const GIT_IGNORED: [&str; 12] = [
    ".DS_Store",
    "inbox/",
    "processed/",
    "meetings/",
    "/notes/",
    "reunioes/",
    "/notas/",
    ".brain/prompt-history/",
    ".brain/state.json",
    ".brain/activity.log",
    "brainstorming/",
    "pessoal/",
];

// ADR-0009/0013 write guard: meeting audio, the transcript (`reuniao.md`) and the
// content-bearing audit (`audit.jsonl`) must NEVER enter the versioned tree.
// True when `rel` (acervo-relative, forward slashes) is such an artifact under
// `contexts/`. Pure so the quarantine is unit-testable without a git repo.
pub fn is_versioning_denied(rel: &str) -> bool {
    let r = rel.trim_start_matches("./").replace('\\', "/");
    // ADR-0026 §14 renamed both the folder and the transcript. The guard has to
    // know EVERY spelling: it is the last thing between a raw transcript and a
    // pushed repository (BR-8), and it fails open — an unmatched name is allowed.
    if !(r.starts_with("contexts/") || r.starts_with("contextos/")) {
        return false;
    }
    let lower = r.to_ascii_lowercase();
    let leaf = r.rsplit('/').next().unwrap_or(&r);
    lower.ends_with(".wav")
        || lower.ends_with(".webm")
        || leaf == crate::meeting::LIVING_FILE
        || leaf == "reuniao.md"
        || leaf == "audit.jsonl"
        || leaf == "auditoria.jsonl"
}

// Is this path quarantined by the acervo's own ignore list? The WRITE path can
// trust `.gitignore` because it rewrites it first (`ensure_gitignore` runs inside
// `stage_and_commit`); a READ path cannot — a read that writes the tree is not a
// read. And the file on disk was written by whatever release created the acervo,
// so every install upgraded to this one still carries the previous list until
// something else happens to save. That gap is how `.brain/state.json` and
// `.brain/activity.log` opened «o que você mudou» with two rows the person never
// wrote (ADR-0027). Pure, so the quarantine is testable without a repository.
pub fn is_quarantined(rel: &str) -> bool {
    let r = rel.trim_start_matches("./").replace('\\', "/");
    GIT_IGNORED.iter().any(|pat| matches_ignore(pat, &r))
}

// The subset of gitignore syntax `GIT_IGNORED` uses, and no more: a bare name
// matches at any depth, a trailing `/` matches a directory (never a file with
// that name), and a pattern that carries a slash is anchored at the acervo root.
fn matches_ignore(pattern: &str, rel: &str) -> bool {
    let dir_only = pattern.ends_with('/');
    let pat = pattern.trim_matches('/');
    if pat.is_empty() {
        return false;
    }
    if pattern.starts_with('/') || pat.contains('/') {
        return (rel == pat && !dir_only) || rel.starts_with(&format!("{pat}/"));
    }
    let segments: Vec<&str> = rel.split('/').collect();
    let last = segments.len().saturating_sub(1);
    segments
        .iter()
        .enumerate()
        .any(|(i, s)| *s == pat && (!dir_only || i < last))
}

// A line of `git status --porcelain` as the two things every caller wants: the
// status code and the path the content is at now (a rename comes as `old -> new`).
struct PendingEntry {
    code: String,
    path: String,
}

fn parse_porcelain_line(line: &str) -> Option<PendingEntry> {
    if line.len() < 4 {
        return None;
    }
    let code = line[..2].trim().to_string();
    let rest = &line[3..];
    // Only a rename/copy line carries `old -> new`; splitting every line on it
    // would rewrite the path of a document whose own NAME contains that string.
    let path = if code.starts_with('R') || code.starts_with('C') {
        rest.rsplit(" -> ").next().unwrap_or(rest)
    } else {
        rest
    };
    let path = path.trim_matches('"').to_string();
    if path.is_empty() {
        return None;
    }
    Some(PendingEntry { code, path })
}

// ONE reading of "what is pending", past the quarantine. Four surfaces ask it —
// the count on the tab, the cards on «o que você mudou», the sidebar's markers
// and the refusal that guards a draft switch — and four answers that can disagree
// are four ways for the screen to lie (DESIGN.md §1). `-uall` because the cards
// are per file: a collapsed `?? .brain/` would count one row the list never draws.
fn pending_entries(base: &Path) -> Vec<PendingEntry> {
    let out = crate::proc::command("git")
        .args([
            "-c",
            "core.quotePath=false",
            "status",
            "--porcelain",
            "-uall",
        ])
        .current_dir(base)
        .output();
    let Ok(out) = out else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_porcelain_line)
        // A UNTRACKED path that no version will ever carry is not pending work.
        // Two families of those: the quarantined folders (GIT_IGNORED), and the
        // material `is_versioning_denied` refuses INSIDE contexts/ — a raw
        // transcript or audio, which no ignore pattern can cover because the folder
        // around it is versioned. Counting the second one was a permanent phantom:
        // `working_diff` filters it, so it had no card; `pending_changes` counted
        // it, so the save button stayed armed and «tudo salvo» was on screen at the
        // same time; and `pr_merge` refused with err.working_tree_dirty forever.
        //
        // Still TRACKED, it IS pending work for exactly one version — the one that
        // takes it out of the index (`unstage_versioning_denied`, which untracks
        // rather than unstages). After that it lands in the case above.
        .filter(|e| e.code != "??" || !(is_quarantined(&e.path) || is_versioning_denied(&e.path)))
        .collect()
}

// Idempotent: guarantees the ignore entries exist in the acervo's .gitignore
// (covers repos initialized before this rule, or hand-made ones).
pub fn ensure_gitignore(base: &Path) -> Result<(), String> {
    let gi = base.join(".gitignore");
    let cur = std::fs::read_to_string(&gi).unwrap_or_default();
    let mut out = cur.clone();
    for entry in GIT_IGNORED {
        if !cur.lines().any(|l| l.trim() == entry) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(entry);
            out.push('\n');
        }
    }
    if out != cur {
        std::fs::write(&gi, out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn git_init_repo(base: &Path) -> Result<(), String> {
    if !git_available() {
        return Err("err.git_not_found".into());
    }
    ensure_gitignore(base)?;
    if base.join(".git").is_dir() {
        return Ok(());
    }
    let out = crate::proc::command("git")
        .arg("init")
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    available: bool,
    repo: bool,
    pending: usize,
    branch: Option<String>,
}

// How many changes a version would carry. ONE authority: the number the button
// counts is the same one the save flow asks before deciding there is anything to
// save, so the label ("tudo salvo ✓") and the refusal can never disagree.
pub fn pending_changes(base: &Path) -> usize {
    pending_entries(base).len()
}

#[tauri::command]
pub fn brain_git_state() -> GitState {
    let available = git_available();
    let base = read_brain_config().map(|c| PathBuf::from(c.brain_dir));
    let repo = base
        .as_ref()
        .map(|b| b.join(".git").is_dir())
        .unwrap_or(false);
    let pending = if available && repo {
        base.as_ref().map(|b| pending_changes(b)).unwrap_or(0)
    } else {
        0
    };
    let branch = if available && repo {
        base.as_ref().and_then(|b| current_branch(b))
    } else {
        None
    };
    GitState {
        available,
        repo,
        pending,
        branch,
    }
}

// Per-file git status (VSCode-like colors in the tree). Maps acervo-relative
// path -> porcelain code ("M", "??", "A", "D"…). Empty when there is no repo.
#[derive(serde::Serialize)]
pub struct GitFiles {
    repo: bool,
    files: HashMap<String, String>,
}

#[tauri::command]
pub fn brain_git_files() -> GitFiles {
    let base = read_brain_config().map(|c| PathBuf::from(c.brain_dir));
    let repo = base
        .as_ref()
        .map(|b| b.join(".git").is_dir())
        .unwrap_or(false);
    let mut files = HashMap::new();
    if repo && git_available() {
        if let Some(b) = base {
            // Same authority as the count and the cards: a marker on a document
            // the review screen does not list is a marker that lies.
            for e in pending_entries(&b) {
                files.insert(e.path, e.code);
            }
        }
    }
    GitFiles { repo, files }
}

// Manual "version now": stage everything and commit (BR: user drives push).
#[tauri::command]
pub fn brain_git_commit(message: String) -> Result<String, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    stage_and_commit(&base, message)
}

// What a save attempt DID, as a fact the screen can read. The result used to be
// a pt-BR sentence ("nada para versionar") the app never looked at, so it
// toasted "versão salva" over a commit that never happened.
pub struct VersionAttempt {
    pub branch: String,
    pub saved: bool,
    pub warn: Option<String>,
    // A revisão que ESTA versão atualizou, e se o empurrão chegou. O commit é
    // local e não pode se perder porque a rede caiu, então os dois fatos são
    // separados: `review` diz que havia uma revisão aberta neste rascunho,
    // `pushed` diz se ela já viu a versão nova.
    pub review: Option<u64>,
    pub pushed: bool,
}

// Sync outcomes the user should see as a warning (the flow still proceeds —
// branch-first degrades, ADR-0002 §2). NoRemote is the pure-local case: no warn.
fn sync_warn(outcome: &SyncOutcome) -> Option<String> {
    match outcome {
        SyncOutcome::Offline => Some("err.git_offline".into()),
        SyncOutcome::Diverged => Some("err.main_diverged".into()),
        _ => None,
    }
}

// "Salvar versão", whole: refuse a no-op, sync the default branch (best effort),
// open the draft and commit the work there.
//
// Lives here (not in the Tauri wrapper) because the decisions it takes are
// domain rules, and a rule with no test is how the app came to announce versions
// that did not exist.
pub fn save_version(base: &Path, slug: &str, message: String) -> Result<VersionAttempt, String> {
    // N3 · nothing pending is not a version. Asked BEFORE the network sync and
    // before any draft is created, so a no-op costs no ~10s fetch, leaves no
    // empty draft behind and moves nobody onto another draft.
    if base.join(".git").is_dir() && pending_changes(base) == 0 {
        return Ok(VersionAttempt {
            branch: current_branch(base).unwrap_or_default(),
            saved: false,
            warn: None,
            review: None,
            pushed: false,
        });
    }
    let warn = sync_warn(&sync_default_branch(base));
    // A VERSÃO CAI ONDE VOCÊ ESTÁ. Isto chamava `create_branch` sempre, e
    // `create_branch` é `git checkout -b rfc/<slug>`: parado num branch que não
    // começa com `rfc/` — o caso NORMAL de um repositório de time, como
    // `feat/acervo-navegavel` — salvar te MOVIA para um rascunho novo, e a revisão
    // aberta daquele branch nunca via a versão. A tela chegou a dizer as duas coisas
    // ao mesmo tempo («salvar cria um rascunho» e «salvar atualiza a revisão
    // aberta»), e a primeira era a verdadeira.
    //
    // Só do CONHECIMENTO OFICIAL é que salvar cria um rascunho — é lá que ele
    // precisa nascer, porque o oficial não recebe commit direto.
    git_init_repo(base)?;
    ensure_baseline_commit(base, Baseline::Empty)?;
    let default = local_default_branch(base);
    let branch = match current_branch(base) {
        Some(cur) if cur != default => cur,
        _ => create_branch(base, slug)?,
    };
    let result = stage_and_commit(base, message)?;
    let saved = result == OUTCOME_VERSIONED;
    // UM PASSO, NÃO DOIS, quando o rascunho já está em revisão. A tela promete
    // «salvar versão atualiza a revisão aberta» desde a primeira rodada e nada
    // empurrava: o commit ficava neste computador e o time seguia lendo a versão
    // anterior. Enviar deixa de ser um passo separado justamente porque não é um —
    // a revisão já existe, e o que falta é ela ver o que acabou de ser salvo.
    //
    // Para um rascunho SEM revisão aberta nada é empurrado: «nada sai do seu
    // computador sozinho» continua valendo, e enviar continua sendo a decisão de
    // compartilhar. O empurrão é consequência de uma decisão que já foi tomada.
    let (review, pushed) = match open_review_to_update(base, &branch, saved) {
        Some(number) => (Some(number), push_branch(base, &branch).is_ok()),
        None => (None, false),
    };
    Ok(VersionAttempt {
        branch,
        saved,
        warn,
        review,
        pushed,
    })
}

// Só vale perguntar ao remote quando há versão nova para ele ver, e só quando o
// ambiente do time existe: sem gh, sem autenticação ou sem remote a resposta é
// «não há revisão aberta a atualizar», sem gastar processo nenhum.
fn open_review_to_update(base: &Path, branch: &str, saved: bool) -> Option<u64> {
    if !saved || !gh_available() || !gh_authed() || git_remote_url(base).is_none() {
        return None;
    }
    let prs = open_reviews_for_branch(base, branch).ok()?;
    match propose_act(&prs, branch) {
        ProposeAct::UpdateOpenReview { number, .. } => Some(number),
        ProposeAct::Create => None,
    }
}

// The `-c` overrides a version is committed with. Command-line `-c` has the
// HIGHEST precedence in git, so passing an identity unconditionally does not
// "fall back": it OVERRIDES the one the doctor's "identidade git" fix just set,
// every version ends up authored by a bot, and the review flow loses who
// proposed what. Only the half git cannot resolve is filled in, so a machine
// with no identity at all still commits.
fn identity_args(name: Option<&str>, email: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if name.is_none() {
        args.push("-c".into());
        args.push("user.name=Loro".into());
    }
    if email.is_none() {
        args.push("-c".into());
        args.push("user.email=loro@localhost".into());
    }
    args
}

// The two outcomes of a commit attempt, as STABLE codes. They are not sentences
// for the user: the screen decides what to say from the fact, in its own
// language (CLAUDE.md §6 — a pt-BR sentence from the backend is not a msgid).
pub const OUTCOME_VERSIONED: &str = "versionado";
pub const OUTCOME_NOTHING: &str = "nada-a-versionar";

// Core of "version now", reused by the two-button flow (Versionar/Propor):
// ensure ephemeral sources stay untracked, stage everything else, commit with the
// user's git identity (falling back only for what the machine does not define).
pub fn stage_and_commit(base: &Path, message: String) -> Result<String, String> {
    if !base.join(".git").is_dir() {
        git_init_repo(base)?;
    }
    // queue/sources never enter default versioning: guarantee the ignore rules
    // and untrack anything previously indexed (files stay on disk)
    ensure_gitignore(base)?;
    let _ = crate::proc::command("git")
        .args([
            "rm",
            "-r",
            "--cached",
            "--ignore-unmatch",
            "-q",
            "inbox",
            "processed",
            "meetings",
            "notes",
            // ADR-0026 §14: .gitignore does not apply to a file already tracked,
            // so an acervo that has not migrated needs its OLD names untracked too
            "reunioes",
            "notas",
            ".brain/prompt-history",
            // ADR-0027: an acervo versioned before the rule carries the intake's
            // bookkeeping in its tree, and .gitignore does not apply to a tracked
            // file — the next version is what takes them out (they stay on disk).
            ".brain/state.json",
            ".brain/activity.log",
            "brainstorming",
            "pessoal",
        ])
        .current_dir(base)
        .output();
    let add = crate::proc::command("git")
        .args(["add", "-A"])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).to_string());
    }
    // ADR-0009 write guard: unstage any meeting audio/transcript/audit that
    // slipped under contexts/ (files stay on disk; they just never get committed).
    unstage_versioning_denied(base);
    let msg = if message.trim().is_empty() {
        "acervo: versionar".to_string()
    } else {
        message
    };
    let (name, email) = git_identity(base);
    let mut args = identity_args(name.as_deref(), email.as_deref());
    // no TTY for a passphrase inside the app: users with commit.gpgsign=true
    // would otherwise fail on every version
    args.push("-c".into());
    args.push("commit.gpgsign=false".into());
    args.push("commit".into());
    args.push("-m".into());
    args.push(msg);
    let out = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        if err.contains("nothing to commit") {
            return Ok(OUTCOME_NOTHING.into());
        }
        return Err(err.trim().to_string());
    }
    Ok(OUTCOME_VERSIONED.into())
}

// Reset from the index every staged path the ADR-0009 quarantine denies. Reads
// the staged set (`git diff --cached --name-only`) and unstages the matches with
// isolated positional args (no shell).
fn unstage_versioning_denied(base: &Path) {
    let Ok(out) = crate::proc::command("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(base)
        .output()
    else {
        return;
    };
    for rel in String::from_utf8_lossy(&out.stdout).lines() {
        if is_versioning_denied(rel) {
            // `reset` DESESTAGIA e o caminho continua rastreado, então a versão
            // seguinte o encontrava modificado de novo — para sempre. `rm --cached`
            // é o mesmo mecanismo que `stage_and_commit` já usa para o que nunca
            // pode ser versionado: sai do índice, fica no disco. Assim uma versão
            // resolve, em vez de recomeçar.
            let _ = crate::proc::command("git")
                .args(["rm", "--cached", "--ignore-unmatch", "-q", "--", rel])
                .current_dir(base)
                .output();
        }
    }
}

#[cfg(test)]
mod tests {

    // ADR-0026 §14 — renaming the folders must not un-quarantine anything. Both
    // spellings are ignored: the new one for a migrated acervo, the old one for a
    // clone that has not migrated yet. A transcript in a versioned tree is BR-8.
    #[test]
    fn both_spellings_of_the_ephemeral_folders_stay_quarantined() {
        for entry in ["meetings/", "/notes/", "reunioes/", "/notas/"] {
            assert!(
                GIT_IGNORED.contains(&entry),
                "{entry} is not quarantined — a meeting record would be versioned"
            );
        }
    }
    use super::*;

    #[test]
    fn parse_semver_extracts_from_real_outputs() {
        assert_eq!(parse_semver("git version 2.50.1"), Some((2, 50, 1)));
        assert_eq!(
            parse_semver("gh version 2.83.2 (2025-12-10)"),
            Some((2, 83, 2))
        );
        assert_eq!(parse_semver("sem versao aqui"), None);
    }

    #[test]
    fn version_meets_compares_major_minor() {
        assert!(version_meets((2, 50, 1), (2, 20)));
        assert!(version_meets((3, 0, 0), (2, 20)));
        assert!(!version_meets((2, 10, 0), (2, 20)));
        assert!(!version_meets((1, 99, 0), (2, 0)));
    }

    #[test]
    fn parse_auth_protocol_reads_ssh_and_https() {
        assert_eq!(
            parse_auth_protocol("  ✓ Git operations protocol: ssh"),
            Some("ssh".into())
        );
        assert_eq!(
            parse_auth_protocol("- Git operations protocol: https"),
            Some("https".into())
        );
        assert_eq!(parse_auth_protocol("Logged in to github.com"), None);
    }

    #[test]
    fn parse_log_line_splits_on_unit_separator() {
        let c = parse_log_line("abc123\u{1f}2026-07-26T10:00:00-03:00\u{1f}Ana\u{1f}feat: x | y")
            .unwrap();
        assert_eq!(c.id, "abc123");
        assert_eq!(c.author, "Ana");
        assert_eq!(c.label, "feat: x | y"); // pipe in the subject is preserved
        assert!(parse_log_line("").is_none());
    }

    #[test]
    fn pr_info_deserializes_gh_json() {
        let json = r#"[{"number":7,"title":"RFC: frota","headRefName":"rfc/frota-x",
            "author":{"login":"ana"},"reviewDecision":"REVIEW_REQUIRED",
            "reviewRequests":[{"login":"bob"},{"name":"Time Frota","slug":"frota"}],
            "updatedAt":"2026-07-26T10:00:00Z","url":"https://github.com/x/y/pull/7","state":"OPEN"}]"#;
        let prs: Vec<PrInfo> = serde_json::from_str(json).unwrap();
        assert_eq!(prs.len(), 1);
        let p = &prs[0];
        assert_eq!(p.number, 7);
        assert_eq!(p.head_ref_name, "rfc/frota-x");
        assert_eq!(p.author.login, "ana");
        assert_eq!(p.review_decision.as_deref(), Some("REVIEW_REQUIRED"));
        assert_eq!(p.review_requests[0].handle(), Some("bob"));
        assert_eq!(p.review_requests[1].handle(), Some("frota"));
    }

    #[test]
    fn pr_info_tolerates_missing_fields() {
        // gh may omit fields; nothing should break (serde default)
        let prs: Vec<PrInfo> = serde_json::from_str(r#"[{"number":1}]"#).unwrap();
        assert_eq!(prs[0].number, 1);
        assert!(prs[0].title.is_empty());
        assert!(prs[0].review_requests.is_empty());
    }

    #[test]
    fn sanitize_slug_hardens_the_branch_name() {
        // accents (non-ASCII) become a separator — portable branch name
        assert_eq!(sanitize_slug("Nova política!").unwrap(), "nova-pol-tica");
        assert_eq!(sanitize_slug("Frota 2026").unwrap(), "frota-2026");
        assert_eq!(sanitize_slug("  --hack; rm -rf  ").unwrap(), "hack-rm-rf");
        assert!(!sanitize_slug("x").unwrap().starts_with('-'));
        // no useful characters → error (never yields an empty/unsafe branch)
        assert!(sanitize_slug("   !!!   ").is_err());
        assert!(sanitize_slug("---").is_err());
    }

    #[test]
    fn is_versioning_denied_blocks_audio_transcript_audit_under_contextos() {
        // ADR-0009: audio/transcript/audit under contexts/ are denied ...
        assert!(is_versioning_denied("contexts/frota/meetings/r1/audio.wav"));
        assert!(is_versioning_denied("contexts/frota/audio.WEBM"));
        assert!(is_versioning_denied(
            "contexts/frota/meetings/r1/reuniao.md"
        ));
        assert!(is_versioning_denied(
            "contexts/frota/meetings/r1/audit.jsonl"
        ));
        // ... but consolidated knowledge and everything outside contexts/ is fine
        assert!(!is_versioning_denied("contexts/frota/context.md"));
        assert!(!is_versioning_denied(
            "contexts/frota/referencias/chart.png"
        ));
        // ADR-0013: the non-versioned world is `brainstorming/`; legacy `pessoal/`
        // stays quarantined too — neither is under contexts/, so never denied.
        assert!(!is_versioning_denied(
            "brainstorming/x/meetings/r1/audio.wav"
        ));
        assert!(!is_versioning_denied(
            "pessoal/temas/x/meetings/r1/audio.wav"
        ));
        assert!(!is_versioning_denied("notes/reuniao.md"));
    }

    #[test]
    fn stage_and_commit_never_versions_audio_transcript_audit_or_pessoal() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = std::env::temp_dir().join(format!("loro-quar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contexts/frota/meetings/r1")).unwrap();
        std::fs::create_dir_all(root.join("brainstorming/x")).unwrap();
        std::fs::create_dir_all(root.join("pessoal/temas/x")).unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();

        std::fs::write(root.join("contexts/frota/context.md"), "conhecimento").unwrap();
        std::fs::write(root.join("contexts/frota/meetings/r1/audio.wav"), b"RIFF").unwrap();
        std::fs::write(root.join("contexts/frota/meetings/r1/reuniao.md"), "fala").unwrap();
        std::fs::write(root.join("contexts/frota/meetings/r1/audit.jsonl"), "{}\n").unwrap();
        std::fs::write(root.join("brainstorming/x/nota.md"), "brainstorming").unwrap();
        std::fs::write(root.join("pessoal/temas/x/nota.md"), "pessoal").unwrap();
        // owner decision (2026-07-28): root notes/ is personal — never versioned
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/2026-07-28-anotacao.md"), "pessoal").unwrap();

        stage_and_commit(&root, "base".into()).unwrap();

        let tracked = crate::proc::command("git")
            .args(["ls-files"])
            .current_dir(&root)
            .output()
            .unwrap();
        let files = String::from_utf8_lossy(&tracked.stdout);
        assert!(files.contains("contexts/frota/context.md"));
        assert!(!files.contains(".wav"), "audio is never versioned");
        assert!(
            !files.contains("reuniao.md"),
            "the transcript is never versioned"
        );
        assert!(
            !files.contains("audit.jsonl"),
            "the audit is never versioned"
        );
        assert!(
            !files.contains("brainstorming"),
            "the brainstorming/ world is never versioned"
        );
        assert!(
            !files.contains("pessoal"),
            "the legacy pessoal/ world is never versioned"
        );
        assert!(
            !files.contains("notes/"),
            "root notes/ is personal — never versioned"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- branch-first flow (ADR-0002 §2) fixtures --------------------------

    fn run_git(dir: &Path, args: &[&str]) -> Output {
        crate::proc::command("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
    }

    fn rev_sha(dir: &Path, r: &str) -> String {
        let out = run_git(dir, &["rev-parse", r]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn temp_repo(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("loro-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    // Repo with one commit and a deterministic default-branch name (older git
    // inits as "master"; the tests need "main").
    fn init_with_commit(root: &Path) {
        git_init_repo(root).unwrap();
        set_identity(root, "Teste", "teste@exemplo.com").unwrap();
        std::fs::write(root.join("context.md"), "base").unwrap();
        stage_and_commit(root, "base".into()).unwrap();
        run_git(root, &["branch", "-M", "main"]);
    }

    // N1 — "salvar versão" twice with different descriptions used to branch the
    // second draft off the default, which moved the pending edit onto another
    // base: the version saved a moment earlier left the open document and the
    // history, while the UI still said "versão salva / tudo salvo".
    #[test]
    fn a_new_draft_keeps_the_version_saved_on_the_current_one() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = temp_repo("draft-chain");
        init_with_commit(&root);

        std::fs::write(root.join("frota.md"), "politica de frota").unwrap();
        create_branch(&root, "politica-de-frota").unwrap();
        stage_and_commit(&root, "politica de frota".into()).unwrap();

        // a second knowledge file, described differently → another draft
        std::fs::write(root.join("mobile.md"), "nota mobile").unwrap();
        create_branch(&root, "nota-mobile").unwrap();
        stage_and_commit(&root, "nota mobile".into()).unwrap();

        assert_eq!(current_branch(&root).as_deref(), Some("rfc/nota-mobile"));
        assert_eq!(
            std::fs::read_to_string(root.join("frota.md")).ok(),
            Some("politica de frota".to_string()),
            "the document went back to its pre-version content"
        );
        let log = run_git(&root, &["log", "--oneline"]);
        let log = String::from_utf8_lossy(&log.stdout).to_string();
        assert!(
            log.contains("politica de frota"),
            "the version saved first vanished from the history: {log}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // N1 (variant) — editing the SAME file twice made git abort the checkout and
    // its raw multi-line English landed verbatim in a toast. The draft the user
    // is on keeps the work either way.
    #[test]
    fn a_second_draft_over_the_same_file_never_leaks_raw_git_english() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("draft-same-file");
        init_with_commit(&root);

        std::fs::write(root.join("context.md"), "primeira").unwrap();
        create_branch(&root, "primeira-mudanca").unwrap();
        stage_and_commit(&root, "primeira mudança".into()).unwrap();
        std::fs::write(root.join("context.md"), "segunda").unwrap();

        let branch = create_branch(&root, "segunda-mudanca")
            .unwrap_or_else(|e| panic!("versionar failed with a raw git message: {e}"));
        assert_eq!(branch, "rfc/segunda-mudanca");
        assert_eq!(
            std::fs::read_to_string(root.join("context.md")).unwrap(),
            "segunda",
            "the pending edit was thrown away by the checkout"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // N2 — a project whose repo has no commits: the first "salvar versão" used to
    // RENAME the unborn default branch, so the acervo lived on a draft forever and
    // "quando o time aprova, vira oficial" had nothing to become official into.
    #[test]
    fn the_first_version_leaves_an_official_branch_to_merge_into() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("baseline");
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        std::fs::write(root.join("context.md"), "conhecimento").unwrap();

        create_branch(&root, "primeira-mudanca").unwrap();
        let result = stage_and_commit(&root, "primeira mudança".into()).unwrap();

        assert!(
            ref_exists(&root, "refs/heads/main"),
            "no official branch exists after the first version"
        );
        assert_eq!(local_default_branch(&root), "main");
        assert_eq!(
            current_branch(&root).as_deref(),
            Some("rfc/primeira-mudanca")
        );
        // the baseline must not swallow the version the user is saving: it lands
        // on the draft, so there is something to send for review
        assert_eq!(result, "versionado");
        let tracked = run_git(
            &root,
            &["ls-tree", "-r", "--name-only", "rfc/primeira-mudanca"],
        );
        assert!(String::from_utf8_lossy(&tracked.stdout).contains("context.md"));
        // the picker's "(principal)" row has to be reachable
        switch_branch(&root, "main").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    // N2 (setup leg) — a project created with "guardar histórico" on had git init
    // and no commit, so it owned no branch at all. The baseline is the seeded
    // acervo itself: what the team's approval later makes official.
    #[test]
    fn a_seeded_project_starts_on_an_official_branch() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("seeded-baseline");
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "semente").unwrap();

        ensure_baseline_commit(&root, Baseline::Seeded).unwrap();

        assert!(ref_exists(&root, "refs/heads/main"));
        let tracked = run_git(&root, &["ls-tree", "-r", "--name-only", "main"]);
        assert!(String::from_utf8_lossy(&tracked.stdout).contains("contexts/frota/context.md"));
        assert!(
            !is_dirty(&root),
            "the seeded project starts fully versioned"
        );
        // and running setup again on the same project changes nothing
        let before = rev_sha(&root, "HEAD");
        ensure_baseline_commit(&root, Baseline::Seeded).unwrap();
        assert_eq!(rev_sha(&root, "HEAD"), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 — every version was authored by "Loro <loro@localhost>": command-line
    // `-c` wins over everything, so the identity the doctor's "corrigir" writes
    // was overridden and the timeline attributed the team's knowledge to a bot.
    #[test]
    fn a_version_is_authored_by_the_identity_the_doctor_sets() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("author");
        git_init_repo(&root).unwrap();
        set_identity(&root, "Daniela Lima", "daniela@exemplo.com.br").unwrap();
        std::fs::write(root.join("context.md"), "conhecimento").unwrap();

        stage_and_commit(&root, "primeira versão".into()).unwrap();

        let out = run_git(&root, &["log", "-1", "--format=%an <%ae>"]);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "Daniela Lima <daniela@exemplo.com.br>"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 (second leg) — the sheet used to ship its own example ("seu@email") as
    // an editable VALUE and the only check here was non-empty, so the address
    // stamped on every version the team reads could be text that is not an
    // address. The refusal lives at the boundary: the doctor row would turn ✓ on
    // an identity GitHub can never attribute to anyone.
    #[test]
    fn set_identity_refuses_an_email_that_is_not_an_address() {
        for bad in [
            "seu@email",
            "seu@email.",
            "seu@.com",
            "ana",
            "@exemplo.com",
            "ana@",
            "ana@exemplo com.br",
            "Ana <ana@exemplo.com>",
            "ana@a@exemplo.com",
        ] {
            assert!(!is_email_shaped(bad), "{bad} is not an e-mail address");
        }
        for good in [
            "ana@exemplo.com",
            "ana.souza@exemplo.com.br",
            "ana+frota@exemplo.com",
        ] {
            assert!(is_email_shaped(good), "{good} is an e-mail address");
        }
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("identity-email");
        git_init_repo(&root).unwrap();
        assert_eq!(
            set_identity(&root, "Ana", "seu@email").unwrap_err(),
            "err.git_identity_invalid_email"
        );
        // and nothing was written: a refused identity leaves the repo as it was
        // (scoped to --local; the machine's global identity is not ours to read)
        let local = |root: &Path| {
            let out = run_git(root, &["config", "--local", "user.email"]);
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        assert_eq!(local(&root), None);
        set_identity(&root, "Ana", "ana@exemplo.com").unwrap();
        assert_eq!(local(&root).as_deref(), Some("ana@exemplo.com"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 — the fallback still exists for a machine with no git identity, and it
    // never covers a half the user did define.
    #[test]
    fn only_the_identity_git_cannot_resolve_falls_back() {
        assert_eq!(
            identity_args(None, None),
            vec!["-c", "user.name=Loro", "-c", "user.email=loro@localhost"]
        );
        assert!(identity_args(Some("Daniela"), Some("d@exemplo.com.br")).is_empty());
        assert_eq!(
            identity_args(Some("Daniela"), None),
            vec!["-c", "user.email=loro@localhost"]
        );
        assert_eq!(
            identity_args(None, Some("d@exemplo.com.br")),
            vec!["-c", "user.name=Loro"]
        );
    }

    #[test]
    fn list_branches_returns_locals() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = temp_repo("branches");
        init_with_commit(&root);
        create_branch(&root, "primeira").unwrap();
        create_branch(&root, "segunda").unwrap();

        let branches = list_branches(&root).unwrap();
        for expected in ["main", "rfc/primeira", "rfc/segunda"] {
            assert!(
                branches.iter().any(|b| b == expected),
                "missing branch {expected} in {branches:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // The sibling below pinned `switch_branch`'s refusal; `pr_merge`'s — the more
    // dangerous of the two, because `gh pr merge --delete-branch` checks the
    // default branch out under a user standing on the head branch — was prose
    // only. gh is never reached: the refusal comes first, exactly like
    // a_decision_with_nothing_written_is_refused_before_gh_runs.
    #[test]
    fn pr_merge_blocks_on_dirty_working_tree_on_the_head_branch() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("merge-dirty");
        init_with_commit(&root);
        create_branch(&root, "frota").unwrap();
        std::fs::write(root.join("context.md"), "edição pendente").unwrap();
        assert_eq!(current_branch(&root).as_deref(), Some("rfc/frota"));

        let err = pr_merge(&root, 7, "rfc/frota").unwrap_err();
        assert_eq!(err, "err.working_tree_dirty");
        // and the tree the user was standing in is exactly as they left it
        assert_eq!(current_branch(&root).as_deref(), Some("rfc/frota"));
        assert_eq!(
            std::fs::read_to_string(root.join("context.md")).unwrap(),
            "edição pendente",
            "the merge moved the tree under the user"
        );

        // the refusal is scoped: pending edits on a draft the merge does not
        // check out are nobody's problem, and blocking there would strand a
        // landing that is ready
        assert!(merge_would_move_the_working_tree(&root, "rfc/frota"));
        assert!(!merge_would_move_the_working_tree(&root, "rfc/outro"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // Isto afirmava o contrário: que QUALQUER árvore suja bloqueava a troca. Era uma
    // pré-checagem mais severa que o git, e virou um beco quando salvar o arquivo
    // parou de commitar (ADR-0027 round 8) — árvore suja passou a ser o normal e o
    // seletor vivia com todas as linhas apagadas. Quem decide é o git.
    // A VERSÃO CAI ONDE VOCÊ ESTÁ. Achado pelo dono no turbo, cujo branch de trabalho
    // é `feat/acervo-navegavel`: salvar chamava `create_branch` sempre, e isso é
    // `git checkout -b rfc/<slug>` — a pessoa era MOVIDA para um rascunho novo e a
    // revisão aberta daquele branch nunca via a versão. A tela chegou a dizer as duas
    // coisas ao mesmo tempo, e a errada era a que prometia atualizar a revisão.
    // Achado na revisão do PR #71: `PR_FIELDS` ganhou `statusCheckRollup` para a
    // linha do time poder dizer que uma mudança está bloqueada, e a tradução para a
    // forma que a tela entende (`check_runs`) só era chamada no DETALHE. A lista
    // recebia o payload cru do gh, `pr.checks` era undefined, e um PR com CI
    // vermelha aparecia igual a um limpo. O teste do JS passava porque alimentava a
    // forma já normalizada — ele afirmava a regra, não o contrato.
    // Achado na revisão do PR #71 e registrado como aberto na rodada 10: num acervo
    // versionado antes da regra, um artefato de reunião RASTREADO dentro de
    // `contexts/` era fantasma permanente. `working_diff` o filtra (não há cartão),
    // `pending_changes` o contava (o botão de salvar ficava armado ao lado de «tudo
    // salvo»), `unstage_versioning_denied` o desestagiava a cada save mantendo-o
    // rastreado, e `pr_merge` recusava com err.working_tree_dirty para sempre.
    #[test]
    fn quarantined_material_inside_contexts_resolves_in_one_version() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("denied-phantom");
        init_with_commit(&root);
        // um acervo antigo: a transcrição crua foi versionada junto com o contexto
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "conhecimento\n").unwrap();
        std::fs::write(root.join("contexts/frota/reuniao.md"), "transcrição crua\n").unwrap();
        crate::proc::command("git")
            .args(["add", "-A"])
            .current_dir(&root)
            .output()
            .unwrap();
        crate::proc::command("git")
            .args(identity_args(Some("t"), Some("t@t.t")))
            .args(["commit", "-m", "legado"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(is_versioning_denied("contexts/frota/reuniao.md"));

        // a pessoa edita a transcrição (ou o app a reescreve)
        std::fs::write(
            root.join("contexts/frota/reuniao.md"),
            "outra transcrição\n",
        )
        .unwrap();
        assert!(
            pending_changes(&root) > 0,
            "rastreado e modificado É trabalho pendente"
        );

        // UMA versão resolve: sai do índice e continua no disco
        stage_and_commit(&root, "limpa o legado".into()).unwrap();
        assert!(
            root.join("contexts/frota/reuniao.md").exists(),
            "o arquivo da pessoa nunca é apagado"
        );
        let tracked = tracked_documents(&root, "HEAD");
        assert!(
            !tracked.iter().any(|p| p.ends_with("reuniao.md")),
            "a transcrição crua saiu do repositório (BR-8): {tracked:?}"
        );

        // e NÃO volta a contar: nenhuma versão futura vai levá-la
        assert_eq!(
            pending_changes(&root),
            0,
            "o fantasma voltou: o botão de salvar fica armado ao lado de «tudo salvo», \
             e pr_merge recusa para sempre"
        );
        assert!(
            !is_dirty(&root),
            "e a troca de rascunho volta a ser possível"
        );
        // o contexto de verdade continua versionado
        assert!(tracked.iter().any(|p| p.ends_with("frota/context.md")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_list_hands_the_screen_the_check_shape_the_screen_reads() {
        let raw = r#"[{"number":6,"title":"t","statusCheckRollup":[
            {"name":"VTEC","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"u"}]}]"#;
        let prs = with_normalized_checks(serde_json::from_slice(raw.as_bytes()).unwrap());
        let json = serde_json::to_string(&prs[0]).unwrap();
        assert!(
            json.contains(r#""checks":["#),
            "a chave que a tela lê: {json}"
        );
        assert!(
            json.contains(r#""state":"failed""#),
            "e o valor do PRODUTO, não o FAILURE do gh: {json}"
        );
        assert!(
            !json.contains("statusCheckRollup"),
            "a forma crua do gh não vai para a tela: {json}"
        );
        assert_eq!(prs[0].checks[0].name, "VTEC");
        // e um PR sem CI nenhum entrega lista vazia, nunca ausência de campo
        let none = with_normalized_checks(serde_json::from_slice(br#"[{"number":7}]"#).unwrap());
        assert!(serde_json::to_string(&none[0])
            .unwrap()
            .contains(r#""checks":[]"#));

        // E A FIAÇÃO. A primeira versão deste teste refazia a tradução ELE MESMO, então
        // arrancá-la de `pr_list` não o fazia reprovar — a mesma armadilha que a
        // revisão do PR #71 apontou no teste da R62. Os dois caminhos que trazem
        // PrInfo do remote têm de passar pela função.
        let src = include_str!("git.rs");
        for f in ["pub fn pr_list(", "pub fn pr_status("] {
            let at = src.find(f).expect(f);
            let body = &src[at..at + src[at..].find("\n}").unwrap()];
            assert!(
                body.contains("with_normalized_checks"),
                "{f} entrega o payload cru do gh para a tela"
            );
        }
    }

    // Mesma família: `PR_DETAIL_FIELDS` pedia `reviewDecision` desde o começo e
    // NENHUMA struct o carregava, então o guarda do «0 de 0 aprovações» via
    // undefined e a tela seguia dizendo que a conta fechou num PR que o GitHub
    // bloqueia.
    #[test]
    fn the_open_review_carries_the_decision_the_remote_gave() {
        assert!(
            PR_DETAIL_FIELDS.contains("reviewDecision"),
            "o campo é pedido ao gh"
        );
        let view: GhPrView =
            serde_json::from_slice(br#"{"number":6,"reviewDecision":"REVIEW_REQUIRED"}"#).unwrap();
        let d = detail_from(view, Conversation::default());
        assert_eq!(
            d.review_decision.as_deref(),
            Some("REVIEW_REQUIRED"),
            "sem isto o «0 de 0 aprovações» segue mentindo"
        );
        let json = serde_json::to_string(&d).unwrap();
        assert!(
            json.contains(r#""reviewDecision":"REVIEW_REQUIRED""#),
            "{json}"
        );
    }

    #[test]
    fn a_version_lands_on_the_draft_you_are_standing_on() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("version-stays");
        init_with_commit(&root);
        // um branch de time, fora da grafia `rfc/…`
        crate::proc::command("git")
            .args(["checkout", "-b", "feat/acervo-navegavel"])
            .current_dir(&root)
            .output()
            .unwrap();
        std::fs::write(root.join("context.md"), "mudança do time").unwrap();

        let att = save_version(&root, "descricao-qualquer", "mudança".into()).unwrap();
        assert!(att.saved);
        assert_eq!(
            att.branch, "feat/acervo-navegavel",
            "a versão caiu no rascunho em que a pessoa estava"
        );
        assert_eq!(
            current_branch(&root).as_deref(),
            Some("feat/acervo-navegavel"),
            "e ela não foi movida para lugar nenhum"
        );
        assert!(
            !ref_exists(&root, "refs/heads/rfc/descricao-qualquer"),
            "nenhum rascunho novo nasceu a partir da descrição"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // E do OFICIAL o rascunho nasce, porque é lá que ele precisa nascer: o
    // conhecimento oficial não recebe commit direto.
    #[test]
    fn from_the_official_knowledge_a_version_still_creates_the_draft() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("version-from-main");
        init_with_commit(&root);
        assert_eq!(current_branch(&root).as_deref(), Some("main"));
        std::fs::write(root.join("context.md"), "mudança direta no oficial").unwrap();

        let att = save_version(&root, "prazo-do-convite", "mudança".into()).unwrap();
        assert!(att.saved);
        assert_eq!(att.branch, "rfc/prazo-do-convite");
        assert_eq!(
            current_branch(&root).as_deref(),
            Some("rfc/prazo-do-convite")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_pending_edit_travels_with_you_instead_of_blocking_the_switch() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("switch-dirty");
        init_with_commit(&root);
        create_branch(&root, "mudanca").unwrap();
        std::fs::write(root.join("context.md"), "edição pendente").unwrap();

        // o arquivo é o mesmo nos dois rascunhos: o git carrega a modificação
        switch_branch(&root, "main").unwrap();
        assert_eq!(current_branch(&root).as_deref(), Some("main"));
        assert_eq!(
            std::fs::read_to_string(root.join("context.md")).unwrap(),
            "edição pendente",
            "a mudança não guardada foi com a pessoa — nada se perde"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // E a recusa que SOBRA é a de verdade: o arquivo difere entre os dois rascunhos,
    // então trocar sobrescreveria a edição. Aí «salve uma versão primeiro» é o
    // conserto certo — e é a única vez em que ele é.
    #[test]
    fn a_switch_that_would_overwrite_the_edit_is_refused_with_the_remedy() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("switch-clobber");
        init_with_commit(&root);
        create_branch(&root, "mudanca").unwrap();
        std::fs::write(root.join("context.md"), "versão do rascunho").unwrap();
        stage_and_commit(&root, "no rascunho".into()).unwrap();
        // agora o arquivo difere entre main e o rascunho, E está modificado
        std::fs::write(root.join("context.md"), "edição pendente").unwrap();

        let err = switch_branch(&root, "main").unwrap_err();
        assert_eq!(err, "err.switch_would_lose_change");
        assert_eq!(
            current_branch(&root).as_deref(),
            Some("rfc/mudanca"),
            "recusado, o chão não se move debaixo da pessoa"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("context.md")).unwrap(),
            "edição pendente"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn switch_branch_errors_on_missing_branch() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("switch-missing");
        init_with_commit(&root);

        let err = switch_branch(&root, "nao-existe").unwrap_err();
        assert_eq!(err, "err.branch_not_found");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_default_without_remote_returns_no_remote() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-noremote");
        init_with_commit(&root);

        assert_eq!(sync_default_branch(&root), SyncOutcome::NoRemote);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_default_fast_forwards_from_origin() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-ff");
        let bare = root.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        run_git(&bare, &["init", "--bare", "--initial-branch=main"]);

        let a = root.join("a");
        std::fs::create_dir_all(&a).unwrap();
        init_with_commit(&a);
        run_git(&a, &["remote", "add", "origin", bare.to_str().unwrap()]);
        assert!(run_git(&a, &["push", "-u", "origin", "main"])
            .status
            .success());

        let c = root.join("c");
        assert!(run_git(
            &root,
            &["clone", bare.to_str().unwrap(), c.to_str().unwrap()]
        )
        .status
        .success());
        set_identity(&c, "Teste", "teste@exemplo.com").unwrap();

        // origin moves ahead; the local clone is behind
        std::fs::write(a.join("context.md"), "avanço").unwrap();
        stage_and_commit(&a, "feat: avanço".into()).unwrap();
        assert!(run_git(&a, &["push", "origin", "main"]).status.success());

        assert_eq!(sync_default_branch(&c), SyncOutcome::Updated);
        assert_eq!(rev_sha(&c, "main"), rev_sha(&c, "origin/main"));
        assert_eq!(sync_default_branch(&c), SyncOutcome::AlreadyUpToDate);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_default_reports_diverged_and_keeps_local_main() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-div");
        let bare = root.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        run_git(&bare, &["init", "--bare", "--initial-branch=main"]);

        let a = root.join("a");
        std::fs::create_dir_all(&a).unwrap();
        init_with_commit(&a);
        run_git(&a, &["remote", "add", "origin", bare.to_str().unwrap()]);
        assert!(run_git(&a, &["push", "-u", "origin", "main"])
            .status
            .success());

        let c = root.join("c");
        assert!(run_git(
            &root,
            &["clone", bare.to_str().unwrap(), c.to_str().unwrap()]
        )
        .status
        .success());
        set_identity(&c, "Teste", "teste@exemplo.com").unwrap();

        // both sides commit: origin and local main diverge
        std::fs::write(c.join("context.md"), "local próprio").unwrap();
        stage_and_commit(&c, "local".into()).unwrap();
        let local_sha = rev_sha(&c, "main");
        std::fs::write(a.join("context.md"), "remoto").unwrap();
        stage_and_commit(&a, "remoto".into()).unwrap();
        assert!(run_git(&a, &["push", "origin", "main"]).status.success());

        assert_eq!(sync_default_branch(&c), SyncOutcome::Diverged);
        // the local default branch is never rewritten outside fast-forward
        assert_eq!(rev_sha(&c, "main"), local_sha);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_offline_degrades() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-offline");
        init_with_commit(&root);
        run_git(
            &root,
            &["remote", "add", "origin", "/loro-nonexistent-remote.git"],
        );

        assert_eq!(sync_default_branch(&root), SyncOutcome::Offline);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn local_default_branch_prefers_origin_head_then_main() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("default-branch");
        init_with_commit(&root);

        // (b) no origin/HEAD → local main wins
        assert_eq!(local_default_branch(&root), "main");

        // (a) origin/HEAD, when present, wins over local heads
        run_git(
            &root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/develop",
            ],
        );
        assert_eq!(local_default_branch(&root), "develop");
        run_git(
            &root,
            &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
        );

        // (c) master when there is no main
        run_git(&root, &["branch", "-M", "master"]);
        assert_eq!(local_default_branch(&root), "master");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn version_never_commits_on_default() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("ver-default");
        init_with_commit(&root);
        let main_sha = rev_sha(&root, "main");

        create_branch(&root, "proposta").unwrap();
        std::fs::write(root.join("context.md"), "mudança").unwrap();
        stage_and_commit(&root, "feat: mudança".into()).unwrap();

        assert_eq!(current_branch(&root).as_deref(), Some("rfc/proposta"));
        assert_eq!(rev_sha(&root, "main"), main_sha, "main never moves");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn version_creates_rfc_branch_and_preserves_main() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = std::env::temp_dir().join(format!("loro-ver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        std::fs::write(root.join("context.md"), "base").unwrap();
        stage_and_commit(&root, "base".into()).unwrap();
        let orig = current_branch(&root).unwrap();

        let branch = create_branch(&root, "minha-rfc").unwrap();
        assert_eq!(branch, "rfc/minha-rfc");
        assert_eq!(current_branch(&root).as_deref(), Some("rfc/minha-rfc"));

        std::fs::write(root.join("context.md"), "mudança proposta").unwrap();
        assert_eq!(
            stage_and_commit(&root, "feat: x".into()).unwrap(),
            "versionado"
        );

        // the main branch still exists (all work branches off it)
        let kept = crate::proc::command("git")
            .args(["rev-parse", "--verify", &orig])
            .current_dir(&root)
            .output()
            .unwrap()
            .status
            .success();
        assert!(kept);
        let _ = std::fs::remove_dir_all(&root);
    }

    // N2 — a project whose versioning started AFTER setup has an empty default
    // branch (Baseline::Empty commits nothing), so every document lives on the
    // draft. Switching to the branch the picker labels "(principal)" therefore
    // takes the whole project off the disk. Git keeps it safe on the draft
    // commit; the SCREEN went empty with no warning and no way back stated.
    // The UI can only state that price if the backend counts it.
    #[test]
    fn the_default_branch_of_a_draft_only_project_holds_no_documents() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("docs-empty-main");
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "conhecimento").unwrap();
        std::fs::write(root.join("INDEX.md"), "índice").unwrap();
        std::fs::write(root.join(".github/workflows/ci.yml"), "on: push").unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();

        // exactly what "começar a guardar versões" runs on a repo-less project
        create_branch(&root, "primeira-versao").unwrap();
        stage_and_commit(&root, "primeira versão".into()).unwrap();
        let default = local_default_branch(&root);

        assert_eq!(
            documents_on(&root, &default),
            0,
            "the baseline commits nothing: the branch called (principal) is an empty room"
        );
        assert_eq!(
            documents_on(&root, "rfc/primeira-versao"),
            2,
            "the draft holds the documents; machine folders (.github/) are not documents"
        );
        assert_eq!(
            documents_leaving(&root, "rfc/primeira-versao", &default),
            2,
            "switching to (principal) takes both documents off the screen"
        );
        assert_eq!(
            documents_leaving(&root, &default, "rfc/primeira-versao"),
            0,
            "going back to the draft costs nothing"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The seeded baseline is the same defect with a smaller blast radius: only
    // the documents created after setup leave the screen.
    #[test]
    fn a_seeded_default_branch_only_loses_what_the_draft_added() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("docs-seeded-main");
        init_with_commit(&root); // context.md committed on main
        create_branch(&root, "frota").unwrap();
        std::fs::write(root.join("nota-nova.md"), "documento novo").unwrap();
        stage_and_commit(&root, "nova nota".into()).unwrap();

        assert_eq!(documents_on(&root, "main"), 1);
        assert_eq!(documents_on(&root, "rfc/frota"), 2);
        assert_eq!(documents_leaving(&root, "rfc/frota", "main"), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ADR-0027 blocker — «＋ novo rascunho…» started the draft from the default
    // branch whenever the tree was CLEAN, which is exactly when nothing travels
    // with you. On every project until a review lands the default branch is the
    // empty baseline, so naming a draft took the whole project off the disk: the
    // sidebar said the knowledge had never been created, and «mudanças de agora»
    // filled with the app's own internals because the `.gitignore` left with the
    // tree. Naming a draft is not a price the user agreed to pay (DESIGN.md §1),
    // and the copy already promises the opposite ("um rascunho novo leva a mudança
    // com você").
    #[test]
    fn a_new_draft_never_takes_the_project_off_the_screen() {
        if which("git").is_none() {
            return;
        }
        // (a) the draft-only project: every document lives on the draft
        let root = temp_repo("newdraft-empties");
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::create_dir_all(root.join(".github")).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "conhecimento\n").unwrap();
        std::fs::write(root.join("INDEX.md"), "índice\n").unwrap();
        std::fs::write(root.join(".github/pull_request_template.md"), "## Resumo\n").unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        create_branch(&root, "onboarding-atualizado").unwrap();
        stage_and_commit(&root, "primeira versão".into()).unwrap();
        assert!(
            !is_dirty(&root),
            "fixture: the tree has to be clean — that is when the defect fired"
        );

        create_branch(&root, "prazo-do-convite-21-dias").unwrap();

        assert_eq!(
            current_branch(&root).as_deref(),
            Some("rfc/prazo-do-convite-21-dias")
        );
        for rel in [
            "contexts/frota/context.md",
            "INDEX.md",
            ".github/pull_request_template.md",
            ".gitignore",
        ] {
            assert!(
                root.join(rel).is_file(),
                "naming a new draft took {rel} off the disk"
            );
        }
        assert_eq!(
            documents_on(&root, "rfc/prazo-do-convite-21-dias"),
            2,
            "the new draft starts empty of the knowledge the project has"
        );
        let paths: Vec<String> = working_diff(&root, None)
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert!(
            paths.is_empty(),
            "the new draft turned the whole project into rows the person never wrote: {paths:?}"
        );
        assert_eq!(pending_changes(&root), 0);
        let _ = std::fs::remove_dir_all(&root);

        // (b) the same defect on content: a version already saved on the current
        // draft must not silently go back to what the official branch says
        let root = temp_repo("newdraft-reverts");
        init_with_commit(&root); // main holds context.md = "base"
        create_branch(&root, "prazo").unwrap();
        std::fs::write(root.join("context.md"), "prazo de 21 dias\n").unwrap();
        stage_and_commit(&root, "prazo de 21 dias".into()).unwrap();

        create_branch(&root, "outro-assunto").unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("context.md")).unwrap(),
            "prazo de 21 dias\n",
            "the version saved on the previous draft went back to the official text"
        );
        let _ = std::fs::remove_dir_all(&root);

        // (c) and the independence the default start buys is kept wherever it is
        // free: once the draft's work is in the official branch, the next draft is
        // rooted THERE, so its review carries only the new commits
        let root = temp_repo("newdraft-independent");
        init_with_commit(&root);
        create_branch(&root, "ja-entrou").unwrap();
        std::fs::write(root.join("frota.md"), "conhecimento\n").unwrap();
        stage_and_commit(&root, "frota".into()).unwrap();
        run_git(&root, &["checkout", "-q", "main"]);
        run_git(
            &root,
            &["merge", "--no-ff", "-q", "-m", "juntou", "rfc/ja-entrou"],
        );
        run_git(&root, &["checkout", "-q", "rfc/ja-entrou"]);
        assert_ne!(
            rev_sha(&root, "main"),
            rev_sha(&root, "rfc/ja-entrou"),
            "fixture: the two candidate start points have to differ"
        );

        create_branch(&root, "assunto-novo").unwrap();

        assert_eq!(
            rev_sha(&root, "HEAD"),
            rev_sha(&root, "main"),
            "the new draft is not rooted in the official branch, so its review would carry the previous draft's commits"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 — the app said "versão salva" over a commit that never happened, and
    // the attempt still created (and switched to) an empty draft on the way.
    // Nothing pending is not a version: the flow refuses BEFORE it changes
    // anything, and reports the refusal as a fact.
    #[test]
    fn saving_a_version_with_nothing_pending_saves_nothing_and_says_so() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("version-noop");
        init_with_commit(&root);
        create_branch(&root, "politica-de-frota").unwrap();
        std::fs::write(root.join("frota.md"), "conhecimento").unwrap();
        let first = save_version(&root, "politica-de-frota", "política de frota".into()).unwrap();
        assert!(
            first.saved,
            "the first version had a pending change to carry"
        );
        assert_eq!(
            pending_changes(&root),
            0,
            "the tree is clean after a version"
        );

        let branches_before = list_branches(&root).unwrap();
        let head_before = rev_sha(&root, "HEAD");

        let again = save_version(&root, "reviso-a-politica", "reviso a política".into()).unwrap();

        assert!(
            !again.saved,
            "there was nothing to version — the app must not be told a version was saved"
        );
        assert_eq!(
            list_branches(&root).unwrap(),
            branches_before,
            "a no-op created an empty draft as a side effect the sheet never mentions"
        );
        assert_eq!(
            current_branch(&root).unwrap(),
            "rfc/politica-de-frota",
            "a no-op moved the user onto another draft"
        );
        assert_eq!(rev_sha(&root, "HEAD"), head_before, "nothing was committed");
        let _ = std::fs::remove_dir_all(&root);
    }

    // The other half of the same rule: a real pending change still versions.
    #[test]
    fn saving_a_version_with_a_pending_change_commits_it() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("version-real");
        init_with_commit(&root);
        std::fs::write(root.join("frota.md"), "conhecimento").unwrap();
        assert!(pending_changes(&root) > 0);

        let out = save_version(&root, "politica-de-frota", "política de frota".into()).unwrap();

        assert!(out.saved);
        assert_eq!(out.branch, "rfc/politica-de-frota");
        assert_eq!(pending_changes(&root), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    // N6 — the doctor could not tell "no repository connected" from "this
    // machine has no network right now", so five minutes offline switched the
    // team flow off and blamed the user's setup.
    #[test]
    fn a_transport_failure_is_offline_not_a_missing_repository() {
        assert!(looks_offline(
            "dial tcp: lookup api.github.com: no such host"
        ));
        assert!(looks_offline("Get \"https://api.github.com\": i/o timeout"));
        assert!(looks_offline("connection refused"));
        assert!(
            !looks_offline("GraphQL: Could not resolve to a Repository with the name 'x/y'."),
            "an answer FROM GitHub is an access problem, not a network one"
        );
        assert!(!looks_offline("HTTP 404: Not Found"));
    }

    // ---- ADR-0027: reading a review inside the app -------------------------

    // BR-8 — the read path obeys the SAME quarantine as the write path. Without
    // it an untracked `contexts/<ctx>/audio.wav` (which no GIT_IGNORED pattern
    // covers) would be read off the disk and painted onto the review screen.
    // This is the read-path twin of
    // `stage_and_commit_never_versions_audio_transcript_audit_or_pessoal`.
    #[test]
    fn the_working_diff_never_shows_what_a_version_would_refuse() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = temp_repo("working-diff-quarantine");
        std::fs::create_dir_all(root.join("contexts/frota/meetings/r1")).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "conhecimento\n").unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        stage_and_commit(&root, "base".into()).unwrap();

        std::fs::write(
            root.join("contexts/frota/context.md"),
            "conhecimento\nprazo de 3 dias\n",
        )
        .unwrap();
        std::fs::write(root.join("contexts/frota/nova.md"), "documento novo\n").unwrap();
        std::fs::write(root.join("contexts/frota/audio.wav"), b"RIFF\0\0\0\0WAVE").unwrap();
        std::fs::write(root.join("contexts/frota/meetings/r1/reuniao.md"), "fala\n").unwrap();

        let files = working_diff(&root, None).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            paths.contains(&"contexts/frota/context.md"),
            "the edited document is missing from the review screen: {paths:?}"
        );
        assert!(
            paths.contains(&"contexts/frota/nova.md"),
            "an untracked document has to show as a new document: {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.ends_with(".wav")),
            "BR-8 — meeting audio reached the review screen: {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.ends_with("reuniao.md")),
            "BR-8 — a raw transcript reached the review screen: {paths:?}"
        );
        // The EXACT set, not a contains: the filter that decides which porcelain
        // lines are untracked files could be dropped with the whole suite green,
        // and what it hides is a card per MODIFIED document — path mangled by the
        // three-character status prefix, so «não dá para mostrar as linhas deste
        // arquivo» about a file that does not exist. A `contains` cannot see an
        // extra row; a set can.
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            vec!["contexts/frota/context.md", "contexts/frota/nova.md"],
            "the review screen is not exactly what a version would carry"
        );

        let nova = files.iter().find(|f| f.path.ends_with("nova.md")).unwrap();
        assert_eq!(nova.kind, crate::diff::ChangeKind::Added);
        assert_eq!(nova.additions, 1, "a new document renders as all-add");
        let ctx = files
            .iter()
            .find(|f| f.path.ends_with("context.md"))
            .unwrap();
        assert_eq!(ctx.kind, crate::diff::ChangeKind::Modified);
        assert_eq!(ctx.additions, 1);
        assert_eq!(ctx.hunks[0].rows.last().unwrap().new_line, Some(2));

        // a read command that mutates the index is not a read command
        let staged = run_git(&root, &["diff", "--cached", "--name-only"]);
        assert!(
            String::from_utf8_lossy(&staged.stdout).trim().is_empty(),
            "reading the working tree staged something"
        );
        // and a path from the screen can never point outside the project
        assert_eq!(
            working_diff(&root, Some("../../etc/passwd")).unwrap_err(),
            "err.outside_acervo"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The crux, checked against git ITSELF. A hand-written fixture can agree
    // with a wrong parser; `git diff --numstat` cannot. Real patch text, with
    // two hunks in one file, a deletion, an accented filename and a binary.
    #[test]
    fn the_parser_agrees_with_git_numstat_on_a_real_repository() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("diff-vs-numstat");
        let ctx = root.join("contexts/frota");
        std::fs::create_dir_all(&ctx).unwrap();
        let ten = (1..=10)
            .map(|i| format!("linha {i}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(ctx.join("context.md"), &ten).unwrap();
        std::fs::write(ctx.join("política.md"), "acentuado\n").unwrap();
        std::fs::write(ctx.join("velha.md"), "some\n").unwrap();
        std::fs::write(ctx.join("foto.png"), b"\x89PNG\r\n\x1a\n\0\0\0").unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        stage_and_commit(&root, "base".into()).unwrap();

        // edits far apart so git emits TWO hunks for one document
        std::fs::write(
            ctx.join("context.md"),
            ten.replace("linha 1\n", "linha um\n")
                .replace("linha 10", "linha dez"),
        )
        .unwrap();
        std::fs::remove_file(ctx.join("velha.md")).unwrap();
        std::fs::write(ctx.join("política.md"), "acentuado\ne mais uma\n").unwrap();
        std::fs::write(ctx.join("foto.png"), b"\x89PNG\r\n\x1a\n\0\0\0\0\0").unwrap();

        let args = ["-c", "core.quotePath=false", "diff", "HEAD"];
        let patch = run_git(
            &root,
            &[&args[..], &["--no-color", "--no-ext-diff", "-U3"][..]].concat(),
        );
        let files = crate::diff::parse_unified_diff(&String::from_utf8_lossy(&patch.stdout));
        let numstat = run_git(&root, &[&args[..], &["--numstat"][..]].concat());

        let mut expected: Vec<(String, String)> = String::from_utf8_lossy(&numstat.stdout)
            .lines()
            .filter_map(|l| {
                let mut it = l.split('\t');
                let a = it.next()?.to_string();
                let d = it.next()?.to_string();
                let p = it.next()?.to_string();
                Some((p, format!("{a}/{d}")))
            })
            .collect();
        expected.sort();
        assert!(expected.len() >= 4, "the fixture stopped exercising git");

        let mut got: Vec<(String, String)> = files
            .iter()
            .map(|f| {
                let counts = if f.binary {
                    "-/-".to_string()
                } else {
                    format!("{}/{}", f.additions, f.deletions)
                };
                (f.path.clone(), counts)
            })
            .collect();
        got.sort();
        assert_eq!(got, expected, "the parser disagrees with git's own numstat");

        // and the two-hunk document really came back as two hunks
        let doc = files
            .iter()
            .find(|f| f.path.ends_with("context.md"))
            .unwrap();
        assert_eq!(doc.hunks.len(), 2);
        assert_eq!(doc.hunks[1].rows.last().unwrap().new_line, Some(10));
        let _ = std::fs::remove_dir_all(&root);
    }

    // A file the screen cannot draw as text says so instead of drawing an empty
    // diff (F2's failure path).
    #[test]
    fn an_untracked_binary_says_so_instead_of_drawing_nothing() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("working-diff-binary");
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "base\n").unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        stage_and_commit(&root, "base".into()).unwrap();
        std::fs::write(
            root.join("contexts/frota/foto.png"),
            b"\x89PNG\r\n\x1a\n\0\0",
        )
        .unwrap();

        let files = working_diff(&root, None).unwrap();
        let foto = files.iter().find(|f| f.path.ends_with("foto.png")).unwrap();
        assert!(foto.binary);
        assert!(foto.hunks.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // The defect: «Mudanças de agora» opened with the machine's own bookkeeping
    // presented as the person's change. Every intake run rewrites
    // `.brain/state.json` and appends to `.brain/activity.log` (the acervo
    // instructions, templates.rs step 4), so those two rows came back on top of
    // the list on every run and nobody had written a line of either. BR-8: the
    // activity log is prose an agent wrote over raw queue items — a versioned one
    // is a route from a transcript to a shared remote.
    #[test]
    fn the_intake_bookkeeping_is_never_a_change_the_person_made() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = temp_repo("intake-bookkeeping");
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::create_dir_all(root.join(".brain")).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "conhecimento\n").unwrap();
        std::fs::write(root.join(".brain/state.json"), "{\"processed\":[]}\n").unwrap();
        std::fs::write(root.join(".brain/activity.log"), "").unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();

        // an acervo versioned BEFORE the rule: both files are already tracked
        run_git(&root, &["add", "-A", "-f"]);
        run_git(&root, &["commit", "-qm", "base"]);
        assert!(
            String::from_utf8_lossy(&run_git(&root, &["ls-files"]).stdout)
                .contains(".brain/state.json"),
            "fixture: the pre-rule acervo has to start with the file tracked"
        );

        // one intake run: the acervo's instructions rewrite both files while the
        // person edits one document
        std::fs::write(
            root.join(".brain/state.json"),
            "{\"processed\":[\"a.md\"]}\n",
        )
        .unwrap();
        std::fs::write(root.join(".brain/activity.log"), "fila processada\n").unwrap();
        std::fs::write(
            root.join("contexts/frota/context.md"),
            "conhecimento\nprazo de 3 dias\n",
        )
        .unwrap();

        stage_and_commit(&root, "prazo atualizado".into()).unwrap();
        let tracked = String::from_utf8_lossy(&run_git(&root, &["ls-files"]).stdout).into_owned();
        assert!(
            !tracked.contains(".brain/state.json"),
            "the intake's bookkeeping is still in the versioned tree: {tracked}"
        );
        assert!(
            !tracked.contains(".brain/activity.log"),
            "BR-8 — the agent's activity log is still versioned: {tracked}"
        );
        assert!(
            tracked.contains("contexts/frota/context.md"),
            "the document the person edited left the version: {tracked}"
        );
        assert!(
            root.join(".brain/state.json").is_file() && root.join(".brain/activity.log").is_file(),
            "leaving the versioned tree must not take the file off the disk"
        );

        // and from here on an intake run leaves «o que você mudou» empty
        std::fs::write(
            root.join(".brain/state.json"),
            "{\"processed\":[\"a.md\",\"b.md\"]}\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".brain/activity.log"),
            "fila processada\noutra rodada\n",
        )
        .unwrap();
        let paths: Vec<String> = working_diff(&root, None)
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert!(
            paths.is_empty(),
            "the machine's own bookkeeping is on the review screen as the person's change: {paths:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The acervo's ignore list exactly as the release BEFORE this one wrote it.
    // Every install upgraded to this release has this file on disk, and nothing on
    // the read path rewrites it.
    const PREVIOUS_RELEASE_GITIGNORE: &str = ".DS_Store\ninbox/\nprocessed/\nmeetings/\n/notes/\nreunioes/\n/notas/\n.brain/prompt-history/\nbrainstorming/\npessoal/\n";

    // The read path used to trust a file it does not write. `.gitignore` is the
    // ONLY thing that keeps the intake's bookkeeping off «o que você mudou», and
    // the five places that rewrite it are all WRITE paths, so on every acervo
    // created by the previous release the screen opened with two cards nobody had
    // written, armed «Salvar versão» for them, and then saved a version that
    // carried neither. Built by hand on purpose: a fixture that calls
    // `git_init_repo` / `set_identity` / `stage_and_commit` before it reads is
    // testing the state AFTER a save, not the state every existing install is in
    // on its first visit to this screen.
    #[test]
    fn the_intake_bookkeeping_is_quarantined_on_a_gitignore_from_the_previous_release() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = temp_repo("stale-gitignore");
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::create_dir_all(root.join(".brain")).unwrap();
        std::fs::write(root.join(".gitignore"), PREVIOUS_RELEASE_GITIGNORE).unwrap();
        std::fs::write(root.join("contexts/frota/context.md"), "conhecimento\n").unwrap();
        run_git(&root, &["init", "-q"]);
        run_git(&root, &["config", "user.name", "Teste"]);
        run_git(&root, &["config", "user.email", "teste@exemplo.com"]);
        run_git(&root, &["config", "commit.gpgsign", "false"]);
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-qm", "base"]);

        // one intake run: the acervo's own instructions (templates.rs step 4)
        // rewrite both files, and the person has changed nothing
        std::fs::write(
            root.join(".brain/state.json"),
            "{\"processed\":[\"a.md\"]}\n",
        )
        .unwrap();
        std::fs::write(root.join(".brain/activity.log"), "fila processada\n").unwrap();

        let paths: Vec<String> = working_diff(&root, None)
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert!(
            paths.is_empty(),
            "the machine's own bookkeeping is on the review screen as the person's change: {paths:?}"
        );
        assert_eq!(
            pending_changes(&root),
            0,
            "the count on the tab disagrees with the list it labels"
        );
        assert!(
            !is_dirty(&root),
            "a dead end: switching draft is refused over files the screen says are not there"
        );

        // and none of this hides a change the person DID make
        std::fs::write(
            root.join("contexts/frota/context.md"),
            "conhecimento\nprazo de 3 dias\n",
        )
        .unwrap();
        let paths: Vec<String> = working_diff(&root, None)
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(paths, vec!["contexts/frota/context.md".to_string()]);
        assert_eq!(pending_changes(&root), 1);
        assert!(is_dirty(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    // The quarantine the read path applies has to be the one git would have
    // applied, or the screen starts hiding documents instead of housekeeping:
    // `GIT_IGNORED` is gitignore syntax, and three of its shapes mean three
    // different things.
    #[test]
    fn the_read_path_quarantine_agrees_with_the_gitignore_it_stands_in_for() {
        // anchored by its slash: only the acervo's own bookkeeping, at the root
        assert!(is_quarantined(".brain/state.json"));
        assert!(is_quarantined(".brain/activity.log"));
        assert!(is_quarantined(".brain/prompt-history/2026-08-01.md"));
        assert!(
            !is_quarantined("contexts/frota/.brain/state.json"),
            "an anchored pattern matched at a depth git would not"
        );
        // a bare name matches at any depth, a trailing slash only a directory
        assert!(is_quarantined("inbox/nota.md"));
        assert!(is_quarantined("contexts/frota/meetings/r1/reuniao.md"));
        assert!(is_quarantined("inbox/"));
        assert!(is_quarantined("contexts/frota/.DS_Store"));
        assert!(
            !is_quarantined("contexts/frota/inbox"),
            "a DOCUMENT named like a quarantined folder left the screen"
        );
        // anchored at the root by its leading slash (owner decision, ADR-0009)
        assert!(is_quarantined("notes/ideia.md"));
        assert!(
            !is_quarantined("contexts/frota/notes/nota.md"),
            "a context's own notes/ folder is versioned knowledge, not the root one"
        );
        // and the knowledge itself is never quarantined
        assert!(!is_quarantined("contexts/frota/context.md"));
        assert!(!is_quarantined("INDEX.md"));
        assert!(!is_quarantined(".github/pull_request_template.md"));
    }

    // The four surfaces that ask "what is pending" share one porcelain reader, so
    // the way it reads a line is load-bearing: a marker keys by where the content
    // IS now (a rename's new path), and ONLY a rename carries `old -> new` — a
    // document whose own name contains that string must keep it, or the card and
    // the sidebar marker point at a file that does not exist.
    #[test]
    fn a_porcelain_line_is_read_as_the_path_the_content_is_at_now() {
        let renamed =
            parse_porcelain_line("R  contexts/frota/velha.md -> contexts/frota/nova.md").unwrap();
        assert_eq!(renamed.code, "R");
        assert_eq!(renamed.path, "contexts/frota/nova.md");

        let odd_name = parse_porcelain_line("?? contexts/frota/antes -> depois.md").unwrap();
        assert_eq!(odd_name.code, "??");
        assert_eq!(odd_name.path, "contexts/frota/antes -> depois.md");

        let edited = parse_porcelain_line(" M contexts/frota/context.md").unwrap();
        assert_eq!(edited.code, "M");
        assert_eq!(edited.path, "contexts/frota/context.md");

        assert!(parse_porcelain_line("").is_none());
        assert!(parse_porcelain_line("?? ").is_none(), "a line with no path");
    }

    // gh's JSON key is `statusCheckRollup` and the app's key is `checks`; the
    // mapping is explicit so a key mismatch cannot hide behind a shared struct.
    #[test]
    fn pr_detail_deserializes_gh_json() {
        let json = r###"{"number":12,"title":"prazo do convite","body":"## Resumo\nmuda o prazo\n<!-- dica -->\n\n## Como conferir\nabra o onboarding\n","author":{"login":"ana"},"headRefName":"rfc/prazo-convite","baseRefName":"main","state":"OPEN","url":"https://github.com/x/y/pull/12","updatedAt":"2026-08-10T10:00:00Z","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewRequests":[{"login":"bob"}],"isDraft":false,"files":[{"path":"contexts/frota/context.md","additions":4,"deletions":1}],"statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://ci"},{"context":"legado","state":"FAILURE","targetUrl":"https://legado"}]}"###;
        let view: GhPrView = serde_json::from_str(json).unwrap();
        let conv = Conversation {
            viewer: "bob".into(),
            reviews: vec![
                PrReview {
                    author: "bob".into(),
                    state: "CHANGES_REQUESTED".into(),
                    ..Default::default()
                },
                PrReview {
                    author: "bob".into(),
                    state: "APPROVED".into(),
                    ..Default::default()
                },
                PrReview {
                    author: "ana".into(),
                    state: "COMMENTED".into(),
                    ..Default::default()
                },
            ],
            threads: vec![PrThread {
                id: 99,
                path: "contexts/frota/context.md".into(),
                resolved: true,
                ..Default::default()
            }],
        };
        let d = detail_from(view, conv);

        assert_eq!(d.number, 12);
        assert_eq!(d.head_ref_name, "rfc/prazo-convite");
        assert_eq!(d.mergeable, "MERGEABLE");
        assert_eq!(
            d.merge_state_status, "BLOCKED",
            "the only truthful signal for whether the change can land"
        );
        // the description arrives already split into the team's sections
        assert_eq!(d.sections.len(), 2);
        assert_eq!(d.sections[0].label, "Resumo");
        assert_eq!(d.sections[0].text, "muda o prazo");
        assert_eq!(d.sections[1].label, "Como conferir");
        // gh's statusCheckRollup became the app's `checks`, both spellings read
        assert_eq!(d.checks.len(), 2);
        assert_eq!(d.checks[0].name, "ci");
        assert_eq!(d.checks[0].state, CheckState::Ok);
        assert_eq!(d.checks[1].name, "legado");
        assert_eq!(d.checks[1].state, CheckState::Failed);
        // a reviewer who asked for changes and then approved counts once
        assert_eq!(d.approvals, 1);
        assert_eq!(d.changes_requested, 0);
        assert!(!d.mine, "the change is ana's; the viewer is bob");
        assert_eq!(d.files[0].additions, 4);
        assert!(d.threads[0].resolved);
    }

    #[test]
    fn pr_detail_tolerates_missing_fields() {
        // an older gh omits fields; nothing may panic (serde default)
        let view: GhPrView = serde_json::from_str(r#"{"number":1}"#).unwrap();
        let d = detail_from(view, Conversation::default());
        assert_eq!(d.number, 1);
        assert!(d.title.is_empty());
        assert!(d.sections.is_empty());
        assert!(d.checks.is_empty());
        assert_eq!(d.approvals, 0);
        assert!(!d.mine, "with no viewer, the app must not claim the change");
    }

    // The GraphQL payload is the only route that carries a review's commit oid,
    // and `stale` is the fact that "aprovação de versão anterior" states.
    #[test]
    fn a_review_of_an_earlier_version_is_marked_stale() {
        let json = r#"{"data":{"viewer":{"login":"ana"},"repository":{"pullRequest":{
            "headRefOid":"HEAD1",
            "reviews":{"nodes":[
              {"state":"APPROVED","body":"ok","submittedAt":"2026-08-01T10:00:00Z","author":{"login":"bob"},"commit":{"oid":"OLD0"}},
              {"state":"CHANGES_REQUESTED","body":"falta","submittedAt":"2026-08-02T10:00:00Z","author":{"login":"cid"},"commit":{"oid":"HEAD1"}}]},
            "reviewThreads":{"nodes":[
              {"isResolved":false,"isOutdated":true,"path":"contexts/frota/context.md","line":12,
               "comments":{"nodes":[
                 {"databaseId":4242,"author":{"login":"bob"},"body":"e o prazo?","createdAt":"2026-08-01T10:00:00Z","diffHunk":"@@ -1 +1 @@\n-a\n-b\n-c\n-d\n-e\n-f\n-g"}]}}]}}}}}"#;
        let conv = conversation_from(serde_json::from_str(json).unwrap());
        assert_eq!(conv.viewer, "ana");
        assert!(conv.reviews[0].stale, "bob approved an earlier version");
        assert!(!conv.reviews[1].stale);
        assert_eq!(
            conv.threads[0].id, 4242,
            "the reply lands on the FIRST comment"
        );
        assert!(conv.threads[0].outdated);
        assert_eq!(conv.threads[0].line, Some(12));
        assert_eq!(
            conv.threads[0].excerpt.lines().count(),
            6,
            "the quoted excerpt is bounded"
        );
        assert_eq!(conv.threads[0].comments[0].author, "bob");
    }

    #[test]
    fn latest_by_author_keeps_the_decision_each_reviewer_holds() {
        let r = |a: &str, s: &str| PrReview {
            author: a.into(),
            state: s.into(),
            ..Default::default()
        };
        let all = vec![
            r("bob", "CHANGES_REQUESTED"),
            r("ana", "APPROVED"),
            r("bob", "APPROVED"),
            r("ana", "COMMENTED"),
        ];
        let latest = latest_by_author(&all);
        assert_eq!(latest.len(), 2);
        assert_eq!(latest.iter().filter(|x| x.state == "APPROVED").count(), 2);
        assert!(
            latest.iter().all(|x| x.state != "CHANGES_REQUESTED"),
            "a reviewer who later approved still counted as blocking"
        );
        assert!(
            latest.iter().all(|x| x.state != "COMMENTED"),
            "a plain comment is not a decision and must not dismiss an approval"
        );
    }

    #[test]
    fn check_state_never_paints_an_unknown_conclusion_green() {
        assert_eq!(check_state("COMPLETED", "SUCCESS"), CheckState::Ok);
        assert_eq!(check_state("COMPLETED", "SKIPPED"), CheckState::Ok);
        assert_eq!(check_state("IN_PROGRESS", ""), CheckState::Running);
        assert_eq!(check_state("", "PENDING"), CheckState::Running);
        assert_eq!(check_state("COMPLETED", "FAILURE"), CheckState::Failed);
        assert_eq!(check_state("COMPLETED", "TIMED_OUT"), CheckState::Failed);
        assert_eq!(
            check_state("SOMETHING_NEW", "SOMETHING_NEW"),
            CheckState::Failed,
            "an unknown state is never reported as passing"
        );
    }

    // Typing the action means an unknown value fails at DESERIALIZATION, before
    // any subprocess runs.
    #[test]
    fn review_action_is_typed_before_any_process_runs() {
        let a: ReviewAction = serde_json::from_str(r#""request_changes""#).unwrap();
        assert_eq!(a.flag(), "--request-changes");
        assert_eq!(
            serde_json::from_str::<ReviewAction>(r#""approve""#)
                .unwrap()
                .flag(),
            "--approve"
        );
        assert_eq!(
            serde_json::from_str::<ReviewAction>(r#""comment""#)
                .unwrap()
                .flag(),
            "--comment"
        );
        assert!(
            serde_json::from_str::<ReviewAction>(r#""--delete-branch""#).is_err(),
            "an arbitrary string could reach gh as a flag"
        );
    }

    #[test]
    fn a_decision_with_nothing_written_is_refused_before_gh_runs() {
        let root = std::env::temp_dir(); // never reached: the refusal comes first
        assert_eq!(
            pr_review(&root, 1, ReviewAction::RequestChanges, "   ").unwrap_err(),
            "err.pr_review_body_required"
        );
        assert_eq!(
            pr_review(&root, 1, ReviewAction::Comment, "").unwrap_err(),
            "err.pr_review_body_required"
        );
        assert_eq!(
            pr_reply(&root, 1, 2, "\n\t ").unwrap_err(),
            "err.pr_review_body_required"
        );
    }

    // The template's `## ` headings ARE the description's structure, and the
    // rule lives once so the screen never re-implements it.
    #[test]
    fn pr_body_sections_reads_the_team_template() {
        let (labels, _) = pr_template_fields(crate::templates::PR_TEMPLATE);
        assert_eq!(labels.len(), 3);
        assert_eq!(labels[0], "Resumo");
        assert_eq!(labels[2], "Como conferir");
        // a hint the author never replaced is markup, not the author's words
        let filled = pr_body_sections("## Resumo\n<!-- o que muda -->\nmuda o prazo\n");
        assert_eq!(filled[0].text, "muda o prazo");
        // a `##` inside a fenced block is code, not a heading
        let (fenced, _) = pr_template_fields("## Um\n```\n## nao e secao\n```\n## Dois\n");
        assert_eq!(fenced, vec!["Um".to_string(), "Dois".to_string()]);
        // a description with no structure is rendered whole, not as one section
        assert!(pr_body_sections("so um paragrafo").is_empty());
        // and what is written back is what the reader will be asked for
        assert_eq!(
            render_pr_body_template(&["Resumo".into(), "Como conferir".into()], ""),
            "## Resumo\n\n## Como conferir\n\n"
        );
    }

    // The sheet asked for six sections and explained none of them: the sentence
    // that says WHAT to write lives in the template's HTML comment, and the
    // parser threw it away with the rest of the markup. A field whose label is
    // "Como conferir" and whose placeholder is empty is a blank box.
    #[test]
    fn a_template_field_carries_the_sentence_that_says_what_to_write() {
        let (labels, hints) = pr_template_fields(crate::templates::PR_TEMPLATE);
        assert_eq!(
            labels.len(),
            hints.len(),
            "the sheet pairs a label with a hint by index"
        );
        assert!(!labels.is_empty());
        for (label, hint) in labels.iter().zip(&hints) {
            assert!(
                !hint.is_empty(),
                "\"{label}\" reaches the screen with no placeholder"
            );
        }
        assert_eq!(hints[0], "o que muda e por quê");

        // a multi-line hint becomes ONE line: a placeholder with newlines in it
        // is not a placeholder
        let (_, h) = pr_template_fields("## Riscos\n<!-- o que ainda\n   fica aberto -->\n");
        assert_eq!(h[0], "o que ainda fica aberto");
        // the hint is guidance, never the author's text
        let s = pr_body_sections("## Resumo\n<!-- o que muda -->\nmuda o prazo\n");
        assert_eq!(s[0].hint, "o que muda");
        assert_eq!(s[0].text, "muda o prazo");
        // a section with no comment simply has no hint
        assert_eq!(pr_body_sections("## Resumo\ntexto\n")[0].hint, "");

        // and rewriting the template from its labels does not blank the guidance:
        // it is UI copy, so dropping it would empty the placeholder for everyone
        // on the team.
        let rewritten = render_pr_body_template(
            &["Resumo".into(), "Riscos".into()],
            crate::templates::PR_TEMPLATE,
        );
        assert!(
            rewritten.contains("## Resumo\n<!-- o que muda e por quê -->"),
            "the section kept its label and lost its hint: {rewritten}"
        );
        assert!(
            rewritten.contains("## Riscos\n\n"),
            "a brand-new section has no hint to keep: {rewritten}"
        );
    }

    // A real team template is not a bare list of headings: it opens with an H1 and
    // a line to whoever is contributing, and it can end with a note of the team's
    // own. «salvar o modelo do time» showed the LABELS and wrote the file back from
    // them alone, so the H1, the paragraph and the trailing note were deleted from
    // the team's repository — and the note had already been folded into the
    // placeholder of the field above it, which every teammate then read as
    // guidance. A control must not destroy what it never showed (DESIGN.md §1).
    #[test]
    fn the_team_template_keeps_what_the_sheet_never_showed() {
        let theirs = "# Descrição da mudança\n\nObrigado por contribuir!\n\n## Resumo\n<!-- o que muda e por quê -->\n\n## Como conferir\n<!-- como um revisor confere -->\n\n<!-- checklist obrigatório do time: /wiki/revisao -->\n";
        let frame = "# Descrição da mudança\n\nObrigado por contribuir!\n\n";
        let note = "<!-- checklist obrigatório do time: /wiki/revisao -->";

        let (labels, hints) = pr_template_fields(theirs);
        assert_eq!(labels, vec!["Resumo", "Como conferir"]);
        assert_eq!(
            hints[1], "como um revisor confere",
            "the team's own note reached the screen as the field's placeholder"
        );

        // saving the same sections back changes nothing about the file
        let same = render_pr_body_template(&labels, theirs);
        assert!(
            same.starts_with(frame),
            "the H1 and the line to the contributor were deleted: {same}"
        );
        assert!(
            same.contains(note),
            "the team's checklist note was deleted: {same}"
        );
        assert!(same.contains("## Resumo\n<!-- o que muda e por quê -->"));

        // adding a section adds a section, and takes nothing with it
        let added = render_pr_body_template(
            &["Resumo".into(), "Como conferir".into(), "Riscos".into()],
            theirs,
        );
        assert!(
            added.starts_with(frame),
            "adding a section ate the frame: {added}"
        );
        assert!(
            added.contains(note),
            "adding a section ate the note: {added}"
        );
        assert!(added.contains("## Riscos\n\n"));

        // and removing one removes exactly that one
        let removed = render_pr_body_template(&["Resumo".into()], theirs);
        assert!(!removed.contains("## Como conferir"));
        assert!(
            removed.starts_with(frame),
            "removing a section ate the frame: {removed}"
        );
        assert!(removed.contains("## Resumo\n<!-- o que muda e por quê -->"));
    }

    // The block before the first `## ` heading is not a field: it has no name, so
    // the sheet would draw a text input with an empty label and an empty
    // placeholder (WCAG 1.3.1/3.3.2) and compose a body that opens with a heading
    // with no name. The guard that drops it could be deleted with the whole suite
    // green, because no test fed the parser a template with a preamble — and a
    // template with an H1 or a welcome line is the ordinary case.
    #[test]
    fn a_template_preamble_is_never_a_field_with_no_name() {
        let theirs =
            "# Descrição\n\nObrigado por contribuir!\n\n## Resumo\n<!-- o que muda -->\n\n## Como conferir\n<!-- como confere -->\n";
        let sections = pr_body_sections(theirs);
        assert_eq!(
            sections[0].label, "",
            "the block before the first heading has to reach the READER as a nameless section"
        );
        assert!(sections[0].text.contains("Obrigado por contribuir!"));

        let (labels, hints) = pr_template_fields(theirs);
        assert_eq!(
            labels.len(),
            sections.len() - 1,
            "the sheet drew a field for a section with no name: {labels:?}"
        );
        assert_eq!(labels, vec!["Resumo", "Como conferir"]);
        assert!(
            !labels.iter().any(|l| l.trim().is_empty()),
            "a field with no label and no placeholder reached the sheet: {labels:?}"
        );
        assert_eq!(labels.len(), hints.len());
    }

    // ADR-0027 · the author's only failure path used to end in gh's English: a
    // draft that already had an open review was sent to `gh pr create` again,
    // which answers "a pull request for branch … already exists" — raw prose in a
    // pt-BR toast, and no route to deliver what the reviewer asked for. Sending
    // an already-reviewed draft UPDATES that review (the push is what it reads).
    #[test]
    fn a_draft_already_under_review_is_updated_never_proposed_twice() {
        let pr = |number, head: &str, state: &str| PrInfo {
            number,
            head_ref_name: head.to_string(),
            url: format!("https://github.com/acme/brain/pull/{number}"),
            state: Some(state.to_string()),
            ..Default::default()
        };
        let prs = vec![
            pr(4, "rfc/outra-coisa", "OPEN"),
            pr(7, "rfc/prazo-do-convite", "OPEN"),
        ];
        match propose_act(&prs, "rfc/prazo-do-convite") {
            ProposeAct::UpdateOpenReview { number, url } => {
                assert_eq!(number, 7, "the wrong review would be updated");
                assert!(url.ends_with("/7"), "the toast needs the review's address");
            }
            ProposeAct::Create => panic!("a second review would be opened for the same draft"),
        }
        // a draft nobody has reviewed yet gets its first review
        assert!(matches!(
            propose_act(&prs, "rfc/nova-ideia"),
            ProposeAct::Create
        ));
        // a CLOSED review is not a route: that draft needs a new one
        assert!(matches!(
            propose_act(
                &[pr(2, "rfc/prazo-do-convite", "CLOSED")],
                "rfc/prazo-do-convite"
            ),
            ProposeAct::Create
        ));
        // and the screen can tell the two outcomes apart, because it says a
        // different sentence for each
        let json = serde_json::to_string(&PrRef {
            number: 7,
            url: "u".into(),
            updated: true,
        })
        .unwrap();
        assert!(json.contains(r#""updated":true"#), "{json}");

        // git words a transport failure its own way; a push that fails offline
        // must not put git's English into a toast
        assert!(looks_offline(
            "fatal: unable to access 'https://github.com/acme/brain/': Could not resolve host: github.com"
        ));
        assert!(looks_offline("ssh: Could not resolve hostname github.com"));
    }

    // BR-8 — the review path handles diffs, descriptions and review comments.
    // Every log line it writes must carry counts, PR numbers and err codes only.
    // A comment does not stop the next leak; this does.
    #[test]
    fn br8_the_review_logs_carry_counts_never_content() {
        // Positive control, assembled at runtime so this source stays clean.
        let leak = String::from("info!") + "(target: \"review\", \"sent {}\", pr_body);";
        assert!(
            log_args(&leak).iter().any(|a| names_content(a)),
            "the lint must catch an obvious leak"
        );
        for (name, src) in [
            ("git.rs", include_str!("git.rs")),
            ("diff.rs", include_str!("diff.rs")),
        ] {
            for args in log_args(src) {
                assert!(
                    !names_content(&args),
                    "{name}: BR-8 — a log line carries knowledge content: {args}"
                );
            }
        }
    }

    // Argument text of each log-macro invocation (paren-balanced). Deliberately
    // simple: it scans our own sources, whose logs hold no unbalanced paren.
    fn log_args(src: &str) -> Vec<String> {
        let mut out = Vec::new();
        for mac in ["info!", "warn!", "error!", "debug!", "trace!"] {
            let mut from = 0;
            while let Some(rel) = src[from..].find(mac) {
                let open = from + rel + mac.len();
                from = open;
                let rest = &src[open..];
                let Some(nz) = rest.find(|c: char| !c.is_whitespace()) else {
                    continue;
                };
                if rest.as_bytes()[nz] != b'(' {
                    continue;
                }
                let open = open + nz;
                let mut depth = 0i32;
                let mut close = None;
                for (i, ch) in src.bytes().enumerate().skip(open) {
                    match ch {
                        b'(' => depth += 1,
                        b')' => {
                            depth -= 1;
                            if depth == 0 {
                                close = Some(i);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                let Some(close) = close else { continue };
                out.push(src[open + 1..close].to_string());
                from = close + 1;
            }
        }
        out
    }

    // Conservative substring guard for the content this surface handles.
    fn names_content(s: &str) -> bool {
        // assembled so the list itself is not what the scan finds
        [
            "dif", "hunk", "patc", "bod", "excerp", "commen", "conten", "tex",
        ]
        .iter()
        .any(|w| s.contains(w))
    }
}
