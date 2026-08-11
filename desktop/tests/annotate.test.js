// ADR-0007 — the annotation layer anchors highlights/comments by TEXT QUOTE
// (W3C/hypothes.is model), never by absolute offset, so a passage survives
// re-render and — because a transcript is append-only — survives live appends.
// makeAnchor/locate are PURE string logic (no DOM), node-testable here; the
// DOM painter (paintRange) is browser-only and verified in the GUI. These
// helpers must be TOTAL — malformed input degrades to null, never throws.
const test = require("node:test");
const assert = require("node:assert");
const A = require("../src/annotate.js");

// ---- makeAnchor ----

test("makeAnchor: captures the quote plus bounded prefix/suffix context", () => {
  const txt = "abcdefghij QUOTE klmnopqrst";
  const start = txt.indexOf("QUOTE");
  const a = A.makeAnchor(txt, start, start + "QUOTE".length);
  assert.strictEqual(a.quote, "QUOTE");
  assert.strictEqual(a.prefix, "abcdefghij ");
  assert.strictEqual(a.suffix, " klmnopqrst");
});

test("makeAnchor: prefix/suffix are capped and clamp at document edges", () => {
  const txt = "x".repeat(100) + "Q" + "y".repeat(100);
  const start = 100;
  const a = A.makeAnchor(txt, start, start + 1);
  assert.strictEqual(a.quote, "Q");
  assert.ok(a.prefix.length <= 40 && a.suffix.length <= 40);
  assert.ok(txt.startsWith("x".repeat(100)) && a.prefix === "x".repeat(40));
});

// ---- locate: the round-trip an anchor must satisfy ----

test("locate: a unique quote round-trips to the same span", () => {
  const txt = "the meeting decided to ship on friday";
  const start = txt.indexOf("ship on friday");
  const a = A.makeAnchor(txt, start, start + "ship on friday".length);
  const loc = A.locate(txt, a);
  assert.deepStrictEqual(loc, { start, end: start + "ship on friday".length });
});

test("locate: a duplicated quote is disambiguated by prefix/suffix context", () => {
  const txt = "custo alto no norte; custo alto no sul";
  // anchor the SECOND "custo alto" (the one followed by " no sul")
  const second = txt.lastIndexOf("custo alto");
  const a = A.makeAnchor(txt, second, second + "custo alto".length);
  const loc = A.locate(txt, a);
  assert.deepStrictEqual(loc, { start: second, end: second + "custo alto".length });
});

test("locate: an append AHEAD of the anchor does not shift it (append-only transcript)", () => {
  const original = "linha um\nlinha dois com a IDEIA importante\n";
  const start = original.indexOf("IDEIA importante");
  const a = A.makeAnchor(original, start, start + "IDEIA importante".length);
  const grown = original + "linha tres (transcrição continuou)\nlinha quatro\n";
  const loc = A.locate(grown, a);
  assert.deepStrictEqual(loc, { start, end: start + "IDEIA importante".length });
});

test("locate: whitespace re-wrap still matches (fuzzy fallback)", () => {
  const a = A.makeAnchor("preciso da sua ajuda com esse texto", 0, 35);
  // same words, re-wrapped by a re-render (newline instead of spaces)
  const rewrapped = "preciso da sua\najuda com   esse texto";
  const loc = A.locate(rewrapped, a);
  assert.ok(loc, "expected a fuzzy match across re-wrapped whitespace");
  assert.strictEqual(rewrapped.slice(loc.start, loc.end).replace(/\s+/g, " "),
    "preciso da sua ajuda com esse texto");
});

test("locate: a deleted quote becomes an orphan (null), never throws", () => {
  const a = A.makeAnchor("este trecho vai sumir do documento", 0, 34);
  assert.strictEqual(A.locate("um documento completamente diferente", a), null);
});

test("locate: total on malformed input", () => {
  assert.strictEqual(A.locate("qualquer coisa", null), null);
  assert.strictEqual(A.locate("qualquer coisa", { quote: "" }), null);
  assert.strictEqual(A.locate(null, { quote: "x" }), null);
});
