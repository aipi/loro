# ADR-0026 — Addressable context: the link is the graph, the index is a screen

- Status: accepted
- Date: 2026-08-13
- Extends: ADR-0004 (efficient-reading layer — summary card, stable IDs, protocol),
  ADR-0018 (the analysis is the meeting's output), ADR-0020 (one anatomy,
  deliberate removals), BR-1, BR-8
- Answers: ADR-0004 §5, which deferred retrieval infrastructure until an acervo
  demonstrably outgrew "grep + index routing". One did — 80 contexts — and the
  measurement below says the missing piece was never an index engine.

## Context

A knowledge base of 80 `context.md` files was **readable but not reachable**.
ADR-0004 made each file cheap to read (§0 card, `D-…`/`H-…` ids, the protocol in
`AGENTS.md`); it left the space *between* files undescribed:

- A neighbouring domain was named in backticks. A name goes nowhere — the reader
  had to guess the folder and the writer had no way to state a dependency.
- `H-3` is numbered **local to its file**, so the id that ADR-0004 made greppable
  is ambiguous the moment it is quoted anywhere else.
- An external code (`MM-1147`) was a string in prose; whether it opened anything
  depended on the reader knowing which tracker the team uses.
- Nothing in the acervo could say **who depends on this document**, so a context
  nobody cites read exactly like a context everybody cites.

The obvious answers (a vector index, a generated graph file, a typed catalogue)
all add a second artefact that can disagree with the markdown. Before building
anything, the alternatives were **measured** on the user's real 80-context
acervo. The measurement decided the shape of this ADR, so it comes first.

## Measurement

Two independent runs, both over the same real acervo and the same 12 questions
taken from real use. **A deterministic retrieval bench** (rank the 80 contexts
per question from a given corpus, then read what the protocol prescribes) and a
**manual A/B** of the reading protocol, audited line-by-line against the source.

| Ranking corpus | hit@1 | hit@3 | MRR | bytes read | files opened |
|---|---|---|---|---|---|
| `INDEX.md` as committed (3.062 B, **16** of 80 contexts described) | **0,17** | 0,25 | 0,247 | 90.666 | 7,08 |
| `INDEX.md` rewritten (22.631 B, **all 80** described) | **0,50** | 0,67 | 0,568 | 84.952 | 4,08 |
| §0 summary cards of all 80 (corpus 125.691 B) | 0,42 | 0,67 | 0,579 | 170.493 | 3,08 |
| cards + anchor text + hotspot titles (+21.380 B) | 0,42 | 0,67 | 0,574 | 193.356 | 3,25 |
| cards + anchor text only | 0,42 | 0,67 | 0,579 | 174.668 | 3,08 |
| cards + hotspot titles only | 0,42 | 0,67 | **0,561** | 191.951 | 3,33 |
| cards + locator (read card + 1 section, not the file) | 0,42 | 0,67 | 0,574 | 162.243 | 3,25 |
| full text of all 80 (**ceiling**, not a protocol) | 0,42 | 0,75 | 0,579 | 1.031.094 | 2,92 |

A second round measured the step the first one exposed: *which section* to read
once the right document is open. Section accuracy, on the runs that reached the
right document:

| How the section is chosen | section hit | bytes/question (amortised) |
|---|---|---|
| term match against each section's full body | 0,36 | 15.172 |
| routed by the §0 card's own line for that section | **0,27** | 12.205 |
| the same routing, reading the top 2 sections | 0,45 | 20.020 |
| **routed section + the facts section (§5)** | **0,73** | **17.343** |
| control: no ranking at all, always §5 | 0,55 | 11.230 |

The control is the finding. On this set the truth sits in §5 six times out of
twelve, so *always* reading §5 scores 0,55 — **better than every single-section
ranker**, including the one routed by the card. Two defects came out of that:
term scoring had no length normalization (an unnormalized tf sum let §3 "Fluxos
principais", the longest section, win by volume — it was picked for four
questions answered in §5), and the question-shape prior was added to raw idf sums
in the tens, so a 0,35 nudge was arithmetic noise dressed as a rule. Both fixed,
and the router still loses to the constant at top-1. What ships is therefore the
constant *plus* the hint — card + routed section + §5, at 0,73 for 17 KB against
87 KB for whole-file reading — and the control stays in the bench so no future
round mistakes a mediocre ranker for a result.

What the numbers say, including where they contradicted the plan:

1. **Describing every context is the whole lever.** 16 → 80 described entries
   tripled hit@1 (0,17 → 0,50), cut files opened from 7,08 to 4,08, and read
   *fewer* bytes than the committed index it replaced. It beats the card corpus
   on hit@1 (0,50 vs 0,42) while reading half the bytes (84.952 vs 170.493).
2. **A corpus of §0 cards is not a retrieval index, and was not built as one.**
   It never beats the described flat index on hit@1, and the manual A/B's
   headline "53% fewer bytes" did not survive audit: both arms read the same
   thing per question (§0 card + one section), so the comparison was one fixed
   cost paid 12× (the index) against another paid once (the card corpus).
   Amortised once per session — 78.503 B (6.542 B/question) against 152.684 B
   (12.724 B/question) — the card corpus reads **94,5% more** for the same 12
   answers, and break-even moves from ~4 questions to ~45.
3. **Exactness was tied at 12/12.** Both protocols answered every question
   correctly, so no cost claim here is paid for with precision. Two real defects
   showed up on the section-scoped side and both argue *for* addressing: a
   section-scoped read dropped an external code that lived in another section
   (provenance is cross-section, which is what a locator is for), and one answer
   read the 6.145 B section when a 2.414 B section carried the same sentence.
4. **Hotspot titles are net noise in ranking** (MRR 0,561 with them, 0,579
   without). They are kept as *index terms and locators*, never as ranking input.
5. **One question is unreachable by any lexical strategy**, the full-text ceiling
   included: it asks about "desligar" while the acervo writes "bloqueio de
   ignição" / "imobilização". No ranking corpus fixes a vocabulary gap. This is
   the measured argument for an **índice remissivo** as a device separate from
   ranking: it lists the word *a neighbour actually wrote*.

Once the loop's teaching landed and the first real lateral links were written in
that acervo, it measures **106 internal links, 0 broken**, of which **20 are
lateral**; the graph reports **80 nodes · 63 orphans · 312 hotspots · 176
decisions · 660 index terms**.

The first pass wrote 25 lateral links; an adversarial read of the surrounding
prose removed 5. Three asserted a flow the text denies ("compared, *without
being implemented*", a supplier mentioned inside a hotspot that calls itself an
unconfirmed hypothesis, a *boundary* between two domains the body says are
distinct), one typed a parent→child link as lateral — which would have masked an
orphan — and one turned a "see also" pointer into a declared flow. Three more had
their kind corrected against the citing document's own §0 and §4. **An invented
edge is worse than a missing one**: a missing edge costs a search, an invented
one is a false statement about the business that the graph then counts. This is
the rule's real cost, and it is why the loop is told to link only the handoff. Cost of the whole pass, debug build: 63–72
ms cold over 975 KB, 0,4 ms to assemble the graph, 1,7 ms on the next call with
the cache valid (invalidated per acervo by mtime and size of *each*
`context.md`).

## Decision

### 1. The índice remissivo is computed on read — as a screen, and as a file

`brain_index_terms` walks the documents on every read and the UI paints the
result at `loro://indice` — a sentinel, like the manual's, not a path on disk.

**Revised (owner decision, 2026-08-13):** the same data is also written to
`TERMS.md` at the acervo root, beside `INDEX.md`, by `brain_index_write`. The
reason is portability, not convenience: a file is readable on GitHub and by
another agent, with no Loro installed, and the acervo's premise is that it is
self-contained. The staleness objection stands — a file can only be wrong by not
being regenerated — but it is bounded by the generator being **deterministic**:
no model call, so it can be re-run at any time and never invents a term. Screen
and file come from the same `index_terms`, so the two cannot disagree.

The entries themselves were revised twice. They started as machine artefacts —
decision slugs read "adr001 evento entrada", a hotspot title is a whole sentence
— which is a list of identifiers, not an index. Mining the contexts' prose for
candidate terms was considered next and rejected: it invents vocabulary the
authors never chose. What ships is what the acervo already names: the context's
own name, the label a neighbour wrote when linking to it, and the external codes
it cites. Accent and case fold together ("precificação" and "precificacao" are
one word, displayed the way the language writes it), and repeated sections of one
document collapse into one place — `cadastro §1, §3, §4` — the way a book index
does it.

A written index is a second artefact with the authority of a versioned document
and none of its upkeep: it ages between two writes and then lies in the reader's
favourite place to trust. It would also produce a git diff on every unrelated
edit. Computing it costs tens of milliseconds on the acervo that motivated the
feature (below), which is cheaper than one wrong answer.

**Nothing about the feature writes into the KNOWLEDGE.** `TERMS.md` at the root is
written (§18) and is derived by definition; no `context.md` is ever touched by a
read. A test compares the bytes
of every `context.md` before and after the pass.

### 2. A meeting is cited by ID only — never by path, never by content

The graph opens `contexts/**/context.md` and nothing else. `meetings/`,
`meeting.md`, `notes/` and the audit trail are never read, so there is no path
by which a transcript, a name or any PII reaches an edge, a term or a log
(BR-8). This agrees with the rule the loop already teaches — *do not reference
the meeting file, it is an ephemeral source* — and hardens it: a meeting is
mentioned by its stable id or not at all, because the file it names is not
versioned and may be gone.

### 3. An external locator becomes a link only when the project says where those live

`inlineMd` marks any `[A-Z][A-Z0-9]{1,4}-\d{1,6}` locator as `.loc`. With a
per-acervo base URL configured (`Acervo.ticket_base`, set by
`brain_set_ticket_base`, edited in **Configurações → Projeto**) it becomes an
`<a>`; with no base it is a `<span>` — mono either way, clickable only when
someone said where. Guessing a tracker URL would send the reader somewhere
nobody asked for, and a link that 404s teaches the reader to distrust every
other link on the page. `normalize_ticket_base` accepts **http(s) only** and
appends the separator the URL needs, so a scheme that executes cannot be stored
and `…/browse` + `MM-1` never becomes `…/browseMM-1`.

The prefix floor of two characters is load-bearing: the acervo's own ids (`H-3`,
`D-2026-07-23-slug`) open with a single letter and must never be mistaken for a
ticket.

### 4. A hotspot id is qualified by its context wherever it is quoted

Every surface that quotes an id outside its own file prints `<contexto>#<id>` —
the backend qualifies it, the reader never re-derives it.

This section originally also decided the opposite of §15: that ids would stay
`H-<n>` and never be renumbered on disk, because they are cited in CHANGELOGs and
review threads. That reasoning held for a *renumbering* — swapping one arbitrary
number for another. It did not survive the owner asking for an id that carries a
date, which is not a renumbering but a change of kind: from a counter local to a
file to a name unique in the acervo. §15 supersedes that half; the qualification
rule here stands, and is what makes both the old and the new id addressable.

### 5. The lateral link carries its kind, and the target has to exist

The loop's `AGENTS.md` template (pt and en) now teaches: cite a neighbour with a
**relative link**, not a name in backticks; write the **kind** in one word right
after it — `upstream` (the other feeds this one), `downstream` (this one feeds
the other), `bidirecional`; **the path must exist**; and link **only the real
handoff**. Linking every mention erases the signal — a context cited by many is
central only if citations are scarce and true.

Edges are deduplicated by `(from, to)`: citing the same neighbour three times is
one neighbourhood, and if only one mention declared a kind, the kind survives.
A **parent → child** edge does not count as lateral (a parent indexing its
children is navigation), while **child → parent** does (pointing upwards is a
claim the child chose to make).

### 6. The reader inverts the direction; the writer's words are never rewritten

`kind` is echoed exactly as the citing document declared it. Printed raw on the
cited document's page it would say the opposite of what is written, so the
inversion belongs to the reading surface: `upstream` → *recebe deste*,
`downstream` → *entrega para este*, `bidirecional` → *nos dois sentidos*. With
no kind declared, the row exists and the direction stays silent — no badge is
invented.

`brain_backlinks(rel)` is asked only of `contexts/**/context.md`, and its markup
is built in the **same paint** as the document, so the panel never shoves the
text down after the reader has started reading.

### 7. The índice points at where the word is written; who cites whom is a different question

An index entry addresses **inside** the document that wrote the word
(`assinatura#H-3`, `D-2026-05-12-slug`, `§2`, `MM-1147`). Who cites whom is
`brain_backlinks`' answer. Duplicating it in the index would let the same fact
disagree with itself on two screens.

Terms come only from what is **already written**: the anchor text a neighbour
chose (how the neighbour *calls* the thing — the measurement's answer to the
vocabulary gap), hotspot titles, decision slugs (minus the date prefix, with the
full id in the locator) and cited external codes. No NLP, no stemming, no
stopword list.

### 8. The graph reports what the knowledge says about itself, with the door to the fix

Two defects, both named and both actionable: a context **nobody cites laterally**
(orphan — whoever reads along the links never arrives) and a link whose **target
does not exist** (dead end). Each row names the *topic*, not the path, and
carries one action — *abrir* — which opens the document where the fix belongs:
the orphan itself, or, for a broken link, the document **that cites**. The broken
target is shown exactly as the author typed it, because that is the string to
correct. A section with no defect is not drawn.

ADR-0020 §4 removed the home statistics because they answered no question and
offered no action. These pass that bar in both directions, which is the only
reason they exist.

### 9. All three reads are async, on purpose

The three commands are `pub async fn`. A synchronous Tauri v2 command runs on the
main thread, and scanning 80 documents there is the bug class of ADR-0022 §28 —
the third occurrence of which was already guarded by a test. A test breaks if
anyone drops the `async`.

### 10. The reading protocol says where to land, not just where to start

ADR-0004 §4 taught four steps and stopped at "read only the needed section" —
which, measured, meant a 36% chance of the needed section. The protocol now names
two things it did not: an **id already addresses its section** (`H-<n>` is §6,
`D-…` is §5, so there is nothing to search), and with no id the reader picks the
section by the **card line that answers** and reads it *together with §5*. Both
`agents_template` variants and every skill that routes from `INDEX.md` carry the
rule; a test asserts it on whitespace-collapsed text, and scopes itself to the
skills that actually start from the index — `/loro-slack` reads the annotation
sidecar, and forcing §5 on it would be cargo cult.

### 11. Where a meeting came from is one field, and it holds an id

The chain the acervo is built on — a hotspot seeds a meeting, a meeting seeds an
RFC — was **recorded nowhere**: 0 of 30 meetings in the reference acervo cited the
open point they came from, so "why was this decided" had no answer on disk. The
meeting manifest gains `origem`, holding `<contexto>#H-<n>` or
`D-YYYY-MM-DD-<slug>` — and **nothing else**. `normalize_origin` refuses a path, a
title, a sentence, an uppercased context, a bare `H-3` and a malformed date; a
refused write leaves the recorded value untouched, and an empty origin does not
serialize, so old manifests stay byte-identical.

This is what makes the genealogy compatible with the meeting being ephemeral: an
id is not PII, so the edge outlives the file it points at without reopening the
transcript path BR-8 closes. It is also why the field is not free text — a field
that accepts a sentence is a field that will eventually hold one.

### 12. A tab says where you are, and following a reference keeps where you were

Every document of the acervo is called `context.md`, `CHANGELOG.md` or
`meeting.md`, and the tab title was the basename — so three open themes were three
identical tabs reading "context.md". The strip stopped being a map, and an
untranslated file name became the only visible identity. The title now comes from
the **path**, which already carries the identity: `assinatura`,
`trato/hardware-lifecycle`, `assinatura · histórico`, `risco · 2026-08-04 12:12`.
No lookup, no IPC, still a pure reducer.

Two more defects of the same shape went with it. Following a reference opened in
the **preview** slot, and there is only one — so the second jump ate the first and
you lost where you came from; following a reference is navigating with intent, so
it gets its own tab. And the tree marked only `[data-doc]` rows, while a theme is
a `[data-ctx]` row: opening a theme lit nothing, and the sidebar had no relation
to what was on screen. `ctxOfDoc()` bridges them, and the owning theme lights up
even when what is open is its CHANGELOG.

Related, from the same round: selecting text opened the excerpt popover, and the
popover took focus — which **collapses the selection**. You lost the Ctrl+C and
the visual anchor of what you had just selected. Focus entering the menu exists
for keyboard access (without it the menu is untouchable), so the trigger decides:
from the mouse the selection stays and focus does not move; from the keyboard it
enters as before.

### 13. An index entry is a word somebody would look up

The índice remissivo shipped listing machine artefacts: decision slugs read
"adr001 evento entrada" and "as is vs falhas travas", hotspot titles are whole
sentences, and one anchor label was literally `../context.md`. That is a list of
identifiers, not an index.

Mining the contexts' prose for candidate terms was the obvious next idea and was
**rejected**: it invents vocabulary the authors never chose, which is the one
thing this acervo refuses to do. What ships is what the acervo already names —
the context's own name, the label a neighbour wrote when linking to it, and the
external codes it cites. The H1 is not a source either: the mould writes
"<caminho> — contexto do domínio", so using it produced "cadastro — contexto do
domínio" as an entry, which is the template talking.

Two rules make it read like a book index rather than a dump: accent and case fold
together, so "precificação" (the prose) and "precificacao" (the folder) are one
entry displayed the way the language writes it; and repeated sections of one
document collapse into one place — `cadastro §1, §3, §4`.

### 14. What Loro generates is named in English

The code, the comments and the docs of this project are in English; what it wrote
into an acervo was not. `contextos/`, `reunioes/`, `notas/`, `anexos/`,
`reuniao.md`, `indice.md`, `auditoria.jsonl` and `marcadores.jsonl` are now
`contexts/`, `meetings/`, `notes/`, `attachments/`, `meeting.md`, `index.md`,
`audit.jsonl` and `markers.jsonl`. **`context.md` did not change** — it was
already English, and it is the one document the domain owns.

`migrate_acervo` does the move, extending the ADR-0013 precedent that renamed
`pessoal/` → `brainstorming/`: rename (atomic, same volume), never clobber a
destination that exists, idempotent. It renames the nested folders too — a
meeting has its own `notes/`, a topic has all three — deepest first, so a parent
never moves out from under a child still queued. Reading still accepts the old
names, because the migration is user-triggered: an acervo nobody migrated yet has
to keep opening.

Four traps came out of the mechanical pass, and each is now a test or a comment:
a UI label is a **msgid**, not a path (`t("notas")` briefly became `t("notes")`,
which would print English inside Portuguese); a regex with an escaped slash
(`/^contextos\//`) does not match a naive replace; a name inside a regex
alternation does not either — and that one **kept** both spellings, since an
un-migrated acervo really does have `contextos/` paths for the agent to name; and
`mv` into an existing directory nests instead of replacing.

The `BrainStatus` fields that the sidebar reads are part of the same contract, so
they moved with it — and the field added by §8 exposed the class of bug that has
no owner: `BrainStatus` has no `rename_all`, so `entry_docs` shipped as
`entry_docs` while the reader asked for `entryDocs`. Both sides had a test; the
seam between them did not, so the entry documents never drew at all. Two tests
now pin the key — one serializes it, one reads it back out of the source the
screen uses.

### 15. A hotspot id carries its date, and the id is the address

`H-<n>` was numbered **local to its file**. The same `H-3` existed in almost every
one of 80 documents, so the id ADR-0004 made greppable was ambiguous the moment it
was quoted anywhere else — and it reached the reader inside the sentence, machine
syntax on the surface ADR-0018 defines as the product's output.

A hotspot now gets `H-YYYY-MM-DD-<slug>`: the **same shape as a decision**, the
date it was recorded (from the CHANGELOG that raised it — never invented) and a
slug from its own title. Qualified by its context it is unique across the acervo.
An id is never reused nor renumbered: it is an address, and an address that moves
breaks whoever cited it.

How it appears was decided twice. First the reader **consumed** it, like it
consumes the `[!HOTSPOT]` marker (N25) — clean prose, but then nobody could search
for an id or copy one to cite it. What ships shows it on **its own line below the
title**: the title is the sentence you read, the id is the address you copy, and
they are two different things. It is also the block's anchor, so a citation
`…/context.md#H-2026-08-13-…` scrolls to the point and marks it for a moment — a
mark that fades on its own, drawn with `outline` because `box-shadow` is reserved
for elevation in this stylesheet, and there is no elevation here.

The acervo migration renamed 312 markers and 319 in-file citations. Two surfaces
had to change with it: the §0 card listed the ids and now states a **count** ("7
pontos em aberto"), and `INDEX.md` carried the range `hotspots H-1..H-7`, which
means nothing once the id is not a number. A long id is for addressing, not for
listing.

### 16. A new acervo is born with all of it

Every rule in this ADR was applied by hand to one existing acervo during the work.
A rule that only lives in a migration is a rule the next project will not have —
so the guarantee is a test, not a promise: `a_fresh_acervo_is_born_with_every_
convention` creates an acervo through the real seeding path, in both languages,
and asserts the English folders (and that no Portuguese one is created), the
`INDEX.md`, and — inside the generated `AGENTS.md` — the relative-link rule, the
edge kinds, the facts-section step of the reading protocol, the dated hotspot id
and the meeting-origin field, plus the dated hotspot format in the `context.md`
mould itself. It fails the day a convention is taught to the migration and
forgotten in the generator.

### 17. A name in the acervo is personal data, and the check is a command

The loop is already told to describe participants by **archetype** (produto,
negócio, engenharia). A rule nobody checks erodes: the reference acervo carried
**31 people across 1.085 mentions** — full names, a corporate e-mail, a Jira
handle — in a knowledge base that is versioned, pushed and shared. That is
personal data in a place nobody consented to, it contradicts BR-8, and it is
exactly what LGPD asks to minimise.

The acervo was cleaned by replacing each person with the archetype the
surrounding text already gave them ("PM Vinícius Lira" → "produto"). A functional
mailbox (`sinistros@`) stayed: it is a role, not a person.

`brain_pii_scan` keeps it from coming back, and its contract is deliberately
modest: it reports **candidates** and never edits. "Pegar Agora" and a person's
name have the same shape, and only a person can tell them apart — a checker that
guesses wrong once is a checker that gets switched off. It also refuses the two
false positives that would have made it noise: a domain (`turbi.com`) and a file
name (`context.md`) look exactly like `nome.sobrenome`.

### 18. The índice remissivo keeps itself

Two triggers, and neither is a button. A **fresh acervo** is seeded with
`TERMS.md`, so a new project opens with both entry documents instead of one. An
**existing** one regenerates when the knowledge changes — the trigger is the same
mtime+size stamp the graph cache already keeps, never the screen being looked at:
a status poll runs every few seconds, and a file that rewrites itself on a read is
a file that fights the user's `git status`.

The write happens **only on a difference**. Rewriting identical bytes would leave
a dirty file in front of the user on every refresh, and a diff that says nothing
is how a generated file trains people to stop reading its diffs.

### 19. Clicking an index entry lands on the word, not on the file

The índice knows **which word** you were looking for. Opening the document at the
top handed that search back to the eye — the one thing the index existed to
spare. The entry now carries its term, and the click highlights the first
occurrence for **10 seconds** and scrolls to it.

The highlight walks the document's **text nodes** and wraps the range in a
`<mark>`. Rewriting `innerHTML` would have been three lines shorter and would have
destroyed the annotation layer (ADR-0007), every wired link and the scroll state —
the document on screen is not a string. The mark is removed and the parent
re-normalised when the time is up, so nothing of it survives in the DOM. Colour
is not the only cue (WCAG G183): the mark carries an outline too.

An anchor still wins when there is no term — a citation to a hotspot lands on the
hotspot, which is §15's job.

### 20. A legacy acervo is gated to the migration, not supported forever

§14 promised that reading would keep accepting the old names indefinitely, so an
acervo nobody migrated would go on working. **That promise was withdrawn**, and
the reason is evidence, not taste.

Three review rounds found three sets of leaks, all the same shape: the rename
created two spellings, and honouring both means auditing *every* path composition
in the codebase. Round one missed the versioning guard (a raw transcript could be
versioned — BR-8). Round two missed `list_meetings`, `queueable_files`, the stamp
path and the returned rel of the queueables. Twenty-one more compositions are
still hardcoded in `app.js`. Each round shipped a commit claiming the class was
closed; each round it was not.

The decisive one is the failure mode. `ensure_acervo_structure` created the
English folders unconditionally, and it runs from the wizard — which is also the
path for pointing at a folder that already exists. On a legacy acervo it created
empty new folders beside the populated old ones; since resolution prefers the
folder that exists, **the entire knowledge vanished from the screen**, and the
migration then reported "both coexist" forever. A half-migrated state is worse
than either end, and it fails silently.

So: `brain_status` reports `legacyLayout`, and the shell is not drawn. The screen
says what happened, says what the migration does *and what it does not do* — the
fear here is losing a file, so that answer comes before the button — and offers
the one action. The migration was already non-destructive, idempotent and
one-step; what was missing was the app admitting it needs to run.

`paths::acervo_dir` stays. It is no longer a promise of dual-mode operation: it is
what keeps the gate itself, and the migration that follows it, able to read a tree
they are about to rename.

## Explicitly NOT done

- **A node-and-edge picture.** It fails the DESIGN.md §9 checklist (it invents a
  second anatomy, it has no primary action, it does not survive a narrow content
  column) and, more decisively, it is the wrong form: the useful neighbourhood of
  a context is **3 to 6 nodes**, which is a list. The measured graph has 20
  lateral edges over 80 nodes — drawn whole it is a hairball nobody reads, and per
  document it is the "Citado por" list with worse ergonomics.
- **Mermaid (or any diagram source in `context.md`).** It re-imports drift *into*
  the source of truth: a diagram is a hand-maintained copy of the links written
  in prose, so the two can disagree while both look authoritative — the exact
  failure ADR-0004 avoided by refusing machine mirrors of `context.md`. It also
  turns every neighbourhood change into churn in a git diff the reviewer must
  read as code. The links themselves are already the graph; the reader computes
  it.
- **Embeddings / a vector index.** ADR-0004 §5 deferred them, and this
  measurement is what the deferral was waiting for: the gain sat in the **edge**
  and in **ranking over described text** (hit@1 0,17 → 0,50 from prose alone),
  not in similarity. A vector index would add a dependency and a derived store
  that must be rebuilt, while the one question no lexical strategy answers is a
  **vocabulary** gap that the índice remissivo solves with words already on disk.
  BR-1 also stands: no new dependency, no network, no vector store.
- **A typed catalogue (Backstage-style `catalog-info.yaml`, typed relations,
  ownership as data).** It needs a schema, a central service to validate and
  serve it, and a governance function to keep entries honest — three things this
  project does not have and one it does not want. Markdown stays the single
  source (ADR-0004 §5); ownership stays where review already happens
  (`.github/CODEOWNERS` + branch protection, ADR-0001 §5). The typed relation
  survives as **one word next to a link**, which any human can write and any
  agent can read.

## Consequences

- **New IPC (read-only, off the main thread), ARCHITECTURE §4:**
  `brain_knowledge_graph()`, `brain_backlinks(rel)`, `brain_index_terms()`, plus
  `brain_set_ticket_base(base)`. The graph's serialised shape is pinned by a test
  (`the_graph_serializes_the_agreed_ipc_shape`), so a frontend that needs another
  key breaks the test first.
- **Identity of a node:** `from`, `to`, `orphans[]` and `entries[].rel` are always
  the *document* rel (`contexts/<ctx>/context.md`); `context` is the
  hierarchical context path (`rac/agendamento`), which is the prefix that
  qualifies a hotspot. `brain_backlinks` expects the document rel.
- **New config field:** `Acervo.ticket_base` (per acervo, in `~/.loro/config.json`,
  empty by default).
- **Backend:** the knowledge-graph section of `acervo.rs` (one pass builds links,
  kinds, hotspots, decisions, codes and title — no file is read twice) with a
  global cache keyed by acervo + mtime + size of each `context.md`.
- **Frontend:** three surfaces — the "Citado por" panel under Referências, the
  índice remissivo at the `loro://indice` sentinel (opened by a secondary button
  in Conhecimento and by a ⌘K entry; ⌘F already searches it), and the
  orphan/broken-link map at the bottom of Conhecimento, repainted per pass and
  only while that destination is on screen.
- **Reading marks (DESIGN.md §3):** `a.xref--ctx` / `a.xref--file` / `a.xref--web`,
  `.loc`, and `ul.summary` for the §0 card.
- **Tests:** 12 in `acervo::graph_tests`, 20 in `desktop/tests/xref-surfaces.test.js`,
  the reader's marks and the locator across the 40 of `desktop/tests/text.test.js`,
  plus two template tests pinning the lateral-link teaching in both languages
  (`agents_teaches_lateral_links_with_a_kind`,
  `agents_requires_the_link_target_to_exist`).
- **i18n:** the three surfaces add msgids that need their English pairs like any
  other (DESIGN.md §4). One of them is a trap worth recording: the ⌘K entry's
  label reaches `t()` as `t(c.label)`, so the msgid sweep over `app.js` cannot
  see it — a missing pair there leaves the palette in pt with no test failing.
- **The manual gains the three surfaces and the address field** (pt and en), since
  all four are user-visible (CLAUDE.md §8.9).
- **`AGENTS.md` in an existing acervo is refreshed by the loop's own template**;
  acervos created by an older Loro degrade gracefully — no lateral links means an
  empty "Citado por", every context an orphan, and an índice built from hotspots,
  decisions and codes alone.
