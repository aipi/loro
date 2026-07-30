# ADR-0007 — Annotation layer: highlights, comments, and per-excerpt habilidades

- **Status:** accepted (owner decision, 2026-07-30)
- **Context:** ADR-0005 turned the acervo into a work surface, but every
  habilidade still acts on a whole file (`alvoRel = tab.rel`), rendered markdown
  is not even selectable (`user-select: none` on `body`, never re-enabled on
  `.doc`/`.mtg-doc`), and there is nowhere to mark up a transcript. Meetings and
  brainstorms produce insight at the level of a *passage*, not a file — an idea
  surfaces mid-meeting and it lands on a specific stretch of transcript. This
  ADR adds a document-wide annotation layer — highlight a passage, comment on
  it, and run a habilidade scoped to it (including asking a person/channel on
  Slack) — uniform across every markdown (meeting transcript, context, note,
  anexo).

## Decision

### §1 Annotations live in a co-located sidecar, anchored by quote

Annotations are **not** written into the markdown. A meeting transcript is
append-only and read-only (ADR-0010); inline marks would break inline
formatting that spans element boundaries and would collide with concurrent
edits. Instead each document gets a co-located sidecar `<doc>.anotacoes.json`
(e.g. `reuniao.md` → `reuniao.anotacoes.json`), versioned with its content
(**BR-8**: content stays in the acervo's own working material, never a log or
manifest — exactly as the transcript already does).

One record models both features — a highlight with an empty `comentarios` list
is just a highlight:

```jsonc
{ "doc": "brainstorming/x/reunioes/<id>/reuniao.md",
  "anotacoes": [
    { "id": "an_ab12", "tipo": "grifo", "cor": "amarelo",
      "anchor": { "quote": "…", "prefix": "…", "suffix": "…" },
      "comentarios": [ { "autor": "…", "texto": "…", "em": "2026-07-30T…" } ],
      "criadoEm": "…", "atualizadoEm": "…" } ] }
```

The anchor stores the **quoted text plus up to 40 chars of prefix/suffix
context** (the W3C Web Annotation / hypothes.is text-quote model), never an
absolute offset. It survives re-render and — because the transcript is
append-only — survives live appends: earlier text never shifts, so an anchor
placed during the meeting stays valid as new lines arrive.

### §2 Painting the exact span at render time

Offsets are computed against the container's rendered `textContent`, then the
range is wrapped in `<mark data-annot-id>` by walking text nodes — the same
`TreeWalker` technique already proven by the ⌘F highlighter (`runFind`),
generalized into a reusable `paintRange(container, start, end, attrs)`. In the
CM6 edit view the same range becomes a native decoration.

Locate order is **exact → fuzzy-near-context → orphan**: a passage that can no
longer be found (the doc was edited and the quote is gone) is never dropped
silently — it is preserved in the sidecar and listed as a *trecho órfão* in the
comments panel (nothing by accident, CLAUDE.md §7).

### §3 Excerpt-addressable habilidades

The alvo generalizes from a whole file to `acervo://<rel>#<annot-id>`.
`resolve_ref` already parses `acervo://…`; its resolution gains an optional
`#<fragment>` that carries the annotation id through to the habilidade, which
reads the sidecar, obtains the quoted excerpt, and injects it **evidenced** into
its context. Existing `loro-question` and `loro-analyse` gain nothing but a more
precise alvo — no new invocation mechanism, still a slash-command typed into the
embedded terminal agent. The excerpt text never travels on the command line
(only the `#id` ref does), so multiline selections are safe and the terminal
history stays clean.

### §4 Slack is an outbound habilidade, not app code (BR-9)

"Send this excerpt as a question to a channel/person" is a new built-in
`loro-slack`, the outbound mirror of `/loro-sync slack`. The Loro binary holds
no Slack credential and makes no Slack call; the embedded terminal agent sends
the message through *its own* connector (ambient-credential model, ADR-0004/
0005). It runs only on explicit user action from the selection popover
(**BR-1**), taking a channel/person as its `argument-hint` and the excerpt as
its alvo. Prerequisite, documented in the manual and not verifiable in code:
that agent must already have its Slack connector authenticated.

### §5 UI: selection popover + one annotation surface

Selecting text in any markdown view raises a floating popover with the same
actions everywhere: **grifar · comentar · perguntar · analisar · Slack**.
Highlights render persistently with a remove toggle (*desgrifar* — as in real
life). Comments show in a margin (read view) and gutter (edit view) and gather
per document in a panel ("reunir os comentários"). The habilidade actions reuse
the ADR-0005 actions rail with an excerpt alvo instead of the file alvo.
`body`'s `user-select: none` is overridden to `text` on `.doc` and `.mtg-doc`
so passages can be selected in the first place.

## Consequences

- **New IPC:** `brain_annotations_get { rel }`, `brain_annotation_add { rel,
  anotacao }`, `brain_annotation_update { rel, id, patch }`,
  `brain_annotation_delete { rel, id }`; `brain_resolve_ref` carries an optional
  `#<annot-id>` fragment.
- **`acervo.rs`:** annotation read/write/delete into `<doc>.anotacoes.json`,
  path-guarded like `guarded_anexos_dir` (normalized, rooted in the acervo, the
  sidecar sits beside an existing `.md`); a stable `an_…` id generator.
- **Frontend:** new pure module `src/annotate.js` (`window.LoroAnnotate`:
  `makeAnchor`, `locate`, and — browser-only — `paintRange`); the ⌘F walker
  refactored to share `paintRange`; selection popover + margin/panel; CM6
  decorations; selection re-enabled in `style.css`.
- **`templates.rs`:** `loro_slack_skill` (pt-BR + English), registered in the
  three materialization sites; `BUILTIN_SKILLS` 9 → 10, mirrored in the frontend
  `TOOL_BUILTINS`, `TOOL_LABELS`, and the picker-exclude set as appropriate; the
  rigor-rules test covers it.
- **BRs upheld:** BR-1 (Slack send is an explicit, confirmed action), BR-8
  (quoted excerpts live in the acervo's own material, never in logs), BR-9 (the
  app never holds a Slack credential — the agent's connector sends).
- **Tests:** anchor cross-format / duplicate-quote / append-ahead / orphan
  (`node --test` in `tests/annotate.test.js`); annotation round-trip + path
  guard + BR-8 (`cargo test` in `acervo.rs`); `loro-slack` rigor-rules test.
- **Deferred / GUI-verification debt:** the popover, mark painting, CM6
  decorations, and the outbound Slack connector prerequisite are GUI/agent
  behaviors not covered by automated tests — recorded as verification debt, as
  ADR-0005 did for its terminal bugfix.
