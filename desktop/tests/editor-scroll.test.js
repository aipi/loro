// ADR-0008 — in edit mode the CM6 editor fills the doc panel and scrolls on its
// own .cm-scroller (see style.css "no modo editar o CM6 ocupa o painel inteiro").
// Regression guard for the scroll-in-edit-mode bug: the view-mode `.docbody`
// uses `align-items: flex-start` (for the reader + sticky rail), which leaks
// into edit mode and stops `.docmain` from being stretched to the panel height
// — it grows to the full document height instead, so the editor never gets a
// bounded height and can't scroll. Edit mode must reset alignment to stretch,
// and must not let the contained-card 60vh floor outgrow the panel.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "src", "style.css"),
  "utf8",
);

const norm = (s) => s.replace(/\s+/g, " ");

test("edit mode stretches .docbody so .docmain is bounded to the panel height", () => {
  const css = norm(CSS);
  assert.match(
    css,
    /#wsBody\.editing \.docbody \{[^}]*align-items:\s*stretch/,
    "editing .docbody must set align-items: stretch, else .docmain grows to the document height and the editor can't scroll",
  );
});

test("edit mode clears the 60vh min-height floor on the CM6 editor", () => {
  const css = norm(CSS);
  assert.match(
    css,
    /#wsBody\.editing \.edithost \.cm-editor \{[^}]*min-height:\s*0/,
    "editing .cm-editor must reset min-height to 0 so it never exceeds the flex panel",
  );
});
