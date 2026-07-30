# ADR-0011 — Brainstorming digest into `indice.md` (`/loro-digest`)

- **Status:** accepted (owner decision, 2026-07-30)
- **Context:** a brainstorming accumulates meetings, notes and anexos, but its
  main markdown (`indice.md`) was born as an empty `# <tema>` and stayed that
  way — there was no single surface summarizing "what is in this topic". The
  owner asked for the `indice.md` to be fed with a full digest of all the
  material (summary, key points/highlights) plus an index and references, and
  to be nudged to refresh it when new material lands.

## Decision

### §1 A new built-in skill: `/loro-digest`

`loro-digest` (`.claude/commands/loro-digest.md`, pt/en via
`loro_digest_skill(lang)` in `templates.rs`) takes `brainstorming/<slug>` as its
target and (re)writes that topic's `indice.md` from scratch:

- **Body:** `# <tema>`, `## Resumo geral` (prose), `## Pontos-chave &
  highlights` (bullets), `## Índice do material` (Reuniões/Notas/Anexos, each
  item a `- [title](acervo://rel) — one-liner`).
- **Front-matter:** preserves `loro`/`id`/`tema`/`criado_em`, bumps
  `atualizado_em`, populates `refs:` (one entry per material, so the
  "Referências" panel renders), and stamps `digest_em` + `digest_itens` (the
  count of materials indexed).

It follows the existing skill contract (agent-run via the embedded terminal,
never a Rust IPC generator) and the ADR-0002 §5 rigor rules (no assumptions,
fast-model subagent scanning, cheap reading). **BR-8:** it reads the PII-free
`relatorio.md` (+ manifest `titulo`) and the notes/anexos — **never** the raw
`reuniao.md` transcript or audio.

### §2 Trigger: manual, re-runnable, with a staleness nudge

The digest is generated on demand (owner choice over auto-on-change: skills are
always user-initiated and local-first — no background LLM calls). Two entry
points, both running `/loro-digest brainstorming/<slug>`:

- The brainstorming's **⋯ menu → "atualizar índice (resumão)"**
  (`runBrainstormDigest`).
- A **staleness banner** atop `indice.md`: `maybeDigestBanner` compares the live
  material count (meetings + notas + anexos) against the stamped `digest_itens`
  via the pure `LoroBrainstorm.digestNotice` — showing "gerar índice" when there
  is material but no digest yet, or "N itens novos" when the count grew (a
  shrink/equal count stays silent). The banner's button re-runs the skill.

`digest_itens` is a deliberately simple, count-based signal: robust for the
common case (a meeting/note/anexo was added) without needing file mtimes on the
frontend. It is an advisory nudge, not a correctness gate.

## Consequences

- **`templates.rs`:** `LORO_DIGEST_SKILL`(`_EN`) + `loro_digest_skill`; the
  no-assumptions/fast-scanning sweep test covers it; a focused
  `digest_skill_targets_brainstorming_and_writes_indice` asserts the target,
  `indice.md`, the four sections, the `digest_em`/`digest_itens` stamps, `refs:`
  and the BR-8 transcript ban.
- **`acervo.rs`:** `BUILTIN_SKILLS` grows to 11 (`loro-digest.md`) so a custom
  tool can't shadow it.
- **`lib.rs`:** seeded create-if-absent in all three points
  (`ensure_acervo_structure`, the migration scaffolding, `ensure_meeting_skills`);
  the structure test asserts it lands on disk.
- **Frontend (`app.js`):** `TOOL_BUILTINS` + `TOOL_PICKER_EXCLUDE` (its own ⋯
  action, not the generic per-file picker); `runBrainstormDigest`,
  `maybeDigestBanner`; `brainstorm.js` gains the pure `digestNotice` (+ tests).
  The front-matter parser (`refs.js`) already reads `digest_em`/`digest_itens`
  generically — no parser change.
- **`style.css`:** `.digest-banner` (a quiet amber bar — the brainstorming
  world's colour).
- **BRs upheld:** BR-1 (the digest is a local skill run; nothing leaves the
  machine without action), BR-8 (no transcript/audio/PII — report-derived only).
- **Not touched:** the fila/report flow (`brain_brainstorm_build_report`), the
  ADR-0007 annotation layer, ADR-0008 `notas/` layout.
