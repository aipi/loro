# ADR-0030 — The header's axis is structural, and the wizard's chrome has one owner

Three defects on one surface, reported from the running app: the nav pill sitting
under the right-hand block, the new-project screen wearing three chromes, and a
project switch offering a menu it would not open.

- Status: accepted
- Date: 2026-08-17
- Extends: ADR-0020 (one anatomy — the nav pill is the header's axis), ADR-0021
  (resizable panes), ADR-0022 §7 (the header's yielding ladder), ADR-0027 (the
  fourth destination), DESIGN.md §1 (state must never lie), §2 rule 9 (prose
  yields, then decoration, then air — a control is never clipped), §7 (the body
  never scrolls sideways)
- Supersedes: the `1140px` breakpoint that returned the nav pill to flow

## Context

Two defects reported from the running app, on the same surface, minutes apart.

### 1. The nav pill sat *under* the right-hand block

Reported as "só aqui que tá quebrando em janelas menores", with a screenshot of
`v0.13.0` half-covered by the `Review` destination.

The pill was centred with `position: absolute; left: 50%`, which takes it **out of
the flow**: nothing pushed it, so when the right-hand block grew it simply passed
underneath. The only guard was a media query that *predicted* the two side widths
(`1140px`, itself a correction of an earlier `1080px`, alongside a third
hand-measured step at `1015px`).

The prediction cannot hold, because the header's content is variable: the UI
language, the project name, the two nav counters, and above all the working-draft
chip, which runs to its own `max-width: 190px`. Measured in the running app
(WebKit, en, draft `feat/acervo-naveg…`):

| block | width |
|---|---|
| left (project) | 107px |
| nav pill | 368px (456→824) |
| right | **440px**, starting at **822** |

A 2px overlap — the version tag underneath the pill — at **1280px, the default
window width in `tauri.conf`**. The centred pill only cleared the right block from
`navW + 36 + 2·rightW = 1284px` up. The shipped default was on the wrong side of
the guess.

Two further defects fell out of measuring properly (a sweep of viewport widths,
four content cases):

- **The project block overflowed instead of eliding.** Its right edge stayed at
  111px at *every* width — it never yielded — and ran over the pill by up to
  **172px**. `min-width: 0` let the track collapse while `justify-self: start`
  sized the item to its content, so it simply overflowed its cell.
- **The body scrolled sideways between 1016 and 1050px** (up to 46px), which §7
  forbids. The right-hand block gave nothing: 602px from 1600px all the way down
  to 1016px, because a fit-content grid item at max-content never squeezes its
  own flex children.

### 2. The new-project screen had three appearances

Reported as "essa tela tá com 3 comportamentos diferentes", with three
screenshots of the same *New project* form wearing three different chromes.

`openNewAcervo()` revealed the screen immediately — `B.setup.hidden = false;
B.shell.hidden = true` — but the `firstrun` class, which is what strips the header
of everything that has no subject without a project (`#app.firstrun .destnav,
.recbtn, #aiPanelBtn, #aiPanel`), was applied only by `brainRefresh()`, **a ~10s
poll**. Until the tick landed, the new-project form was framed by the *configured*
project's chrome: destinations pill, Gravar, ✦ IA, and the AI panel open —
narrowing the column the form is centred in, which is why the card sat in a
different place in each screenshot.

One state, two owners. The settled state was always correct; what varied was when
you looked.

### 3. The project switch still wore a menu it would not open

Reported on the settled screen: "isso ainda confunde (a seta)". Even once the
`firstrun` chrome had landed, the left block read `🦜 project ⌄` — and the `⌄` is
the promise of a dropdown. The click could not deliver it, because the only thing
disabling the switch was `#app.firstrun .apphead .projbtn { pointer-events: none }`.

Which turned out to disable less than it claimed: `pointer-events: none` blocks the
**mouse** and leaves a `<button>` in the tab order. Focus it and press Enter and the
click handler fires — the project menu opened over the wizard. The "disabled"
control was operable by keyboard, and it kept `aria-haspopup="true"`, so a screen
reader was told about a popup too.

## Decision

### The axis is a grid, not a prediction

`#appHead` becomes three tracks with **flexible sides**:

```css
#appHead { display: grid; grid-template-columns: 1fr auto 1fr; }
#appHead > .switch    { justify-self: stretch; }
#appHead > .destnav   { justify-self: center; }
#appHead > .headright { justify-self: stretch; justify-content: flex-end; min-width: 0; margin-left: 0; }
```

While both side blocks fit their share, the middle one sits on the window's axis;
when a side needs more, it **pushes** the pill instead of passing under it. The
degradation is continuous — no jump at a guessed width — and the exact axis
returns on its own. The `1140px` breakpoint is deleted; only its prose step
(`.projname { max-width: 110px }`) survives, and now for a stated reason: a
narrower left track keeps the pill on axis longer.

`stretch` is what binds each side block to its track — that is the fix for the
overflow, not decoration. And the right block is bound too, so it finally yields:
what gives is the **draft chip**, already `flex: 0 1 auto; min-width: 0` and
already elected "the first to yield width" (R64). It ellipsizes the draft name,
which stays whole in the `title` and in the sheet it opens. No control shrinks —
every other child is `flex: none`, and their sum is the track's floor, which is
precisely what stops the pill from ever passing under. `margin-left: auto` must go
in the grid: an auto margin cancels `stretch` and would restore fit-content.

`#headRec` moves **inside** `.headright`. As a loose fourth sibling it had no
track, and its width has to count toward the block whose share decides whether the
pill is on axis — which is where the old comments were already measuring it.

Measured after the change, in the app at 1280px: collision **−14 on both sides**
(was +2), off-axis **−2** (the header's asymmetric padding, 14 left / 18 right),
no sideways scroll. Across the swept matrix — 4 content cases × 16 widths, 860px
(the `tauri.conf` floor) to 1600px — worst case **−10 / −10 / 0**.

### The measurement is repeatable, or it is not a measurement

`tools/measure-header.js` renders the **shipped** header markup (extracted from
`index.html`, never retyped) with the **shipped** sheet, at a sweep of viewport
widths so the media queries actually fire, and fails when the pill is overlapped
or the body scrolls sideways. It writes only the content the app fills at runtime,
and it writes the **worst case** on purpose: predicting the typical case is what
produced the breakpoints that broke. Run by `make test-layout`; kept **out** of
`make test`, which must stay portable, and it skips with exit 0 where no
Chrome/Chromium exists. Proved to bite by restoring the old rule: red on every
case, green after.

### One state, one painter

`paintWizardChrome(showWizard, legado)` owns all three signals — the two `hidden`
flags and the `firstrun` class — and both entrances call it: `openNewAcervo()`
paints on the spot, `brainRefresh()` paints on its tick. The chrome is no longer
something a poll gets around to. Same cure as C1/C2/C28 in `state-truth.test.js`:
find the single source and make the surface read from it.

### What is not a control does not dress as one

`renderSwitch()` derives one boolean from the same single source (`!B.setup.hidden`)
and paints the switch from it: the `⌄` is **hidden**, the button is genuinely
`disabled` — which is what removes it from the tab order and blocks Enter, the half
`pointer-events` never covered — and `aria-haspopup` is dropped, because a disabled
button must not keep advertising a popup. `paintWizardChrome()` calls
`renderSwitch()`, so the arrow goes the moment the screen appears rather than on the
next tick. The CSS rule stays as a belt, with the appearance of the disabled state
beside it: no grey control chrome, because in the wizard that block is the app's
**mark**, not a button.

The **label** is deliberately left alone. B7 fixed `t("projeto")` as the right word
(the defect it cured was the internal term "acervo" leaking into the UI), and with
the `⌄` gone it reads as a label rather than as a project one could pick. Creating an
*additional* project it shows the active project's real name, which is a fact worth
stating. Verified in the app: before, `disabled=false / haspopup=true / focusable`;
immediately after `openNewAcervo()`, `caret hidden / disabled=true / haspopup=null /
not focusable`.

## Consequences

- Between roughly 943px and 1284px the pill is pushed off the exact axis rather
  than centred. That is the honest trade: it was already off-flow-centre below
  1140px, and the alternative is overlap. Nothing is clipped and nothing scrolls.
- A long draft name now ellipsizes earlier on a narrow window instead of holding
  its 190px. The full name is in the `title` and in the sheet — it is an address,
  not a label (R64).
- The `1015px` ladder (prose → decoration → air) is untouched and still needed: it
  is what makes the 860px floor fit.
- `.apphead` stays flex for the **Settings** header, which has different children;
  every grid rule is scoped to `#appHead`.
- The header's axis can no longer be broken by a content change without
  `make test-layout` going red — but only if someone runs it. It is opt-in.

## Tests

- `review.test.js` F12 — `.destnav` may never be `position: absolute` again (the
  root cause, asserted directly), `#appHead` declares the three tracks, and
  `#headRec` lives inside `.headright`.
- `tokens.test.js` — the yielding ladder now reads in grid terms: the project
  block's `min-width: 0` is what lets the left track shrink, `display: flex` is
  what makes it elide instead of overflow.
- `state-truth.test.js` C32 — `paintWizardChrome` owns the three signals, both
  entrances call it, and **no one else writes them** (the assertion strips the
  painter from the source before searching, so a second writer fails).
- `state-truth.test.js` C33 — the switch reads the same single source; the caret
  follows it; `disabled` is what disables (asserted by name, so a return to
  `pointer-events`-only fails); `aria-haspopup` is dropped and restored; and the
  painter repaints the switch so the arrow never waits for a poll.
- `xref-surfaces.test.js` — the legacy gate is still decided before the shell can
  appear, now through the painter.
- `make test-layout` — 4 content cases × 16 widths, no overlap, no side-scroll.
