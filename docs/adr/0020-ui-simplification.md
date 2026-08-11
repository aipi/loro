# ADR-0020 — UI simplification: one anatomy, three destinations, deliberate removals

- Status: accepted
- Date: 2026-08-11
- Supersedes: ADR-0011 (brainstorming digest — **revoked**)
- Amends: ADR-0001 §10 (theme), ADR-0008 (no pinned Home tab), ADR-0013 (the 1·2·3 flow bar)
- Unchanged: ADR-0007 (annotations), ADR-0009 (move/copy path), ADR-0016 (markdown bar)

## Context

The interface required prior knowledge to be usable: the flow was explained
three times over (a numbered nav, an explanatory 1·2·3 strip, a set of `ⓘ`
tooltips), the vocabulary was internal (*acervo*, *brainstorming*, *fila*,
*contextos*, *habilidades*), and the home screen competed with itself — four
statistics, a frequency chart, an activity feed and a GitHub card, none of
which answered a question a non-expert user actually asks.

The design ruler was Don Norman: **affordances and signifiers instead of
little signs**. Wherever the UI needed an `ⓘ` to be understood, the element was
replaced by a pattern the world has already taught.

## Decision

### 1. One anatomy, in every screen

```
HEADER 54px — [logo + project ⌄] [nav pill] ······ [Record] [✦ AI]
SIDEBAR 250/60px │ TABS (only when a document is open) │ PANEL 330px
                 │ CONTENT                             │ Document·Chat·Terminal
```

Inviolable rules, encoded in `shell.js` and the `.bshell` grid:

1. The tab strip starts **to the right of** the sidebar; the sidebar reaches
   the header.
2. **There is no "Home" tab** — tabs are open documents only. Home/Organize/
   Knowledge are destinations of the header nav pill. The Home tab still exists
   inside `ws` as the "nothing open" state, but is never drawn.
3. The sidebar collapse control sits **at the bottom**, beside ⚙ Settings.
4. **One primary action per screen** (a single filled button).
5. **No explanatory `ⓘ` tooltips** and no numbered labels in navigation.
6. **✦ AI** toggles the right panel; active state is a 12% teal fill.
7. **Record comes before ✦ AI** in the header.

### 2. Simplified vocabulary

Internal terms survive in code, IPC and on disk; they stop being a
prerequisite for using the app.

| Internal | UI |
|---|---|
| acervo | projeto |
| brainstorming | ideias |
| fila → contexto | para organizar |
| contextos | conhecimento |
| habilidades | ações de IA |
| versionar (commit) | salvar versão |
| propor mudança (RFC/PR) | enviar para revisão do time |
| promover | juntar a um conhecimento |

### 3. Selectable theme with warm dark tokens

`data-theme` on `<html>` replaces `prefers-color-scheme`. The preference is
`light | dark | system`; **`system` is resolved in JS** to `light`/`dark` and
written to the attribute, so the stylesheet only ever knows two real states.
The dark palette is warm (`#211e19`, `#2a2620`, `#26231d`), not the previous
cool grey `#121719`. The embedded terminal is dark in both themes (`#26231d`).

### 4. Deliberate removals

These leave the UI **and** the code, so their absence does not read as an
oversight:

1. **Brainstorming digest — revokes ADR-0011.** `/loro-digest`, the "atualizar
   índice (resumão)" ⋯ entry, `runBrainstormDigest` and the `maybeDigestBanner`
   staleness nudge. The digest competed with reading the material directly, and
   "stale index" needed explaining — exactly the kind of sign this redesign
   removes. Existing `indice.md` files stay in the acervo as ordinary
   documents; `LoroBrainstorm.digestNotice` remains in `brainstorm.js` as a
   pure helper with no caller.
2. **Typed meeting markers.** The three kinds (dúvida/decisão/investigação)
   become a single **✎ Marcar momento** (`⌘⌥M`); `brain_meeting_marker` now
   always receives `tipo: "momento"` and `⌘⌥1/2/3` are retired. Choosing a kind
   mid-meeting was friction; the value is in anchoring the instant.
3. The **four home statistics** (na fila · processadas · contextos · fontes).
4. **"Contextos mais ativos"** (frequency bars).
5. The **"atividade do loop"** feed.
6. The **explanatory 1·2·3 strip** — the flow became the three nav destinations.
7. The home **`ghCard`** — environment checks moved to Settings → Versions and
   GitHub. **Exception:** `brain_notifications` does not disappear; it becomes
   the dismissable strip at the top of Knowledge (screen 1c).
8. All **`ⓘ` tooltips** — if an element needs "what is this?", the problem is
   its name.

Shared justification for 3–8: each competed with its screen's primary action
and none answered a question a non-expert user asks. Items 3–5 are diagnostic
information, still reachable from Knowledge and each document's timeline.

### 5. What explicitly does NOT go

- **Annotations (ADR-0007)** — they gain surface instead: selection popover and
  anchored comments on the document (1d), highlights on the transcript (1f).
  `annotate.js`, `.annotatable` and `acervo://<rel>#<annot-id>` are untouched.
- The **full ⌘K palette** — now the single palette (files *and* commands,
  grouped *ir para · gravar · criar · documento · fazer*), kept as the living
  documentation of every shortcut. ⌘P/⌘⇧P remain as legacy aliases.
- Copy path, branch-first, migrate acervo, new notebook, the queue controls
  (`importCtx` / `queueSaveAnexos`), chat model+effort, the chat's permission-denial flow (recorded in ADR-0021).

## Consequences

- New frontend module `desktop/src/shell.js` owns the chrome (theme,
  destinations, sidebar collapse, panel, terminal dock). It is DOM-only: it
  knows nothing about IPC, acervo or transcription.
- New persisted UI state (`localStorage`, `DEFAULTS` in `app.js`): `theme`,
  `sidebarCollapsed`, `aiPanelOpen`, `aiPanelTab`.
- New IPC command `brain_set_agent` — the AI agent command was only settable at
  creation; Settings → "IA e terminal" now edits it for the active acervo.
- The terminal has two mount points (`#panelTerm`, `#termDock`); `⇆` moves the
  same `#termPanel` element between them and refits xterm.
- `mdInline` marks the operator's speaker label with `.spk--me` so the
  transcript can colour "você" and the other channels differently.
- i18n gains the redesign's msgids; the digest and typed-marker strings are gone.
