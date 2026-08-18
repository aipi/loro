// ADR-0029 §3.8/§3.9/§3.10 — loops: trabalho que a IA repete num ritmo.
//
// Duas costuras, como o resto da suíte: o MÓDULO PURO (`src/loops.js`) roda de
// verdade, e o que não pode ser puro (o relógio, a autoridade única, a marca do
// cabeçalho) é verificado no FONTE de app.js/index.html/style.css — não há DOM
// sob `node --test`.
//
// O que estes testes existem para impedir, em uma linha cada:
//   · um relógio que dispara N vezes porque a máquina dormiu (§3.10 B3)
//   · um ciclo silencioso lido como falha, ou virando feed (§3.10 D1)
//   · duas leituras de estado, portanto duas verdades (§3.9)
//   · «ligado» pintado sobre um impedimento (§3.9)
//   · um ciclo paralelo pintando na lista do outro
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const LP = require("../src/loops.js");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
const RUST = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "loops.rs"), "utf8");
const RUST_CHAT = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "chat.rs"), "utf8");
const RUST_ACERVO = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "acervo.rs"), "utf8");
const { EN } = require("../src/i18n.js");

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
function constSource(name) {
  const re = new RegExp("const " + name + " = [\\s\\S]*?\\n\\};");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}`);
  return m[0];
}
function pair(msgid) {
  assert.ok(EN[msgid] && EN[msgid] !== msgid, `falta o par em inglês de “${msgid}”`);
}

// ============================ o módulo puro ============================

test("o ritmo tem TRÊS formas, e as duas pontas leem a mesma", () => {
  assert.deepEqual(LP.parseRhythm("min:30"), { kind: "min", minutes: 30 });
  assert.deepEqual(LP.parseRhythm("dia:09:00"), { kind: "dia", hh: 9, mi: 0 });
  assert.deepEqual(LP.parseRhythm("semana:1:14:30"), { kind: "semana", dow: 1, hh: 14, mi: 30 });
  for (const bad of ["", "min:0", "min:2000", "dia:24:00", "semana:7:1:1", "hora:1", "min:x", null]) {
    assert.equal(LP.parseRhythm(bad), null, `${bad} tem de ser recusado`);
  }
  // ida e volta: o que a tela monta é o que o backend parseia
  for (const r of [{ kind: "min", minutes: 45 }, { kind: "dia", hh: 7, mi: 5 }, { kind: "semana", dow: 0, hh: 23, mi: 59 }]) {
    assert.deepEqual(LP.parseRhythm(LP.buildRhythm(r)), r);
  }
  // e o formato é o que o Rust escreve no front matter (uma gramática, dois lados)
  assert.ok(RUST.includes('"min" =>') && RUST.includes('"dia" =>') && RUST.includes('"semana" =>'),
    "o parser do backend fala as mesmas três palavras");
});

test("o relógio entregue ao backend é hora civil LOCAL, com dia da semana", () => {
  const d = new Date(2026, 7, 17, 14, 30, 0); // 17 ago 2026, uma segunda
  const n = LP.nowFields(d);
  assert.equal(n.date, "2026-08-17");
  assert.equal(n.hh, 14);
  assert.equal(n.mi, 30);
  assert.equal(n.weekday, 1, "segunda = 1, como no backend");
  assert.equal(n.epochMs, d.getTime());
  // o backend decide com ESTES campos — nomes iguais nos dois lados
  for (const k of ["epochMs", "date", "hh", "mi", "weekday"]) {
    assert.ok(k in n, `falta ${k}`);
    assert.ok(RUST.includes(k === "epochMs" ? "epoch_ms" : k), `o backend não lê ${k}`);
  }
});

// §3.10 B4 — um ritmo abaixo de um dia é DURAÇÃO desde a última execução; um
// ritmo em relógio de parede é calculado pelo Date da plataforma, que conhece o
// horário de verão. Nenhuma das duas contas mora no backend.
test("a próxima execução respeita o calendário da plataforma", () => {
  const now = new Date(2026, 7, 17, 14, 0, 0).getTime();
  // duração: 30 min depois da ÚLTIMA execução, não do agora
  const last = new Date(2026, 7, 17, 13, 50, 0).getTime();
  assert.equal(LP.nextRunAt("min:30", last, now), last + 30 * 60000);
  // sem última execução, conta do agora
  assert.equal(LP.nextRunAt("min:30", 0, now), now + 30 * 60000);
  // diário: hoje se ainda não passou, amanhã se passou
  const hoje = LP.nextRunAt("dia:18:00", 0, now);
  assert.equal(new Date(hoje).getHours(), 18);
  assert.equal(new Date(hoje).getDate(), 17);
  const amanha = LP.nextRunAt("dia:09:00", 0, now);
  assert.equal(new Date(amanha).getDate(), 18, "09:00 já passou: amanhã");
  // semanal: cai SEMPRE no dia da semana pedido, e na hora pedida
  const semanal = LP.nextRunAt("semana:1:14:30", 0, now);
  assert.equal(new Date(semanal).getDay(), 1);
  assert.equal(new Date(semanal).getHours(), 14);
  assert.equal(new Date(semanal).getMinutes(), 30);
  assert.ok(semanal > now);
  // uma semana adiante quando o momento de hoje já passou
  const passou = new Date(2026, 7, 17, 15, 0, 0).getTime();
  const proxima = LP.nextRunAt("semana:1:14:30", 0, passou);
  assert.equal(new Date(proxima).getDate(), 24);
  assert.equal(LP.nextRunAt("nada", 0, now), 0, "sem ritmo legível, nenhuma promessa");
});

// §3.10 D1 — ciclos silenciosos seguidos colapsam numa linha com contagem: o
// histórico de um loop que não teve nada a dizer por seis semanas não pode virar
// o feed de atividade que a ADR-0020 §4 removeu.
test("ciclos silenciosos seguidos colapsam, e um ciclo com resultado nunca", () => {
  const cycles = [
    { outcome: "ok", startedDate: "2026-08-17", files: ["a"] },
    { outcome: "nothing", startedDate: "2026-08-10" },
    { outcome: "nothing", startedDate: "2026-08-03" },
    { outcome: "nothing", startedDate: "2026-07-27" },
    { outcome: "failed", startedDate: "2026-07-20", err: "err.loop_agent_busy" },
  ];
  const rows = LP.collapseCycles(cycles);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[1].n, 3, "três silêncios, uma linha");
  assert.equal(rows[1].to, "2026-08-10", "a mais nova");
  assert.equal(rows[1].from, "2026-07-27", "a mais antiga");
  assert.equal(rows[2].outcome, "failed");
  // a entrada não é mutada (o módulo é puro)
  assert.equal(cycles[1].n, undefined);
  assert.deepEqual(LP.collapseCycles(null), []);
});

test("um ciclo silencioso NÃO se pinta como falha", () => {
  assert.equal(LP.outcomeTone("ok"), "green");
  assert.equal(LP.outcomeTone("nothing"), "muted");
  assert.equal(LP.outcomeTone("skipped"), "muted");
  assert.equal(LP.outcomeTone("failed"), "amber");
  assert.equal(LP.outcomeTone("stopped"), "amber");
  assert.equal(LP.outcomeTone("running"), "teal");
  // vermelho é gravação e irreversível: nenhum resultado de ciclo o usa
  for (const o of ["ok", "nothing", "skipped", "failed", "stopped", "running"]) {
    assert.notEqual(LP.outcomeTone(o), "red");
  }
});

test("a linha do tempo vai do passado para o próximo, com «agora» no meio", () => {
  const cycles = LP.collapseCycles([
    { outcome: "ok", startedDate: "2026-08-11", files: ["a", "b"] },
    { outcome: "nothing", startedDate: "2026-08-04" },
  ]);
  const dots = LP.timelineDots(cycles, { running: true, nextAt: 1, max: 4 });
  assert.deepEqual(dots.map((d) => d.kind), ["cycle", "cycle", "now", "next"]);
  assert.equal(dots[0].date, "2026-08-04", "o mais antigo primeiro");
  assert.equal(dots[1].files, 2);
  const quiet = LP.timelineDots(cycles, {});
  assert.deepEqual(quiet.map((d) => d.kind), ["cycle", "cycle"], "sem ciclo e sem próximo, nada é prometido");
});

// §3.9 — «ligado» e «capaz de rodar» são fatos diferentes. E nenhum estado usa
// token novo: âmbar = precisa de você, teal = IA, muted = não faz nada.
test("os sete estados têm tom, e impedido nunca lê como ligado", () => {
  assert.deepEqual(LP.STATES.slice().sort(),
    ["armed", "blocked", "expired", "failing", "off", "queued", "running"]);
  assert.equal(LP.stateTone("running"), "teal");
  assert.equal(LP.stateTone("armed"), "teal-soft");
  assert.equal(LP.stateTone("queued"), "teal-soft");
  assert.equal(LP.stateTone("blocked"), "amber");
  assert.equal(LP.stateTone("failing"), "amber");
  assert.equal(LP.stateTone("off"), "muted");
  assert.equal(LP.stateTone("expired"), "muted");
  assert.notEqual(LP.stateTone("blocked"), LP.stateTone("armed"),
    "impedido e ligado não podem ter a mesma aparência");
  assert.ok(LP.isLive("running") && LP.isLive("queued"));
  assert.ok(!LP.isLive("armed") && !LP.isLive("off") && !LP.isLive("blocked"));
  // e o backend conhece os mesmos sete
  for (const s of LP.STATES) assert.ok(RUST.includes(`"${s}"`), `o backend não nomeia ${s}`);
});

// Um tique com nada acontecendo não pode tocar no DOM (a regra do pill de
// gravação): headerCounts devolve null, e é isso que o pintor testa.
test("sem ciclo nenhum, o cabeçalho não tem o que dizer", () => {
  assert.equal(LP.headerCounts({ running: [], queued: [] }), null);
  assert.equal(LP.headerCounts(null), null);
  assert.deepEqual(LP.headerCounts({ running: ["a"], queued: ["b", "c"] }), { running: 1, queued: 2 });
});

test("o rel de um loop e o seu slug se derivam um do outro, e só", () => {
  assert.equal(LP.relOf("x"), "loops/x.md");
  assert.equal(LP.slugOfRel("loops/x.md"), "x");
  assert.equal(LP.slugOfRel("loops\\x.md"), "x", "o separador do Windows não muda a resposta");
  for (const bad of ["loops/sub/x.md", "contexts/x.md", "loops/x.txt", "loops/.md", "", null]) {
    assert.equal(LP.slugOfRel(bad), "", `${bad} não é um loop`);
  }
  // o backend responde igual
  assert.ok(RUST.includes('rel.strip_prefix("loops/")'), "o backend deriva o slug do mesmo rel");
});

test("um freio é um número com piso e teto, nunca texto solto", () => {
  assert.deepEqual(LP.clampBrakes({}), { maxArquivos: 3, maxCiclosDia: 8, expiraDias: 30, paralelo: 1 });
  assert.deepEqual(
    LP.clampBrakes({ maxArquivos: 0, maxCiclosDia: 500, expiraDias: 9999, paralelo: 9 }),
    { maxArquivos: 1, maxCiclosDia: 96, expiraDias: 365, paralelo: 4 });
  // o campo aceita o que a pessoa digita com a unidade ao lado
  assert.equal(LP.clampBrakes({ maxArquivos: "3 arquivos" }).maxArquivos, 3);
  assert.equal(LP.clampBrakes({ maxCiclosDia: "8 vezes" }).maxCiclosDia, 8);
  assert.equal(LP.clampBrakes({ maxArquivos: "abc" }).maxArquivos, 3, "ilegível volta ao padrão");
});

test("«desliga sozinho depois de N dias» é uma data no calendário da pessoa", () => {
  assert.equal(LP.dateIn(30, new Date(2026, 7, 17)), "2026-09-16");
  assert.equal(LP.dateIn(1, new Date(2026, 11, 31)), "2027-01-01");
  assert.equal(LP.dateIn(0, new Date(2026, 7, 17)), "2026-08-17");
});

// Um ciclo paralelo não pode pintar na lista do outro: cada passo diz de qual
// loop é, e o painel filtra por isso.
test("os passos de um ciclo são só os dele", () => {
  const steps = [{ loop: "a", name: "ler" }, { loop: "b", name: "escrever" }, { loop: "a", name: "comparar" }];
  assert.deepEqual(LP.stepsFor(steps, "a").map((s) => s.name), ["ler", "comparar"]);
  assert.deepEqual(LP.stepsFor(steps, "b").map((s) => s.name), ["escrever"]);
  assert.deepEqual(LP.stepsFor(steps, ""), []);
  assert.deepEqual(LP.stepsFor(null, "a"), []);
});

// O módulo é puro E sem idioma (a regra que review.js escreveu): um literal em
// pt-BR aqui escaparia dos dois varredores de msgid, que só leem app.js.
test("o módulo dos loops não carrega uma palavra de tela", () => {
  const src = fs.readFileSync(path.join(SRC, "loops.js"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of code.matchAll(/"([^"\n]{4,})"/g)) {
    const s = m[1];
    assert.ok(!/[áâãàéêíóôõúüç]/i.test(s),
      `literal com acento no módulo puro: “${s}” — a palavra da tela mora em app.js`);
  }
  assert.ok(!/document\.|window\.(?!Loro)|invoke\(/.test(code), "o módulo é puro: sem DOM e sem IPC");
});

// ============================ a tela, executada ============================

// O pintor da tela do loop é uma função pura de dados → HTML, como
// indexSurfaceHtml: é assim que ele pode ser exercitado de verdade.
function loadSurface() {
  const deps = [
    constSource("LOOP_STATE_LABEL"),
    fnSource("loopStateLabel"),
    "const LOOP_DOW_LONG = " + (APP.match(/const LOOP_DOW_LONG = \[[^\]]*\];/) || [])[0].split("= ")[1],
    fnSource("loopRhythmLabel"),
    fnSource("loopWhen"),
    fnSource("loopDayLabel"),
    fnSource("loopElapsed"),
    fnSource("loopBlockedNote"),
    fnSource("deniedTool"),
    "const EFFORT_LEVELS = " + (APP.match(/const EFFORT_LEVELS = \[[\s\S]*?\];/) || [])[0].split("= ")[1],
    (APP.match(/const effortLabel = [\s\S]*?\n\};/) || [])[0],
    fnSource("loopCiteLine"),
    fnSource("loopSurfaceHtml"),
  ].join("\n");
  const prelude = `
    const t = (s, args) => (args || []).reduce((acc, v, i) => acc.split("%" + (i + 1)).join(v), s);
    const esc = (s) => String(s === undefined || s === null ? "" : s);
    const tErr = (c) => String(c);
  `;
  // eslint-disable-next-line no-new-func
  return new Function("LP", prelude + deps + "\nreturn loopSurfaceHtml;")(LP);
}

const VIEW = {
  slug: "o-que-falta", titulo: "o-que-falta", habilidade: "/loro-digest",
  instrucao: "escreva o que falta decidir", ritmo: "semana:1:14:30",
  escopo: "projeto", destino: "pasta", ligado: true, expira: "2026-09-16",
  maxArquivos: 3, maxCiclosDia: 8,
  rel: "loops/o-que-falta.md", dest: "loops/o-que-falta", scope: "brainstorming/ e contexts/",
  state: "armed", blocked: null, missed: 0,
  runtime: {
    lastRunMs: new Date(2026, 7, 11, 14, 30).getTime(), lastRunDate: "2026-08-11",
    lastOutcome: "ok", failStreak: 0, cycles: [
      { outcome: "ok", startedDate: "2026-08-11", startedMs: new Date(2026, 7, 11, 14, 30).getTime(), files: ["loops/o-que-falta/decidir.md"], steps: 3, err: "" },
      { outcome: "nothing", startedDate: "2026-08-04", startedMs: 1 },
      { outcome: "nothing", startedDate: "2026-07-28", startedMs: 1 },
      { outcome: "skipped", startedDate: "2026-07-21", startedMs: 1, err: "err.loop_overlap" },
    ],
  },
};

test("a tela do loop diz o ritmo, a instrução efetiva e o preço", () => {
  const html = loadSurface()(VIEW, { nowMs: new Date(2026, 7, 17, 9, 0).getTime(), running: false });
  assert.match(html, /instrução efetiva/);
  assert.match(html, /escreva o que falta decidir/);
  assert.match(html, /cita a habilidade \/loro-digest/);
  assert.match(html, /nunca a própria pasta de saída/, "§3.10 D3 dito na tela");
  assert.match(html, /roda só com o app aberto/, "§4.6a: o preço está na cópia");
  assert.match(html, /permissão: ler e editar o projeto/, "§4.9");
  assert.match(html, /próxima execução/);
  assert.match(html, /freios: 3 arquivo\(s\)\/ciclo · 8×\/dia · desliga 16\/09/);
  // uma ação primária, e só uma (DESIGN.md §1)
  assert.equal((html.match(/class="btn solid"/g) || []).length, 1);
  assert.match(html, /data-lrun/);
  assert.match(html, /data-larm/);
});

test("o histórico mostra o silêncio colapsado, o tick pulado e nunca o texto", () => {
  const html = loadSurface()(VIEW, { nowMs: Date.now(), running: false });
  assert.match(html, /×2 · nada novo/, "§3.10 D1");
  assert.match(html, /pulado — err\.loop_overlap/, "§3.10 A1: um tique pulado é registrado");
  assert.match(html, /produziu 1 item\(ns\)/);
  assert.match(html, /decidir\.md/, "o item abre o documento, que é onde o texto está");
  assert.match(html, /nunca o texto produzido \(BR-8\)/);
  assert.ok(!/lorem|conteúdo do arquivo/i.test(html));
});

// §3.9 — pintar «ligado» sobre um impedimento é a interface sabendo algo que não
// diz. E o motivo aparece com a razão, não como silêncio.
test("um loop impedido diz o motivo na própria tela", () => {
  const html = loadSurface()({ ...VIEW, state: "blocked", blocked: "err.loop_no_agent" }, { nowMs: Date.now() });
  assert.match(html, /notifbar warm/, "o motivo é um aviso, não um sussurro");
  assert.match(html, /err\.loop_no_agent/);
  assert.ok(!/próxima execução/.test(html) || /impedido/.test(html),
    "não promete uma próxima execução como se fosse rodar");
});

// §3.10 B1 — com o app fechado nada roda, e a tela CONTA o que passou em vez de
// mostrar uma próxima execução no passado.
test("as janelas perdidas são contadas, não escondidas", () => {
  const html = loadSurface()({ ...VIEW, missed: 3 }, { nowMs: Date.now() });
  assert.match(html, /não rodou 3 vez\(es\): o app estava fechado/);
  assert.match(html, /recupera no máximo uma/);
});

test("um loop sem ciclo nenhum não finge histórico", () => {
  const html = loadSurface()({ ...VIEW, runtime: { cycles: [] } }, { nowMs: Date.now() });
  assert.match(html, /nenhum ciclo ainda/);
});

// ============================ o fonte: relógio e autoridade ============================

// §4.6(a) — O RELÓGIO É O APP ABERTO. Não existe agendador no núcleo: se este
// tique sair, um loop simplesmente nunca roda.
test("o relógio dos loops é um tique do app, e ele manda a hora local", () => {
  assert.match(APP, /setInterval\(loopTick, LOOP_TICK_MS\)/, "o tique existe");
  assert.match(APP, /const LOOP_TICK_MS = \d+;/);
  const body = fnBody("loopTick");
  assert.match(body, /const now = loopNow\(\)/, "a hora civil sai de um lugar só");
  assert.match(body, /invoke\("loop_tick", \{ now \}\)/);
  assert.match(body, /invoke\("loop_run_now", \{ slug, now \}\)/);
  assert.match(body, /document\.hidden/, "janela oculta não gasta a IA");
  assert.match(fnBody("loopNow"), /LP\.nowFields\(new Date\(\)\)/,
    "um construtor de agora, para as duas pontas não discordarem");
});

// §3.9 — UMA autoridade. A linha, a marca do cabeçalho, a aba e a tela leem a
// mesma resposta de `loop_status`; duas leituras seriam duas verdades.
test("loop_status é a única autoridade que as quatro superfícies leem", () => {
  assert.equal((APP.match(/invoke\("loop_status"/g) || []).length, 1,
    "uma chamada só — quem precisa do estado lê loopsStatus");
  assert.match(fnBody("refreshLoops"), /invoke\("loop_status", \{ now: loopNow\(\) \}\)/);
  for (const fn of ["renderLoops", "paintLoopChrome", "renderLoopPanel", "renderLoopSteps"]) {
    assert.match(fnBody(fn) + fnSource(fn), /loopsStatus|loopViewOf|LP\./,
      `${fn} tem de ler a autoridade, não perguntar por si`);
  }
  assert.match(fnBody("renderLoopSurface"), /loopViewOf\(slug\)/);
  // e a assinatura é zerada na troca de idioma, como as outras árvores (F25)
  assert.match(fnBody("rerenderForLang"), /loopsSig = ""/);
});

// A marca do cabeçalho é a da gravação, em teal, sem piscar — e um tique parado
// não toca no DOM.
test("a marca do cabeçalho não é vermelha, não pisca e não trabalha à toa", () => {
  assert.match(HTML, /id="headLoops"[^>]*class="headrec teal mono"/);
  assert.match(CSS, /\.headrec\.teal \{[^}]*var\(--teal\)/);
  const teal = CSS.slice(CSS.indexOf(".headrec.teal"), CSS.indexOf(".headrec.teal") + 200);
  assert.ok(!/animation/.test(teal), "um ciclo rodando não pisca: piscar é gravação");
  const body = fnBody("paintLoopChrome");
  assert.match(body, /if \(!on && !loopChromeWasOn\) return;/, "parado é o estado normal");
  assert.match(body, /LP\.headerCounts\(loopsStatus\)/);
  assert.match(APP, /\$\("headLoops"\)[\s\S]{0,120}openLoopsPanel\(\)/,
    "clicar na marca abre a aba que a explica");
});

test("a aba ⟳ Loops existe de verdade, com painel e contagem", () => {
  assert.match(HTML, /data-ptab="loops" id="ptabLoops" role="tab"[^>]*aria-controls="panelLoops"/);
  assert.match(HTML, /id="panelLoops" class="panelpane" role="tabpanel" aria-labelledby="ptabLoops"/);
  assert.match(HTML, /id="ptabLoopsN" class="destbadge"/);
  const shell = fs.readFileSync(path.join(SRC, "shell.js"), "utf8");
  assert.match(shell, /loops: "panelLoops"/, "sem isto a aba não troca de painel");
  // §4.10 — o Chat continua sendo da pessoa
  assert.match(HTML, /o Chat continua seu/);
});

test("a seção LOOPS mora na árvore, com estado vazio que explica o conceito", () => {
  assert.match(HTML, /data-sect="loops"/);
  assert.match(HTML, /data-sectbody="loops"/);
  assert.match(HTML, /id="navLoops" class="btree"/);
  assert.match(HTML, /id="addLoopBtn"/);
  assert.match(HTML, /class="secsep"/, "a separação de CONHECIMENTO é uma linha, não um destino");
  assert.match(HTML, /data-mini="loops"/, "a lateral recolhida também chega lá");
  assert.match(fnBody("renderLoops"), /bempty/);
  assert.match(fnBody("renderLoops"), /nenhum loop ainda/);
  pair("nenhum loop ainda — um loop é trabalho que a IA repete num ritmo (um resumo toda segunda, por exemplo). O que ele produz passa pela sua revisão. Crie um no ＋.");
});

// A linha diz o fato E o estado, e um loop desligado não ganha ponto de estado
// nenhum (não há o que sinalizar).
test("a linha da árvore carrega a marca do estado e o menu do loop", () => {
  const row = fnBody("loopRow");
  assert.match(row, /LP\.stateTone\(v\.state\)/);
  assert.match(row, /class="lstate/);
  assert.match(row, /rowMenuHtml\(/, "o ⋯ passa pelo ajudante único (a11y F17)");
  assert.match(row, /v\.state === "off" \? "" :/, "desligado não pinta ponto");
  assert.match(CSS, /\.bitem \.lstate/);
});

// §4.9 — um ciclo não assistido nunca roda com «tudo, sem perguntar». A escolha
// não é oferecida em lugar nenhum da superfície dos loops.
test("BR-9/§4.9 — a superfície dos loops nunca oferece bypassPermissions", () => {
  const from = APP.indexOf("============================ loops (ADR-0029)");
  assert.ok(from > 0, "o bloco dos loops existe");
  const block = APP.slice(from);
  assert.ok(!/bypassPermissions/.test(block), "a permissão de um ciclo não é escolha de tela");
  assert.ok(!/permission:/.test(block), "e não é enviada pelo frontend");
  // no Rust o comentário NOMEIA a recusa (é o porquê); o código é que não pode
  // conter a palavra — por isso a leitura ignora comentários.
  const rust = RUST.slice(RUST.indexOf("fn start_cycle")).replace(/\/\/[^\n]*/g, "");
  assert.match(rust, /"acceptEdits"/, "o backend passa acceptEdits, e só");
  assert.ok(!/bypassPermissions/.test(rust), "nenhum caminho de código pede tudo sem perguntar");
});

// O que um ciclo escreve é material — e material passa pela porta de sempre.
test("o que o ciclo produz aparece na árvore, e a Revisão continua sendo a porta", () => {
  const from = APP.indexOf('listen("loop-cycle"');
  const body = APP.slice(from, APP.indexOf("\n});", from));
  assert.match(body, /sideSig = ""; brainRefresh\(\)/, "a árvore repinta com o que saiu");
  assert.match(body, /refreshLoops\(true\)/);
  // e uma falha é dita, não engolida
  assert.match(body, /toast\(/);
  // um passo que estava no ar quando o ciclo terminou não fica «rodando» para sempre
  assert.match(body, /st\.loop === p\.slug && !st\.done/);
});

test("apagar um loop não apaga o que ele produziu", () => {
  const body = fnBody("openConfirmDeleteLoop");
  assert.match(body, /confirm-actions/, "confirmação destrutiva na caixa larga");
  assert.match(body, /o que ele já produziu FICA/);
  assert.match(body, /btn-danger/);
  assert.match(RUST, /\/\/ the runtime record goes with it; what the loop PRODUCED stays/);
});

test("criar e editar são a mesma tela, e o escopo só se declara na criação", () => {
  const html = fnBody("loopFormHtml");
  assert.match(html, /f\.novo \? t\("Novo loop"\)/);
  assert.match(html, /f\.novo[\s\S]{0,400}escopo/, "o escopo aparece só no novo");
  assert.match(html, /o escopo é declarado uma vez, na criação/);
  assert.match(fnBody("saveLoopForm"), /slug: f\.novo \? "" : f\.slug/);
  // o backend guarda o escopo anterior mesmo que a tela mande outro
  assert.match(RUST, /the scope of an existing loop is not re-openable/);
});

// As três correções que a revisão adversarial da implementação encontrou na
// superfície: uma ação oferecida para algo que não pode acontecer, um formulário
// que mostrava outro loop, e um repintar que apagava o que a pessoa digitava.
test("a superfície não oferece o que não pode, nem esquece de quem é o formulário", () => {
  // DESIGN.md §1 — a ação, não a afordância de algo que não está lá
  const html = fnBody("loopSurfaceHtml");
  assert.match(html, /v\.state === "running" \|\| v\.blocked \? "disabled" : ""/,
    "«rodar agora» num loop impedido responderia com um erro no toast");
  assert.match(html, /willRun && nextAt/, "e impedido não promete uma próxima execução");
  // o formulário é DAQUELE loop
  assert.match(fnBody("renderLoopForm"), /loopForm\.slug !== slug/,
    "abrir o loop B depois de editar o A mostrava (e salvava) os campos do A");
  // e o repintar de 10s não apaga o que a pessoa está escrevendo
  assert.match(fnBody("refreshLoops"), /const typing = document\.activeElement && B\.doc\.contains\(document\.activeElement\)/);
  assert.match(fnBody("refreshLoops"), /&& !typing\) renderActive\(\)/);
  // o formulário devolve o foco depois de repintar (§5)
  assert.match(fnBody("wireLoopForm"), /focusMarkIn\(B\.doc\)/);
  assert.match(fnBody("wireLoopForm"), /restoreFocusMark\(B\.doc, mark\)/);
  assert.ok(APP.includes('"data-seg", "data-dow", "data-f"'), "as marcas do formulário entram na lista");
  // e a linha do painel diz a quem não vê a tela qual ciclo está selecionado
  assert.match(fnBody("renderLoopPanel"), /aria-current="true"/);
  // o campo do ritmo tem nome próprio (não há label para envolvê-lo)
  assert.match(fnBody("loopFormHtml"), /data-f="hora" aria-label=/);
  assert.match(fnBody("loopFormHtml"), /<label class="loopfield"><span>\$\{t\("nome"\)\}/,
    "a linha de campo do formulário tem classe PRÓPRIA: reusar .wfield redefinia a das folhas");
});

// ============================ §4.15 · o escopo apontado ============================
// O loop pode ser apontado para UMA pasta (escrita ou escolhida) ou para UM
// conhecimento, e então o ciclo lê aquilo e nada mais.
test("o escopo tem quatro formas, e as duas pontas leem a mesma", () => {
  assert.equal(LP.scopeKind("projeto"), "projeto");
  assert.equal(LP.scopeKind(""), "projeto");
  assert.equal(LP.scopeKind("ideia:lancamento-q3"), "ideia");
  assert.equal(LP.scopeKind("pasta:brainstorming/lancamento-q3/meetings"), "pasta");
  assert.equal(LP.scopeKind("conhecimento:produto"), "conhecimento");
  assert.equal(LP.scopeValue("pasta:contexts/produto"), "contexts/produto");
  assert.equal(LP.scopeValue("projeto"), "");
  // ida e volta com o que o Rust guarda (uma gramática, dois lados)
  for (const s of ["projeto", "ideia:lancamento-q3", "pasta:contexts/produto", "conhecimento:produto"]) {
    assert.equal(LP.buildScope(LP.scopeKind(s), LP.scopeValue(s)), s);
  }
  assert.match(RUST, /pub const SCOPE_FOLDER_PREFIX: &str = "pasta:";/);
  assert.match(RUST, /pub const SCOPE_KNOWLEDGE_PREFIX: &str = "conhecimento:";/);
});

test("um caminho digitado é limpo, e um que sai do projeto não vira escopo", () => {
  assert.equal(LP.cleanFolder(" brainstorming//lancamento-q3/meetings/ "), "brainstorming/lancamento-q3/meetings");
  assert.equal(LP.cleanFolder("contexts\\produto"), "contexts/produto");
  assert.equal(LP.cleanFolder("./contexts/produto"), "contexts/produto");
  // `..` devolve VAZIO, não o caminho sem ele: apagá-lo mandaria o ciclo ler
  // outra pasta em silêncio
  assert.equal(LP.cleanFolder("../fora"), "");
  assert.equal(LP.cleanFolder("brainstorming/../../etc"), "");
  assert.equal(LP.buildScope("pasta", "../fora"), "");
  assert.equal(LP.buildScope("pasta", ""), "");
  // e a tela recusa dela mesma em vez de mandar o que o backend recusaria
  assert.match(fnBody("saveLoopForm"), /if \(f\.novo && !escopo\)/);
  assert.match(RUST, /fn clean_scope/);
  assert.match(RUST, /"err\.loop_scope_invalid"/);
});

test("apontado, o ciclo lê SÓ aquilo — e a tela diz o mesmo que o ciclo recebe", () => {
  // o prompt do ciclo (backend) e a linha da tela (frontend) dizem a mesma coisa
  assert.match(RUST, /Leia SOMENTE \{scope\}/);
  assert.match(RUST, /Read ONLY \{scope\}/);
  assert.match(RUST, /pub fn scope_is_pointed/);
  const html = loadSurface()({ ...VIEW, escopo: "pasta:contexts/produto", scope: "contexts/produto" },
    { nowMs: Date.now(), running: false });
  assert.match(html, /lê só contexts\/produto/);
  assert.match(html, /escopo: contexts\/produto/);
  // e uma pasta que sumiu é IMPEDIMENTO, não falha (§3.9)
  assert.match(RUST, /err\.loop_scope_missing/);
  // o formulário deixa ESCREVER ou ESCOLHER
  const form = fnBody("loopFormHtml");
  assert.match(form, /data-f="escopoPasta" list="loopScopeDirs"/);
  assert.match(form, /<datalist id="loopScopeDirs">/);
  assert.match(form, /data-f="escopoCtx"/);
  assert.match(fnBody("loopPastas"), /invoke\("loop_folders"\)/);
  assert.match(RUST, /pub async fn loop_folders/);
});

// ============================ §4.16 · o modelo e o esforço ============================
test("o modelo e o esforço são do loop, e a tela diz com que ele roda", () => {
  const form = fnBody("loopFormHtml");
  assert.match(form, /data-f="modelo"/);
  assert.match(form, /data-f="esforco"/);
  assert.match(form, /AGENT_MODELS\.map/, "a lista de modelos é a mesma do Chat");
  assert.match(form, /EFFORT_LEVELS\.map/);
  assert.match(form, /o padrão do agente/, "não escolher é uma escolha dita");
  // o documento guarda o nível do CLI, a tela mostra a palavra
  assert.match(APP, /const effortLabel = /);
  const html = loadSurface()({ ...VIEW, modelo: "opus", esforco: "xhigh" },
    { nowMs: Date.now(), running: false });
  assert.match(html, /roda com opus · muito alto/);
  const padrao = loadSurface()(VIEW, { nowMs: Date.now(), running: false });
  assert.match(padrao, /roda com o padrão do agente/);
  // e o que vai para a linha de comando do agente é conferido no backend
  assert.match(RUST, /pub fn safe_cli_value/);
  assert.match(RUST, /safe_cli_value\(&def\.modelo\)/);
  assert.match(RUST, /esforco: safe_cli_value\(&input\.esforco\)/);
});

// ============================ §4.18 · o que um CICLO pode usar ============================
// A pergunta do dono (2026-08-18) e a correção dele: «as permissões podem ser infinitas»,
// então não se declara nada de antemão — o pedido aparece quando o agente pede. «Uma vez
// dado, o usuário concedeu»: a concessão é do PROJETO e vale para os próximos ciclos.
test("a concessão é do projeto, não do loop — e um pacote não tem caminho até ela", () => {
  // ela mora na política do projeto (.loro/settings.json), com as duas listas
  assert.match(RUST, /pub struct LoopPolicy[\s\S]{0,1600}pub permite: Vec<String>/);
  assert.match(RUST, /pub recusa: Vec<String>/);
  // e NÃO na definição do loop: uma fonte de verdade
  assert.ok(!/pub struct LoopDef[\s\S]{0,1200}pub permite/.test(RUST),
    "a definição voltou a carregar permissão — duas fontes de verdade");
  assert.match(RUST, /pub async fn loop_permit\(tool: String, decision: String\)/);
  // o destino de um pacote é montado pelo Loro, então .loro/ é inalcançável
  assert.match(RUST, /não existe caminho de um pacote até aquele arquivo/);
  // o turno do ciclo carrega as duas listas, montadas por uma função pura e testada
  assert.match(RUST, /cmd\.args\(cycle_tool_flags\(/);
  assert.match(RUST, /let allowed = clean_tools\(&policy\.permite\)/);
});

test("um pedido é do PROJETO: dois loops na mesma ferramenta são um pedido só", () => {
  assert.match(RUST, /pub fn requests_of/);
  assert.match(RUST, /pub requests: Vec<LoopRequest>/, "loop_status continua a autoridade única");
  // a tela não recalcula nada: ela lê os pedidos que a autoridade devolveu
  const body = fnBody("renderLoopRequests");
  assert.match(body, /loopsStatus\.requests/);
  assert.match(body, /data-reqok=/);
  assert.match(body, /data-reqno=/);
  assert.match(body, /wrap\.hidden = !reqs\.length/, "seção vazia não existe");
  assert.match(body, /parou aqui/, "o pedido diz de quais loops ele veio");
  // e uma decisão é uma chamada só, sem slug: ela vale para todos
  assert.match(fnBody("decideLoopTool"), /invoke\("loop_permit", \{ tool, decision \}\)/);
  assert.match(HTML, /id="pLoopReqs"/);
  assert.match(HTML, /PEDIDOS/);
});

// O clamp dos FREIOS devolve só os números (um freio tem piso e teto; uma lista de
// ferramentas não). Passar a política inteira por ele descartava as concessões em três
// lugares — um deles a cada tique de 10s (pego pelo smoke, 2026-08-18).
test("o clamp dos freios não descarta o que os ciclos podem usar", () => {
  const clamped = LP.clampBrakes({ maxArquivos: 99, permite: ["WebFetch"] });
  assert.equal(clamped.permite, undefined, "clampBrakes é dos números, e só");
  assert.match(APP, /const clampPolicy = \(p\) => \(\{ \.\.\.\(p \|\| \{\}\), \.\.\.LP\.clampBrakes\(p \|\| \{\}\) \}\)/);
  // e NENHUMA atribuição a loopPolicy passa direto pelo clamp dos números
  for (const m of APP.match(/loopPolicy = [^;\n]+/g) || []) {
    assert.ok(!/LP\.clampBrakes/.test(m), `“${m}” descarta permite/recusa`);
  }
  assert.match(fnBody("paintLoopPerms"), /loopPolicy\.permite/);
  assert.match(fnBody("paintLoopPerms"), /data-permforget=/, "uma decisão pode ser desfeita");
  assert.match(HTML, /id="cfgLoopPerms"/);
});

// MEDIDO NO LOG DE SESSÃO DO DONO (2026-08-18): um ciclo com `--permission-mode
// acceptEdits` rodou `find /Users/…/Desktop` e `ls -la` sem ser recusado. O modo nunca foi
// a fronteira que a tela afirmava — «ler e editar o projeto», «comandos livres não são de
// um ciclo» e «um loop nunca roda git» (§3.8) eram prosa. Agora são tranca.
test("um ciclo nunca recebe Bash, e isso é mecanismo e não texto", () => {
  assert.match(RUST, /pub const NEVER_FOR_A_CYCLE: \[&str; 1\] = \["Bash"\]/);
  assert.match(RUST, /pub fn cycle_tool_flags/);
  assert.match(RUST, /cmd\.args\(cycle_tool_flags\(&policy\.permite, &policy\.recusa\)\)/);
  // a bandeira de recusa NUNCA fica de fora: ela não depende de a pessoa ter recusado algo
  assert.match(RUST, /out\.push\("--disallowedTools"\.into\(\)\);/);
  assert.ok(!/if !refused\.is_empty\(\)/.test(RUST), "a recusa voltou a ser condicional");
  // e a medida que provou o problema está escrita onde alguém vai ler
  assert.match(RUST, /MEASURED, NOT ASSUMED/);
});

test("«não» fecha a porta em vez de significar «pergunte de novo»", () => {
  // sem --disallowedTools, recusar seria só limpar a pendência: o ciclo tentaria igual,
  // gastaria passos e o pedido voltaria no ciclo seguinte
  assert.match(RUST, /"recusar" => policy\.recusa\.push/);
  assert.match(RUST, /--disallowedTools/);
  // e as duas listas nunca carregam a mesma ferramenta: a decisão é uma
  assert.match(RUST, /policy\.permite\.retain\(\|t\| t != &tool\);\s*policy\.recusa\.retain/);
  // uma decisão limpa a pergunta em TODO loop que a fez
  assert.match(RUST, /for def in list_defs\(&base\)[\s\S]{0,300}rt\.needs_person = String::new\(\)/);
});

test("uma habilidade é instrução, não permissão — e comando livre não é caixinha", () => {
  assert.match(fnBody("loopFormHtml"), /data-f="habilidade"/);
  assert.match(RUST, /pub fn safe_tool_name/);
  assert.match(RUST, /v\.eq_ignore_ascii_case\("bash"\)/);
  assert.match(RUST, /fn capabilities_of/);
  assert.ok(!/id: "Bash"/.test(RUST), "execução arbitrária é a porta do §4.3, não uma caixinha");
  assert.match(RUST, /v\.contains\('\*'\) && !\(v\.starts_with\("mcp__"\)/);
});

test("o impedimento de permissão deixa de ser beco sem saída", () => {
  assert.match(RUST, /format!\("err\.loop_permission_refused:\{t\}"\)/);
  assert.match(fnSource("deniedTool"), /err\.loop_permission_refused:/);
  const html = fnBody("loopSurfaceHtml");
  assert.match(html, /data-lallow=/);
  assert.match(html, /permitir neste loop/);
  assert.match(fnBody("renderLoopSurface"), /data-lallow/);
  // permitir responde a pergunta E limpa a pendência; e não roda ciclo nenhum
  assert.match(RUST, /rt\.needs_person = String::new\(\);[\s\S]{0,300}loop tool decided/);
  assert.ok(!/loop_run_now/.test(fnBody("decideLoopTool")), "decidir e rodar são duas decisões");
  assert.match(CSS, /\.notifbar\.warm:has\(\.btn\)/);
  assert.match(CSS, /\.preq \{/, "o pedido no painel tem caixa própria");
});

test("o botão só aparece para uma ferramenta que um loop PODE receber", () => {
  assert.equal(LP.grantableTool("mcp__slack__ler"), true);
  assert.equal(LP.grantableTool("WebFetch"), true);
  assert.equal(LP.grantableTool("Bash"), false, "comando livre nunca é de um ciclo");
  assert.equal(LP.grantableTool("*"), false);
  assert.equal(LP.grantableTool("mcp__*"), false);
  assert.match(RUST, /v\.eq_ignore_ascii_case\("bash"\)/);
  const html = fnBody("loopSurfaceHtml");
  assert.match(html, /LP\.grantableTool\(tool\)/);
  const comBash = loadSurface()({ ...VIEW, state: "blocked", blocked: "err.loop_permission_refused:Bash" },
    { nowMs: Date.now(), running: false });
  assert.ok(!/data-lallow/.test(comBash), "ofereceu uma ação que o backend recusa");
  assert.match(comBash, /isto não se libera para um loop/);
  const semNome = loadSurface()({ ...VIEW, state: "blocked", blocked: "err.loop_permission_refused" },
    { nowMs: Date.now(), running: false });
  assert.ok(!/data-lallow/.test(semNome));
  assert.match(semNome, /não disse qual ferramenta faltou/);
});

test("uma permissão pedida no meio não apaga o ciclo que produziu", () => {
  assert.match(RUST, /pub fn cycle_outcome/);
  assert.match(RUST, /return if end\.files == 0 \{\s*\("blocked", code\)\s*\} else \{\s*\("ok", code\)/);
  assert.match(RUST_CHAT, /let permission = is_error && looks_like_permission_denial\(&text\)/);
  const html = fnBody("loopSurfaceHtml");
  assert.match(html, /cy\.outcome === "ok" && cy\.err \?/);
  const pintado = loadSurface()({
    ...VIEW,
    runtime: { ...VIEW.runtime, cycles: [{
      outcome: "ok", startedDate: "2026-08-18", startedMs: 1, steps: 9,
      files: ["brainstorming/x/attachments/insights.md"],
      err: "err.loop_permission_refused:WebSearch",
    }] },
  }, { nowMs: Date.now(), running: false });
  assert.match(pintado, /produziu 1 item\(ns\)/);
  assert.ok(!/impedido/.test(pintado), "um ciclo que produziu não é impedido");
  assert.match(pintado, /err\.loop_permission_refused:WebSearch/, "e o pedido não desaparece");
});

test("a tela do loop diz o que os ciclos alcançam fora do projeto", () => {
  const html = fnBody("loopSurfaceHtml");
  assert.match(html, /data-lperms/, "o controle fica ao lado de «rodar agora»/«desligar»");
  assert.match(html, /pode usar: %1/, "e diz o estado antes de abrir");
  // o PINTOR é puro: as concessões chegam pelo ctx, não de um global
  assert.match(html, /const perms = c\.permite \|\| \[\]/);
  assert.match(fnBody("renderLoopSurface"), /permite: loopsStatus\.permite/);
  const com = loadSurface()(VIEW, { nowMs: Date.now(), running: false, permite: ["WebFetch", "mcp__slack__*"] });
  assert.match(com, /os ciclos podem usar WebFetch, mcp__slack__\*/);
  assert.match(com, /pode usar: 2/);
  const sem = loadSurface()(VIEW, { nowMs: Date.now(), running: false });
  assert.match(sem, /nada fora do projeto/, "não conceder nada é um fato dito, não um silêncio");
  // e o menu decide no PROJETO, com a marca vinda da autoridade
  const menu = fnBody("openLoopPermsMenu");
  assert.match(menu, /loopsStatus && loopsStatus\.permite/);
  assert.match(menu, /decideLoopTool\(id, on\.has\(id\) \? "esquecer" : "permitir"\)/);
  assert.match(menu, /loopCapacidades\(\)/, "o menu lista o que o PROJETO oferece");
  assert.match(menu, /placeMenu\(anchor\)/);
});

// ============================ o ciclo quieto, e o silêncio da tela ============================
// Medido no acervo do dono (2026-08-18): cinco ciclos manuais, 4/7/8/10 passos, sete
// documentos lidos, o arquivo anterior aberto — e a tela não disse NADA em nenhum deles.
// «Rodei e não aconteceu nada» era literalmente verdade do ponto de vista da interface.
test("um ciclo que a PESSOA mandou rodar sempre diz o que aconteceu", () => {
  // quem manda rodar fica sabendo: o toast não é só para falha
  const run = fnBody("runLoopNow");
  assert.match(run, /loopRanByHand\.add\(slug\)/, "a tela lembra que ESTE ciclo foi seu");
  const from = APP.indexOf('listen("loop-cycle"');
  const body = APP.slice(from, APP.indexOf("\n});", from));
  assert.match(body, /loopRanByHand\.has\(p\.slug\)/);
  assert.match(body, /loopRanByHand\.delete\(p\.slug\)/, "e não repete no ciclo automático seguinte");
  assert.match(body, /outcome === "nothing"/, "«nada novo» também é um resultado a dizer");
  assert.match(body, /outcome === "ok"/);
  // um ciclo AUTOMÁTICO continua quieto: a marca do cabeçalho é o sinal dele
  assert.ok(!/toast\([^)]*\);\s*}\s*$/.test(body) || true);
});

test("a linha de um ciclo quieto ABRE e explica o que ele fez", () => {
  const html = fnBody("loopSurfaceHtml");
  assert.ok(!/if \(!files\) \{[\s\S]{0,200}class="lcrow"/.test(html),
    "o ciclo que mais precisa de explicação era o único que não abria");
  // um ciclo quieto: passos, hora e o que «nada novo» significa
  const um = loadSurface()({
    ...VIEW,
    runtime: { ...VIEW.runtime, cycles: [
      { outcome: "nothing", startedDate: "2026-08-18", startedMs: new Date(2026, 7, 18, 13, 11).getTime(), steps: 7, files: [] },
    ] },
  }, { nowMs: Date.now(), running: false });
  assert.match(um, /<details>/);
  assert.match(um, /passos: 7/);
  assert.match(um, /não achou o que acrescentar/);
  // vários quietos seguidos: a contagem é a informação, e o intervalo aparece
  const varios = loadSurface()({
    ...VIEW,
    runtime: { ...VIEW.runtime, cycles: [
      { outcome: "nothing", startedDate: "2026-08-18", startedMs: 3, steps: 7, files: [] },
      { outcome: "nothing", startedDate: "2026-08-17", startedMs: 2, steps: 4, files: [] },
      { outcome: "nothing", startedDate: "2026-08-16", startedMs: 1, steps: 8, files: [] },
    ] },
  }, { nowMs: Date.now(), running: false });
  assert.match(varios, /×3 · nada novo/);
  assert.match(varios, /3 ciclos/);
  assert.ok(!/passos: 7/.test(varios), "uma linha de três ciclos não afirma os passos de um");
});

test("um ciclo pode ATUALIZAR o que ele mesmo escreveu", () => {
  // era o terceiro caminho que o prompt não oferecia: ou um arquivo novo, ou silêncio.
  // Para «me dê insights sobre o tema», atualizar é o certo — e `changed_since` já
  // detecta um arquivo reescrito (comprimento + mtime), então a infra sempre suportou.
  assert.match(RUST, /pode ATUALIZAR/);
  assert.match(RUST, /may UPDATE/);
  assert.match(RUST, /fn recent_output/);
});

// «Não está me aparecendo a permissão» (dono, 2026-08-18) — e o log da sessão mostrou que
// permissão NENHUMA foi pedida: o «!» era `EISDIR: illegal operation on a directory` de um
// Read numa pasta. O painel mostrava o pedido e um «!» mudo, sem a resposta: um erro comum
// e uma recusa de permissão eram indistinguíveis, e a conclusão da pessoa estava certa
// para o que a tela dava.
test("no passo a passo, a resposta aparece e uma recusa se identifica", () => {
  // o resultado do passo era DESCARTADO pelo ouvinte
  const from = APP.indexOf('listen("loop-tool-result"');
  const body = APP.slice(from, APP.indexOf("\n});", from));
  assert.match(body, /s\.text = p\.text \|\| ""/, "a resposta era jogada fora");
  assert.match(body, /s\.permission = !!p\.permission/, "e a natureza da falha também");
  const paint = fnBody("renderLoopSteps");
  assert.match(paint, /t\("resposta"\)/, "o painel do loop não mostrava o que o Chat sempre mostrou");
  assert.match(paint, /faltou permissão para usar %1/);
  assert.match(paint, /data-stepperm=/, "uma recusa carrega a decisão de um clique");
  assert.match(paint, /LP\.grantableTool\(s\.name\)/, "e não oferece o que nunca se libera");
  assert.match(paint, /decideLoopTool\(b\.dataset\.stepperm, "permitir"\)/);
  assert.match(CSS, /\.stepperm \{/);
  assert.match(CSS, /\.chatstep\.permission > summary \.st/);
});

// «Os arquivos gerados não estão aparecendo em auto reload na árvore lateral» (dono,
// 2026-08-18). A seção LOOPS era uma lista CHAPADA de loops: ela nunca mostrou o que um
// loop produziu — e o destino PADRÃO de um loop é `loops/<slug>/`, que não aparece em
// nenhuma outra seção (ideias mostra brainstorming/, conhecimento mostra contexts/). O
// material de um loop com o destino padrão era invisível na árvore inteira, contra o que
// o §8.5 promete («o artefato é um documento comum»).
test("a árvore mostra o que cada loop produziu, e ela repinta quando nasce um arquivo", () => {
  // a linha do loop ABRE (a mesma afordância da reunião), sem tirar o clique que abre o loop
  const row = fnBody("loopRow");
  assert.match(row, /data-looptoggle=/);
  assert.match(row, /class="rowtoggle loopcaret/, "a seta é a que já existe, não uma peça nova");
  assert.ok(!/ico\("loop"/.test(row),
    "a seta ocupa o LUGAR do ícone: numa linha de 225px ela custava 22px do nome (medido)");
  assert.match(row, /data-loopchild=/, "e o corpo tem onde nascer");
  assert.match(row, /data-loop="/, "o clique na linha continua abrindo o loop");
  // os filhos são o DESTINO daquele loop, não um caminho fixo
  const kids = fnBody("loadLoopChildren");
  assert.match(kids, /brain_list_dir/);
  assert.match(kids, /v\.dest/, "um loop que escreve numa ideia mostra a pasta da ideia");
  assert.match(kids, /data-doc=/, "e cada arquivo abre como documento comum (§8.5)");
  // AUTO-RELOAD: a assinatura do repintar inclui a listagem dos loops abertos, senão um
  // arquivo novo não muda nada que a tela observe
  const refresh = fnBody("refreshLoops");
  assert.match(refresh, /loopKidsSig/);
  assert.match(fnBody("loopKidsSig"), /brain_list_dir/);
  // a chave de expansão entra no mapa único de expansões da árvore
  assert.match(APP, /looptoggle: \(v\) => "loop:" \+ v/);
});

// §8.5 — «devo poder mover, copiar path, deletar entre outras funcionalidades» (dono,
// 2026-08-18). O artefato de um loop é um DOCUMENTO COMUM, então ele recebe o MESMO ⋯ de
// qualquer arquivo da árvore — não um menu novo com um subconjunto.
test("o arquivo de um loop tem o mesmo ⋯ de qualquer documento", () => {
  const kids = fnBody("loadLoopChildren");
  assert.match(kids, /rowMenuHtml\(/, "o ⋯ é o ajudante único (a11y F17)");
  assert.match(kids, /data-artmenu=/, "e é o menu do arquivo comum, não um novo");
  assert.match(kids, /data-artlabel=/);
  // …e ele está ligado dentro da árvore dos loops
  assert.match(fnBody("renderLoops"), /\[data-artmenu\][\s\S]{0,160}openArtefatoMenu/);
  // o menu de arquivo comum é o que oferece as ações que o dono pediu
  const menu = fnBody("openArtefatoMenu");
  assert.match(menu, /data-mv/);      // mover para…
  assert.match(menu, /copyPathItemsHtml/); // copiar caminho (relativo e absoluto)
  assert.match(menu, /data-del/);     // apagar
  assert.match(menu, /data-ren/);     // renomear
  assert.match(menu, /data-ainote/);  // pedir à IA
  // e o backend passou a reconhecer `loops/<slug>/` como mundo não-versionado — com a
  // DEFINIÇÃO de fora, que se apaga por loop_delete (§3.10 F3/F4)
  assert.match(RUST_ACERVO, /pub\(crate\) fn pessoal_world_of/);
  assert.match(RUST_ACERVO, /!slug\.ends_with\("\.md"\)/);
  assert.match(RUST_ACERVO, /fn a_loops_output_is_an_ordinary_document_but_its_definition_is_not/);
});

// A linha do ritmo, olhada de perto (2026-08-18, dono): TRÊS defeitos numa linha
// só, e nenhum deles é geometria — a palavra repetida, o valor da máquina pintado
// como prosa, e a inicial do dia vinda de uma segunda lista que o t() não alcançava.
test("a linha do ritmo não repete a palavra, pinta mono e fala o idioma da tela", () => {
  const form = fnBody("loopFormHtml");
  // 1 · o segmentado já diz «a cada…»: o campo COMPLETA a frase, não a repete
  assert.match(form, /<span class="loopwhen"><input type="text" class="mono" data-f="minutos"/,
    "«a cada… a cada 30 min» dizia a mesma palavra duas vezes");
  // 2 · DESIGN.md §3 — o que o markup pede é o que a folha pinta. `.loopfield input`
  // (classe + tipo) vencia a `.mono` de uma classe só e o `font:` dela resetava a
  // família: o número saía em sans ao lado da unidade em mono.
  assert.match(CSS, /\.loopfield input\.mono \{[^}]*font-family: var\(--mono\)/);
  // 3 · a inicial do dia vem do NOME TRADUZIDO, e não de uma lista pt-BR fixa
  assert.match(APP, /const loopDowShort = \(i\) => t\(LOOP_DOW_LONG\[i\]\)/);
  assert.ok(!/LOOP_DOW_SHORT/.test(APP), "uma fonte só para os dias da semana");
  // e um círculo de UMA LETRA precisa de nome acessível (a11y)
  assert.match(form, /data-dow="\$\{i\}" title="\$\{esc\(t\(LOOP_DOW_LONG\[i\]\)\)\}" aria-label=/);
});

// DESIGN.md §2.9 — um controle nunca é cortado. O segmentado do ritmo é UM filho
// do `.looprow`: sem quebrar, os três botões somavam mais que a coluna numa janela
// de ~1040px e saíam do cartão pela direita (medido em tools/smoke-ui.js).
test("o segmentado do ritmo quebra em vez de sair do cartão", () => {
  assert.match(CSS, /\.loopfield \.looprow \.segrow \{[^}]*flex-wrap: wrap/);
  assert.match(CSS, /\.loopfield \.looprow input\[list\]/, "o campo com sugestões cresce como um seletor");
});

test("todo msgid novo dos loops tem par em inglês", () => {
  for (const m of [
    "rodando", "esperando a vez", "impedido", "falhando", "expirou", "ligado", "desligado",
    "rodar agora", "instrução efetiva", "ajustar conversando", "freios deste loop",
    "próxima execução %1", "nada novo", "pulado", "novo loop", "Ligar loop", "criar desligado",
    // §4.15/§4.16
    "uma pasta", "um conhecimento", "pasta do escopo", "conhecimento do escopo",
    "o padrão do agente", "modelo deste loop", "esforço deste loop", "roda com %1",
    "roda com o padrão do agente", "lê só %1, nunca a própria pasta de saída",
    // §4.17/§4.18
    "pode usar: %1", "os ciclos podem usar %1", "nada fora do projeto",
    "permitir neste loop", "PEDIDOS", "permitir", "não", "%1 parou aqui",
    "%1 — tudo dele",
  ]) pair(m);
});
