// ADR-0043 — the chat speaks the terminal's language: «/» lists the agent's own
// commands, a terminal-only command goes to the terminal, and what the agent asks
// mid-turn (options, permissions) is answered by the person.
//
// The pure module runs for real; the wiring in app.js / bubble.js / lib.rs is
// checked in the SOURCE (there is no DOM under node --test, see state-truth).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const AA = require("../src/agentask.js");
const FZ = require("../src/fuzzy.js");

const SRC = path.join(__dirname, "..", "src");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const APP = read("app.js");
const BUBBLE = read("bubble.js");
const INDEX = read("index.html");
const LIB = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");

// The shape `agent_commands` returns (captured names from the CLI's initialize).
const CMDS = [
  { name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" },
  { name: "context", description: "Context usage", argumentHint: "" },
  { name: "loro-ask", description: "Pergunta ao acervo", argumentHint: "" },
  { name: "turbi-design:torque", description: "Torque 2", argumentHint: "" },
];

test("ADR-0043 — a command the CLI listed runs in the chat; one it did not, in the terminal", () => {
  const k = (x) => AA.classify(x, CMDS).kind;
  assert.deepStrictEqual(AA.classify("/compact keep the decisions", CMDS), { kind: "command", name: "compact", arg: "keep the decisions" });
  assert.strictEqual(k("/context"), "command");
  assert.strictEqual(k("/turbi-design:torque botão"), "command");
  // /login is not in the print-mode list (measured 2026-11-23): only the terminal has it
  assert.strictEqual(k("/login"), "terminal");
  assert.strictEqual(k("qual o prazo?"), "chat");
  assert.strictEqual(k("a/b não é comando"), "chat");
  assert.strictEqual(k("/"), "chat", "a bare slash is text");
});

test("ADR-0043 — with no list yet, a «/x» stays in the chat: the CLI decides, never our guess", () => {
  assert.strictEqual(AA.classify("/login", []).kind, "command");
  assert.strictEqual(AA.classify("/login", undefined).kind, "command");
});

// owner, 2026-11-23: «o /model também não está abrindo o terminal… faz sentido
// comandos interativos abrir o terminal». Measured in the chat's own mode: bare
// /config, /advisor print only «Usage:»; /mcp says «use /mcp in the terminal»;
// /fast and /focus are unavailable there at all.
test("ADR-0043 — an interactive command goes to the terminal when it would open a picker there", () => {
  const listed = CMDS.concat(["config", "mcp", "advisor", "output-style", "color", "fast", "focus"].map((name) => ({ name })));
  const k = (x) => AA.classify(x, listed).kind;
  for (const c of ["/config", "/mcp", "/advisor", "/output-style", "/color"]) assert.strictEqual(k(c), "terminal", c);
  // with an argument they do work in the chat
  assert.strictEqual(k("/config autoCompact=false"), "command");
  assert.strictEqual(k("/output-style Concise"), "command");
  assert.strictEqual(k("/fast on"), "terminal", "unavailable in the chat even with an argument");
  assert.strictEqual(k("/focus"), "terminal");
});

// Measured: «/model sonnet» in the chat answered «Set model to Sonnet 5.5 for this
// session only» and the NEXT turn ran on the model Loro passes. So /model and
// /effort are the chat's own control, not a CLI command and not the terminal's.
test("ADR-0043 — /model and /effort set the chat's own model and effort", () => {
  assert.deepStrictEqual(AA.classify("/model opus", CMDS), { kind: "setting", name: "model", arg: "opus" });
  assert.deepStrictEqual(AA.classify("/effort", CMDS), { kind: "setting", name: "effort", arg: "" });
  assert.match(APP, /route\.kind === "setting"\) \{[\s\S]*?applyChatSetting\(route\)/);
  assert.match(APP, /case "chat-effort":/);
  assert.match(BUBBLE, /route\.kind === "setting"\) \{ bubbleSetting\(route\)/);
});

test("ADR-0043 — the answers map is question → label, labels for multi, own words when typed", () => {
  const qs = [
    { question: "Cor?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
    { question: "Seções?", multiSelect: true, options: [{ label: "Intro" }, { label: "Fim" }] },
    { question: "Formato?", multiSelect: false, options: [{ label: "A" }] },
  ];
  const picks = [{ labels: ["Blue"] }, { labels: ["Intro", "Fim"] }, { labels: ["A"], other: "tabela" }];
  assert.deepStrictEqual(AA.answersFrom(qs, picks), {
    "Cor?": "Blue",
    "Seções?": ["Intro", "Fim"],
    "Formato?": "tabela",
  });
  assert.ok(AA.complete(qs, picks));
  assert.ok(!AA.complete(qs, [{ labels: ["Red"] }, { labels: [] }, {}]), "every question needs an answer");
});

test("ADR-0043 — a permission names WHAT would run, not the raw JSON", () => {
  assert.strictEqual(AA.summarize({ tool: "Bash", input: { command: "rm -rf build" } }), "rm -rf build");
  assert.strictEqual(AA.summarize({ tool: "Write", input: { file_path: "/a/x.md", content: "…" } }), "/a/x.md");
  assert.strictEqual(AA.summarize({ tool: "WebFetch", input: { url: "https://x.y" } }), "https://x.y");
  assert.strictEqual(AA.summarize({ tool: "X", input: {}, description: "faz algo" }), "faz algo");
});

// moved from bubble.test.js (ADR-0041 §11): one implementation for both chats
test("ADR-0041 §11 — the list opens only while the command NAME is typed", () => {
  assert.strictEqual(AA.slashQuery("/"), "");
  assert.strictEqual(AA.slashQuery("/rev"), "rev");
  assert.strictEqual(AA.slashQuery("/review "), null, "after the space come the arguments");
  assert.strictEqual(AA.slashQuery("oi /x"), null);
  assert.strictEqual(AA.slashQuery(""), null);
});

test("ADR-0041 §11 — no query: all, in the CLI's order; with one, the fuzzy filter decides", () => {
  assert.deepStrictEqual(AA.slashItems(CMDS, "").map((x) => x.name), CMDS.map((x) => x.name));
  assert.deepStrictEqual(AA.slashItems(CMDS, "comp", FZ.filter).map((x) => x.name), ["compact"]);
  assert.strictEqual(AA.slashItems(CMDS, "torq", FZ.filter)[0].name, "turbi-design:torque");
  assert.strictEqual(AA.slashItems(Array.from({ length: 80 }, (_, i) => ({ name: "s" + i })), "").length, 50);
});

test("ADR-0043 — both chats are wired: «/» list, asks, answers and the terminal route", () => {
  // backend surface
  for (const c of ["chat_answer", "agent_commands"]) {
    assert.match(LIB, new RegExp("chat::" + c + "\\b"), c + " is not registered");
  }
  // main window
  assert.match(INDEX, /<script src="agentask\.js"><\/script>/);
  assert.match(INDEX, /id="chatSlash"/);
  assert.match(APP, /listen\("chat-ask"/);
  assert.match(APP, /invoke\("chat_answer"/);
  assert.match(APP, /LoroAgentAsk\.attachSlash\(\{\s*input: \$\("chatInput"\)/);
  assert.match(APP, /case "terminal-command":/);
  // a «/command» goes unchanged: wrapped in /loro-ask it was a question about it
  const send = APP.slice(APP.indexOf("async function sendChat"), APP.indexOf("function refreshAfterSkill"));
  assert.match(send, /route\.kind === "command"\) \{[\s\S]*?prompt = text;/);
  // bubble
  assert.match(BUBBLE, /listen\("bubble-chat-ask"/);
  assert.match(BUBBLE, /send\("terminal-command", \{ command: q \}\)/);
});

// The embedded terminal already IS the agent's TUI. Measured 2026-11-23 over a pty:
// "/cost\n" in one write stays parked in Claude's prompt; "/cost" then "\r" runs.
// The owner's screenshot showed «claude '/login'» parked there — a shell line typed
// into Claude, with an Enter that never submitted.
test("ADR-0043 — a terminal-only command is typed INTO the agent's TUI and submitted with \\r", () => {
  const run = APP.slice(APP.indexOf("async function runTerminalCommand"), APP.indexOf("let agentCmds"));
  assert.match(run, /termRunAgent\(/, "must go through the agent's own TUI");
  assert.doesNotMatch(run, /chat_terminal_line|termRun\(line\)/, "no shell line typed into Claude");
  const agent = APP.slice(APP.indexOf("async function termRunAgent"), APP.indexOf("// ---- setup guiado"));
  assert.doesNotMatch(agent, /data: line \+ "\\n"/, "text+\\n in one write is never sent");
  assert.match(agent, /data: "\\r"/, "Enter is its own \\r");
});
