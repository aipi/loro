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
9. The **recording footer is shared** by the loose recording and the meeting — one clock, one canvas. Meeting-specific controls (⏸ pausar, ■ Encerrar) sit **left of the clock**; the explanatory sentence truncates before any control shrinks.

### Fixed measurements

| Element | Value | Token |
|---|---|---|
| Header height | 54px | — |
| Sidebar | 250px / 60px collapsed | `--side-w-default` |
| Right panel | 330px (floor 260px, the width where its three tabs still fit) | `--panel-w` |
| Document card | max-width **700px**, centred — view **and** edit | — |
| Terminal dock | 34vh default, floor 120px | — |

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
| `--muted` / `--ghost` | `#97938a` / `#c9c5bc` | `#8b8579` / `#5c574d` | captions / disabled |
| `--line-strong` / `--line` / `--line-soft` | `#e2ded5` / `#e9e6de` / `#efece5` | `#3a362e` / `#35312a` / `#35312a` | borders, by weight |
| `--teal` | `#0e8c86` | `#2fc7bf` | AI, knowledge, primary action |
| `--yellow` / `--yellow-ink` | `#dd9c00` / `#a87a08` | `#e6b13a` / `#e6b13a` | pending, "para organizar", system audio |
| `--red` | `#e5484d` | `#e5484d` | recording, destructive, blocking |
| `--danger` | `#b04a4e` | `#e08488` | destructive text on surfaces |

The dark palette is **warm** (`#211e19`, not `#111`) — it is the same paper,
after dark. `--on-teal` / `--on-solid` flip to the dark paper colour so filled
buttons keep contrast in both themes.

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
| Button, tab, section label | `600 12.5px var(--sans)` |
| Body of a control, list row | `600 13px var(--sans)` |
| Micro-label, counter | `10.5px var(--mono)` |
| Card title | `600 14px` → `650 19px` for a section heading |

Reading text (documents) uses the 700px card with normal weight; every UI label
above 12px is 600. Mono is never used for prose.

### Radius, elevation, spacing

| Radius | Where |
|---|---|
| `999px` | pills — nav, badges, record button, chips (most common by far) |
| `12px` | cards and panels |
| `10px` / `8px` | inputs, editor host, menu items |
| `6px` | small inline marks |

Shadows are tokens, not ad-hoc: `--sh-card` (rest), `--sh-card2` (raised card),
`--sh-menu` (floating menu), `--sh-modal` (modal). Dark theme raises opacity
rather than changing spread — depth reads differently on dark paper.

Spacing is a 4px rhythm; content padding is `clamp(16px, 3vw, 28px)` so a narrow
column keeps its margins.

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

**Cards.** `12px` radius, `--panel`, `--sh-card2`, `--line-strong` border. The
document card is 700px and centred in both modes.

**Empty states** carry an icon, a bold line and one explanatory sentence — never
three sections each explaining their own emptiness.

**Progress and work.** A running chat shows a "pensando…" indicator and one
`<details>` step per tool, closed by default, opening to request and response
(capped at 2000 chars — a conversation is not a file viewer). A failed step opens
itself.

**Pending state.** Any action that spawns a process paints a pending state on
click (`iniciando…` / `encerrando…`, disabled, pulsing) and is cleared by the
backend event that defines the truth — never by a timer.

**Refusals go to a toast, not into content.** A refusal written into the answer
bubble repeats on every click and reads as the agent failing.

**Menus** clamp to the viewport and flip above their anchor rather than being
clipped.

## 6. Motion

Motion exists to explain a state change, never to decorate. Blink for recording
(1.4s pulse), 0.12s ease for carets and toggles, 0.9s flash to confirm "I opened
the chat for you". Every animation is wrapped in
`@media (prefers-reduced-motion: reduce)` with a static fallback.

## 7. Density and containment

The content column narrows when the ✦ IA panel opens, so **layout responds to the
column, not the window**: the recording footer uses a container query on `.bmain`.
A window-width media query would have been wrong for the same layout.

Wide content — tables, code, diagrams — scrolls inside its own container. The
page body never scrolls horizontally.

## 8. What explicitly does NOT go in

Kept from ADR-0020 §5, plus what the later rounds removed:

- **`ⓘ` tooltips.** If a thing needs explaining, the copy explains it.
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
- Does it read correctly in **both** themes, via `data-theme` (never
  `prefers-color-scheme` in a component)?
- Does every new string have an English pair?
- Does it respect `prefers-reduced-motion`?
- Does it survive a narrow content column (panel open) without a window-width
  media query?
- If it reports a state, does it enforce it?
