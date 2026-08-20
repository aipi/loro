// ADR-0031 R5a, contract §1/§8.C/§9.C — the extension surface renderer.
//
// One seam only, and that is the point of the module: `src/extview.js` is PURE,
// so it runs for real here with a literal facts object and there is nothing to
// stub. What cannot be pure (geometry) is not asserted here at all — there is
// no DOM under `node --test`, so `tools/smoke-ui.js` owns that half.
//
// What these tests exist to prevent, one line each:
//   · a third party's JSON reaching innerHTML unescaped
//   · a raw measurement (a hex, a pixel, a locator) crossing the token wall,
//     which is the moment one of the two themes stops working
//   · an unknown primitive dropped in silence, so the surface lies by omission
//   · a component that expands into itself becoming a hang instead of a refusal
//   · a pt-BR literal parked in a module neither msgid scanner reads
//
// Test titles are pt-BR because contract §9.C froze them; comments are English
// per CLAUDE.md §6.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const EXTVIEW_PATH = path.join(SRC, "extview.js");
const EXTVIEW_SRC = fs.readFileSync(EXTVIEW_PATH, "utf8");
const XV = require("../src/extview.js");
const TEXT = require("../src/text.js");

// ---------------------------------------------------------------- helpers
// Copied per suite, the model being desktop/tests/plugins.test.js:25-46.
function countOf(html, needle) {
  return html.split(needle).length - 1;
}
function classTokens(html) {
  const out = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}
function ctxOf(extra) {
  return Object.assign({
    lang: "pt",
    facts: FACTS,
    icons: { context: "M1 1z", folder: "M2 2z" },
    strings: {
      attribution: "ATRIB",
      more: "e mais %1",
      refused: "RECUSADA",
      empty: "VAZIO",
    },
    extId: "hotspots-board",
  }, extra || {});
}

// The facts shape is contract §2.1's, derived from the measured GraphNode
// (acervo.rs:2798-2835). A hotspot row's `title` is the NODE's title: measured,
// `struct DocHotspot { id: String }` has one field (acervo.rs:2401), so a
// hotspot has no title of its own and this fixture must not invent one.
const FACTS = {
  "acervo.hotspots": {
    count: 4,
    rows: [
      { id: "assinatura#cancelamento-cdc", hotspot: "cancelamento-cdc", context: "assinatura", rel: "contexts/assinatura/context.md", title: "assinatura" },
      { id: "assinatura#H-2", hotspot: "H-2", context: "assinatura", rel: "contexts/assinatura/context.md", title: "assinatura" },
      { id: "frota#pneu-liso", hotspot: "pneu-liso", context: "frota", rel: "contexts/frota/context.md", title: "frota" },
      { id: "frota#H-7", hotspot: "H-7", context: "frota", rel: "contexts/frota/context.md", title: "frota" },
    ],
  },
  "acervo.contexts": {
    count: 3,
    rows: [
      { context: "assinatura", rel: "contexts/assinatura/context.md", title: "assinatura", hotspots: 2, decisions: 2, inlinks: 2, outlinks: 1 },
      { context: "frota", rel: "contexts/frota/context.md", title: "frota", hotspots: 2, decisions: 0, inlinks: 0, outlinks: 0 },
      // Zero hotspots on purpose: the `where` of contract §1.7 must leave this
      // context OUT, because a board with an empty column lies about the acervo.
      { context: "sem-pontos", rel: "contexts/sem-pontos/context.md", title: "sem-pontos", hotspots: 0, decisions: 1, inlinks: 0, outlinks: 0 },
    ],
  },
  "acervo.orphans": { count: 1, rows: [{ rel: "contexts/frota/rastreamento/context.md", context: "frota/rastreamento" }] },
  "acervo.broken": { count: 1, rows: [{ from: "contexts/a/context.md", target: "../inexistente/context.md" }] },
};

// The LITERAL document of contract §1.7 — the acceptance test for the whole
// primitive set. It is pasted, not built, so a contract hole shows up as a
// failure here instead of being worked around in a fixture.
const KANBAN = {
  loroView: 1,
  components: {
    card: {
      params: ["title", "meta", "rel"],
      body: { kind: "stack", gap: 4, pad: 8, children: [
        { kind: "text", text: { $: "param.title" }, size: "body", wrap: true },
        { kind: "badge", text: { $: "param.meta" }, tone: "muted" },
        { kind: "link", label: { pt: "abrir o tema", en: "open the topic" }, rel: { $: "param.rel" } },
      ] },
    },
    column: {
      params: ["ctxname"],
      body: { kind: "stack", gap: 6, pad: 6, children: [
        { kind: "row", gap: 6, align: "between", children: [
          { kind: "text", text: { $: "param.ctxname" }, size: "label", tone: "ink3" },
          { kind: "icon", name: "context", tone: "ink3" },
        ] },
        { kind: "divider" },
        { kind: "scroll", max: "lg", children: [
          { kind: "each", of: "acervo.hotspots", as: "hs",
            where: { context: { eq: { $: "col.context" } } },
            body: { kind: "use", component: "card",
              args: { title: { $: "hs.hotspot" }, meta: { $: "hs.context" }, rel: { $: "hs.rel" } } } },
        ] },
      ] },
    },
  },
  view: [
    { kind: "text", size: "title", text: { pt: "Pontos em aberto por tema", en: "Open points by topic" } },
    { kind: "when", value: { $: "facts.acervo.hotspots.count" }, gt: 0,
      then: [
        { kind: "scroll", axis: "x", max: "lg", children: [
          { kind: "row", gap: 10, children: [
            { kind: "each", of: "acervo.contexts", as: "col",
              where: { hotspots: { gt: 0 } },
              body: { kind: "use", component: "column", args: { ctxname: { $: "col.context" } } } },
          ] },
        ] },
      ],
      else: [
        { kind: "text", tone: "muted", text: { pt: "nenhum ponto em aberto no conhecimento deste projeto", en: "no open points in this project's knowledge" } },
      ] },
  ],
};

function doc(view, components) {
  const d = { loroView: 1, view };
  if (components) d.components = components;
  return d;
}

// ==================== o conjunto de primitivas basta ====================

test("um kanban se expressa só com as primitivas", () => {
  const v = XV.validate(KANBAN);
  assert.deepEqual(v.errors, [], "o documento do contrato §1.7 tem de validar limpo");
  const out = XV.render(KANBAN, ctxOf());
  assert.deepEqual(out.errors, [], "e tem de renderizar sem uma única recusa");

  // um quadro é scroll{x} -> row -> n x (stack -> scroll{y} -> cartões)
  assert.equal(countOf(out.html, "extv-scroll-x"), 1, "um único contêiner que rola na horizontal");
  assert.equal(countOf(out.html, '<div class="extv-scroll'), 3,
    "o de fora mais uma coluna por tema com ponto em aberto");
  assert.equal(countOf(out.html, "extv-row"), 3, "a fileira das colunas e um cabeçalho por coluna");
  assert.equal(countOf(out.html, "extv-div"), 2, "uma régua por coluna");
  // 4 hotspots = 4 cartões, e o contexto sem pontos não vira coluna vazia
  assert.equal(countOf(out.html, "extv-link"), 4);
  assert.ok(!out.html.includes("sem-pontos"), "um tema sem ponto em aberto não é uma coluna vazia");
  // a página nunca rola na horizontal: o único eixo x está dentro de um scroll
  assert.ok(out.html.indexOf("extv-scroll-x") < out.html.indexOf("extv-row"));
});

test("um each aninhado lê a linha de fora", () => {
  const out = XV.render(KANBAN, ctxOf());
  // corta o html por coluna e confere que nenhum cartão caiu no tema errado
  const cols = out.html.split('<div class="extv-stack g-6 p-6 al-start">').slice(1);
  assert.equal(cols.length, 2);
  const assinatura = cols[0], frota = cols[1];
  assert.ok(assinatura.includes("cancelamento-cdc") && assinatura.includes("H-2"));
  assert.ok(!assinatura.includes("pneu-liso") && !assinatura.includes("H-7"),
    "um ref resolvido só na linha de dentro duplicaria os cartões entre as colunas");
  assert.ok(frota.includes("pneu-liso") && frota.includes("H-7"));
  assert.ok(!frota.includes("cancelamento-cdc"));
  // e cada ponto aparece exactamente uma vez no documento inteiro
  for (const h of ["cancelamento-cdc", "H-2", "pneu-liso", "H-7"]) {
    assert.equal(countOf(out.html, ">" + h + "<"), 1, h + " tem de aparecer uma vez");
  }

  // A leitura de fora tem DUAS costuras, e o kanban do contrato só exercita
  // uma: o `where` do each de dentro resolve `col.context` no escopo de FORA, e
  // o CORPO do each de dentro também tem de alcançar a linha de fora. Sem esta
  // segunda metade, trocar o escopo do corpo por um quadro novo por linha passa
  // verde — medido: 4 cartões, zero erros, com a troca aplicada.
  const dois = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.contexts", as: "col", where: { hotspots: { gt: 0 } },
      body: { kind: "each", of: "acervo.hotspots", as: "hs",
        where: { context: { eq: { $: "col.context" } } },
        body: { kind: "row", children: [
          { kind: "badge", text: { $: "col.context" } },
          { kind: "text", text: { $: "hs.hotspot" } },
        ] } } }],
  };
  const par = XV.render(dois, ctxOf());
  assert.deepEqual(par.errors, [], "o corpo de dentro tem de alcançar col E hs");
  assert.equal(countOf(par.html, "extv-row"), 4);
  assert.equal(countOf(par.html, ">assinatura<"), 2, "o tema de fora acompanha cada linha de dentro");
  assert.equal(countOf(par.html, ">frota<"), 2);
  // e o par nunca se cruza
  assert.ok(/>assinatura<\/span><p[^>]*>cancelamento-cdc</.test(par.html), par.html);
  assert.ok(/>frota<\/span><p[^>]*>pneu-liso</.test(par.html), par.html);
});

test("um when sobre uma contagem dá ao quadro um vazio de verdade", () => {
  const zero = { count: 0, rows: [] };
  const out = XV.render(KANBAN, ctxOf({
    facts: Object.assign({}, FACTS, { "acervo.hotspots": zero }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.html.includes("nenhum ponto em aberto"), "o else do autor, não três colunas vazias");
  assert.ok(!out.html.includes("extv-scroll-x"));
  // e o mesmo documento em inglês escolhe a outra metade do par
  const en = XV.render(KANBAN, ctxOf({ lang: "en", facts: Object.assign({}, FACTS, { "acervo.hotspots": zero }) }));
  assert.ok(en.html.includes("no open points in this project"));
  assert.ok(!en.html.includes("nenhum ponto"));
});

// ==================== o que é recusado, e aparece ====================

test("um nó desconhecido é recusado pelo nome e aparece na tela", () => {
  const d = doc([{ kind: "iframe", src: "x" }, { kind: "text", text: { pt: "ok", en: "ok" } }]);
  const v = XV.validate(d);
  assert.ok(v.errors.includes("err.ext_view_node:iframe"), JSON.stringify(v.errors));
  const out = XV.render(d, ctxOf());
  assert.ok(out.errors.includes("err.ext_view_node:iframe"));
  // ADR-0029 §3.7 — recusar em silêncio é uma superfície que mente por omissão
  assert.ok(out.html.includes("extv-err"), "a recusa tem de ser pintada");
  assert.ok(out.html.includes("err.ext_view_node:iframe"), "e tem de dizer QUAL nó");
  assert.ok(out.html.includes("RECUSADA"), "com a cópia que o host passou, nunca uma literal daqui");
  assert.ok(out.html.includes(">ok<"), "e o resto do documento continua desenhado");
});

test("nenhum valor fora da escala é aceito", () => {
  const cases = [
    [{ kind: "text", text: { pt: "a", en: "a" }, tone: "#ff0000" }, "err.ext_view_value:tone"],
    [{ kind: "stack", gap: 7, children: [{ kind: "divider" }] }, "err.ext_view_value:gap"],
    [{ kind: "stack", pad: 3, children: [{ kind: "divider" }] }, "err.ext_view_value:pad"],
    [{ kind: "grid", cols: 9, children: [{ kind: "divider" }] }, "err.ext_view_value:grid.cols"],
    [{ kind: "grid", children: [{ kind: "divider" }] }, "err.ext_view_value:grid.cols"],
    [{ kind: "icon", name: "rocket" }, "err.ext_view_value:icon.name"],
    [{ kind: "text", text: { pt: "a", en: "a" }, size: "huge" }, "err.ext_view_value:size"],
    [{ kind: "text", text: { pt: "a", en: "a" }, family: "Comic Sans" }, "err.ext_view_value:family"],
    [{ kind: "row", align: "middle", children: [{ kind: "divider" }] }, "err.ext_view_value:align"],
    [{ kind: "scroll", max: "xl", children: [{ kind: "divider" }] }, "err.ext_view_value:scroll.max"],
    [{ kind: "spacer", size: 5 }, "err.ext_view_value:spacer.size"],
    [{ kind: "each", of: "acervo.tudo", as: "r", body: { kind: "divider" } }, "err.ext_view_facts:acervo.tudo"],
  ];
  for (const [node, code] of cases) {
    const v = XV.validate(doc([node]));
    assert.ok(v.errors.includes(code), JSON.stringify(node) + " -> " + JSON.stringify(v.errors));
    // e a superfície diz qual: nunca ignorado em silêncio
    const out = XV.render(doc([node]), ctxOf());
    assert.ok(out.errors.includes(code));
  }
});

test("um link só aponta para dentro do acervo — não existe localizador neste contrato", () => {
  const bad = ["https://exemplo.test/x", "//exemplo.test", "javascript:alert(1)",
    "/etc/passwd", "../../fora.md", "contexts/../../fora.md", "mailto:a@b.c"];
  for (const rel of bad) {
    const d = doc([{ kind: "link", label: { pt: "ir", en: "go" }, rel }]);
    assert.ok(XV.validate(d).errors.includes("err.ext_view_value:link.rel"), rel);
    const out = XV.render(d, ctxOf());
    assert.ok(out.html.includes("err.ext_view_value:link.rel"), rel);
    assert.ok(!out.html.includes(rel), rel + " não pode sobrar no html");
  }
  assert.deepEqual(XV.validate(doc([{ kind: "link", label: { pt: "ir", en: "go" }, rel: "contexts/a/context.md" }])).errors, []);
  // um rel vindo de DADO (um Ref) só pode ser julgado quando resolve: o mesmo
  // guarda tem de valer na hora de pintar, não só na validação estática
  const viaRef = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.broken", as: "b",
      body: { kind: "link", label: { pt: "ir", en: "go" }, rel: { $: "b.target" } } }],
  };
  assert.deepEqual(XV.validate(viaRef).errors, [], "estaticamente não há o que julgar");
  const out = XV.render(viaRef, ctxOf());
  assert.ok(out.errors.includes("err.ext_view_value:link.rel"),
    "`../inexistente/context.md` sai dos fatos e tem de ser recusado ao pintar");
});

test("toda string tem o par pt/en", () => {
  const d = doc([{ kind: "text", text: { pt: "só em português" } }]);
  const v = XV.validate(d);
  assert.ok(v.errors.includes("err.ext_i18n_missing:/view/0/text"), JSON.stringify(v.errors));
  assert.ok(XV.validate(doc([{ kind: "text", text: { en: "english only" } }]))
    .errors.includes("err.ext_i18n_missing:/view/0/text"));
  assert.ok(XV.validate(doc([{ kind: "link", label: { pt: "ir" }, rel: "a/context.md" }]))
    .errors.includes("err.ext_i18n_missing:/view/0/label"));
  // o ponteiro nomeia o campo, inclusive dentro de um componente
  const inComp = doc(
    [{ kind: "use", component: "c", args: {} }],
    { c: { params: [], body: { kind: "text", text: { pt: "x" } } } },
  );
  assert.ok(XV.validate(inComp).errors.includes("err.ext_i18n_missing:/components/c/body/text"));
});

test("um ref que não resolve é dito, nunca desenhado como vazio", () => {
  const d = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.hotspots", as: "hs",
      body: { kind: "text", text: { $: "hs.inexistente" } } }],
  };
  const out = XV.render(d, ctxOf());
  assert.ok(out.errors.includes("err.ext_view_ref:hs.inexistente"), JSON.stringify(out.errors));
  assert.ok(out.html.includes("err.ext_view_ref:hs.inexistente"));
  assert.ok(!out.html.includes("undefined"), "nunca `undefined` na tela");
  // e um caminho da cadeia de protótipos não é um caminho
  for (const p of ["hs.constructor", "hs.__proto__", "hs.toString"]) {
    const bad = { loroView: 1, view: [{ kind: "each", of: "acervo.hotspots", as: "hs", body: { kind: "text", text: { $: p } } }] };
    const r = XV.render(bad, ctxOf());
    assert.ok(r.errors.some((e) => e.indexOf("err.ext_view_ref:") === 0), p + " -> " + JSON.stringify(r.errors));
  }
});

test("um id de campo repetido é recusado, e um botão não colide com um campo", () => {
  const dup = doc([
    { kind: "field", id: "nome", field: "string", label: { pt: "nome", en: "name" } },
    { kind: "field", id: "nome", field: "string", label: { pt: "nome", en: "name" } },
  ]);
  assert.ok(XV.validate(dup).errors.includes("err.ext_view_value:field.id"));
  const clash = doc([
    { kind: "field", id: "alvo", field: "string", label: { pt: "alvo", en: "target" } },
    { kind: "button", action: "ir", label: { pt: "ir", en: "go" }, values: ["alvo"], args: { alvo: { pt: "x", en: "x" } } },
  ]);
  assert.ok(XV.validate(clash).errors.includes("err.ext_view_value:button.args"),
    "values e args caem num só objeto no ext_action (contrato §4.3): a colisão é recusada aqui");
});

test("um when tem exatamente um operador", () => {
  const none = doc([{ kind: "when", value: 1, then: [{ kind: "divider" }] }]);
  assert.ok(XV.validate(none).errors.includes("err.ext_view_value:when"));
  const two = doc([{ kind: "when", value: 1, is: 1, gt: 0, then: [{ kind: "divider" }] }]);
  assert.ok(XV.validate(two).errors.includes("err.ext_view_value:when"));
  assert.deepEqual(XV.validate(doc([{ kind: "when", value: 1, is: 1, then: [{ kind: "divider" }] }])).errors, []);
});

test("uma versão que não é 1 é recusada e nada é pintado", () => {
  const out = XV.render({ loroView: 2, view: [{ kind: "text", text: { pt: "a", en: "a" } }] }, ctxOf());
  assert.deepEqual(out.errors, ["err.ext_view_version:2"]);
  assert.ok(out.html.includes("err.ext_view_version:2"));
  assert.ok(!out.html.includes(">a<"), "um documento de outra versão não é meio desenhado");
  assert.deepEqual(XV.render({ loroView: 1, view: [] }, ctxOf()).errors, ["err.ext_view_empty"]);
  assert.deepEqual(XV.render({ loroView: 1 }, ctxOf()).errors, ["err.ext_view_empty"]);
});

// ==================== os tetos: uma recusa, nunca um travamento ====================

test("um componente que se expande em si mesmo para no teto", () => {
  const d = doc(
    [{ kind: "use", component: "eu", args: {} }],
    { eu: { params: [], body: { kind: "use", component: "eu", args: {} } } },
  );
  // se isto travar, o teste não falha: ele pendura — que é exactamente o
  // travamento que o teto existe para impedir (CLAUDE.md §7.1 regra 2: tire o
  // teto de expandNode e veja).
  const ex = XV.expand(d);
  assert.ok(ex.errors.includes("err.ext_view_depth:" + XV.MAX_DEPTH), JSON.stringify(ex.errors));
  assert.equal(XV.MAX_DEPTH, 8);
  const out = XV.render(d, ctxOf());
  assert.ok(out.errors.includes("err.ext_view_depth:8"));
  assert.ok(out.html.includes("err.ext_view_depth:8"), "e a tela diz por que parou");
  // mútua, não só direta
  const mutual = doc([{ kind: "use", component: "a", args: {} }], {
    a: { params: [], body: { kind: "use", component: "b", args: {} } },
    b: { params: [], body: { kind: "use", component: "a", args: {} } },
  });
  assert.ok(XV.render(mutual, ctxOf()).errors.includes("err.ext_view_depth:8"));
});

test("um documento gigante para no teto de nós", () => {
  const kids = [];
  for (let i = 0; i < 64; i++) {
    const inner = [];
    for (let j = 0; j < 64; j++) inner.push({ kind: "text", text: { pt: "x", en: "x" } });
    kids.push({ kind: "stack", children: inner });
  }
  const d = doc(kids);
  const out = XV.render(d, ctxOf());
  const hit = out.errors.filter((e) => e.indexOf("err.ext_view_size:") === 0);
  assert.equal(hit.length, 1, JSON.stringify(out.errors));
  assert.ok(Number(hit[0].split(":")[1]) > XV.MAX_NODES, hit[0]);
  assert.equal(XV.MAX_NODES, 2000);
  assert.ok(out.html.length < 400000, "e o html para de crescer com a expansão");
});

test("o resto além do teto é contado, nunca cortado em silêncio", () => {
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ id: "c#h" + i, hotspot: "h" + i, context: "c", rel: "contexts/c/context.md", title: "c" });
  }
  const d = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.hotspots", as: "hs", body: { kind: "badge", text: { $: "hs.hotspot" } } }],
  };
  const out = XV.render(d, ctxOf({ facts: { "acervo.hotspots": { count: 250, rows } } }));
  assert.deepEqual(out.errors, []);
  assert.equal(countOf(out.html, "badge"), XV.EACH_CAP, "200 é o teto padrão do each");
  assert.equal(countOf(out.html, "extv-more"), 1, "e o resto é uma linha, não um fim de linha");
  assert.ok(out.html.includes("e mais 50"), "com a contagem real, do molde que o host passou");
  // um cap explícito é respeitado do mesmo jeito
  const capped = { loroView: 1, view: [Object.assign({}, d.view[0], { cap: 10 })] };
  const out2 = XV.render(capped, ctxOf({ facts: { "acervo.hotspots": { count: 250, rows } } }));
  assert.equal(countOf(out2.html, "badge"), 10);
  assert.ok(out2.html.includes("e mais 240"));
});

// ==================== o escape, e o que ele compra ====================

test("o escape é o mesmo do app", () => {
  const fixtures = [
    "& < > \" '",
    "&amp;&lt;",
    'contexts/pasta com "aspas"/context.md',
    "<img onerror=1>",
    "'; drop --",
    "",
    "sem nada de especial",
  ];
  for (const s of fixtures) {
    assert.equal(XV.esc(s), TEXT.esc(s), "os dois escapes têm de bater caractere a caractere: " + s);
  }
  // AS CINCO, não três (text.js:8-16): escapar três quebra um atributo e o
  // cartão vira um controle que não faz nada.
  assert.equal(XV.esc("& < > \" '"), "&amp; &lt; &gt; &quot; &#39;");
  const fn = EXTVIEW_SRC.match(/function esc\(s\)[\s\S]*?\n {2}\}/);
  assert.ok(fn, "extview.js tem de definir o seu próprio esc()");
  for (const c of ["&amp;", "&lt;", "&gt;", "&quot;", "&#39;"]) {
    assert.ok(fn[0].includes(c), "falta " + c + " no escape");
  }
});

test("texto malicioso da extensão sai escapado", () => {
  const rows = [{
    id: 'x#"><img onerror=alert(1)>',
    hotspot: '"><img onerror=alert(1)>',
    context: "<script>alert(1)</script>",
    rel: 'contexts/pasta com "aspas"/context.md',
    title: "x",
  }];
  const d = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.hotspots", as: "hs", body: { kind: "stack", children: [
      { kind: "text", text: { $: "hs.hotspot" }, wrap: false },
      { kind: "badge", text: { $: "hs.context" } },
      { kind: "button", action: "abrir", label: { pt: "abrir", en: "open" }, args: { alvo: { $: "hs.hotspot" } } },
    ] } }],
  };
  const out = XV.render(d, ctxOf({ facts: { "acervo.hotspots": { count: 1, rows } } }));
  assert.deepEqual(out.errors, []);
  assert.ok(!out.html.includes("<img"), "nem no texto");
  assert.ok(!out.html.includes("<script"), "nem no badge");
  // o payload continua legível como TEXTO — e é isso que escapar significa. O
  // que não pode existir é a forma executável: uma aspa que fecha o atributo
  // seguida de uma tag (o defeito medido em text.js:8-16).
  assert.ok(!out.html.includes('"><img'), "nenhuma aspa fecha um atributo para abrir uma tag");
  assert.ok(!/<[a-z]+ [a-z-]+=[^"]/.test(out.html), "nenhum atributo sem aspas");
  assert.ok(out.html.includes("&lt;img") && out.html.includes("&quot;"));
  // um rel com aspas (legal no macOS/Linux) não pode truncar o atributo
  const link = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.hotspots", as: "hs",
      body: { kind: "link", label: { pt: "ir", en: "go" }, rel: { $: "hs.rel" } } }],
  };
  // uma pasta COM espaço e COM aspa é legal no macOS/Linux, então o caminho é
  // aceito — e a aspa vira &quot;, que é exactamente a correção medida em
  // text.js:8-16. Recusar o caminho seria recusar um documento que a pessoa tem.
  const out2 = XV.render(link, ctxOf({ facts: { "acervo.hotspots": { count: 1, rows } } }));
  assert.deepEqual(out2.errors, []);
  assert.ok(out2.html.includes('data-extv-rel="contexts/pasta com &quot;aspas&quot;/context.md"'),
    "o atributo continua fechando onde devia");
  assert.ok(!out2.html.includes('rel="contexts/pasta com "'), "e não é truncado na aspa");
});

test("o renderizador não emite style, tabindex nem localizador", () => {
  // a ausência de uma API é a garantia, e a ausência só é garantia enquanto
  // alguém confere: o CSP do app é carga estrutural e a ordem de foco é do app.
  for (const proibido of ["style=", "tabindex", "srcdoc", "iframe", "innerHTML"]) {
    assert.ok(!EXTVIEW_SRC.includes(proibido),
      "extview.js não pode conter “" + proibido + "”");
  }
  assert.ok(!/[áàâãéêíóôõúüçÁÂÃÉÊÍÓÔÕÚÇ]/.test(EXTVIEW_SRC),
    "nenhuma literal em pt-BR: ela escaparia aos dois varredores de msgid");
  assert.ok(!/(^|[^\w$.])t\(/.test(EXTVIEW_SRC),
    "nenhuma chamada a t(): toda frase visível chega por ctx.strings");
  // e a saída também não
  const out = XV.render(KANBAN, ctxOf());
  for (const proibido of ["style=", "tabindex", "src=", "://"]) {
    assert.ok(!out.html.includes(proibido), "a saída não pode conter “" + proibido + "”");
  }
  assert.ok(!out.html.includes("<img"));
});

// ==================== reúso, teclado, e o estado que não mente ====================

test("um botão é o botão do app e um badge é mono", () => {
  const d = doc([
    { kind: "button", action: "criar", label: { pt: "criar", en: "create" }, primary: true },
    { kind: "button", action: "ver", label: { pt: "ver", en: "view" } },
    { kind: "button", action: "nada", label: { pt: "nada", en: "none" }, disabled: true },
    { kind: "badge", text: { pt: "novo", en: "new" }, tone: "green" },
  ]);
  const out = XV.render(d, ctxOf());
  assert.deepEqual(out.errors, []);
  // DESIGN §5 — a mesma ação não pode ter duas aparências, e o badge tem o piso
  // mono/11px que tests/tokens.test.js:1215 fixa
  assert.ok(out.html.includes('<button class="btn solid"'));
  assert.ok(out.html.includes('<button class="btn"'));
  assert.ok(out.html.includes('class="mono badge tn-green"'));
  assert.ok(!out.html.includes("extv-btn") && !out.html.includes("extv-badge"),
    "nenhuma classe inventada para algo que o app já desenha");
  // um controle desabilitado diz que está desabilitado, não parece ligado
  assert.equal(countOf(out.html, " disabled>"), 1);
  assert.ok(out.html.includes('data-extv-action="criar"'));
});

// DESIGN §1 e §2 regra 4 — UMA ação primária por tela, um único botão cheio.
// VERMELHO PRIMEIRO, medido no DOM real com o renderizador de verdade: dois
// `primary: true` saíam como dois `button.btn.solid` e `errors: []` — a tela
// afirmando que as duas eram A ação, sem uma recusa.
test("só existe uma ação primária, e a segunda é recusada pelo nome", () => {
  const d = doc([
    { kind: "button", action: "um", label: { pt: "um", en: "one" }, primary: true },
    { kind: "button", action: "dois", label: { pt: "dois", en: "two" }, primary: true },
    { kind: "button", action: "tres", label: { pt: "tres", en: "three" }, primary: true },
  ]);
  const out = XV.render(d, ctxOf());
  assert.equal(countOf(out.html, 'class="btn solid"'), 1, "um único botão cheio");
  assert.equal(countOf(out.html, 'class="btn"'), 2, "as outras viram botões comuns");
  assert.deepEqual(out.errors, ["err.ext_view_value:button.primary"],
    "a recusa é pelo nome e aparece na tela: nada é descartado em silêncio");
  // e o mesmo componente usado duas vezes conta duas vezes: a contagem é da
  // PINTURA, porque é ela que produz os botões
  const comp = {
    loroView: 1,
    components: { acao: { params: [], body: { kind: "button", action: "x", label: { pt: "x", en: "x" }, primary: true } } },
    view: [{ kind: "use", component: "acao", args: {} }, { kind: "use", component: "acao", args: {} }],
  };
  const out2 = XV.render(comp, ctxOf());
  assert.equal(countOf(out2.html, 'class="btn solid"'), 1);
  assert.ok(out2.errors.includes("err.ext_view_value:button.primary"));
  // duas renderizações do mesmo documento continuam dando os mesmos bytes
  assert.equal(XV.render(comp, ctxOf()).html, out2.html);
});

test("toda primitiva interativa é alcançável pelo teclado", () => {
  const d = doc([
    { kind: "field", id: "nome", field: "string", label: { pt: "nome", en: "name" }, placeholder: { pt: "ex.", en: "e.g." }, hint: { pt: "dica", en: "hint" } },
    { kind: "field", id: "qtd", field: "number", label: { pt: "quantos", en: "how many" }, value: 3 },
    { kind: "field", id: "liga", field: "bool", label: { pt: "ligado", en: "on" }, value: true },
    { kind: "field", id: "col", field: "enum", label: { pt: "coleção", en: "collection" }, value: "b",
      options: [{ value: "a", label: { pt: "um", en: "one" } }, { value: "b", label: { pt: "dois", en: "two" } }] },
    { kind: "button", action: "enviar", label: { pt: "enviar", en: "send" }, values: ["nome", "qtd"], confirm: { pt: "tem certeza?", en: "sure?" } },
    { kind: "link", label: { pt: "abrir", en: "open" }, rel: "contexts/a/context.md" },
  ]);
  const out = XV.render(d, ctxOf());
  assert.deepEqual(out.errors, []);
  // elementos reais, em ordem de DOM, sem uma única ordem de foco escrita pelo
  // autor: uma composição inalcançável pelo teclado não pode ser composta
  assert.equal(countOf(out.html, "<input "), 3);
  assert.equal(countOf(out.html, "<select "), 1);
  assert.equal(countOf(out.html, "<button "), 1);
  assert.equal(countOf(out.html, "<a class=\"extv-link\""), 1);
  assert.ok(!out.html.includes("tabindex"));
  // cada rótulo aponta para o seu próprio controle
  const fors = [...out.html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(fors.length, 4);
  assert.equal(new Set(fors).size, 4, "quatro ids distintos, ou um rótulo aponta para o campo do vizinho");
  for (const id of fors) assert.ok(out.html.includes('id="' + id + '"'), id);
  // a dica é anunciada, não só desenhada
  assert.ok(out.html.includes("aria-describedby="));
  // o valor selecionado é o que o documento diz
  assert.ok(out.html.includes('<option value="b" selected>'));
  assert.ok(out.html.includes(' checked>'));
  assert.ok(out.html.includes('value="3"'));
  // o que o clique vai fazer está dito antes do clique
  assert.ok(out.html.includes('data-extv-confirm="tem certeza?"'));
  assert.ok(out.html.includes('data-extv-values="nome,qtd"'));
});

test("um campo dentro de um each não repete o id do vizinho", () => {
  const d = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.contexts", as: "c",
      body: { kind: "field", id: "nota", field: "string", label: { pt: "nota", en: "note" } } }],
  };
  const out = XV.render(d, ctxOf());
  const ids = [...out.html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "três linhas, três ids — um id repetido é um rótulo que aponta para o campo errado");
  assert.equal(countOf(out.html, 'data-extv-field="nota"'), 3, "o id LÓGICO continua o mesmo para o ext_action");
});

test("o vermelho nunca é o padrão", () => {
  // neste app vermelho significa gravando-e-irreversível (docs/DESIGN.md, tabela
  // dos loops): ele só aparece onde o autor pediu.
  const semTom = XV.render(KANBAN, ctxOf());
  assert.ok(!semTom.html.includes("tn-red"));
  const kitchen = doc([
    { kind: "text", text: { pt: "a", en: "a" } },
    { kind: "badge", text: { pt: "b", en: "b" } },
    { kind: "icon", name: "folder" },
  ]);
  const out = XV.render(kitchen, ctxOf());
  assert.ok(!out.html.includes("tn-red"));
  assert.ok(out.html.includes('class="mono badge tn-muted"'), "o badge cai em muted, nunca em vermelho");
  assert.ok(/<p class="extv-text sz-body">/.test(out.html), "e um texto sem tom não recebe tom nenhum");
  const pedido = XV.render(doc([{ kind: "text", text: { pt: "a", en: "a" }, tone: "red" }]), ctxOf());
  assert.ok(pedido.html.includes("tn-red"), "e aparece quando é pedido");
});

test("uma afirmação da extensão é atribuída à extensão", () => {
  const out = XV.render(KANBAN, ctxOf());
  // DESIGN §1 — o estado nunca mente: o primeiro filho do contêiner diz de
  // quem é a afirmação, então nada abaixo lê como afirmação do Loro.
  const i = out.html.indexOf('<p class="extv-attr">');
  assert.ok(i > 0, "a linha de atribuição tem de existir");
  assert.ok(i < out.html.indexOf("Pontos em aberto"), "e vir ANTES de qualquer conteúdo da extensão");
  assert.ok(out.html.includes(">ATRIB<"));
  assert.ok(out.html.indexOf('class="extv"') < i, "dentro do contêiner .extv");
  // um documento que não pinta nada não pinta um cartão em branco
  const vazio = {
    loroView: 1,
    view: [{ kind: "each", of: "acervo.hotspots", as: "hs", body: { kind: "badge", text: { $: "hs.hotspot" } } }],
  };
  const out2 = XV.render(vazio, ctxOf({ facts: { "acervo.hotspots": { count: 0, rows: [] } } }));
  assert.ok(out2.html.includes(">VAZIO<"), "a frase de vazio vem do host, e o cartão nunca fica em branco");
});

test("todo valor sai como classe de papel, e só as classes congeladas existem", () => {
  const kitchen = doc([
    { kind: "grid", cols: 3, gap: 14, pad: 12, align: "center", children: [
      { kind: "text", text: { pt: "t", en: "t" }, size: "title", tone: "accent" },
      { kind: "text", text: { pt: "m", en: "m" }, size: "meta", tone: "teal", family: "mono" },
      { kind: "text", text: { pt: "l", en: "l" }, size: "label", tone: "amber", wrap: false },
    ] },
    { kind: "row", wrap: true, gap: 2, pad: 4, align: "end", children: [
      { kind: "badge", text: { pt: "b", en: "b" }, tone: "ink2" },
      { kind: "icon", name: "folder", tone: "ink" },
      { kind: "spacer", size: 10 },
      { kind: "divider" },
    ] },
    { kind: "scroll", axis: "x", max: "sm", gap: 6, pad: 0, align: "between", children: [
      { kind: "stack", gap: 8, children: [{ kind: "doc", md: { pt: "# oi", en: "# hi" } }] },
    ] },
    { kind: "field", id: "f", field: "string", label: { pt: "f", en: "f" } },
    { kind: "button", action: "b", label: { pt: "b", en: "b" } },
    { kind: "link", label: { pt: "l", en: "l" }, rel: "contexts/a/context.md" },
  ]);
  const out = XV.render(kitchen, ctxOf());
  assert.deepEqual(out.errors, []);
  const permitidas = new Set(XV.CLASSES.concat(["mono", "badge", "btn", "solid"]));
  for (const c of classTokens(out.html)) {
    assert.ok(permitidas.has(c), "classe fora da lista congelada: " + c);
  }
  // e nada de medida crua: nem hex, nem px, nem nome de fonte
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(out.html.replace(/&#39;/g, "")), "nenhum hex na saída");
  assert.ok(!/\d+px/.test(out.html), "nenhum pixel na saída");
  // as escalas são as do contrato, medidas na folha
  assert.deepEqual(XV.STEPS, [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.deepEqual(XV.TONES, ["ink", "ink2", "ink3", "muted", "teal", "amber", "red", "green", "accent"]);
  assert.deepEqual(XV.SIZES, ["title", "body", "label", "meta"]);
  assert.deepEqual(XV.ALIGNS, ["start", "center", "end", "between"]);
  assert.equal(XV.ICONS_ALLOWED.length, 14);
  // acervo.areas joined in round 2 (2026-08-20): the owner's real acervo has 79
  // contexts, so a column per context measured 12px wide — the AREA is the only
  // grouping that fits a board, and it is derivable (first path segment).
  assert.deepEqual(XV.FACTS, ["acervo.hotspots", "acervo.contexts", "acervo.orphans", "acervo.broken", "acervo.areas"]);
});

test("um ícone só pode ser um dos catorze do app", () => {
  // medido: o mapa ICONS de app.js:2903-2924 tem exactamente estes nomes.
  const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  const bloco = APP.match(/const ICONS = \{[\s\S]*?\n\};/);
  assert.ok(bloco, "app.js tem de definir ICONS");
  const nomes = [...bloco[0].matchAll(/^ {2}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(nomes.slice().sort(), XV.ICONS_ALLOWED.slice().sort(),
    "o alfabeto de ícones do contrato é o mapa do app, não uma lista paralela");
  // e o desenho vem do host: o autor nomeia, nunca desenha
  const out = XV.render(doc([{ kind: "icon", name: "context" }]), ctxOf());
  assert.ok(out.html.includes('<path d="M1 1z"/>'), "o traçado é o que ctx.icons entregou");
  assert.ok(out.html.includes('aria-hidden="true"'), "um ícone nunca é o único portador do sentido");
});

test("um doc é conteúdo: imagem e localizador saem, o resto fica", () => {
  const md = [
    "# título",
    "uma ![figura](https://exemplo.test/a.png) no meio",
    "um [link externo](https://exemplo.test/x) e um [tema](contexts/a/context.md)",
    "fim",
  ].join("\n");
  const limpo = XV.stripDoc(md);
  assert.ok(!limpo.includes("://"), "nenhum localizador sobra na FONTE entregue ao leitor");
  assert.ok(limpo.includes("uma figura no meio"), "a legenda da imagem fica");
  assert.ok(limpo.includes("um link externo e um [tema](contexts/a/context.md)"),
    "o rótulo do externo fica como texto e a referência interna continua uma referência");
  const out = XV.render(doc([{ kind: "doc", md: { pt: md, en: md } }]), ctxOf());
  assert.deepEqual(out.errors, []);
  assert.ok(!out.html.includes("<img") && !out.html.includes("://"));
  // o resto além do cap é contado, nunca cortado em silêncio
  const longo = Array.from({ length: 30 }, (_, i) => "linha " + i).join("\n");
  const out2 = XV.render(doc([{ kind: "doc", md: { pt: longo, en: longo }, cap: 10 }]), ctxOf());
  assert.ok(out2.html.includes("linha 9") && !out2.html.includes("linha 10"));
  assert.ok(out2.html.includes("e mais 20"));
});

// ==================== o módulo é puro ====================

test("o módulo é puro", () => {
  const antes = JSON.stringify(KANBAN);
  const a = XV.render(KANBAN, ctxOf());
  const b = XV.render(KANBAN, ctxOf());
  assert.equal(JSON.stringify(KANBAN), antes, "o documento de entrada não pode ser tocado");
  assert.equal(a.html, b.html, "duas renderizações do mesmo documento dão os mesmos bytes");
  assert.deepEqual(a.errors, b.errors);
  // outra instância do módulo dá o mesmo resultado: nenhum estado sobreviveu
  delete require.cache[require.resolve("../src/extview.js")];
  const XV2 = require("../src/extview.js");
  assert.notStrictEqual(XV2, XV);
  assert.equal(XV2.render(KANBAN, ctxOf()).html, a.html);
  // e nenhum global de DOM foi tocado
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.LoroExtView, "object", "o preâmbulo UMD publica no root, como loops.js:20-23");
});

test("nada trava: um documento hostil sempre volta", () => {
  const hostis = [
    null, undefined, 0, "", [], { loroView: 1, view: [null] },
    { loroView: 1, view: [{ kind: 42 }] },
    { loroView: 1, view: [{ kind: "stack" }] },
    { loroView: 1, view: [{ kind: "stack", children: [] }] },
    { loroView: 1, components: { "NÃO-VALE": { params: [], body: { kind: "divider" } } }, view: [{ kind: "divider" }] },
    { loroView: 1, view: [{ kind: "use", component: "inexistente", args: {} }] },
    { loroView: 1, view: [{ kind: "each", of: "acervo.hotspots", as: "hs", body: { kind: "text", text: { $: "hs" } } }] },
  ];
  for (const d of hostis) {
    const out = XV.render(d, ctxOf());
    assert.equal(typeof out.html, "string", JSON.stringify(d));
    assert.ok(out.html.indexOf('<div class="extv"') === 0, JSON.stringify(d));
    assert.ok(Array.isArray(out.errors));
    if (d && d.loroView === 1) assert.ok(out.errors.length > 0, JSON.stringify(d) + " tem de dizer o que recusou");
  }
  // um ctx incompleto também não derruba nada: o host é quem falhou, não a tela
  assert.equal(typeof XV.render(KANBAN, {}).html, "string");
  assert.equal(typeof XV.render(KANBAN, undefined).html, "string");
});

test("todo código que este módulo levanta está na tabela do contrato §6", () => {
  // um código sem gatilho é cópia que mente, e um gatilho sem código é uma
  // recusa invisível: esta é a lista que o integrador tem de pareaar em
  // desktop/src/i18n.js (ERR_PT + EN), e nada além dela.
  const CONTRATO = new Set([
    "err.ext_view_version", "err.ext_view_empty", "err.ext_view_node", "err.ext_view_value",
    "err.ext_view_ref", "err.ext_view_facts", "err.ext_view_component", "err.ext_view_depth",
    "err.ext_view_size", "err.ext_i18n_missing",
  ]);
  const levantados = new Set();
  for (const m of EXTVIEW_SRC.matchAll(/"(err\.[a-z0-9_]+)/g)) levantados.add(m[1]);
  assert.ok(levantados.size >= 10, [...levantados].join(","));
  for (const c of levantados) {
    assert.ok(CONTRATO.has(c), c + " não está na tabela de erros do contrato §6");
  }
  // e nenhum código reservado que este round não pode levantar
  for (const reservado of ["err.ext_outbound_unattended", "err.ext_audio_network", "err.ext_checksum"]) {
    assert.ok(!EXTVIEW_SRC.includes(reservado), reservado + " não tem gatilho em R5a");
  }
});

// ================= round 2 — the owner's kanban round (2026-08-20) =========
// The defect that opened this round was MEASURED at the owner's real scale
// (79 contexts / 312 hotspots): .extv-scroll-x children kept flex-shrink:1 and
// 79 columns painted at 12px each, text over text. Geometry itself is smoke's
// half; what belongs here is the CONTRACT half: the width role, the surface
// role, the `ask` button, and `settings.*` bindings — each refused by name
// when malformed, each identical for a manifest view and an MCP-served view,
// because both cross this same validate()/render() pair.

test("w é um papel de largura do contrato, nunca uma medida", () => {
  const ok = XV.render({ loroView: 1, view: [
    { kind: "stack", w: "md", children: [{ kind: "text", text: { pt: "a", en: "a" } }] },
    { kind: "scroll", w: "sm", children: [{ kind: "text", text: { pt: "b", en: "b" } }] },
  ] }, ctxOf());
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.html.includes("w-md"), "stack ganha a classe w-md");
  assert.ok(ok.html.includes("w-sm"), "scroll ganha a classe w-sm");
  // a measurement is not a role: refused by name, painted, never dropped
  const bad = XV.render({ loroView: 1, view: [
    { kind: "stack", w: "248px", children: [{ kind: "text", text: { pt: "a", en: "a" } }] },
  ] }, ctxOf());
  assert.ok(bad.errors.includes("err.ext_view_value:w"), String(bad.errors));
  assert.ok(!bad.html.includes("248px"), "a medida crua não atravessa");
  // the role classes are in the frozen list, so the sheet can define them
  for (const c of ["w-xs", "w-sm", "w-md", "w-lg"]) {
    assert.ok(XV.CLASSES.includes(c), "classe congelada faltando: " + c);
  }
});

test("surface é um papel booleano do stack — um cartão sem cor própria", () => {
  const ok = XV.render({ loroView: 1, view: [
    { kind: "stack", surface: true, children: [{ kind: "text", text: { pt: "a", en: "a" } }] },
  ] }, ctxOf());
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.html.includes("extv-surface"));
  assert.ok(XV.CLASSES.includes("extv-surface"));
  const bad = XV.render({ loroView: 1, view: [
    { kind: "stack", surface: "sim", children: [{ kind: "text", text: { pt: "a", en: "a" } }] },
  ] }, ctxOf());
  assert.ok(bad.errors.includes("err.ext_view_value:surface"), String(bad.errors));
});

test("ask: o botão abre a porta do chat e ela é do usuário, nunca da extensão", () => {
  // resolved in the ROW's scope, like button.args: the ask carries the card it
  // sits on, and the person still types and confirms before anything runs.
  const doc = { loroView: 1, view: [
    { kind: "each", of: "acervo.hotspots", as: "hs",
      body: { kind: "button", ask: { skill: "loro-kanban-ask", target: { $: "hs.id" },
        hint: { pt: "a resposta chega no chat", en: "the answer lands in the chat" } },
        label: { pt: "perguntar", en: "ask" } } },
  ] };
  const out = XV.render(doc, ctxOf());
  assert.deepEqual(out.errors, []);
  assert.ok(out.html.includes('data-extv-ask="loro-kanban-ask"'));
  assert.ok(out.html.includes('data-extv-ask-target="assinatura#cancelamento-cdc"'));
  assert.ok(!out.html.includes("data-extv-action"), "ask não é action");
});

test("ask e action são exclusivos, e o nome da habilidade é um slug estrito", () => {
  const both = XV.render({ loroView: 1, view: [
    { kind: "button", action: "x", ask: { skill: "loro-kanban-ask" }, label: { pt: "b", en: "b" } },
  ] }, ctxOf());
  assert.ok(both.errors.includes("err.ext_view_value:button.ask"), String(both.errors));
  // an uppercase, a dot, a space, a slash: each is refused by name — the slug
  // becomes half of a chat line, so the alphabet is the guard
  for (const skill of ["Bash", "loro.kanban", "a b", "x/y", ""]) {
    const bad = XV.render({ loroView: 1, view: [
      { kind: "button", ask: { skill }, label: { pt: "b", en: "b" } },
    ] }, ctxOf());
    assert.ok(bad.errors.includes("err.ext_view_value:button.ask"),
      "aceitou o slug proibido: " + JSON.stringify(skill));
  }
  // and ask does not smuggle the action-only fields along
  const smuggle = XV.render({ loroView: 1, view: [
    { kind: "button", ask: { skill: "loro-kanban-ask" }, values: ["f"], label: { pt: "b", en: "b" } },
  ] }, ctxOf());
  assert.ok(smuggle.errors.includes("err.ext_view_value:button.ask"), String(smuggle.errors));
});

test("um alvo malicioso do ask sai escapado, nunca como atributo novo", () => {
  const out = XV.render({ loroView: 1, view: [
    { kind: "button", ask: { skill: "loro-kanban-ask",
      target: { pt: '" onmouseover="alert(1)', en: '" onmouseover="alert(1)' } },
      label: { pt: "b", en: "b" } },
  ] }, ctxOf());
  assert.ok(!/onmouseover="alert/.test(out.html), "o atributo não nasce");
  assert.ok(out.html.includes("&quot;"), "a aspa dupla foi escapada");
});

test("settings.<id> resolve do ctx, e um id que não existe é recusado por nome", () => {
  const ctx = ctxOf({ settings: { colunas: "area", mostrar_comentarios: true } });
  const out = XV.render({ loroView: 1, view: [
    { kind: "text", text: { $: "settings.colunas" } },
    { kind: "when", value: { $: "settings.mostrar_comentarios" }, is: true,
      then: [{ kind: "badge", text: { pt: "com comentários", en: "with comments" } }] },
  ] }, ctx);
  assert.deepEqual(out.errors, []);
  assert.ok(out.html.includes(">area<"), "o valor do ajuste aparece");
  assert.ok(out.html.includes("com comentários"), "o when leu o ajuste");
  const bad = XV.render({ loroView: 1, view: [
    { kind: "text", text: { $: "settings.nao_existe" } },
  ] }, ctx);
  assert.ok(bad.errors.includes("err.ext_view_ref:settings.nao_existe"), String(bad.errors));
});

test("acervo.areas é a quinta coleção, e o kanban por área itera sobre ela", () => {
  assert.ok(XV.FACTS.includes("acervo.areas"), "coleção fora do catálogo");
  const facts = Object.assign({}, FACTS, {
    "acervo.areas": { count: 2, rows: [
      { area: "assinatura", contexts: 1, hotspots: 2 },
      { area: "frota", contexts: 2, hotspots: 2 },
    ] },
  });
  // hotspot rows carry their area, so the inner each can filter on it
  facts["acervo.hotspots"] = { count: 4, rows: FACTS["acervo.hotspots"].rows.map((r) =>
    Object.assign({}, r, { area: r.context.split("/")[0], comments: 0 })) };
  const out = XV.render({ loroView: 1, view: [
    { kind: "each", of: "acervo.areas", as: "col",
      body: { kind: "stack", w: "md", children: [
        { kind: "text", text: { $: "col.area" }, size: "label" },
        { kind: "each", of: "acervo.hotspots", as: "hs",
          where: { area: { eq: { $: "col.area" } } },
          body: { kind: "text", text: { $: "hs.hotspot" } } },
      ] } },
  ] }, ctxOf({ facts }));
  assert.deepEqual(out.errors, []);
  assert.equal(countOf(out.html, "w-md"), 2, "uma coluna por área");
  assert.ok(out.html.includes("pneu-liso") && out.html.includes("cancelamento-cdc"));
});

test("where com mais de uma chave é um E, e `has` é a busca do contrato", () => {
  const facts = {
    "acervo.hotspots": { count: 3, rows: [
      { id: "frota/eletrica#H-1", hotspot: "H-1", context: "frota/eletrica", rel: "contexts/frota/eletrica/context.md", title: "x", status: "aberto", comments: 0 },
      { id: "frota/danos#H-2", hotspot: "H-2", context: "frota/danos", rel: "contexts/frota/danos/context.md", title: "x", status: "em-pauta", comments: 1 },
      { id: "assinatura#H-3", hotspot: "H-3", context: "assinatura", rel: "contexts/assinatura/context.md", title: "x", status: "aberto", comments: 0 },
    ] },
    "acervo.contexts": { count: 0, rows: [] },
    "acervo.orphans": { count: 0, rows: [] },
    "acervo.broken": { count: 0, rows: [] },
    "acervo.areas": { count: 0, rows: [] },
  };
  // status AND busca: a coluna «aberto» filtrada por «frota» tem UM cartão
  const out = XV.render({ loroView: 1, view: [
    { kind: "each", of: "acervo.hotspots", as: "hs",
      where: { status: { eq: "aberto" }, id: { has: { $: "settings.filtro" } } },
      body: { kind: "text", text: { $: "hs.hotspot" } } },
  ] }, ctxOf({ facts, settings: { filtro: "FROTA" } }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.html.includes("H-1"), "o aberto da frota entra");
  assert.ok(!out.html.includes("H-2"), "em-pauta não entra na coluna aberto");
  assert.ok(!out.html.includes("H-3"), "assinatura não casa com a busca");
  // a busca vazia casa tudo — uma caixa vazia não é um filtro
  const all = XV.render({ loroView: 1, view: [
    { kind: "each", of: "acervo.hotspots", as: "hs",
      where: { status: { eq: "aberto" }, id: { has: { $: "settings.filtro" } } },
      body: { kind: "text", text: { $: "hs.hotspot" } } },
  ] }, ctxOf({ facts, settings: { filtro: "" } }));
  assert.ok(all.html.includes("H-1") && all.html.includes("H-3"));
  // mais de 4 chaves: recusado por nome (um where ilimitado é um plano de consulta)
  const five = XV.render({ loroView: 1, view: [
    { kind: "each", of: "acervo.hotspots", as: "hs",
      where: { a: { eq: "x" }, b: { eq: "x" }, c: { eq: "x" }, d: { eq: "x" }, e: { eq: "x" } },
      body: { kind: "text", text: { $: "hs.hotspot" } } },
  ] }, ctxOf({ facts }));
  assert.ok(five.errors.includes("err.ext_view_value:each.where"), String(five.errors));
});

test("um dropdown pode nascer dos fatos — optionsFrom, com a opção «todas»", () => {
  const facts = Object.assign({}, FACTS, {
    "acervo.areas": { count: 2, rows: [
      { area: "assinatura", contexts: 1, hotspots: 2 },
      { area: "frota", contexts: 2, hotspots: 2 },
    ] },
  });
  const out = XV.render({ loroView: 1, view: [
    { kind: "field", id: "filtro", "field": "enum",
      label: { pt: "área", en: "area" },
      value: { $: "settings.filtro" },
      optionsFrom: { of: "acervo.areas", value: "area", label: "area" },
      empty: { pt: "todas as áreas", en: "all areas" } },
  ] }, ctxOf({ facts, settings: { filtro: "frota" } }));
  assert.deepEqual(out.errors, []);
  // a opção vazia primeiro, e o valor salvo selecionado
  assert.ok(/<option value=""[^>]*>todas as áreas<\/option>/.test(out.html), out.html);
  assert.ok(/<option value="frota" selected>/.test(out.html), "o valor salvo seleciona");
  assert.ok(out.html.includes('<option value="assinatura"'));
  // optionsFrom e options juntos: recusado por nome (duas fontes, uma verdade)
  const both = XV.render({ loroView: 1, view: [
    { kind: "field", id: "f", "field": "enum", label: { pt: "a", en: "a" },
      options: [{ value: "x", label: { pt: "x", en: "x" } }],
      optionsFrom: { of: "acervo.areas", value: "area", label: "area" } },
  ] }, ctxOf({ facts }));
  assert.ok(both.errors.includes("err.ext_view_value:field.options"), String(both.errors));
  // uma coleção fora do catálogo: recusada por nome
  const bad = XV.render({ loroView: 1, view: [
    { kind: "field", id: "g", "field": "enum", label: { pt: "a", en: "a" },
      optionsFrom: { of: "acervo.segredos", value: "x", label: "x" } },
  ] }, ctxOf({ facts }));
  assert.ok(bad.errors.includes("err.ext_view_facts:acervo.segredos"), String(bad.errors));
});

// O DRIFT QUE APARECEU NA TELA DO DONO (2026-08-20): a view nova pedia
// `settings.filtro` e o schema gravado na instalação anterior não o declarava —
// cada ref virou um err.ext_view_ref pintado. Reinstalar resolve (o record é
// substituído inteiro, ext.rs install_at), mas o REPOSITÓRIO nunca pode enviar
// os dois arquivos em desacordo: este teste lê o exemplo REAL do disco.
test("o exemplo enviado: todo settings.* da view existe no schema do manifesto", () => {
  const dir = path.join(__dirname, "..", "..", "examples", "extensions", "hotspots-board");
  const board = JSON.parse(fs.readFileSync(path.join(dir, "surface", "board.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "loro.json"), "utf8"));
  const declared = new Set((manifest.settings || []).map((f) => f.id));
  const refs = new Set();
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (typeof n.$ === "string" && n.$.startsWith("settings.")) refs.add(n.$.slice(9).split(".")[0]);
      Object.values(n).forEach(walk);
    }
  })(board);
  const faltando = [...refs].filter((id) => !declared.has(id));
  assert.deepEqual(faltando, [], "a view pede ajustes que o schema não declara: " + faltando.join(", "));
  // e a view inteira renderiza SEM ERROS com os defaults do próprio manifesto
  const settings = {};
  for (const f of manifest.settings || []) settings[f.id] = f.default;
  const facts = Object.assign({}, FACTS, {
    "acervo.areas": { count: 1, rows: [{ area: "frota", contexts: 2, hotspots: 4 }] },
  });
  facts["acervo.hotspots"] = { count: 4, rows: FACTS["acervo.hotspots"].rows.map((r) =>
    Object.assign({}, r, { area: r.context.split("/")[0], comments: 0, status: "aberto" })) };
  const out = XV.render(board, ctxOf({ facts, settings }));
  assert.deepEqual(out.errors, [], "o exemplo enviado renderiza com recusas");
});
