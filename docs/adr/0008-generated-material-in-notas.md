# ADR-0008 — Skill-generated material lives in the meeting's `notas/`

- **Status:** accepted (owner decision, 2026-07-30)
- **Context:** ADR-0012 had the meeting skills write their output into a fixed
  `reunioes/<id>/artefatos/<kind>/` subtree (`investigacoes/`, `respostas/`, …),
  and even older acervos still carried bare `investigacoes/`, `perguntas/`,
  `respostas/`, `relatorios/` folders. In practice this fragmented "where did my
  analysis go?" across several kind-named folders (seen in existing acervos such
  as `turbo`, `xpto`), which is friction, not structure. The owner's call: a
  skill-produced document **is a note** — it should land in one predictable
  place, `notas/`.

## Decision

### §1 Every skill-generated document goes to the meeting's `notas/`

`loro-analyse` writes `reunioes/<id>/notas/analise-<ISO>.md`; `loro-question`
writes `reunioes/<id>/notas/<slug>.md`; the same holds for any document a
habilidade produces about a meeting (including the excerpt-scoped runs from
ADR-0007). There is no `artefatos/<kind>/` subtree any more — one flat `notas/`
folder per meeting. `relatorio.md`, `manifest.json`, `marcadores.jsonl`,
`auditoria.jsonl` and `reuniao.md` remain meeting-root files as before; the
report is still folded from `relatorio.md` + PII-free markers (`gather_part`
unchanged), so a marker's `ref` now points at `notas/…`.

This supersedes ADR-0012's artefatos subtree for generated material. Brainstorming-
and context-level generators (`/loro-presentation`, `/loro-artifact`) keep
writing to that world's `anexos/` (ADR-0005 §3) — a presentation/artifact is a
deliverable attached to the world, not a meeting note; only the meeting skills
move.

### §2 Legacy folders self-heal into `notas/`

Listing a brainstorming's meetings migrates each meeting non-destructively: the
files under any legacy `artefatos/`, `investigacoes/`, `perguntas/`,
`respostas/`, `relatorios/` folder are **moved** (flattened, deduped on name
collision — never overwritten) into `notas/`, and the now-empty legacy folders
are removed. No explicit "migrate" command — the same self-heal spirit as the
ADR-0005 brainstorming-subfolder backfill. Existing acervos (`turbo`, `xpto`, …)
are fixed on first open.

## Consequences

- **`templates.rs`:** `meeting_analyse_skill` / `meeting_question_skill` (pt+en)
  write into `notas/` and cite ADR-0008; the marker `ref` and the audit `wrote`
  example follow; the meeting-skills test asserts `notas/…` and the absence of
  the old artefatos paths.
- **`acervo.rs`:** `migrate_meeting_to_notas` (+ `move_files_flat`,
  `dir_has_files`, `next_free_name`), invoked from `list_meetings`; test
  `list_meetings_migrates_legacy_artefatos_into_notas` covers move + dedup +
  legacy-folder removal + real-file survival.
- **Frontend:** `fillMeetingChild` and `listArtefatos` read the meeting's flat
  `notas/`; the "perguntar" modal copy points at the meeting notes.
- **BRs upheld:** unchanged — BR-8 (generated content is acervo material, never
  a log) still holds; this only moves *where* inside the acervo it lands.
- **Not touched:** ADR-0005 `anexos/` for `/loro-sync`, `/loro-presentation`,
  `/loro-artifact`, and the computer/nota imports; ADR-0007 annotation sidecars.
