#!/usr/bin/env python3
"""The same server, driven from OUTSIDE Loro.

    python3 examples/extensions/mcp-python/agent/consume.py

No app, no window, no Tauri, no environment variable from Loro: this file spawns
`server/main.py`, does the handshake of contract §4.2, lists the tools and calls
one. If it prints a result, the extension was never a Loro plugin — it is an MCP
server that Loro happens to be one client of.

Standard library only, on purpose. An official MCP SDK would work against the
same process (it speaks the same newline-delimited JSON-RPC over stdio) and the
README says so, but requiring it would put a `pip install` between a person and
an example, and the product's floor is offline.

BR-9: this file asks for no credential, reads no token from the environment,
prints no secret, and has nowhere to store one. There is no host name in it and
no network module imported anywhere in this example.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PACOTE = os.path.dirname(HERE)  # the extension's root: the folder with loro.json
SERVER = os.path.join(PACOTE, "server", "main.py")

PROTOCOL_VERSION = "2025-06-18"


class Stdio:
    """One process, one line per message. The two rules that are not style:

    * stderr is drained into its own pipe and read only at the end here, but a
      long-lived client MUST drain it continuously: a full pipe buffer blocks
      the child's next write, it stops producing stdout, EOF never arrives and
      the call hangs forever. That is the lesson `chat.rs:562-576` paid for, and
      this file is short-lived enough to read stderr once, at the end.
    * every request carries its own `id`, and a reply is matched by it — never
      by arrival order.
    """

    def __init__(self, argv, cwd):
        self.proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.next_id = 0

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params=None):
        self.next_id += 1
        rid = self.next_id
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"the server closed stdout before answering {method}")
            try:
                msg = json.loads(line)
            except ValueError:
                continue  # not JSON: ignored, exactly as the host ignores it
            if msg.get("id") != rid:
                continue  # someone else's reply, or a notification
            if "error" in msg:
                raise RuntimeError(f"{method} answered error {msg['error'].get('code')}")
            return msg.get("result", {})

    def notify(self, method, params=None):
        self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def close(self):
        # Drop stdin first — the graceful stop signal. The server's read loop
        # sees EOF and exits on its own, so nothing has to be killed.
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        return self.proc.stderr.read()


def payload_of(result):
    """An MCP tool result carries the payload as JSON in the first text block."""
    content = result.get("content") or []
    if not content or content[0].get("type") != "text":
        raise RuntimeError("the tool result has no text content block")
    return json.loads(content[0]["text"])


def main():
    if not os.path.isfile(SERVER):
        print(f"server not found: {SERVER}", file=sys.stderr)
        return 1

    print("driving the extension's own MCP server, with no Loro in between")
    print(f"  spawn: {sys.executable} server/main.py   (cwd={PACOTE})")

    client = Stdio([sys.executable, os.path.join("server", "main.py")], cwd=PACOTE)
    try:
        info = client.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                # This client is not Loro and does not pretend to be: the name a
                # server sees is the name of whoever actually connected.
                "clientInfo": {"name": "consume.py", "version": "0.1.0"},
            },
        )
        client.notify("notifications/initialized")
        print(f"  initialize: protocol={info.get('protocolVersion')} server={info.get('serverInfo', {}).get('name')}")
        if info.get("protocolVersion") != PROTOCOL_VERSION:
            print("  refusing: the server answered another protocol version", file=sys.stderr)
            return 1

        names = [t.get("name") for t in client.request("tools/list").get("tools", [])]
        print(f"  tools/list: {', '.join(names)}")

        own = [n for n in names if not str(n).startswith("loro/")]
        if not own:
            print("  this server exposes no tool of its own", file=sys.stderr)
            return 1

        result = payload_of(client.request("tools/call", {"name": "contar_pontos", "arguments": {}}))
        print(f"  contar_pontos: {json.dumps(result, ensure_ascii=False, sort_keys=True)}")

        # The Loro-facing half answers the same client, and that is the whole
        # point: one process, two audiences, no branch inside it.
        view = payload_of(client.request("tools/call", {"name": "loro/view", "arguments": {"lang": "pt"}}))
        print(f"  loro/view: loroView={view.get('loroView')} nodes={len(view.get('view', []))}")
    finally:
        tail = client.close()

    if tail:
        print("  server stderr (method names and durations only, by BR-8):")
        for line in tail.strip().splitlines():
            print(f"    {line}")
    print("done — the extension is indifferent to being inside or outside Loro")
    return 0


if __name__ == "__main__":
    sys.exit(main())
