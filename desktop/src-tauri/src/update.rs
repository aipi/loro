// Loro — "há uma versão nova": comparar o que está instalado com a última
// release publicada no GitHub, e dizer ao usuário como atualizar PELA ROTA QUE
// ELE USOU para instalar (ADR-0032).
//
// O app NÃO baixa e NÃO instala nada aqui. Ele avisa e mostra o comando; quem
// atualiza é o usuário, no gerenciador que já é dono do bundle. Duas razões de
// fato, não de gosto:
//   1. o bundle não é assinado com Developer ID (release.yml), então um
//      auto-update teria de resolver quarentena/Gatekeeper — outro projeto;
//   2. `brew upgrade --cask loro` substitui o /Applications/Loro.app que está
//      RODANDO. Rodá-lo como filho do próprio app (terminal embutido) é pedir
//      para o processo ser trocado embaixo de quem o disparou.
//
// Privacidade (BR-8): a consulta é um GET anônimo à API pública do GitHub. Não
// vai nome, projeto, transcrição, nem a versão instalada (o User-Agent é fixo).
// Em disco fica só ~/.loro/update.json — carimbo de tempo, última versão vista
// e a chave liga/desliga. Nada de conteúdo do usuário.
//
// Multiplataforma por construção: a checagem é a mesma em todo sistema; só a
// ROTA de atualização é por SO. Hoje só o macOS tem rota nomeada (Homebrew
// cask, ADR-0006) porque é o único que o projeto empacota; Windows e Linux
// caem em `Route::Download`, que manda para a página da release.

use crate::paths::{loro_data_dir, which};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// A release pública do projeto. Overridable para teste e para um fork/mirror.
pub fn releases_api_url() -> String {
    std::env::var("LORO_RELEASE_API")
        .unwrap_or_else(|_| "https://api.github.com/repos/aipi/loro/releases/latest".into())
}

pub fn releases_page_url() -> String {
    std::env::var("LORO_RELEASE_PAGE")
        .unwrap_or_else(|_| "https://github.com/aipi/loro/releases/latest".into())
}

// Uma checagem por dia é o teto: a release existe por semanas, e o custo de
// perguntar é uma ida à rede que o usuário não pediu.
pub const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

// Como este Loro foi instalado — decide o que a tela oferece.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    // Homebrew cask (a instalação recomendada no macOS, ADR-0006).
    Brew,
    // .dmg arrastado à mão, ou qualquer sistema que o projeto ainda não empacota.
    Download,
}

// O comando que atualiza por esta rota, ou vazio quando não existe um comando
// (aí a tela oferece a página da release).
pub fn update_command(route: Route) -> String {
    match route {
        Route::Brew => "brew upgrade --cask loro".into(),
        Route::Download => String::new(),
    }
}

// Os Caskrooms possíveis: o prefixo que o Homebrew anuncia (HOMEBREW_PREFIX,
// exportado por `brew shellenv`) e os dois padrões — /opt/homebrew no Apple
// Silicon, /usr/local no Intel. Consultado por diretório, e não por
// `brew list --cask`, porque isto roda no arranque: um `brew` frio custa
// centenas de ms e um `stat` custa nada.
pub fn caskroom_dirs(get_env: impl Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(prefix) = get_env("HOMEBREW_PREFIX").filter(|p| !p.trim().is_empty()) {
        dirs.push(PathBuf::from(prefix).join("Caskroom/loro"));
    }
    for p in ["/opt/homebrew", "/usr/local"] {
        let d = PathBuf::from(p).join("Caskroom/loro");
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

// A rota é um FATO do disco, não uma dedução do sistema operacional: o mesmo
// macOS recebe instalação por cask e instalação por .dmg arrastado, e cada uma
// atualiza de um jeito. Só o cask deixa rastro (o Caskroom).
pub fn detect_route(exists: impl Fn(&PathBuf) -> bool) -> Route {
    if !cfg!(target_os = "macos") {
        return Route::Download;
    }
    let dirs = caskroom_dirs(|k| std::env::var(k).ok());
    if dirs.iter().any(&exists) {
        Route::Brew
    } else {
        Route::Download
    }
}

// ~/.loro/update.json — a preferência do usuário e o que a última checagem viu.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    // Ligado por padrão: um app que não avisa deixa o usuário numa versão com
    // bug conhecido. Desligável em Configurações — a rede nunca é obrigatória.
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    // Epoch em segundos da última consulta BEM-SUCEDIDA. Uma falha de rede não
    // gasta a cota do dia, senão um avião perdido adia a checagem por 24h.
    #[serde(default)]
    pub last_check: u64,
    // Última versão vista lá fora, para a tela ter resposta antes da rede.
    #[serde(default)]
    pub latest: String,
}

fn enabled_default() -> bool {
    true
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            enabled: true,
            last_check: 0,
            latest: String::new(),
        }
    }
}

pub fn state_path() -> PathBuf {
    loro_data_dir().join("update.json")
}

pub fn read_state() -> UpdateState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn write_state(st: &UpdateState) -> Result<(), String> {
    let p = state_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|_| SAVE_ERR.to_string())?;
    }
    let body = serde_json::to_string_pretty(st).map_err(|_| SAVE_ERR.to_string())?;
    std::fs::write(&p, body).map_err(|_| SAVE_ERR.to_string())
}

// ADR-0001 §10 — a tela recebe código de produto, nunca o texto do io::Error.
const SAVE_ERR: &str = "err.update_pref_save";

// `force` é o botão «verificar agora»: passa por cima do intervalo E da chave,
// porque é o usuário pedindo, nesta janela, uma consulta que ele mesmo iniciou.
// Sem force, a chave desligada é um não, e a cota é uma por intervalo.
pub fn should_check(st: &UpdateState, now: u64, force: bool) -> bool {
    if force {
        return true;
    }
    if !st.enabled {
        return false;
    }
    // Dois carimbos que NÃO são "checado há pouco", e o teste pegou o primeiro:
    // `lastCheck: 0` é «nunca verifiquei» — deixá-lo cair na subtração faz a
    // primeira checagem depender do relógio (com now=10 a conta dá 10 < 86400 e
    // uma instalação nova nunca verificava). E um carimbo NO FUTURO (relógio
    // adiantado, corrigido depois) satura a subtração em 0 e trancaria o aviso
    // para sempre. Nos dois casos a resposta é a mesma: verifique.
    if st.last_check == 0 || st.last_check > now {
        return true;
    }
    now - st.last_check >= CHECK_INTERVAL_SECS
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// A versão como três números. Aceita o "v" da tag e ignora o que vier depois de
// um sufixo (`0.14.0-rc.1`), porque /releases/latest já exclui pré-lançamento:
// o sufixo, se aparecer, é ruído de nome e não deve derrubar a comparação.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let mut it = core.split('.');
    let mut num = || it.next().unwrap_or("0").trim().parse::<u64>().ok();
    let major = num()?;
    let minor = num().unwrap_or(0);
    let patch = num().unwrap_or(0);
    Some((major, minor, patch))
}

// Comparar por NÚMERO, nunca por texto: "0.9.0" > "0.10.0" em ordem
// alfabética, e essa é exatamente a versão em que o aviso teria de funcionar.
// Uma versão ilegível dos dois lados vira "não há nada novo" — o app cala a
// boca em vez de inventar uma atualização.
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

// A tag da release na resposta da API. Draft e pré-lançamento são recusados
// AQUI também, e não só pelo endpoint: um mirror ou um fork apontado por
// LORO_RELEASE_API pode responder outra coisa, e a checagem não pode empurrar
// para o usuário uma versão que o projeto não considera publicada.
pub fn tag_from_release_json(txt: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    if v.get("draft").and_then(|b| b.as_bool()).unwrap_or(false)
        || v.get("prerelease")
            .and_then(|b| b.as_bool())
            .unwrap_or(false)
    {
        return None;
    }
    let tag = v.get("tag_name").and_then(|t| t.as_str())?.trim();
    let tag = tag.trim_start_matches(['v', 'V']);
    parse_version(tag).map(|_| tag.to_string())
}

// A consulta. Mesmo desenho do download de modelo (models.rs): curl do sistema,
// HTTPS e mais nada (`--proto =https`), sem crate de rede nova. `--max-time`
// existe para o arranque nunca depender da rede: passou de 8s, não houve
// checagem hoje, e o app segue igual.
pub fn fetch_latest_tag() -> Result<String, String> {
    // Um só código para a tela: "não deu para verificar". O motivo (sem curl,
    // rede fora, resposta estranha) vai para o log, não para o usuário — e
    // reusar `err.curl_missing` seria mentir de perto, porque essa mensagem diz
    // "necessário para baixar o modelo".
    if which("curl").is_none() {
        return Err("err.update_check_failed".into());
    }
    let out = crate::proc::command("curl")
        .args([
            "--proto",
            "=https",
            "--tlsv1.2",
            "-sSfL",
            "--max-time",
            "8",
            "-H",
            "Accept: application/vnd.github+json",
            // O User-Agent que a API do GitHub exige. Fixo de propósito: pôr a
            // versão instalada aqui contaria ao servidor algo que a consulta
            // não precisa contar.
            "-H",
            "User-Agent: loro-update-check",
            &releases_api_url(),
        ])
        .output()
        .map_err(|_| "err.update_check_failed".to_string())?;
    if !out.status.success() {
        return Err("err.update_check_failed".into());
    }
    tag_from_release_json(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "err.update_check_failed".to_string())
}

// O que a tela recebe. `checked` distingue "olhei e não há nada" de "não olhei
// agora" (intervalo, chave desligada, rede fora) — a diferença que decide se
// Configurações pode dizer «você está na última versão».
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub checked: bool,
    pub enabled: bool,
    pub last_check: u64,
    pub route: Route,
    pub command: String,
    pub url: String,
}

// A decisão inteira, sem rede e sem disco: recebe o que o estado dizia e o que
// a consulta trouxe (None = não consultei), devolve o que a tela mostra. É aqui
// que mora a regra, e é por isso que ela é testável sem GitHub nenhum.
pub fn status_from(
    current: &str,
    st: &UpdateState,
    fetched: Option<&str>,
    route: Route,
    now: u64,
) -> UpdateStatus {
    let checked = fetched.is_some();
    let latest = fetched.unwrap_or(&st.latest).to_string();
    UpdateStatus {
        available: is_newer(&latest, current),
        current: current.to_string(),
        latest,
        checked,
        enabled: st.enabled,
        last_check: if checked { now } else { st.last_check },
        route,
        command: update_command(route),
        url: releases_page_url(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A armadilha que este módulo existe para não cair: em ordem alfabética
    // "0.9.0" > "0.10.0", e o aviso silenciaria justo na virada de dezena.
    #[test]
    fn newer_is_decided_by_number_not_by_text() {
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.9.0", "0.10.0"));
        assert!(is_newer("v0.13.1", "0.13.0"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.13.0", "0.13.0"));
        assert!(!is_newer("0.12.9", "0.13.0"));
    }

    // Um app instalado à frente da última release (build local, teste) não pode
    // ser avisado para "atualizar" para trás.
    #[test]
    fn a_build_ahead_of_the_release_is_never_told_to_update() {
        assert!(!is_newer("0.13.0", "0.14.0-dev"));
        assert_eq!(parse_version("0.14.0-dev"), Some((0, 14, 0)));
    }

    // Lixo não vira atualização: sem versão legível, o app cala a boca.
    #[test]
    fn unreadable_versions_never_announce_an_update() {
        assert!(!is_newer("banana", "0.13.0"));
        assert!(!is_newer("0.14.0", "banana"));
        assert!(!is_newer("", ""));
        assert_eq!(parse_version("v1"), Some((1, 0, 0)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn tag_is_read_from_the_release_payload_without_its_v() {
        let json =
            r#"{"tag_name":"v0.13.1","name":"Loro v0.13.1","draft":false,"prerelease":false}"#;
        assert_eq!(tag_from_release_json(json).as_deref(), Some("0.13.1"));
    }

    // BR-8 / segurança: um payload de outro lugar (LORO_RELEASE_API apontado
    // para um mirror) não empurra rascunho, pré-lançamento nem tag inventada.
    #[test]
    fn draft_prerelease_and_garbage_tags_are_refused() {
        assert_eq!(
            tag_from_release_json(r#"{"tag_name":"v9.9.9","draft":true}"#),
            None
        );
        assert_eq!(
            tag_from_release_json(r#"{"tag_name":"v9.9.9","prerelease":true}"#),
            None
        );
        assert_eq!(tag_from_release_json(r#"{"tag_name":"nightly"}"#), None);
        assert_eq!(tag_from_release_json(r#"{"name":"sem tag"}"#), None);
        assert_eq!(tag_from_release_json("<html>404</html>"), None);
    }

    // A cota é uma por dia; o botão «verificar agora» é do usuário e não tem cota.
    #[test]
    fn one_check_per_day_and_the_button_always_gets_through() {
        let day = CHECK_INTERVAL_SECS;
        let st = UpdateState {
            enabled: true,
            last_check: 1_000_000,
            latest: String::new(),
        };
        assert!(!should_check(&st, 1_000_000 + day - 1, false));
        assert!(should_check(&st, 1_000_000 + day, false));
        assert!(should_check(&st, 1_000_000 + 5, true));
        // primeira execução: nunca checou — e isso não pode depender de que
        // horas são (com o relógio fake em 10s, a subtração dava 10 < 86400).
        assert!(should_check(&UpdateState::default(), 10, false));
        assert!(should_check(&UpdateState::default(), 1_800_000_000, false));
    }

    // Carimbo no futuro (relógio adiantado e depois corrigido): saturating_sub
    // devolve 0 e o aviso ficaria trancado para sempre. Verifica.
    #[test]
    fn a_stamp_from_the_future_does_not_lock_the_check_forever() {
        let st = UpdateState {
            enabled: true,
            last_check: 2_000_000_000,
            latest: String::new(),
        };
        assert!(should_check(&st, 1_000_000, false));
    }

    // A chave desligada é um NÃO para a rede automática — e continua sendo um
    // não em todo arranque, não só no primeiro.
    #[test]
    fn the_switch_off_means_no_automatic_network_call_ever() {
        let st = UpdateState {
            enabled: false,
            last_check: 0,
            latest: String::new(),
        };
        assert!(!should_check(&st, 0, false));
        assert!(!should_check(&st, 999_999_999, false));
        assert!(should_check(&st, 999_999_999, true)); // o usuário clicou
    }

    // Estado ausente/legado: o arquivo não existir, ou existir sem a chave, tem
    // de valer "ligado" — e nunca explodir.
    #[test]
    fn missing_state_reads_as_enabled_and_never_checked() {
        let st: UpdateState = serde_json::from_str("{}").unwrap();
        assert!(st.enabled);
        assert_eq!(st.last_check, 0);
        let st: UpdateState = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!st.enabled);
        let json = serde_json::to_string(&UpdateState::default()).unwrap();
        assert!(
            json.contains(r#""lastCheck":0"#),
            "camelCase no disco: {json}"
        );
    }

    // ADR-0006: quem instalou pelo cask atualiza pelo cask. O rastro é o
    // Caskroom, e o prefixo do Homebrew muda entre Apple Silicon e Intel.
    #[test]
    fn the_caskroom_is_looked_for_where_homebrew_actually_puts_it() {
        let dirs = caskroom_dirs(|_| None);
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/Caskroom/loro")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/Caskroom/loro")));
        let dirs = caskroom_dirs(|k| (k == "HOMEBREW_PREFIX").then(|| "/custom/brew".to_string()));
        assert_eq!(dirs[0], PathBuf::from("/custom/brew/Caskroom/loro"));
        assert_eq!(dirs.len(), 3, "sem duplicar os padrões: {dirs:?}");
    }

    #[test]
    fn the_brew_route_is_the_only_one_with_a_command() {
        assert_eq!(update_command(Route::Brew), "brew upgrade --cask loro");
        assert_eq!(update_command(Route::Download), "");
    }

    // Sem Caskroom não há rota brew — o .dmg arrastado à mão recebe a página da
    // release, não um comando que falharia com "Cask 'loro' is not installed".
    #[test]
    fn without_a_caskroom_the_route_is_the_download_page() {
        assert_eq!(detect_route(|_| false), Route::Download);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_caskroom_on_disk_makes_the_route_brew() {
        assert_eq!(detect_route(|_| true), Route::Brew);
    }

    // Fora do macOS não existe rota nomeada hoje: o aviso continua valendo, a
    // instrução vira a página da release (aberto para Windows/Linux ganharem a
    // sua rota sem mudar a checagem).
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn other_systems_still_get_the_notice_and_fall_back_to_the_page() {
        assert_eq!(detect_route(|_| true), Route::Download);
    }

    // "Não consultei" NÃO é "está atualizado": sem checagem a tela não pode
    // afirmar que o usuário está na última versão, e o carimbo antigo fica de pé.
    #[test]
    fn a_skipped_check_keeps_the_old_stamp_and_does_not_claim_freshness() {
        let st = UpdateState {
            enabled: true,
            last_check: 500,
            latest: "0.13.0".into(),
        };
        let s = status_from("0.13.0", &st, None, Route::Download, 9_000);
        assert!(!s.checked);
        assert_eq!(s.last_check, 500);
        assert!(!s.available);

        let s = status_from("0.13.0", &st, Some("0.13.1"), Route::Brew, 9_000);
        assert!(s.checked);
        assert_eq!(s.last_check, 9_000);
        assert!(s.available);
        assert_eq!(s.command, "brew upgrade --cask loro");
    }

    // O estado guardado responde ANTES da rede: reabrir o app dentro das 24h
    // ainda mostra o aviso que a checagem de ontem levantou.
    #[test]
    fn the_notice_survives_a_restart_without_asking_the_network_again() {
        let st = UpdateState {
            enabled: true,
            last_check: 500,
            latest: "0.14.0".into(),
        };
        let s = status_from("0.13.0", &st, None, Route::Brew, 600);
        assert!(s.available, "o que ontem viu continua valendo hoje");
        assert!(!s.checked);
        assert_eq!(s.latest, "0.14.0");
    }

    // BR-8: o que vai ao GitHub é um GET anônimo. Nada de versão instalada no
    // User-Agent, nada de identificador, e HTTPS obrigatório.
    #[test]
    fn the_query_is_https_only_and_carries_nothing_about_the_user() {
        let url = releases_api_url();
        assert!(url.starts_with("https://"), "{url}");
        let src = include_str!("update.rs");
        let call = src
            .split("pub fn fetch_latest_tag")
            .nth(1)
            .expect("a função da consulta");
        let call = &call[..call.find("\n}").unwrap_or(call.len())];
        assert!(call.contains("\"--proto\""), "curl preso a https");
        assert!(
            call.contains("User-Agent: loro-update-check"),
            "o User-Agent não pode carregar a versão instalada"
        );
        assert!(
            !call.contains("app_version") && !call.contains("CARGO_PKG_VERSION"),
            "a consulta não conta ao servidor em que versão o usuário está"
        );
    }
}
