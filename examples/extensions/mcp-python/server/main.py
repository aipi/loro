#!/usr/bin/env python3
"""An MCP server for Loro, over stdio, in the Python standard library only.

It answers the four `loro/*` calls of the R5a contract (§4.3) plus one ordinary
tool (`contar_pontos`), so the same process is useful to Loro AND to any agent
that speaks MCP. `agent/consume.py` drives this file with no Loro anywhere.

Three properties are deliberate, and each one is a guarantee rather than a style:

* **Standard library only.** No `pip install`, nothing vendored. The product's
  floor is offline, and an example that needs a package to start is an example
  that only works where the network does.
* **No network module is imported at all** (no `socket`, `http`, `urllib`,
  `ssl`). BR-1's absolute half is held by absence of an API, not by a promise:
  a process that cannot open a socket cannot send audio anywhere. Grep this file
  for `import` and the list is `json`, `sys`, `time`.
* **It reads no file from the acervo.** Facts about the project are computed by
  the host and handed to the renderer with the view (contract §2). This server
  therefore serves a view over *its own* state, and lets `each`/`when` read the
  host's facts — which is exactly the split the contract draws.

Logging (stderr): method name, tool name, duration, byte counts. Never an
argument, never a payload, never a settings value (BR-8, BR-9). The host drains
this pipe from the moment of spawn and keeps the last 4000 bytes as a ring.
"""

import json
import sys
import time

PROTOCOL_VERSION = "2025-06-18"  # contract §4.2 — must match the host's constant
SERVER_NAME = "pontos-python"  # must equal loro.json -> program.server (§4.2 check 3)
SERVER_VERSION = "0.1.0"

# The only `loro/*` names R5a allows a server to expose. Anything else in
# `tools/list` makes the host refuse the whole extension by name
# (`err.ext_reserved_name:<name>`), because the prefix is Loro's.
LORO_TOOLS = ("loro/describe", "loro/view", "loro/action", "loro/settings")

# `each.cap` is 1..=200 in the contract (§1.4); the setting is clamped to it
# instead of being trusted, because a value that arrives from outside is input.
CAP_MIN, CAP_MAX = 1, 200

# Everything this process knows. It is its own state, not the project's: the
# project's facts belong to the host (§2), and a second copy of them here would
# be a second answer to the same question.
STATE = {"limite": 5, "vistos": 0}


# ---------------------------------------------------------------------------
# the wire (§4.1) — one JSON object per line, `\n`-terminated, UTF-8
# ---------------------------------------------------------------------------


def send(obj):
    """One object, one line, flushed. A buffered reply is a reply that never
    arrives: the host is blocked on `recv_timeout` and would fail with
    `err.ext_timeout:<method>` while this process sat on a full buffer."""
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    return len(line)


def log(**fields):
    parts = " ".join(f"{k}={v}" for k, v in fields.items() if v != "")
    sys.stderr.write(f"[{SERVER_NAME}] {parts}\n")
    sys.stderr.flush()


def reply(rid, result):
    return send({"jsonrpc": "2.0", "id": rid, "result": result})


def rpc_error(rid, code, message):
    # The host maps this to `err.ext_rpc:<code>` and shows its own copy — the
    # message here is for a human reading stderr or a log, never for the screen.
    return send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


# Notifications this process still owes the host. They are queued and flushed
# AFTER the reply of the call that produced them: putting a notification on the
# wire first would make the host re-ask for the view while the action it is
# waiting on is still pending, and the reply it is blocked on would arrive second.
PENDING_NOTIFY = []


def notify_later(method, params=None):
    PENDING_NOTIFY.append((method, params or {}))


def flush_notifications():
    while PENDING_NOTIFY:
        method, params = PENDING_NOTIFY.pop(0)
        send({"jsonrpc": "2.0", "method": method, "params": params})
        log(method=method, kind="notification")


def tool_result(payload, is_error=False):
    """An MCP tool result: the Loro payload travels as JSON inside the first
    text content block (§4.3). `content[0].type` must be `text` or the host
    refuses with `err.ext_bad_payload:<method>`."""
    text = json.dumps(payload, ensure_ascii=False)
    return {"isError": is_error, "content": [{"type": "text", "text": text}]}


# ---------------------------------------------------------------------------
# the view this process serves (§1) — closed alphabet, pt/en pairs, no CSS
# ---------------------------------------------------------------------------


def i18n(pt, en):
    """Both halves, always. A missing half is `err.ext_i18n_missing:<pointer>`:
    the person chose a language and an extension is not an exception to it."""
    return {"pt": pt, "en": en}


def view_document():
    """The served half of the contract, built from STATE.

    Note what is NOT possible here, and it is a property of the design rather
    than a limitation of this file: a `Ref` (`{"$": …}`) reads the HOST's facts
    or an enclosing `each` row — never this process's variables. So a number
    this server owns (`vistos`, `limite`) reaches the screen as a literal pt/en
    pair that the server writes on both halves. The extension's own data is the
    extension's claim, and the renderer wraps the whole surface in an
    attribution line so it never reads as Loro's (§1.6).
    """
    limite = clamp_cap(STATE["limite"])
    vistos = STATE["vistos"]
    return {
        "loroView": 1,
        "components": {
            "linha": {
                "params": ["id", "rel"],
                "body": {
                    "kind": "row",
                    "gap": 6,
                    "align": "between",
                    "children": [
                        {"kind": "icon", "name": "idea", "tone": "ink3"},
                        {"kind": "text", "text": {"$": "param.id"}, "size": "body", "family": "mono", "wrap": False},
                        {"kind": "link", "label": i18n("abrir", "open"), "rel": {"$": "param.rel"}},
                    ],
                },
            }
        },
        "view": [
            {"kind": "text", "size": "title", "text": i18n("Pontos em aberto, por um processo", "Open points, from a process")},
            {
                "kind": "text",
                "size": "meta",
                "tone": "muted",
                "text": i18n(
                    "esta tela é servida por um programa Python que roda nesta máquina e responde por stdio; "
                    "os pontos vêm do conhecimento deste projeto, lidos pelo Loro, não pelo programa.",
                    "this screen is served by a Python program running on this machine, answering over stdio; "
                    "the points come from this project's knowledge, read by Loro, not by the program.",
                ),
            },
            {
                "kind": "row",
                "gap": 6,
                "wrap": True,
                "children": [
                    {"kind": "badge", "text": i18n("servido por processo", "served by a process"), "tone": "teal"},
                    {"kind": "badge", "text": i18n(f"aberto {vistos}x", f"opened {vistos}x"), "tone": "muted"},
                ],
            },
            {"kind": "divider"},
            {
                "kind": "field",
                "id": "limite",
                "field": "number",
                "label": i18n("pontos por coluna", "points per column"),
                "value": limite,
                "hint": i18n("de 1 a 200; o resto é contado, nunca cortado em silêncio", "1 to 200; the remainder is counted, never dropped in silence"),
            },
            {
                "kind": "row",
                "gap": 6,
                "children": [
                    {
                        "kind": "button",
                        "action": "recontar",
                        "label": i18n("aplicar o limite", "apply the limit"),
                        "primary": True,
                        "values": ["limite"],
                    },
                    {"kind": "button", "action": "marcar-visto", "label": i18n("marcar como visto", "mark as seen")},
                ],
            },
            {
                "kind": "when",
                "value": {"$": "facts.acervo.hotspots.count"},
                "gt": 0,
                "then": [
                    {
                        "kind": "scroll",
                        "max": "md",
                        "children": [
                            {
                                "kind": "each",
                                "of": "acervo.hotspots",
                                "as": "hs",
                                "cap": limite,
                                "body": {
                                    "kind": "use",
                                    "component": "linha",
                                    "args": {"id": {"$": "hs.id"}, "rel": {"$": "hs.rel"}},
                                },
                            }
                        ],
                    }
                ],
                "else": [
                    {
                        "kind": "text",
                        "tone": "muted",
                        "text": i18n(
                            "nenhum ponto em aberto no conhecimento deste projeto",
                            "no open points in this project's knowledge",
                        ),
                    }
                ],
            },
            {
                "kind": "doc",
                "cap": 40,
                "md": i18n(
                    "**O mesmo processo, fora do app.** `agent/consume.py` fala com este "
                    "servidor por stdio, sem o Loro no meio, e chama `contar_pontos`.",
                    "**The same process, outside the app.** `agent/consume.py` talks to this "
                    "server over stdio, with no Loro in between, and calls `contar_pontos`.",
                ),
            },
        ],
    }


def clamp_cap(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return STATE["limite"]
    return max(CAP_MIN, min(CAP_MAX, n))


# ---------------------------------------------------------------------------
# the tools
# ---------------------------------------------------------------------------


def tools_list():
    return [
        {
            "name": "loro/describe",
            "description": "Who this extension is and which points it implements.",
            "inputSchema": {"type": "object"},
        },
        {
            "name": "loro/view",
            "description": "The view document Loro renders (contract §1).",
            "inputSchema": {"type": "object"},
        },
        {
            "name": "loro/action",
            "description": "A click on one of the view's buttons.",
            "inputSchema": {"type": "object"},
        },
        {
            "name": "loro/settings",
            "description": "The values the person set in Configuracoes.",
            "inputSchema": {"type": "object"},
        },
        # An ordinary tool: no `loro/` prefix, so it is the extension's own and
        # any MCP client may call it. This is the half `agent/consume.py` uses.
        {
            "name": "contar_pontos",
            "description": "How many points this server would list, and the current limit.",
            "inputSchema": {"type": "object"},
        },
    ]


def call_describe(_args):
    return tool_result({"name": SERVER_NAME, "version": SERVER_VERSION, "points": {"surface": 1}})


def call_view(_args):
    return tool_result(view_document())


def call_action(args):
    action = args.get("action", "")
    values = args.get("values", {}) or {}
    if action == "recontar":
        # The typed value is INPUT, not a setting: it is clamped, and the reply
        # says what actually happened rather than what was asked for.
        before = STATE["limite"]
        STATE["limite"] = clamp_cap(values.get("limite", before))
        n = STATE["limite"]
        return tool_result(
            {
                "outcome": "ok" if n != before else "nothing",
                "message": i18n(f"agora lista até {n} pontos por coluna", f"now lists up to {n} points per column"),
                "invalidate": n != before,
            }
        )
    if action == "marcar-visto":
        STATE["vistos"] += 1
        # `invalidate:false` plus a push, on purpose: `loro/view_invalidated` is
        # the ONE message an extension may send the host in R5a (§4.4), and a
        # server that only ever answers `invalidate:true` never exercises it.
        # Both mechanisms mean the same thing here — the badge changed — so the
        # state on screen cannot disagree with the state in this process.
        notify_later("loro/view_invalidated", {})
        return tool_result(
            {
                "outcome": "ok",
                "message": i18n("marcado; a tela se atualiza sozinha", "marked; the screen refreshes itself"),
                "invalidate": False,
            }
        )
    # An action nobody declared is a failure with a name, never a silent no-op.
    return tool_result(
        {
            "outcome": "failed",
            "message": i18n("esta extensão não tem essa ação", "this extension has no such action"),
            "invalidate": False,
        }
    )


def call_settings(args):
    # Only declared ids are read, and no value is ever logged (BR-8/BR-9). The
    # schema in loro.json has no credential field — the host refuses one at
    # install with `err.ext_settings_secret:<field>`, so this process never has
    # to hold a secret and deliberately has no code that could.
    values = args.get("values", {}) or {}
    if "limite" in values:
        STATE["limite"] = clamp_cap(values["limite"])
    return tool_result({"ok": True})


def call_contar_pontos(_args):
    return tool_result({"pontos": STATE["vistos"], "limite": clamp_cap(STATE["limite"]), "servidor": SERVER_NAME})


TOOLS = {
    "loro/describe": call_describe,
    "loro/view": call_view,
    "loro/action": call_action,
    "loro/settings": call_settings,
    "contar_pontos": call_contar_pontos,
}


# ---------------------------------------------------------------------------
# the dispatcher
# ---------------------------------------------------------------------------


def handle(msg):
    method = msg.get("method", "")
    rid = msg.get("id")
    params = msg.get("params", {}) or {}
    started = time.monotonic()
    sent = 0

    if method == "initialize":
        sent = reply(
            rid,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )
    elif method == "notifications/initialized":
        # A notification: no id, no reply. Answering it would put an unmatched
        # object on the wire, and the host's reader drops what it cannot match.
        pass
    elif method == "tools/list":
        sent = reply(rid, {"tools": tools_list()})
    elif method == "tools/call":
        name = params.get("name", "")
        fn = TOOLS.get(name)
        if fn is None:
            sent = reply(
                rid,
                tool_result({"error": "unknown tool"}, is_error=True),
            )
        else:
            sent = reply(rid, fn(params.get("arguments", {}) or {}))
        log(method=method, tool=name, ms=int((time.monotonic() - started) * 1000), bytes=sent)
        flush_notifications()
        return
    elif rid is None:
        # An unknown NOTIFICATION is ignored on purpose (§4.1): a protocol
        # addition must not be able to bring this reader down.
        return
    else:
        sent = rpc_error(rid, -32601, "method not found")

    log(method=method, ms=int((time.monotonic() - started) * 1000), bytes=sent)


def main():
    log(event="ready", protocol=PROTOCOL_VERSION)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            # Not JSON: ignored, exactly as the host ignores what it cannot
            # parse. A reader that dies on one bad line is a reader that a
            # protocol change can kill.
            log(event="dropped_unparseable_line", bytes=len(line))
            continue
        if not isinstance(msg, dict):
            log(event="dropped_non_object")
            continue
        handle(msg)
    # stdin closed: the host dropped it as the graceful stop signal (§4.7).
    log(event="stdin_eof")
    return 0


if __name__ == "__main__":
    sys.exit(main())
