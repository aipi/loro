// Tests for LoroFuzzy (node --test). Pure module, no DOM, no deps.
// Backs the command-palette quick-open (ADR-0008): subsequence match with
// contiguity + basename/word-boundary bonuses, NFD diacritic folding (pt-BR).
const test = require("node:test");
const assert = require("node:assert");
const { score, filter } = require("../src/fuzzy.js");

test("empty query scores 0 (matches everything; caller shows MRU)", () => {
  assert.strictEqual(score("", "anything/at/all.md"), 0);
  assert.strictEqual(score("", ""), 0);
});

test("subsequence match returns a number", () => {
  assert.strictEqual(typeof score("abc", "a-b-c"), "number");
});

test("non-subsequence returns null", () => {
  assert.strictEqual(score("xyz", "abc"), null);
  assert.strictEqual(score("cba", "abc"), null); // order matters
  assert.strictEqual(score("abcd", "abc"), null); // query longer than any subseq
});

test("match is case-insensitive", () => {
  assert.notStrictEqual(score("ABC", "abcdef"), null);
  assert.notStrictEqual(score("abc", "ABCDEF"), null);
});

test("contiguous run outranks a scattered subsequence", () => {
  const contiguous = score("abc", "abcxyz");
  const scattered = score("abc", "axbxcx");
  assert.notStrictEqual(contiguous, null);
  assert.notStrictEqual(scattered, null);
  assert.ok(contiguous > scattered, `contiguous ${contiguous} > scattered ${scattered}`);
});

test("basename match outranks a dir-only match", () => {
  // 'ctx' hits the basename here...
  const inBasename = score("ctx", "pessoal/foo/ctx.md");
  // ...and only the directory here.
  const inDir = score("ctx", "ctx/foo/other.md");
  assert.notStrictEqual(inBasename, null);
  assert.notStrictEqual(inDir, null);
  assert.ok(inBasename > inDir, `basename ${inBasename} > dir ${inDir}`);
});

test("word-boundary matches outrank mid-word matches", () => {
  const boundary = score("fb", "foo/bar.md"); // f, b both start segments/words
  const midword = score("fb", "foobar.md"); // b is mid-word
  assert.notStrictEqual(boundary, null);
  assert.notStrictEqual(midword, null);
  assert.ok(boundary > midword, `boundary ${boundary} > midword ${midword}`);
});

test("NFD folding: 'reuniao' matches 'reunião'", () => {
  assert.notStrictEqual(
    score("reuniao", "pessoal/temas/x/meetings/reunião.md"),
    null
  );
});

test("NFD folding: 'analise' matches 'análise'", () => {
  assert.notStrictEqual(score("analise", "contexts/loro/análise.md"), null);
});

test("filter sorts by descending score and drops non-matches", () => {
  const items = [
    { rel: "pessoal/notes.md" },
    { rel: "contexts/loro/context.md" },
    { rel: "pessoal/context-draft.md" },
  ];
  const out = filter("context", items, (it) => it.rel);
  // 'notes.md' has no 'context' subsequence -> dropped.
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((it) => it.rel !== "pessoal/notes.md"));
  // basename hit ('context.md') ranks above dir/scattered hit.
  assert.strictEqual(out[0].rel, "contexts/loro/context.md");
});

test("filter with empty query keeps every item in original order (stable)", () => {
  const items = [{ k: "b" }, { k: "a" }, { k: "c" }];
  const out = filter("", items, (it) => it.k);
  assert.deepStrictEqual(out.map((it) => it.k), ["b", "a", "c"]);
});

test("filter is stable for equal scores", () => {
  // Two targets that score identically must keep input order.
  const items = [{ k: "abx" }, { k: "aby" }];
  const out = filter("ab", items, (it) => it.k);
  assert.deepStrictEqual(out.map((it) => it.k), ["abx", "aby"]);
});
