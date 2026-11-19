# ADR-0042 — «Permissões do Claude»: free by default, with a deny list for acts on other people

- **Status:** accepted, implemented 2026-11-18 (owner's request, same PR as ADR-0041).
- **Amends:** ADR-0029 §4.9 (an unattended cycle never got `bypassPermissions`) and §4.18 (a cycle never gets `Bash`) — both remain true in the «restrito» mode and are no longer the default; ADR-0021 (the chat's own permission choice) — it now applies only in «restrito». ADR-0029 is not rewritten; this file is the change.
- **Keeps:** BR-9 — no credential is stored or forwarded; every run is still the acervo's own agent CLI, in the acervo as cwd, under the person's own account.

## Context

The owner, 2026-11-18: «vamos liberar de acordo com os pedidos sem pré-autorização». Loro's agent runs were held back by flags that print mode cannot ask about: the chat ran with `acceptEdits` unless the person flipped it; a loop cycle always ran with `acceptEdits` and `--disallowedTools Bash`, read-only outside the project. Requests failed with a permission block the person then had to work around — and the new bubble chat (ADR-0041 §8) would inherit the same friction during a call.

At the same time he has a standing rule for UNATTENDED runs: never send, publish, share, delete or answer on his behalf (Slack send/draft/schedule/create-conversation/reaction/canvas, Gmail draft/trash, Drive share/trash, Calendar delete/respond).

## Decision

1. **One setting, the person's:** `~/.loro/config.json` → `"permissoesClaude": { "modo": "livre" | "restrito", "bloqueio": [tools…], "bloquearNoChat": false }`. Never in the acervo's versioned `.loro/settings.json`: a teammate's commit must not be able to widen what the owner's agent may do. Absent = `livre` with the default deny list. Settings → IA e terminal → «Permissões do Claude».
2. **«Livre (sem pedir autorização)» is the new default:** `--permission-mode bypassPermissions` on every surface — the main chat (and with it «pedir à IA» from brainstorm/review), the bubble chat, and loop cycles. No `Bash` block; writes outside the project allowed.
3. **«Restrito (como antes)»** reproduces the previous model exactly: the main chat follows its own segmented choice (ADR-0021), the bubble chat runs `acceptEdits`, a cycle runs `acceptEdits` with `cycle_tool_flags` (`Bash` always refused, the granted `--allowedTools`).
4. **The deny list** (`bloqueio`, editable, one tool per line; pre-filled with the 14 tools of the owner's rule) is passed as `--disallowedTools`:
   - to **every loop cycle, in both modes** — nobody is watching it;
   - to the **bubble chat only when «Bloquear envios no chat do balão»** is on (default **off**: there the owner is typing the request himself);
   - never to the main chat (unchanged from before).
   An emptied list adds no empty flag (the CLI refuses one).
5. **One pure builder** (`agent_perms.rs`: `permission_mode(perms, surface, chat_choice)` + `tool_flags(perms, surface, permite, recusa)`), used by `chat_send` and by `start_cycle`; the stored list is cleaned at save and again at spawn (`clean_refusals`: plain tokens only, no leading `-`).

## Consequences

- A loop can now run commands and touch files outside the project by default. What it cannot do — unless the person empties the list — is act on other people through the listed connectors.
- The loops screen still never offers a mode (ADR-0029 §4.9's surface rule stands): the mode is chosen once, in Settings, for the person.
- The chat's amber «faltou permissão» block can still appear in «restrito», or when a tool is on the deny list.

## Tests

`agent_perms.rs`: absent config = livre + 14-tool list + chat unblocked; livre bypasses on all three surfaces; restrito is exactly the old behavior (chat choice honored, bubble/loop `acceptEdits`, `Bash` in the cycle's deny list, the deny list riding along); a loop always gets the deny list but no `Bash` block when free; the bubble chat blocks only behind its toggle and the main chat never; stored values are cleaned. `loops.test.js` now asserts the cycle goes through the builder instead of hard-coding the mode.
