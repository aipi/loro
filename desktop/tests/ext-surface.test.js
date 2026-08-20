// ADR-0031 R5a — the integrator's own contract: the SIXTH surface must exist
// without touching the five that already do.
//
// The pure renderer is tested in `extview.test.js` (batch C) and the manifest,
// supervisor and protocol halves live in the Rust modules that own them
// (`ext.rs`, `mcp.rs`). What is left over — and what nothing else can see — is
// the WIRING: a sentinel `rel` that no painter claims, a mini-sidebar button
// that lands on the wrong destination, a section pair whose two orders drift, a
// polled repaint that eats what the person is typing, and a string that ships
// untranslated because a scanner cannot see it.
//
// Each test below states the defect it was shown red against; three of them
// were verified by deleting the fix and watching them fail (the measurements
// are in the comments).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
const RUST_DIR = path.join(__dirname, "..", "src-tauri", "src");
const LIB = fs.readFileSync(path.join(RUST_DIR, "lib.rs"), "utf8");
const MAKEFILE = fs.readFileSync(path.join(__dirname, "..", "..", "Makefile"), "utf8");
const { EN, ERR_PT } = require("../src/i18n.js");
const EXTVIEW = require("../src/extview.js");

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
function pair(msgid) {
  assert.ok(EN[msgid] && EN[msgid] !== msgid, `falta o par em inglês de “${msgid}”`);
}

// ==================== a aba-sentinela ====================

// VERMELHO PRIMEIRO, medido: apagando o braço `if (extIdOf(tab.rel)) { … }` de
// renderActive, um `loro://ext/<id>` cai no fluxo de arquivo (app.js: `const
// textFile = isGuide || scratch || /\.(md|txt)$/i.test(tab.rel)` → false) e
// `readDoc` chama `brain_read` com o sentinela. O braço TEM de retornar.
test("os seis pontos da aba-sentinela existem, e o pintor RETORNA", () => {
  assert.match(APP, /^const EXT_PREFIX = "loro:\/\/ext\/";/m,
    "o sentinela é um const do TOPO: declarado junto dos pintores ele cai na zona morta e derruba o boot");
  const title = APP.match(/const tabTitle = \(tab\) => \([\s\S]*?\);/);
  assert.ok(title, "tabTitle continua existindo");
  assert.match(title[0], /extIdOf\(tab\.rel\)/, "a faixa de abas nomearia a aba com o sentinela cru");

  const badge = fnBody("docBadge");
  assert.match(badge, /if \(extIdOf\(p\)\) return \[/,
    "o selo padrão («documento do projeto») prometeria um arquivo que ninguém abre");

  const render = fnSource("renderActive");
  const braco = render.match(/if \(extIdOf\(tab\.rel\)\) \{[\s\S]*?\n  \}/);
  assert.ok(braco, "renderActive precisa do braço da tela de extensão");
  assert.match(braco[0], /await renderExtSurface\(tab, stale\)/);
  assert.match(braco[0], /\n    return;\n/, "sem o return o sentinela cai no fluxo de arquivo e readDoc lança");
  assert.match(render, /: extIdOf\(tab\.rel\) \? `\$\{t\("extensões"\)\}\//,
    "a linha de trilha mostraria o sentinela cru");

  assert.match(APP, /function openExt\(id\) \{ return openDoc\(EXT_PREFIX \+ id/);
  assert.match(fnBody("brainRefresh"), /refreshExt\(false\)/,
    "sem a linha no tique, a lateral só mudaria quando alguém clicasse");
});

// `extIdOf` é o único juiz de «isto é uma tela de extensão»: ele decide o
// título, o selo, a trilha E o pintor. Um id que não passa pelo alfabeto fechado
// não pode virar uma tela — senão o sentinela leva texto arbitrário ao backend.
test("extIdOf só aceita um id do alfabeto fechado", () => {
  const fn = new Function('const EXT_PREFIX = "loro://ext/";' + "return (" + fnSource("extIdOf") + ");")();
  assert.equal(fn("loro://ext/hotspots-board"), "hotspots-board");
  assert.equal(fn("loro://ext/mcp-python"), "mcp-python");
  assert.equal(fn("loro://indice"), "");
  assert.equal(fn("contexts/loro/context.md"), "");
  assert.equal(fn("loro://ext/"), "");
  assert.equal(fn("loro://ext/../../etc/passwd"), "");
  assert.equal(fn("loro://ext/UPPER"), "");
  assert.equal(fn("loro://ext/a b"), "");
  assert.equal(fn(null), "");
  assert.equal(fn(undefined), "");
});

// VERMELHO PRIMEIRO, medido: sem o braço explícito o clique cai no `goDest(what)`
// do fim do manipulador, e `shell.js:42` reescreve para "home" todo nome fora de
// DESTS — o botão levava a Início com o ícone prometendo Extensões.
test("o botão da lateral recolhida tem braço PRÓPRIO para 'ext'", () => {
  const h = APP.match(/document\.querySelectorAll\("#sideMini \.minibtn"\)[\s\S]*?\n\}\)\);/);
  assert.ok(h, "o manipulador do #sideMini continua existindo");
  assert.match(h[0], /if \(what === "ext"\) \{/);
  assert.match(h[0], /\[data-sectbody="ext"\]/);
  // MEDIDO em shell.js: `const DESTS = { home:…, organize:…, knowledge:…, review:… }`
  // e `if (!DESTS[name]) name = "home";` — "ext" não está lá, e é por isso que o
  // braço próprio é obrigatório e não uma preferência de estilo.
  const dests = fs.readFileSync(path.join(SRC, "shell.js"), "utf8");
  const mapa = dests.match(/const DESTS = \{[^}]*\}/);
  assert.ok(mapa, "shell.js continua tendo a lista de destinos");
  assert.ok(!/\bext\b/.test(mapa[0]), "'ext' NÃO é um destino");
  assert.match(dests, /if \(!DESTS\[name\]\) name = "home";/,
    "é esta linha que reescreveria o clique para Início");
  assert.match(HTML, /data-mini="ext"/);
});

// ==================== a sexta seção da lateral ====================

test("a sexta seção existe, recolhe como as outras e abre pelo ＋", () => {
  assert.match(HTML, /<button class="secttl" data-sect="ext"[^>]*aria-expanded="true">/);
  assert.match(HTML, /<div data-sectbody="ext"><div id="navExt" class="btree"><\/div><\/div>/);
  assert.match(HTML, /id="addExtBtn"[^>]*aria-label="Instalar extensão"/,
    "o ＋ tem nome acessível (a11y F5/C5)");
  const r = fnBody("renderExt");
  assert.match(r, /wireTreeKeyboard\(/, "a árvore anda pelas setas (a11y F18)");
  // o ⋯ nasce do ajudante único (a11y C5) — ele vive no pintor da LINHA
  assert.match(fnBody("extRowHtml"), /rowMenuHtml\(`data-extmenu=/);
  assert.match(r, /openExtMenu\(el2, el2\.dataset\.extmenu\)/, "e o ⋯ da linha abre o menu");
  // A linha de vazio DIZ o que a seção é e como sair dela (DESIGN §1).
  assert.match(r, /bempty/);
  assert.match(APP, /addExtBtn/);
});

// O estado NUNCA mente: sem programa não há processo, então não há selo de
// processo nem controle de iniciar/parar. É o caso da extensão de nível 1, que
// o backend reporta como `state:"running", hasProgram:false`.
test("uma extensão sem programa não ganha selo de processo nem iniciar/parar", () => {
  const row = fnBody("extRowHtml");
  assert.match(row, /r\.hasProgram\s*\n?\s*\?/, "o selo é condicionado a haver programa");
  const surf = fnBody("extSurfaceHtml");
  assert.match(surf, /temPrograma\s*$|temPrograma$/m);
  assert.match(surf, /temPrograma\s*\n?\s*\?[\s\S]*data-extstop[\s\S]*data-extstart/,
    "os dois controles só existem quando há programa para iniciar e parar");
  assert.match(surf, /esta extensão não traz programa/,
    "e quando não há, a tela DIZ que nada roda em vez de calar");
  pair("esta extensão não traz programa — a tela vem do que ela declarou, e nada roda");
});

// Os seis estados de §5.1 viram frase por `t()` LITERAL, um por estado: um
// `t(MAPA[estado])` é invisível para os dois varredores de msgid e embarcaria em
// português com a suíte verde.
test("cada estado da extensão tem frase literal e par em inglês", () => {
  const body = fnBody("extStateLabel");
  for (const s of ["rodando", "iniciando", "sem resposta", "caiu", "impedida", "parada"]) {
    assert.ok(body.includes(`t("${s}")`), `o estado «${s}» precisa de um t() literal`);
    pair(s);
  }
  assert.ok(!/t\([A-Z_]+\[/.test(body), "um msgid vindo de um mapa é invisível para os varredores");
});

// ==================== o repintar não come o que se digita ====================

// VERMELHO PRIMEIRO, medido: apagando a guarda `typing`, um tique de 10s
// (brainRefresh → refreshExt) repinta a tela por innerHTML e apaga o `field` em
// que a pessoa está escrevendo. É a MESMA cura que refreshLoops precisou.
test("um repintar sondado não apaga o que a pessoa está digitando", () => {
  const body = fnBody("refreshExt");
  assert.match(body, /const typing = document\.activeElement && B\.doc\.contains\(document\.activeElement\)/);
  assert.match(body, /if \(tab && extIdOf\(tab\.rel\) && !typing\) renderActive\(\)/);
  assert.match(body, /extSig/, "o repintar é gatilhado por assinatura, não por passada");
});

// VERMELHO PRIMEIRO, medido no mesmo par: o ouvinte de `ext-view-invalidated`
// não tinha guarda nenhuma. Este repintar é disparado pelo PROGRAMA de terceiro
// (a nota chega no laço de 500ms de `spawn_drain`), então uma extensão podia
// apagar o que a pessoa estava digitando num `field` no meio da tecla — e a tela
// voltava ao topo. O aviso não pode ser perdido: fica pendente e pinta quando o
// foco sai.
test("uma invalidação vinda do programa não come o que a pessoa está digitando", () => {
  const m = APP.match(/listen\("ext-view-invalidated",[\s\S]*?\}\);/);
  assert.ok(m, "o ouvinte continua registrado");
  assert.match(m[0], /const digitando = document\.activeElement && B\.doc\.contains\(document\.activeElement\)/);
  assert.match(m[0], /if \(digitando\) \{ extViewPendente = p\.id; return; \}/,
    "com o cursor dentro da tela o repintar espera; ele não é descartado");
  // e existe o caminho que paga a dívida
  const pend = fnBody("extRepaintPendente");
  assert.match(pend, /if \(!extViewPendente\) return;/);
  assert.match(pend, /renderActive\(\)/);
  assert.match(APP, /document\.addEventListener\("focusout", \(\) => setTimeout\(extRepaintPendente, 0\)\);/,
    "um ligador por pintura empilharia ouvintes: o B.doc sobrevive ao innerHTML");
});

// VERMELHO PRIMEIRO, MEDIDO rodando os módulos reais: um `doc` com
// `[o contrato](docs/adr/0031-the-executable-extension.md)` sai do leitor do Loro
// como `<a class="xref xref--file" href="#" data-path="…">o contrato</a>`, com
// `errors: []`. `wireExtSurface` ligava só `a[data-extv-rel]` e
// `[data-extv-action]`, e `wireDocLinks()` não é alcançável pelo braço da
// extensão — então o Tab chegava no link, o leitor de tela anunciava «link», e o
// clique navegava para `#`: nada abria e a tela rolava para o topo.
test("um link dentro da prosa de uma extensão abre o documento", () => {
  const wire = fnBody("wireExtSurface");
  assert.match(wire, /a\[data-path\]/, "o gancho do leitor do Loro também é ligado");
  assert.match(wire, /onRefClick\("", null, a\.dataset\.path, a\)/,
    "resolvido contra a RAIZ do projeto pela mesma porta guardada de sempre");
  assert.match(wire, /a\[data-ref\]/);
  // e o alvo passa pela MESMA guarda que a primitiva `link` aplica
  const XV = EXTVIEW;
  const limpo = XV.stripDoc("[dentro](docs/a.md) [fora](../../../../etc/passwd) [vazio]() [esquema](https://x.test/p)");
  assert.ok(limpo.includes("[dentro](docs/a.md)"), "uma referência de dentro continua uma referência");
  assert.ok(!limpo.includes("etc/passwd"), "um `..` não sobra nem como alvo inerte");
  assert.ok(!limpo.includes("https://"), "e nada com esquema atravessa");
  assert.ok(limpo.includes("fora") && limpo.includes("vazio") && limpo.includes("esquema"),
    "o rótulo fica como texto: o conteúdo não é jogado fora");
});

// DESIGN §1 — «um controle que relata um estado que não impõe é pior que nenhum
// controle». MEDIDO no DOM real: com `state:"no_answer"` o menu da linha oferecia
// apenas `["open","start","set","cap","rm"]` — sem `stop` — enquanto o processo
// continuava VIVO (`sweep` só anula o handle quando o filho já morreu). A única
// oferta restante era «iniciar», que subia um SEGUNDO filho e derrubava o
// primeiro para fora do registro.
test("uma extensão que parou de responder ainda pode ser parada", () => {
  const surf = fnBody("extSurfaceHtml");
  assert.match(surf, /const podeParar = row \? !!row\.canStop : false;/,
    "quem responde se há o que parar é o backend, não uma dedução do estado");
  assert.match(surf, /podeParar\s*\n?\s*\?[\s\S]*data-extstop/);
  const menu = fnBody("openExtMenu");
  assert.match(menu, /r\.canStop\s*\n?\s*\?[\s\S]*data-a="stop"/,
    "o menu da linha usa o mesmo fato");
  assert.ok(!/r\.state === "running" \|\| r\.state === "starting"/.test(menu),
    "o portão deduzido do estado foi o defeito");
  // e a assinatura do repintar carrega o fato, senão o botão nunca troca
  assert.match(fnBody("refreshExt"), /r\.canStop/);
});

// ADR-0029 R5 — «explicit second confirmation, contents named». `.loro/ext.json`
// é guardado junto com o projeto: ele chega na alteração de outra pessoa
// trazendo `program.command` e `program.args`, e a única tela que jamais nomeou
// o comando era a folha de instalar, que esse registro nunca atravessa.
test("iniciar um programa que ninguém aprovou aqui pergunta, e nomeia o comando", () => {
  const start = fnBody("startExt");
  assert.match(start, /invoke\("ext_start", \{ id, approve: !!aprovar \}\)/);
  assert.match(start, /codigo\.startsWith\("err\.ext_untrusted"\)/);
  assert.match(start, /askExtTrust\(id\)/);
  const ask = fnBody("askExtTrust");
  assert.match(ask, /p\.command/, "a folha NOMEIA o comando");
  assert.match(ask, /p\.args/, "e os argumentos, que são a metade perigosa");
  assert.match(ask, /r\.origin/, "e de onde ele veio");
  assert.match(ask, /openModal\(/);
  assert.match(ask, /startExt\(id, true\)/, "só o «sim» explícito aprova");
  for (const msgid of [
    "Rodar o programa desta extensão?",
    "isto vai rodar um programa no SEU computador, com o seu acesso: ele pode ler e escrever o que você pode. O Loro não põe o programa de uma extensão numa caixa.",
    "você só é perguntado de novo se este comando mudar.",
  ]) pair(msgid);
  assert.ok(ERR_PT["err.ext_untrusted"] && EN["err.ext_untrusted"],
    "o código que pede a confirmação tem par nos dois idiomas");
});

// MEDIDO com getComputedStyle no DOM real: o selo de estado da TELA de uma
// extensão e o de Configurações caíam em `rgb(216,211,200)` / `-apple-system` /
// 14.5px — nenhuma regra casava, porque as quatro de `.lstate` eram todas
// prefixadas por `.bitem`. Uma extensão que caiu ficava tipograficamente
// idêntica a uma que está rodando.
test("o selo de estado tem regra fora da linha da lateral", () => {
  for (const sel of [".lstate {", ".lstate.teal {", ".lstate.amber {", ".lstate.muted {"]) {
    assert.ok(CSS.includes("\n" + sel), `falta a regra ${sel}`);
  }
  // e a lateral não muda: `.bitem .lstate*` tem dois nomes e continua ganhando
  assert.ok(CSS.includes(".bitem .lstate {"));
  assert.ok(CSS.indexOf(".bitem .lstate {") < CSS.indexOf("\n.lstate {"));
  // o selo da tela e o de Configurações usam a MESMA classe (DESIGN §5)
  assert.match(fnBody("extSurfaceHtml"), /class="lstate \$\{extStateCls\(st\)\}"/);
  assert.match(fnBody("renderExtCfgList"), /class="lstate \$\{extStateCls\(r\.state\)\}"/);
});

// MEDIDO a 880px de janela (o piso é 860): o selo da aba-tela era a frase inteira
// «tela de uma extensão — não é um arquivo do projeto» dentro de `.badge`, que é
// `flex: none` e não encolhe — 373px numa faixa de 355px, empurrando o #bDocWrap
// 72px para fora e jogando a barra horizontal no #wsBody (WCAG 1.4.10). Depois:
// rolagem 0 e nenhum nó fora do cartão. Um selo é uma ou duas palavras.
test("o selo da tela de uma extensão é um selo, não uma frase", () => {
  const body = fnBody("docBadge");
  const m = body.match(/if \(extIdOf\(p\)\) return \[t\("([^"]+)"\)/);
  assert.ok(m, "o braço da extensão continua no seletor do selo (docBadge)");
  assert.ok(m[1].length <= 24, `um selo com ${m[1].length} caracteres não caberia: “${m[1]}”`);
  assert.ok(m[1].split(/\s+/).length <= 3, `um selo é uma ou duas palavras: “${m[1]}”`);
  pair(m[1]);
  assert.ok(EN[m[1]].length <= 24, `e o par em inglês também: “${EN[m[1]]}”`);
});

// MEDIDO no DOM real: `#brainDoc` carrega `doc reader`, e `.doc p` / `.doc hr`
// (classe+tipo, 0-1-1) ganham de `.extv-text` / `.extv-div` (0-1-0). Um
// `{"kind":"stack","gap":0}` media 9px entre as linhas (8.7px de margem que
// ninguém pediu) e a régua de 4px do `divider` era pintada com 16px. O papel
// pedido pelo autor tem de ser o papel pintado.
test("o degrau que a extensão pede é o degrau que a folha pinta", () => {
  for (const sel of [".extv .extv-text", ".extv .extv-div", ".extv .extv-attr", ".extv .extv-more"]) {
    assert.ok(CSS.includes(sel), `falta ${sel}: .doc p / .doc hr ganham de um nome só`);
  }
  assert.match(CSS, /\.extv \.extv-text \{ margin: 0; min-width: 0; max-width: 100%; \}/,
    "o teto de largura é o que impede um token de 46 caracteres de furar a coluna");
});

test("trocar de idioma repinta a seção E a tela da extensão", () => {
  const body = fnBody("rerenderForLang");
  assert.match(body, /extSig = ""; renderExt\(\); renderExtCfgList\(\);/,
    "sem zerar a assinatura a seção fica no idioma anterior até um tique mudá-la por outro motivo");
  assert.match(body, /renderActive\(\)/, "a tela aberta é innerHTML e é repintada pelo mesmo caminho");
});

// ==================== Configurações ====================

test("Configurações ganha Extensões, na ordem da nav e com carga tardia", () => {
  const navOrder = [...HTML.matchAll(/class="cfgnavbtn[^"]*" data-sec="([a-z]+)"/g)].map((m) => m[1]);
  const secOrder = [...HTML.matchAll(/class="cfgsec" data-sec="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(navOrder, secOrder, "o scroll-spy depende das duas ordens serem a mesma");
  assert.ok(navOrder.includes("ext"), "a seção existe na nav");
  // o data-sec passa pelo mesmo `[a-z]+` das duas varreduras acima
  assert.match("ext", /^[a-z]+$/);
  // a escada de títulos não pula degrau (a11y F10)
  assert.match(HTML, /<section class="cfgsec" data-sec="ext">\s*<h3/);
  assert.match(fnBody("markCfgNav"), /sec === "ext" && !cfgExtSeen/);
  assert.match(fnBody("openCfg"), /cfgExtSeen = false;/, "uma nova visita lê de novo");
  assert.match(fnBody("openCfg"), /refreshExt\(true\)/, "a tela abre já com a verdade na lista");
  assert.match(HTML, /id="cfgInstallExt"/);
  assert.match(fnBody("renderExtCfgList"), /class="modelrow"/, "sem inventar componente");
});

// §5.8 — a resposta é REGISTRADA e não impede nada nesta rodada. A folha tem de
// dizer as DUAS metades: o Loro não oferece porta de leitura, E não põe o
// programa numa caixa. A primeira versão desta cópia dizia só a primeira e
// afirmava «uma extensão não tem por onde ler o seu projeto» ao lado de um botão
// «recusar» — duas afirmações falsas na mesma folha, porque
// `mcp::McpClient::spawn` roda o filho sem `env_clear`, sem sandbox e sem negar
// rede (mcp.rs:444-460; proc.rs:64-77 remove 8 variáveis CLAUDE_* e nada mais).
// DESIGN §1: um controle que relata um estado que não impõe é pior que nenhum.
test("a tela de permissões declara que nada é imposto nesta versão", () => {
  const body = fnBody("openExtCapabilities");
  const frase = "o Loro não dá a uma extensão nenhuma porta para ler o seu projeto — e não põe o programa dela numa caixa: um programa iniciado roda com o seu acesso e alcança o que você alcança. A sua resposta aqui fica registrada; nesta versão ela não bloqueia nada.";
  assert.ok(body.includes(frase), "a folha diz as duas metades");
  pair(frase);
  // e não voltou a afirmar a barreira que não existe
  assert.ok(!/não tem por onde ler o seu projeto/.test(APP),
    "essa frase afirma uma contenção que o código não oferece");
  assert.ok(!/nenhuma extensão tem como ler o seu projeto por conta própria/.test(HTML),
    "a seção de Configurações dizia a mesma coisa");
  assert.match(HTML, /não põe o programa dela numa caixa/);
  // e os três botões chamam o comando que existe, com o vocabulário do backend
  for (const d of ["permitir", "recusar", "esquecer"]) {
    assert.ok(body.includes(`data-extdec="${d}"`), `a decisão «${d}» é oferecida`);
  }
  assert.match(body, /invoke\("ext_permit", \{ id, capability: b\.dataset\.extcap, decision: b\.dataset\.extdec \}\)/);
});

test("a folha de instalar diz o que a extensão declarou E o que o Loro não faz", () => {
  const body = fnBody("extPreviewHtml");
  assert.match(body, /pv\.unsupported/, "um ponto declarado e descartado em silêncio é uma tela que mente");
  assert.match(body, /pv\.trust/, "a frase de confiança nomeia o comando que vai rodar");
  assert.match(body, /pv\.conflicts/);
  assert.match(body, /pv\.installed/);
  assert.match(body, /pv\.findings/, "a triagem aparece na PORTA, não depois de instalar");
  const inst = fnBody("openInstallExt");
  assert.match(inst, /openModal\(/, "é a folha única do app: a falha a mantém aberta");
  assert.match(inst, /invoke\("ext_install", \{ source: dir, hoje: loopNow\(\)\.date \}\)/,
    "o tempo civil vem do frontend (loops.rs:169-175)");
  assert.match(inst, /throw t\("escolha a pasta da extensão"\)/, "um `toast` + return fecharia a folha");
});

// ==================== os ganchos do renderizador ====================

// MEDIDO (app.js: `B.doc.querySelectorAll("a[data-path]")` resolvido contra o rel
// do documento aberto): o documento aberto aqui é o sentinela, então reusar
// `data-path` mandaria o caminho por um resolvedor com a base errada. Cada gancho
// que `extview.js` emite tem de ter um ligador deste lado — senão o controle não
// faz nada, que é o defeito que a premissa do dono proíbe.
test("todo gancho que o renderizador emite tem ligador na tela", () => {
  const EXTV = fs.readFileSync(path.join(SRC, "extview.js"), "utf8");
  // o `args` sai por uma aspa ESCAPADA no fonte (`"data-extv-args=\"" + …`), então
  // o varredor tem de aceitar as duas grafias — senão ele deixa de ver um gancho.
  const ganchos = [...new Set([...EXTV.matchAll(/data-extv-([a-z]+)=\\?"/g)].map((m) => m[1]))].sort();
  // round 2: `ask` entrou (o botão que abre a porta do chat). Os sufixos
  // ask-target/ask-hint/ask-ph não são ganchos próprios — são carga do mesmo
  // botão, lidos por askExtChat.
  assert.deepEqual(ganchos, ["action", "args", "ask", "confirm", "field", "rel", "values"],
    "a lista de ganchos mudou: o ligador tem de mudar com ela");
  const wire = fnBody("wireExtSurface");
  assert.match(wire, /a\[data-extv-rel\]/);
  assert.match(wire, /onRefClick\("", null, a\.dataset\.extvRel, a\)/,
    "resolvido contra a RAIZ do projeto pela mesma porta guardada de sempre");
  assert.match(wire, /\[data-extv-action\]/);
  assert.match(wire, /\[data-extv-ask\]/, "o botão ask sem ligador é um controle que não faz nada");
  const ask = fnBody("askExtChat");
  assert.match(ask, /dataset\.extvAskTarget/, "o alvo resolvido na linha tem de chegar ao chat");
  assert.match(ask, /dispatchAiFromSheet/, "o envio passa pela MESMA porta das outras folhas de IA");
  // um campo que é ajuste declarado persiste pela mesma porta de Configurações
  assert.match(wire, /ext_settings_set/, "o campo-ajuste do quadro sem persistência mentiria a folha");
  const run = fnBody("runExtAction");
  assert.match(run, /dataset\.extvArgs/);
  assert.match(run, /dataset\.extvValues/);
  assert.match(run, /data-extv-field/);
  assert.match(fnBody("askExtAction"), /dataset\.extvConfirm/,
    "um `confirm` declarado e ignorado seria uma promessa que a tela não cumpre");
});

// Cada classe que o renderizador emite tem de existir na folha: uma classe sem
// regra é um layout que não acontece, e a lista é FECHADA de propósito.
test("toda classe da lista fechada tem regra em style.css", () => {
  const semRegra = EXTVIEW.CLASSES.filter((c) => !new RegExp("\\." + c + "(?![\\w-])").test(CSS));
  assert.deepEqual(semRegra, [], "classe emitida sem regra na folha:\n  " + semRegra.join("\n  "));
  // e os modificadores que NÃO são classe (para a lista ficar fechada)
  for (const sel of [
    '.extv-text[data-wrap="false"]',
    '.extv-text[data-family="mono"]',
    '.extv-doc[data-plain="true"]',
  ]) assert.ok(CSS.includes(sel), `falta a regra ${sel}`);
  for (const step of [0, 2, 4, 6, 8, 10, 12, 14]) {
    assert.ok(CSS.includes(`.extv-spacer[data-step="${step}"]`), `falta o degrau ${step} do espaçador`);
  }
});

// A folha inteira do app é medida por tokens.test.js; o que ELE não pode ver é
// se este bloco novo trouxe uma medida crua de terceiro para dentro do tema.
test("o bloco .extv não traz uma cor crua nem desliga um anel de foco", () => {
  const bloco = CSS.slice(CSS.indexOf("/* ============ a tela de uma extensão"));
  assert.ok(bloco.length > 500, "o bloco existe");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(bloco), "toda cor deste bloco é um token dos dois :root");
  assert.ok(!/outline\s*:\s*(none|0)/.test(bloco), "nenhum anel de foco é desligado aqui (WCAG 2.4.7)");
  assert.ok(!/!important/.test(bloco));
});

// ==================== registro, tradução e lint ====================

test("os treze comandos ext_* estão registrados, antes de ai_doctor", () => {
  const handler = LIB.match(/generate_handler!\[([\s\S]*?)\n {8}\]\)/);
  assert.ok(handler, "lib.rs continua tendo o generate_handler");
  const lista = handler[1];
  const cmds = ["ext_list", "ext_preview", "ext_install", "ext_remove", "ext_start", "ext_stop",
    "ext_view", "ext_action", "ext_settings_schema", "ext_settings_get", "ext_settings_set",
    "ext_capabilities", "ext_permit"];
  for (const c of cmds) assert.ok(lista.includes(`            ext::${c},\n`), `falta ${c} no invoke_handler`);
  assert.ok(lista.indexOf("ext::ext_list,") < lista.indexOf("ai_doctor"),
    "ai_doctor NÃO tem vírgula: inserir depois dele não compila");
  assert.match(LIB, /^mod ext;$/m);
  assert.match(LIB, /^mod mcp;$/m);
  // §4.7 — sair leva os programas das extensões com a árvore inteira
  assert.match(LIB, /tauri::RunEvent::ExitRequested \{ \.\. \} = event \{\n {12}ext::stop_all\(\);/);
});

// O varredor de `err.*` de i18n.test.js lê só `src-tauri/src/*.rs`; este cobre a
// outra metade: os códigos que o RENDERIZADOR levanta e que nenhum .rs cita.
test("todo err.ext_* que o renderizador levanta tem par nos dois idiomas", () => {
  const EXTV = fs.readFileSync(path.join(SRC, "extview.js"), "utf8");
  const codigos = [...new Set([...EXTV.matchAll(/"(err\.ext_[a-z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.ok(codigos.length >= 10, `o varredor tem de achar os códigos, achei ${codigos.length}`);
  const semPar = codigos.filter((c) => !(c in ERR_PT) || !(c in EN)).sort();
  assert.deepEqual(semPar, [], "código do renderizador sem tradução:\n  " + semPar.join("\n  "));
});

// Um código reservado SEM gatilho é texto que mente: ele ganha o par na rodada
// que puder levantá-lo, não nesta.
test("nenhum código reservado desta rodada ganhou tradução por antecipação", () => {
  const RS = fs.readdirSync(RUST_DIR).filter((f) => f.endsWith(".rs"))
    .map((f) => fs.readFileSync(path.join(RUST_DIR, f), "utf8")).join("\n");
  for (const c of ["err.ext_outbound_unattended", "err.ext_toolchain_missing", "err.ext_checksum"]) {
    assert.ok(!RS.includes(c), `${c} passou a ter gatilho — agora ele PRECISA do par`);
    assert.ok(!(c in ERR_PT), `${c} não tem gatilho nesta rodada: a mensagem prometeria um estado que não existe`);
  }
});

test("o módulo novo é conferido pelo make lint", () => {
  const m = MAKEFILE.match(/^JS_SRC :=(.*)$/m);
  assert.ok(m, "o Makefile continua tendo JS_SRC");
  assert.ok(m[1].includes("desktop/src/extview.js"),
    "JS_SRC é lista fixa, não glob: fora dela o módulo nunca é `node --check`ado");
  assert.match(HTML, /<script src="extview\.js"><\/script>\s*\n\s*<script src="audio\.js">|<script src="extview\.js"><\/script>/,
    "extview.js é carregado antes de app.js, que é o último");
  assert.ok(HTML.indexOf('src="extview.js"') < HTML.indexOf('src="app.js"'));
});
