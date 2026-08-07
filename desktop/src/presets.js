// Loro — pure, dependency-free helpers for acervo usage templates (presets,
// ADR-0003) and the agent-agnostic terminal invocation. Loaded in the browser
// via <script> (defines window.LoroPresets) and in Node via require() for
// `node --test`. No DOM, no Tauri.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroPresets = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Prefill the wizard contexts field from a template selection: never clobber
  // what the user already typed by hand (dirty), only replace pristine content.
  function prefillContexts(current, dirty, contexts) {
    if (dirty && String(current || "").trim() !== "") return current;
    return (contexts || []).join(", ");
  }

  // Process name of an agent command: basename of the first token, normalized
  // for comparison the same way the backend's process_name_matches does it —
  // lowercase, no `.exe`, either separator. The agent field is free text stored
  // verbatim, so an acervo saved as "Claude" used to miss the `=== "claude"`
  // check below and every habilidade reached Claude as the fallback prompt
  // instead of its slash-command.
  function agentName(agent) {
    const first = String(agent || "").trim().split(/\s+/)[0] || "claude";
    const leaf = first.split(/[/\\]/).pop() || "claude";
    return leaf.toLowerCase().replace(/\.exe$/, "") || "claude";
  }

  // Slash-commands are a Claude convention. For any other agent the same skill
  // is invoked as a plain one-line prompt pointing at the instruction file the
  // acervo materializes (AGENTS.md remains the neutral entry point).
  function agentInvocation(agent, cmd) {
    const line = String(cmd || "").trim();
    if (agentName(agent) === "claude") return line;
    const m = line.match(/^\/([a-z0-9-]+)\s*(.*)$/s);
    if (!m) return line; // not a slash-command: pass through untouched
    const [, skill, args] = m;
    const suffix = args ? " " + args : "";
    return (
      "Read and follow the instructions in .claude/commands/" +
      skill +
      ".md (this folder's AGENTS.md has the base rules)." +
      suffix
    );
  }

  return { prefillContexts, agentName, agentInvocation };
});
