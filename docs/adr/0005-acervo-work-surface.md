# ADR-0005 — The acervo as a work surface: external sources, habilidades, anexos

- **Status:** accepted (owner decisions, 2026-07-29)
- **Context:** up to ADR-0004 the acervo was a place knowledge *landed* (via
  the capture → fila → contexto loop). This ADR turns it into a place work
  actually *happens*: pull external material in, generate material, and keep
  it organized — all reached through the already-embedded terminal agent, and
  **without the app ever holding a credential**. It consolidates what were
  three incremental ADRs during the same iteration (external-source sync;
  custom habilidades + autoContext; content-bearing anexos, the actions rail,
  and a terminal bugfix) into one coherent record.

## Decision

### §1 `/loro-sync` — external sources into a local anexo

`/loro-sync <fonte> <alvo> <identificador>` brings an external item into the
acervo as a **local anexo file** referenced by a note. Sources: `drive`
(Gemini meeting notes on Google Drive), `slack` (a channel message), `jira`
(a ticket), `confluence` (a page).

- **No OAuth in the app (ambient-credential model, extends ADR-0004).** The
  skill runs in the embedded terminal agent, which uses *its own* connectors;
  the Loro binary never talks to these APIs and never stores a token (**BR-9**).
  Prerequisite, documented in the manual, not verifiable in code: that agent
  must already have the relevant connector authenticated.
- **Opt-in, confirmed (BR-1).** Sync only runs on explicit user action, and
  the agent must list candidates and get confirmation before attaching —
  never silently. For `drive`, the acceptance rule is title contains
  "Anotações do Gemini" **and** (parent folder is "Meet Recordings" **or** the
  doc is owned by someone else — a colleague's shared meeting exposes no
  parent folder, so the owner branch is load-bearing). The search must never
  filter by owner. An optional identifier narrows the search or passes a
  direct link.
- **Content lands in an anexo, not just a link (supersedes the original
  link-only stance).** Drive exports the full document; slack/jira/confluence
  get an agent-written summary. Each is saved as
  `brainstorming/<tema>/anexos/<slug>.md` (front-matter `fonte`/`link`/`data`)
  and the target note references that **local** file (`tipo: doc`,
  `caminho: acervo://…`) — never the external URL in `refs:`. **BR-8** holds:
  the content lives in the acervo's own working material (exactly as a meeting
  transcript already does), never in a log or manifest.
- `anchor_path`/`resolve_ref` (`acervo.rs`) still tolerate `http(s)` refs as
  external links, and `brain_open_link` opens them in the OS browser
  (`http(s)` only, never a shell) — kept as valid infrastructure even though
  the skill now prefers local anexos.

### §2 Habilidades (built-in + custom)

A **habilidade** (UI label; the code keeps the English identifier `tool`,
CLAUDE.md §6) is any `.md` in `.claude/commands/` — the filename *is* the
slash-command. Nine ship built-in (`loro-context`, `loro-analyse`,
`loro-question`, `loro-ask`, `loro-note`, `loro-sync`, `loro-tool`,
`loro-presentation`, `loro-artifact`), tracked in `BUILTIN_SKILLS`
(`acervo.rs`) and mirrored in the frontend `TOOL_BUILTINS`.

- Built-ins can be **edited but never deleted** (`brain_delete_tool` refuses
  them; the UI hides the option). Custom ones have full CRUD.
- Two ways to author a custom one: describe it to `/loro-tool` (the AI drafts
  the skill, same dual create-or-evolve shape as `/loro-note`), or import an
  existing skill file directly (`brain_new_tool`, no AI).
- `/loro-presentation` and `/loro-artifact` generate material (markdown by
  default) from a brainstorming or a context, into that world's `anexos/`.
- **Reached, never buried.** Habilidades are run from a compact picker with
  friendly names (not `loro-…`) and the selected item's description always
  visible: on the Visão Geral hero button, on a brainstorming's/meeting's `⋯`
  menu, and from the actions rail (§6). The sidebar "habilidades" section is
  collapsible; a book icon marks the *concept* (section, rail, menu), while
  file rows show origin — puzzle = built-in, star = custom.

### §3 Three folders per brainstorming; anexos in contexts too

Every brainstorming has exactly three user-facing folders — **`reunioes/`**
(every meeting is born here), **`notas/`**, **`anexos/`** (a presentation is
one kind of anexo, not a separate folder). `create_brainstorming` scaffolds
`anexos/`; `list_brainstormings` self-heals it on older acervos;
`all_parts_of` enumerates it for the consolidated report (`gather_part`'s
unknown-kind fallback routes it to Notas — no extra code).

Contexts get a first-class `anexos/` folder too, versioned with the context.
Both worlds feed it the same way, each folder carrying its own creation
action in the sidebar:

- **＋ do computador** — `brain_import_files(destRel)`: native file picker
  copies chosen files into an `anexos/` folder, guarded by
  `guarded_anexos_dir` (normalized path, rooted in `brainstorming/` or
  `contextos/`, must end in `anexos`); original filename kept, numeric suffix
  on collision.
- **＋ nova nota** — `brain_new_note_in(destRel, titulo)` for a context (the
  counterpart of `brain_new_notebook` for a brainstorming), a living-front-
  matter markdown note.

The three folders render as collapsible groups with a folder icon and count,
so the on-disk structure is legible in the UI.

### §4 `autoContext` with a real effect, as a usage-template choice

`autoContext` used to only skip the wizard's "≥1 context" validation. Now it
gates whether the `/loro-context` loop may create a **brand-new** context on
its own (never affects assigning to an existing one), read from a per-acervo
`.loro/settings.json` (distinct from the global `~/.loro/config.json`, so the
terminal agent sees only this acervo's setting).

It is chosen as the **first option of the usage-template picker**
("Automático", mutually exclusive with the verticals): Automático ⇒
`autoContext: true` + generico seeding (no predefined contexts — the loop
creates/assigns them); any vertical/genérico ⇒ manual. The picker shows each
option's explanation on select; the standalone checkbox is gone. A Settings
toggle (`brain_set_auto_context`) still flips it later.

### §5 Terminal launch bugfix

`term_open` hardcoded `claude` as the auto-launch line (broke non-default
agents) and `term_status` had no session state, so a fresh session's agent —
not yet visible to `ps` — was read as "not running" and the launch command
was re-typed into a live session. Fixed: `term_open` launches
`active_agent()`; `TermSession` records `launched_at`; `term_status` exposes a
`justLaunched` grace window (`is_within_grace`); `termRunAgent` only re-types
once that window passes.

### §6 UI patterns: one actions rail, scalable sidebar, language at creation

- **Actions rail (same everywhere).** A document viewer and a meeting surface
  both show a right-side rail with the same cards: the **habilidade** card
  (friendly-name dropdown + always-visible description + ▶ executar — the
  alvo is a fixed, read-only argument, the writable box shows the skill's
  remaining `argument-hint` tokens), **pedir à IA**, and **versionar** (on a
  context doc — same `brain_version` as the acervo header). `perguntar ao
  acervo` moved off the hero into the habilidade picker; `propor mudança`
  gained an ⓘ explaining the RFC flow.
- **Scalable brainstorming list.** Above a threshold a search box filters by
  name; without it the list caps to the most recent + "ver todos"
  (`filterAndCapTemas`, pure/tested).
- **Language at acervo creation (revises ADR-0002 §1).** ADR-0002 retired the
  per-project language and made generation follow the UI language. The wizard
  now offers an explicit language choice (pt-BR / English) when creating an
  acervo; it sets both the acervo's generation language and the UI language,
  so the whole experience matches from the first screen.

## Consequences

- **`acervo.rs`:** `BUILTIN_SKILLS` (9), `new_tool`/`delete_tool`,
  `guarded_anexos_dir`, `new_note_in`, `anchor_path`/`resolve_ref` external-
  link branch; commands `brain_new_tool`/`brain_delete_tool`/
  `brain_new_note_in`/`brain_open_link`; `create_brainstorming` +
  `all_parts_of` gain `anexos`; `list_brainstormings` self-heals it.
- **`config.rs`/`lib.rs`:** `AcervoSettings` + `write_acervo_settings`;
  `brain_set_auto_context`; `brain_import_files`; `TermSession.launched_at`,
  `TermStatus.justLaunched`, `is_within_grace`, `term_open` uses
  `active_agent()`; `brain_setup` writes `.loro/settings.json` and honors a
  per-acervo `lang`.
- **`templates.rs`:** `loro_sync_skill` (4 sources → local anexo),
  `loro_tool_skill`, `loro_presentation_skill`, `loro_artifact_skill`;
  `/loro-context` reads the `autoContext` gate; all registered in the three
  materialization sites; the rigor-rules test covers every skill.
- **Frontend:** habilidade picker/card/labels, actions rail, sidebar folder
  groups + per-folder actions + search, book/puzzle/star icons, wizard
  language + "Automático" template option.
- **BRs upheld:** BR-1 (opt-in external calls), BR-8 (no content in logs;
  content only in acervo material), BR-9 (no credentials in the app).
- **Tests:** URL-safe `anchor_path`/`resolve_ref`, `is_openable_link`,
  ref round-trips, `new_tool`/`delete_tool`, `guarded_anexos_dir`/
  `new_note_in`, `is_within_grace`, `write_acervo_settings`, the loop's
  autoContext/anexos instructions, `filterAndCapTemas`, `syncCmd`/`toolCmd`.
