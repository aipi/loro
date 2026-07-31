// issue #18 — every node in the sidebar tree can copy its acervo-relative and
// absolute path. The affordance is UI-only (the backend `brain_abs_path`
// already resolves any path in the acervo). These guards assert the shared
// helpers exist and that every ⋯ menu builder + the menuless file/folder rows
// wire them, so a future edit can't silently drop copy-path from a surface.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(
  path.join(__dirname, "..", "src", "app.js"),
  "utf8",
);

test("copy-path helpers are defined", () => {
  for (const fn of [
    "function copyPathItemsHtml(",
    "function wireCopyPathItems(",
    "function openPathMenu(",
    "function pathMenuBtnHtml(",
  ]) {
    assert.ok(APP.includes(fn), `missing helper: ${fn}`);
  }
});

test("every ⋯ menu builder offers the copy-path rows", () => {
  // one copyPathItemsHtml() per menu: artefato, bs, meeting, queue, ctx, tool
  const items = APP.match(/copyPathItemsHtml\(\)/g) || [];
  assert.ok(items.length >= 6, `expected ≥6 copyPathItemsHtml() call sites, got ${items.length}`);
  // the menus that target a derived rel wire it explicitly
  for (const call of [
    "wireCopyPathItems(`brainstorming/${slug}`)",
    "wireCopyPathItems(`inbox/${name}`)",
    "wireCopyPathItems(`contextos/${name}`)",
  ]) {
    assert.ok(APP.includes(call), `missing wiring: ${call}`);
  }
});

test("menuless file/folder rows carry a copy-path ⋯ button", () => {
  const btns = APP.match(/pathMenuBtnHtml\(/g) || [];
  // fontes files + 3 context-child rows + the anexos folder header = ≥5 uses
  // (the definition itself is `function pathMenuBtnHtml(`, excluded by the `(`)
  assert.ok(btns.length >= 5, `expected ≥5 pathMenuBtnHtml() uses, got ${btns.length}`);
  assert.ok(APP.includes("wirePathMenus("), "wirePathMenus must be called to bind the buttons");
});
