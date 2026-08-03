# ADR-0014 — The fila receives the real selected files, not a consolidated report

- **Status:** accepted (owner decision, 2026-08-03)
- **Supersedes:** the ADR-0013 "brainstorming → fila" consolidation step (the
  single merged `relatorio.md`). The rest of ADR-0013 (the three-stage
  Brainstorming → Fila → Contexto flow, the `inbox/` queue, `/loro-context`)
  stands.
- **Context:** "enviar para a fila" always sent the **same** artifact — a single
  consolidated `relatorio.md`. The two-step path was
  `brain_brainstorm_build_report` (distil the selection into ONE hygienised
  report under `anexos/`, extracting only Resumo/Decisões/Dúvidas/Investigações/
  Dados from each meeting's `relatorio.md`) → `brain_send_report_to_queue` (copy
  that one report into `inbox/`). Consequences the owner hit: (a) the actual
  meeting/analysis/note the user wanted to feed to context never reached the
  queue — only a summary of it did; (b) selecting several parts fused them into
  ONE queue item instead of queueing each; (c) the queue always showed a
  "relatorio" and nothing else. The owner wants to **choose the file(s)** to send
  and have each one enter the processing queue on its own.

## Decision

### §1 One queue item per selected file — no consolidation

`brain_send_files_to_queue(rels[], destContext?)` copies each selected
brainstorming file into `inbox/` **as itself** — one queue item per file. The
`/loro-context` loop then distils each entry independently. There is no
consolidated report anymore; `brain_brainstorm_build_report`,
`build_brainstorm_report`, `assemble_brainstorm_report`, `gather_part`,
`extract_section*`, `SelItem` and `brain_send_report_to_queue` are removed.

Selection already happens at file granularity in the tree (notes, attachments and
each meeting's analyses are individual checkboxes). The frontend maps each
selection to its real file via the pure `LoroBrainstorm.queueRelForSelection`,
then calls the batch command.

### §2 A meeting is queued as its `relatorio.md` (BR-8 upheld)

A meeting's checkbox resolves to that meeting's own `relatorio.md` — the
report/analysis, PII- and transcript-free. The raw living notebook `reuniao.md`
(which carries the transcript), the content-bearing `auditoria.jsonl` and any
audio **never** enter the fila. The guard is the pure `acervo::is_queueable`
(text-only `.md`/`.txt` **and** leaf is not `reuniao.md`/`auditoria.jsonl`;
audio/`.jsonl` are already excluded by the text-only gate). Owner decision
(2026-08-03): the raw meeting is **not** queueable — the report represents it.

### §3 Collision-free queue names, transactional batch

The inbox filename is the brainstorming-relative path flattened `/`→`-`
(`acervo::queue_name_for`), e.g.
`brainstorming/frota/reunioes/r1/relatorio.md` → `frota-reunioes-r1-relatorio.md`,
so two files sharing a basename (two meetings' `relatorio.md`) never overwrite
each other. A `destContext` still steers via the `<ctx>--` prefix
(`import_name`). The batch **validates every entry before writing any** — a bad
rel (outside `brainstorming/`, non-text, transcript, traversal) fails the whole
call with no partial queue.

### §4 "enviar tudo → fila"

The brainstorming's ⋯ menu action (was "gerar relatório de tudo → fila") becomes
"enviar tudo → fila": `brain_send_brainstorm_to_queue(slug, destContext?)`
enumerates every queueable file via `acervo::queueable_files` (each meeting's
`relatorio.md` and its `notas/` analyses + the topic's `notas/`/`anexos/`,
excluding transcript/audio and legacy `*-relatorio.md`) and sends each as its own
item.

## Consequences

- **`acervo.rs`:** removed the whole consolidated-report machinery; added the
  pure `is_queueable`, `queue_name_for`, `queueable_files` (+ tests:
  `is_queueable_blocks_transcript_audio_audit_only`,
  `queue_name_for_flattens_path_and_is_collision_free`,
  `queueable_files_lists_real_files_excluding_transcript_and_legacy_report`).
  `MeetingManifestLite`/`content_of`/`base64_encode` stay (other callers).
- **`lib.rs`:** `brain_send_report_to_queue` replaced by
  `brain_send_files_to_queue` + `brain_send_brainstorm_to_queue`, sharing
  `resolve_queue_entry`; registered in the invoke handler.
- **Frontend (`app.js`):** `sendFilesToQueue`, `sendBrainstormAllToQueue`,
  rewritten `sendSelectionToQueue`; the meeting ⋯ "enviar para a fila" and the
  brainstorming ⋯ "enviar tudo → fila" call the new commands; the selection-bar
  CTA copy updated. `brainstorm.js` gains the pure `queueRelForSelection`
  (replacing `reportInboxName`); STAGES "fila" hint reworded (parts→files).
- **i18n:** new `err.queue_brainstorming_only`, `err.transcript_not_queueable`,
  `err.queue_empty_selection`; `enviar tudo → fila`, the per-file queue toasts and
  the new CTA title (pt + en). Obsolete report strings dropped.
- **BRs upheld:** BR-1 (local; a copy into `inbox/` is a local FS write), BR-8
  (transcript/audio/audit never reach the queue — enforced in `is_queueable` and
  `resolve_queue_entry`, not only in the UI).
- **Docs:** `docs/ARCHITECTURE.md` §4 command table + the knowledge-flow
  paragraph; the in-app manual (pt/en); `CLAUDE.md` ADR index.
