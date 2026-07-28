// Loro — world-legibility derivations for the Knowledge Studio shell (ADR-0008).
// Pure, no DOM: loaded in the browser via <script> (defines window.LoroWorld)
// and in Node via require(). A tab's kind ("context"/"personal"/"other")
// decides its permanent crumb badge and whether Git state may ever surface.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroWorld = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Permanent crumb badge per world. `null` means the caller keeps its own
  // document-specific badge (inbox/guide/etc.).
  function crumbBadge(kind) {
    if (kind === "context") return { label: "versionado", cls: "ok" };
    if (kind === "personal") return { label: "rascunho — não versionado", cls: "warn2" };
    return null;
  }

  // Git indicators exist only in the versioned world; a pessoal/ tab never
  // renders any Git state (ADR-0008).
  function gitVisible(kind) {
    return kind === "context";
  }

  return { crumbBadge, gitVisible };
});
