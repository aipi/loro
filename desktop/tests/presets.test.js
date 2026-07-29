// Usage templates + agent-agnostic invocation helpers (ADR-0003).
const test = require("node:test");
const assert = require("node:assert");
const { prefillContexts, agentName, agentInvocation } = require("../src/presets.js");

test("prefillContexts fills a pristine field from the template", () => {
  assert.strictEqual(prefillContexts("", false, ["contas", "pipeline"]), "contas, pipeline");
  assert.strictEqual(prefillContexts("  ", true, ["contas"]), "contas");
});

test("prefillContexts never clobbers what the user typed", () => {
  assert.strictEqual(prefillContexts("meu, proprio", true, ["contas"]), "meu, proprio");
});

test("agentName takes the basename of the first token", () => {
  assert.strictEqual(agentName("claude"), "claude");
  assert.strictEqual(agentName("ollama run llama3"), "ollama");
  assert.strictEqual(agentName("/usr/local/bin/gemini --flash"), "gemini");
  assert.strictEqual(agentName(""), "claude");
});

test("agentInvocation keeps slash-commands for claude", () => {
  assert.strictEqual(agentInvocation("claude", "/brain-context"), "/brain-context");
  assert.strictEqual(agentInvocation("/opt/bin/claude", "/brain-ask o que mudou?"), "/brain-ask o que mudou?");
});

test("agentInvocation rewrites slash-commands as a plain prompt for other agents", () => {
  const out = agentInvocation("gemini", "/brain-context");
  assert.match(out, /\.claude\/commands\/brain-context\.md/);
  assert.ok(!out.startsWith("/"));
  const withArgs = agentInvocation("ollama run llama3", "/brain-answer qual foi a decisão?");
  assert.match(withArgs, /brain-answer\.md/);
  assert.match(withArgs, /qual foi a decisão\?$/);
});

test("agentInvocation passes non-slash input through untouched", () => {
  assert.strictEqual(agentInvocation("gemini", "olá, resuma a reunião"), "olá, resuma a reunião");
});
