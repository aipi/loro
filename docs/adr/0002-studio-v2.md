# ADR-0002 — Studio v2: generation language, branch-first git, editor lifecycle, in-app manual

- **Status:** accepted (owner decision, 2026-07-28)
- **Context:** first incremental ADR after the consolidated baseline
  (ADR-0001 §8 anticipated this return). Everything in this package traces to
  the owner's 2026-07-28 review of the app after the i18n release
  (ADR-0001 §10).

## Decision

### §1 Generation language follows the UI language

- All content the app *generates* — brainstorming reports, meeting notebooks,
  seeds, skills — is born in the **active UI language** (`uiLang`) at
  generation time. UI in English → reports/contexts in English; pt → pt.
- **`Acervo.lang` is retired** as a user-facing concept: the wizard no longer
  asks for a project language, the field stops being written, and generation
  call sites switch from `active_lang()` to `ui_lang()`. The field is still
  *read* for backward compatibility (existing configs parse), but nothing
  consumes it for new content. Mixed-language acervos are accepted as a
  consequence of switching `uiLang` — the owner chose live fidelity over
  per-project consistency.
- `assemble_brainstorm_report` (acervo.rs) and `assemble_notebook`
  (meeting.rs) gain a `lang` parameter (their headings were hard-coded pt).
  The EN meeting skills lose their pt-BR residue ("Reply in pt-BR") and their
  section headings match the notebook headings per language.

### §2 Branch-first knowledge versioning with default-branch sync

- Knowledge changes never land on the default branch: the only commit route is
  `brain_version`, which always creates/switches to an `rfc/<slug>` branch
  (invariant covered by test).
- Before branching, `brain_version` **syncs the local default branch** with
  `origin` (`sync_default_branch`: fetch + fast-forward only). Sync *degrades,
  never blocks*: no remote → plain local flow; offline/diverged → the branch is
  created from the local default and the outcome is reported as a translated
  warning (`err.git_offline`, `err.main_diverged`). The local default branch is
  never rewritten beyond a fast-forward.
- The user can now see the current branch, switch to another local branch, or
  create a new one from the UI (`git_branches`, `git_switch_branch`,
  `git_create_branch`; `brain_git_state` exposes `branch`).
- Switching with a dirty working tree is **blocked** (`err.working_tree_dirty`)
  — no stash, no auto-commit; the in-product remedy is Versionar itself.

### §3 Editor tab lifecycle (multi-file corruption fix)

- `LoroWorkspace.openTab` returns `{ ws, evictedId }`: reusing the preview
  slot reports the evicted tab id so the live editor side-maps
  (`cmById`/`savedById`/`fmById`) are disposed deterministically
  (`disposeTabState`, CM6 `destroy()` before map deletion). Root cause of
  content showing/saving under the wrong tab.
- `renderActive` is serialized by a generation token (`stale()` checked after
  every await); the winning render alone touches editor/doc visibility.

### §4 Terminal/Claude handshake ("perguntar ao acervo")

- Slash-commands are only injected after the embedded Claude signals readiness
  (prompt marker observed in `term-output`), not merely after the PTY opens;
  a reused session without a live Claude relaunches it first. Failures surface
  to the user (missing acervo, `claude` not on PATH) instead of dying silently.

### §5 Brain skills: no assumed premises, efficient reading

- AGENTS rule 6 inverts: when in doubt the loop does **not** pick the most
  likely context — it records the uncertainty (hotspot/`?`) and asks when
  interactive. All skills state "never assume unstated premises; declare
  uncertainties".
- Skills instruct efficient scanning: bulk file listing/reading goes through
  subagents on a fast model (Haiku), reserving the main model for synthesis.
- "gerar contexto" with an empty queue is clearly refused in the UI
  (`genContextNow` guard) on top of the skill's existing "nada novo"
  short-circuit.

### §6 Studio shell: resizable sidebar, creation-first notes

- The sidebar gets a drag handle (min = the previous `clamp(180px,30vw,250px)`
  floor, max ~45vw), width persisted in settings. Above a width threshold,
  tree items show metadata already available in the frontend: mtime (formatted
  in the UI locale), textual git status, full file name. File *size* is
  deferred (would require backend struct changes).
- The notes block ("＋ nova nota" + list) moves to the top of an expanded
  brainstorming, above meetings — creation-first applies to the whole block.

### §7 In-app manual + documentation process

- A bilingual user manual (`manual.pt.md` / `manual.en.md`, FAQ + step-by-step
  for every flow) ships **inside the app bundle** and opens as a studio tab
  (rendered with the existing markdown reader) via the `?` help button and the
  command palette; language follows `uiLang` (switching re-reads it). It is
  fetched as a same-origin webview asset — simpler and safer than the
  originally sketched `read_bundled_doc` IPC command (no new backend surface,
  no path-traversal exposure; `brain_read` stays sandboxed to the acervo).
- **Process rule:** every feature addition must evaluate updating the manual,
  this ADR series, README and ARCHITECTURE (CLAUDE.md §8 step; also enforced
  by the release checklist skill).

## Consequences

- Mixed-language acervos become possible (accepted trade-off; §1).
- Versionar may touch the network (fetch) — bounded by low-speed timeouts and
  fully degradable offline (§2).
- `openTab`'s return type changes (internal contract; all call sites updated
  in the same change).
- Two docs (`manual.*.md`) join the release surface and must be kept current
  (§7 process rule).

## References

- ADR-0001 (baseline; §10 UI language) — unchanged, remains the baseline.
- Owner decisions recorded from the 2026-07-28 planning session.
