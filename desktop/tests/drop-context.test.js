// Arrastar um arquivo do sistema para DENTRO do chat ou do terminal (ADR-0028).
//
// A janela já aceitava arquivos soltos, mas com UM destino só: a fila do acervo
// (`brain_import_paths`). Soltar sobre o chat ou sobre o terminal — as duas
// superfícies onde se conversa com o agente — não fazia nada, e o caminho de um
// arquivo é exatamente o contexto que se quer dar ali. Agora o LUGAR do solto
// decide o destino, e nas duas superfícies novas o que entra é o CAMINHO como
// texto: nada é importado, nada é executado.
//
// DESIGN.md §1 (o realce não pode prometer o destino errado) e o princípio de
// que uma ação irreversível não acontece por acidente — daí o terminal receber o
// caminho SEM "\n".
// Sem DOM sob `node --test`: a costura é a FONTE de app.js/style.css, e toda
// decisão que pode ser função pura é uma e é exercitada de verdade.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
const { EN } = require("../src/i18n.js");

function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}
function loadPure(name) {
  // eslint-disable-next-line no-new-func
  return new Function("const t = (s) => s;\nreturn (" + fnSource(name) + ");")();
}
// O roteador é executado de verdade: as dependências dele entram como espiões, e
// o teste lê o que cada destino RECEBEU.
function loadRouter(env) {
  const spy = {
    chat: null, term: null, imported: null, marks: [], toasts: [],
    brainTab: env.brainTab !== false, hostOs: env.hostOs || "macos", dest: env.dest,
  };
  const fn = new Function("spy", `
    const t = (s) => s, tErr = (s) => s, clog = () => {};
    let sideSig = "", brainTab = spy.brainTab, hostOs = spy.hostOs;
    const toast = (m) => spy.toasts.push(m);
    const brainRefresh = () => {};
    // cada porta devolve o que ela devolve de verdade: a fila conta, o arquivar devolve os
    // caminhos NOVOS (é deles que o toast e o realce vivem)
    const invoke = async (cmd, args) => {
      spy.imported = { cmd, args };
      const paths = args.paths || [];
      if (cmd === "brain_drop_into") {
        return paths.map((p) => args.destRel + "/" + String(p).split("/").pop());
      }
      return paths.length;
    };
    const dropDestinationAt = () => spy.dest;
    const paintDropTarget = (d) => spy.marks.push(d);
    const insertIntoChatInput = (s) => { spy.chat = s; return true; };
    const dropIntoTerminal = (s) => { spy.term = s; };
    ${fnSource("isQueueGuidePath")}
    ${fnSource("splitQueueGuideDrop")}
    ${fnSource("quoteDropPathShell")}
    ${fnSource("quoteDropPathPrompt")}
    ${fnSource("dropPathsText")}
    ${fnSource("dropOriginLabel")}
    return ${fnSource("handleSystemDrop")};
  `)(spy);
  return { run: fn, spy };
}

// ---------------------------------------------------------------- o destino
test("o LUGAR do solto nomeia o destino — chat, terminal ou fila", () => {
  const dest = loadPure("dropDestination");
  const hitting = (...sels) => ({ closest: (s) => (sels.includes(s) ? {} : null) });

  assert.equal(dest(hitting("#panelChat")), "chat");
  assert.equal(dest(hitting("#termPanel")), "terminal");
  assert.equal(dest(hitting("#panelDoc")), "fila", "fora das duas, o destino de sempre");
  assert.equal(dest(null), "fila", "sem alvo (fora da janela) o comportamento não muda");
  assert.equal(dest({}), "fila", "um alvo sem closest não pode explodir o drop");
});

// ---------------------------------------------------------------- arquivar
// «Ao arrastar um arquivo do meu computador para dentro da árvore, quero mover esse
// arquivo para o destino» (dono, 2026-08-18). O quarto destino entra no MESMO roteador: o
// lugar do solto decide. E o gesto tem significados diferentes nos dois lugares —
// arquivar numa pasta MOVE (o original sai, como em qualquer gerenciador de arquivos no
// mesmo disco); soltar na FILA copia, porque ali é «entregue isto à IA».
test("uma PASTA da árvore é um destino, e ela nomeia a si mesma", () => {
  const dest = loadPure("dropDestination");
  const hitting = (sel, attrs) => ({
    closest: (s) => (s === sel ? { dataset: attrs || {} } : null),
  });
  assert.equal(
    dest(hitting("[data-dropdir]", { dropdir: "brainstorming/vendas/attachments" })),
    "pasta:brainstorming/vendas/attachments"
  );
  assert.equal(dest(hitting("[data-dropdir]", { dropdir: "loops/teste" })), "pasta:loops/teste");
  // uma pasta sem caminho não vira destino — cair na fila é o certo, não adivinhar
  assert.equal(dest(hitting("[data-dropdir]", {})), "fila");
  // o chat e o terminal continuam vencendo (eles são superfícies, não pastas)
  assert.equal(dest({ closest: (s) => (s === "#panelChat" ? {} : null) }), "chat");
});

test("soltar numa pasta MOVE; soltar na fila copia", () => {
  const { run, spy } = loadRouter({ dest: "pasta:brainstorming/vendas/attachments" });
  return run({ paths: ["/Users/x/Desktop/relatorio.pdf"], position: { x: 1, y: 1 } }).then(() => {
    assert.equal(spy.imported.cmd, "brain_drop_into", "a porta que MOVE, não a que copia");
    assert.deepEqual(spy.imported.args.paths, ["/Users/x/Desktop/relatorio.pdf"]);
    assert.equal(spy.imported.args.destRel, "brainstorming/vendas/attachments");
    assert.ok(spy.toasts.join(" ").includes("→"), "a tela diz para onde foi");
  }).then(() => {
    // a fila continua sendo a porta que COPIA (o original é seu)
    const f = loadRouter({ dest: "fila" });
    return f.run({ paths: ["/Users/x/Desktop/a.pdf"], position: { x: 1, y: 1 } }).then(() => {
      assert.equal(f.spy.imported.cmd, "brain_import_paths");
    });
  });
});

// A unidade do `position` do Tauri não é a mesma nos três sistemas: dividir
// sempre pelo devicePixelRatio punha o ponto na metade da tela num Retina, e
// nunca dividir errava no Windows em 150%.
test("o ponto do evento chega em px de CSS em cada sistema", () => {
  const pt = loadPure("dropPointCss");

  // Windows: ScreenToClient devolve px de DISPOSITIVO
  assert.deepEqual(pt({ x: 300, y: 200 }, 1.5, "windows"), { x: 200, y: 400 / 3 });
  // macOS: draggingLocation é em PONTOS — já é px de CSS
  assert.deepEqual(pt({ x: 300, y: 200 }, 2, "macos"), { x: 300, y: 200 });
  // Linux (GTK): também lógico
  assert.deepEqual(pt({ x: 300, y: 200 }, 2, "linux"), { x: 300, y: 200 });
  // sem posição no payload o ponto é a origem, não NaN
  assert.deepEqual(pt(undefined, 2, "windows"), { x: 0, y: 0 });
  assert.deepEqual(pt({ x: 10, y: 10 }, 0, "windows"), { x: 10, y: 10 }, "ratio 0 não divide por zero");

  assert.match(fnSource("dropDestinationAt"), /dropPointCss\(\s*pos,\s*window\.devicePixelRatio,\s*hostOs\s*\)/,
    "quem consulta o DOM usa a conversão única, com o sistema real");
});

// ---------------------------------------------------------------- as aspas
test("um caminho com espaço sobrevive ao SHELL do terminal", () => {
  const q = loadPure("quoteDropPathShell");

  assert.equal(q("/Users/x/nota.md", "macos"), "/Users/x/nota.md", "o caminho simples não ganha enfeite");
  assert.equal(q("/Users/x/duas palavras.md", "macos"), "'/Users/x/duas palavras.md'");
  // zsh/bash: aspas simples são literais, e a embutida se fecha e reabre
  assert.equal(q("/Users/x/Daniel's.md", "macos"), "'/Users/x/Daniel'\\''s.md'");
  assert.equal(q("/Users/x/$HOME.md", "macos"), "'/Users/x/$HOME.md'", "o $ não pode expandir");
  // cmd.exe (COMSPEC, term_open) não entende aspas simples
  assert.equal(q("C:\\Users\\x\\duas palavras.md", "windows"), '"C:\\Users\\x\\duas palavras.md"');
  assert.match(q("C:\\Users\\x\\nota.md", "windows"), /^"/, "o \\ do Windows sempre pede aspas");
});

test("no composer o caminho é PROMPT, não linha de comando", () => {
  const q = loadPure("quoteDropPathPrompt");

  assert.equal(q("/Users/x/nota.md"), "/Users/x/nota.md");
  assert.equal(q("/Users/x/duas palavras.md"), '"/Users/x/duas palavras.md"');
  assert.equal(q("/Users/x/$HOME.md"), "/Users/x/$HOME.md",
    "o texto do prompt não passa por shell: aspas por metacaractere só sujariam");
  assert.equal(q('/Users/x/a"b.md'), '/Users/x/a"b.md',
    "sem espaço não há o que desambiguar — nem a aspa do nome");
  assert.equal(q('/Users/x/a b"c.md'), '"/Users/x/a b\\"c.md"',
    "quando as aspas entram, a embutida é escapada, nunca apagada");
});

test("vários arquivos viram uma linha, cada um com a regra do seu destino", () => {
  const text = new Function(
    "const t = (s) => s;\n" +
    fnSource("quoteDropPathShell") + "\n" +
    fnSource("quoteDropPathPrompt") + "\n" +
    "return (" + fnSource("dropPathsText") + ");"
  )();

  assert.equal(text(["/a/um.md", "/a/dois tres.md"], "chat", "macos"), '/a/um.md "/a/dois tres.md"');
  assert.equal(text(["/a/um.md", "/a/dois tres.md"], "terminal", "macos"), "/a/um.md '/a/dois tres.md'");
  assert.equal(text([], "chat", "macos"), "");
});

// ---------------------------------------------------------------- o roteamento
test("soltar no chat cola o caminho e NÃO importa nada para o acervo", async () => {
  const { run, spy } = loadRouter({ dest: "chat" });
  assert.equal(await run({ paths: ["/a/um.md", "/a/dois tres.md"] }), "chat");
  assert.equal(spy.chat, '/a/um.md "/a/dois tres.md"');
  assert.equal(spy.imported, null, "nada de brain_import_paths: a porta da fila é de mão única");
  assert.equal(spy.term, null);
});

test("soltar no terminal digita o caminho com as aspas do shell", async () => {
  const { run, spy } = loadRouter({ dest: "terminal", hostOs: "macos" });
  assert.equal(await run({ paths: ["/a/dois tres.md"] }), "terminal");
  assert.equal(spy.term, "'/a/dois tres.md'");
  assert.equal(spy.imported, null);
  assert.equal(spy.chat, null);
});

test("fora das duas superfícies a fila continua igual — inclusive o guard do _prompt.md", async () => {
  let r = loadRouter({ dest: "fila" });
  assert.equal(await r.run({ paths: ["/a/um.md"] }), "fila");
  assert.deepEqual(r.spy.imported, { cmd: "brain_import_paths", args: { paths: ["/a/um.md"], context: null } });
  assert.equal(r.spy.chat, null);

  // ADR-0024 · o guia do loop não é um item, e a recusa é dita
  r = loadRouter({ dest: "fila" });
  await r.run({ paths: ["/a/um.md", "/a/_prompt.md"] });
  assert.deepEqual(r.spy.imported.args.paths, ["/a/um.md"], "o guia não entra");
  assert.match(r.spy.toasts.join(" | "), /_prompt\.md/, "e a recusa aparece");

  // fora da aba do acervo não há fila para receber
  r = loadRouter({ dest: "fila", brainTab: false });
  await r.run({ paths: ["/a/um.md"] });
  assert.equal(r.spy.imported, null);
});

test("um solto sem arquivos apaga o realce e não faz mais nada", async () => {
  const { run, spy } = loadRouter({ dest: "chat" });
  await run({ paths: [] });
  assert.deepEqual(spy.marks, [null], "o realce é apagado sempre, mesmo no solto vazio");
  assert.equal(spy.chat, null);
  assert.equal(spy.imported, null);
});

test("soltar no terminal digita o caminho e NUNCA executa", () => {
  const src = fnSource("dropIntoTerminal");
  assert.match(src, /term_input/);
  assert.doesNotMatch(src, /\\n/, "sem newline: soltar um arquivo não dispara comando");
  // depois de term-exit o PTY não existe mais e o invoke sumiria em silêncio
  assert.match(src, /termReady/, "terminal fechado: a recusa é dita, não engolida");
  assert.ok(EN["o terminal não está rodando — use “reiniciar”"], "a recusa tem par em inglês");
});

test("a cola cai no cursor, sem grudar no que já estava escrito", () => {
  // sem DOM: o teste monta o textarea de mentira que a função vai achar em $()
  // e a chama de verdade
  const run = new Function(
    "text", "node",
    "const t = (s) => s;\n" +
    "const $ = () => node;\n" +
    "class Event { constructor(n) { this.type = n; } }\n" +
    "return (" + fnSource("insertIntoChatInput") + ")(text);"
  );
  const fake = (value, at) => ({
    value, selectionStart: at, selectionEnd: at,
    focus() {}, setSelectionRange(a) { this.selectionStart = this.selectionEnd = a; },
    dispatchEvent(e) { this.fired = e.type; },
  });

  let node = fake("", 0);
  assert.equal(run("/a/um.md", node), true);
  assert.equal(node.value, "/a/um.md ", "termina com espaço: dá para continuar escrevendo");

  node = fake("resuma", 6);
  run("/a/um.md", node);
  assert.equal(node.value, "resuma /a/um.md ", "o espaço à esquerda entra quando falta");

  node = fake("resuma ", 7);
  run("/a/um.md", node);
  assert.equal(node.value, "resuma /a/um.md ", "e NÃO entra quando já existe");

  node = fake("antes depois", 6);
  run("/a/um.md", node);
  assert.equal(node.value, "antes /a/um.md depois", "a cola cai no cursor, não no fim");
  assert.equal(node.selectionStart, "antes /a/um.md ".length, "o cursor fica depois da cola");

  assert.equal(node.fired, "input", "o composer é avisado para crescer com o texto");
  assert.equal(run("/a/um.md", null), false, "sem composer, a cola falha sem explodir");
});

// ---------------------------------------------------------------- o realce
test("o realce acende na superfície que VAI receber, e só nela", () => {
  const src = fnSource("paintDropTarget");
  assert.match(src, /"dropping",\s*dest === "fila" && brainTab/,
    "o realce da fila não pode acender com o ponteiro sobre o chat");
  assert.match(src, /droptarget/);
  // as duas superfícies novas são o MESMO mapa que o roteador nomeia: um destino
  // sem realce (ou um realce sem destino) é o estado mentindo
  const marks = APP.match(/const DROP_MARKS = \{[^}]*\}/);
  assert.ok(marks, "app.js deve definir DROP_MARKS");
  assert.match(marks[0], /chat:\s*"panelChat"/);
  assert.match(marks[0], /terminal:\s*"termPanel"/);
  const dest = loadPure("dropDestination");
  const named = new Set(marks[0].match(/(\w+):/g).map((s) => s.slice(0, -1)));
  for (const sel of ["#panelChat", "#termPanel"]) {
    assert.ok(named.has(dest({ closest: (s) => (s === sel ? {} : null) })),
      `${sel} é destino do roteador mas não tem realce`);
  }

  for (const ev of ["drag-enter", "drag-over"]) {
    const m = APP.match(new RegExp('listen\\("tauri://' + ev + '"[\\s\\S]{0,220}'));
    assert.ok(m, `falta o listener de ${ev}`);
    assert.match(m[0], /paintDropTarget\(dropDestinationAt\(/,
      `${ev} tem de repintar pelo destino — o realce segue o ponteiro`);
  }
  const leave = APP.match(/listen\("tauri:\/\/drag-leave"[\s\S]{0,120}/);
  assert.match(leave[0], /paintDropTarget\(null\)/, "sair da janela apaga tudo");
  assert.match(fnSource("handleSystemDrop"), /paintDropTarget\(null\)/, "e soltar também");
  // o listener não pode voltar a ter lógica própria: o roteador é o único dono
  const wire = APP.match(/listen\("tauri:\/\/drag-drop"[\s\S]{0,120}/);
  assert.match(wire[0], /handleSystemDrop\(e && e\.payload\)/);

  assert.match(CSS, /#panelChat\.droptarget[^{]*\{[^}]*outline:/,
    "o chat realçado tem contorno próprio na folha de estilo");
  assert.match(CSS, /#termPanel\.droptarget[^{]*\{[^}]*outline:/);
});
