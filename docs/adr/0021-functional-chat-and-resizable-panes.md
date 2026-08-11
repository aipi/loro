# ADR-0021 — A functional chat, and every side pane is resizable

- Status: accepted
- Date: 2026-08-11
- Builds on: ADR-0003 (per-acervo AI agent), ADR-0020 (the redesigned shell)
- Records the **permission-denial flow** (`chat_handoff`): the design handoff
  called it "ADR-0019", but no such ADR was ever written in this repo — the
  decision is recorded HERE, and `docs/adr/` has no 0019 by design. (The
  companion `chat_add_dir` was removed by this ADR's own amendment below.)

## Context

ADR-0020 shipped the Chat tab of the right panel as a **composer without a
conversation**: sending routed the prompt to the embedded terminal and the answer
appeared there, not in the thread. That is a signpost, not a chat — the exact
thing the redesign set out to remove.

Separately, only one of the three side panes could be resized. The file tree had
a drag grip (ADR-0002 §6); the 330px right panel and the bottom terminal dock
were fixed. On a 13" laptop the reading column is the first thing to suffer, and
the user could do nothing about it.

## Decision

### 1. The chat talks to the project's own agent, non-interactively

**No API call is added.** The chat runs the *same* CLI the embedded terminal runs
— the acervo's `agent` (ADR-0003) — in non-interactive mode, with the acervo
directory as the working directory. The privacy posture is therefore unchanged
and unchanged *by construction*: the account is the user's, the process is local,
and Loro neither stores nor forwards a credential (BR-1, BR-9).

New module `src-tauri/src/chat.rs`, and the IPC surface:

| Command | Purpose |
|---|---|
| `chat_send` | run one turn: `{prompt, model, effort, permission, fresh}` |
| `chat_cancel` | kill the running turn |
| `chat_reset` | drop the session — the next turn starts a new conversation |
| `chat_status` | `{running, hasSession, agent}` — lets the UI recover after a reload |
| `chat_handoff` | the line that resumes this conversation in the terminal |

Events: `chat-delta` (incremental text), `chat-tool` (the agent reached for a
tool), `chat-done` (`{ok, error, detail, permission}`).

**The Claude contract**, verified against `claude --help` and a live probe on
2026-08-11:

```
claude -p --output-format stream-json --include-partial-messages --verbose \
       [--model M] [--effort L] [--resume SESSION] [--add-dir DIR]
```

One JSON object per line. We consume exactly four shapes — `system`/`init` (the
session id), `content_block_delta` (text), `content_block_start` of a `tool_use`
(the step marker), and `result` (end of turn). **Every unknown line is ignored on
purpose:** the CLI's stream vocabulary will grow, and a new shape must not be
able to break the chat.

The prompt goes over **stdin**, not argv — a long prompt would otherwise blow the
argument limit and force hand-rolled quote escaping.

**Multi-turn is `--resume <session_id>`,** with the id captured from the previous
turn. Verified live: turn 2 recalled a word only turn 1 was told.

**Agents that are not Claude** have no standard print mode. For them the prompt
is passed as a single argument (`ollama run llama3 "…"`) and stdout is the answer
— no session, no structured streaming, and `chat_handoff` refuses with
`err.chat_handoff_unsupported` rather than inventing a flag.

**One turn at a time.** A second send while one runs is refused
(`err.chat_busy`), not queued: a queued turn is invisible work.

### 2. A permission denial is a choice, not an error

In print mode the agent cannot stop and ask, so a tool that needs permission
fails the turn. Rather than print that as a dead end, the backend flags it
(`permission: true`) and the UI shows the amber block from the design: **Permitir
esta pasta** (`chat_add_dir`, scoped to this conversation, written to no config)
or **Continuar no terminal** (`chat_handoff` → `agent --resume <id>` typed into
the embedded terminal, where the agent *can* ask interactively).

Detection is a heuristic over the CLI's wording, because the CLI has no stable
code for it. It deliberately errs toward *not* matching: the worst case is the
raw message instead of the amber block, never a permission block over an
unrelated failure.

### 3. Model and effort are one control

The state strip's `sonnet · alto ⌄` opens one menu with both axes and maps to
`--model` / `--effort`. Effort levels are named in the UI language and translated
at the edge (`alto` → `high`) — the user picks a word, not a flag.

### 4. Every side pane resizes, with one gesture

`#aiGrip` (between content and panel) and `#termGrip` (above the bottom terminal
dock) join the existing `#sideGrip`. All three share `wireGrip()`: drag to
resize, double-click to reset, persisted in `localStorage`
(`panelW`, `termH`, alongside the existing `sideW`).

Floors are functional, not arbitrary: the panel stops at **260px**, the width at
which its three-tab row still fits without wrapping (ADR-0020 rule 6); the
terminal dock stops at 120px. Ceilings are 60% and 75% of the window.

While dragging, `body.resizing` disables pointer events inside the main row —
without it the xterm canvas and the wave canvas swallow the pointer mid-gesture.

## Consequences

- `chat.rs` spawns a child process per turn and reads it on a worker thread; the
  child is killed on `chat_cancel`/`chat_reset` and on a new turn.
- Logs carry line counts and exit codes only — never prompt or answer text (BR-8).
- The chat survives a window reload: the turn runs in the backend, and
  `chat_status` restores the busy state instead of pretending nothing is running.
- The Chat tab no longer routes to the terminal. The terminal remains the place
  for interactive work and is where `chat_handoff` lands.
- New persisted UI state: `panelW`, `termH`, `chatModel`, `chatEffort`.

## Amendment (2026-08-11) — permission mode, and steps you can open

Measured against the real CLI after first use, two things in §1 were wrong.

### The chat could read but never write

In print mode the agent **cannot stop and ask**, so every write was denied. The
symptom was worse than a plain error: the turn ended with **`is_error: false`**
and a polite "Preciso da sua permissão para gravar os arquivos", so the denial
was invisible to the `chat-done` check and the agent looped retrying. `--add-dir`
never addressed it — the acervo directory is already the working directory; what
was missing was `--permission-mode`.

Measured (2026-08-11, same `alvo.txt` written in a scratch project):

| `--permission-mode` | writes in the project | reads outside the project |
|---|---|---|
| *(default)* | **denied**, `is_error: false` | denied |
| `acceptEdits` | **works** | denied |
| `bypassPermissions` | **works** | **works** |

So the command now always carries a mode that can act, and the mode is the
user's choice (Settings → IA e terminal → *o que o chat pode fazer*):

- **ler e editar o projeto** (`acceptEdits`, default) — covers analysing a
  meeting and writing notes, and stops at the project boundary.
- **tudo, sem perguntar** (`bypassPermissions`) — also external connectors
  (Slack, Drive…) and paths outside the project.

`manual` and `plan` are deliberately not offered: they require a prompt that
print mode has no way to show, so offering them would be offering a broken mode
(`permission_arg()` folds anything unknown into `acceptEdits`).

Denial detection moved to where the truth is: a **`tool_result`**, read as it
streams, instead of the final `result`. The amber block now offers *Liberar tudo
e repetir* — which changes the persisted policy and re-sends the last prompt —
instead of "Permitir esta pasta", which was solving a problem that did not exist.

**`chat_add_dir` was removed.** It was built for that button; with the boundary
measured, `bypassPermissions` covers the outside-the-project case and the command
had no caller left. A registered command with no caller is dead surface.

### Steps are expandable

`chat-tool` now carries `{id, name, input}` read from the `assistant` event
(where the input is complete — `content_block_start` still has it half-built),
and a new `chat-tool-result` carries `{id, isError, text, permission}` from the
matching `tool_result`. In the UI a step is a `<details>`: closed it is just the
tool name, open it shows the request and the response. Both sides are capped at
2000 chars in the backend — a conversation is not a file viewer, and a tool
result can be megabytes. A failed step opens itself.
