// Critic round 3 — the boot path itself.
//
//   N1/N17/N21  the app did not boot at all: four `data-i18n-attrs` values were
//               SPACE-separated ("aria-label title"), applyI18n splits the list
//               on "," only, so the whole string became one token, the derived
//               dataset key was "i18nSrcAriaLabel title", and assigning it asked
//               the DOM for the attribute `data-i18n-src-aria-label title` —
//               not a valid qualified name. setAttribute threw at module init,
//               applySettings() aborted, and the window painted nothing.
//   N18         518 tests and a clean lint coexisted with that blank window,
//               because no suite ever RAN a line of the boot path: every other
//               suite reads app.js as text or evaluates one pure function.
//   N19         the i18n scanner reproduced the applier's comma-only rule, so
//               the malformed declaration was invisible to it too.
//
// This suite closes the class by EXECUTING the shipped applyI18n over the
// shipped index.html. There is no DOM in `node --test` and the repo carries no
// DOM library (a privacy-first app should not need a network install to prove
// it starts), so the seam is a minimal DOM that enforces the two browser rules
// this bug lives in: the dataset key → attribute-name derivation, and
// setAttribute's qualified-name validation. A declaration that cannot become an
// attribute name fails here instead of blanking the window.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");

// ---------------------------------------------------------------- mini-DOM
// XML Name production, narrowed to what an HTML attribute may be called. A
// space anywhere in the name is exactly what the browser rejected.
const QUALIFIED_NAME = /^[A-Za-z_:][A-Za-z0-9._:-]*$/;

// The dataset setter's own derivation: camelCase → hyphenated, "data-" prefixed.
// Whatever survives here is what setAttribute is asked for.
function attrNameFromDatasetKey(key) {
  return "data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}
function datasetKeyFromAttrName(name) {
  return name.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function makeNode(tag, attrs, text) {
  const node = {
    tagName: tag.toUpperCase(),
    attrs: new Map(attrs),
    textContent: text || "",
    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null;
    },
    setAttribute(name, value) {
      if (!QUALIFIED_NAME.test(name)) {
        const e = new Error(`Invalid qualified name: '${name}'`);
        e.name = "InvalidCharacterError";
        throw e;
      }
      this.attrs.set(name, String(value));
    },
    hasAttribute(name) {
      return this.attrs.has(name);
    },
  };
  node.dataset = new Proxy(
    {},
    {
      get: (_, key) => node.getAttribute(attrNameFromDatasetKey(String(key))) ?? undefined,
      set: (_, key, value) => {
        node.setAttribute(attrNameFromDatasetKey(String(key)), value);
        return true;
      },
      has: (_, key) => node.hasAttribute(attrNameFromDatasetKey(String(key))),
    }
  );
  return node;
}

// One start-tag per element, plus the text up to the next tag — enough for the
// applier, which only reads attributes and textContent.
function parseNodes(html) {
  const nodes = [];
  for (const m of html.matchAll(/<([a-z0-9]+)((?:\s+[^<>]*?)?)>([^<]*)/gi)) {
    const attrs = [];
    for (const a of m[2].matchAll(/([A-Za-z-][A-Za-z0-9:._-]*)(?:="([^"]*)")?/g)) {
      if (a[1]) attrs.push([a[1].toLowerCase(), a[2] === undefined ? "" : a[2]]);
    }
    nodes.push(makeNode(m[1], attrs, m[3]));
  }
  return nodes;
}

function makeDocument(html) {
  const nodes = parseNodes(html);
  return {
    documentElement: makeNode("html", [], ""),
    all: nodes,
    querySelectorAll(sel) {
      const m = /^\[([a-z0-9-]+)\]$/.exec(sel);
      assert.ok(m, `o DOM mínimo só resolve seletores de atributo, veio: ${sel}`);
      const list = nodes.filter((n) => n.hasAttribute(m[1]));
      list.forEach = Array.prototype.forEach.bind(list);
      return list;
    },
  };
}

// The shipped applier, verbatim: this suite is worth nothing if it runs a copy.
function loadApplyI18n() {
  const m = APP.match(/function applyI18n\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, "app.js deve definir applyI18n()");
  return m[0];
}
function runApplyI18n(html, lang) {
  const doc = makeDocument(html);
  const src = loadApplyI18n();
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "document",
    "settings",
    "setI18nLang",
    "t",
    src + "\nreturn applyI18n;"
  )(doc, { uiLang: lang || "pt" }, () => {}, (s) => s);
  fn();
  return doc;
}

// ------------------------------------------------------------------- tests
test("N1 — o boot traduz o index.html inteiro sem lançar (a janela em branco)", () => {
  // Este é o teste que faltava: nenhuma suíte executava uma linha do boot, então
  // um InvalidCharacterError no init convivia com 518 testes verdes (N18).
  assert.doesNotThrow(() => runApplyI18n(HTML, "pt"));
  assert.doesNotThrow(() => runApplyI18n(HTML, "en"));
});

test("N1 — o DOM mínimo vê TODOS os nós de i18n do arquivo", () => {
  // Um varredor que não vê nada passa por engano (foi como N19 nasceu): o
  // número de nós que o shim entrega tem de casar com o do arquivo.
  const doc = makeDocument(HTML);
  const attrsNoArquivo = (HTML.match(/\bdata-i18n-attrs="/g) || []).length;
  const textoNoArquivo = (HTML.match(/\bdata-i18n(?![-a-z])/g) || []).length;
  assert.ok(attrsNoArquivo > 20 && textoNoArquivo > 100, "o index.html perdeu seus msgids?");
  assert.equal(doc.querySelectorAll("[data-i18n-attrs]").length, attrsNoArquivo);
  assert.equal(doc.querySelectorAll("[data-i18n]").length, textoNoArquivo);
});

test("N1 — toda lista data-i18n-attrs deriva um nome de atributo válido", () => {
  const ruins = [];
  for (const m of HTML.matchAll(/\bdata-i18n-attrs="([^"]*)"/g)) {
    for (const token of m[1].split(/[,\s]+/)) {
      const a = token.trim();
      if (!a) continue;
      const key = `i18nSrc${a.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}`;
      const derived = attrNameFromDatasetKey(key);
      if (!QUALIFIED_NAME.test(derived)) ruins.push(`${m[1]} → ${derived}`);
      if (!QUALIFIED_NAME.test(a)) ruins.push(`${m[1]} → atributo inválido: ${a}`);
    }
  }
  assert.deepStrictEqual(ruins, [], "declarações que o DOM recusa:\n  " + ruins.join("\n  "));
});

test("N1 — o aplicador aceita vírgula E espaço: um separador não derruba o app", () => {
  // O separador da lista é convenção nossa; um erro de digitação nela tem de
  // degradar (a tradução do atributo), nunca abortar o resto do script.
  const html = '<button aria-label="Nova ideia" title="Nova ideia" data-i18n-attrs="aria-label title">+</button>';
  const doc = runApplyI18n(html, "pt");
  const btn = doc.all.find((n) => n.hasAttribute("data-i18n-attrs"));
  assert.equal(btn.getAttribute("data-i18n-src-aria-label"), "Nova ideia",
    "o token separado por espaço tem de ser lido como 'aria-label', não virar nome de atributo");
  assert.equal(btn.getAttribute("data-i18n-src-title"), "Nova ideia");
});

test("N1 — todo atributo declarado existe no elemento (nada de tradução para o vazio)", () => {
  // Um token que não casa com nenhum atributo do elemento é uma declaração
  // morta: o aplicador guardaria "" e a tradução nunca aconteceria.
  const orfaos = [];
  for (const m of HTML.matchAll(/<[a-z0-9]+(?:\s+[^<>]*?)?\bdata-i18n-attrs="([^"]*)"[^<>]*>/gi)) {
    for (const token of m[1].split(/[,\s]+/)) {
      const a = token.trim();
      if (!a) continue;
      if (!new RegExp(`\\b${a}="`).test(m[0])) orfaos.push(`${a} em ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepStrictEqual(orfaos, [], "data-i18n-attrs sem o atributo correspondente:\n  " + orfaos.join("\n  "));
});

test("N1 — o aplicador congela o valor pt e o reescreve na troca de idioma", () => {
  const html = '<button title="Fechar o terminal" data-i18n-attrs="title">x</button>';
  const doc = makeDocument(html);
  const src = loadApplyI18n();
  const traduz = (s) => (s === "Fechar o terminal" ? "Close the terminal" : s);
  // eslint-disable-next-line no-new-func
  const fn = new Function("document", "settings", "setI18nLang", "t", src + "\nreturn applyI18n;")(
    doc, { uiLang: "en" }, () => {}, traduz
  );
  fn();
  fn(); // segunda passada: o msgid congelado é o pt, não o inglês já aplicado
  const btn = doc.all.find((n) => n.hasAttribute("data-i18n-attrs"));
  assert.equal(btn.getAttribute("data-i18n-src-title"), "Fechar o terminal");
  assert.equal(btn.getAttribute("title"), "Close the terminal");
});

test("N18 — o boot do index.html carrega os scripts que ele mesmo declara", () => {
  // O erro fatal abortava app.js DEPOIS do <script>: quem lê o HTML tem de ver
  // a mesma ordem que o app depende (i18n antes de app.js, que chama t() no init).
  const scripts = [...HTML.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  for (const s of scripts) {
    if (/^https?:/.test(s)) continue;
    const p = path.join(SRC, s.replace(/^\.\//, ""));
    assert.ok(fs.existsSync(p), `script declarado e ausente do disco: ${s}`);
  }
  assert.ok(scripts.indexOf("i18n.js") < scripts.indexOf("app.js"),
    "app.js chama t() no init: i18n.js tem de carregar antes");
});
