// THE BAR §3 as tests: the app must be operable without a mouse and legible to
// assistive tech (WCAG 2.1 AA). Each test below was written from a defect found
// by driving the running app:
//
//   F5/F17/F18 — the sidebar tree, the Conhecimento cards and every ⋯ menu were
//                role-less, unfocusable <div>s with onclick and no key handler;
//                Escape did not close a menu and focus never came back.
//   F6        — no live region anywhere: 183 toasts, the chat's "pensando…",
//                the wizard error and the recording state were silent.
//   F7        — selected/current state was a CSS class and nothing else.
//   F8        — the ⌘K palette had no combobox/listbox semantics.
//   F9        — the select that decides WHAT is recorded and the one that decides
//                WHERE knowledge lands had no accessible name.
//   F10       — no heading outline; Configurações jumped to <h3>.
//   F19       — the overlays never moved focus in, contained it or restored it.
//
// The frontend is vanilla JS loaded by <script> (no DOM under `node --test`), so
// the seam is the SOURCE of app.js/index.html, like wizard.test.js and
// honest-controls.test.js. Pure decisions are exercised for real.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const { EN } = require("../src/i18n.js");

// body of a top-level `function name(...) { … }` / `async function name(...) { … }`
function fnBody(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[1];
}
// a top-level `const NAME = [ … ];` table
function constTable(name) {
  const m = APP.match(new RegExp("const " + name + " = \\[([\\s\\S]*?)\\n\\];"));
  assert.ok(m, `app.js deve definir ${name}`);
  return m[1];
}
// `t` de identidade: em pt o msgid É o texto, então uma decisão pura pode ser
// exercitada sem o dicionário nem o DOM.
function loadPure(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  // eslint-disable-next-line no-new-func
  return new Function("const t = (s) => s;\nreturn (" + m[0] + ");")();
}
// the opening tag of an element by id, e.g. tag("toast") → '<div id="toast" …>'
function tag(id) {
  const m = HTML.match(new RegExp('<[a-z0-9]+[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(m, `index.html deve conter #${id}`);
  return m[0];
}

// ------------------------------------------------------------------ F6
// Um toast é o ÚNICO canal de sucesso/erro do app (DESIGN.md §5). Sem região
// viva ele é pixels: para quem usa leitor de tela, "transcrição falhou" é
// indistinguível de a ação não ter feito nada.
test("F6 — o toast é uma região viva polite", () => {
  const t = tag("toast");
  assert.match(t, /role="status"/);
  assert.match(t, /aria-live="polite"/);
  assert.match(t, /aria-atomic="true"/);
});

test("F6 — o toast aparece ANTES de receber o texto", () => {
  // uma região viva só é lida quando o texto MUDA com ela na árvore visível:
  // escrever e depois revelar não anuncia nada.
  for (const name of ["toast", "toastAction"]) {
    const body = fnBody(name);
    const reveal = body.indexOf("hidden = false");
    const write = body.search(/textContent = (msg|"")/);
    assert.ok(reveal >= 0 && write >= 0, `${name} deve revelar e escrever`);
    assert.ok(reveal < write, `${name}: revelar vem antes de escrever, senão nada é anunciado`);
  }
});

test("F6 — existe UMA região viva do app, e um único ponto que fala nela", () => {
  const live = tag("srLive");
  assert.match(live, /role="status"/);
  assert.match(live, /aria-live="polite"/);
  const body = fnBody("announce");
  assert.match(body, /srLive/, "announce() é o único escritor da região");
  // toasts e o estado da gravação passam por ela
  assert.match(fnBody("toast"), /announce\(/);
  assert.match(APP, /announce\(t\("gravando"\)\)/, "o estado da gravação é um status, não um alerta");
});

test("F6 — o erro do wizard é um alerta e aparece antes de ser escrito", () => {
  assert.match(tag("brainSetupErr"), /role="alert"/);
  const m = APP.match(/B\.setupErr\.hidden = false;[\s\S]{0,80}?setupErr\.textContent|B\.setupErr\.textContent[\s\S]{0,80}?setupErr\.hidden = false/);
  assert.ok(m, "o erro do wizard continua sendo escrito");
  assert.match(m[0], /^B\.setupErr\.hidden = false;/, "revelar antes de escrever — senão o alerta é mudo");
});

test("F6 — o chat anuncia que está pensando e que terminou", () => {
  const body = fnBody("chatThinking");
  assert.match(body, /announce\(/, "o indicador visual não existe para a tecnologia assistiva");
});

// ------------------------------------------------------------------ F17/F5
// Todo menu ⋯ era uma pilha de <div class="fitem2"> com .onclick: um usuário de
// teclado chegava ao ⋯ (que é um <button>), abria o menu e ficava preso — nenhum
// item focável, e o Escape não fechava.
test("F17 — um único helper dá teclado a TODOS os menus flutuantes", () => {
  const body = fnBody("wireFloatMenu");
  assert.match(body, /role", "menu"|role","menu"/, "o menu declara o papel que seu comportamento já tem");
  assert.match(body, /menuitem/, "cada item é um menuitem focável");
  assert.match(body, /tabIndex = -1/, "itens de menu não são paradas de Tab: setas, não Tab");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]) {
    assert.match(body, new RegExp(key), `o menu deve responder a ${key}`);
  }
  assert.match(body, /\.focus\(\)/, "o foco entra no menu ao abrir");
});

test("F17 — placeMenu (o colocador de TODOS os menus) arma o teclado", () => {
  const body = fnBody("placeMenu");
  assert.match(body, /wireFloatMenu\(/,
    "o conserto é no helper compartilhado, não em cada um dos 14 menus");
  // o menu do seletor de projetos não passa por placeMenu: arma direto
  assert.match(APP, /wireFloatMenu\(B\.acervoMenu/, "o menu de projetos também é operável");
});

test("F17 — fechar um menu devolve o foco a quem o abriu", () => {
  const body = fnBody("closeFloat");
  assert.match(body, /focus\(\)/, "sem isto o foco cai no <body> e o Tab reinicia do topo");
  assert.match(body, /aria-expanded/, "o ⋯ volta a dizer que está fechado");
});

test("F17 — o ⋯ que abre o menu declara que ele existe", () => {
  const body = fnBody("wireFloatMenu");
  assert.match(body, /aria-haspopup/);
  assert.match(body, /aria-expanded", "true"|aria-expanded","true"/);
});

// ------------------------------------------------------------------ F18
// Expandir uma pasta, abrir um tema ou uma ideia era impossível sem mouse: as
// linhas são <div class="bitem"> com onclick. Elas CONTÊM um <button class=
// "rowmenu"> (o ⋯), então um <button> por fora seria HTML inválido — a linha
// recebe o papel que seu comportamento já tem, dentro de uma árvore de verdade.
test("F18 — as linhas da árvore ganham papel, nome e foco", () => {
  const body = fnBody("wireTreeKeyboard");
  assert.match(body, /treeitem/);
  assert.match(body, /"tree"/, "o container é a árvore");
  assert.match(body, /group/, "os filhos (.bchild) são um grupo, não itens soltos");
  assert.match(body, /aria-expanded/, "uma linha que abre/fecha diz em que estado está");
  assert.match(body, /tabIndex = row === cur \? 0 : -1/,
    "uma única parada de Tab por árvore (tabindex rotativo)");
});

test("F18 — a árvore anda pelas setas e age no Enter/Espaço", () => {
  const body = fnBody("onTreeKey");
  for (const key of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter", " "]) {
    assert.match(body, new RegExp(key === " " ? '" "' : key), `a árvore deve responder a ${key}`);
  }
});

test("F18 — quem monta a árvore arma o teclado (os dois ligadores)", () => {
  assert.match(fnBody("wireSidebar"), /wireTreeKeyboard\(/);
  assert.match(fnBody("wirePessoal"), /wireTreeKeyboard\(/);
});

test("F18 — o card de conhecimento é operável e tem nome próprio", () => {
  const body = fnBody("renderDestKnowledge");
  assert.match(body, /role="button"/, "o card é a ação primária da tela");
  assert.match(body, /tabindex="0"/);
  assert.match(body, /aria-label=/, "sem nome explícito o card seria lido inteiro, texto por texto");
  assert.match(body, /onkeydown|keydown/, "Enter e Espaço abrem o tema");
});

test("F5 — cada ⋯ tem um nome próprio, não cinco 'ações' iguais", () => {
  // numa lista de 5 itens havia 5 controles com o MESMO nome acessível
  const genericos = [...APP.matchAll(/class="rowmenu"[^>]*title="\$\{t\("ações"\)\}"/g)];
  assert.deepStrictEqual(genericos.map((m) => m[0]), [],
    "um ⋯ precisa dizer de QUAL item ele é");
});

// C5 — a rodada anterior consertou o TITLE, que não é o nome acessível de um
// <button>: pelo algoritmo de accname o nome vem do CONTEÚDO, então os 19
// gatilhos da tela calculavam todos "⋯". O nome tem de ser explícito.
test("C5 — todo ⋯ nasce de um helper único e leva aria-label", () => {
  const tags = [...APP.matchAll(/<button class="rowmenu"[^>]*?>/g)].map((m) => m[0]);
  assert.ok(tags.length >= 2, `esperava os gatilhos ⋯ em app.js, achei ${tags.length}`);
  const semNome = tags.filter((tg) => !/aria-label=/.test(tg));
  assert.deepStrictEqual(semNome, [], "um ⋯ sem aria-label é lido como '⋯':\n  " + semNome.join("\n  "));
  const body = fnBody("rowMenuHtml");
  assert.match(body, /aria-label=/, "o helper é o dono do nome");
  assert.match(body, /\$\{label\}|esc\(name\)|\$\{name\}/,
    "o nome tem de conter o item — sem isso volta a ser genérico");
});

test("C5 — o nome do ⋯ é montado com o rótulo do item, não com o slug", () => {
  // os 11 ⋯ de habilidades tinham o MESMO title ("ações (usar, editar…)")
  const row = APP.match(/function toolRow\(f\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(row, "app.js deve definir toolRow()");
  assert.match(row[1], /rowMenuHtml\(/, "a linha da habilidade usa o helper");
  assert.match(row[1], /label/, "o nome do ⋯ é o rótulo da habilidade");
});

// ------------------------------------------------------------------ C18
// A faixa de abas era um <div> por aba, sem papel e sem aria-selected: qual
// documento está aberto existia SÓ na classe .on (WCAG 4.1.2/1.3.1). As abas do
// painel direito já eram abas de verdade — estas não.
test("C18 — a faixa de documentos abertos é um tablist", () => {
  assert.match(tag("wsTabs"), /role="tablist"/, "#wsTabs é a faixa de abas");
  const body = fnBody("renderTabs");
  assert.match(body, /role="tab"/, "cada aba declara o papel que seu comportamento tem");
  assert.match(body, /aria-selected="\$\{/, "qual aba está ativa não pode viver só no CSS");
  assert.match(body, /tabindex="\$\{/, "tabindex rotativo: uma parada de Tab por faixa");
});

test("C18 — as abas de documento andam pelas setas", () => {
  const body = fnBody("onTabKey");
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.match(body, new RegExp(key), `a faixa de abas deve responder a ${key}`);
  }
  assert.match(fnBody("wireTabs"), /onTabKey\(/, "quem monta a faixa arma o teclado");
});

test("C18 — a seleção da árvore e a cor do projeto também chegam à ARIA", () => {
  const table = constTable("ARIA_MIRROR");
  assert.match(table, /\.bitem/, "a linha selecionada da árvore era só uma classe");
  assert.match(table, /swatch/, "a cor escolhida era só uma classe");
});

// ------------------------------------------------------------------ C3/C20
// #editWrap era a ÚNICA folha modal que o Escape não fechava — e é a que prende
// o foco atrás de um fundo inert. O conserto é no par entrar/sair que todas
// usam, não num listener avulso.
test("C3 — o Escape fecha a folha que está no topo, qualquer que seja ela", () => {
  const enter = fnBody("enterOverlay");
  assert.match(enter, /onEscape|close/, "quem entra na pilha registra como se fecha");
  const m = APP.match(/window\.addEventListener\("keydown", \(e\) => \{[^}]*Escape[^}]*overlayStack[\s\S]*?\}\);/);
  assert.ok(m, "um único ouvinte fecha a camada do topo (não um por folha)");
});

test("C3 — as três folhas registram o seu fechador", () => {
  assert.match(fnBody("openCfg"), /enterOverlay\(cfgWrap, cfgClose, closeCfg\)/);
  assert.match(fnBody("openEditor"), /enterOverlay\(B\.editWrap,[\s\S]*?closeEditor\)/);
  assert.match(fnBody("openModal"), /closeModal\)/);
  // e o listener avulso de cada uma saiu de cena
  assert.ok(!/Escape" && !cfgWrap\.hidden/.test(APP), "sobrou um Escape avulso para Configurações");
  assert.ok(!/Escape" && !PM\.wrap\.hidden/.test(APP), "sobrou um Escape avulso para a folha de confirmação");
});

// ------------------------------------------------------------------ C21
// Na árvore, ArrowRight ATIVAVA o nó: abria um documento e jogava o foco no
// editor. Pelo padrão tree do WAI-ARIA APG, num nó fechado ele EXPANDE, num nó
// aberto vai para o primeiro filho, e nunca ativa.
test("C21 — ArrowRight expande, nunca ativa", () => {
  const body = fnBody("onTreeKey");
  const dir = body.match(/ArrowRight[\s\S]*?ArrowLeft/);
  assert.ok(dir, "onTreeKey continua tratando as setas");
  assert.ok(!/activateTreeRow/.test(dir[0]),
    "ArrowRight abria o documento do nó e tirava o foco da árvore");
  assert.match(dir[0], /expandTreeRow\(/, "num nó fechado, ArrowRight expande");
});

test("C21 — expandir é uma operação própria (sem abrir documento)", () => {
  const body = fnBody("expandTreeRow");
  assert.match(body, /bOpen\.add/, "expandir é acrescentar a chave de aberto");
  assert.ok(!/openDoc\(/.test(body), "expandir não abre documento nenhum");
  assert.match(body, /focus\(\)/, "o foco fica na linha, mesmo quando a lateral se redesenha");
});

// ------------------------------------------------------------------ F7
// A seleção era só `.on`. Em Configurações o controle segmentado é o ÚNICO
// controle (o <select id="mode"> está hidden), então o usuário de leitor de tela
// não tinha como saber o modo de transcrição, o tema, nem — no caso sensível — se
// o chat está em "tudo, sem perguntar".
test("F7 — um espelho único leva a classe .on para a ARIA", () => {
  const table = constTable("ARIA_MIRROR");
  for (const attr of ["aria-pressed", "aria-current", "aria-selected", "aria-expanded"]) {
    assert.match(table, new RegExp(attr), `${attr} precisa acompanhar o cromo`);
  }
  const body = fnBody("paintAriaState");
  assert.match(body, /classList\.contains\("on"\)/, "a fonte da verdade continua sendo a classe");
  assert.match(APP, /new MutationObserver/,
    "o cromo é pintado em shell.js, em app.js e na restauração do boot: o espelho tem de cobrir os três");
});

test("F7 — cada segmento é um grupo com nome, não seis botões soltos", () => {
  for (const id of ["modeSeg", "actionModeSeg", "chatPermSeg", "themeSeg"]) {
    const t = tag(id);
    assert.match(t, /role="group"/, `#${id} precisa ser um grupo`);
    assert.match(t, /aria-label(?:ledby)?=/, `#${id} precisa de nome acessível`);
  }
});

test("F7 — as abas do painel direito são abas de verdade", () => {
  assert.match(HTML, /id="panelTabs"[^>]*role="tablist"/);
  const tabs = [...HTML.matchAll(/<button class="ptab[^"]*"[^>]*>/g)];
  assert.equal(tabs.length, 3);
  for (const m of tabs) assert.match(m[0], /role="tab"/);
  for (const id of ["panelDoc", "panelChat", "panelTerm"]) {
    assert.match(tag(id), /role="tabpanel"/);
    assert.match(tag(id), /aria-labelledby=/);
  }
});

// ------------------------------------------------------------------ F8
test("F8 — a paleta ⌘K é um combobox com listbox", () => {
  assert.match(tag("cmdk"), /role="dialog"/);
  assert.match(tag("cmdk"), /aria-modal="true"/);
  const inp = tag("cmdkInput");
  assert.match(inp, /role="combobox"/);
  assert.match(inp, /aria-controls="cmdkList"/);
  assert.match(inp, /aria-autocomplete="list"/);
  assert.match(inp, /aria-expanded=/);
  assert.match(inp, /aria-label=/);
  assert.match(tag("cmdkList"), /role="listbox"/);
});

test("F8 — cada resultado é uma opção com id, e o realce é anunciado", () => {
  const render = fnBody("renderPalette");
  assert.match(render, /role="option"/);
  assert.match(render, /id="cmdk-opt-/, "aria-activedescendant precisa de um id para apontar");
  assert.match(render, /role="presentation"/, "os títulos de grupo não são opções");
  assert.match(render, /announce\(/, "quantos resultados apareceram é um status");
  const idx = fnBody("setCmdkIndex");
  assert.match(idx, /aria-selected/);
  assert.match(idx, /aria-activedescendant/);
});

// ------------------------------------------------------------------ F9
test("F9 — o seletor do que é gravado e o do destino têm nome acessível", () => {
  for (const [id, msg] of [["recSource", "fonte de áudio"], ["importCtx", "destino do que for organizado"]]) {
    const t = tag(id);
    assert.match(t, new RegExp('aria-label="' + msg + '"'), `#${id} precisa dizer o que decide`);
    assert.match(t, /data-i18n-attrs="[^"]*aria-label/, `o nome de #${id} é um msgid`);
    assert.ok(EN[msg] && EN[msg] !== msg, `sem par em inglês: ${msg}`);
  }
});

// ------------------------------------------------------------------ R4
// O ● do cabeçalho — o controle mais proeminente do app — trazia
// aria-label="Gravar / Parar" fixo no HTML: um nome que anuncia as DUAS ações
// opostas ao mesmo tempo e nunca muda. Como aria-label vence o conteúdo, a
// tecnologia assistiva ouvia isso nos quatro estados (Gravar · iniciando… ·
// Parar · encerrando…) e não tinha como saber o que apertar faria. O rótulo
// visível já era verdade: agora ele e o nome acessível têm a MESMA fonte.
test("R4 — o nome acessível do ● é o estado em que ele está", () => {
  const btn = tag("toggleBtn");
  assert.ok(!/aria-label="Gravar \/ Parar"/.test(btn),
    "um nome fixo com duas ações opostas não é o nome de nenhum estado");
  assert.match(tag("recLabel"), /data-i18n-dyn/,
    "o rótulo é escrito em tempo de execução: quem escreve também traduz (F25)");
  assert.ok(!("Gravar / Parar" in EN), "o msgid que nomeava as duas ações saiu do catálogo");

  const label = loadPure("recControlLabel");
  assert.equal(label(null, false), "Gravar");
  assert.equal(label(null, true), "Parar");
  assert.equal(label("starting", false), "iniciando…");
  assert.equal(label("stopping", true), "encerrando…");

  const paint = fnBody("paintRecControl");
  assert.match(paint, /recControlLabel\(/, "há uma decisão só sobre o que o ● diz");
  assert.match(paint, /recLabel/, "ela escreve o rótulo visível");
  assert.match(paint, /aria-label/, "…e o nome acessível, da mesma fonte");
  assert.match(paint, /title/, "…e o tooltip, que também dizia 'Gravar' gravando");
  for (const owner of ["setRecPending", "paintRecordingChrome", "rerenderForLang", "applySettings"]) {
    assert.match(fnBody(owner), /paintRecControl\(/, `${owner} deve pintar pelo dono único`);
  }
  assert.ok(!/aria-label/.test(fnBody("setRecPending")),
    "o nome acessível não pode ter um segundo escritor");
});

// ------------------------------------------------------------------ F10
test("F10 — Configurações não salta do título para <h3>", () => {
  const m = HTML.match(/<h[12][^>]*class="cfgtitle"[^>]*>/);
  assert.ok(m, "o título de Configurações é um cabeçalho, não um <span>");
  const cfg = HTML.slice(HTML.indexOf('id="cfgWrap"'));
  assert.ok(!/<h1\b/.test(cfg.slice(0, cfg.indexOf('id="toast"'))) || /<h1[^>]*class="cfgtitle"/.test(m[0]),
    "um nível só entre o título e as seções");
});

test("F10 — o documento aberto e as seções do painel têm cabeçalho", () => {
  assert.match(tag("bCrumb"), /^<h1/, "o documento aberto é o conteúdo principal da tela");
  const pheads = [...HTML.matchAll(/class="phead"/g)];
  assert.ok(pheads.length >= 3);
  assert.equal((HTML.match(/<h2 class="phead"/g) || []).length, pheads.length,
    "as seções do painel eram <div> estilizados");
});

test("F10 — as seções recolhíveis da lateral dizem se estão abertas", () => {
  const body = fnBody("applySideSections");
  assert.match(body, /aria-expanded/);
});

// ------------------------------------------------------------------ F19
// Com Configurações aberta (uma camada OPACA sobre o app inteiro) o Tab caía em
// controles pintados por baixo dela: foco invisível, Enter agindo na tela de trás.
test("F19 — as três folhas modais declaram-se diálogos", () => {
  for (const id of ["cfgWrap", "editWrap", "pmWrap"]) {
    const t = tag(id);
    assert.match(t, /role="dialog"/, `#${id} precisa ser um diálogo`);
    assert.match(t, /aria-modal="true"/, `#${id} precisa ser modal`);
    assert.match(t, /aria-labelledby=/, `#${id} precisa de nome`);
  }
});

test("F19 — o resto do app fica inert enquanto uma folha está aberta", () => {
  const body = fnBody("setBackgroundInert");
  assert.match(body, /inert/, "inert é o que tira dezenas de controles do Tab e da árvore");
  const list = APP.match(/const INERT_BEHIND = \[([^\]]*)\]/);
  assert.ok(list, "app.js deve declarar as regiões que ficam atrás da folha");
  for (const id of ["appHead", "brainShell", "aiPanel"]) {
    assert.match(list[1], new RegExp(id), `${id} fica atrás da camada opaca`);
  }
});

test("F19 — abrir uma folha move o foco para dentro; fechar devolve", () => {
  const enter = fnBody("enterOverlay");
  assert.match(enter, /activeElement/, "quem abriu é lembrado");
  assert.match(enter, /setBackgroundInert\(true\)/);
  assert.match(enter, /focus\(\)/);
  const leave = fnBody("leaveOverlay");
  assert.match(leave, /setBackgroundInert\(false\)/);
  assert.match(leave, /focus\(\)/, "o foco volta para o controle que abriu a folha");
});

test("F19 — as quatro superfícies usam o mesmo par entrar/sair", () => {
  assert.match(fnBody("openCfg"), /enterOverlay\(/);
  assert.match(fnBody("closeCfg"), /leaveOverlay\(/);
  assert.match(fnBody("openModal"), /enterOverlay\(/);
  assert.match(fnBody("closeModal"), /leaveOverlay\(/);
  assert.match(fnBody("openPalette"), /enterOverlay\(/);
  assert.match(fnBody("closePalette"), /leaveOverlay\(/);
});

// A anatomia é INVIOLÁVEL (DESIGN.md §2): dar semântica não pode acrescentar
// cromo. Um conserto certo aqui é invisível numa captura de tela, exceto pelos
// anéis de foco — então nada de novo texto visível nem de novos elementos com
// caixa própria.
test("a região viva não tem caixa visível (nenhum cromo novo)", () => {
  const live = tag("srLive");
  assert.match(live, /clip-path|clip:/, "a região viva é lida, não vista");
  assert.ok(!/\shidden(\s|>|=)/.test(live),
    "o atributo hidden a tiraria da árvore de acessibilidade — ela ficaria muda");
});

// ------------------------------------------------------------------ #sideToggle
// O alternador da lateral é um botão SÓ com ícone (o <svg> é aria-hidden): sem
// aria-label o nome acessível caía no `title`, que dizia "recolher barra lateral"
// nos dois estados — e com a lateral já recolhida ele nomeia a ação contrária à
// que executa. O nome tem de acompanhar o estado (WCAG 4.1.2).
test("#sideToggle tem nome acessível, e ele muda com o estado", () => {
  const t0 = tag("sideToggle");
  assert.match(t0, /aria-label="recolher barra lateral"/, "o botão nasce com nome próprio");
  assert.match(t0, /aria-expanded="true"/);
  const body = fnBody("paintSideToggle");
  assert.match(body, /expandir barra lateral/, "recolhida, o nome vira 'expandir'");
  assert.match(body, /recolher barra lateral/);
  assert.match(body, /setAttribute\("aria-label", label\)/);
  assert.match(body, /st\.title = label/, "o tooltip do mouse conta a mesma verdade");
  assert.match(body, /aria-expanded/, "e o estado segue exposto");
  assert.match(fnBody("toggleSidebar"), /paintSideToggle\(\)/, "o clique repinta o nome");
  assert.match(fnBody("applyChrome"), /paintSideToggle\(\)/,
    "uma lateral restaurada recolhida não pode oferecer 'recolher'");
  // fora do applyI18n: quem escreve em tempo de execução também traduz (F25)
  assert.ok(!/id="sideToggle"[^>]*data-i18n-attrs/.test(HTML),
    "sob o applyI18n o valor do boot voltaria por cima do nome com estado");
  for (const pt of ["recolher barra lateral", "expandir barra lateral"]) {
    assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
  }
});
