# ADR-0009 — Move any file & copy its path in the brainstorming tree

- **Status:** accepted (owner decision, 2026-07-30)
- **Context:** the sidebar's ⋯ menu let a note/anexo be renamed or deleted in
  place (ADR-0003 §5), but a file could not be **relocated** without touching
  the folder on disk, and there was no way to grab a file's **path** for use in
  a habilidade prompt (`acervo://…`) or to open it in Finder/terminal. Separately,
  the brainstorming tree showed per-folder and per-tema **item counts** (pills)
  that the owner found to be visual noise in the always-expanded personal tree.

## Decision

### §1 Move a file to any folder — menu + drag-and-drop

A new command `brain_move_pessoal(rel, destDir)` moves a **file** into another
folder of the **same non-versioned world** (`brainstorming/` or `pessoal/`),
preserving the filename. It mirrors `rename_pessoal_file`'s confinement: the
versioned `contextos/` tree is off-limits on **both** ends, `..` traversal is
refused, the destination must be an existing directory, and a name clash at the
destination is **never overwritten** (`err.file_exists_in_target`). The pure
core `move_pessoal_file(base, rel, dest_dir)` is tested without Tauri.

The UI exposes it two ways (owner request):
- **⋯ menu → ⇄ mover para…** — a modal picks the destination (avulso, or any
  brainstorming's `notas/`/`anexos/`).
- **Drag-and-drop** — the drag handle is the file's **icon** (`.nico`), not the
  whole row. A draggable row makes the WebView read a slightly-moved click
  (common on a trackpad) as a drag and swallow the `click`, so single-clicking a
  file would intermittently fail to open it; keeping the row non-draggable and
  only the icon draggable makes click-to-open reliable. The icon of any movable
  file (any row carrying `data-artmenu`: note, anexo, avulso, meeting note) is
  dropped onto a folder-group header (`data-pestoggle` → `notas`/`anexos`/
  `avulso`). `reunioes/` holds meeting **folders**, not loose files, so it is not
  a drop target.

### §2 Copy a file's path — relative or absolute

The ⋯ menu gains **⧉ copiar caminho relativo** (the acervo-relative rel the UI
already holds — portable, the `acervo://` form) and **⧉ copiar caminho
absoluto**, backed by `brain_abs_path(rel)` which resolves `base.join(rel)`
guarded to the acervo root. Clipboard writes use a dependency-light helper
(`navigator.clipboard` with a hidden-textarea `execCommand` fallback) — no new
Tauri plugin.

### §3 Avulso rows get the ⋯ menu

Loose `avulso` files previously rendered as plain rows; they now carry the same
`data-artmenu` button so rename/move/copy-path/delete apply to every file in the
tree, not just notes/anexos.

### §4 The brainstorming tree drops its item counts

`renderTemaNode` (per-tema meeting count), the `avulso` header, and the three
folder groups (`reuniões`/`notas`/`anexos`) no longer render a count pill.
`folderGroupHtml` stays generic (it is shared) — the brainstorming callers pass
`0`; the **contextos** tree keeps its counts unchanged. The now-dead
`#navPessoal .pill` rule is removed.

## Consequences

- **`acervo.rs`:** `move_pessoal_file` + commands `brain_move_pessoal`,
  `brain_abs_path`; tests `move_pessoal_file_moves_between_folders` and
  `move_pessoal_file_refuses_escapes_collisions_and_versioned` (versioned world
  off-limits both ends, `..`, collision, missing destination).
- **`lib.rs`:** both commands registered in `generate_handler!`.
- **Frontend (`app.js`):** `openArtefatoMenu` gains move/copy items;
  `promptMoveFile`, `copyFilePath`, `copyToClipboard`, `pestoggleDestDir`,
  `wirePessoalDnd`; avulso rows carry `data-artmenu`; pills removed.
- **Annotation race hardening (relates to ADR-0007):** `decorateAnnotations`
  now takes the render `stale` guard (the `renderActive` renderGen) and commits
  `annotState.rel` **synchronously** before the async annotation load. The load
  is a slow IPC round-trip; switching docs during it could (a) let a superseded
  load paint/overwrite `annotState` for the previous doc — "the editor shows
  another markdown's data" — and (b) leave `annotState.rel` pointing at the old
  doc, so a highlight made on the new doc would be written to the old one.
  `paintMeetingSurface`/`renderMeetingLiving`/`refreshLivingInPlace` thread the
  guard through for the meeting living surface.
- **i18n:** new pt→en msgids for the move/copy strings.
- **BRs upheld:** BR-8 unchanged — no transcript/PII in logs; the move is a
  local FS rename inside the acervo, nothing leaves the machine (BR-1). Copying
  an absolute path places it only on the user's own clipboard, on request.
- **Not touched:** `contextos/` versioned moves (`brain_move`,
  `brain_move_context_to_acervo`) and their counts; ADR-0007 annotation
  sidecars; ADR-0008 `notas/` layout.
