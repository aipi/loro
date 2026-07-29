# ADR-0006 — Custom user tools, `/loro-sync` beyond Drive, `autoContext` with a real effect

- **Status:** accepted (owner decision, 2026-07-29)
- **Context:** three related asks came in together. (1) The owner wanted the
  reunião-sync flow from ADR-0005 to also cover Slack (by channel), Jira (by
  ticket) and Confluence (by page), and to be reachable from the Visão Geral,
  not only from inside a brainstorming. (2) Advanced users want to author
  their own skills ("tools") without touching the filesystem by hand, listed
  and managed from the app. (3) `autoContext` — a wizard toggle promising
  "let the loop create/organize contexts on its own" — turned out to do
  nothing beyond skipping a setup validation; turning it off later would
  have been a silent no-op.

## Decision

### §1 `/loro-sync` grows to slack/jira/confluence

Same command shape as ADR-0005 (`/loro-sync <fonte> <alvo> <identificador>`),
three new branches in the skill prompt (`templates.rs`, `loro_sync_skill`):

- **slack** — identifier is the channel name (required). The agent reads
  that channel's recent/pinned messages via its own Slack connector, lists
  candidates for confirmation, and records `tipo: slack`, `caminho: <the
  message's permalink>` — never the message text.
- **jira** — identifier is the ticket key or a direct link (required). Fetched
  by key via the Atlassian/Jira connector, confirmed by title/status before
  attaching, `tipo: jira` — never the description/comments.
- **confluence** — identifier is the page's exact title or a direct link
  (required). Searched by title if not a link, confirmed if ambiguous,
  `tipo: confluence` — never the page body.

No Rust changes were needed for these three: `anchor_path`/`resolve_ref`
already treat any `http(s)` `caminho` as an external link (ADR-0005 §3),
regardless of the `tipo` string stored alongside it.

**Visão Geral card:** a new "🧰 ferramentas" card lists all four sync
sources as buttons; without a brainstorming already open, the modal also
asks which one to target (`brain_list_brainstorms`). The pre-existing
per-brainstorming "⇄ sincronizar reunião" button keeps its Drive-only,
tema-preset shortcut — both routes share one `promptSyncTool(fonte, slug?)`.

### §2 Custom tools: any `.claude/commands/*.md` outside 7 built-ins

No new naming convention was invented: the filename already IS the
slash-command (Claude Code discovers every `.md` under `.claude/commands/`).
A **tool** is simply any such file that is not one of the 7 built-ins
(`loro-context`, `loro-analyse`, `loro-question`, `loro-ask`, `loro-note`,
`loro-sync`, `loro-tool`) — tracked as `BUILTIN_SKILLS` in `acervo.rs` and
mirrored in `app.js`'s `TOOL_BUILTINS` (keep both in sync).

Two ways to create one, per the owner's explicit "pode ser os dois" — a
user may already have a skill written elsewhere:

- **AI-drafted** — `/loro-tool <descrição>`: a new meta-skill, same
  create-or-evolve dual shape as `/loro-note` (first token an existing
  `.claude/commands/*.md` → evolve; otherwise the whole argument is a
  description → the agent derives a kebab-case name, refusing the 7
  reserved ones, and writes the file itself).
- **Imported** — a "colar skill existente" modal in the sidebar writes the
  pasted content directly via the new `brain_new_tool(nome, conteudo)`
  command; no AI involved, non-destructive (suffix on collision, mirrors
  `new_notebook`).

Deletion is scoped tight: `brain_delete_tool(rel)` only accepts
`.claude/commands/*.md` paths outside `BUILTIN_SKILLS` — it can never remove
a built-in skill or reach outside that folder.

**UI:** a new sidebar section ("🧰 ferramentas", parallel to
Brainstorming/Contextos) lists tools with a `⋯` menu — usar / editar (opens
the raw file, same editor as any note) / pedir à IA (`/loro-tool <rel>
<pedido>`) / excluir. The same list feeds "usar" buttons on the Visão Geral
card and a "🧰 ferramentas…" entry in a meeting's `⋯` menu — one list, three
places it can be triggered from, per the owner's explicit requirement.

### §3 `autoContext` gains a real, reversible effect

Previously: `auto_context` only skipped `brain_setup`'s "must define ≥1
context" validation; nothing at runtime consulted it afterward (confirmed by
grep — no other read site existed). The wizard label ("deixar o loop criar e
organizar os contextos") was aspirational, not implemented.

Now: a per-acervo local marker, `.loro/settings.json` (`{"autoContext":
bool}`) — distinct from the global `~/.loro/config.json`, which lists every
acervo and should not be exposed wholesale to a terminal agent scoped to
one acervo. Written by `brain_setup` (create and edit) and by a new
`brain_set_auto_context(value)` command wired to a Settings toggle, so the
choice isn't locked in at creation time (the owner's explicit ask).

The `/loro-context` loop skill (`templates.rs`) now reads that marker
before creating a context that doesn't yet exist: `true` (default, and now
the wizard's default too) creates/assigns freely, exactly like before;
`false` leaves the unmatched item pending in `inbox/` and reports that it
needs a manually-assigned context, instead of assuming one. Assigning to an
**existing** context (via a `<contexto>--` prefix or a fit found by the
loop) is unaffected either way — this setting only gates creating something
brand new.

## Consequences

- `acervo.rs`: `BUILTIN_SKILLS`, `new_tool`, `delete_tool`,
  `brain_new_tool`, `brain_delete_tool`.
- `config.rs`: `AcervoSettings`, `write_acervo_settings`.
- `lib.rs`: `brain_set_auto_context`; `brain_setup` now also writes the
  local marker; `.claude/commands/loro-tool.md` joins the other 6 in all
  three skill-materialization sites.
- `templates.rs`: `loro_sync_skill` grows 3 branches; new `loro_tool_skill`;
  `brain_skill` (`/loro-context`) gains the `autoContext` gate.
- Frontend: `promptSyncTool` generalized (4 sources, optional tema-select);
  new "🧰 ferramentas" sidebar section + Visão Geral card entries + meeting
  menu entry; wizard toggle repositioned and now defaults on; Settings
  gains the toggle.
- Tests: `new_tool_*`/`delete_tool_*` (acervo.rs), `write_acervo_settings_*`
  (config.rs), `loop_skill_respects_auto_context_setting` (templates.rs),
  `toolCmd`/`newToolCmd` (brainstorm.test.js).
