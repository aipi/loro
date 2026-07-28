// ADR-0009 — living files carry YAML front-matter (refs/audio/promovido) and
// inline `[label](ref:id)` links. Reference resolution and front-matter parsing
// are PURE string logic (no DOM, no YAML library — no-bundler constraint), so
// they live in a node-testable module. mdRender degrades to plain text on
// malformed front-matter; these helpers must therefore NEVER throw.
const test = require("node:test");
const assert = require("node:assert");
const Refs = require("../src/refs.js");

// ---- splitFrontMatter ----

test("splitFrontMatter: splits a leading --- block from the body", () => {
  const text = "---\nloro: 1\ntema: x\n---\n# Título\n\nCorpo.";
  const r = Refs.splitFrontMatter(text);
  assert.strictEqual(r.frontMatter, "loro: 1\ntema: x");
  assert.strictEqual(r.body, "# Título\n\nCorpo.");
});

test("splitFrontMatter: no front-matter returns null + full body", () => {
  const text = "# Só corpo\n\nsem front-matter.";
  const r = Refs.splitFrontMatter(text);
  assert.strictEqual(r.frontMatter, null);
  assert.strictEqual(r.body, text);
});

test("splitFrontMatter: unterminated block degrades to plain body (never throws)", () => {
  const text = "---\nloro: 1\nsem fechamento\n# corpo";
  const r = Refs.splitFrontMatter(text);
  assert.strictEqual(r.frontMatter, null);
  assert.strictEqual(r.body, text);
});

test("splitFrontMatter: an empty front-matter block is still a valid split", () => {
  const r = Refs.splitFrontMatter("---\n---\ncorpo");
  assert.strictEqual(r.frontMatter, "");
  assert.strictEqual(r.body, "corpo");
});

// ---- parseFrontMatter ----

test("parseFrontMatter: scalars of our real shape", () => {
  const fm = ["loro: 1", "id: abc123", "tema: cobranca", "criado_em: 2026-07-27", "atualizado_em: 2026-07-27"].join("\n");
  const o = Refs.parseFrontMatter(fm);
  assert.strictEqual(o.loro, "1");
  assert.strictEqual(o.id, "abc123");
  assert.strictEqual(o.tema, "cobranca");
  assert.strictEqual(o.criado_em, "2026-07-27");
  assert.strictEqual(o.atualizado_em, "2026-07-27");
});

test("parseFrontMatter: inline-object refs list", () => {
  const fm = [
    "tema: cobranca",
    "refs:",
    "  - {id: r1, tipo: image, caminho: acervo://pessoal/temas/cobranca/img/a.png}",
    "  - {id: r2, tipo: doc, caminho: acervo://contextos/cobranca/context.md}",
  ].join("\n");
  const o = Refs.parseFrontMatter(fm);
  assert.strictEqual(Array.isArray(o.refs), true);
  assert.strictEqual(o.refs.length, 2);
  assert.deepStrictEqual(o.refs[0], { id: "r1", tipo: "image", caminho: "acervo://pessoal/temas/cobranca/img/a.png" });
  assert.strictEqual(o.refs[1].caminho, "acervo://contextos/cobranca/context.md");
});

test("parseFrontMatter: block-item refs list", () => {
  const fm = [
    "refs:",
    "  - id: r1",
    "    tipo: audio",
    "    caminho: acervo://pessoal/temas/x/reunioes/2026-07-27-a/reuniao.wav",
    "  - id: r2",
    "    tipo: doc",
    "    caminho: acervo://pessoal/avulso/2026-07-27-nota.md",
  ].join("\n");
  const o = Refs.parseFrontMatter(fm);
  assert.strictEqual(o.refs.length, 2);
  assert.strictEqual(o.refs[0].id, "r1");
  assert.strictEqual(o.refs[0].tipo, "audio");
  assert.strictEqual(o.refs[1].caminho, "acervo://pessoal/avulso/2026-07-27-nota.md");
});

test("parseFrontMatter: audio list + promovido nested map", () => {
  const fm = [
    "audio:",
    "  - {id: a1, tipo: audio, caminho: acervo://pessoal/temas/x/reunioes/r/reuniao.wav}",
    "promovido:",
    "  para: cobranca",
    "  branch: rfc/cobranca-x",
    "  em: 2026-07-27",
  ].join("\n");
  const o = Refs.parseFrontMatter(fm);
  assert.strictEqual(o.audio[0].id, "a1");
  assert.deepStrictEqual(o.promovido, { para: "cobranca", branch: "rfc/cobranca-x", em: "2026-07-27" });
});

test("parseFrontMatter: empty inline array", () => {
  const o = Refs.parseFrontMatter("refs: []");
  assert.deepStrictEqual(o.refs, []);
});

test("parseFrontMatter: junk never throws and yields {}", () => {
  for (const junk of ["%%%\n\t- broken\n:::", "just some prose\nwith no structure", "", "\n\n\n"]) {
    let o;
    assert.doesNotThrow(() => { o = Refs.parseFrontMatter(junk); });
    assert.deepStrictEqual(o, {});
  }
});

test("parseFrontMatter: null/undefined input yields {} (never throws)", () => {
  assert.deepStrictEqual(Refs.parseFrontMatter(null), {});
  assert.deepStrictEqual(Refs.parseFrontMatter(undefined), {});
});

// ---- parseRef ----

test("parseRef: acervo:// anchored form", () => {
  assert.deepStrictEqual(Refs.parseRef("acervo://contextos/x.md"), { scheme: "acervo", path: "contextos/x.md" });
});

test("parseRef: anything else is relative", () => {
  assert.deepStrictEqual(Refs.parseRef("../img/a.png"), { scheme: "relative", path: "../img/a.png" });
  assert.deepStrictEqual(Refs.parseRef("./sibling.md"), { scheme: "relative", path: "./sibling.md" });
  assert.deepStrictEqual(Refs.parseRef("notas/a.md"), { scheme: "relative", path: "notas/a.md" });
});

// ---- resolveRelative ----

test("resolveRelative: resolves against the source file's directory", () => {
  assert.strictEqual(
    Refs.resolveRelative("pessoal/temas/x/notas/a.md", "../img/chart.png"),
    "pessoal/temas/x/img/chart.png",
  );
});

test("resolveRelative: collapses ./ and current dir", () => {
  assert.strictEqual(Refs.resolveRelative("pessoal/avulso/n.md", "./sibling.md"), "pessoal/avulso/sibling.md");
  assert.strictEqual(Refs.resolveRelative("pessoal/avulso/n.md", "sibling.md"), "pessoal/avulso/sibling.md");
});

test("resolveRelative: escape ABOVE root is clamped to root (never yields a ../)", () => {
  const out = Refs.resolveRelative("pessoal/temas/x/notas/a.md", "../../../../../../etc/passwd");
  assert.strictEqual(out.includes(".."), false);
  assert.strictEqual(out, "etc/passwd");
});

test("resolveRelative: a leading slash is treated as acervo-root-relative", () => {
  assert.strictEqual(Refs.resolveRelative("pessoal/avulso/n.md", "/contextos/x.md"), "contextos/x.md");
});

// ---- tipoFromExt ----

test("tipoFromExt: extension table", () => {
  const cases = {
    "a.md": "doc",
    "a.txt": "doc",
    "a.svg": "image",
    "a.png": "image",
    "a.jpg": "image",
    "a.jpeg": "image",
    "a.gif": "image",
    "a.webp": "image",
    "a.wav": "audio",
    "a.webm": "audio",
    "a.mp3": "audio",
    "a.m4a": "audio",
    "a.pdf": "other",
    "a.xlsx": "other",
    noext: "other",
    "acervo://pessoal/temas/x/img/CHART.PNG": "image",
  };
  for (const [name, tipo] of Object.entries(cases)) {
    assert.strictEqual(Refs.tipoFromExt(name), tipo, `${name} -> ${tipo}`);
  }
});

// ---- findRef ----

test("findRef: finds by id across refs and audio, else null", () => {
  const fm = {
    refs: [{ id: "r1", tipo: "doc", caminho: "acervo://x.md" }],
    audio: [{ id: "a1", tipo: "audio", caminho: "acervo://y.wav" }],
  };
  assert.strictEqual(Refs.findRef(fm, "r1").tipo, "doc");
  assert.strictEqual(Refs.findRef(fm, "a1").tipo, "audio");
  assert.strictEqual(Refs.findRef(fm, "nope"), null);
  assert.strictEqual(Refs.findRef({}, "r1"), null);
  assert.strictEqual(Refs.findRef(null, "r1"), null);
});
