# ADR-0027 — The review happens inside the app: a fourth destination

- Status: accepted
- Date: 2026-08-14
- Extends: ADR-0002 §2 (working drafts, the branch picker), ADR-0009 (the
  versioning quarantine), ADR-0020 (one anatomy, deliberate removals),
  ADR-0022 §28 (heavy work never runs on the main thread), ADR-0026 (a
  destination paints only where it is looked at), BR-8, BR-9
- Supersedes: the `openReviewsSheet` modal introduced by the round-4 collaboration
  pass (`collab-versioning.test.js` N4/N5), and the msgid that described it

## Context

Half of what Loro promises is collaborative: a change to the official knowledge
is proposed, read, discussed and approved by a team. Until this ADR the app could
**write** that half and not **read** it.

Measured on the code as it stood:

- `gh_pr_list` existed in the IPC contract and had exactly one frontend caller —
  a modal (`openReviewsSheet`) reachable from a toast that expires and a banner
  that can be dismissed. `brain_notifications` produced the sentence
  "2 aguardam sua revisão": a number with no door.
- Every row of that modal could do one thing: hand the address back to the user
  (`abrir` → the browser, `⧉ copiar link` → the clipboard). The app owned the
  URL and delegated the act.
- The one msgid that explained the modal — *"a revisão acontece no GitHub —
  «abrir» leva você até ela no navegador."* — was the interface admitting the
  gap in prose.
- Reading a proposed change took five steps and left the app: panel → ✦ IA →
  TIME → "Ver revisões do time" → row → browser → read.
- The **local** half was in the same state. `brain_git_files` could say *which*
  documents changed; nothing could say *what* changed in them. "Salvar versão do
  projeto" committed a set of changes the user had never been shown.

The design file (`Revisão do Loro.dc.html`) proposed a fourth nav destination
with two halves — what you changed, and what the team proposed. That shape is
right for a reason the design did not state: **a destination cannot be
dismissed**. A count that points at a modal outlives the modal; a count that
points at a destination points at something that is still there tomorrow.

## Decision

**The review is a destination, not a sheet.** `#destReview` is the fourth
`.dest-view` inside `#bHome`, with a fourth `.dest` pill in `#destNav` carrying
the amber `.destbadge` count, and two `.segbtn` halves:

| Half | What it answers | Source of truth |
|---|---|---|
| `Mudanças de agora` | what *I* changed and have not saved | `brain_git_diff` (pure local git) |
| `Revisões do time` | what the *team* proposed and who it waits on | `gh_pr_list`, `gh_pr_detail`, `brain_notifications` |

The destination is **never hidden**. The local half is plain git and works with
no network, no `gh` and no account; only the team half degrades, and it degrades
by *saying so*. A `when` gate on the nav item would hide a capability that works.

**Eight new IPC commands** (contract rows in `docs/ARCHITECTURE.md` §4). Six of
them shell out and are therefore `async` — ADR-0022 §28's bug class is heavy work
inside a synchronous `#[tauri::command]`, and `gh_pr_detail` alone is three
subprocesses plus two network round trips:

| Command | Shape | Note |
|---|---|---|
| `brain_git_diff(rel?)` | `[FileDiff]` | working tree vs HEAD, parsed; untracked files render as all-add; **the ADR-0009 quarantine applies exactly as on the save path**, so the screen shows what a version would carry and nothing else |
| `gh_pr_detail(number)` | `PrDetail` | body already split into the template's sections, checks, reviews with `stale`, threads, `mine` |
| `gh_pr_diff(number)` | `[FileDiff]` | the same parser as the working tree, so one change never gets two renderings |
| `gh_pr_review(number, action, body)` | `() / err` | `action` is a typed enum: an unknown value fails at deserialization, before any subprocess runs |
| `gh_pr_merge(number, headRef)` | `() / err` | squash + delete-branch; refuses a dirty tree on the head branch |
| `gh_pr_reply(number, commentId, body)` | `() / err` | |
| `brain_pr_template()` | `{rel, sections}` | the team's own file; `rel` travels because five spellings are accepted |
| `brain_set_pr_template(sections)` | `rel / err` | writes into the versioned tree, so the change is reviewed like any other |

**Division of labour is the rule, not a preference.** `diff.rs` is pure (takes
`&str`, returns structs, no `Command`, no `Path`) and owns every off-by-one in a
diff, with `#[test]`s that run on a machine with no git. `git.rs` shells out and
owns `gh`'s vocabulary. `lib.rs` only wires and gates. On the frontend the same
seam: `desktop/src/review.js` is **pure and language-free** — every reducer
returns semantic enums (`status: "added"`, `blocked: "conflict"`) and `app.js`
turns them into msgids at paint time. Reason: the two msgid scanners
(`i18n.test.js`, `vocabulary.test.js`) read `app.js`, so a pt-BR literal parked
in a reducer would escape both the English-pair check and the retired-vocabulary
sweep. If a label ever has to live closer to the data, the fix is to widen the
scanners to that file — never to accept the hole.

**One authority decides what the open review offers.** `reviewState(pr, {me})`
returns a single shape, so `✓ Aprovar` and `Juntar ao conhecimento oficial` can
never both be on screen (DESIGN.md §2 rule 4), and a decided review is replaced
by its **state** rather than by a re-armed button. The merge gate is
`mergeStateStatus`, never the approval arithmetic: branch protection is not
readable by a non-admin, so `%1 de %2 aprovações` is a *fact about the people in
the review* and not the repository's required count.

**`t()` gains positional interpolation.** Seventeen of the destination's
sentences carry `%1`/`%2` and no such mechanism existed. `t(msgid, args)`
substitutes `%1..%9` after the English lookup, in both languages. A `%N` with no
argument is left standing rather than blanked: a visible defect beats a sentence
that silently loses a word. `i18n.test.js`'s scanner already tolerated the
two-argument form, so no scanner changed.

**BR-8 / BR-9 hold, and are now mechanically guarded.** No new command logs a
diff row, a review body or a comment: `ai.rs`'s content-in-logs lint grew to
cover `git.rs` and `diff.rs` and to ban `diff|hunk|patch|body`, and
`review-destination.test.js` R8 sweeps the frontend painters for the same class.
No token is requested, stored or logged — `gh` runs with the user's ambient
credential and `require_gh()` only asks whether that credential works.

## Deviations from the design file

Each is a simplification of the **flow**, not a reduction of capability, except
where marked.

**D1 — the destination replaces the modal.** Steps to read a proposed change:
before = 5 and the browser; after = 2 and no browser. `openReviewsSheet` is
retired and its four routes re-point at the destination.

**D2 — no `simples`/`avançado` mode. One frame; the diff opens inside the card.**
The design switched the whole layout between a 700px card list and a 280px file
list plus a diff pane, moving the composer between the two. DESIGN.md §1 says the
frame does not change with the mode. Shipped: one 720px column; a card expands to
the plain-language `como era / como fica`, and a disclosure inside the same card
opens the real diff with the `lado a lado / unificado` switch. Steps to the exact
lines: 4 plus a mode to remember → 2. Everything the mode bought is kept: both
diff styles, `marcar como visto`, the `N / M vistos` counter, the per-file `+/−`
counts, the status badge, and the announced gap between hunks.

**D3 — the draft type pills are dropped.** The design composed `<tipo>/<slug>`
from five pills. `git.rs::create_branch`, `app.js::draftSlugFromBranch` and
`brain_version` all address a draft as `rfc/<slug>`, so four of the five spellings
would not be addressable. Shipped: one field, with the live `%1/24` counter and
the slug preview the design asked for. Steps: 3 → 2. The preview shows `⎇ <slug>`
and not `rfc/<slug>`: `rfc` is retired vocabulary (DESIGN.md §4), and the prefix
is the mechanism, not the name.

**D4 — the composer needs no sheet.** The description field is on screen beside
the changes it describes, so the button commits directly: 3 steps → 2. The price
sentence that lived inside the sheet ("guarda o projeto inteiro — todos os temas,
não só o documento aberto") moves **above** the button, so it is still stated
before the click. `#gitBtn` in the ✦ IA panel keeps its sheet — that is the
per-document route, where the changes are *not* on screen.

**D5 — unified is the default.** In a 720px column side-by-side gives each side
~330px and knowledge is prose: every line wraps. Both remain available.

**D6 — `openReviewsSheet`'s assertions are migrated, not deleted.**
`collab-versioning.test.js` N4/N5 pinned the modal's markup. Each claim is
re-pointed at `teamRowHtml` / `renderTeamReviews` / `renderReviewDetail` at
equal-or-greater strength: the row still names the review with `#num` in its
accessible name and is now keyboard-operable (`role="button"` + `tabindex="0"` +
`wireActivateKeys`), which the static `.fitem2` row never needed;
`openProposalUrl` is still the only way the review surface opens a URL; and the
"permanent door" claim gets stronger — the five routes are asserted **by name**
instead of counted with slack, and they land on a nav destination pinned in
`index.html`. The one assertion **replaced** rather than moved is the copy: with
the reading happening inside Loro, *"a revisão acontece no GitHub"* is false
(DESIGN.md §1 — state must never lie), so the msgid, its English pair and
`Revisões abertas` (the retired sheet's title) are deleted in the same edit, and
the deletion is itself asserted.

**D7 — the disclosures reuse the idioms that exist.** The card is
`<details>/<summary>`, not a div with an onclick, so keyboard operation and
`aria-expanded` come for free; the tab strip and the diff-style switch are both
the existing `.segrow`/`.segbtn` segmented control, not a second kind of tab.

**D8 — side-by-side carries the change by position and sign, not by tint.** The
style sheet tints the diff **row** (`.rvrow.add` / `.rvrow.del`), and in a paired
row the two halves have opposite tones: tinting the row would say one thing about
two. In `lado a lado` the meaning is carried by position (left = como era, right =
como fica), by the `+`/`−` glyph inside the changed cell, and by the hatch where
there was no line. Colour is never the only cue in either mode (WCAG 1.4.1), and
`unificado` — the default — keeps the full row tint plus its own sign column.

## Not implemented, and why

1. **`<tipo>/<slug>` draft names and the five type pills** — D3.
2. **The `todos / M / A / D` filter pills.** Four controls for a list that is
   normally under ten rows, where every card already carries its status badge and
   the header carries the counts. *This is a capability the design called for and
   the implementation does not have* — a deliberate loss, not a simplification.
   The cheapest honest replacement, if a real acervo ever needs it, is to sort by
   status rather than to filter by it.
3. **"aceitar sugestão"** — there is no `gh` primitive for applying a suggestion
   block, and applying a guessed patch to someone's knowledge is destructive. The
   suggestion renders read-only; the way out is `abrir no GitHub ↗`.
4. **"resolver conversa"** — needs a GraphQL mutation with no `gh` command.
   Resolved state is **read and rendered** (`resolvida ✓`); resolving happens on
   GitHub.
5. **"atualizar rascunho com o oficial"** on a conflicting change — merging the
   official branch into a draft can leave a conflicted working tree, and the app
   has no conflict-resolution surface. The conflict is *stated* and the way out is
   *named* (terminal or GitHub), which is the honest shape of a control we cannot
   finish.
6. **The non-clickable "conhecimento oficial" row** in the picker. Today's picker
   lets you switch to the default branch after stating the price
   (`switchPrice`/`confirmSwitchBranch`); removing that removes a capability. The
   row stays switchable and the copy says the branch is protected from *writes*.
7. **Pagination of a review's conversation.** The GraphQL query asks for the first
   50 threads and 50 replies. A knowledge review larger than that has left the
   app's premise; nothing on screen prints a total the app did not receive.
8. **A persisted `N de M vistos` counter.** It is session-only. A counter that
   survived a saved version would be counting files that are no longer in the
   change, and nothing in the contract decided where it should live.
9. **`pending_changes()` still counts what `working_diff` filters out.** `git
   status --porcelain` counts a quarantined `contexts/<ctx>/audio.wav`, so the
   ✦ IA panel's badge can read `1` while the Revisão list is empty and says
   `tudo salvo`. Pre-existing (the save path already unstages it), but the new
   screen is where it becomes visible as a contradiction. Not fixed here: fixing
   `pending_changes` moves a number three tests read.

## Consequences

- **`gh pr merge --delete-branch` moves the working tree.** Standing on the head
  branch, `gh` checks out the default branch before deleting it, so the documents
  on screen change. Mitigated by refusing with `err.working_tree_dirty` when that
  branch is current and dirty, by naming the closed draft in the copy before the
  click, and by refreshing the destination afterwards. On a clean tree the switch
  is silent, and if the default branch is the empty-room case that
  `the_default_branch_of_a_draft_only_project_holds_no_documents` documents, the
  screen empties — the same price `confirmSwitchBranch` already states.
- **Three subprocesses per `gh_pr_detail`.** Explicit user action, and `async`, so
  the window does not freeze; but the destination must not poll it. It loads on
  entry and after an action, never on a timer.
- **`gh --json` field availability at the doctor's floor (gh 2.0).**
  `mergeStateStatus` / `statusCheckRollup` on a very old `gh` make the whole
  `pr view --json` call fail, not just the field. That degrades to
  `err.pr_read_failed` with `abrir no GitHub ↗` as the way out. Whether the
  floor should rise is a separate ADR question.
- **`gh_pr_list` predates the stable-code contract** and returns `gh`'s raw
  stderr. The destination therefore translates only strings that start with
  `err.` and never repeats subprocess prose; when the error is not a code the
  screen says it could not read the reviews and offers the diagnosis screen.
  Pinned by `review-destination.test.js` R10, which was found by driving the real
  app with `gh` installed and unauthenticated.
- **The header at the 860px floor.** The fourth pill pushed the header past the
  window; the fixes are `white-space: nowrap` on `.dest`, the project name
  yielding to 110px/70px, and the pill returning to flow at 1140px instead of
  1080px. What yields is prose (an already-ellipsised name whose full text is in
  the button `title` and the switch menu), never a control — DESIGN.md §2 rule 9's
  own ordering. The header already overflowed at three destinations *before* the
  fourth item, so this is a fix for a live defect.

## Round 2 — what the critics found, and what the fixes decided

Nine defects survived round 1. The three that mattered were not pixels; they were
the screen telling the user something that was not true, and two guards that could
not fail. Each fix below leaves a regression test named after the defect.

### The screen said one thing and git did another

- **Saving on the official knowledge created a draft nobody named.** The composer
  sent the free-text description as the draft *slug*: `brain_version` addresses a
  draft by slug and `create_branch` runs `git checkout -b rfc/<slug>`, so one click
  moved the user onto `rfc/onboarding-atualizado-com-o-novo-prazo-do-convite` (49
  characters, cut at 50 by `sanitize_slug`) while the chip on the same card read
  `⎇ no conhecimento oficial` and the copy stated only half of the price. **Decided:**
  the name comes from `draftSlugify` — the *same* 24-letter rule the «Novo rascunho»
  sheet teaches and enforces — and `#revSaveNote` states the other half of the
  price *before* the click, naming the draft the description will create, live as
  it is typed. `draftSlugify` now also trims a trailing `-` left by the 24-character
  cut, because `sanitize_slug` trims it on the way in and the announced name has to
  be the created name. The alternative (asking for the draft name in a second
  field) buys the same truth for one more control and one more step.
- **`⎇ no conhecimento oficial` was painted for any branch outside `rfc/…`** —
  including the very draft the F11 banner named on the same screen, with the ✦ IA
  panel showing `⎇ feature/x` three metres away. Two of three answers were wrong,
  and the wrong one sat next to the composer. **Decided:** `draftNameFromBranch`
  answers *how the screen names where you are*; `draftSlugFromBranch` keeps
  answering *is this draft addressable by slug?* (what `brain_version` needs). One
  fact, one function, four callers (chip, F11 banner, team row, decision block).
  The composer's note appears whenever there is no addressable draft, which is
  exactly when saving creates one — on the default branch **and** on a foreign
  branch.
- **A failing check was announced and never named.** `CheckRun { name, state, url }`
  arrived whole and the screen folded the list into one word. A reviewer was told
  the change is blocked and could not learn by what, on the destination whose whole
  intent is deciding inside Loro. **Decided:** `review.js::failingChecks` (pure) +
  `checksHtml` paint `Verificações que falharam` with one row per check and
  `ver a verificação ↗` through the app's single URL door. The group heading carries
  the state, so the rows do not repeat a badge N times (DESIGN.md §7).
- **Inside an open review, `como era / como fica` could be the reviewer's own
  uncommitted text.** `diffFileAt(path)` searched the working tree first and the
  review second; both lists are keyed by the same acervo-relative path, so a
  reviewer with a local edit to a document the proposal also touches read their own
  draft as the proposal, with the real diff underneath. **Decided:** the list is a
  parameter — `RV.fileAt(files, path)` — and `wireCardToggle(root, files)` receives
  the list that drew the cards. `diffFileAt` is deleted; there is no global left to
  resolve against.
- **The 400-row cut was a dead end.** `⋯ … e mais 500 linhas` and nothing else, in
  the destination that exists to show the exact lines. **Decided:** the cut carries
  `mostrar mais linhas` (`REV.rowsMore`, one `DIFF_ROWS_MAX` step per click, in the
  repaint signature so the click is not swallowed by the poll). No backend call:
  the rows are already in memory. The ceiling stays, so a card still never becomes
  the file.
- **A save that failed said nothing.** `invoke("brain_version")` had no `catch`: the
  rejection died in the console. **Decided:** the R10 shape — a stable `err.*` code
  is translated, anything else becomes `não consegui salvar a versão agora`, and the
  log line carries the code or the word `opaque` (BR-8).

### Guards that could not fail

- **The migrated N4 assertion.** `data-prdetail` was asserted against
  `teamRowHtml + renderTeamReviews` as one blob: removing the attribute from the
  markup *or* changing the selector in the reader left the whole 697-test suite
  green, with every review row a focusable button that opens nothing. Each half is
  now asserted against its own text, and `wireActivateKeys(row)` is pinned inside
  the loop that runs.
- **The `aria-busy` assertion matched its own teardown.** `/aria-busy/` over the
  body of `withPending` was satisfied by the `removeAttribute` in the `finally`, so
  the line that *announces* could be deleted with the suite green. Set and clear are
  now asserted separately, with their order (set before `try`, clear inside
  `finally`).
- **Both binary guards were proved by accident.** The fixtures had `hunks: []`, so
  `diffRows`/`plainBits` returned `[]` for the empty-hunks reason and deleting
  `if (f.binary)` stayed green. The fixture now carries rows (the real shape of a
  file past `DIFF_READ_MAX_BYTES`), and the same payload *without* the flag is
  asserted to draw — so the guard is the only reason.
- **R11's orphan scan ran on a loose count.** A prefix filter matched 35 functions
  (two of them not the destination's) against a floor of `>= 20`: fifteen could fall
  out of the scan without failing. It is now an explicit list, checked in both
  directions — a function that leaves the list fails, and a new function declared in
  the destination's block and *not* listed fails too.
- **R7's single-authority guard forbade one byte sequence.** `!/pr\.mine &&/` let
  `pr.mine === true &&` through. The painter is now *exercised* over the same
  2×3×5×4×2×3 matrix the reducer is tested with (never two primaries, `data-prmerge`
  iff `canMerge`, `data-praction` iff `canReview && !decided`, never an empty
  return), and every `if` condition is scanned for a read of `pr`.
- **An orphan msgid.** The same diff that removed two msgids because "um msgid
  órfão é cromo morto" added `descrição no modelo de revisão do time`, used by no
  surface. Removed, and `i18n.test.js` now sweeps the ADR-0027 block of the catalog:
  every key in it must appear in `app.js` or `index.html`. Measured while writing
  that sweep: the catalog as a whole carries **197 orphans predating this ADR** (dead
  surfaces: `brainstorming`, the old `acervo` vocabulary, the pre-ADR-0018 report).
  Not paid here — deleting a msgid whose surface I did not build is a change I
  cannot verify — but it is now a measured number instead of an unknown.

### Not implemented (added to the list above)

10. **The collapsed-gap expander.** `design-spec.md` §5 D2 recorded it as a *kept*
    capability; it does not exist and cannot exist against today's payload —
    `git diff -U3` sends three lines of context and nothing more, so the control
    would open nothing (DESIGN.md §1). The gap stays a **notice**; the 400-row
    **cut** is a different row and now carries its way on. Widening the fetch is a
    backend question (a `brain_git_diff(rel, context)` parameter) and belongs to
    whoever needs it, with the cost of re-reading the file stated.

### Consequence — the language toggle repaints the destination

The Revisão destination is drawn with `innerHTML` and carries `data-i18n-dyn`
nodes (the draft chip, the opening sentence, the price note). The language toggle
now clears `REV.sig`/`REV.teamSig` and calls `renderDestReview()`: a new language
does not change the *fact*, so without clearing the signatures the repaint would be
swallowed and half the screen would stay in the previous language (F25, the same
defect `renderActive()` in that list was added for).

## Round 3 — what the critics found in the running app, and what the fixes decided

Twenty-four defects, ranked by the brief with usability first. Two of them were the
same disease as round 2's, one layer out: a sheet that discarded the user's work, and
a picker that spoke git on the one screen whose job is choosing where the work goes.
Nine were guards that could not fail, each proved by mutating a copy in `/tmp` and
watching the suite stay green. Every fix leaves a regression test named after the
defect (`R17`–`R35` in `review-destination.test.js`, four measured guards in
`tokens.test.js`).

### A flow that did not close

- **A sheet that failed threw the user's work away.** Sending for review with no
  `gh` credential closed the sheet, blanked the seven typed fields and left one
  toast that expires — the screen ended up exactly as before the attempt, with no
  record of it, and the pre-refusal that would have avoided the trip did not fire
  because `envDoctor` was not answered yet. The close was **unconditional**: any
  failing sheet (save a version, team template, reply) discarded what was typed.
  **Decided:** the sheet's confirm now has two outcomes. Success closes it; failure
  keeps it open, re-arms the confirm, restores the dismissal callback (so whoever
  awaits the sheet is still answered by all five exits — the `● travado em
  iniciando…` invariant) and writes the reason **inside** the sheet, in a
  `role="alert"` slot that also carries `abrir Configurações` when the code is one
  of `ENV_REMEDY` — the same list `teamBlockCode()` chooses from, so the pre-refusal
  and the in-sheet remedy cannot drift. Configurações opens **over** the sheet: fix
  the credential, come back, the fields are as they were and confirm is armed.
  A thrown *string* is a product message (the `invoke` rejection code, or a msgid a
  handler threw); anything else becomes `não deu para concluir agora`, and the log
  line carries the code or `opaque` (BR-8). `promptReply` no longer swallows its own
  IPC error for the same reason.
- **The drafts sheet spoke git.** «Rascunhos de trabalho» — the only screen whose
  function is *choosing the place* — listed `main (principal)` and
  `● rfc/onboarding-atualizado-co`, one click away from the composer chip that says
  «no conhecimento oficial» / «no rascunho onboarding-atualizado-co», and the price
  sheet named only the way back. **Decided:** `placeName(branch, def)` is the one
  answer to *how the screen calls this place* — «conhecimento oficial» or
  «rascunho «<slug>»» — and it names the rows (visible label **and** accessible
  name), both sides of the price sheet, and nothing else. `promptVersionar` stopped
  printing `⎇ rfc/<slug>`; the field label already says «rascunho». The duplicated
  clause in the price («7 documentos saem da tela — lá ainda não há nenhum
  documento — a tela vai ficar vazia») became two exclusive branches: the count, or
  the empty screen.
- **The picker offered a switch it knew would be refused.** With one unsaved change
  every row was live, the second click promised a consequence that would not happen
  and the third produced `err.working_tree_dirty`. `git_branches` already returns
  `dirty` — the same call that draws the rows. **Decided:** while the tree is dirty
  the existing-draft rows are `aria-disabled`, not focusable, and say the remedy in
  their own meta column; the sheet carries one sentence explaining it, and
  «＋ novo rascunho…» stays live because `checkout -b` carries the change with it —
  which the sentence says.
- **A failed team read had a blank explanation line.** The title said «não consegui
  ler as revisões agora», the reserved `<p>` was empty and a button pointed at
  Configurações. Dropping `gh`'s raw English is right; writing nothing in its place
  is the interface knowing something it does not say. **Decided:** the non-`err.*`
  branch has a product-written sentence naming where the diagnosis lives.

### The keyboard and the accessibility tree

- **Opening a review and coming back dropped focus to `<body>`**, and because
  `#revOpen` sits after `#revList` in the DOM the restored list was *behind* the
  sequential-focus starting point — going forward it could not be entered at all.
  **Decided:** `openReview` sends focus to `#revBack` and announces
  `revisão #%1 aberta`; `backToReviewList` returns focus to the row that was
  opened (or the tab, if it is gone), the way `leaveOverlay` already does.
- **The team row's accessible name replaced its contents** — the state chip, who
  asked, which draft and when were invisible to anyone who hears the row — and a
  real `<button>` (⧉ copiar link) lived **inside** a `div[role=button]`, whose
  children ARIA makes presentational. **Decided:** the opener is a real `<button>`
  carrying the title, with an accessible name that includes the number, the title,
  the state and the meta line; ⧉ copiar link is its **sibling**. `role=button` +
  `tabindex` + `wireActivateKeys` on the row are gone — the element does it better.
- **`unificado / lado a lado` carried its selection only in CSS.** The house's ARIA
  mirror observes class mutations on nodes that already exist, and these are written
  by `innerHTML`, so they escaped it by construction. **Decided:** `aria-pressed` is
  written where the buttons are written, on both of them.
- **The three card toggles destroyed the focused control.** Marking as read, opening
  the full change and switching diff mode all repaint the list, so focus fell to
  `<body>`, the next Tab restarted at the card and nothing announced the outcome —
  for a keyboard or screen-reader user those three controls produced no feedback at
  all. **Decided:** `repaintFocused(attr, val, repaint, said)` repaints, re-queries
  the equivalent control by its own data attribute, focuses it, and announces the
  outcome where the outcome is a number the screen shows (`%1 de %2 vistos`).
- **Every thread offered a button named exactly «responder»** and the sheet it
  opened never said which conversation it answered — a reply could be posted to the
  wrong thread. **Decided:** `threadWhere(th)` is the one address of a conversation;
  it names the button (`responder — contexts/x/context.md:13`, visible label first,
  WCAG 2.5.3), titles the sheet (`responder a %1`), and the sheet quotes the excerpt
  and names who wrote there. `wireReviewDetail` passes the thread the row carries
  (`threadOf(pr, id)`), so the reply cannot land under another excerpt.
- **The destination's status messages were never announced.** «tentar de novo»
  repainted the identical error with no toast, no live region and no pending state.
  **Decided:** both empty states announce through the app's single live region
  (`#srLive`, via `announce`) and both retries go through `withPending`.

### Measured, in both themes

- **The fourth destination clipped the recording pill between 901px and ~1015px.**
  `#headRec` had `min-width: 0` and every other header block is `flex: none`, so the
  whole deficit landed on the one clickable control — 35px of the 151px it needs at
  901px, no clock and no word «gravando» — while the version tag (decoration) and the
  inter-block air kept their pixels, because the yield block started at 900px.
  **Decided:** the yield block moves to the width where the header actually runs out
  (**1015px**, measured with four destinations, both nav counters and the recording
  in progress) and takes `.localtag` with it; `.headrec` is `flex: none`; and the one
  shrinkable item in the header is now **prose** — `.apphead .switch` is
  `flex: 0 1 auto; min-width: 0`, so a residual deficit ellipsizes the project name
  (whose full text is in the `title` and the switch menu) instead of a control.
  DESIGN.md §2 rules 8/9 rewritten with the measured band; `tokens.test.js` guards
  the shrink order, and `review.test.js`'s "never scroll the body" assertion is
  migrated onto the prose block at equal strength.
- **A badge was not mono, and a state's ink was the project's colour.** `.badge`
  never declared a family — every pre-existing site wrote `class="mono badge"` by
  hand and the seven new ones did not — so the review card's state read as 10px sans.
  And `.badge.ok` painted with `var(--accent)`: with the amber project colour «novo»
  and «modificado» measured 1.02:1 apart. **Decided:** the family belongs to the
  component (`.badge { font-family: var(--mono) }`), and a state's ink is a state
  token — `.badge.ok` is `--green`, which is already the app's "added" (the sidebar
  dot, the diff row's fill). Guarded: a badge is mono, no two states in one list
  share an ink, and no state ink references `--accent`.
- **`class="hint mono"` painted `--sans` with mono's letter-spacing.** The two
  classes have equal specificity and `.hint`/`.pmnote` come later with the `font:`
  shorthand, which resets the family — so the wrong half of the rule survived on the
  team-template path and both counters. **Decided:** the machine's half goes in its
  own `<span class="mono">` (the path inside the sentence, the two counters) and the
  inert class is removed from the six markup combinations that asked for a family
  they did not get. Guarded structurally in `tokens.test.js`: for every class
  combination in the markup that contains `mono`, the winning single-class rule must
  be the mono one.
- **Two controls of the destination had a 1.16–1.28:1 boundary** where §5 requires
  `--line-control` (3:1): the draft chip (`.pbranch`, a 1.04:1 fill difference
  against the card, so the border *is* the affordance) and the labelled `.mini.act`
  actions. Their labels were also `9.5px var(--mono)` — below §3's smallest step, and
  the machine's font on a phrase. **Decided:** `--line-control` on both boundaries
  (both added to `tokens.test.js`'s boundary list, which is what makes them
  measured), and the Revisão's labelled actions get an 11.5px `--sans` label.
- **The disabled primary read at 3.72:1 (dark) / 3.97:1 (light)** — below the floor
  the sheet itself declares two rules above (`.btn:disabled { color: var(--ink3) }`,
  "4,9:1") — and that is what the screen looks like whenever everything is saved.
  **Decided:** one state, one appearance — a disabled primary is a disabled button:
  the same fill, border and `--ink3` as `.btn:disabled`. Guarded for both selectors
  in both themes.

### Guards that could not fail (proved by mutation, each recorded)

Each line is a mutation applied to a copy in `/tmp`, the whole suite green before
the fix, the named test failing after it.

| Mutation | What shipped through it | Now killed by |
|---|---|---|
| drop `[...REV.viewed]` from the repaint signature | «marcar como visto» changes nothing on screen | `R26` |
| drop `[...REV.openDiff]` | «ver a mudança completa» opens nothing | `R26` |
| `run: () => {}` on the failed-read empty state | the only door on the screen retries nothing | `R27` |
| render `.rvtitle` empty in `checksHtml` | «Verificações que falharam» lists anonymous rows | `R28` |
| `added → { warn, removido }` | a new document badged as removed | `R29` |
| `nowBadge.textContent = 0` | the tab shows 0 next to three changed documents | `R30` |
| invert `paintReviewIntro`'s branch | each half promises what the other one does | `R31` |
| `promptReply(pr, threadOf(pr, 0))` | every reply posts under the wrong excerpt | `R34` |
| a third field on a shared line of `REV` | R11's field scan was positional and could not see it | `R11` |
| header yield block back to 900px | the recording pill clipped again from 901px | `tokens.test.js` |
| `.headrec` shrinkable again | a control absorbs the header's deficit | `tokens.test.js` + `review.test.js` |
| `.badge.ok` back to `var(--accent)` | two states, one ink, with an amber project | `tokens.test.js` |

`wireCardToggle`'s third parameter (`repaint`) was dead — no caller passed it, and
R14 pinned the two-argument calls that made it unreachable. Dropped, with the
signature asserted against the call sites in both directions (`R32`).

### One string kept against the contract

`design-spec.md` §7 lists `editado`/`edited` for a modified document; the shipped
badge says **`modificado`**, which is the word the sidebar's git marks and the
timeline already use for that state (`app.js` `g-mod`). Two names for one fact one
click apart is the defect `R18` exists for, so the badge keeps the app's word and
the contract's row is the stale one. `R29` pins all four states and their English
pairs.

## Round 4 — what the critics found in the running app, and what the fixes decided

Fourteen defects. Two of them were the same disease as round 2's and round 3's, one
layer out — a screen that answers its own question with the wrong half of the truth,
and a control that reports a state it does not enforce. Two were guards that could
not fail, both proved by mutating a copy in `/tmp` and watching the suite stay green.
Every fix leaves a regression test named after the defect (`R36`–`R44` in
`review-destination.test.js`, one measured boundary and one measured focus ring in
`tokens.test.js`, one pure test in `review.test.js`).

### The screen said one thing and the app knew another

- **«tudo salvo» with the open document unsaved.** The working tree was clean, so
  `renderMyChanges` answered *o que você mudou* with «tudo salvo», disabled the
  primary action and oriented the wrong next step («envie para revisão» — there was
  nothing to send), while the tab strip in the same frame painted «mobile ●» whose
  title is «alterações não salvas». The disk is not the editor: a version keeps what
  is **already in the file**, so an unsaved buffer stays out of it — silently.
  The app already knew how to add the two truths up (`renderPanelTimeline` uses
  `tab.dirty || gitFiles[rel]`). **Decided:** `dirtyDocs()` is the one answer to
  *which open documents are not in the file yet*, and it has two surfaces, each
  carrying the truth once: with an empty list the empty state stops claiming
  «tudo salvo» and reads «mudanças não salvas» + «texto não salvo em %1 — a mudança
  aparece aqui depois de salvar.» with a door that activates the tab (its accessible
  name carries the document, WCAG 2.4.6); with cards on screen the sentence moves to
  `#revUnsavedNote`, which is part of `#revSaveBtn`'s `aria-describedby` — so the
  keyboard hears the whole price before the click (WCAG 3.3.2), the same way the
  other two half-prices are already read out. The repaint signature carries the
  unsaved list, or the sentence would only appear when the working tree changed for
  some other reason. The panel's `#gitBtn` is the same claim in the other place:
  `versionBtnState(g, unsavedDocs)` keeps it **disabled** with a clean tree (saving a
  version cannot commit a buffer that is not on disk — a control that does nothing is
  worse than none) but stops labelling it «tudo salvo ✓», and says the missing step
  in its title instead.
- **«✓ visto» and «N de M vistos» survived a saved version.** `REV.viewed` was a
  path-keyed `Set` that was never cleared, so a change nobody had opened arrived
  `aria-pressed="true"` with the header reading «1 de 1 vistos» — on the tool that
  exists so you *não perca um documento numa mudança grande*. The comment above the
  set stated the opposite intent. **Decided:** the mark is a claim about **content
  read**, so it dies with the content: `review.js::changeId(file, scope)` keys it by
  path + kind + counts + the length and an FNV-1a of the hunk text, and
  `viewedCount(files, viewed, scope)` counts with the same key. `scope` (`now` vs
  `pr:<n>`) separates the two lists that speak the same acervo-relative paths, so a
  mark can no longer cross from the working tree into an open review. Clearing the
  set on save was the cheaper fix and the wrong one: it leaves the same lie open for
  a document that changes again *while* the list is on screen (the 10 s poll).
- **The propose button was armed and silent about the half that is not connected.**
  Nothing on the Revisão screen said the team was unreachable before the click; the
  click answered with a toast quoting `gh auth login` to a user who was promised they
  need no git. The app evaluated the same `teamBlockCode()` on click, and the
  neighbouring tab already rendered the sentence. **Decided:** `paintTeamGate()`
  paints the state **before** the click — `#revTeamNote` (the existing msgid for
  not-connected, or the offline one) as the button's `aria-describedby`, `#revTeamGo`
  as the remedy, and the button **disabled**, with no tooltip (a tooltip does not
  fire on a disabled control, and the code's own text is the diagnosis screen's
  wording, not this screen's). The click guard stays as the last check at the moment
  of the click. The painter rides with `renderGhCard`, so it repaints when the
  environment answer lands or changes.
- **One draft, two names.** The ✦ IA panel printed the raw ref while the Revisão
  screen called the same object «no rascunho <slug>» — an unexplained `rfc/` prefix
  in the one place that talks about your draft while you are editing.
  **Decided:** `draftChipLabel(branch, def)` is the one sentence for *where you are*,
  and both chips are painted by it. The raw ref is not shown: DESIGN.md §4 maps it to
  «rascunho de trabalho», and `#branchBtn` keeps the tooltip that says what the
  control does.

### Every failure path now lands where it says

- **«abrir Configurações» opened Configurações at the top.** Three doors of the
  review flow (the team empty state, the F5 refusal toast, the remedy inside the
  sheet) named «Versões e GitHub» and dropped the user on «Projeto», with the section
  they named being the last of seven. The app's own panel link already did it right.
  **Decided:** `openCfgGit()` — `await openCfg(); showCfgSection("git")` — is the
  only door those four routes use.

### The keyboard and the accessibility tree

- **The two text fields of the destination had no focus indicator**, in both themes,
  and both refusal paths (`descreva a mudança em uma linha antes de salvar`,
  `escreva o que precisa mudar antes de pedir mudanças`) move the keyboard straight
  to them. Cause: the R14 fix from an earlier round was scoped to `.sheet`, and these
  two `.wfield` rows live in a `.revcard`. **Decided:** the ring follows the **box**,
  not the screen it appears on — `.wfield:focus-within` is unscoped, and the one
  place where the field draws its own box (`.wizcard`) turns the row's ring off so
  there is never a double ring. `tokens.test.js` measures a ring for every surface a
  `.wfield` lives on, and both allowlist entries were migrated to the unscoped
  selector (strictly more coverage).
- **The live region announced the hidden half.** Both halves are painted in the same
  pass and both spoke into `#srLive`, so whichever finished last owned it: arriving
  at Revisão announced «nada aqui ainda — o time ainda não está conectado» about a
  half that was not on screen, and nothing about the half that was.
  **Decided:** `announceRev(half, msg)` speaks only for the tab that is showing (and
  never while an open review covers both), the tab strip clears both signatures so
  the half that just appeared repaints and announces, and the non-empty *now* half
  announces its own arrival («%1 documentos mudados») instead of being the only state
  that says nothing.
- **A sheet that replaces another left the keyboard on `<body>`** and never announced
  the new dialog: `enterOverlay` returns early when the wrap is already in the
  overlay stack, while `PM.body.innerHTML` destroys the node that had focus.
  **Decided:** `openModal` detects that it is *replacing* a sheet, moves focus to the
  new body's first field and announces the new title — the dialog's accessible name
  changed, so it is a new dialog (WCAG 4.1.2). The branch rows that already
  `closeModal()` first are unaffected.
- **The three per-card controls repeated verbatim once per document.** «marcar como
  visto», «ver a mudança completa» and the diff-mode group had identical accessible
  names on every card, in a list built so you can read a big change document by
  document. **Decided:** each carries the document in its accessible name, with the
  visible label as its prefix (WCAG 2.4.6 + 2.5.3) — the rule the app already
  applies to «responder — <endereço>» and «ver a verificação ↗ — <nome>».
- **The open review was never a heading.** The `h1` stayed «Revisão» and the
  review's own sections were `h2`, so the outline of an open review was
  indistinguishable from any other's. **Decided:** the review's identity is an `h2`
  and its four sections («O que muda», «Sua revisão», «Conversa», «Verificações que
  falharam») become `h3`. `index.html`'s own `.phead`s stay `h2` — they belong to the
  list, which is hidden while a review is open.
- **The 10 s poll threw the keyboard back to the top of the list.** `repaintFocused`
  protected the deliberate clicks; the poll path did not, so any outside change to
  the working tree moved the focus of a change the user did not make (WCAG 2.4.3).
  **Decided:** `focusMarkIn(list)` remembers the **address** of the focused control
  (`[data-rv*="…"]`, or the card's `> summary`) before the `innerHTML` swap and
  `restoreFocusMark(list, mark)` gives it back afterwards — and only if the repaint
  left the focus orphaned, so a focus that already has an owner is never moved.

### Two guards that could not fail

| Mutation | What shipped through it | Now killed by |
|---|---|---|
| `.dest { font: 600 8px var(--sans) }` inside the narrow header block | a nav destination's label at 8px in every window ≤1015px | `tokens.test.js` (`d.has("font")` instead of a `/font:/` grep over key names, which never contain a colon) |
| an orphan msgid whose text is a substring of a live one (`verificações ok`) | a dead msgid in the catalogue with no surface — the exact shape a reworded string leaves behind | `i18n.test.js` (whole-literal match against `t("…")` arguments and `data-i18n` texts/attribute values, with a floor that fails if the reader goes blind) |

### What was deliberately left alone

`REV.openCard`, `REV.openDiff` and `REV.rowsMore` stay keyed by path: they are
disclosure state (*is this card open, how many rows have I asked for*), not a claim
about what the user has read, and a card that stays open across a poll is the
behaviour the signature already protects. `#knowIdxBtn`'s explicit
`border-color: var(--line-control)` is now redundant with the base `.btn` — it is
kept as the ADR-0026 surface's own pin, and `xref-surfaces.test.js` still asserts it.

## Round 5 — what the critics found in the running app, and what the fixes decided

Four defects, all in the same family as rounds 2–4: a screen that states a fact it no
longer holds, or names a next step it has already refused. Two of them broke a flow
(F8 could not close at all), so they were fixed first. Each fix leaves a regression
test named after the defect (`R45`–`R48` in `review-destination.test.js`), and each
guard was proved by mutating a copy in `/tmp` and watching it fail.

### A flow that did not close

- **A review that comes back to me offered no decision.** GitHub marks a submitted
  review `stale` when the author pushes another version, and it can ask for my review
  again. In both cases the previous answer no longer counts — but `decisionHtml` tested
  `st.decided` first and never looked at `st.stale`, so the block read «você aprovou /
  a mudança entra no conhecimento oficial quando todas as aprovações chegarem» **with
  no control in it**, on a row the app's own grouping filed under «Aguardam a sua
  revisão». The second sentence was also false: a stale approval is not counted, so the
  change was never going to land «quando todas as aprovações chegarem». The only exit
  was «abrir no GitHub ↗», on the destination whose intro promises «a sua leitura
  acontece aqui, sem sair do Loro».
  **Decided:** *who still has a decision to make* is one answer from the reducer —
  `reviewState().canDecide = canReview && (!decided || stale || askedAgain)` — and the
  painter switches on it, so «the list says it is my turn» and «the review offers me
  nothing» can no longer both be true. `askedAgain` is computed by `askedOf(pr, me)`,
  the same function `groupReviews` uses to choose the row's group: one fact, one
  reader. The re-armed block says **why** it came back («a sua aprovação era de uma
  versão anterior…», «o seu pedido de mudanças era de uma versão anterior…», «%1 pediu
  a sua revisão de novo.») — a returning decision without a reason is a button that
  appeared by itself. A decision that still stands is unchanged: it is replaced by the
  state, never by a re-armed button, and R7's matrix was **migrated** to the new
  authority (`data-praction` present iff `st.canDecide`, exercised over the same 240
  combinations, plus an exercised assertion that a current approval offers nothing).
- **The changes-requested state addressed the author, whoever was reading.** The
  reviewer who had just clicked «pedir mudanças» read their own login in the third
  person («ana pediu mudanças») and the author's remedy — «salve uma nova versão no
  rascunho» — about a draft that is not theirs. Both roles got byte-identical copy,
  two lines below a branch that already says «você aprovou».
  **Decided:** the title asks *whose request is this* (`st.decided ===
  "changes_requested"` → «você pediu mudanças») and the sentence asks *whose draft is
  this* (`st.mine` → the author's remedy; otherwise the reviewer's state, which names
  the author as the person the next step belongs to). Nothing about the mechanism
  changed; the screen just stopped handing one role the other's instructions.

### The screen named a step it had already refused

- **«tudo salvo» invited the step the same card disables.** With a clean tree and no
  GitHub — the state of every first install — the empty state read «Envie para revisão
  quando quiser que o time leia» while, two sentences below in the same card,
  `paintTeamGate` said «o time ainda não está conectado» with «↗ Enviar para revisão do
  time» disabled. The same `teamBlockCode()` is evaluated in the same paint pass.
  **Decided:** the hint names the step that **works** — «Para o time ler, conecte o
  GitHub em Configurações.» with `abrir Configurações` as the empty state's own door
  (the same `openCfgGit` the other three routes use), or «Sem conexão agora — envie
  para revisão quando a rede voltar.» with no door, because waiting for the network is
  not a button (`paintTeamGate` already makes the same distinction). Two consequences,
  both measured in the running app: the block travels in the repaint signature (the
  environment diagnosis arrives *after* the destination's first paint, so without it
  the sentence would only change when the working tree changed for some other reason),
  and `renderGhCard` repaints this surface next to `paintTeamGate` — the two sentences
  are surfaces of one fact and must change in the same instant. The remedy button now
  exists twice in the frame, once per sentence that owns it; both are secondary, the
  screen's one primary action is still «Salvar versão do projeto».
- **The toast of a draft switch spoke git.** `afterSwitch` passed the raw ref straight
  through: creating «toast tres» answered «⎇ rfc/toast-tres» two centimetres above the
  chip that calls the same place «⎇ no rascunho toast-tres», and a first switch that
  costs documents wrote «⎇ main» — the one word DESIGN.md §4 replaces with
  «conhecimento oficial». Every other surface of that fact already went through
  `placeName`.
  **Decided:** `afterSwitch(branch, price, def)` names the place with `placeName`, and
  `def` travels with the call because only the caller has just read which ref is the
  official one (`git_branches`); `REV.def` is the fallback for the two callers that
  cannot be on the default branch by construction. The price the toast reports is
  unchanged. Measured while verifying: the switch also left the chip and the empty
  state naming the *previous* draft until the 10 s poll came round — the toast said
  «⎇ conhecimento oficial» while the chip said «no rascunho fe5-aviso» — so
  `afterSwitch` now re-reads where we are (`refreshMyChanges`, which is where
  `REV.branch/def` and the three sentences that quote them are painted, and which
  no-ops off the destination). The duplicate call in `promptNewDraft` was removed.
  DESIGN.md §4 records the corollary: no user-facing string is built from a git ref.

### Verified in the running app

F1/F4 were walked in the scratch instance: the toast reads «⎇ rascunho «fe5-aviso»»
and «⎇ conhecimento oficial · 8 documentos ficaram no rascunho anterior»; the price
sheet, the chip, the empty state and the toast name the same place in the same words
1.2 s after the switch; the empty state's «abrir Configurações» lands on «Versões e
GitHub». F8's three states cannot be produced in a scratch HOME with no `gh`
credentials (that is the environment, not a defect), so they were exercised through the
app's own painters — `reviewState` + `prChips` + `decisionHtml` + `groupReviews`, the
same seam `review-destination.test.js` uses.

### Guards, proved by mutation

| Mutation (on a `/tmp` copy) | Killed by |
|---|---|
| `canDecide` back to `canReview && !decided` | R46 |
| the changes-requested block back to one copy for both roles | R47 |
| the switch toast back to the raw ref | R45 |
| «tudo salvo» back to always inviting the send | R48 |
| the empty state's door removed | R48 |
| `askedOf` returning `false` (the group and the block reading different facts) | R46 |

## Round 6 — what the owner found in the running app, against the real remote

Reported by the owner after using the destination against `turbiteam/turbo` (a
real remote, real open reviews):

### The review's prose was machine syntax

`renderReviewDetail` wrote the description with `esc(pr.body)` — and the
conversation wrote each comment the same way — inside `.rvbit`'s
`white-space: pre-wrap`. A pull-request body is markdown: it is what the team's
own template asks for and what GitHub stores. So the body of turbo's #6 reached
the screen as `**Nenhuma palavra de negócio foi reescrita**`, a table as raw
pipes and a blockquote as a leading `>`, on the half of the screen whose only job
is to be READ (ADR-0018) — exactly what DESIGN.md §5 forbids ("machine syntax
must not reach the surface").

**Decided:** the author's text goes through the document reader's own
`mdRender(src, docOpts())`. One named function, `reviewProse`, so the
description and the comments cannot diverge, and `docOpts()` so a lateral link
and a locator are marked here as they are in a document (ADR-0026). What the
PRODUCT wrote (a section label, an author, a date, "sem descrição") stays
escaped: it is a value, not the author's prose.

`.rvprose` is therefore the **third reading surface**, and it does not reinvent
what the first two already decided: `pre`, `table`, `th` and `td` join the
existing `.doc` selector lists rather than declaring parallel rules, so a code
block is a box and a wide table scrolls inside its own container (§3, §7). The
`pre-wrap` is switched off — with real block markup every newline in the source
would otherwise become a blank line. The heading ladder is the CARD's scale, not
the document's (the card is half the width): it only descends, and h4 is never
smaller than the 13px prose it introduces.

Pinned by R56 (three cases), proved red by five mutations: the description back
to `esc`, the comment back to `esc`, `.rvprose pre` leaving the `.doc` family,
the `pre-wrap` returning, and the ladder ceasing to descend.

### Still open — the detail does not appear until the reader clicks something

Also reported: "ao clicar em uma das PRs, para carregar os dados, eu preciso
clicar em algo da tela." NOT fixed, and deliberately not guessed at. What was
ruled out by reading, each with the reason:

- the eight new commands are all `async fn`, so none of them blocks the main
  thread (the ADR-0022 §28 class);
- `invoke` is Tauri's own, with no queue or serialisation in front of it;
- every route into the destination goes through `goDest`, which sets the shell
  destination BEFORE `refreshReview`, so `loadReviewDetail`'s `reviewOn()` guard
  is true at click time;
- `renderReviewDetail` has no signature guard — it paints unconditionally as
  soon as `REV.detail` is set, and wires its own controls in the same pass;
- `REV.openNum` only changes in `openReview` and `backToReviewList`, so the
  `if (REV.openNum === number)` check after the await holds;
- `gh pr view --json <detail fields>` measures 1.69s and `gh pr diff` 1.98s on
  #6 of that repo, so the wait is a few seconds and the placeholder
  ("um momento…") covers it — slowness alone does not explain the report.

That leaves the await itself not resuming, or a repaint that does not reach the
screen — neither of which can be told apart without driving the running app.
Reproducing needs one instrumented run; the fix must not be authored before it.

### The click froze the window, and the same list was fetched twice

Also reported by the owner: "ao clicar em Review, o app dá uma travada", and the
review taking long to load. Measured on `turbiteam/turbo`, one click on the
destination:

| command | thread | subprocesses | cost |
|---|---|---|---|
| `git_branches` | **main** | 13 (`ls-tree` per branch × 2) | ~0.15s |
| `brain_git_diff` | async | 1 | ~0.1s |
| `gh_pr_list` | **main** | 1 (network) | **~1.7s** |
| `brain_notifications` | **main** | 4 — `gh --version`, `gh auth status`, `gh_account`, **and `pr_list` again** | **~3.3s** |

≈5s of blocked main thread per click, and `gh pr list` fetched **twice** in the
same click. `gh auth status` alone costs 0.76s because it validates the token
over the network, and it ran on every tick.

The cause is the ADR-0022 §28 class on the git side: a `#[tauri::command] fn`
with no `async` runs on the main thread in Tauri v2, and **all 14** git/gh
commands were written that way. The guard that exists watches transcription, not
this.

**Decided**, four layers:

1. **The right thread.** The four commands the destination fires
   (`gh_pr_list`, `gh_pr_status`, `git_branches`, `brain_notifications`) become
   `async fn` handing their blocking work to `spawn_blocking`, the shape
   `env_doctor` already had. Scoped to the review path by the owner's decision
   (2026-08-17): the conversion is mechanical but it touches flows that cannot be
   exercised without running the app. **The other ten remain synchronous and are
   an open item** — see below.
2. **One reading, one source of truth.** `pr_list_cached(base, max_age)` in
   git.rs, read by BOTH `gh_pr_list` and `brain_notifications`, so the duplicate
   network trip is gone by construction rather than by discipline. It returns the
   reading's AGE with the data, because the screen is not allowed to pass a
   cached list off as a reading of now (DESIGN.md §1).
3. **Single-flight.** The lock is held ACROSS the fetch, so a second concurrent
   caller waits and finds the result ready instead of spawning a second process —
   the cure for the herd when the 10s tick and a click land together. This is why
   the function may only be called from inside `spawn_blocking`.
   Every write to a review (`gh_pr_review`, `gh_pr_merge`, `gh_pr_reply`, and both
   outcomes of `brain_propose_change`) invalidates it: the worst possible stale
   read is the world from before the reader's own action.
4. **Cache-then-revalidate, and the age is stated.** The destination paints the
   list it already knows before awaiting anything, then repaints when the remote
   answers. `REV.prsFresh` is true only for a reading that just came off the
   network (`ageMs === 0`); while it is false and there is a list, `#revAge` says
   «esta é a leitura anterior — buscando as revisões de agora…», or, with no
   network, that this is the last reading taken. Three states, three sentences, and
   silence when the list is fresh — a label on a fresh reading would be noise.
   Opening a review also stopped being serial: `gh_pr_detail` (~1.7s) and
   `gh_pr_diff` (~2.0s) are independent, so they go out together (`allSettled` —
   the review's text is worth reading without its diff) and the wait is the slower
   one, ~2.0s instead of 3.7s.

Pinned by R57 (eight cases), proved red by nine mutations. One of them matters
more than the rest: the first version of "paints before the network" compared text
indexes inside the function body, and the FIRST `renderTeamReviews()` there
belongs to the blocked-team branch, before the await — so the assertion passed
with the pre-paint deleted. It was replaced by a harness that EXERCISES
`refreshTeamReviews` with a promise the test controls and asserts WHEN the painter
ran. An assertion that cannot fail is the disease this repo already caught once (a
grep filter hiding a `cargo fmt` diff), and it was in the new test, not the old.

### Still open

- **Ten git/gh commands still run on the main thread**: `brain_timeline`,
  `brain_git_state`, `brain_git_files`, `brain_git_commit`, `brain_version`,
  `git_switch_branch`, `git_create_branch`, `brain_pr_template`,
  `brain_set_pr_template`, and `gh_pr_list`'s neighbours in the wizard path. Each
  one freezes the window for as long as its subprocesses take. The guard added by
  R57 is POSITIVE (it asserts the four are off the main thread) rather than an
  allowlist, precisely so it does not launder the other ten into a permanent
  exemption.
- **The closed file card still needs the whole diff.** Rendering the cards from
  `pr.files` (which `gh_pr_detail` already returns, with the counts) would let the
  diff be fetched only when a card is opened, taking it off the critical path
  entirely. It changes `changeCardHtml`'s contract and its tests, so it was not
  done in this round.
- **The detail still has no cache.** Re-opening the same review re-reads it.

### Sending was a step that no longer existed, and saving did not keep its promise

Reported by the owner: "se já existe uma PR aberta para a branch, não deveria
mostrar send for team review. Além de que o commit deveria ser junto com o push no
save a project version."

Both halves are one design, and together they close the round-5 open finding
`save-does-not-update-the-open-review`.

What was there: `#revProposeBtn` read «↗ Enviar para revisão do time» and, on a
draft that already had an open review, `brain_propose_change` **updated** that
review instead of opening one (D-B). A control promising to open what it was going
to update. Meanwhile the F11 banner and the manual had been claiming «salvar versão
atualiza a revisão aberta» since round 1 while `save_version` only committed — the
version stayed on the machine and the team kept reading the previous one.

**Decided:**

- **The rule lives once.** `RV.openReviewFor(prs, branch, {me})` in `review.js` is
  the screen's half of `propose_act` (git.rs) — same question, same answer. Two
  copies of that rule diverge, and the price of the divergence is exactly the
  mislabelled control.
- **Saving pushes when, and only when, the draft already carries an open review.**
  `open_review_to_update` asks the remote only if there is a new version to show
  and the team environment exists (`gh` present, authenticated, a remote), so a
  project without a team spends no process on the question. A draft with **no**
  open review pushes nothing: «nada sai do seu computador sozinho» is the
  destination's own opening sentence, and sending stays the decision to share. The
  push is a consequence of a decision already taken, never a new one.
- **The commit and the push are separate facts.** `VersionAttempt` gained
  `review: Option<u64>` and `pushed: bool`. A commit must not be lost because the
  network died, so the toast has three outcomes and three sentences: the review was
  updated; the version is saved here and the review gets it when the network
  returns; or there was no open review at all. Saying «revisão atualizada» after a
  failed push would be the same class of lie this section exists to remove.
- **The control leaves the screen, and the state takes its place.** `#revOpenState`
  names the review (#N) and says what the remaining step is, with a door to it —
  never a number without a door. With the team **blocked** the button stays visible
  and disabled instead (R44's contract is unchanged): a door that vanishes is worse
  than one that says why it is shut, and a possibly-stale PR list is not grounds to
  remove it.
- **`brain_version` leaves the main thread**, because it just gained network I/O,
  and invalidates the PR-list cache when it pushes.

Also fixed on the same lines: `paintEditBanner` filtered with `!p.mine`, and
`PrInfo` has no `mine` field — so the expression was always true and **your own**
draft under review got the sentence written for someone else's ("você está
editando o rascunho…"). Seen in the running app against `turbiteam/turbo` #6. It
now asks the shared rule, and on your own draft the banner does not appear at all
— the open-review state is what speaks there.

Pinned by R58 (five cases), proved red by eight mutations: the button returning
with a review open; the push removed; a draft *without* a review starting to push;
`brain_version` back to sync; the toast claiming an update after a failed push; the
banner reading `p.mine` again; the shared rule treating a CLOSED review as open;
and the cache not being invalidated when a version reaches the review.

**Still open from this:** the ✦ IA panel's `#proposeBtn` keeps its label in the
same situation. It cannot apply the rule reliably — `REV.prs` is only populated
once the destination has been visited — and its *outcome* is already honest
(`PrRef.updated` drives the sentence). The destination is the surface that knows.

## Round 7 — the open findings, closed

The loop exited on its declared cap of five rounds with 15 findings still open,
and rounds 6 closed two of them (`save-does-not-update-the-open-review`, the
markdown body). The owner asked why the rest were still open; the answer was the
cap, and the cap was theirs to lift. This round closes the remainder.

### The blocker

`review-now-list-never-self-refreshes`. `setInterval(brainRefresh, 10000)` re-read
`brain_git_files` — which is why the sidebar's unsaved dot updated — and never
called `refreshMyChanges()`. So one window made three claims at once: the dot lit,
the centre saying «tudo salvo» with `#revSaveBtn` disabled, and the draft picker
refusing every switch with «salve uma versão antes de trocar de rascunho», whose
stated remedy was the button the screen had just turned off. **Decided:** the
destination joins the app's single clock (`if (reviewOn()) { refreshMyChanges();
refreshTeamReviews(); }`). Both halves are self-gated — `renderMyChanges` repaints
by signature, so the poll cannot close an open card, and `gh_pr_list` answers from
the 30s cache, so a 10s tick costs one network read every third pass. The
visibility gate still holds: no work while the window is occluded.

### The type system

`.phead` is `600 11px var(--mono)` UPPERCASE at `--muted` — the machine naming a
bin (IDEIAS · COM ESTE DOCUMENTO), which §3 endorses. The destination had reused it
for authored PROSE («Aguardam a sua revisão», «O que muda», «Conversa», «Sua
revisão»), and the ladder inverted: an h2 of 11px at 4.65:1 introducing 13.5px card
titles. **Decided:** the panel keeps `.phead` (it is right there); the destination's
sentences get `.rvhead`, `--sans`, sentence case, and a ladder that descends —
h2 15.5 > h3 14.5 > card title 13.5 > prose 13.

`.pbranch` is `11.5px var(--mono)` and `draftChipLabel` put the whole sentence
inside it. §5: a field's label is prose, only its VALUE may be mono. **Decided:**
`draftChipHtml` splits them — glyph and sentence in `--sans`, the draft's name (an
address) in mono. `draftChipLabel` survives as the plain text, because the
accessible name and the toasts need the sentence, and two sources for one fact
diverge.

`.badge` shipped 10px, under both the 10.5px floor and the 11px the §3 table gives
a badge. The guard the round-5 critic wanted was never written because it would
have been red. **Decided:** `.badge` → 11px, and the new guard also measures the
COUNTERS, which caught two more the finding never named: `.destbadge`/`.cbadge` at
10px and `.minibadge` at 9px, all → 10.5px, the step §3 gives a counter. Two steps,
each on its own kind of mark.

`.termstrip { border-bottom: rgba(255,255,255,.07) }` was the sheet's last colour
literal outside the token blocks and the single row of the widened guard's
allowlist. **Decided:** `--term-line`, beside `--term-bg`/`--term-fg`/`--term-dim`/
`--term-ok`, one value in both themes like the rest of that palette. The allowlist
is now **empty**, exactly as its own self-check demanded ("once the rule resolves
from a token, the row goes").

### Controls that misled

The collapsed-gap notice was byte-for-byte the neighbour that IS a control: same
class, same leading `⋯`, twenty lines above the 400-row cut that carries a real
button. The decision not to make it a control is right (the payload is `-U3`; an
expander would open nothing) — what was wrong is that it looked like one.
**Decided:** `.rvgap.quiet`, without the `⋯`, dashed and dimmer. The `⋯` promises
«there is more, click me».

The draft chip and «trocar de rascunho» opened the same sheet, side by side, and
the chip's accessible name already claims the door. **Decided:** the link is gone —
one control, one outcome, one tab stop. Its msgid left the catalogue in the same
edit, which is what the orphan-msgid guard exists to force.

The «tudo salvo» state and the team gate 300px below carried the same sentence and
the same «abrir Configurações». R48 requires the empty state to keep a door (a step
that works, and a door is not a sentence), so the duplicate that goes is the lower
one: `emptyStateOffersCfg()` is the shared predicate, and the gate's own button
falls silent while the state above is offering it. The note stays — it is the reason
the send button is disabled.

The draft picker capped each name at 170px against the fixed `.fmeta` column, so
two drafts sharing a 24-character prefix painted the identical visible label on the
one screen whose whole job is choosing which knowledge base comes to the front.
The accessible names were complete, so someone listening could tell them apart and
someone looking could not. **Decided:** `.fitem2.draftrow` gives the name the whole
line and lets it wrap (§7); the counter drops to a second line instead of eating
the identity.

The header had no floor on `.apphead .switch`, so once decoration and air were
spent below 1015px the whole remaining deficit landed on `.projname`, measured down
to a 7px sliver. **Decided:** the floor belongs to the BLOCK — `min-width: 118px`
(logo + the documented 70px + caret) — and the `max-width` stays what it always
was, the label's ceiling.

### The propose sheet, and a surface the ADR claimed but never had

The backend already computed `PrTemplate.hints` — each section's own `<!-- … -->`
sentence — and the sheet threw them away, asking for the description the whole team
will read as N blank single-line boxes. **Decided:** the hint is the field's
placeholder, and the field is a `textarea rows="2"`, because «o que muda e por quê»
is not a one-line value.

This ADR claimed «the suggestion renders read-only; the way out is `abrir no
GitHub ↗`» and neither msgid existed anywhere: a ```suggestion fence arrived as an
unnamed code block. Documentation describing a surface that was never built.
**Decided:** `suggestionHtml` names it, shows what is being suggested, and states
the way out. Applying it stays unimplemented for the reason already recorded.

### Found by driving the app against the real remote (`turbiteam/turbo`)

- **`0 de 0 aprovações` on a `REVIEW_REQUIRED` review.** The denominator is the
  people IN the review, which is a fact — but with nobody assigned it summed to
  zero, which READS as "nothing pending" while GitHub blocked the merge. The
  decision is in the same payload. **Decided:** when the remote says a review is
  required, the denominator is at least one.
- **The team list could not say a change was blocked.** `pr_list` asked for neither
  `statusCheckRollup` nor `mergeable`, so a change with failing checks or a
  conflict looked exactly like one that was ready — the question F6 exists to
  answer at a glance. **Decided:** both fields join the same `gh pr list` (no extra
  process), `check_runs` becomes the one translation both the list and the detail
  read, and `RV.listChips` is the rule for what the row may claim. The state also
  reaches the row's accessible NAME, not just its pixels.
- **The quoted excerpt carried `@@ -3,35 +3,107 @@`.** GitHub's `diffHunk` opens
  with the header, and it reached the reply sheet. §5: machine syntax does not
  reach the surface. **Decided:** `last_lines` drops it — it is neither the
  commented line nor its context.
- **`paintEditBanner` filtered on `!p.mine`, and `PrInfo` has no `mine` field**, so
  the expression was always true and your OWN draft under review got the sentence
  written for someone else's. **Decided:** it asks the shared rule, and on your own
  draft the banner does not appear at all — the open-review state speaks there.

### Housekeeping

`desktop/src/review.js` and `desktop/src/workspace.js` were absent from the
Makefile's `JS_SRC`, so `make lint`'s `node --check` never parsed the destination's
pure module. Both are in now.

### Proof

R59 through R62 plus the widened R60 guards, **19 mutations, 19 killed**. One of
them mattered more than the rest: a mutation aimed at `paintEditBanner` first hit
`paintTeamGate` instead and survived, which exposed a real weakness in R58 — its
assertion matched BOTH copies of the open-review sentence, so it could not tell "my
draft" from "someone else's". The test now exercises both branches with the account
set, and the re-aimed mutation dies. The mutation that survives is the one worth
having.

**Deliberately still open**, and both are the owner's standing decisions:
`brain_timeline`, `brain_git_state`, `brain_git_files`, `brain_git_commit`,
`git_switch_branch`, `git_create_branch`, `brain_pr_template` and
`brain_set_pr_template` remain synchronous (the owner scoped `spawn_blocking` to
the review path on 2026-08-17, and the R57 guard is positive so it does not launder
them); the ✦ IA panel's `#proposeBtn` keeps its label because it cannot read
`REV.prs` reliably; the closed file card still needs the whole diff; and the review
detail has no cache.

## Round 8 — a loader, the header's draft, and saving a file is not a commit

Three things the owner asked for on 2026-08-17, after using the destination.

### «Ainda não carreguei» is a third fact

`REV.prs || []` collapsed `null` (never loaded) with `[]` (loaded, and there are
none), so on first entry the screen said «nada aqui ainda — nenhuma revisão aberta
ainda» for ~1.7s while it was still fetching. The state lied, and the step it
oriented was to send a change that might already be there.

**Decided:** loading is a third state, distinct from empty, from populated and from
blocked. The indicator is the one the house already had — the chat's «pensando…»:
three dots, a mono label, the `prefers-reduced-motion` wrapper, and the text in a
`role="status"` node so someone who cannot see the screen hears that it is working
(WCAG 4.1.3). A second indicator would have been a second anatomy for the same
fact, so `.chatthinking` and `.rvloading` share the rule the way `.doc pre` and
`.rvprose pre` do.

Loader and age label are **mutually exclusive by construction**: the loader says
"I have nothing", the age label says "I have something and it is not from now".
Cache-then-revalidate means the loader only ever appears on a genuinely cold start.

### The draft belongs in the header

The design puts `⎇ {{ branchName }} ⌄` in the header's right block, before Gravar.
It shipped only inside the ✦ IA panel's TIME section, so the fact that decides
where your next version lands was visible only with the panel open and a document
in focus. **This was a departure nobody wrote down** — exactly what the intent lens
exists to catch, and it slipped through five rounds.

**Decided:** `#headDraft`, painted by the same `draftChipHtml`/`draftChipLabel` as
the other two chips (one fact, one name), opening the same sheet, under the same
authority (the git state — no branch, no control; an empty chip is not a fact). Per
§2 rule 9 it is the **first** thing to yield width: below 1015px only the glyph
remains, and the name stays in the title and in the sheet it opens, so no label is
ever cut.

### Saving a file is not a commit

The editor's footer had ONE primary, and on a knowledge document it wrote the file
**and** opened the version sheet — there was no way to just save your text. A commit
is of the whole project, not of the document in focus.

**Decided:** the footer's button writes the file, and says only that («Salvar», for
both kinds of document). The version sheet keeps its two doors — the ✦ IA panel's
TIME section and the Revisão destination, which is on the clock and shows the change
as soon as the file is written.

This **reverses F30**, whose guard asserted the footer's save *reached* the version
sheet — that flow existed and used to die silently, which is what F30 was written
for. The assertion is migrated to the stronger shape: it now **forbids** rather than
requires (`promptVersionar`, `brain_version` and `brain_git_commit` must not be
reachable from that handler), pins the single label, and asserts the version sheet is
still reachable by its own doors. Recorded here because reversing a decision that
carried a test is not a refactor.

Pinned by R63, R64 and the migrated F30; **11 mutations, 11 killed**.

## Round 9 — seen in the running app, against turbo

Three reports from the owner, and this time I brought the app up and looked. All
three were mine, and two of them were worse than what was reported.

### The header chip I added was the broken design

The design's header carries `⎇ {{ branchName }} ⌄` — glyph, address, caret. I reused
the composer's form, which carries PROSE («no rascunho …»), and in a 190px pill that
sentence wrapped onto two lines, inflating the control and pushing the header out of
alignment. **Decided:** `draftChipCompact` for the header — glyph, the address in
mono, caret, `white-space: nowrap`, the address truncating with an ellipsis. The full
sentence stays in the `title` and the accessible name, which is where it fits. Below
1015px the address and caret go and only the glyph remains.

### Saving a version moved you off your own draft

The worse one, and the root of the report about the two contradictory sentences.
`save_version` called `create_branch` **unconditionally**, and `create_branch` is
`git checkout -b rfc/<slug>`. Standing on a branch that is not spelled `rfc/…` — the
normal case for a team repository, and exactly turbo's `feat/acervo-navegavel` —
saving **moved you to a brand-new draft** named after your sentence, and the open
review on the branch you left never saw the version. The screen said both things at
once: «salvar cria um rascunho de trabalho com o nome da sua descrição» and «salvar
versão atualiza a revisão aberta». The first was the true one.

**Decided:** a version lands on the draft you are standing on. Only from the
**official knowledge** does saving create a draft — that is where one has to be born,
because the official branch takes no direct commit. `#revSaveNote` now asks the right
question (`willCreateDraft`: are we on the default branch?) instead of asking whether
the branch is addressable as `rfc/<slug>`, which is a different question and answered
"no" for every team branch.

### Switching drafts was refused for a reason that was not git's

Reported as «não tenho conseguido trocar de branch onde a opção aparece».
`switch_branch` refused **any** dirty working tree before asking git. Git only refuses
when the checkout would overwrite the modification; in the common case it carries the
change with you and nothing is lost. And since saving a file stopped committing
(round 8), a dirty tree became the normal resting state — so every row in the picker
lived disabled, with «salve uma versão primeiro» pointing at a button that had nothing
to do.

**Decided:** git decides. The attempt happens; the only refusal it gives here is the
overwrite, which becomes `err.switch_would_lose_change` — the one case where "save a
version first" is the right remedy. The picker stops pre-disabling rows and states
the price instead: your unsaved change travels with you, and if the document differs
in the target draft the switch is refused and the screen says which. This **reverses
R19**, whose premise ("the sheet does not offer a switch it knows will be refused")
was true only because of the over-strict pre-check; the migrated pair is stronger
because it covers both sides — no pre-refusal of what git allows, and a real refusal
that arrives with its remedy.

### And the identity it did not have

`paintOpenReviewState` and `paintEditBanner` asked `RV.openReviewFor(..., {me:
reviewMe()})`, and when `envDoctor.account` has not been read yet `reviewMe()` is
empty, so `same("aipi", "")` is false and **your own** change announced itself as
someone else's — the same class as the `p.mine` bug of round 7, one layer up. Not
knowing who you are is not the same as knowing the draft is not yours. **Decided:**
with no account read, the neutral sentence — the one true in both cases — and the
F11 banner is not drawn at all.

### The loader the previous round missed

«O loader do review não está mostrando»: rounds 8 gave the two LISTS a loader and left
the DETAIL — which is where the ~2s of network actually happens — with the word «um
momento…» glued to the review number. **Decided:** the detail gets the same indicator
as everything else, with its own `role="status"`.

Pinned by R65, R66, the migrated R19/R58/R64, and two new Rust tests
(`a_version_lands_on_the_draft_you_are_standing_on`,
`from_the_official_knowledge_a_version_still_creates_the_draft`), each proved red.

**What this round says about the method:** every one of these was invisible to a
source-level suite and obvious in one screenshot. Three rounds of CSS and copy went
out verified only by tests, and the tests were green the whole time.

## Round 10 — the code review of PR #71

Nine findings, all real. Three were fixes from earlier rounds that **never fired**,
and none of the eight corrections broke a single existing assertion — which is the
finding behind the findings: my tests asserted the rules and not the contracts.

### The one that was security-shaped

`esc()` escaped `& < >` and not quotes, and this surface interpolates
**third-party text into HTML attributes**: a PR title (any fork author), a file
path, a check name, a conversation address. One quote closes the attribute, and the
app's CSP allows inline styles, so a title like `Prazo" style="position:fixed;inset:0`
lands a `style` on the row and can blanket the window (inline JS is blocked, so this
is attribute/CSS injection, not script execution). With no malice at all, a path
containing `"` — legal on macOS and Linux — truncated `data-rvfull`, `RV.fileAt`
returned null, and «ver a mudança completa» became a control that does nothing.
`focusMarkIn` already guarded `/["\\]/`; the awareness was missing everywhere else.
**Decided:** `esc()` escapes all five. One change, every emission site, impossible to
miss the next one.

### Two fixes from earlier rounds that were dead on arrival

- **The check chip on the team row (round 7).** `PR_FIELDS` gained
  `statusCheckRollup` so the row could say a change is blocked, and `check_runs`
  existed to translate it — but it was only called from `detail_from`. `pr_list`
  handed JS the raw gh payload, so `pr.checks` was `undefined` and a PR with red CI
  rendered identically to a clean one. **Decided:** `with_normalized_checks`, a named
  function both `pr_list` and `pr_status` route through, and `PrInfo` carries
  `checks` (product values) while `statusCheckRollup` stops being serialized at all.
- **«0 de 0 aprovações» (round 7).** `PR_DETAIL_FIELDS` asked gh for
  `reviewDecision` from the first day and **no struct carried it**, so the guard that
  raises the denominator saw `undefined` and the screen kept saying the count was
  settled on a PR GitHub blocks. **Decided:** the field exists on `GhPrView` and
  `PrDetail`.

Both of my tests passed because they fed the already-normalized shape. The check
test now exercises `with_normalized_checks` **and asserts the wiring** — its first
version re-did the translation itself, so tearing it out of `pr_list` did not make it
fail. That mutation is the one that mattered.

### And one the new guard found on its own

Writing the check-shape test surfaced something nobody reported: `checksState`
returned `"ok"` for any list where nothing matched `"failed"`/`"running"`, so an
unknown state — including a raw gh `"FAILURE"` leaking through a contract gap —
painted **green**. The Rust side already had this rule (`check_state`: an unknown
state is never reported as passing); the JS side did not. **Decided:** `"ok"` is the
affirmative branch, so it is the one that requires every state to be known.

### Five smaller ones

- `%1 de %1 aprovações · verificações ok` — `t()` replaces `%1` globally, so it
  always printed have/have next to a header saying «1 de 2»; and `canMerge` accepts
  `checks === null` (no CI at all), where «verificações ok» asserts a check that
  never ran. Now `%1 de %2`, and the check sentence only when there are checks.
- `openForEditing` called `land()` regardless of the confirmation sheet, so
  cancelling left the view switched and the review closed. `confirmSwitchBranch`
  takes an `after` callback that runs only when the switch happens.
- `paintTeamGate` assigned `btn.hidden` only in the unblocked branch, so a draft
  under review followed by a network drop left the permanent door invisible forever,
  with its `aria-describedby` note on screen describing a control that is not there.
- An outdated **conversation** was badged with the approval msgid. It has its own now.
- `switch_branch`'s refusal mapping matched English git output only, and
  `proc::command` pins no locale — on a localized git the refusal fell through and
  raw git prose reached a pt-BR toast, which is what the mapping exists to prevent.
  `LC_ALL=C`/`LANGUAGE=C` are pinned on the call whose output we parse.

Pinned by R67 (six cases in JS, two in Rust); **10 mutations, 10 killed**.

### The two that were recorded, and then closed

- **`working_diff` filters `is_versioning_denied` and `pending_entries` does not**, so
  in a legacy acervo where meeting artifacts live under `contexts/<x>/` a *tracked*
  denied path counts in `pending_changes`/`is_dirty`, never appears as a card, and
  `unstage_versioning_denied` resets it on every save — a permanent phantom pending
  change, and the same dead end this ADR fixed for `.brain/state.json`. It predates
  this work and touches `pending_changes` semantics broadly, so it belongs to its own
  change.
- **The six review commands are `async fn` that block directly** rather than using
  `spawn_blocking`. Tauri v2 spawns them onto the async runtime, so the window does
  not freeze — but the guard only greps for `async fn`, so a regression to blocking a
  runtime worker would pass, and `pr_list_cached`'s "only from `spawn_blocking`"
  contract is enforced by convention. None of them calls it today.

## Round 11 — closing the two the review left open

Both were recorded as "someone else's change" in round 10 and the owner asked
whether they were worth doing now. They were, for different reasons.

### The phantom pending change, and why it never terminated

The reviewer described the symptom; reading it turned up **two** faults nested in
each other, and a comment in the code asserting something untrue.

`pending_entries` carried this justification for counting a tracked quarantined
path: *"the next version is what takes it out of the index, so hiding it would
leave the save button disarmed over work git still owes."* That premise was false.
`unstage_versioning_denied` ran `git reset -- <rel>`, which **unstages** and leaves
the path tracked — so the next version found it modified again, forever. Meanwhile
`working_diff` filters it, so it never had a card. The result was a permanent dead
end: the save button armed next to «tudo salvo» on the same screen, saving never
clearing it, and `pr_merge` refusing with `err.working_tree_dirty` for good.

**Decided**, both halves:

1. `unstage_versioning_denied` uses `git rm --cached --ignore-unmatch` — the same
   mechanism `stage_and_commit` already applies to everything that must never be
   versioned (`inbox`, `brainstorming`, `.brain/state.json`): out of the index, still
   on disk. Now **one** version resolves it instead of restarting the loop, and the
   raw transcript leaves the repository, which is the point of the rule (BR-8).
2. `pending_entries` stops counting an **untracked** denied path. Those two families
   — the quarantined folders (`GIT_IGNORED`) and the material
   `is_versioning_denied` refuses *inside* `contexts/` — are not pending work,
   because no version will ever carry them. The second one could not be covered by
   an ignore pattern, because the folder around it is versioned; that is exactly why
   it was invisible to the first filter.

Still **tracked**, it is pending work for exactly one version — the one that
untracks it. After that it lands in case 2. The loop terminates.

Pinned by `quarantined_material_inside_contexts_resolves_in_one_version`, which
builds a real legacy acervo (a raw `reuniao.md` committed beside its `context.md`),
and **each half of the fix was mutated separately** — reverting either one turns it
red. The test also asserts the file is never deleted from disk and the real context
stays versioned.

### The cache contract, derived instead of listed

`pr_list_cached` holds a blocking `Mutex` **across** the fetch — that is what makes
the single-flight work — so calling it from an `async fn` that does not delegate
pins an executor thread with the lock in hand. Nothing violates it today, and the
guard that was supposed to protect it listed four command names by hand: a new
command reading the cache would have passed.

**Decided:** the guard **derives** the set. It parses every function in `lib.rs`,
resolves which `#[tauri::command]`s reach `pr_list_cached` (directly or through a
`_blocking` helper), and requires `async` + `spawn_blocking` on each. It also
refuses to pass when it finds fewer than two readers, because a scanner that goes
blind is the same disease as an assertion that cannot fail. Proved by adding a
`gh_pr_peek` command that reads the cache inline: red, naming the command.

