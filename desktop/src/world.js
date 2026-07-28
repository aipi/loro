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
  // document-specific badge (inbox/guide/etc.). `lang` ("pt" default | "en")
  // localizes the label directly — pure modules cannot reach the window-level
  // i18n dictionary.
  const BADGE_COPY = {
    pt: { context: "versionado", personal: "rascunho — não versionado" },
    en: { context: "versioned", personal: "draft — not versioned" },
  };
  function crumbBadge(kind, lang) {
    const t = BADGE_COPY[lang === "en" ? "en" : "pt"];
    if (kind === "context") return { label: t.context, cls: "ok" };
    if (kind === "personal") return { label: t.personal, cls: "warn2" };
    return null;
  }

  // Git indicators exist only in the versioned world; a pessoal/ tab never
  // renders any Git state (ADR-0008).
  function gitVisible(kind) {
    return kind === "context";
  }

  return { crumbBadge, gitVisible };
});
