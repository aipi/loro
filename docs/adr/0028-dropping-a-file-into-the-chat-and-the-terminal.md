# ADR-0028 — A file dropped on the chat or the terminal pastes its path

- Status: accepted
- Date: 2026-08-17
- Extends: ADR-0020 (one anatomy — the right panel holds Documento · Chat ·
  Terminal), ADR-0021 (the chat runs the acervo's own agent CLI; the terminal is
  a login shell that launches it), ADR-0024 (intake triage: the fila's door is
  one-way), ADR-0026 (a surface paints only where it is looked at)

## Context

The window already accepted files dropped from the system, and it had exactly
**one** destination: the active acervo's fila (`brain_import_paths`). The whole
of that behaviour was one guard and one call:

```js
listen("tauri://drag-drop", async (e) => {
  if (!brainTab) return;
  …brain_import_paths…
});
```

So the two surfaces where the user actually talks to the agent — the **Chat**
tab and the embedded **terminal**, both in the right panel — were dead to a
drop. Dragging a file over either one produced the OS copy cursor (wry answers
`NSDragOperation::Copy` for the whole webview) and then nothing: on the acervo
tab the file silently entered the fila instead, and anywhere else the handler
returned early. The interface accepted the gesture and dropped it.

That is the one gesture the agent CLIs are built around. A path in the prompt is
how an image, an audio file or a PDF becomes context — the user's own words:
*"essa funcionalidade do Claude Code é muito boa, ele cola o path do arquivo no
chat para usar como contexto."* Without it the alternative is to leave the app,
copy the path in Finder/Explorer and paste it back by hand.

Three things stood between the gesture and the behaviour:

1. **HTML5 drag-and-drop cannot do this.** Inside a webview a dropped `File`
   object has no filesystem path, and Tauri exposes no path-from-`File` API. The
   real path only arrives on the native `tauri://drag-drop` event. Turning the
   webview's `dragDropEnabled` off to get HTML5 events would trade the path away
   for nothing.
2. **The native event carries a position, and its unit is not portable.** Tauri
   types it `PhysicalPosition`, but nothing scales it: on macOS it comes from
   `NSDraggingInfo.draggingLocation` (points) and on Linux from GTK (logical) —
   already CSS pixels — while on Windows it comes from `ScreenToClient` (device
   pixels). Dividing by `devicePixelRatio` unconditionally lands the hit-test in
   the middle of the screen on a Retina display; never dividing misses on
   Windows at 150%.
3. **Only one destination was reversible.** The fila is a versioned, one-way door
   (ADR-0024): what enters is triaged and goes to git. Pasting text is not.

## Decision

**The place of the drop names the destination.** One router, three destinations,
and the two new ones only ever produce **text**:

| Dropped on | What happens |
|---|---|
| `#panelChat` (thread or composer) | the path is inserted into `#chatInput` **at the cursor** |
| `#termPanel` (side or bottom dock) | the path is typed into the PTY via `term_input` |
| anywhere else | unchanged — the fila of the active acervo, `brainTab` guard and all |

The decision is a pure function of the hit element (`dropDestination`), so it is
exercised for real under `node --test` without a DOM. `dropDestinationAt`
converts the event position once (`dropPointCss(pos, devicePixelRatio, hostOs)` —
dividing **only** on Windows, per the unit analysis above) and hands
`document.elementFromPoint` the result, which settles overlap and z-order for
free.

**Nothing is imported and nothing is executed.** The path reaches the terminal
**without a trailing `\n`**: the terminal runs the project's agent, and firing a
command by accident has no undo. The fila's own door keeps its own guard — the
`_prompt.md` refusal (ADR-0024) stays on the fila branch, because the branches
that paste text never touch the acervo.

**A path has to survive its reader, and the two readers differ.** The terminal's
reader is a *shell* (`zsh` on unix, `cmd.exe` via `COMSPEC` on Windows — see
`term_open`), where an unquoted space splits the path into two arguments;
`quoteDropPathShell` single-quotes (literal in zsh, embedded `'` closed and
reopened) and double-quotes on Windows, where single quotes mean nothing. The
composer's reader is the agent CLI receiving a *prompt string* — no shell, so
only whitespace is ambiguous and `quoteDropPathPrompt` quotes just that. Quoting
a `$` in a prompt would only add noise.

**The highlight names the surface that will receive.** There was one highlight
(`#app.dropping`, the fila's) and it lit up with the pointer over the chat —
the state promising the wrong destination (DESIGN.md §1). `paintDropTarget`
owns all three, `tauri://drag-over` is now listened to so the highlight follows
the pointer instead of freezing on the destination it entered by, and
`DROP_MARKS` is the single map the tests hold the router against: a destination
without a highlight is the same defect as a highlight without a destination.

**A closed terminal says so.** After `term-exit` the PTY is gone and
`term_input` would vanish in silence, so the drop refuses out loud
(*"o terminal não está rodando — use «reiniciar»"*).

## Consequences

- Dropping a file on the acervo tab **outside** the panel behaves exactly as
  before; the fila keeps its triage and its one-way door.
- The chat and the terminal accept multiple files at once — one line, one quote
  rule per destination, space-separated.
- The insertion behaves like a paste: it lands at the cursor, does not glue
  itself to the previous word, ends with a space, and fires `input` so the
  composer grows (ADR-0020's composer).
- `#panelDoc` and the markdown editor are **not** destinations. A path is not
  what a document wants; if that changes it is a separate decision.
- The hit-test depends on `hostOs`, which arrives from the backend
  (`std::env::consts::OS`) after boot. A drop before that lands with the macOS
  default — worst case, one drop routed to the fila on Windows.

## Tests

`desktop/tests/drop-context.test.js` — the router names each destination
(including the two degenerate hits); the position converts per OS; both quote
rules, including the embedded quote and the Windows backslash; the handler routes
before importing and the fila branch keeps `splitQueueGuideDrop`; the terminal
branch contains no `\n`; the paste lands at the cursor with and without a
preceding space; the highlight covers exactly the router's destinations and is
cleared on drop and on leave. `state-truth.test.js` C6 still holds the
`_prompt.md` refusal on the same handler.


---

## Extension — a folder of the tree is a fourth destination (2026-08-18)

«Ao arrastar um arquivo do meu computador para dentro da árvore, quero mover esse arquivo
para o destino, como é possível fazer no vscode.» The router this ADR built already answers
the only question that matters — **the place of the drop decides** — so the change is one
more answer, not a new mechanism: `dropDestination` returns `pasta:<rel>` when the pointer
is over a row that declares itself a folder.

### The gesture means different things in the two places, and that is the decision

Every import door in Loro **copies** (`import_into_inbox`, `brain_import_files`: `fs::copy`,
never overwriting). The owner asked for **move**, and after the trade-off was named the
decision (2026-08-18) was:

- **onto a FOLDER of the tree → MOVE.** Dropping into a folder of the cabinet is *filing*,
  which is what a file manager does on one disk: the original leaves. The toast says so —
  «N → pasta · o original saiu de ~/Desktop» — because a move has no undo here.
- **onto the FILA → COPY**, unchanged. There the gesture means «hand this to the AI», and
  the original stays the person's.

### What declares itself a drop target, and why that list is one line

`folderGroupHtml` already received the folder's `rel` (for the path menu), so every folder
group in the tree — an idea's *notas*/*anexos*, a topic's *anexos* — became a target at once.
Plus three rows that ARE folders: an idea (→ its `attachments`), a knowledge topic (→ its
`attachments`, the same door «＋ do computador» opens) and a **loop** (→ its own folder). A
group without a real folder passes no `rel` and does not pretend to receive.

The highlight moved with it: the row itself lights (`.droprow`), and the fila's highlight no
longer promises a destination the drop will not take (DESIGN.md §1).

### Two refusals come before the first move, because a move has no undo

- **a source already inside the acervo** is the other door (`move_pessoal_file`, which knows
  the worlds and rewrites inbound refs) — `err.drop_from_inside`;
- **a credential heading for the versioned tree** is refused for the whole batch
  (ADR-0024/BR-9) — scanned BEFORE anything moves, because afterwards the bytes are no
  longer where they were.

Destinations are one rule (`acervo::guarded_drop_dir`): any folder of a non-versioned world
(`brainstorming/`, `pessoal/`, `loops/<slug>/`) plus `contexts/**/attachments`. `inbox/` is
refused by name — the fila has its own door, and it copies. Cross-volume drops fall back to
copy+remove, so a file from an external disk still files.

### And the harness grew two guards

`__SMOKE__.fire` plus the row's real coordinates let the smoke drive the actual Tauri event
through `elementFromPoint`, which is what decides the destination — the only way to know the
drop lands where the person aimed. And the smoke now **compiles the STUB and the DRIVER
before opening Chrome**: they live inside template literals, so `node --check` never saw
them, and a syntax error there printed «o driver não chegou ao fim» — which reads like an app
defect. It happened twice in one day (a backtick inside a comment; a `\/` that the template
literal collapsed into `//`, commenting out the line). It now names the error.
