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

Position: collapsed, the window is the icon plus 6 pt on each side (44×44 pt at the default 32 pt icon, §8). Where it sits is the person's preference, in `~/.loro/config.json`:

```json
"balao": { "visivel": true, "tela": "<screen name>", "posicoes": { "<screen name>": { "fx": 1.0, "fy": 0.7 } } }
```

One spot **per screen**, stored as a fraction of the room the bubble can move in on that screen's work area (not pixels: a resolution change or the Dock moving keeps it in the same corner); `tela` is the screen it was last left on. On start it reopens there, clamped to the visible area; on first run it sits on the right edge, a little below the middle. Every 15 s (the backend beat of §4) a bubble on no connected screen is brought to the nearest one. A drag is saved once it settles (600 ms after the last `Moved`), never while expanded. Absent `balao` = shown at the default spot. Settings → Capture «mostrar o balão de gravação», the tray item «Mostrar / ocultar balão» and the palette item hide/show it (`bubble_set_visible`).

### §2 Collapsed: the app icon, a steady badge, no animation

The icon is the colorful app icon (`icons/128x128@2x.png`, copied to `src/loro-icon.png` because `frontendDist` is `src/`), not the monochrome tray template. Idle: the icon only. Recording: a **steady** red dot on its top-right corner (the elapsed time lives in the panel header and the tooltip since §8 — under the icon, at 32 pt, there is no room for it). Paused: a **steady** grey pause badge, the clock frozen. Starting/stopping: a neutral badge. **The icon and its badge never animate** — no keyframes, no transitions, no class toggled on a timer (the only transition in the window is the panel opening/closing, §8); the 1 s timer only rewrites the clock's digits. The smoke test measures it (two reads 1.3 s apart must be identical) and was shown to go red when a blink was added.

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
- the panel lists today's AND tomorrow's events (§8).

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

## §8 Refinements after the owner's first build (2026-11-18)

The owner tested the first build («ficou top!») and asked for five changes, all on the same PR:

1. **Size.** The icon is **32 pt by default** — a quarter of the 64 pt icon's area — with **médio 48** and **grande 64** in Settings → Captura («tamanho do balão»); stored as `balao.tamanho` (anything else reads as 32). The collapsed window is the icon + 6 pt per side; the badge scales with the icon (30%, never under 9 pt). The 256 px PNG keeps it crisp at 2× up to 64 pt. The drag threshold (4 px) is a distance, so it is unchanged at 32 pt. `bubble_get_size` / `bubble_set_size` (resizes the collapsed window in place and emits `bubble-size`).
2. **Panel design.** A native-feeling card: an **opaque** surface per theme (the first build used a translucent blurred material; on a real Mac the text of the windows behind bled through the words — owner: «atrapalhando bastante» — so `backdrop-filter` is gone and the card is solid, with a 1 px border and a soft shadow), 14 px radius, system font, light and dark via `prefers-color-scheme`. Header: state (red dot + «gravando»), title · idea, elapsed time. One prominent red primary action (Gravar or Encerrar); the rest are ghost buttons. The destination is ONE compact field showing the current idea; clicking it opens a searchable list (type-to-filter with `fuzzy.js`; ↑/↓/Enter/Esc — Esc closes the list, not the panel): **Recentes** (the last 5 chosen, most recent first, kept in the main window's settings) and then every idea alphabetically, 8 rows visible and scrolling, plus «+ nova ideia «texto»» when no idea has exactly that name (created with `brain_create_brainstorm` before recording or scheduling into it). A first version used chips, which did not scale («e se tiver uma lista grande?»). The SAME component is the per-event destination in the Agenda. No native `title` tooltips inside the panel (one overlapped the Record button); the collapsed icon keeps its hint. Two tabs, **Gravação** and **Agenda**. Opening/closing is a 140 ms fade+scale from the icon's corner (none under `prefers-reduced-motion`), the only transition in the window. Contrast is MEASURED in the smoke (WCAG, against the panel's own opaque background, which the smoke also asserts has alpha 1 and no backdrop filter): every text checked is ≥ 4.5:1 in both themes (lowest: 5.4 for white on the red button). Red TEXT uses a lighter red in dark mode (#ff7b72), because the button red on the dark material read at ~2.6:1.
3. **Agenda — follow every next event.** The external agent now ALSO writes **tomorrow's** file, same contract, `.loro/agenda/<tomorrow>.json`. Loro reads both (either may be missing; merged by id, today's first; the «agenda não atualizada» note follows the most recently generated valid file). The Agenda tab groups **Hoje** / **Amanhã** and collapses today's ended events under **«Já passaram (N)»**; the one under way is highlighted. A row opens in place: time range, duration, live status («começa em 25 min» / «agora»), with/without guests, the destination idea for THAT event, «Gravar quando começar», and «Gravar agora» while it is happening (recorded like a scheduled one — titled, stopped at its end, closed quietly). A schedule entry carries the EVENT's day (`data`), so an event of tomorrow scheduled tonight survives the pruning and starts tomorrow (tested across midnight).
4. **Collapsed hint.** The icon's tooltip says the state and the next event: «Próxima: 09:30 Daily — gravar ✓» (✓ when it is scheduled).
5. **Mini chat** (owner request A). A composer at the bottom of the card asks the acervo's agent anything, through the SAME path the main chat uses (`chat_send`, the acervo's own CLI in the acervo as cwd — no new credential, BR-9) but on its **own channel** (`channel: "bubble"`: its own process slot, its own `--resume` session, its own `bubble-chat-*` events), so a question asked over a call never lands in the main window's conversation. Context goes as **file references**, never pasted: the living meeting file (when recording) and the two agenda files, prefixed as `@path` lines. The answer streams in, rendered as escaped markdown-lite (bold, code, lists, fences) with a copy button; «pensando…»/«usando X…» while it runs, **Parar** kills the process, **nova conversa** resets the session; Enter sends, Shift+Enter breaks the line, Esc collapses. The card grows with the conversation up to **70% of the screen height** (`bubble_panel_height`, growing away from the icon). What the agent may do without asking is ADR-0042.

## §9 Agenda event links

The agenda contract gains two **optional** fields per event, `versao` unchanged (absence tolerated):

```json
{"id":"…","titulo":"…","inicio":"…","fim":"…","comConvidados":true,
 "link":"<video call URL — Meet/Zoom/Teams, if any>",
 "linkAgenda":"<Google Calendar event page URL>"}
```

Only `http(s)` URLs are kept (`safeUrl`: scheme checked, no whitespace, ≤ 2048 chars); anything else is dropped without dropping the event. URLs open in the **default browser** through the existing `brain_open_link` command, which checks the scheme again — never inside a webview. The Agenda tab shows a red **Entrar** on the event in progress and on the next one to start (when they have a link), **Entrar** and **Abrir na agenda** in the opened detail, and when a scheduled recording starts on an event with a link the bubble asks **«Gravando: <título>» — Entrar na reunião**.

## §10 Tarefas (the owner's Google Tasks, through a file)

A third tab, **Tarefas**. Loro still never touches Google (BR-9): the agent writes `<acervo>/.loro/agenda/tarefas.json`:

```json
{"versao":1,"geradoEm":"<ISO with offset>","tarefas":[{"id":"<task id>","titulo":"…",
 "prazo":"YYYY-MM-DD"|null,"notas":"<plain text or empty>","status":"needsAction"|"completed",
 "concluidaEm":"<ISO>"|null,"link":"<webViewLink or null>"}]}
```

(open tasks plus those completed in the last 7 days). Parsed in the pure `src/tarefas.js`: a malformed task is dropped alone, a non-calendar `prazo` reads as «sem prazo», a non-http(s) link as none; the same stale rule (missing or older than 2 h → quiet «tarefas não atualizadas»). Groups by the LOCAL day: **Atrasadas / Hoje / Próximas / Sem prazo**, plus **Concluídas (N)** folded. A row is a checkbox, the title and a due-date chip; clicking opens the notes as plain text (line breaks kept; `http(s)` URLs become buttons that open in the browser — never HTML) and **Abrir no Google**. The tab shows a badge with overdue + today.

Completing (or reopening) cannot write Google, so Loro APPENDS an action to `<acervo>/.loro/agenda/tarefas-acoes.json`:

```json
{"acoes":[{"id":"<task id>","acao":"concluir"|"reabrir","em":"<ISO with the local offset>"}]}
```

(write-then-rename; a corrupted file starts over; the agent consumes and clears it). The task shows **«concluindo…»** in place until a later `tarefas.json` reflects it; then (or if the task left the file) the pending action is dropped (`reconcile`). `.loro/agenda/` is already git-ignored.

## §11 Slash commands in the bubble chat

Typing `/` in the bubble composer opens a completion list of the owner's skills and commands, as in Claude Code's terminal: each row is `/name` + a one-line description, filtered as he types (`fuzzy.js`), ↑/↓ to move, Tab/Enter to complete to `/name ` (the space is where arguments go), Esc closes the list. `skills_list` (Rust, `skills.rs`) discovers what the CLI would load for the acervo — project `.claude/skills/*/SKILL.md` and `.claude/commands/*.md`, user `~/.claude/skills` and `~/.claude/commands`, plugin skills under `~/.claude/plugins/**/skills` shown as `plugin:skill` (the plugin's name from its `.claude-plugin/plugin.json`) — reading ONLY the frontmatter `name`/`description` (plain, quoted, block or wrapped values; missing name → folder/file name), precedence project > user > plugin, names restricted to plain tokens, cached 60 s. No CLI built-ins are listed: the ones that exist are interactive and do nothing in `-p` mode. A message that starts with `/` is sent to `claude -p` UNCHANGED (no context header in front), so the CLI resolves it. Not done: the same popover in the main window's chat composer (left for a follow-up).

## §12 Getting out of the way (owner, 2026-11-19)

"ocultar quando a janela do loro for aberta, ou fechar essa miniatura a algum momento."

- **Steps aside with the main window.** While the main window has focus, the bubble is hidden; when it loses focus (another app, or the window is closed to the tray) the bubble comes back. This is NOT the person's "hidden" (`balao.visivel` is untouched); it is `balao.ocultarComJanela`, on by default, with a checkbox in Settings. "Abrir no Loro" folds the panel first, so the bubble returns as the icon.
- **Hide from the bubble itself.** The panel's footer has "Ocultar balão": it sets `visivel: false` (the same as the Settings checkbox). It comes back from the menu bar (the tray item "Mostrar / ocultar balão"), or from Loro: ⌘K "Mostrar / ocultar balão", the bubble button on the recording bar, or Settings. An explicit show shows it right away, even over the main window; it steps aside again the next time that window takes focus.

## §13 The parrot walks while recording (owner, 2026-11-19)

"quando ele estiver em gravação, poderia fazer o loro se movimentar no bubble, como se tivesse andando."

This amends §2's "the icon never animates", by the owner who asked for that rule. While **recording**, the parrot in the bubble walks in place: the two legs swing and the body bobs (0.7 s cycle). Paused, starting, stopping or idle, it stands still. What §2 was about still holds: **nothing blinks** — the red dot and the pause badge stay steady, and no opacity or colour changes on a timer. `prefers-reduced-motion` turns the walk off. To animate, the bubble draws the parrot as inline SVG (`#bird`, the same drawing as `icons/parrot-src.svg`) instead of the PNG.

## §14 Random tricks while recording (owner, 2026-11-19)

"faz ele pular e abrir as asas de vez em quando, ou se mexer a ponto de sumir. Ter vários movimentos diferentes e aleatórios."

On top of the walk (§13), every 1 to 4.5 seconds of recording the parrot does one trick, drawn at random and never the same twice in a row: **jump** (with the wings open), **flap**, **exit** (walks out of the icon and comes back from the other side), **flip** (turns around for a moment), **spin** (a somersault), **peck**, **fly** (takes off flapping, leaves through the top and lands back from the other side) and **talk** (the beak moves and a small speech balloon pops up beside him). Each is one finite CSS animation behind a class on `#icon` (`t-<name>`); `bubble.js` only draws the next one and clears it. They stop with the recording, and `prefers-reduced-motion` turns all of it off. The red dot still never moves or blinks.

## §15 The parrot inside the main window (owner, 2026-11-19)

"faz esse de dentro fazer os truques também, enquanto grava" — and, in the dark theme, the panel grey around it instead of the cream square.

`src/parrot.js` replaces every `<img src="parrot.png">` of the main window with the same inline SVG the bubble draws (`.parrotbox`, styles in `style.css`). While recording and not paused it walks and does the same random tricks (§13, §14), driven from `paintRecordingChrome`. Light theme: the cream tile. Dark theme: the tile is `--panel` and the beak and legs go light. The drawing and its keyframes now exist twice (bubble.html and style.css/parrot.js): the bubble is a separate window with its own CSS, and keeping it self-contained was preferred to a shared file for now.

## §16 Marking the live talk from the bubble (owner, 2026-11-19)

"no balão, deve permitir grifar uma palavra e aparecer as opções. Se eu comentar, isso deve ser considerado na análise, ou criado um to-do depois."

Selecting a passage inside one line of the bubble's live talk shows three options under it: **Grifar**, **Comentar** and **Tarefa**. The bubble sends `annotate` with the quote; the main window writes it with `brain_annotation_add` into the running meeting's `meeting.anotacoes.json` — the same sidecar and shape as the main window's highlights (ADR-0007), so the mark also shows in the living tab. A to-do is an annotation with `tipo: "tarefa"` and a comment `tarefa: <text>` (the passage itself when left empty). Loro only stores it (BR-9): whoever analyses the meeting afterwards — the owner's agenda loop — reads the sidecar, weighs highlights and comments, and turns `tarefa` annotations into tasks. While a passage is being marked the live talk is not repainted, so the selection survives new lines.

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
- The translucent material over real windows (the smoke renders over a blank page), the tooltip of a non-key window (WKWebView may only show `title` tooltips while Loro is active), and the panel growing with a long chat answer.
