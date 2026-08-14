// ADR-0008 — the two versioned worlds must be legible at the tab surface:
// contexts/ tabs are "versionado" and carry a Git indicator; pessoal/ tabs are
// "rascunho — não versionado" and NEVER surface any Git state. These are pure
// derivations of a tab's kind, so they live in a node-testable module.
const test = require("node:test");
const assert = require("node:assert");
const World = require("../src/world.js");

test("crumbBadge: context world is versionado", () => {
  const b = World.crumbBadge("context");
  assert.strictEqual(b.label, "versionado");
  assert.strictEqual(b.cls, "ok");
});

test("crumbBadge: personal world is an un-versioned draft", () => {
  const b = World.crumbBadge("personal");
  assert.strictEqual(b.label, "rascunho — não versionado");
  assert.strictEqual(b.cls, "warn2");
});

test("crumbBadge: other kinds have no world badge (caller falls back)", () => {
  assert.strictEqual(World.crumbBadge("other"), null);
});

test("crumbBadge: renders in English when lang is 'en'", () => {
  assert.strictEqual(World.crumbBadge("context", "en").label, "versioned");
  assert.strictEqual(World.crumbBadge("context", "en").cls, "ok");
  assert.strictEqual(World.crumbBadge("personal", "en").label, "draft — not versioned");
  assert.strictEqual(World.crumbBadge("personal", "en").cls, "warn2");
  assert.strictEqual(World.crumbBadge("other", "en"), null);
  // explicit "pt" matches the default
  assert.strictEqual(World.crumbBadge("context", "pt").label, "versionado");
});

test("gitVisible: only context tabs surface Git state", () => {
  assert.strictEqual(World.gitVisible("context"), true);
  // BR of ADR-0008: a pessoal/ tab never renders a git-dirty state.
  assert.strictEqual(World.gitVisible("personal"), false);
  assert.strictEqual(World.gitVisible("other"), false);
});
