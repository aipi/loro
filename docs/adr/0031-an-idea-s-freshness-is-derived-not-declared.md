# ADR-0031 — An idea's freshness is derived from its content, not declared in its meta

- Status: accepted
- Date: 2026-08-17
- Extends: ADR-0013 (the flat `brainstorming/<slug>/` world), ADR-0018 (the
  analysis IS the meeting's output — it lands in `meetings/<id>/notes/`), ADR-0022
  §7 (skills run in the chat or in the terminal), DESIGN.md §1 (state must never
  lie)

## Context

Reported from the running app, the day before a demo: *"a análise de reunião não
está funcionando"* — and, asked what the screen showed, *"roda mas não aparece na
árvore lateral"*.

The AI was never broken. Measured on the owner's real acervo:

- `chat turn finished lines=155 code=0 ok=true` in the log — the agent ran and
  answered;
- the analysis was **on disk**: `brainstorming/engenharia/meetings/2026-08-13-1437-reuniao/notes/analise-2026-08-13T144Z.md`;
- and driving `runMeetingSkill("analyse", …)` produced a *second* one.

What failed was the sidebar. The ideas tree caps its list (`PESSOAL_FILTER_THRESHOLD
= 8`) and keeps, per `brainstorm.js::filterAndCapTemas`, the most recently updated
ones plus a "ver todos (9)" row. The sort key is `atualizadoEm`, which the backend
read straight out of each idea's `meta.json`:

```rust
atualizado_em: m.atualizado_em,
```

That field is written only when the idea is created or edited **through the app**.
An analysis the agent writes into `meetings/<id>/notes/` never touches it. Measured
across all nine ideas in the acervo, the field was **empty in every one**:

```
abertura-e-fechamento  meta.atualizado_em=(vazio)   conteúdo mais novo=2026-08-14
engenharia             meta.atualizado_em=(vazio)   conteúdo mais novo=2026-08-17
… (nine of nine empty)
```

With every key equal, the comparator returns 0 for every pair, so **which eight
survive is arbitrary** — decided by input order and the category grouping, not by
recency. The idea holding the newest work (`engenharia`) was the one hidden, and
nothing the AI wrote could ever bring it into view. Two promises broke at once:
the manual's ("mostra só os mais recentes") and DESIGN.md §1's.

`atualizadoEm` has exactly **one** consumer in the whole frontend — that
comparator. It is never displayed. So it is not "the date the idea was edited"; it
is "the key that orders ideas by freshness", and it was empty.

Contexts are **not** capped (`renderCtxForest` renders the whole forest), which is
why "gerar contexto" was never affected — the same report named it, but the defect
was only ever in the ideas tree, which is where analyses land.

## Decision

**Freshness is derived from the content, and the meta is only a floor.**
`brainstorming_freshness(dir, meta_atualizado_em)` returns the newest of: what the
meta claims, and the mtimes of the idea's folder, its three groups
(`meetings`/`notes`/`attachments`, legacy names included), and **each meeting plus
that meeting's `notes/`**. A directory's mtime moves when a direct child appears,
so those levels are exactly what it takes to see an analysis land.

The meta is never *demoted*: a date the app wrote that is newer than the disk still
wins. It simply stops being the ceiling.

The scan is **shallow on purpose** — this runs on the sidebar's ~10s poll. It stats
directories only: no file is read, no audio tree is walked, and the cost is bounded
by the number of meetings, not by the number of files. Timestamps are returned as
`YYYY-MM-DDTHH:MM:SS`, which keeps the existing lexicographic comparator working
unchanged and orders finer than a date could.

## Consequences

- The ideas tree now shows the eight genuinely most recent, and an analysis lands
  the idea it belongs to at the **top** — verified in the app: `engenharia` went
  from absent to first, and opening the meeting listed both analyses.
- The cap and the "ver todos" escape are untouched; what changed is that the choice
  of which eight is now meaningful.
- `meta.json`'s `atualizado_em` stops being load-bearing for ordering. It is left
  in place (it is a floor, and other flows write it), but an empty one is no longer
  a silent loss.
- Any *other* consumer of `atualizadoEm` added later inherits a derived value. It
  is documented here as "freshness", not "when the user last edited it" — if a
  screen ever needs the latter, it must read the meta directly.

## Tests

`acervo.rs::brainstorming_freshness_sees_work_the_agent_wrote` — the key is never
empty (an empty key is what made the order arbitrary); an analysis written deep in
`meetings/<id>/notes/` moves it; a newer meta still wins; an older meta cannot hide
newer work.
