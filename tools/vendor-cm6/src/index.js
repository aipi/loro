// ADR-0008 — CodeMirror 6 vendor entry. esbuild bundles this into the single
// committed IIFE desktop/src/vendor/cm6.js and exposes window.LoroCM6. This
// file is NEVER loaded at runtime; only its bundled output is.
//
// Contract (the integration step depends on it verbatim):
//   window.LoroCM6.create(opts) -> handle
//     opts   = { parent, doc, readOnly?, onChange?, onSave?, theme? }
//     handle = { view, getValue, setValue, focus, setReadOnly, destroy }
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from "@codemirror/commands";
import {
  syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

// Map the editor chrome to Loro's palette (style.css custom props) so the
// vendored blob inherits the app theme instead of hard-coding colors. Only
// --ink/--panel/--line/--accent are contractually available.
function loroTheme(dark) {
  return EditorView.theme(
    {
      "&": {
        color: "var(--ink)",
        backgroundColor: "var(--panel)",
        height: "100%",
        fontSize: "13px",
      },
      ".cm-content": {
        caretColor: "var(--accent)",
        fontFamily: "var(--mono)",
        padding: "8px 0",
      },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
      "&.cm-focused": { outline: "none" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)" },
      ".cm-gutters": {
        backgroundColor: "var(--panel)",
        color: "var(--muted, var(--ink))",
        border: "none",
        borderRight: "1px solid var(--line)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--ink) 5%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--ink) 7%, transparent)",
      },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        outline: "1px solid color-mix(in srgb, var(--accent) 50%, transparent)",
        backgroundColor: "transparent",
      },
      ".cm-selectionMatch": {
        backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)",
      },
      ".cm-panels": {
        backgroundColor: "var(--panel)",
        color: "var(--ink)",
        borderTop: "1px solid var(--line)",
      },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        fontFamily: "var(--mono)",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
      },
    },
    { dark }
  );
}

// Syntax highlighting for markdown, expressed against the palette. Semantic
// tokens borrow the app accent / ink so both themes stay coherent.
const loroHighlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: "var(--ink)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: [t.monospace], color: "var(--accent)" },
  { tag: t.quote, color: "var(--muted, var(--ink))", fontStyle: "italic" },
  { tag: [t.keyword, t.operator], color: "var(--accent)" },
  { tag: [t.comment], color: "var(--muted, var(--ink))", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta], color: "var(--muted, var(--ink))" },
  { tag: [t.list], color: "var(--ink)" },
]);

function create(opts) {
  opts = opts || {};
  const parent = opts.parent;
  if (!parent) throw new Error("LoroCM6.create: opts.parent is required");

  // Compartments keep read-only reconfigurable without rebuilding the state.
  const readOnlyComp = new Compartment();
  const dark = opts.theme !== "light";

  // Cmd/Ctrl-S saves through the host and never lets the WebView swallow it.
  const saveKeymap = keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: (v) => {
        if (typeof opts.onSave === "function") opts.onSave(v.state.doc.toString());
        return true;
      },
    },
  ]);

  // onChange fires on real document edits only (not selection moves).
  const changeListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && typeof opts.onChange === "function") {
      opts.onChange(u.state.doc.toString());
    }
  });

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    EditorView.lineWrapping,
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    markdown(),
    syntaxHighlighting(loroHighlight),
    loroTheme(dark),
    saveKeymap,
    // indentWithTab and closeBracketsKeymap take precedence over defaults.
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    changeListener,
    readOnlyComp.of([
      EditorState.readOnly.of(!!opts.readOnly),
      EditorView.editable.of(!opts.readOnly),
    ]),
  ];

  if (dark) extensions.push(EditorView.darkTheme.of(true));

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: opts.doc != null ? String(opts.doc) : "", extensions }),
  });

  return {
    view,
    getValue() {
      return view.state.doc.toString();
    },
    setValue(s) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: s != null ? String(s) : "" },
      });
    },
    focus() {
      view.focus();
    },
    setReadOnly(b) {
      view.dispatch({
        effects: readOnlyComp.reconfigure([
          EditorState.readOnly.of(!!b),
          EditorView.editable.of(!b),
        ]),
      });
    },
    destroy() {
      view.destroy();
    },
  };
}

// Assign the global directly (no esbuild globalName) so the bundled IIFE
// produces exactly `window.LoroCM6 = { create }` with no `.default` nesting.
(typeof window !== "undefined" ? window : globalThis).LoroCM6 = { create };
