#!/usr/bin/env python3
"""The protocol tests for the two example extensions. Standard library only.

    python3 examples/extensions/mcp-python/tests/protocol_test.py
    python3 examples/extensions/mcp-python/tests/protocol_test.py -v

No network, no Loro, no `pip install`. Every assertion is against the literal
wire of the R5a contract (§4.2/§4.3) or against a file on disk.

Deliberately NOT wired into `make test` in this round: `test-js` is
`node --test tests/*.test.js` and `test-rust` is `cargo test`, so adding a Python
step is a Makefile change, and the Makefile belongs to the integrator.

`TestHotspotsBoard` asserts things about the *sibling* example. It lives here
because `hotspots-board` is the zero-code proof: a test file inside that folder
would make it carry code.
"""

import json
import os
import queue
import subprocess
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PACOTE = os.path.dirname(HERE)
EXAMPLES = os.path.dirname(PACOTE)
BOARD = os.path.join(EXAMPLES, "hotspots-board")
REPO = os.path.dirname(os.path.dirname(EXAMPLES))

PROTOCOL_VERSION = "2025-06-18"
FOUR = ["loro/describe", "loro/view", "loro/action", "loro/settings"]

# ---------------------------------------------------------------------------
# the closed alphabet of the view contract (§1.1-§1.5), copied literally so a
# drift in either direction is a red test rather than a screen that guesses
# ---------------------------------------------------------------------------

LAYOUT = {"stack", "row", "grid", "scroll"}
LEAVES = {"text", "badge", "field", "button", "link", "doc", "divider", "spacer", "icon"}
BINDINGS = {"each", "when", "use"}
KINDS = LAYOUT | LEAVES | BINDINGS
TONES = {"ink", "ink2", "ink3", "muted", "teal", "amber", "red", "green", "accent"}
STEPS = {0, 2, 4, 6, 8, 10, 12, 14}
SIZES = {"title", "body", "label", "meta"}
ALIGNS = {"start", "center", "end", "between"}
FAMILIES = {"sans", "mono"}
# the 14 names measured in desktop/src/app.js `ICONS`
ICONS = {
    "folder", "context", "guide", "history", "idea", "ref", "meeting", "note",
    "file", "archive", "loop", "skill", "builtinskill", "customskill",
}
FACTS = {"acervo.hotspots", "acervo.contexts", "acervo.orphans", "acervo.broken"}


def lint_view(doc):
    """A shallow lint of a view document against the closed alphabet.

    This is NOT `LoroExtView.validate` (batch C owns that, in
    `desktop/src/extview.js`) — it is the subset that can be checked with no
    Node and no DOM, so this file stands alone. `test_view_passes_the_renderer`
    runs the real validator whenever `extview.js` is on disk.
    """
    problems = []

    def i18n(value, where):
        if isinstance(value, dict) and "$" in value:
            return  # a Ref resolves to data, which is not translated
        if not isinstance(value, dict) or not value.get("pt") or not value.get("en"):
            problems.append(f"err.ext_i18n_missing:{where}")

    def node(n, where):
        if not isinstance(n, dict):
            problems.append(f"err.ext_view_node:{where}")
            return
        kind = n.get("kind")
        if kind not in KINDS:
            problems.append(f"err.ext_view_node:{kind}")
            return
        if "tone" in n and n["tone"] not in TONES:
            problems.append(f"err.ext_view_value:tone@{where}")
        for step in ("gap", "pad", "size"):
            if kind in LAYOUT and step in n and n[step] not in STEPS:
                problems.append(f"err.ext_view_value:{step}@{where}")
        if kind == "spacer" and n.get("size") not in STEPS:
            problems.append(f"err.ext_view_value:spacer.size@{where}")
        if kind == "text" and n.get("size") is not None and n["size"] not in SIZES:
            problems.append(f"err.ext_view_value:text.size@{where}")
        if "align" in n and n["align"] not in ALIGNS:
            problems.append(f"err.ext_view_value:align@{where}")
        if "family" in n and n["family"] not in FAMILIES:
            problems.append(f"err.ext_view_value:family@{where}")
        if kind == "grid" and n.get("cols") not in {2, 3, 4, 5, 6}:
            problems.append(f"err.ext_view_value:grid.cols@{where}")
        if kind == "icon" and n.get("name") not in ICONS:
            problems.append(f"err.ext_view_value:icon.name@{where}")
        if kind in ("text", "badge"):
            i18n(n.get("text"), f"{where}/text")
        if kind in ("button", "link"):
            i18n(n.get("label"), f"{where}/label")
        if kind == "field":
            i18n(n.get("label"), f"{where}/label")
        if kind == "doc":
            i18n(n.get("md"), f"{where}/md")
        if kind == "link":
            rel = n.get("rel")
            if isinstance(rel, str) and ("://" in rel or rel.startswith("/") or ".." in rel):
                problems.append(f"err.ext_view_value:link.rel@{where}")
        if kind == "each":
            if n.get("of") not in FACTS:
                problems.append(f"err.ext_view_facts:{n.get('of')}")
            if not n.get("as"):
                problems.append(f"err.ext_view_value:each.as@{where}")
            cap = n.get("cap", 200)
            if not isinstance(cap, int) or not 1 <= cap <= 200:
                problems.append(f"err.ext_view_value:each.cap@{where}")
            node(n.get("body"), f"{where}/body")
        if kind == "when":
            ops = [k for k in ("is", "exists", "gt") if k in n]
            if len(ops) != 1:
                problems.append(f"err.ext_view_value:when@{where}")
            for i, child in enumerate(n.get("then") or []):
                node(child, f"{where}/then/{i}")
            for i, child in enumerate(n.get("else") or []):
                node(child, f"{where}/else/{i}")
        for i, child in enumerate(n.get("children") or []):
            node(child, f"{where}/children/{i}")

    if doc.get("loroView") != 1:
        problems.append(f"err.ext_view_version:{doc.get('loroView')}")
    if not doc.get("view"):
        problems.append("err.ext_view_empty")
    for name, comp in (doc.get("components") or {}).items():
        node(comp.get("body"), f"/components/{name}/body")
    for i, n in enumerate(doc.get("view") or []):
        node(n, f"/view/{i}")
    return problems


# ---------------------------------------------------------------------------
# the client — a reader thread, a pending map keyed by id, stderr drained from
# the moment of spawn (contract §4.1's three non-negotiables, in miniature)
# ---------------------------------------------------------------------------


class Client:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join("server", "main.py")],
            cwd=PACOTE,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.next_id = 0
        self.replies = {}
        self.notifications = queue.Queue()
        self.unparseable = 0
        self.stderr_lines = []
        self._lock = threading.Lock()
        self._event = threading.Condition(self._lock)
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.unparseable += 1
                continue
            if "id" in msg and msg["id"] is not None:
                with self._event:
                    self.replies[msg["id"]] = msg
                    self._event.notify_all()
            else:
                self.notifications.put(msg)

    def _read_stderr(self):
        # Drained from spawn, not on stop: a full pipe buffer blocks the child's
        # next write, it stops producing stdout, and EOF never arrives.
        for line in self.proc.stderr:
            self.stderr_lines.append(line.rstrip("\n"))

    def send_raw(self, text):
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    def send(self, obj):
        self.send_raw(json.dumps(obj, ensure_ascii=False) + "\n")

    def request_id(self, method, params=None):
        self.next_id += 1
        rid = self.next_id
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        return rid

    def await_reply(self, rid, timeout=5.0):
        with self._event:
            if not self._event.wait_for(lambda: rid in self.replies, timeout=timeout):
                raise AssertionError(f"no reply for id {rid} within {timeout}s")
            return self.replies.pop(rid)

    def request(self, method, params=None, timeout=5.0):
        return self.await_reply(self.request_id(method, params), timeout)

    def call(self, name, arguments=None, timeout=5.0):
        return self.request("tools/call", {"name": name, "arguments": arguments or {}}, timeout)

    def payload(self, name, arguments=None):
        result = self.call(name, arguments).get("result", {})
        content = result.get("content") or []
        assert content and content[0].get("type") == "text", f"err.ext_bad_payload:{name}"
        return json.loads(content[0]["text"]), result

    def handshake(self):
        result = self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "protocol_test", "version": "0.1.0"},
            },
        ).get("result", {})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return result

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        for pipe in (self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except Exception:
                pass


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.addCleanup(self.client.close)


# ---------------------------------------------------------------------------


class TestHandshake(ServerCase):
    def test_initialize_echoes_the_protocol_version(self):
        """Red by changing the server's version string — that is the contract
        drift E6 names, and the host refuses with err.ext_protocol_unsupported."""
        result = self.client.handshake()
        self.assertEqual(result.get("protocolVersion"), PROTOCOL_VERSION)
        self.assertIn("tools", result.get("capabilities", {}))

    def test_server_info_name_matches_the_manifest(self):
        """A manifest is an assertion; the process is the fact. A mismatch is
        err.ext_server_mismatch:<theirs> (§4.2 check 3)."""
        with open(os.path.join(PACOTE, "loro.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
        result = self.client.handshake()
        self.assertEqual(result["serverInfo"]["name"], manifest["program"]["server"])

    def test_initialized_notification_gets_no_reply(self):
        self.client.handshake()  # sends notifications/initialized
        rid = self.client.request_id("tools/list")
        reply = self.client.await_reply(rid)
        self.assertEqual(reply["id"], rid)
        self.assertIn("tools", reply["result"])

    def test_two_requests_are_matched_by_their_own_ids(self):
        """Red by keying the pending map on arrival order: the results swap."""
        self.client.handshake()
        a = self.client.request_id("tools/call", {"name": "loro/describe", "arguments": {}})
        b = self.client.request_id("tools/call", {"name": "contar_pontos", "arguments": {}})
        first = self.client.await_reply(b)
        second = self.client.await_reply(a)
        self.assertEqual(first["id"], b)
        self.assertEqual(second["id"], a)
        self.assertIn("points", json.loads(second["result"]["content"][0]["text"]))

    def test_an_unparseable_line_does_not_bring_the_reader_down(self):
        self.client.handshake()
        self.client.send_raw("not json\n")
        self.client.send_raw("[1,2,3]\n")  # valid JSON, not an object
        reply = self.client.request("tools/list")
        self.assertIn("tools", reply["result"])

    def test_an_unknown_method_is_a_named_rpc_error(self):
        self.client.handshake()
        reply = self.client.request("loro/exec", {})
        self.assertIn("error", reply, "an unknown method must not answer a result")
        self.assertEqual(reply["error"]["code"], -32601)


class TestReservedNamespace(ServerCase):
    def test_no_loro_name_outside_the_four(self):
        """Red by adding `loro/exec` to tools_list: the host would refuse the
        whole extension with err.ext_reserved_name:<name> (§4.2 check 4)."""
        self.client.handshake()
        names = [t["name"] for t in self.client.request("tools/list")["result"]["tools"]]
        for name in FOUR:
            self.assertIn(name, names)
        squatted = [n for n in names if n.startswith("loro/") and n not in FOUR]
        self.assertEqual(squatted, [], f"reserved names squatted: {squatted}")

    def test_the_server_also_has_a_tool_of_its_own(self):
        self.client.handshake()
        names = [t["name"] for t in self.client.request("tools/list")["result"]["tools"]]
        own = [n for n in names if not n.startswith("loro/")]
        self.assertTrue(own, "a server with no tool of its own is useful to no agent")


class TestTheFourCalls(ServerCase):
    def test_describe_names_the_points_it_implements(self):
        self.client.handshake()
        payload, _ = self.client.payload("loro/describe", {"lang": "pt", "loroVersion": "0.13.1"})
        self.assertEqual(payload["points"], {"surface": 1})
        self.assertTrue(payload["name"])
        self.assertTrue(payload["version"])

    def test_settings_are_accepted_and_never_echoed(self):
        self.client.handshake()
        payload, _ = self.client.payload("loro/settings", {"values": {"limite": 7}})
        self.assertEqual(payload, {"ok": True})
        view, _ = self.client.payload("loro/view", {"lang": "pt"})
        cap = [n for n in view["view"] if n["kind"] == "when"][0]["then"][0]["children"][0]["cap"]
        self.assertEqual(cap, 7, "the setting the person chose must reach the view")
        self.assertFalse(
            [line for line in self.client.stderr_lines if "7" in line and "limite" in line],
            "BR-8/BR-9: a settings value must never reach a log line",
        )

    def test_an_action_reports_an_outcome_from_the_loops_vocabulary(self):
        self.client.handshake()
        payload, _ = self.client.payload("loro/action", {"action": "recontar", "values": {"limite": 12}, "lang": "pt"})
        self.assertIn(payload["outcome"], ("ok", "nothing", "failed"))
        self.assertEqual(payload["outcome"], "ok")
        self.assertTrue(payload["message"]["pt"] and payload["message"]["en"])
        self.assertIs(payload["invalidate"], True)

    def test_a_value_from_outside_is_clamped_not_trusted(self):
        self.client.handshake()
        self.client.payload("loro/action", {"action": "recontar", "values": {"limite": 9999}, "lang": "pt"})
        view, _ = self.client.payload("loro/view", {"lang": "pt"})
        cap = [n for n in view["view"] if n["kind"] == "when"][0]["then"][0]["children"][0]["cap"]
        self.assertEqual(cap, 200, "each.cap is 1..=200; a bigger number is input, not a setting")

    def test_an_action_nobody_declared_fails_by_name(self):
        """Red by returning outcome ok for anything: a control that reports
        success it did not perform is a state that lies."""
        self.client.handshake()
        payload, _ = self.client.payload("loro/action", {"action": "arrastar-cartao", "values": {}, "lang": "pt"})
        self.assertEqual(payload["outcome"], "failed")
        self.assertIs(payload["invalidate"], False)

    def test_the_one_message_the_extension_may_push(self):
        """`loro/view_invalidated` is the only extension->host method in R5a
        (§4.4). Red by pushing `loro/propose_outbound` instead: the host refuses
        it by name and drops it."""
        self.client.handshake()
        payload, _ = self.client.payload("loro/action", {"action": "marcar-visto", "values": {}, "lang": "pt"})
        self.assertEqual(payload["outcome"], "ok")
        note = self.client.notifications.get(timeout=5)
        self.assertEqual(note["method"], "loro/view_invalidated")
        self.assertNotIn("id", note, "a notification carries no id and expects no reply")


class TestViewDocument(ServerCase):
    def setUp(self):
        super().setUp()
        self.client.handshake()
        self.view, self.raw = self.client.payload("loro/view", {"lang": "pt"})

    def test_the_reply_is_a_text_content_block(self):
        self.assertIs(self.raw["isError"], False)
        self.assertEqual(self.raw["content"][0]["type"], "text")

    def test_the_view_is_a_valid_document(self):
        """Red by emitting `{"kind":"rows"}` — the widget vocabulary ADR-0031 §3
        revoked — or a tone outside the nine."""
        self.assertEqual(self.view["loroView"], 1)
        self.assertEqual(lint_view(self.view), [])

    def test_it_carries_no_css_no_url_and_no_hex(self):
        text = json.dumps(self.view, ensure_ascii=False)
        for forbidden in ("://", "style", "tabindex", "#ff", "px\"", "<script"):
            self.assertNotIn(forbidden, text, f"the served view must carry no {forbidden!r}")

    def test_every_control_can_act_on_something(self):
        buttons = []

        def walk(n):
            if isinstance(n, dict):
                if n.get("kind") == "button":
                    buttons.append(n)
                for v in n.values():
                    walk(v)
            elif isinstance(n, list):
                for v in n:
                    walk(v)

        walk(self.view["view"])
        self.assertTrue(buttons, "a served surface with no action proves nothing")
        for b in buttons:
            self.assertTrue(b.get("action"), "a button with no action is a control that does nothing")
            self.assertTrue(b["label"]["pt"] and b["label"]["en"])

    def test_view_passes_the_renderer_when_it_exists(self):
        extview = os.path.join(REPO, "desktop", "src", "extview.js")
        if not os.path.isfile(extview):
            self.skipTest(f"batch C has not landed yet: {extview} does not exist")
        script = (
            "const V=require(process.argv[1]);"
            "const doc=JSON.parse(process.argv[2]);"
            "const r=V.validate(doc);"
            "if(!r.ok){console.error(JSON.stringify(r.errors));process.exit(1);}"
        )
        proc = subprocess.run(
            ["node", "-e", script, extview, json.dumps(self.view, ensure_ascii=False)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)


class TestOutsideTheApp(unittest.TestCase):
    def test_the_same_server_runs_with_no_loro_anywhere(self):
        """Red by coupling the server to a Loro-only environment variable: the
        owner's thesis (the extension is indifferent to being inside or outside
        the app) stops being true."""
        env = {k: v for k, v in os.environ.items() if not k.startswith("LORO")}
        proc = subprocess.run(
            [sys.executable, os.path.join(PACOTE, "agent", "consume.py")],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("contar_pontos:", proc.stdout)
        self.assertIn("loroView=1", proc.stdout)

    def test_the_example_needs_no_third_party_package(self):
        """The product's floor is offline: an example that needs `pip install`
        works only where the network does."""
        allowed = {"json", "os", "queue", "subprocess", "sys", "threading", "time", "unittest"}
        for rel in ("server/main.py", "agent/consume.py", "tests/protocol_test.py"):
            with open(os.path.join(PACOTE, rel), encoding="utf-8") as fh:
                src = fh.read()
            imports = set()
            for line in src.splitlines():
                line = line.strip()
                if line.startswith("import "):
                    imports.add(line[len("import ") :].split(".")[0].split(" ")[0])
                elif line.startswith("from "):
                    imports.add(line[len("from ") :].split(".")[0].split(" ")[0])
            self.assertTrue(imports <= allowed, f"{rel} imports outside the stdlib subset: {imports - allowed}")

    def test_no_network_module_is_reachable_from_the_server(self):
        """BR-1's absolute half is held by ABSENCE of an API. A process that
        never imports a socket cannot send audio, a transcript, or anything."""
        with open(os.path.join(PACOTE, "server", "main.py"), encoding="utf-8") as fh:
            src = fh.read()
        for line in src.splitlines():
            stripped = line.strip()
            if stripped.startswith(("import ", "from ")):
                for banned in ("socket", "http", "urllib", "ssl", "ftplib", "smtplib", "requests"):
                    self.assertNotIn(banned, stripped, f"a network import reached the server: {stripped}")


class TestHotspotsBoard(unittest.TestCase):
    """The sibling example: level 1, zero code. Its tests live here so that
    folder can stay free of code."""

    # measured: plugins.rs:36 EXECUTABLE_MARKERS
    MARKERS = ("hooks/", ".mcp.json", ".lsp.json", "monitors/", "bin/", "settings.json", "agents/")

    def setUp(self):
        with open(os.path.join(BOARD, "loro.json"), encoding="utf-8") as fh:
            self.manifest = json.load(fh)

    def test_it_declares_no_program(self):
        """Red by adding a `program` key: it stops being the zero-code proof and
        the install sheet gains a trust sentence it does not need."""
        self.assertNotIn("program", self.manifest)
        self.assertEqual(self.manifest["loro"], 2)
        self.assertEqual(self.manifest["points"], {"surface": 1})
        self.assertNotIn("view", self.manifest["surface"], "view + viewFile is err.ext_surface_ambiguous")
        self.assertIs(self.manifest["surface"]["served"], False)

    def test_the_folder_carries_no_executable_file(self):
        for root, _dirs, files in os.walk(BOARD):
            for name in files:
                path = os.path.join(root, name)
                rel = os.path.relpath(path, BOARD).replace(os.sep, "/")
                self.assertFalse(os.access(path, os.X_OK), f"{rel} is executable")
                self.assertFalse(
                    rel.endswith((".py", ".sh", ".js", ".rb", ".exe")), f"{rel} is a script"
                )
                for marker in self.MARKERS:
                    if marker.endswith("/"):
                        self.assertFalse(rel.startswith(marker), f"{rel} hits the executable marker {marker}")
                    else:
                        self.assertNotEqual(rel, marker, f"{rel} is the executable marker {marker}")

    def test_the_board_is_a_valid_view_document(self):
        view_file = self.manifest["surface"]["viewFile"]
        self.assertFalse(view_file.startswith("/") or ".." in view_file, "err.ext_path_escape")
        with open(os.path.join(BOARD, view_file), encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(lint_view(doc), [])

    def test_the_board_says_the_columns_are_computed(self):
        """The first thing a person does with a kanban is drag a card. Here a
        card is a line in a versioned document, so the copy has to say it —
        red by deleting the sentence."""
        with open(os.path.join(BOARD, self.manifest["surface"]["viewFile"]), encoding="utf-8") as fh:
            doc = json.load(fh)
        text = json.dumps(doc, ensure_ascii=False)
        self.assertIn("arrasta", text, "the pt copy must say nothing is dragged")
        self.assertIn("dragged", text, "the en copy must say nothing is dragged")
        self.assertIn("revisão do time", text, "and it must say what to do instead")

    def test_a_nested_each_reads_the_outer_row(self):
        """The kanban is impossible without `as`: the inner `each` filters on
        `col.context`, a row of the OUTER one."""
        with open(os.path.join(BOARD, self.manifest["surface"]["viewFile"]), encoding="utf-8") as fh:
            doc = json.load(fh)
        inner = doc["components"]["column"]["body"]["children"][2]["children"][0]
        self.assertEqual(inner["kind"], "each")
        self.assertEqual(inner["where"], {"context": {"eq": {"$": "col.context"}}})
        outer = doc["view"][1]["then"][1]["children"][0]["children"][0]
        self.assertEqual(outer["as"], "col")

    def test_the_habilidades_it_brings_are_declared(self):
        """`commands/<name>.md` lands as `.claude/commands/<name>.md` (measured,
        plugins.rs:309-330), so `kinds` has to say `skills` out loud."""
        self.assertIn("skills", self.manifest["kinds"])
        self.assertIn("surface", self.manifest["kinds"])
        cmds = sorted(f for f in os.listdir(os.path.join(BOARD, "commands")) if f.endswith(".md"))
        self.assertTrue(cmds)
        for name in cmds:
            stem = name[:-3]
            self.assertNotIn(".", stem, "a dot is not a valid Claude Code command name")
            with open(os.path.join(BOARD, "commands", name), encoding="utf-8") as fh:
                body = fh.read()
            self.assertTrue(body.startswith("---\n"), f"{name} has no frontmatter")
            self.assertIn("description:", body.split("---")[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
