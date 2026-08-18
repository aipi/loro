// ADR-0029 — plugins (pacotes): a extensão é um pacote, e instalar é uma mudança.
//
// A metade de dentro (manifesto, classe, plano, triagem, remoção) é testada no
// Rust, onde ela vive (`src-tauri/src/plugins.rs`). Aqui ficam os contratos que a
// TELA tem de honrar, e um deles é o mais importante da ADR: a recusa nomeia a
// CLASSE em vez de falhar em geral.
//
// O que estes testes existem para impedir:
//   · uma folha que fecha na falha e leva embora o que a pessoa digitou (§5.1.4)
//   · uma recusa genérica onde o motivo era conhecido (§3.2)
//   · uma triagem que aparece depois de instalar, e não na porta (§3.4)
//   · «remover» apagando o que a pessoa escreveu depois (§3.5)
//   · uma habilidade sem dizer de onde veio (§5.1.1)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const RUST = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "plugins.rs"), "utf8");
const { EN, ERR_PT } = require("../src/i18n.js");

function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}
function fnBody(name) {
  const src = fnSource(name);
  return src.slice(src.indexOf("{") + 1, -1);
}
function loadPure(name, extra) {
  const prelude = `
    const t = (s, args) => (args || []).reduce((acc, v, i) => acc.split("%" + (i + 1)).join(v), s);
    const esc = (s) => String(s === undefined || s === null ? "" : s);
    const INTAKE_LABEL = { "intake.cpf": () => "um número no formato de CPF" };
  ` + (extra || "");
  // eslint-disable-next-line no-new-func
  return new Function(prelude + "return (" + fnSource(name) + ");")();
}
function pair(msgid) {
  assert.ok(EN[msgid] && EN[msgid] !== msgid, `falta o par em inglês de “${msgid}”`);
}

// ============================ a folha do instalar ============================

// §5.1.4 — a folha usa a folha ÚNICA do app: pendência automática no primário,
// erro no slot role="alert" que já existe, e só o sucesso a fecha. Um `toast` +
// `return` aqui fecharia a folha e apagaria o caminho digitado.
test("a folha do instalar é a folha do app, e a falha a mantém aberta", () => {
  const body = fnBody("openInstallPlugin");
  assert.match(body, /openModal\(t\("Instalar plugin"\)/, "uma folha, a do app");
  assert.match(body, /throw t\("escolha a pasta do plugin"\)/,
    "recusar é LANÇAR: um toast fecharia a folha e levaria o caminho digitado");
  assert.ok(!/toast\([^)]*\);\s*return;/.test(body), "nenhuma validação que fecha a folha");
  assert.match(body, /invoke\("brain_install_plugin", \{ source: dir, hoje: loopNow\(\)\.date \}\)/);
  assert.match(body, /invoke\("pick_folder"\)/, "o picker é o do sistema, sem caminho inventado");
  assert.match(body, /invoke\("brain_plugin_manifest", \{ source: dir \}\)/, "o preview é read-only");
  // e depois de instalar, a árvore e a Revisão sabem
  assert.match(body, /refreshPlugins\(\)/);
  assert.match(body, /brainRefresh\(\)/);
  assert.match(body, /Revisão/, "a cópia diz onde a mudança vai aparecer");
});

// §3.2 — a recusa NOMEIA a classe. Um erro genérico deixaria a pessoa sem saber
// que o problema é o TIPO do pacote, não o pacote.
test("um pacote executável é recusado nomeando o que ele traz", () => {
  const html = loadPure("pluginPreviewHtml")({
    id: "devops", name: "devops-hooks", version: "1.0.0", author: "",
    class: "executable", executable: ["hooks/", "bin/"],
    brings: { skills: [], contexts: [], loops: [] }, writes: [],
    findings: [], blocked: false, conflicts: [], unsupported: [], installed: null,
  });
  assert.match(html, /role="alert"/, "a recusa mora no slot que o leitor de tela anuncia");
  assert.match(html, /hooks\/ · bin\//, "diz QUAIS automações");
  assert.match(html, /rodam comandos no seu computador/);
  assert.match(html, /só habilidades, temas e loops, que são instruções/);
  // e o backend recusa pelo mesmo motivo, com o código que a tela traduz
  assert.match(RUST, /err\.plugin_kind_unsupported/);
  assert.ok("err.plugin_kind_unsupported" in ERR_PT && EN["err.plugin_kind_unsupported"]);
});

// §3.4 — a triagem da ADR-0024 vale na porta do install: credencial bloqueia,
// CPF avisa, e a pessoa decide. E o achado nunca viaja (BR-8).
test("a triagem aparece ANTES de instalar, e um bloqueio não é um aviso", () => {
  const warn = loadPure("pluginPreviewHtml")({
    id: "x", name: "x", version: "", author: "", class: "declarative", executable: [],
    brings: { skills: ["/loro-parecer"], contexts: [], loops: [] }, writes: [],
    findings: [{ rel: "pt/AGENTS.md", findings: [{ severity: "warn", rule: "intake.cpf", line: 3, count: 1 }] }],
    blocked: false, conflicts: [], unsupported: [], installed: null,
  });
  assert.match(warn, /class="intakehead warn"/);
  assert.match(warn, /confira antes de instalar/);
  assert.match(warn, /CPF/, "o rótulo vem do mapa que já existe, sem o texto achado");
  assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(warn), "BR-8: o achado nunca aparece");
  const blocked = loadPure("pluginPreviewHtml")({
    id: "x", name: "x", version: "", author: "", class: "declarative", executable: [],
    brings: { skills: [], contexts: [], loops: [] }, writes: [],
    findings: [{ rel: "commands/x.md", findings: [{ severity: "block", rule: "intake.secret", line: 1, count: 1 }] }],
    blocked: true, conflicts: [], unsupported: [], installed: null,
  });
  assert.match(blocked, /class="intakehead block"/);
  assert.match(blocked, /não vai entrar/);
  assert.match(blocked, /versionado e vai para o git/, "diz POR QUE a porta é de mão única");
});

test("o preview diz o que traz, o que já existe e o que esta versão não instala", () => {
  const html = loadPure("pluginPreviewHtml")({
    id: "juridico-br", name: "juridico-br", version: "1.2.0", author: "OAB",
    description: "habilidades juridicas", class: "declarative", executable: [],
    brings: { skills: ["/loro-parecer", "/loro-contrato"], contexts: ["juridico"], loops: ["revisao-de-prazos"] },
    writes: [], findings: [], blocked: false,
    conflicts: [".claude/commands/loro-parecer.md"], unsupported: ["mcp", "agentsExtra"],
    installed: "1.1.0",
  });
  assert.match(html, /juridico-br/);
  assert.match(html, /1\.2\.0 · OAB/);
  assert.match(html, /\/loro-parecer · \/loro-contrato/);
  assert.match(html, /revisao-de-prazos/);
  assert.match(html, /chega desligado; ligar é um ato seu/, "§3.8.1 dito antes do clique");
  assert.match(html, /1 arquivo\(s\) já existem e não serão sobrescritos/, "§3.5");
  assert.match(html, /também declara mcp · agentsExtra, que esta versão ainda não instala/,
    "§3.7 — nada é descartado em silêncio");
  assert.match(html, /a versão 1\.1\.0 deste plugin já está instalada/);
  assert.match(html, /Nada é enviado nem publicado/);
});

// §3.5 — remover subtrai o que o pacote trouxe. O que a pessoa editou depois
// FICA, e a tela diz qual.
test("remover diz o que sai e o que fica, na caixa larga da confirmação", () => {
  const body = fnBody("openConfirmRemovePlugin");
  assert.match(body, /confirm-actions/, "a caixa larga vem desta classe (240–260px)");
  assert.match(body, /btn-danger/);
  assert.match(body, /Um arquivo que você editou depois FICA/);
  assert.match(body, /invoke\("brain_remove_plugin", \{ id: p\.id \}\)/);
  assert.match(body, /r\.kept/, "a tela lê o que ficou");
  assert.match(body, /closeTabsUnder/, "uma aba de um arquivo removido não fica órfã");
  // e o backend decide pelo digest, não pela data — e NÃO SABER guarda o arquivo:
  // um digest vazio (a máquina não tinha a ferramenta de hash) apagava tudo
  assert.match(RUST, /if f\.sha256\.is_empty\(\) \|\| !now\.eq_ignore_ascii_case\(&f\.sha256\)/);
  // e o caminho do registro é guardado como qualquer caminho do acervo: o registro
  // é versionado, então ele chega no commit de outra pessoa
  assert.match(RUST, /crate::acervo::guarded_existing\(base, &f\.rel\)/);
});

// §5.1.1 — de onde veio uma habilidade é a pergunta que importa quando ela se
// comporta mal. Uma pill por linha: «padrão» e a origem nunca coexistem.
test("a linha da habilidade diz o plugin de onde veio", () => {
  const row = fnSource("toolRow");
  assert.match(row, /pluginOfRel\(f\.path\)/);
  assert.match(row, /class="pill mono"/);
  assert.match(row, /veio do plugin %1/);
  // um built-in tem a pill "padrão" e NENHUMA origem (a expressão é um ou-outro)
  assert.match(row, /f\.builtin\s*\n?\s*\? `<span class="pill"/);
  pair("veio do plugin %1");
  assert.match(fnBody("pluginOfRel"), /\(p\.files \|\| \[\]\)\.some\(\(f\) => f\.rel === rel\)/,
    "a origem sai do registro do install, não de um palpite pelo nome");
});

test("o ＋ das habilidades ganha a terceira entrada, sem submenu", () => {
  const body = fnBody("openAddToolMenu");
  assert.match(body, /data-plug/);
  assert.match(body, /instalar plugin…/);
  assert.match(body, /fsep/, "a entrada nova é separada das duas de autoria");
  assert.equal((body.match(/fitem2/g) || []).length, 3, "três entradas, uma lista");
  assert.match(body, /openInstallPlugin\(\)/);
  // e o ＋ dos loops tem as suas duas
  const from = APP.indexOf('const add = $("addLoopBtn")');
  assert.ok(from > 0);
  const block = APP.slice(from, from + 700);
  assert.match(block, /novo loop…/);
  assert.match(block, /instalar de um plugin…/);
});

// §4.2 — a gerência mora na página de Configurações que já existe, e a seção
// carrega o seu quando é alcançada (uma vez por visita).
test("Configurações ganha Plugins e Loops, na ordem da nav e com carga tardia", () => {
  const navOrder = [...HTML.matchAll(/class="cfgnavbtn[^"]*" data-sec="([a-z]+)"/g)].map((m) => m[1]);
  const secOrder = [...HTML.matchAll(/class="cfgsec" data-sec="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(navOrder, secOrder, "o scroll-spy depende das duas ordens serem a mesma");
  assert.ok(navOrder.includes("plugins") && navOrder.includes("loops"));
  const spy = fnBody("markCfgNav");
  assert.match(spy, /sec === "plugins" && !cfgPluginsSeen/);
  assert.match(spy, /sec === "loops" && !cfgLoopsSeen/);
  assert.match(fnBody("openCfg"), /cfgPluginsSeen = false; cfgLoopsSeen = false;/,
    "uma nova visita lê de novo");
  // as duas seções são h3 (a escada de títulos não pula degrau — a11y F10)
  assert.match(HTML, /<section class="cfgsec" data-sec="plugins">\s*<h3/);
  assert.match(HTML, /<section class="cfgsec" data-sec="loops">\s*<h3/);
  // o segmentado tem grupo e rótulo (a11y F7)
  assert.match(HTML, /id="loopParSeg" role="group" aria-labelledby="lblLoopPar"/);
});

test("a lista de plugins reaproveita a linha que Configurações já tem", () => {
  const body = fnBody("renderPluginList");
  assert.match(body, /class="modelrow"/, "sem inventar componente");
  assert.match(body, /rowMenuHtml\(/, "o ⋯ passa pelo ajudante único");
  assert.match(body, /pluginmeta/);
  assert.match(body, /nenhum plugin instalado/, "estado vazio que explica o conceito");
  pair("nenhum plugin instalado. Um plugin traz habilidades, temas e loops prontos — e você revê tudo antes de virar oficial.");
});

// A ADR inteira depende disto: a classe sai da ÁRVORE do pacote, não do que o
// manifesto afirma (a lição da ADR-0024, onde o nome do arquivo decidia).
test("a classe do pacote é lida da árvore, no backend", () => {
  assert.match(RUST, /pub fn class_of\(entries: &\[String\]\) -> &'static str/);
  assert.match(RUST, /let class = class_of\(&entries\);/,
    "o preview usa a função, e não repete a decisão");
  for (const m of ["hooks/", ".mcp.json", ".lsp.json", "monitors/", "bin/", "settings.json", "agents/"]) {
    assert.ok(RUST.includes(`"${m}"`), `${m} tem de contar como executável`);
  }
  // e nada aqui é executado: o pacote é instrução
  assert.ok(!/Command::new|proc::command/.test(RUST), "um pacote nunca é executado pelo app");
});

test("todo código err.plugin_* tem mensagem nos dois idiomas", () => {
  const codes = [...RUST.matchAll(/"(err\.[a-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(codes.length >= 8, `poucos códigos: ${codes.length}`);
  for (const c of new Set(codes)) {
    assert.ok(c in ERR_PT, `falta pt de ${c}`);
    assert.ok(c in EN, `falta en de ${c}`);
  }
});

test("os msgids da superfície de plugins têm par em inglês", () => {
  for (const m of [
    "Instalar plugin", "instalar plugin…", "o que este plugin traz", "remover plugin",
    "ver o que trouxe", "plugin removido", "confira antes de instalar",
  ]) pair(m);
});
