# ADR-0016 — Markdown formatting bar in the edit modes (not WYSIWYG)

- **Status:** accepted (owner decision, 2026-08-04)
- **Context:** the owner asked whether the edit modes should get "WYSIWYG
  controls". There were two edit surfaces with no formatting affordance at all:
  the Studio tab (CodeMirror 6, markdown as source — ADR-0008) and the modal
  editor for queue drafts / loop instructions (a bare `<textarea>`). Writing
  markdown meant typing every marker by hand, and the two surfaces did not even
  behave alike.

## Decision

### §1 Markdown-aware controls, not a rich-text editor

The edit modes get a **formatting bar that writes markdown syntax into the
buffer** — bold, italic, strikethrough, H1–H3, bulleted/task/numbered list,
quote, inline code, link, table, code block, horizontal rule — plus `⌘B`/`⌘I`/`⌘K`.
The document on disk stays markdown written the way a human writes it, and each
command edits only the range it touches.

A real rich-text editor (contenteditable + markdown serializer, e.g. Tiptap) was
considered and **declined**:

- it reserializes the whole document on save, which churns the git diff (ADR-0002
  makes branch-first git the review surface — a diff that rewrites untouched
  lines is not reviewable);
- text-quote anchors for highlights/comments (ADR-0007) break silently when a
  serializer normalizes whitespace;
- front matter (`refs:`, `audio:`, `digest_itens`) is a contract read by
  `refs.js`, the digest (ADR-0011) and the skills; no generic serializer
  preserves it faithfully;
- it means a second vendored blob under the Tauri CSP, replacing CM6.

A hybrid "live preview" (hiding markers off the cursor line, Obsidian-style) is
compatible with this decision and stays open as a later increment; it is a custom
decoration plugin in the vendored bundle, not something off the shelf.

### §2 The commands are pure functions

`desktop/src/mdedit.js` (`window.LoroMdEdit`, `require`-able in Node) exposes
`apply(doc, anchor, head, action) -> {changes, selection} | null` — the shape a
CM6 transaction takes. No DOM, no CodeMirror: the whole toggle behavior
(wrap/unwrap, marker-run counting so italic inside bold does not confuse itself,
line-block prefixes, sequential numbering, blank lines skipped, indentation
preserved) is unit-tested in `desktop/tests/mdedit.test.js`. `ACTIONS` (the bar's
buttons, labels, tooltips, groups) and `KEYS` (the shortcuts) live in the same
module, so the bar has no separate list to drift from.

The bar does not touch the vendored CM6 bundle: it dispatches through the
existing `LoroCM6.create` handle contract (`view`, `getValue`), so `make
vendor-cm6` is not part of this change. `⌘B`/`⌘I`/`⌘K` are intercepted with a
capture-phase `keydown` on the editor DOM — in WKWebView the native shortcut
would otherwise apply HTML bold/italic inside CM6's contenteditable and dirty the
buffer.

### §3 One editor for both surfaces

The modal editor (queue drafts, loop instructions) drops its `<textarea>` and
uses the same `LoroCM6` + the same bar as the Studio tab. Its handle is created
per opening and destroyed on close (the modal holds no buffer of its own);
`⌘S` inside it saves through the same path as the *salvar* button.

### §4 The bar wraps

`.mdbar` is `flex-wrap: wrap` as a requirement, not a style: on the default
560×520 window the fifteen controls do not fit one row, and without wrapping they
would overflow the panel width in WKWebView. In edit mode the bar is `flex: none`
so only the editor below it grows and scrolls. Structural guards live in
`desktop/tests/mdbar.test.js`.

## Consequences

- Formatting is discoverable without knowing markdown, and the file on disk is
  unchanged in kind — reviewable diffs, intact annotation anchors, untouched
  front matter.
- Tooltips are new pt-BR msgids with English entries in `i18n.js`.
- GUI verification (WKWebView at 560×520: wrapping, focus retention on click,
  `⌘B` not producing native bold) is pending on a machine with the Rust
  toolchain — it could not be run where this change was written.
