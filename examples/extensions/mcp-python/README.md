# mcp-python — the same extension, inside and outside the app

An MCP server over stdio, written in the **Python standard library only**, that
serves a Loro surface *and* answers any other MCP client. It is the checkable
form of one claim: **an extension is a process that speaks a protocol, not a
plugin that lives inside a program.**

```
mcp-python/
  .claude-plugin/plugin.json   name, version, author
  loro.json                    "loro": 2 · program (mcp/stdio) · surface.served · settings
  server/main.py               the MCP server: initialize · tools/list · tools/call
  agent/consume.py             the same server, driven with no Loro in between
  tests/protocol_test.py       the literal wire of §4.2/§4.3, plus the board next door
  README.md
```

## The two runs

### 1 · Outside the app — no Loro anywhere

```
python3 examples/extensions/mcp-python/agent/consume.py
```

Measured output on 2026-08-19 (Python 3.14.6, macOS):

```
driving the extension's own MCP server, with no Loro in between
  initialize: protocol=2025-06-18 server=pontos-python
  tools/list: loro/describe, loro/view, loro/action, loro/settings, contar_pontos
  contar_pontos: {"limite": 5, "pontos": 0, "servidor": "pontos-python"}
  loro/view: loroView=1 nodes=8
```

**What this proves:** the handshake, the tool list and the calls are the
protocol's, not the app's. `consume.py` is not Loro, does not claim to be
(`clientInfo.name` is `consume.py`), and passes no Loro environment variable —
the test `test_the_same_server_runs_with_no_loro_anywhere` strips every `LORO*`
variable before running it, so a server that quietly depended on one goes red.

### 2 · Inside the app — the served surface

Install from a local folder (Configurações → Extensões), pointing at **this
folder**, the one with `.claude-plugin/plugin.json` inside:

```
/path/to/loro/examples/extensions/mcp-python
```

Loro then: resolves `program.command` (`python3`) through its own lookup, spawns
`server/main.py`, does `initialize` → `notifications/initialized` →
`tools/list`, passes the current settings with `loro/settings`, calls
`loro/describe`, and only then reports the extension as *rodando*. The tab
`loro://ext/mcp-python` calls `loro/view` and renders what comes back with Loro's
own components, in the person's theme and language.

**What this proves:** the served half of the contract. The same `loro/view`
payload that `consume.py` printed is the one the app paints — one process, two
audiences, and no branch inside the server that asks *"am I inside Loro?"*.

## What the surface does, and what each control really does

| Control | What happens |
|---|---|
| *pontos por coluna* (`field limite`) | typed value; nothing happens until a button submits it |
| **aplicar o limite** (`action recontar`, primary) | sends the typed value, the server **clamps it to 1..200** and answers `outcome: ok` + `invalidate: true`, so Loro re-asks for the view. Asking for 9999 gets 200 and the screen says 200 — the state cannot lie about what was applied |
| *marcar como visto* (`action marcar-visto`) | bumps the server's own counter, answers `invalidate: false`, and then **pushes** `loro/view_invalidated` — the one message an extension may send the host in R5a (§4.4). A server that only ever answers `invalidate:true` never exercises that path |
| *abrir* (`link`) on a row | Loro opens the knowledge document in a reading tab. The `rel` comes from the **host's** facts, so it is a path Loro already vouched for |

An action nobody declared answers `outcome: "failed"` with a pt/en message —
never a silent no-op.

## The three properties that are guarantees, not style

- **Standard library only.** `server/main.py` imports `json`, `sys`, `time`;
  `agent/consume.py` imports `json`, `os`, `subprocess`, `sys`. No `pip install`,
  nothing vendored. The product's floor is offline, and an example that needs a
  package to start is an example that only works where the network does. A test
  asserts the import list.
- **No network module is imported at all** — no `socket`, `http`, `urllib`,
  `ssl`. BR-1's absolute half is held by the **absence of an API**, not by a
  promise: a process with no socket cannot send audio or a transcript anywhere,
  and `test_no_network_module_is_reachable_from_the_server` keeps it that way.
  There is no host name anywhere in this example, real or internal.
- **No credential, ever** (BR-9). Nothing is asked, nothing is read from the
  environment, nothing is printed, and the settings schema declares no field
  whose `kind` or `id` names a secret — the host would refuse the install with
  `err.ext_settings_secret:<field>` before writing a byte. The stderr log carries
  method name, tool name, duration and byte counts, never an argument and never a
  settings value (BR-8); a test asserts a settings value never reaches a log line.

## Where the facts come from, and why the server does not read the acervo

`server/main.py` opens **no file of the project**. Facts about the acervo —
open points, knowledge areas, orphans, broken links — are computed by Loro from
its own knowledge graph and handed to the renderer together with the view
(contract §2). So the served document uses `each`/`when` over
`acervo.hotspots` / `facts.acervo.hotspots.count` and Loro resolves them.

One consequence worth knowing before you write a served view: a `Ref`
(`{"$": …}`) reads the **host's** facts or an enclosing `each` row — never the
server's own variables. A number the server owns (its counter, its limit)
reaches the screen as a literal `pt`/`en` pair the server writes on both halves.
That is what the attribution line around the whole surface is for: the
extension's data renders as the *extension's claim*, never as Loro's.

## Running the tests

```
python3 examples/extensions/mcp-python/tests/protocol_test.py       # 28 tests
python3 examples/extensions/mcp-python/tests/protocol_test.py -v
```

Standard library `unittest`, no network, no Loro. It covers the literal
handshake, id correlation with two requests in flight, an unparseable line that
must not bring the reader down, an unknown method answering
`-32601`, the reserved `loro/*` namespace, the four calls, the pushed
notification, the view against the closed alphabet — and, whenever
`desktop/src/extview.js` is on disk, the view against the **real** renderer
(`LoroExtView.validate`), skipping with a named reason when it is not.

It also carries `TestHotspotsBoard`, which asserts things about the sibling
example (`../hotspots-board`): no `program`, no executable file, a valid view
document, and the copy that says the columns are computed. Those tests live here
because that example's whole point is being **zero code** — a test file inside it
would break the claim.

Not wired into `make test` in this round: `test-js` is
`node --test tests/*.test.js` and `test-rust` is `cargo test`, so adding a Python
step is a Makefile change, and the Makefile belongs to the integrator.

## Two things this manifest had to decide, and one of them is a question

- **`command` is a name, not a path.** `"command": "python3"` — a value with `/`
  or `\` is refused (`err.ext_program_path:<value>`), and the name is resolved
  through Loro's own lookup, the same one a probe uses (ADR-0030). On Windows
  that lookup also tries `python3.exe`; whether the machine has it is the
  machine's business, and the failure is named (`err.ext_program_missing:python3`)
  rather than silent.
- **`cwd` is omitted on purpose.** `args` is `["server/main.py"]`, a relative
  path token, and this manifest reads it as relative to the pacote's installed
  root. The contract's own example in §3.1 shows `args: ["server/main.py"]`
  together with `cwd: "server"`, and those two cannot both be right — with that
  cwd the token resolves to `server/server/main.py`. **This is a contract
  question for the integrator**, not something an example should settle by
  guessing: R5a does not state the spawn cwd when `cwd` is absent. The server
  itself is immune either way — it reads no file, so nothing but argv resolution
  depends on the answer.
