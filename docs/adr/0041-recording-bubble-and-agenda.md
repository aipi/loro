# ADR-0041 — The recording bubble, and recording the agenda instead of the whole day

- **Status:** accepted, implemented 2026-11-18 (owner's direction; the gaps below were filled by the implementer and are marked as such). Window behavior verified only in a headless browser — see "Owed to a human".
- **Supersedes:** ADR-0038 (the recorded workday).
- **Replaces:** the floating caption window (`overlay`, ADR-0001) and ADR-0022 §21's blinking tray.
- **Keeps:** ADR-0038 §3 (wall-clock epoch `e=` per utterance, `startedEpochMs`/`pausedMs` in the manifest, the `h:mm:ss` stamp) and §4 (keep the Mac awake), ADR-0039/0040 (the meeting mic path) untouched.

## Context

The owner, after a day with ADR-0038: recording the whole workday and letting an agent cut it by the calendar afterwards "wasn't good". What he asked for instead (2026-11-18):

1. Loro's symbol as a **bubble always on top of every app**, that he drags between windows and screens.
2. From the bubble: start/stop/pause a recording, **choose WHERE it is saved** (which idea), see the conversation being recorded, start a new one.
3. It **suggests the next calendar events** and lets him schedule them to be recorded — which removes the need for the all-day recording.
4. The tray icon **must not blink**; the recording sign lives only in the bubble.

A refinement arrived during implementation and supersedes the first click semantics: the bubble looks like the **Dock icon** (the colorful app icon, ~64 pt, subtle shadow); **press-and-hold + move drags**; a **click expands** the bubble into the panel (click again / click outside / Esc collapses); recording starts from the panel's **Gravar** button, never from a click on the icon; the panel opens **toward the side of the screen with more room**.

BR-9 still binds: the app never stores a credential and never reads Google. The calendar therefore comes from an **external agent** (the owner's Claude Code with a calendar connector), which is being written in parallel against the file contract in §4.

## Decision

### §1 A new `bubble` window replaces the caption overlay

A new window, label `bubble`, created in `setup` by `bubble.rs` (not in `tauri.conf.json`, because two of its properties are only reachable from code), replaces the `overlay` caption strip. Evolving `overlay` in place was rejected: its label, its `toggle_overlay` command and its Settings checkbox all meant "captions", and keeping two always-on-top floating windows would have them compete for the same corner. The bubble's panel shows the live transcript tail, so the caption had nothing left to do — `overlay.html/.js`, `toggle_overlay`, `optOverlay` and the footer chip were removed (the chip now shows/hides the bubble).

Window: transparent, undecorated, no system shadow (the shadow is CSS, around the icon only), not resizable, `always_on_top`, `skip_taskbar`, `visible_on_all_workspaces`, `focused(false)` (showing it never takes the keyboard from the call), `accept_first_mouse(true)` (the first click acts instead of only activating Loro). On macOS the NSWindow additionally gets `collectionBehavior = canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary` and `level = kCGStatusWindowLevel (25)` through `objc2` (already in the tree via Tauri), so it shows on every Space and over a fullscreen app.

Position: collapsed it is 84×84 pt (the 64 pt icon plus room for its badges). Where it sits is the person's preference, in `~/.loro/config.json`:

```json
"balao": { "visivel": true, "tela": "<screen name>", "posicoes": { "<screen name>": { "fx": 1.0, "fy": 0.7 } } }
```

One spot **per screen**, stored as a fraction of the room the bubble can move in on that screen's work area (not pixels: a resolution change or the Dock moving keeps it in the same corner); `tela` is the screen it was last left on. On start it reopens there, clamped to the visible area; on first run it sits on the right edge, a little below the middle. Every 15 s (the backend beat of §4) a bubble on no connected screen is brought to the nearest one. A drag is saved once it settles (600 ms after the last `Moved`), never while expanded. Absent `balao` = shown at the default spot. Settings → Capture «mostrar o balão de gravação», the tray item «Mostrar / ocultar balão» and the palette item hide/show it (`bubble_set_visible`).

### §2 Collapsed: the app icon, a steady badge, no animation

The icon is the colorful app icon (`icons/128x128@2x.png`, copied to `src/loro-icon.png` because `frontendDist` is `src/`), not the monochrome tray template. Idle: the icon only. Recording: a **steady** red dot on its top-right corner and the elapsed time (`m:ss`, `h:mm:ss` after an hour) in a small pill under it. Paused: a **steady** grey pause badge, the clock frozen. Starting/stopping: a neutral badge. **Nothing animates** — no keyframes, no transitions, no class toggled on a timer; the 1 s timer only rewrites the clock's digits. The smoke test measures it (two reads 1.3 s apart must be identical) and was shown to go red when a blink was added.

Gestures (`bubble-core.js::gesture`, pure): press → move beyond **4 px** (Euclidean) → `startDragging()` once, and the system owns the drag (it follows the cursor across screens); a release that never crossed 4 px is a **click**; a release after a drag does nothing. 4 px keeps a trackpad click (1–3 px of jitter) a click. A click on the icon **only toggles the panel** — it never records (owner's refinement).

### §3 Expanded: the panel

`bubble_expand(true)` resizes the window to 340×520 pt toward the side of the screen with more room on each axis (`expanded_frame`, pure and tested) and clamps it to the work area; the icon stays in the corner it was in (the panel draws its header there). Collapsing returns the icon to exactly where it was — or, if the open panel was dragged by its icon, to that corner of the panel where it was left (`collapsed_origin`, tested). Click on the icon, click outside (window blur) or Esc collapses. A NEW scheduler question (§4) opens the panel so it is seen; the same question does not reopen a panel the person closed.

Contents, top to bottom: state + elapsed + meeting title; the scheduler's question, when there is one; **onde salvar** — the idea picker (the active acervo's brainstorming ideas, the last one used selected, «+ nova ideia…» creates one through `brain_create_brainstorm`; disabled while recording, because changing it would promise a move that does not happen); the controls — **Gravar** (idle), **Pausar/Retomar**, **Encerrar**, **Nova gravação** (ends the current one and starts another in the chosen idea); **agora** — the last 12 lines of what was written to the meeting, labeled `você`/`sistema` (fed from the single append point, so a line dropped as echo never shows); **próximas reuniões** with a per-event «gravar» switch; **Abrir no Loro** (shows the main window on the living meeting).

The main window is the **owner**: the bubble sends `bubble-cmd` and paints `bubble-state`; the meeting, the scheduler and every decision stay in `app.js`, through the same paths as a meeting started from the main window (`startMeetingWith` without the modal, `pauseMeeting`, `resumeMeeting`, `stopMeeting`). Where meetings do not exist (Linux) «Gravar» falls back to the live mode's `toggle()`; a live recording shows only «Encerrar» (only meetings pause).

### §4 The agenda is a file an external agent writes

The contract — kept EXACTLY, because the agent side is implemented against it:

```
<active acervo>/.loro/agenda/<YYYY-MM-DD>.json   (the LOCAL day)

{"versao":1,
 "geradoEm":"<ISO-8601 with offset>",
 "eventos":[{"id":"<calendar event id>",
             "titulo":"<title>",
             "inicio":"<ISO-8601 with offset>",
             "fim":"<ISO-8601 with offset>",
             "comConvidados":true}]}
```

Only timed events, no attendee names. Reading (`agenda_read`, raw text; parsing in the pure `agenda.js`):

- missing file → «agenda não atualizada»; bad JSON, `versao ≠ 1`, `eventos` not an array or an unreadable `geradoEm` → the whole file is ignored (same note);
- `geradoEm` older than **2 h** → the same quiet note, **but the events still count** (a file written at 07:00 still holds the person's meetings at 10:00; only a later change is missed) — an implementer's call;
- an instant **without an offset is refused**, never read in the machine's timezone; a malformed event (no id, end ≤ start, bad instant) is dropped alone; a repeated id keeps the first; `titulo` missing shows «(sem título)»; `comConvidados` missing = false;
- the panel lists today's events that have not ended (`fim` exclusive).

Scheduling: the «gravar» switch writes `<acervo>/.loro/agenda/agendadas.json`:

```json
{"versao":1,"eventos":{"<event id>":{"tema":"<idea slug>","data":"YYYY-MM-DD"}}}
```

The tema is the one chosen in the panel at the moment of toggling (the switch refuses with no idea chosen); entries of past days are pruned on write. `.loro/agenda/` is added to the acervo's `.gitignore` (`GIT_IGNORED`): it holds meeting titles and is machine bookkeeping — never versioned (BR-8).

The clock: a **backend thread** emits `loro-tick` to the main window every 15 s (ADR-0038's lesson: the tick must not depend on `document.hidden`; this goes further and does not depend on a hidden webview's timers at all, which ADR-0038 left unverified). Each tick re-reads both files (they are small; no file watcher) and asks `agenda.js::decide` — pure, given `{now, eventos, agendadas, estado}`:

| Situation | Decision |
|---|---|
| idle, a scheduled event under way and not yet handled | `iniciar` — `startMeetingWith({tema, titulo: <event title>, quiet: true})`; tema = the scheduled one, else the last used |
| a scheduled meeting recording, 2 min before its end | `avisar-fim` → «termina em 2 min — estender?» (+15 min / deixar terminar), once per end |
| …at its end (`fim` from the CURRENT file — the agent may move it — plus the extensions) | `encerrar`; paused counts too |
| …at its end, with the next scheduled one already due (back-to-back) | `trocar` — stop, wait for the close (finish + purge, ≤ 120 s), start the next |
| a recording the PERSON started (or an extended scheduled one) when a scheduled event starts | `perguntar-troca` → «Começou: <título> — trocar para ela?» (Trocar / Continuar); nothing is interrupted |
| idle, an unscheduled event **with guests** in its first 10 min | `sugerir` → «Gravar <título>?» — one click, never auto-start |
| starting / stopping | `nada` |

Every event acted on (started, prompted, suggested, declined) is marked handled for the day and never acted on again; a scheduled meeting stopped by hand therefore does not restart. Overlapping due events: the one that began last wins. Starting by hand marks the events under way as handled (recording them by hand is not a reason to ask «trocar?»). Accepting a suggestion records it like a scheduled one (stops at its end, closes quietly).

### §5 What stays from ADR-0038, and what goes

Kept: `/usr/bin/caffeinate -i -w <Loro's pid>` — now held while **any** recording is active (live mode, manual or scheduled meeting), driven from the backend's single recording switch (`set_recording`, which every start/stop/pause/resume already passes), so there is no IPC for it; released while paused and on exit. The per-utterance `e=` epoch, `startedEpochMs`/`pausedMs` in the manifest, the `h:mm:ss` stamp. A meeting started by the agenda closes **quietly** (no tab, no analysis offer — the person was in a call in another window); one started by hand behaves as before.

Removed: the hourly rotation tick, the `diaGravado` settings UI, `workday_get`/`workday_set`/`workday_keep_awake`, `workday.js`/`workday.rs`, the tema `dia` special case and the palette's «Retomar o dia gravado». A `diaGravado` key left in `~/.loro/config.json` by v0.19 is ignored on read and dropped on the next write.

### §6 The tray

The icon is set once and never swapped (the blink thread and the dim frame are gone; the tooltip no longer changes either — the recording sign is the bubble's). Menu: Abrir Loro · **Gravar / Encerrar gravação** (the same `hotkey-toggle` as before, renamed with the bubble's verbs) · **Mostrar / ocultar balão** · Sair.

### §7 Untouched

ADR-0039/0040: the raw sidecar microphone, its in-process echo cancellation and the separate `você`/`sistema` tracks.

## Explicitly NOT done

- Loro still does not read the calendar, does not know who attends, and does not write the agenda file.
- No file watcher on the agenda: the 15 s tick re-reads it (a change shows within 15 s).
- The bubble is a regular `NSWindow`, not a non-activating `NSPanel`: clicking it activates Loro (the call app loses key focus for that click). Converting it to a panel would need private window-class swizzling; left for a measured need.
- No automatic opening of the main window for scheduled meetings; «Abrir no Loro» is the way.
- Windows/Linux: the bubble and the scheduler run; the Spaces/fullscreen behavior and keep-awake are macOS-only.

## Owed to a human (not verifiable headless)

- Always-on-top **over a fullscreen app** (Meet in fullscreen Chrome, Zoom fullscreen) and on **every Space** — the collection behavior and level are set, but only a real Mac shows the result.
- **Dragging across monitors**, the per-screen position after unplugging a monitor, and the clamp on resolution change.
- That clicking the bubble while another app is frontmost registers on the FIRST click (`acceptFirstMouse`), and that click-outside collapses (window blur).
- A scheduled meeting starting and stopping on time **with the main window closed to the tray for hours** (the backend tick is not a webview timer, but App Nap may still delay a background process).
- `pmset -g assertions` showing the `caffeinate` assertion during a recording and its release when it stops.
