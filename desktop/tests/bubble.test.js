// ADR-0041 — o balão de gravação: arrastar vs clicar, abrir/fechar o painel, o
// selo de gravação SEM piscar, e a ponte com a janela principal.
//
// O MÓDULO PURO (`src/bubble-core.js`) roda de verdade; a janela (bubble.html +
// bubble.js) e a ponte em app.js são conferidas no FONTE. O DOM de verdade é
// medido em `make test-ui` (tools/smoke-bubble.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const BC = require("../src/bubble-core.js");

const SRC = path.join(__dirname, "..", "src");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const HTML = read("bubble.html");
const JS = read("bubble.js");
const CORE = read("bubble-core.js");
const APP = read("app.js");
const ROOT = path.join(__dirname, "..", "src-tauri");
const LIB = fs.readFileSync(path.join(ROOT, "src", "lib.rs"), "utf8");
const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, "tauri.conf.json"), "utf8"));
const CAPS = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities", "default.json"), "utf8"));

// ---- arrastar vs clicar -------------------------------------------------------

test("ADR-0041 §1 — apertar e soltar sem mover é CLIQUE", () => {
  const g = BC.gesture();
  assert.strictEqual(g.down(100, 100), "none");
  assert.strictEqual(g.move(102, 101), "none", "um tremor de 2px não é arrasto");
  assert.strictEqual(g.up(102, 101), "click");
});

test("ADR-0041 §1 — apertar e mover além do limiar é ARRASTO, e o soltar não vira clique", () => {
  const g = BC.gesture();
  g.down(100, 100);
  assert.strictEqual(g.move(102, 103), "none", "√13 ≈ 3.6px: ainda é clique");
  assert.strictEqual(g.move(105, 100), "drag", "5px: começa a arrastar — uma vez só");
  assert.strictEqual(g.move(140, 160), "none", "o sistema já está arrastando");
  assert.strictEqual(g.up(140, 160), "none", "terminar um arrasto não abre o painel");
  // e o próximo gesto começa limpo
  g.down(10, 10);
  assert.strictEqual(g.up(10, 10), "click");
});

test("ADR-0041 §1 — o limiar é uma distância, não um eixo", () => {
  assert.strictEqual(BC.DRAG_THRESHOLD_PX, 4);
  assert.strictEqual(BC.isDrag({ x: 0, y: 0 }, { x: 3, y: 3 }), true, "3,3 = 4.24px");
  assert.strictEqual(BC.isDrag({ x: 0, y: 0 }, { x: 4, y: 0 }), false, "exatamente o limiar ainda é clique");
  assert.strictEqual(BC.isDrag({ x: 0, y: 0 }, { x: 0, y: -5 }), true);
});

test("ADR-0041 §1 — soltar sem ter apertado (o mouseup de outro lugar) não é clique", () => {
  const g = BC.gesture();
  assert.strictEqual(g.up(1, 1), "none");
  assert.strictEqual(g.move(50, 50), "none");
});

// ---- abrir / fechar o painel --------------------------------------------------

test("ADR-0041 §2 — clicar no ícone abre; clicar de novo, clicar fora ou Esc fecha", () => {
  assert.strictEqual(BC.panel(false, "icon-click"), true);
  assert.strictEqual(BC.panel(true, "icon-click"), false);
  assert.strictEqual(BC.panel(true, "blur"), false);
  assert.strictEqual(BC.panel(true, "escape"), false);
  // fechado, nada disso abre
  assert.strictEqual(BC.panel(false, "blur"), false);
  assert.strictEqual(BC.panel(false, "escape"), false);
  // um aviso do agendador (fim chegando, trocar?) abre o painel para ser visto
  assert.strictEqual(BC.panel(false, "prompt"), true);
  assert.strictEqual(BC.panel(true, "prompt"), true);
  assert.strictEqual(BC.panel(true, "outro"), true, "evento desconhecido não muda nada");
});

test("ADR-0041 §2 — um clique NÃO grava: gravar é o botão do painel", () => {
  // o clique no ícone só abre o painel (refinamento do dono): o código do ícone
  // não manda comando de gravação nenhum
  const onIcon = JS.slice(JS.indexOf("function onIconClick"), JS.indexOf("}", JS.indexOf("function onIconClick")) + 1);
  assert.ok(onIcon.includes("function onIconClick"), "bubble.js define onIconClick");
  assert.doesNotMatch(onIcon, /send\("(start|toggle|pause|resume|stop)"/);
});

// ---- o selo: estável, nunca piscando -----------------------------------------

test("ADR-0041 §2 — o selo diz o estado: nada, ● gravando com tempo, ⏸ pausado", () => {
  assert.deepStrictEqual(BC.badge({ rec: "idle" }, 0), { kind: null, time: null });
  const startedAt = 1000000;
  assert.deepStrictEqual(BC.badge({ rec: "recording", startedAt, pausedMs: 0 }, startedAt + 65000), { kind: "rec", time: "1:05" });
  assert.deepStrictEqual(BC.badge({ rec: "paused", startedAt, pausedMs: 5000, pauseStart: startedAt + 65000 }, startedAt + 600000),
    { kind: "pause", time: "1:00" }, "o relógio para na pausa");
  assert.deepStrictEqual(BC.badge({ rec: "starting" }, 0), { kind: "pending", time: null });
  assert.deepStrictEqual(BC.badge({ rec: "stopping" }, 0), { kind: "pending", time: null });
});

test("ADR-0041 §2 — o tempo passa de m:ss para h:mm:ss depois da primeira hora", () => {
  assert.strictEqual(BC.formatElapsed(0), "0:00");
  assert.strictEqual(BC.formatElapsed(59999), "0:59");
  assert.strictEqual(BC.formatElapsed(3599000), "59:59");
  assert.strictEqual(BC.formatElapsed(3600000), "1:00:00");
  assert.strictEqual(BC.formatElapsed(-5), "0:00");
});

test("ADR-0041 §2 — NADA pisca: sem animação no balão (pedido explícito do dono)", () => {
  assert.doesNotMatch(HTML, /@keyframes|animation\s*:|animation-name/);
  assert.doesNotMatch(JS, /\.animate\(|setInterval\([^)]*(blink|pisca)/i);
  // o relógio troca de segundo em segundo, mas o ponto não troca de estado
  assert.doesNotMatch(JS, /classList\.toggle\("(on|blink|dim)"/);
});

test("ADR-0041 §2 — o balão é o ícone colorido do app, não o template monocromático da bandeja", () => {
  assert.match(HTML, /src="loro-icon\.png"/);
  assert.ok(fs.existsSync(path.join(SRC, "loro-icon.png")), "o ícone do app está no frontendDist");
  assert.doesNotMatch(HTML, /tray-on|parrot\.png/);
});

// ---- o painel ----------------------------------------------------------------

test("ADR-0041 §3 — o painel tem as cinco partes: transcrição, ideia, controles, abrir, próximas", () => {
  for (const id of ["bTail", "bDest", "bGravar", "bPausar", "bRetomar", "bEncerrar", "bNova", "bAbrir", "bAgenda", "bAgendaNota", "bPrompt"]) {
    assert.match(HTML, new RegExp(`id="${id}"`), `bubble.html deve ter #${id}`);
  }
});

test("ADR-0041 §3 — as falas aparecem com «você» e «sistema»", () => {
  assert.strictEqual(BC.whoLabel("mic"), "você");
  assert.strictEqual(BC.whoLabel("system"), "sistema");
  assert.deepStrictEqual(BC.tail([{ who: "mic", text: "a" }, { who: "system", text: "b" }, { who: "mic", text: "c" }], 2),
    [{ who: "system", text: "b" }, { who: "mic", text: "c" }]);
});

test("ADR-0041 §3 — os controles que aparecem dependem do estado", () => {
  assert.deepStrictEqual(BC.controls({ rec: "idle", canRecord: true }), ["gravar"]);
  assert.deepStrictEqual(BC.controls({ rec: "idle", canRecord: false }), []);
  assert.deepStrictEqual(BC.controls({ rec: "recording", meeting: true }), ["pausar", "encerrar", "nova"]);
  assert.deepStrictEqual(BC.controls({ rec: "paused", meeting: true }), ["retomar", "encerrar", "nova"]);
  assert.deepStrictEqual(BC.controls({ rec: "recording", meeting: false }), ["encerrar"], "modo ao vivo não pausa");
  assert.deepStrictEqual(BC.controls({ rec: "starting" }), []);
});

test("ADR-0041 §3 — bubble-core.js é puro", () => {
  assert.doesNotMatch(CORE, /\bdocument\.|\binvoke\(|__TAURI__|\bwindow\.(?!LoroBubble)/);
});

// ---- a janela e a ponte ------------------------------------------------------

test("ADR-0041 §1 — a legenda flutuante saiu: o balão é a única janela flutuante", () => {
  assert.ok(!fs.existsSync(path.join(SRC, "overlay.html")));
  assert.ok(!fs.existsSync(path.join(SRC, "overlay.js")));
  assert.ok(!CONF.app.windows.some((w) => w.label === "overlay"));
  assert.doesNotMatch(LIB, /fn toggle_overlay/);
  assert.ok(!APP.includes("toggle_overlay"));
  assert.ok(CAPS.windows.includes("bubble"));
  assert.ok(!CAPS.windows.includes("overlay"));
  assert.ok(CAPS.permissions.includes("core:window:allow-start-dragging"), "o arrasto é do sistema");
});

test("ADR-0041 §1 — a janela do balão: sem moldura, transparente, no topo, sem roubar o foco", () => {
  const rs = fs.readFileSync(path.join(ROOT, "src", "bubble.rs"), "utf8");
  for (const call of [".decorations(false)", ".transparent(true)", ".always_on_top(true)", ".skip_taskbar(true)",
    ".visible_on_all_workspaces(true)", ".focused(false)", ".accept_first_mouse(true)"]) {
    assert.ok(rs.includes(call), "bubble.rs deve chamar " + call);
  }
});

test("ADR-0041 §3 — a janela principal é a dona: o balão manda comandos e recebe estado", () => {
  assert.match(APP, /listen\("bubble-cmd", /);
  assert.match(APP, /emit\("bubble-state", /);
  assert.match(JS, /listen\("bubble-state", /);
  assert.match(JS, /emit\("bubble-cmd", /);
  for (const cmd of ["start", "pause", "resume", "stop", "new", "open", "set-tema", "schedule", "extend", "switch", "keep", "record-suggested", "dismiss", "hello"]) {
    assert.match(APP, new RegExp(`case "${cmd}"`), "app.js atende " + cmd);
  }
});

test("ADR-0041 §1 — mostrar/ocultar o balão: Configurações e bandeja", () => {
  const html = read("index.html");
  assert.match(html, /id="optBubble"/);
  assert.ok(!html.includes('id="optOverlay"'));
  assert.match(APP, /invoke\("bubble_set_visible", \{ visible/);
  assert.match(LIB, /"bubble" => bubble::toggle_visible\(app\)/);
});

test("ADR-0041 — todo texto do balão tem par em inglês", () => {
  const { EN } = require("../src/i18n.js");
  const ids = new Set();
  for (const m of HTML.matchAll(/data-i18n>([^<]+)</g)) ids.add(m[1].trim());
  for (const m of HTML.matchAll(/data-i18n-placeholder="([^"]+)"/g)) ids.add(m[1]);
  for (const m of JS.matchAll(/\bt\("([^"]+)"/g)) ids.add(m[1]);
  for (const m of JS.matchAll(/btn\("([^"]+)"/g)) ids.add(m[1]);
  // os avisos que app.js manda ao balão são msgids que o balão traduz
  for (const m of APP.matchAll(/bubble\.aviso = "([^"]+)"/g)) ids.add(m[1]);
  ids.add(BC.whoLabel("mic")); ids.add(BC.whoLabel("system"));
  const faltando = [...ids].filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
  assert.deepStrictEqual(faltando, [], "msgids do balão sem par em inglês");
});

// ---- refinamentos do dono (2026-11-18, depois do primeiro build) ---------------

test("ADR-0041 §2 — o tamanho: 32 pt por padrão (1/4 da área), 48 e 64 nas Configurações", () => {
  assert.match(HTML, /--icon: 32px/, "o padrão do CSS é o pequeno");
  assert.match(JS, /invoke\("bubble_get_size"\)/);
  assert.match(JS, /listen\("bubble-size"/);
  const idx = read("index.html");
  for (const v of ["32", "48", "64"]) assert.match(idx, new RegExp(`id="optBubbleSize"[\\s\\S]{0,400}value="${v}"`));
  assert.match(APP, /invoke\("bubble_set_size", \{ size:/);
  // o selo acompanha o ícone, mas nunca some de tão pequeno
  assert.strictEqual(BC.badgePx(32), 10);
  assert.strictEqual(BC.badgePx(48), 14);
  assert.strictEqual(BC.badgePx(64), 19);
  assert.strictEqual(BC.badgePx(10), 9);
  // o arrasto continua valendo no ícone pequeno: o limiar é de distância, não de tamanho
  const g = BC.gesture();
  g.down(16, 16);
  assert.strictEqual(g.move(19, 16), "none");
  assert.strictEqual(g.up(19, 16), "click");
});

test("ADR-0041 §2 — o recolhido diz a próxima reunião no tooltip, com ✓ quando vai gravar", () => {
  const hh = () => "09:30";
  assert.strictEqual(BC.tooltip("Loro", { evento: { inicioMs: 0, titulo: "Daily" }, agendada: true }, hh),
    "Loro\nPróxima: 09:30 Daily — gravar ✓");
  assert.strictEqual(BC.tooltip("gravando · 1:05", { evento: { inicioMs: 0, titulo: "1:1" }, agendada: false }, hh,
    { proxima: "Next", gravar: "record" }), "gravando · 1:05\nNext: 09:30 1:1");
  assert.strictEqual(BC.tooltip("Loro", null, hh), "Loro");
  assert.match(JS, /\$\("icon"\)\.title = /);
});

test("ADR-0041 §3 — o painel abre e fecha a partir do ícone, curto e sem repetição", () => {
  assert.match(HTML, /transition: opacity 140ms ease-out, transform 140ms ease-out/);
  assert.match(HTML, /prefers-reduced-motion: reduce/);
  // a ÚNICA transição é a do painel: o ícone e o selo nunca transitam (o smoke
  // desliga transições para medir o estado final, então a regra mora aqui)
  const comTransicao = HTML.split("\n").filter((l) => /transition\s*:/.test(l));
  assert.ok(comTransicao.length > 0);
  for (const l of comTransicao) assert.match(l, /#panel|^\s*transition: opacity/, "transição fora do painel: " + l.trim());
  // OPACO (dono, depois do build real: o texto de trás vazava por baixo)
  assert.doesNotMatch(HTML, /backdrop-filter/);
  assert.match(HTML, /--bg: #f6f6f8;/);
  assert.match(HTML, /--bg: #242428;/);
  assert.match(HTML, /border: 1px solid var\(--border\)/);
  assert.match(HTML, /prefers-color-scheme: dark/);
  assert.match(HTML, /border-radius: 14px/);
  // a agenda é uma aba com hoje, amanhã e os que já passaram recolhidos
  for (const id of ["tabBtnRec", "tabBtnAgenda", "tabRec", "tabAgenda", "bPassados", "bDest"]) {
    assert.match(HTML, new RegExp(`id="${id}"`));
  }
  assert.match(JS, /LAG\.group\(/);
  assert.match(JS, /send\("record-now"/);
  assert.match(APP, /case "record-now"/);
});

test("ADR-0041 §3 — o chat do balão: canal próprio, contexto por referência, Enter envia", () => {
  assert.match(JS, /invoke\("chat_send", \{ input: \{ prompt: BC\.chatPrompt\(q, st\.chatCtx \|\| \[\]\), channel: "bubble"/);
  assert.match(JS, /invoke\("chat_cancel", \{ channel: "bubble" \}\)/);
  assert.match(JS, /invoke\("chat_reset", \{ channel: "bubble" \}\)/);
  assert.match(JS, /listen\("bubble-chat-delta"/);
  assert.match(JS, /e\.key === "Enter" && !e\.shiftKey/);
  assert.match(JS, /invoke\("bubble_panel_height"/);
  // o contexto é a reunião em andamento e os DOIS arquivos da agenda, como caminho
  assert.match(APP, /chatCtx: \[\s*meeting\.active && meeting\.livingRel/);
  const p = BC.chatPrompt("o que o Rick pediu?", ["brainstorming/x/meetings/y/reuniao.md", ".loro/agenda/2026-11-18.json", "/etc/passwd", "../fora.md"]);
  assert.match(p, /@brainstorming\/x\/meetings\/y\/reuniao\.md/);
  assert.match(p, /@\.loro\/agenda\/2026-11-18\.json/);
  assert.doesNotMatch(p, /passwd|fora\.md/, "só caminho relativo dentro do acervo");
  assert.ok(p.endsWith("o que o Rick pediu?"));
  assert.strictEqual(BC.chatPrompt("  oi  ", []), "oi");
});

test("ADR-0041 §3 — a resposta é escapada antes de ganhar formatação", () => {
  const h = BC.mdLite("**sim** <img src=x onerror=alert(1)>\n- um\n- `dois`\n```\n<b>x</b>\n```");
  assert.doesNotMatch(h, /<img|<b>/);
  assert.match(h, /<strong>sim<\/strong> &lt;img/);
  assert.match(h, /<ul><li>um<\/li><li><code>dois<\/code><\/li><\/ul>/);
  assert.match(h, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/);
});

// ---- o seletor de destino (dono: «e se tiver uma lista grande?») -------------
const FZ = require("../src/fuzzy.js");
const TEMAS = [
  { slug: "dia", nome: "dia" }, { slug: "henrique", nome: "henrique" }, { slug: "luan", nome: "Luan" },
  { slug: "frota-2026", nome: "frota 2026" }, { slug: "zeta", nome: "zeta" }, { slug: "agua", nome: "Água" },
];

test("ADR-0041 §8 — sem busca: Recentes (mais recente primeiro, até 5) e depois todas em ordem alfabética", () => {
  const it = BC.pickerItems({ temas: TEMAS, recentes: ["luan", "sumiu", "dia", "luan"] });
  assert.deepStrictEqual(it.filter((x) => x.kind === "recent").map((x) => x.slug), ["luan", "dia"],
    "a que não existe mais cai, repetida não duplica");
  assert.deepStrictEqual(it.filter((x) => x.kind === "all").map((x) => x.nome), ["Água", "frota 2026", "henrique", "zeta"],
    "alfabética, acento e caixa não mudam a ordem, sem repetir as recentes");
  const muitas = Array.from({ length: 9 }, (_, i) => ({ slug: "t" + i, nome: "t" + i }));
  assert.strictEqual(BC.pickerItems({ temas: muitas, recentes: muitas.map((x) => x.slug) }).filter((x) => x.kind === "recent").length, 5);
});

test("ADR-0041 §8 — digitar filtra pelo fuzzy, e oferece criar quando nenhum nome bate", () => {
  const f = BC.pickerItems({ temas: TEMAS, query: "fro", filter: FZ.filter });
  assert.deepStrictEqual(f.map((x) => [x.kind, x.nome]), [["match", "frota 2026"], ["new", "fro"]]);
  // sem acento acha o com acento, e um nome exato não oferece criar de novo
  assert.deepStrictEqual(BC.pickerItems({ temas: TEMAS, query: "agua", filter: FZ.filter }).map((x) => x.kind), ["match"]);
  assert.deepStrictEqual(BC.pickerItems({ temas: TEMAS, query: "LUAN", filter: FZ.filter }).map((x) => x.kind), ["match"]);
  // nada bate: só criar
  assert.deepStrictEqual(BC.pickerItems({ temas: TEMAS, query: "lançamento q4", filter: FZ.filter }),
    [{ kind: "new", slug: "", nome: "lançamento q4" }]);
  // sem nenhuma ideia ainda, o campo vazio não oferece nada (digitar é o caminho)
  assert.deepStrictEqual(BC.pickerItems({ temas: [], query: "" }), []);
});

test("ADR-0041 §8 — teclado: ↑/↓ movem sem passar das pontas, Enter escolhe, Esc fecha", () => {
  assert.deepStrictEqual(BC.pickerKey(0, "ArrowDown", 3), { index: 1, action: "move" });
  assert.deepStrictEqual(BC.pickerKey(2, "ArrowDown", 3), { index: 2, action: "move" });
  assert.deepStrictEqual(BC.pickerKey(0, "ArrowUp", 3), { index: 0, action: "move" });
  assert.deepStrictEqual(BC.pickerKey(1, "Enter", 3), { index: 1, action: "pick" });
  assert.deepStrictEqual(BC.pickerKey(-1, "Enter", 0), { index: -1, action: "none" });
  assert.deepStrictEqual(BC.pickerKey(1, "Escape", 3), { index: 1, action: "close" });
  assert.deepStrictEqual(BC.pickerKey(1, "a", 3), { index: 1, action: "none" });
});

test("ADR-0041 §8 — a escolha vira a mais recente, sem repetir, até 5", () => {
  assert.deepStrictEqual(BC.noteRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepStrictEqual(BC.noteRecent(["a", "b", "c", "d", "e"], "f"), ["f", "a", "b", "c", "d"]);
  assert.deepStrictEqual(BC.noteRecent(["a"], ""), ["a"]);
  assert.match(APP, /bubbleRecentes: \[\]/);
  assert.match(APP, /recentes: settings\.bubbleRecentes/);
});

test("ADR-0041 §8 — o MESMO seletor no Gravação e no detalhe do evento; nada de <select> nem de title no painel", () => {
  assert.strictEqual((JS.match(/makePicker\(/g) || []).length, 3, "a definição + o do Gravação + o do evento");
  assert.doesNotMatch(JS, /createElement\("select"\)/);
  assert.doesNotMatch(HTML, /<select/);
  // a única dica nativa é a do ícone recolhido
  const titles = JS.match(/\.title = /g) || [];
  assert.strictEqual(titles.length, 1, "só o ícone tem title");
  assert.match(JS, /\$\("icon"\)\.title = /);
  assert.match(HTML, /<script src="fuzzy\.js"><\/script>/);
  // Esc com a lista aberta fecha a LISTA, não o painel
  assert.match(JS, /if \(openPicker\) \{ openPicker\.close\(\); return; \}/);
});

// ---- §11 · «/» no chat do balão -------------------------------------------------
const SKILLS = [
  { name: "consulta", description: "Responde o que era esperado", source: "project" },
  { name: "interview", description: "Entrevista", source: "user" },
  { name: "review", description: "Confronta com o Figma", source: "user" },
  { name: "turbi-design:torque", description: "Torque 2", source: "plugin" },
];

test("ADR-0041 §11 — a lista abre só enquanto se digita o NOME do comando", () => {
  assert.strictEqual(BC.slashQuery("/"), "");
  assert.strictEqual(BC.slashQuery("/rev"), "rev");
  assert.strictEqual(BC.slashQuery("/review "), null, "depois do espaço vêm os argumentos");
  assert.strictEqual(BC.slashQuery("oi /x"), null);
  assert.strictEqual(BC.slashQuery(""), null);
});

test("ADR-0041 §11 — sem filtro, todas na ordem do backend; com filtro, o fuzzy decide", () => {
  assert.deepStrictEqual(BC.slashItems(SKILLS, "").map((x) => x.name), SKILLS.map((x) => x.name));
  assert.deepStrictEqual(BC.slashItems(SKILLS, "rev", FZ.filter).map((x) => x.name), ["review"]);
  // o começo do nome e o pedaço depois do «:» do plugin contam como fronteira
  assert.strictEqual(BC.slashItems(SKILLS, "torq", FZ.filter)[0].name, "turbi-design:torque");
  assert.strictEqual(BC.slashItems(SKILLS, "i", FZ.filter)[0].name, "interview", "fronteira no começo ganha");
  assert.strictEqual(BC.slashItems(Array.from({ length: 80 }, (_, i) => ({ name: "s" + i })), "").length, 50);
});

test("ADR-0041 §11 — completar deixa «/nome » e o envio vai cru para o CLI", () => {
  assert.strictEqual(BC.slashComplete("review"), "/review ");
  assert.strictEqual(BC.slashComplete("/review"), "/review ");
  assert.strictEqual(BC.chatPrompt("/review contrato x", ["a/b.md"]), "/review contrato x", "sem cabeçalho de contexto");
  assert.match(JS, /invoke\("skills_list"\)/);
  assert.match(JS, /e\.key === "Tab" \|\| \(e\.key === "Enter" && !e\.shiftKey\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "src", "lib.rs"), "utf8"), /skills::skills_list/);
});
