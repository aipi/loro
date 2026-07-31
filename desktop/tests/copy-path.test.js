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
  // fontes files + 3 context-child rows + the folderGroupHtml header = ≥5 uses
  assert.ok(btns.length >= 5, `expected ≥5 pathMenuBtnHtml() uses, got ${btns.length}`);
  assert.ok(APP.includes("wirePathMenus("), "wirePathMenus must be called to bind the buttons");
});

test("brainstorming folders (reuniões/notas/anexos) copy their path", () => {
  // each tema folder passes its real acervo path as folderGroupHtml's `rel`,
  // so the copy-path ⋯ shows on the folder header (not only inside it).
  for (const rel of [
    "`brainstorming/${slug}/reunioes`",
    "`brainstorming/${slug}/notas`",
    "`brainstorming/${slug}/anexos`",
  ]) {
    assert.ok(APP.includes(rel), `folder header must copy ${rel}`);
  }
  // navPessoal binds its own copy-path buttons (it wires via wirePessoal, not
  // the global wireSidebar pass).
  assert.ok(APP.includes("wirePathMenus(B.navPessoal)"), "wirePessoal must bind navPessoal copy-path buttons");
});
