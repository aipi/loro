// ADR-0008 — in edit mode the CM6 editor fills the doc panel and scrolls on its
// own .cm-scroller (see style.css "no modo editar o CM6 ocupa o painel inteiro").
// Regression guard: the contained-card `min-height: 60vh` on .cm-editor must not
// leak into edit mode, where it makes the editor taller than the flex panel and
// the long document gets clipped by edithost's `overflow: hidden` with no
// scrollbar. Edit mode must reset that floor and keep the scroller scrollable.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "src", "style.css"),
  "utf8",
);

const norm = (s) => s.replace(/\s+/g, " ");

test("edit mode clears the 60vh min-height floor on the CM6 editor", () => {
  const css = norm(CSS);
  assert.match(
    css,
    /#wsBody\.editing \.edithost \.cm-editor \{[^}]*min-height:\s*0/,
    "editing .cm-editor must reset min-height to 0 so it never exceeds the flex panel",
  );
});

test("edit mode keeps the CM6 scroller vertically scrollable", () => {
  const css = norm(CSS);
  assert.match(
    css,
    /#wsBody\.editing \.edithost \.cm-scroller \{[^}]*overflow-y:\s*auto/,
    "editing .cm-scroller must scroll vertically so long documents roll inside the panel",
  );
});
