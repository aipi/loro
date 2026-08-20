# Loro — design system

How the interface looks, behaves and decides. `ARCHITECTURE.md` says how the app
is built; the ADRs record *why* each decision was taken; this file is what you
read before drawing new UI, so the next screen looks like it belongs.

Values here are **taken from `desktop/src/style.css`**, not from a mockup. When
the two disagree, the code is right and this file is stale — fix it.

> Sources: ADR-0020 (anatomy, vocabulary, theme), ADR-0021 (chat, resizable
> panes), ADR-0022 (seven usability rounds + the review sweep), ADR-0024 (intake
> triage), ADR-0026 (the marks of a jump, and the three reading surfaces of a
> lateral link), ADR-0029 (the fifth sidebar section, the fourth panel tab, the
> second header pill, and a state that is a fact rather than a promise). This file consolidates their *visual* consequences; the
> reasoning stays in the ADRs.

## 1. Principles

These are not aspirations. Each one was written after a specific failure, and
the failure is named so the principle can be argued with.

**The interface must not know something it does not say.** The chat was working
while looking frozen; a meeting recorded with no clock; a meeting with no
analysis offered an arrow into an empty list. If the app knows, the app shows.

**State must never lie.** Pausing a recording stops capture *for real* — a pause
that kept recording would say "stopped" while recording. The tray parrot stops
blinking while paused for the same reason. A control that reports a state it
does not enforce is worse than no control.

**Offer the action, not the affordance for a thing that isn't there.** A
finished meeting with no analysis shows *✦ analisar*, not a disclosure arrow.

**Never show a control that does nothing.** Organizar had a per-item checkbox
nothing read, while the footer counted the whole queue and the action processed
the whole queue. A control that misrepresents what will happen to the user's
material is a defect, not decoration.

**The frame does not change with the mode.** View and edit are the same 700px
card; only the content changes. Edit mode used to go full-bleed — a different
room, not a different mode.

**The user owns the choices the code was making for them.** Where an AI action
runs (chat or terminal), what the chat may do without asking, which sidebar
sections are open, how wide each pane is, whether echo cancellation is on. Each
one is a real trade-off, and the copy states the price rather than hiding it.

**State the price in the copy.** *"cancelar o eco do alto-falante"* is followed
by "o custo é real: o macOS troca o caminho de áudio da máquina e a sua voz sai
mais baixa". A setting that hides its cost gets switched on and then blamed.

**One primary action per screen.** A single filled button. Everything else is
secondary, ghost, or a menu.

## 2. Anatomy

One layout, in every screen:

```
HEADER 54px — [logo + projeto ⌄] [nav pill · centralizado] ······ [Gravar] [✦ IA]
SIDEBAR 250/60px │ TABS (only when a document is open) │ PANEL 330px
                 │ CONTENT                             │ Documento·Chat·⟳ Loops·Terminal
                 │ RECORDING FOOTER (while recording)  │
```

Inviolable rules — encoded in `shell.js` and the `.bshell` grid, not just here:

1. The tab strip starts **to the right of** the sidebar; the sidebar reaches the header.
2. **There is no "Home" tab.** Início/Organizar/Conhecimento/Revisão are destinations of the header nav, never tabs. A destination cannot be dismissed — that is why the review half of the product is one (ADR-0027) and not the sheet it used to be, reachable from a toast that expires and a banner with an ×.
   **A tab is an open document OR a screen; it is never a destination.** This clause used to read "tabs are open documents only", and the code had already outgrown that wording before ADR-0031 — corrected here rather than left for the next reader to trip over. MEASURED (`grep -o 'loro://[a-z-]*' desktop/src/*.js | sort -u`): the strip carries **five** `loro://` sentinel rels that are not files — `loro://indice` (ADR-0026), `loro://manual`, `loro://loop-novo` (ADR-0029), `loro://nova-nota`, and `loro://ext/<id>` (ADR-0031 R5a, the fifth and newest). Add the model's own pinned `__home__` rel (`app.js:2280`, non-closable at `app.js:5005`, and filtered OUT of the strip at `app.js:4912`) and the workspace holds six non-file rels while painting five: "there is no Home tab" is a statement about what is **painted**, and it is still true. What makes a screen a legitimate tab is the rest of this rule: it opens by an act, it can be closed, it never replaces a destination, and — the reason a screen exists at all instead of a sixth nav pill — an extension's surface is per-extension and therefore countable, so it cannot be a fixed place in the chrome (rule 13).
3. The sidebar collapse control sits **at the bottom**, beside ⚙ Configurações.
4. **One primary action per screen.**
5. **No explanatory `ⓘ` tooltips**, no numbered labels in navigation.
6. **✦ IA** toggles the right panel; its active state is a 12% teal fill.
7. **Gravar comes before ✦ IA** in the header.
8. The nav pill is **centred on the window** (absolutely positioned): both side blocks change width with their content, so flex centring would let it drift. Below **1140px** it returns to normal flow, before it can collide — measured with four destinations: while the pill is absolute the right block has to fit in half the gutter, and at 1080px that is 330px against the 348px the right block asks for with the recording pill visible. Below **1015px** — the width where the header actually runs out, measured with the four destinations, **both** nav counters and a recording in progress — the header yields in rule 9's order: **prose** first (the project name truncates to 70px; its full text is in the button `title` and the switch menu), then **decoration** (the `v0.x.y` tag and the status dot go), then the **air** (the gap between blocks and the padding of the two right-hand controls). No control shrinks and no label is clipped; measured result, 844px in an 860px window. The one shrinkable item in the header is the project block (`flex: 0 1 auto; min-width: 0`) — it is prose, and it ellipsizes. The recording pill is `flex: none` because it is a control: it had `min-width: 0` and, since every other block is `flex: none`, it absorbed the whole deficit between 901px and 1015px — 35px of the 151px it needs, with the clock and the word «gravando» cut off, which is the one thing the header exists to say while you are on another screen.
9. The **recording footer is shared** by the loose recording and the meeting — one clock, one canvas. Meeting-specific controls (⏸ pausar, ■ Encerrar) sit **left of the clock**; the explanatory sentence truncates before any control shrinks, and **a control is never clipped**: the sentence truncates, the sentence goes, the wave gives up its width, and only then does the row wrap onto a second line. The seal that says whether audio is being kept was being cut off 38.6px past the column edge, which is the one claim the footer exists to make.
10. A window width may take a pane's **space**; it may never take the **pane**. Below
   1041px the ✦ IA panel yields *width* (never more than 45vw, whatever was persisted)
   and the sidebar gives up its share next (34% of the column, from 900px down) — the
   same three panes at every width, measured with the panel open: 690px of content
   column at 1280, 434px at 1024, 341px at the 860px floor `tauri.conf` allows. It used
   to be `display: none` below 1041px, and at 1024px — half-tiling on any Mac — the
   panel was simply gone while ✦ IA kept its 12% fill and `aria-expanded="true"`, the
   Home card focused a composer inside a `display:none` subtree, the drag grip was
   still painted at the window's edge for a panel that was not there, and the terminal
   (mounted inside the panel by default) had no way back. It does not become a drawer
   over the reader either: a pane that covers the document reads as a clipped document.
   Two consequences of the pane surviving, both measured and both fixed where the
   constraint actually is: what the panel takes is *column*, so anything laid out in
   grids inside it asks the column and never the window (§7 — the Home hero and the
   Conhecimento grid drew a card 43px outside the column at 950px while their window
   breakpoints sat at 900 and 1050); and the sidebar's 34% share at the 860px floor is
   178px against a 184px footer row, so **⚙ Configurações truncates and the collapse
   control beside it keeps its 36px** — rule 9 again, one pane down.

11. **One axis.** Every destination column centres on the same axis as the document
   card (`margin-inline: auto` on `.viewhead`, `.orglist`, `.knowgrid`, `.revlist`,
   `.revcard` and friends). Owner decision, 2026-08-18: the screen had no pattern —
   Início and an open document centred while Organizar, Conhecimento and Revisão hugged
   the left, leaving half of a wide window empty beside them. The WIDTHS still differ on
   purpose (700px for the card because it is reading, 720px for a list because it is a
   list); what is unified is the axis, and it is the axis the eye reads as a pattern.
   Measured, not asserted: `tools/smoke-ui.js` walks the three destinations and fails
   when a column's left and right gaps differ by more than 24px.
12. The sidebar's sections are **six** (ADR-0029, then ADR-0031): IDEIAS · PARA
   ORGANIZAR · CONHECIMENTO ─ LOOPS ─ EXTENSÕES · HABILIDADES DE IA, and a hairline
   (`.secsep`) before LOOPS and before EXTENSÕES is the whole separation — a loop can belong to the project, so it does not
   live inside an idea, and it is **not** a sixth destination in the nav pill. The
   panel's strip gained a fourth tab (⟳ Loops); it already scrolls inside its own
   container (§7), which is why the 300px floor is only a floor. The header gained
   a **second** pill (the teal loops mark), also `flex: none`, so the worst case the
   header is measured against is now *recording AND a cycle running*, in both
   languages — `tools/measure-header.js` carries those two cases, and 6×16
   measurements show no overlap and no sideways scroll down to the 860px floor.
13. **EXTENSÕES is the sixth section, and it is not a destination either** (ADR-0031
   R5a). An installed extension opens a SCREEN (`loro://ext/<id>`), the fifth
   sentinel tab beside the index, a loop, the manual and a new note — so it lives in
   the sidebar with its own `.secsep`, not in the nav pill. The placement was
   MEASURED before it was chosen, not deduced from the ADR: the app's only hairline
   sat before LOOPS, and `#toolsSection` is born `hidden`, so ADR-0031 §4(a)'s
   "after HABILIDADES DE IA" would have hung a line under a collapsed void.
   `tools/smoke-ui.js` step `sidebar-ext` fails when the new hairline's previous
   sibling has no height. The layout of the screen an extension draws comes from the
   closed `.extv*` alphabet (58 class names, `LoroExtView.CLASSES`): a third party's
   document asks for a ROLE (`tone: "amber"`, `size: "meta"`, `gap: 8`) and never
   for a measurement, and that is what keeps both themes working without the
   extension knowing themes exist. It is **not** the whole class list on the page,
   and saying "only" was wrong: MEASURED against the renderer, four names outside
   `CLASSES` are also emitted — `mono badge` for a badge, `btn` / `btn solid` for a
   button, and `<code class="mono">` inside a refusal. That is deliberate reuse
   (DESIGN §5 — the same thing must not have two appearances) and those four are
   Loro's own components, but an auditor reading this file has to know they are
   there. A `doc` node adds the reader's own prose classes (`.xref`, `.xref--file`,
   …) for the same reason: the prose is rendered by Loro's reader, not by the
   alphabet. Two roles the alphabet honours only because the sheet raises their
   specificity: `.extv .extv-text` / `.extv .extv-div` — inside `#brainDoc` (class
   `doc reader`) `.doc p` and `.doc hr` are class+type and beat a single class, so a
   declared `gap: 0` measured 9px and a declared 4px rule measured 16px until the
   selector had two names. Nothing an extension can write reaches `style`, the focus
   order, or a remote byte — the guarantee is the absence of the API, not a check
   inside it. What the alphabet has NO primitive for is named in ADR-0031 §14: an
   image or any geometry, so a map, a chart or a QR code cannot be drawn by a third
   party without changing Loro.

### Fixed measurements

| Element | Value | Token |
|---|---|---|
| Header height | 54px | — |
| Sidebar | 250px / 60px collapsed (drag floor 180px, ceiling 45vw) | `--side-w-default` |
| Right panel | 330px (drag floor 300px, ceiling 60vw) | `--panel-w` |
| Document card | max-width **700px**, centred — view **and** edit | — |
| Destination list column (`.orglist`, `.revlist`, `.viewhead`) | max-width **720px**, centred (`margin-inline: auto`) | — |
| Terminal dock | 34vh default, floor 120px, ceiling 75vh | — |

The panel's floor used to be justified as "the width where its three tabs still
fit". It was not: at that width the third tab pushed `<body>` sideways. The strip
now scrolls inside its own container (§7), so the floor is only a floor — 300px,
enforced in `app.js` (`PANEL_MIN`).

**Every number in that table is pinned by `tokens.test.js`** — against the tokens,
the `.bshell` grid and the drag clamps in `app.js`, in both directions. The claim
that they were pinned was made here before anything pinned them, and by then three
of the numbers had gone stale.

Every floor and ceiling in it holds **on apply**, not only while dragging: the sizes
are persisted, so a panel dragged to 60vw of a 2560px display came back as 1536px on
a 1512px laptop — 29px past the window edge, the sidebar and the document at 0px, the
send button clipped and `<body>` scrolling sideways — and a dock dragged to 75vh of a
1440px display came back 309px below the window, prompt line included. The drag clamp
decides the number; the sheet decides that no stored number can outgrow the window it
is applied in (`min(var(--panel-w), 60vw)`, the sidebar column `min(var(--side-w), 45%)`
of the column it lives in, `clamp(120px, var(--term-h), 75vh)`).

Every side pane drags to resize (shared `wireGrip()`), double-click resets, and
the width is persisted. While dragging, `body.resizing` disables pointer events
inside the main row — without it the xterm and wave canvases swallow the pointer.

## 3. Tokens

Set on `:root`, overridden on `:root[data-theme="dark"]`. The theme preference is
`light | dark | system`; "system" is resolved in JS and stamped as `data-theme` on
`<html>` — **never read `prefers-color-scheme` directly in a component**, or it
will ignore the user's choice (the editor did exactly that).

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#fbfaf6` | `#211e19` | app background |
| `--panel` | `#ffffff` | `#2a2620` | cards, menus, inputs |
| `--side` | white 55% over paper | `#26231d` | sidebar |
| `--ink` | `#201d18` | `#f0ede5` | primary text |
| `--ink2` / `--ink3` | `#3d3a34` / `#6f6b62` | `#d8d3c8` / `#a29d92` | secondary text |
| `--muted` / `--ghost` | `#757169` / `#c9c5bc` | `#9a938a` / `#5c574d` | captions / disabled |
| `--line-strong` / `--line` / `--line-soft` | `#e2ded5` / `#e9e6de` / `#efece5` | `#3a362e` / `#35312a` / `#35312a` | hairlines and separators, by weight |
| `--line-dash` | `#d5d2ca` | `#4a453b` | dashed "add here" outlines |
| `--line-control` | `#8f8880` | `#847d73` | the boundary of a control |
| `--teal` | `#0b736e` | `#2fc7bf` | AI, knowledge, primary action |
| `--green` | `#1a7f37` | `#4fc463` | untracked file in the tree |
| `--yellow` / `--yellow-ink` | `#dd9c00` / `#8a6207` | `#e6b13a` / `#f0c05a` | pending, "para organizar", system audio |
| `--red` | `#c92a2f` | `#ee6469` | recording, destructive, blocking |
| `--danger` | `#b04a4e` | `#e08488` | destructive text on surfaces |
| `--on-teal` / `--on-solid` / `--on-red` | `#ffffff` / `#211e19` / `#ffffff` | `#211e19` / `#211e19` / `#211e19` | ink on a filled control |

`--live` is `--red` under a name that says what it means. The terminal keeps one
fixed palette in **both** themes (`--term-bg #26231d`, `--term-fg`, `--term-dim`,
`--term-ok`, `--term-danger`, `--term-cur`): a shell that changed colour with the
app theme would misread its own output.

The dark palette is **warm** (`#211e19`, not `#111`) — it is the same paper,
after dark.

**Every value above is measured, not chosen.** Text tokens clear 4.5:1 on paper,
panel and sidebar in both themes; a filled control carries the ink its own
lightness allows, which is why `--on-teal` and `--on-red` are white in light and
the dark paper in dark, while `--on-solid` is the dark paper in both (the amber
fill is light in both themes): white on `--teal` 5.69:1 · dark paper on the dark
`--teal` 7.94:1 · dark paper on `--yellow` 6.98:1 / 8.47:1 · white on `--red`
5.45:1 / dark paper on the dark `--red` 5.27:1. `tokens.test.js` resolves every
token for both themes and re-measures all of it, this table included — if you
change a value here without changing the code, the suite says so.

`--line`, `--line-soft` and `--line-strong` are **hairlines**: they separate two
surfaces at ~1.2:1 and are not allowed to be the only thing that identifies a
control. A control whose box *is* its affordance — text field, select, the
field-shaped folder pickers, the chat composer, the editor host, the find bar, the
labelled row actions (`.mini.act`), the draft chip (`.pbranch`) and **every
secondary `.btn`** — draws its border with `--line-control`, which clears 3:1 on
paper, panel and sidebar in both themes (WCAG 2.1 AA 1.4.11). `.btn` was the last
one left behind: its fill is the same as the card it sits on (1.00:1 measured), so
the border was the whole box, and with `--line` it measured 1.16:1 in dark and
1.25:1 in light — the pill of «↗ Enviar para revisão do time», «pedir mudanças» and
the empty state's «abrir Configurações» was not perceivable. A disabled `.btn` keeps
that same box: unavailable is not invisible.

**Focus is part of the palette.** `:focus-visible` is a 1.5px `--accent` outline
2px outside the control, so it contrasts with the surface *behind* the control,
not with the control. Two surfaces are inverted and get the ring of their own
palette: inside the terminal it is `--term-ok` (7.49:1 on `--term-bg`, where the
accent gave 2.76:1 in light) and on the toast, which is painted with `--ink`, it
is `--paper` (16.1:1 / 14.2:1, where the accent gave 1.79:1 in dark).

A box with more than one focusable child takes the ring on `:focus-within`, on the
box: the field row (`.wfield`), the find bar and the chat composer. All three had
switched the global ring off on the input and painted nothing in its place, so the
caret was the only cue and the controls beside it (the find counter and ×, the send
button) had none at all. **The ring follows the box, not the screen the box appears
on:** scoped to `.sheet`, the same rule left the two text fields of the Revisão
destination — which live in a `.revcard` — as the only Tab stops of that screen with
no focus indicator, in both themes, and both refusal paths send the keyboard straight
to them. The one place where the field draws its own box (the first-run card) turns
the row's ring off, because two concentric rings are two claims about one focus. The guard for this reads **every** `outline` declaration in
the sheet, including `!important`: it used to be an allowlist of nine selectors, so
switching the ring off on the record button, the destination tabs and the wizard's
colour swatches broke nothing.

A **state** is held to the same 3:1 as a boundary (WCAG 1.4.11): the selected ⌘K row
is a 3px bar in the accent (4.66:1 light / 5.54:1 dark against the row it marks, for
every one of the six project accents) over the 14% tint. The tint alone measured
1.12:1 against the rows around it, and Enter ran a command nobody could see selected.

**Semantics, not decoration:** teal = AI and knowledge · amber = pending, needs
you, other people's audio · red = recording and irreversible.

### Layers

One ladder, and it is an **order** rather than five numbers living in five rules:

| Layer | `z-index` |
|---|---|
| content, the tree, the panel | — |
| notice bar / toast | `30` |
| **Configurações** (`.cfgpage`) | `45` |
| **a sheet** (`.sheet-wrap`) | `50` |
| a floating menu (`.floatmenu`) | `60` |
| the command palette (`.cmdk`) | `80` |
| a tooltip (`.tipbox`) | `95` |

Two of those relations are load-bearing and were paid for. **A sheet sits above
Configurações** because Configurações is what opened it: at `40` against the page's `45`,
«instalar plugin…» opened a sheet BEHIND the settings page — `hidden` was false, its height
was fine, and `elementFromPoint` at the centre of the sheet returned `.cfgcard`. Its buttons
were unreachable and the gesture read as «I click and nothing happens» (measured in the DOM,
2026-08-18). **A menu sits above a sheet**, because a menu opened from inside a sheet has to
cover it. The order is pinned by `tokens.test.js`, and the *paint order* — being open is not
being visible — is measured on the real DOM in `tools/smoke-ui.js`.

### Type

Two families: `--sans` (`-apple-system, Inter, system-ui`) for content and UI,
`--mono` (`ui-monospace, SF Mono, Menlo`) for anything the machine owns — paths,
timecodes, counters, badges, terminal.

**The machine's half goes in its own element.** `class="hint mono"` (or `pmnote
mono`) does *not* paint mono: the two classes have equal specificity, `.hint` and
`.pmnote` come later in the sheet and use the `font:` shorthand, which resets the
family — so what survived was the wrong half of the rule, prose in `--sans` with
mono's letter-spacing and the path in the sentence set in `--sans` too. A sentence
that mixes prose and a machine value is written as prose with a `<span class="mono">`
around the value. Guarded structurally: for every class combination in the markup
that asks for `mono`, the winning single-class rule has to be the mono one
(`tokens.test.js`).

**A field is the same trap with a different shape.** `.loopfield input` (class +
type) beats `.mono` (one class) and its `font:` shorthand resets the family, so the
loop's `class="mono"` value fields — the minutes, the time, the date — painted in
`--sans` while the unit beside them (`min`, `às`) painted in `--mono`: three
typographies in the rhythm row, and the machine's value set as prose. A field whose
markup asks for mono names the family itself (`.loopfield input.mono`). Fixed-width
digits are also the right answer for a number field: the value does not shift as it
is typed.

The scale in actual use, most frequent first:

| Role | Style |
|---|---|
| Metadata, badges, paths | `11px var(--mono)` |
| Button, **field label**, panel tab (`.ptab`) | `600 12.5px var(--sans)` |
| Open-document tab (`.wstab`) | `600 12px var(--sans)` |
| Section label — sidebar groups, panel heads | `600 11px var(--mono)`, uppercase, `.09em` tracking |
| Body of a control, list row | `600 13px var(--sans)` |
| Helper sentence, note, footnote | `11.5px/1.5 var(--sans)` |
| Micro-label, counter | `10.5px var(--mono)` |
| Card title, **sheet title** | `600 14px` → `650 19px` for a section heading |
| Code block in a document | `.85em` of the reader → **12.3px** `var(--mono)` |
| **Diff row** (`.rvrow`, ADR-0027) | **12.3px/1.7** `var(--mono)` — the code step, because a diff row *is* a code line; the gutter and the gap notice take the micro-label step (`10.5px var(--mono)`) |

**The document's heading ladder** (`.doc.reader`, the product's primary output —
ADR-0018) is declared whole, not inherited: prose is `14.5px/1.7` at `--ink2`, and
above it h1 `650 23px` · h2 `650 18px` · h3 `650 15.5px` · h4 `600 14.5px`, all
`--ink`, then h5/h6 `600 13px` at `--ink3`. Two rules hold it: **it only descends**,
in size and in weight, and **h4 is never smaller than the prose it introduces**.
Only h1 and h2 used to be declared; h3 and h4 fell through to `em` inheritance and
the UA's bold, which made h3 *smaller and heavier* than its own parent and left it
0.725px from an inline `<strong>` — a section that reads as another bolded
sentence. A heading is told apart by size AND ink, never by weight alone: an
inline bold phrase is `700` at `--ink2`, so a heading is `--ink`.

**A code block is a box on both reading surfaces.** `.doc pre` and `.chatans pre`
carry `color-mix(in srgb, var(--ink) 4%, transparent)`, a `--line-control` (3:1)
edge and `var(--mono)` on the `pre` itself, and scroll inside themselves (§7). A
scroll container with the card's own fill and a 1.2:1 hairline is one the reader
cannot find, so a clipped line reads as damaged content rather than as content
that scrolls — and declaring the family only on the child `<code>` leaves the
`pre` on the UA's generic monospace, off the type system.

**A table in a document keeps the words the author wrote.** `.doc th` was
`10.5px var(--mono)`, uppercased, at `--muted`: the style sheet rewrote authored
text into the machine's font, at the step this scale reserves for a micro-label,
with the casing destroyed. A table header is prose — it is told apart by weight
and ink (`650` at `--ink`) on the cell's own step, and nothing else.

**Three destinations, three marks** (ADR-0026). A link in a document can land in
three different places, and the reader used to find out only after clicking: all
three were drawn alike. The mark is the **type**, never an icon with a legend —
the permanent underline (§5) is identical on all of them, and no authored word is
rewritten by the sheet.

| Mark | Destination | Style | Why |
|---|---|---|---|
| `a.xref--ctx` | another knowledge topic (`context.md`, `AGENTS.md`, `INDEX.md`, `CLAUDE.md`) | the prose of the line | a topic is a **name**, and a name is prose |
| `a.xref--file` | any other file in the project | `var(--mono)` at `.92em` | a material is a **path** — the machine's half of the line |
| `a.xref--web` | outside the project (`http(s):`) | trailing `↗` | leaving the app is a state change, so it is stated before the click |

**A locator is a value, so it is mono with or without a link.** An id the
knowledge cites (`MM-1147`) is marked `.loc` in `var(--mono)` at `.9em`. It only
becomes an `<a>` when the project carries a base URL (Configurações → Projeto);
with none it is a `<span>` at `--ink3` — it does not pretend to be clickable, and
the app never guesses where someone else's ids live. The prefix is two to five
capitals on purpose: the acervo's own ids (`H-3`, `D-2026-07-23-slug`) open with
a single letter and must never be dressed as a ticket.

**The §0 card is a box, not a font.** The summary card is the surface every
retrieval path lands on first, and it is a list of definitions rather than body
prose. It gets the **same container as a code block** — 4% ink fill, a
`--line-control` (3:1) edge, `8px` radius — with each row's label lifted to
`--ink`. Deliberately *not* a font change: the rule two paragraphs up — a table
in a document keeps the words the author wrote — holds here too. The card is
authored prose; the sheet may contain it, and may not restyle it into the
machine's typeface, uppercase it, or rewrite its casing.

**The manual's modal is a reading surface too.** When there is no project yet the
manual opens as a sheet (`.manualmodal`), and that block declares `pre` and
`table` with the same decisions as `.doc` — `var(--mono)`, the 4% tint, the
`--line-control` edge, and `overflow-x: auto` — because a block with no rule of
its own falls to the UA's generic monospace and pushes the whole sheet sideways
instead of scrolling inside itself (§7).

A section label is the machine naming a bin (IDEIAS · PARA ORGANIZAR ·
CONHECIMENTO · COM ESTE DOCUMENTO), which is why it is mono and the tabs beside
it are not. The document's own view/edit switch (`.tab`) is the one tab still set
in `11px var(--mono)`.

Reading text (documents) uses the 700px card with normal weight; every UI label
above 12px is 600. **Mono is never used for prose** — and a field label
("nome do projeto"), a helper sentence and a **sheet title** ("Novo rascunho —
descreva a mudança em uma linha") are prose, not values: the first-run wizard, the
whole of Configurações and every modal heading were monospace because the markup
carries a `.mono` class, so the rule that paints prose declares `--sans` itself
instead of inheriting — and a sentence is not shouted either, so the title lost its
uppercase with the mono. `tokens.test.js` checks that. A path, a timecode, a counter
or a badge inside a sentence stays mono — that is the machine's half of the line.

Two `em` steps on the same text **multiply**: a code block was `.85em` of the reader
inside a `code` rule that asked for another `.85em`, which rendered the code at
10.4762px — under the 11px this scale reserves for metadata and at the 10.5px it
reserves for a micro-label, on a surface whose whole job is to be read.

### Radius, elevation, spacing

| Radius | Where |
|---|---|
| `999px` | pills — nav, badges, record button, chips (most common by far) |
| `50%` | circles — the record button, the send button, status dots |
| `16px` | the two largest surfaces: the document card and the Home hero card |
| `14px` | modal sheets, the ⌘K box, `.cfgcard`, `.wizcard` |
| `12px` | cards, banners, chat bubbles, the composer |
| `10px` / `9px` / `8px` | inputs, editor host, rail sections, menu items |
| `7px` / `6px` | tree rows, glyph buttons |
| `5px` / `4px` | the ⌘K chip (`.kbd`), the ＋ of a sidebar section, the download bar |
| `3px` / `2px` | the record button's "stop" glyph, an inline `mark` in a document |

The dense chrome keeps the small steps: below 6px a corner stops reading as a
corner and starts reading as a rounded square, which is exactly what the stop
glyph and a highlighted word want. Image assets carry the one-off radii that match
their artwork (11 / 13 / 15px); nothing else invents a radius.

Shadows are tokens, not ad-hoc: `--sh-card` (rest), `--sh-card2` (raised card),
`--sh-menu` (floating menu), `--sh-modal` (modal). Dark theme raises opacity
rather than changing spread — depth reads differently on dark paper.

Spacing is a **2px rhythm**: 2 · 4 · 6 · 8 · 10 · 12 · 14 carry the great
majority of every padding, gap and margin in the sheet, and the dense chrome
(tree rows, pills, mono chips) uses the odd single-pixel steps in between. It is
not a 4px grid — claiming one only made the document wrong. Content padding is
`clamp(16px, 3vw, 28px)` so a narrow column keeps its margins.

## 4. Vocabulary

Internal terms survive in code, IPC and on disk. They stop being a prerequisite
for **using** the app.

| Internal | UI |
|---|---|
| acervo | **projeto** |
| brainstorming | **ideias** |
| fila → contexto | **para organizar** |
| contextos | **conhecimento** |
| habilidades | **habilidades de IA** |
| versionar (commit) | **salvar versão** |
| propor mudança (RFC/PR) | **enviar para revisão do time** |
| promover | **juntar a um conhecimento** |
| branch `rfc/…` | **rascunho de trabalho** |
| branch padrão (main) | **conhecimento oficial** |
| remote (origin) | **repositório do time** |
| plugin (pacote de extensão) | **plugin** |
| loop (trabalho recorrente da IA) | **loop** |
| ciclo de um loop | **ciclo** |
| freios de um loop | **freios** (nunca "limites" ou "metas") |

Those two names are **one function**, not a habit: `placeName(branch, def)` returns
«conhecimento oficial» or «rascunho «<slug>»», and it names the rows of the drafts
sheet (visible label *and* accessible name), both sides of the switch price **and the
toast that reports the switch**. The sheet whose whole job is *choosing the place* was
the last screen still calling the places `main (principal)` and
`rfc/onboarding-atualizado-co` — one click away from the composer chip saying «no
conhecimento oficial». One fact, one name, whatever the distance between the two
surfaces.

That rule has a corollary the toast taught: **no user-facing string is built from a
git ref**. A ref reaches the screen only through `placeName` / `draftChipLabel`, and
the caller passes the default branch it just read, because "is this the official
knowledge?" is a question only `def` answers. A surface that says «⎇ rfc/toast-tres»
or «⎇ main» is the git vocabulary leaking through the screen that exists to hide it —
and the *same* surface must also be repainted when the place changes, or the frame
holds two answers to «where am I» at once.

The last three were never product words at all, and they lived where they do the
most damage: the **error dictionary**. `err.on_main_branch` said "você está na
branch principal: clique em Versionar primeiro" — a mechanism the screen never
shows plus a control that does not exist (the button reads "Salvar versão do
projeto"). The vocabulary sweep reads `ERR_PT` and its English pairs too, and it
also refuses any error that tells the user to click a label the HTML does not
carry: a message the user cannot act on is not an error message.

Copy describes what the screen does *for you*, not what it is called. Not
"Organizar: itens na fila", but "Escolha o que vale virar conhecimento. A IA lê,
resume e propõe onde cada coisa entra — nada fica oficial sem a sua aprovação."

pt-BR is the source language: **the Portuguese string in code IS the msgid**, and
every one needs an English pair. Two tests enforce it — one over `app.js`, one
over `index.html` (half the msgids live there and went untested for a while).

## 5. Components

**Buttons.** `.btn` (secondary), `.btn.solid` (the one primary per screen),
`.link` (inline), `.glyph` (icon-only). The record button `.recbtn` is a red pill
that becomes ink-coloured while recording; its compact form `.recbtn.sm` is used
by "■ Encerrar reunião" — the same action must not have two appearances.

**Pills and badges.** Mono, `999px`, semantic colour. Meeting sources are
coloured in read mode exactly as they are live: teal for você, amber for sistema.
The family belongs to the **component**, not to whoever writes the markup: `.badge`
declared none, every old site wrote `class="mono badge"` by hand, and the seven
badges the Revisão destination added read as 10px sans (measured) until the rule
gained `font-family: var(--mono)`. And a **state's ink is a state token, never
`var(--accent)`**: `.badge.ok` painted with the project colour, so with the amber
project «novo» and «modificado» measured 1.02:1 apart — two git states with one
appearance in one list. `--green` / `--yellow-ink` / `--red` carry new / changed /
removed, matching the fill the diff row uses for the same fact.

**A disabled control.** One state, one appearance: a disabled primary is a disabled
button — the same fill, border and `--ink3` text as `.btn:disabled` (4.9:1). The
filled variant kept its accent fill with `--muted` on top and measured 3.72:1
(dark) / 3.97:1 (light), and that is what the screen looks like whenever there is
nothing to save.

**Cards.** `12px` radius, `--panel`, `--sh-card2`, `--line` border. The two
largest surfaces — the document card and the Home hero — go up to `16px` with a
`--line-strong` border, because a bigger surface needs a bigger corner to read as
one. The document card is 700px and centred in both modes.

**Fields.** A text field, a select or a field-shaped trigger is `--paper` inside
`--panel` with a `--line-control` border: the fill alone is a 1.04:1 difference,
so the border is the affordance and it has to clear 3:1. Its label is prose
(`600 12.5px var(--sans)`), its helper sentence is prose, and only the value it
holds may be mono. The **writing surface** is the same kind of box, and it is one
box: the markdown bar closes its top edge and the editor host closes the rest, in
the same `--line-control`, **in edit mode as much as in view mode** — the mode you
actually type in had the weaker border.

**Links inside a document** carry a permanent underline. The accent against the
prose around it is 2.95:1 in light and 1.79:1 in dark, well under the 3:1 that
allows colour to be the only cue, so the underline is not decoration and not a
hover reveal — hover and focus only thicken it (WCAG 1.4.1, 2.4.7).

**"Citado por" is the same box as Referências, pointing the other way**
(ADR-0026). Referências looks *into* the document (the material it carries); the
second `<details class="refspanel backpanel">` below it lists who cites this
document. Same anatomy, opposite direction — a new shape would have implied a new
kind of thing. Three rules it does not share with its neighbour: each row is a
`<button class="refitem">` (the neighbour's href-less `<a>` is out of the tab
order and carries no link role — WCAG 2.1.1 / 4.1.2); the row reads the **type of
the edge inverted for the page it is on** (`upstream` → *recebe deste*,
`downstream` → *entrega para este*), because printing it raw would say the
opposite of what the other document wrote, and an undeclared type gets **no badge
at all**; and with nobody citing, nothing is drawn. The markup is built in the
**same paint** as the document — a panel inserted afterwards shoves the text down
just as the reader starts reading.

**A computed screen is a reading tab, not a file.** The índice remissivo lives at
the sentinel `loro://indice`, the pattern the manual (`loro://manual`) already
used: same 700px card, same tab strip, no destination invented for it. Because it
is a calculation and not a document it has **no modes** (nothing to edit), no ⇢
move/delete, no version seal, and the right panel returns to "nenhum documento em
foco" instead of promising a document's affordances to a screen. Its header seal
and tab name say it is computed. The entry is `<dl class="idx">`: the term in
prose on the left (it is the word a person wrote), its locators in mono on the
right (they are addresses), a `--line-soft` rule between entries — a separator,
not the boundary of a control. Alphabetical by the UI locale, like the back of a
book.

**A number with no action is a statistic; a defect with a door is a control.**
The Conhecimento map (`#knowMap`) lists topics nobody cites and links whose target
does not exist. Each row names the **topic** (never the path) and carries exactly
one action — *abrir* — which opens the document where the fix belongs: the orphan
itself, or, for a broken link, the document *that cites*. The broken target is
printed exactly as its author typed it, in mono, because that is the string to
correct. A section with no defect is not drawn, and the block itself is hidden
while the project has no knowledge at all. This is the bar ADR-0020 §4 set when
it removed the home statistics, met from the other side.

**Empty states** carry an icon, a bold line and one explanatory sentence — never
three sections each explaining their own emptiness.

**A hotspot is a callout, not a string.** A knowledge document records its open
points as `> [!HOTSPOT] <title>` (the template writes the marker so the agent can
find the point again). The reader consumes the marker and renders the block as
`blockquote.hotspot` with its first line as the title: machine syntax must not
reach the surface ADR-0018 defines as the product's output.

**A control the screen removes is removed from every route to it.** The panel
hides a section by hiding its `.psec`, and the button's own `hidden` stays false —
so the ⌘K entry and the global shortcut kept firing controls the screen had taken
away. A palette gate reads visibility through the ancestors (`controlOnScreen`),
never the control's own flag alone.

**Progress and work.** A running chat shows a "pensando…" indicator and one
`<details>` step per tool, closed by default, opening to request and response
(capped at 2000 chars — a conversation is not a file viewer). A failed step opens
itself.

**A bubble contains what it is given.** `max-width: 90%` bounds the box and says
nothing about what is inside it: a pasted URL was drawn 351px outside the panel and
outside the window, and recovering it scrolled the whole conversation sideways. A
message breaks an unbreakable token; an answer's code block scrolls inside itself, in
`--mono` like every other machine text (it was rendering in the UA's generic
monospace, the one reading surface off the type system).

**Pending state.** Any action that spawns a process paints a pending state on
click (`iniciando…` / `encerrando…`, disabled, pulsing) and is cleared by the
backend event that defines the truth — never by a timer. **A confirmation sheet
is one of them:** its primary action goes disabled and reads `um momento…`
(`aria-busy`) while the handler runs, and the sheet closes only when the work has
an outcome. It used to close *before* awaiting, so "salvar versão" ran a `git
fetch` of up to ~10s behind a screen that said nothing at all. The one exception
is a dispatch that hands the work to another surface — the chat, or the terminal
the dispatch itself opens *behind* the sheet: that surface carries the feedback,
so the sheet steps out of the way immediately (`dispatchAiFromSheet`).

**Refusals go to a toast, not into content.** A refusal written into the answer
bubble repeats on every click and reads as the agent failing.

**A sheet that fails stays open, with the reason inside it.** Closing on failure
threw away what the person had just typed — seven fields of the send-for-review
sheet — and the only notice of the error left with the toast that carried it, so the
screen ended up exactly as before the attempt with no record of it. Failure keeps the
sheet, re-arms its primary action, and writes the message into a `role="alert"` slot
(`#pmErr`) that carries `abrir Configurações` when the app knows the remedy is the
environment. Configurações opens *over* the sheet: fix it, come back, the fields are
as they were. Success is the only outcome that closes a sheet.

**A row that opens something is a button, and its siblings are siblings.** A card
with `role="button"` + `tabindex` around a real `<button>` is two defects: ARIA makes
a button's children presentational (so the inner control's exposure is undefined),
and the row's `aria-label` *replaces* everything inside it — the state chip, who
asked, which draft, when. The team review row is a plain card holding a real
`<button>` with the title, whose accessible name carries the number, the title, the
state and the meta line, with `⧉ copiar link` beside it, not inside it.

**A control that repaints its own list gets its focus back.** `marcar como visto`,
`ver a mudança completa` and the diff-mode switch rebuild the list they live in, so
the element that carried the outcome stops existing: focus fell to `<body>` and the
next Tab restarted at the top of the card. The repaint re-queries the equivalent
control by its own data attribute and focuses it, and announces the outcome when the
outcome is a number on screen (`%1 de %2 vistos`) — the same save/restore
`enterOverlay`/`leaveOverlay` do for a layer. A view switch inside a destination
(opening a review, coming back) does the same: forward to the control that closes the
view, back to the row that was opened. **And a repaint the user did not ask for keeps
the place too:** the 10 s poll rebuilds the same list when the working tree changes
under it (an analysis writing a document, a git operation), so the list remembers the
*address* of the focused control before the swap and gives it back afterwards — only
when the swap left it orphaned, because a focus that already has an owner is never
moved (WCAG 2.4.3). A sheet that **replaces** another one is the same rule at the
layer level: the overlay stack is already entered, so the new body has to be given the
keyboard and the new dialog name has to be announced, or the keyboard is left on
`<body>` in front of a dialog nothing named (4.1.2).

**One live region, and it speaks for what is on screen.** The app has a single
`#srLive` and a single function that writes in it. Two halves painted in the same pass
(the destination's two tabs) both wrote there, so the one that finished last won and
the arrival announced the *hidden* half — «nada aqui ainda» about a list the user
cannot see. A status message is only a status message for the pane that is showing:
the painter asks which tab is up before it speaks, and the half that just appeared
repaints so it can speak at all.

**An open item is a heading.** A view that opens *one* thing inside a destination
gives that thing a heading of its own (`h2` under the destination's `h1`) and pushes
its own sections down a level. Rendered as a `<span>`, the item's identity is missing
from the outline, and heading navigation reads three section titles that belong to
nothing (1.3.1 / 2.4.6).

**The review card** (`.revcard`, ADR-0027) is the ordinary `12px` card, and it is
a `<details>` with a `.revsum` disclosure row — not a div with an onclick, so the
keyboard and `aria-expanded` come for free and the destination does not invent a
second way to open a section. Three layers, each earning its place:

| Layer | What it is | Rule |
|---|---|---|
| `.revsum` | status badge · document name · path in `11px var(--mono)` · `+N −N` | the badge word is the **same word** the sidebar dot uses for the same git status — one state never has two names |
| `.rvbit` | `como era` / `como fica`, the change in the writer's own words | body ink (`--ink2`) on a `--red 7%` / `--green 8%` fill; the micro-label above it is `--ink3`. Capped at 12 lines with the rest **counted**, because a new document is one passage containing a whole file |
| `.rvdiff` | the exact lines, behind `ver a mudança completa` | the code-block container of §3 — 4% ink fill, `--line-control` (3:1) edge, `var(--mono)` on the box. The row **wraps**; knowledge is prose, so nothing scrolls sideways (§7) |

Green and red live in the **fill**, never in the ink: as text on their own tint
they measure between the 3:1 and 4.5:1 floors. The `+`/`−` glyph and the row's
position carry the meaning, which is what WCAG 1.4.1 wants anyway.

**The gap and the cut are two different rows.** The gap between two hunks is a
**notice**, not a control — the payload carries three lines of context and nothing
more, so an "expand" there would open nothing. The **cut** at 400 rows is the
app's own ceiling (§7: nothing grows without bound inside a card), and the rows
past it are already in memory: it carries `mostrar mais linhas`, which raises the
ceiling one step per click and disappears when the reading is complete. A counted
remainder with no way on is a dead end in the one destination that exists to show
the exact lines.

**What blocks a change is named.** A review whose checks failed lists them under
`Verificações que falharam` — one `.revrow` per check, the name the CI gave it,
and `ver a verificação ↗` where the payload carries a URL. The chip in the header
still folds them into one word (`✗ verificações falharam`); the group's heading
carries the state, so the rows do not repeat a badge N times.

**Two halves of one subject are a segmented control, not a second tab strip.**
`Mudanças de agora` / `Revisões do time` are `.segbtn`, because §3 fixes the
document's view/edit switch as *the* one tab set in mono; a second mono tab strip
would contradict a written rule. Each half carries the same `.destbadge` the nav
pill does, fed by the same painter, so the nav count and the tab count can never
disagree.

**A loop is a screen, and its state is a fact — never a promise** (ADR-0029).
The loop's document opens in the same 700px `.doccard` as everything else, with
the same `visualizar`/`editar` switch: view shows the rhythm, the timeline, the
effective instruction and the cycles; edit shows the definition's fields (the
definition is structured, so edit is a form, not CM6). Three rules hold it:

| Rule | Why |
|---|---|
| Seven states, three marks: **teal** = the AI is or will be working · **amber** = it needs you (`impedido`, `falhando`) · `--ink3`/outline = it does nothing (`desligado`, `expirou`) | No new token, and **red stays recording-and-irreversible**: a cycle running is not a recording. The mark does not blink either — blinking is the tray parrot's, and it means capture |
| A loop that **cannot** run never shows a next run | «ligado» and «capaz de rodar» are different facts. The screen says `impedido` and names the reason instead of promising a time it will not keep |
| A quiet cycle is `muted`, not amber, and consecutive quiet cycles are ONE row with a count | A cycle with nothing to say is a legitimate outcome. Painting it as a failure would train the person to ignore the amber that matters — and a row per silence is the activity feed §8 removed |

**Two pills in the header, one of them teal.** The recording pill (`.headrec`) got
a twin (`.headrec.teal`): work happening unattended has to be visible from any
screen, which is the same problem recording solved. Same box, same `flex: none`,
same click-to-go-there contract — the red one returns to the recording, the teal
one opens the ⟳ Loops tab. An idle tick never touches either (`loopChromeWasOn`).

**Menus** clamp to the viewport and flip above their anchor rather than being
clipped. A **picker** is a fixed 196px column of names; a **destructive
confirmation** borrows the same box but carries a sentence and a path, so it is
wider (240–260px, clamped to the viewport) and the path wraps — at the picker's
width its content needed 302px inside 194px and the copy that says what is about
to be destroyed was the part that got cut.

**A third party's screen is drawn by Loro, and the renderer's guarantees are a
short, checkable list** (ADR-0031 R5a, `desktop/src/extview.js`). An extension
sends a **document**, never markup: it asks for a ROLE and Loro decides the
pixels. What that buys is stated as what is imposed and what is deliberately not,
because a harness that refuses on taste is a fork with extra steps (ADR-0031
§4.4) — and because the two lists were measured against the code, not copied from
the ADR.

**Imposed, mechanically, with no way around it:**

| What | How |
|---|---|
| **Both languages** | every label is `{pt, en}` and both halves are required — `err.ext_i18n_missing:<pointer>` otherwise. The person chose a language; an extension is not an exception to it |
| **Both themes** | colour is one of **9 tone roles** (`ink · ink2 · ink3 · muted · teal · amber · red · green · accent`), each mapping to a token defined in BOTH `:root` blocks. There is no hex, no `rgb()`, no `style` attribute anywhere in the alphabet, so the surface follows `data-theme` without ever learning a theme exists |
| **The rhythm** | spacing is one of the 8 steps of the 2px scale, type one of 4 size roles, alignment one of 4, family `sans\|mono`, an icon one of the **14 names Loro owns** (`ICONS_ALLOWED`) — a name outside it resolves to nothing |
| **The class list is closed** | `LoroExtView.CLASSES`, 58 names, plus the four Loro components named in rule 13. A modifier that is not in the list becomes a `data-` attribute, never a new class |
| **Ceilings** | 2000 nodes after expansion · component depth 8 · 64 children per layout node · 32 components · 200 rows per `each` · 120 (max 400) lines per `doc` · nesting 128. MEASURED: with the ceilings removed, a component whose body is a `use` of itself throws `RangeError` inside the painter and the screen goes blank saying nothing |
| **A refusal is visible and named** | an unknown primitive is `err.ext_view_node:<kind>` **painted in the screen**, translated, next to what did render. A node dropped in silence is a screen lying about what it showed (ADR-0029 §3.7) |
| **Attribution is the first child** | `.extv-attr` says «esta tela é da extensão «X» — o Loro só desenha o que ela pediu» ABOVE everything, so nothing below it reads as Loro's own claim |
| **One primary action** | rule 4, and the count is taken at **paint** time, not validation — one component used twice paints two buttons from one declaration. The second `primary: true` is refused by name (`err.ext_view_value:button.primary`) and painted as an ordinary `.btn`. MEASURED before the fix: two filled buttons, zero refusals. This one is a deliberate *narrowing* of ADR-0031 §13, which had listed the single primary as Loro's taste and therefore not imposed — see ADR-0031 §17 |
| **The reading column** | the surface renders inside `#brainDoc`, the same 700px `.doccard` every document uses, so §7's density and containment rules apply to it whether the author wanted them or not — the second narrowing of §13, and the reason `min-width: 0` is on every layout node |
| **Nothing reaches out** | no JS, no CSS, no font, no remote asset, no `style`, no reach into the focus order or the tab sequence. The guarantee is the **absence of the API**, not a check inside it — and the facts a view reads are computed by the host and handed to it, so a surface never asks the disk anything |
| **Prose is Loro's reader** | a `doc` node goes through `mdRender`, and every image and every external address is stripped **from the markdown source** before that. A link to a file in the project survives and is wired through the same guarded door as any other reference (`brain_resolve_ref`) |

**Deliberately NOT imposed** — and the shipped example proves each one is
reachable: `examples/extensions/hotspots-board` paints a horizontally scrolling
kanban of columns and cards, with counters, from a 53-line document and no code.
What a card, a column or a status *means* is the author's decision; a board, a
timeline or a counter is expressible; a dense layout is expressible. Loro's answer
to a surface it disagrees with is **origem** and **uninstall**, never a schema that
makes it unexpressible. What the alphabet has **no primitive for at all** is named
in ADR-0031 §14 and §17: an image or any geometry — so a map, a chart or a QR code
cannot be drawn by a third party without a change inside Loro.

## 6. Motion

Motion exists to explain a state change, never to decorate. Blink for recording
(1.4s pulse), 0.12s ease for carets and toggles, 0.9s flash to confirm "I opened
the chat for you". Every animation is wrapped in
`@media (prefers-reduced-motion: reduce)` with a static fallback.

## 7. Density and containment

The content column narrows when the ✦ IA panel opens, so **layout responds to the
column, not the window**: the recording footer, the Home hero grid (≤460px of column
→ one column) and the Conhecimento grid (≤540px → one column) all use a container
query on `.bmain`. A window-width media query would have been wrong for the same
layout, and was: a `1fr` track never shrinks below its min-content, so with the panel
open the three hero cards needed 367px inside 288px and "Perguntar à IA" was drawn
from x=538 to x=658 with the column ending at x=615 — 43px outside it at a 950px
window, 92px at 901px — while the media query that was supposed to rescue it only
fired below 900px, where a *closed* panel leaves 645px of room. Measured the same way,
two Conhecimento cards ended at x=732 with the column ending at x=716 at 1051px.
The threshold is the grid's own min-content plus the destination's padding; the query
is on the box that shrinks.

Wide content — tables, code, diagrams — scrolls inside its own container. The
page body never scrolls horizontally.

**A diff is the exception that proves the rule** (ADR-0027). Its rows read the
column too (`@container (max-width: 520px)` narrows the gutters), but the row
**wraps** instead of scrolling: knowledge is prose, and a line the reader has to
drag sideways to finish is a line they will not read. That is also why `unificado`
is the default in a 720px column — `lado a lado` leaves each side ~330px.

Two ways that was lost, both measured: a **stacked** layout (≤900px, where the
document's rail moves below the reader) turns `.docbody` into a column, and a column
flex container leaves its child shrink-to-fit in the cross axis — so the reader grew to
559.5px inside a 519px card, 9.5px past its right border, and the code block stopped
scrolling in its own container and inflated the document instead. And an **unbreakable
token** (a URL, a path, an id) sets a column's min-content width, so reading prose
needed horizontal scrolling: a document wraps one (`overflow-wrap: break-word`) rather
than growing past the card that holds it (WCAG 2.1 AA 1.4.10).

## 8. What explicitly does NOT go in

Kept from ADR-0020 §5, plus what the later rounds removed:

- **`ⓘ` tooltips.** If a thing needs explaining, the copy explains it. One
  deliberate exception, approved by the owner on 2026-08-11 and marked as such in
  the code (`index.html` `#wizDirInfo`): "onde guardar" keeps its summary in view
  and puts the long detail behind a **click** disclosure (`aria-expanded`), which
  is a progressive-disclosure control rather than a hover tooltip. A test pins it
  (`wizard.test.js`), so this line is the design system agreeing with the code
  rather than contradicting it.
- **Numbered flows** ("1 · 2 · 3"). Destinations, not steps.
- **Home statistics, bars and activity feed.** Home asks one question.
- **The brainstorming digest** (revokes ADR-0011) — its dedicated UI, not the skill.
- **Typed meeting markers.** One "momento".
- **The terminal's ×.** Visibility belongs to the ✦ IA panel and its tab.
- **A store front for plugins** (ADR-0029) — no browsable grid with artwork,
  ratings or "destaques". A pacote arrives from a folder (later a repository), and
  browsing a catálogo is a **list of names with a description**, in the 196px
  picker vocabulary the app already uses. No ⓘ explaining what a plugin is either.
- **An activity feed for loops.** A loop's history lives on the loop's own screen,
  consecutive quiet cycles collapse into one row, and Home stays as ADR-0020 §4
  left it: one question, no statistics.
- **A rich-text WYSIWYG editor.** Declined deliberately: git-diff churn, ADR-0007
  anchors, front matter. The markdown bar is markdown-aware, not WYSIWYG.
- **Anything an extension might paint that is not a primitive** (ADR-0031 R5a).
  Five refusals, each enforced by the absence of a way to express it rather than
  by a check: **no markup** — an extension sends a document, so no JS, no CSS, no
  HTML, no font and no remote asset ever reaches the page (the CSP is
  load-bearing); **no chrome** — the surface renders inside the reading card and
  cannot paint the header, the sidebar, the panel or another extension's screen;
  **no execution API** — `loro/exec` is a reserved name that is refused, not a
  method that is missing; **no image and no external address inside prose** — both
  are stripped from a `doc` node's markdown source, which is also why there is no
  chart, map or QR code (ADR-0031 §14); **no second filled button** — the second
  `primary: true` is refused by name and painted flat (§5). What an extension's
  screen *means* is not on this list, on purpose (§5, ADR-0031 §4.4).

## 9. Checklist before drawing new UI

- Does it fit the one anatomy, or is it inventing a second one?
- Is there exactly one primary action?
- Does every control do something, and does the copy say what will happen?
- Can you **see** the control? Its boundary comes from `--line-control` (3:1), its
  text from a token that clears 4.5:1 on that surface, and its focus ring is
  legible on the surface the ring lands on — including the inverted ones.
- Is every sentence in `--sans`, with mono left to paths, timecodes and counters?
- Does it read correctly in **both** themes, via `data-theme` (never
  `prefers-color-scheme` in a component)?
- Does every new string have an English pair?
- Does it respect `prefers-reduced-motion`?
- Does it survive a narrow content column (panel open) without a window-width
  media query?
- If it reports a state, does it enforce it?
