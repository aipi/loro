# Loro — design system

How the interface looks, behaves and decides. `ARCHITECTURE.md` says how the app
is built; the ADRs record *why* each decision was taken; this file is what you
read before drawing new UI, so the next screen looks like it belongs.

Values here are **taken from `desktop/src/style.css`**, not from a mockup. When
the two disagree, the code is right and this file is stale — fix it.

> Sources: ADR-0020 (anatomy, vocabulary, theme), ADR-0021 (chat, resizable
> panes), ADR-0022 (seven usability rounds + the review sweep), ADR-0024 (intake
> triage). This file consolidates their *visual* consequences; the reasoning
> stays in the ADRs.

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
                 │ CONTENT                             │ Documento·Chat·Terminal
                 │ RECORDING FOOTER (while recording)  │
```

Inviolable rules — encoded in `shell.js` and the `.bshell` grid, not just here:

1. The tab strip starts **to the right of** the sidebar; the sidebar reaches the header.
2. **There is no "Home" tab.** Tabs are open documents only; Início/Organizar/Conhecimento are destinations of the header nav.
3. The sidebar collapse control sits **at the bottom**, beside ⚙ Configurações.
4. **One primary action per screen.**
5. **No explanatory `ⓘ` tooltips**, no numbered labels in navigation.
6. **✦ IA** toggles the right panel; its active state is a 12% teal fill.
7. **Gravar comes before ✦ IA** in the header.
8. The nav pill is **centred on the window** (absolutely positioned): both side blocks change width with their content, so flex centring would let it drift. Below 1080px it returns to normal flow, before it can collide.
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

### Fixed measurements

| Element | Value | Token |
|---|---|---|
| Header height | 54px | — |
| Sidebar | 250px / 60px collapsed (drag floor 180px, ceiling 45vw) | `--side-w-default` |
| Right panel | 330px (drag floor 300px, ceiling 60vw) | `--panel-w` |
| Document card | max-width **700px**, centred — view **and** edit | — |
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
field-shaped folder pickers, the chat composer, the editor host, the find bar —
draws its border with `--line-control`, which clears 3:1 on paper, panel and
sidebar in both themes (WCAG 2.1 AA 1.4.11).

**Focus is part of the palette.** `:focus-visible` is a 1.5px `--accent` outline
2px outside the control, so it contrasts with the surface *behind* the control,
not with the control. Two surfaces are inverted and get the ring of their own
palette: inside the terminal it is `--term-ok` (7.49:1 on `--term-bg`, where the
accent gave 2.76:1 in light) and on the toast, which is painted with `--ink`, it
is `--paper` (16.1:1 / 14.2:1, where the accent gave 1.79:1 in dark).

A box with more than one focusable child takes the ring on `:focus-within`, on the
box: the field row of a modal sheet, the find bar and the chat composer. All three had
switched the global ring off on the input and painted nothing in its place, so the
caret was the only cue and the controls beside it (the find counter and ×, the send
button) had none at all. The guard for this reads **every** `outline` declaration in
the sheet, including `!important`: it used to be an allowlist of nine selectors, so
switching the ring off on the record button, the destination tabs and the wizard's
colour swatches broke nothing.

A **state** is held to the same 3:1 as a boundary (WCAG 1.4.11): the selected ⌘K row
is a 3px bar in the accent (4.66:1 light / 5.54:1 dark against the row it marks, for
every one of the six project accents) over the 14% tint. The tint alone measured
1.12:1 against the rows around it, and Enter ran a command nobody could see selected.

**Semantics, not decoration:** teal = AI and knowledge · amber = pending, needs
you, other people's audio · red = recording and irreversible.

### Type

Two families: `--sans` (`-apple-system, Inter, system-ui`) for content and UI,
`--mono` (`ui-monospace, SF Mono, Menlo`) for anything the machine owns — paths,
timecodes, counters, badges, terminal.

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

**Menus** clamp to the viewport and flip above their anchor rather than being
clipped. A **picker** is a fixed 196px column of names; a **destructive
confirmation** borrows the same box but carries a sentence and a path, so it is
wider (240–260px, clamped to the viewport) and the path wraps — at the picker's
width its content needed 302px inside 194px and the copy that says what is about
to be destroyed was the part that got cut.

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
- **A rich-text WYSIWYG editor.** Declined deliberately: git-diff churn, ADR-0007
  anchors, front matter. The markdown bar is markdown-aware, not WYSIWYG.

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
