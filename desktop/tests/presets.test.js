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

// O nome é usado para COMPARAR, então tem de vir normalizado — como no
// process_name_matches do backend (minúsculas, sem .exe). Um acervo salvo com
// "Claude" fazia toda habilidade cair no texto de fallback, porque a config
// guarda o comando verbatim e "Claude" !== "claude".
test("agentName normaliza caixa e sufixo .exe", () => {
  assert.strictEqual(agentName("Claude"), "claude");
  assert.strictEqual(agentName("CLAUDE"), "claude");
  assert.strictEqual(agentName("Claude --resume"), "claude");
  assert.strictEqual(agentName("C:\\tools\\Claude.exe"), "claude");
  assert.strictEqual(agentName("claude.EXE"), "claude");
  // um caminho COM espaço é indistinguível de comando + argumentos, aqui e no
  // backend (ambos quebram no primeiro espaço) — documentado, não corrigido
  assert.strictEqual(agentName("C:\\Program Files\\claude.exe"), "program");
  assert.strictEqual(agentName("/usr/local/bin/Gemini"), "gemini");
});

test("agentInvocation keeps slash-commands for claude", () => {
  assert.strictEqual(agentInvocation("claude", "/loro-context"), "/loro-context");
  assert.strictEqual(agentInvocation("/opt/bin/claude", "/loro-ask o que mudou?"), "/loro-ask o que mudou?");
});

test("agentInvocation rewrites slash-commands as a plain prompt for other agents", () => {
  const out = agentInvocation("gemini", "/loro-context");
  assert.match(out, /\.claude\/commands\/loro-context\.md/);
  assert.ok(!out.startsWith("/"));
  const withArgs = agentInvocation("ollama run llama3", "/loro-question qual foi a decisão?");
  assert.match(withArgs, /loro-question\.md/);
  assert.match(withArgs, /qual foi a decisão\?$/);
});

test("agentInvocation passes non-slash input through untouched", () => {
  assert.strictEqual(agentInvocation("gemini", "olá, resuma a reunião"), "olá, resuma a reunião");
});

// O bug relatado: acervo salvo com "Claude" (o campo é texto livre) e toda
// habilidade chegava ao Claude como "Read and follow the instructions in
// .claude/commands/loro-analyse.md…" em vez de /loro-analyse.
test("agentInvocation reconhece o claude escrito com maiúscula", () => {
  for (const a of ["Claude", "CLAUDE", "Claude --resume", "/opt/bin/Claude"]) {
    assert.strictEqual(
      agentInvocation(a, "/loro-analyse brainstorming/x/meetings/y"),
      "/loro-analyse brainstorming/x/meetings/y",
      `agente ${a} deveria receber o slash-command`,
    );
  }
});
