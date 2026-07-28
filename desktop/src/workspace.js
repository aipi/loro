// Loro — workspace state + pure reducers for the Knowledge Studio shell (ADR-0008).
// Isolated, framework-free module: loaded in the browser via <script>
// (defines window.LoroWorkspace) and in Node via require() for node --test.
//
// The whole point of this module is that `ws` stays plain and JSON-serializable
// (ADR-0008): live CodeMirror EditorStates live in a side Map in app.js keyed by
// tab id, never here. Every reducer takes `ws` and returns a NEW `ws` — no input
// is ever mutated — so session-restore stays a purely additive later step.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroWorkspace = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function basename(rel) {
    const parts = String(rel).split("/");
    return parts[parts.length - 1] || String(rel);
  }

  // Two versioned worlds must be legible at the tab level (ADR-0008).
  function deriveKind(rel) {
    const s = String(rel);
    if (s.startsWith("contextos/")) return "context";
    if (s.startsWith("pessoal/")) return "personal";
    return "other";
  }

  function makeTab(id, rel, preview) {
    return {
      id,
      rel,
      title: basename(rel),
      kind: deriveKind(rel),
      mode: "view",
      pinned: false,
      preview: !!preview,
      dirty: false,
      savedText: null,
      readScroll: 0,
    };
  }

  function empty() {
    return { tabs: [], activeId: null, mru: [], closed: [], seq: 0 };
  }

  function activeTab(ws) {
    return ws.tabs.find((t) => t.id === ws.activeId) || null;
  }

  // Activate a tab and move it to the front of the MRU list.
  function setActive(ws, id) {
    if (!ws.tabs.some((t) => t.id === id)) return ws;
    const mru = [id, ...ws.mru.filter((x) => x !== id)];
    return { ...ws, activeId: id, mru };
  }

  function patchTab(ws, id, patch) {
    return { ...ws, tabs: ws.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
  }

  // Open (or focus) a document. Single-click opens an ephemeral preview tab;
  // only one preview exists at a time and the next preview open reuses its slot.
  // Opening a preview rel permanently promotes it (preview -> permanent).
  function openTab(ws, rel, opts) {
    const preview = opts && "preview" in opts ? !!opts.preview : true;
    const existing = ws.tabs.find((t) => t.rel === rel);
    if (existing) {
      const ws2 = !preview && existing.preview ? patchTab(ws, existing.id, { preview: false }) : ws;
      return setActive(ws2, existing.id);
    }
    if (preview) {
      const prev = ws.tabs.find((t) => t.preview);
      if (prev) {
        // reuse the preview slot in place: keep id + position, swap the content
        const tabs = ws.tabs.map((t) => (t.id === prev.id ? makeTab(prev.id, rel, true) : t));
        return setActive({ ...ws, tabs }, prev.id);
      }
    }
    const seq = ws.seq + 1;
    const id = "t" + seq;
    const tabs = [...ws.tabs, makeTab(id, rel, preview)];
    return setActive({ ...ws, tabs, seq }, id);
  }

  // Close a tab, remember its rel on the reopen stack, and pick the next active
  // from the MRU (falling back to the last remaining tab).
  function closeTab(ws, id) {
    const tab = ws.tabs.find((t) => t.id === id);
    if (!tab) return ws;
    const tabs = ws.tabs.filter((t) => t.id !== id);
    const mru = ws.mru.filter((x) => x !== id);
    const closed = [...ws.closed, tab.rel];
    let activeId = ws.activeId;
    if (activeId === id) activeId = mru.length ? mru[0] : tabs.length ? tabs[tabs.length - 1].id : null;
    return { ...ws, tabs, mru, closed, activeId };
  }

  function closeByRel(ws, rel) {
    const tab = ws.tabs.find((t) => t.rel === rel);
    return tab ? closeTab(ws, tab.id) : ws;
  }

  // Pop the most recently closed rel and reopen it as a permanent tab.
  function reopenClosed(ws) {
    if (!ws.closed.length) return ws;
    const closed = ws.closed.slice(0, -1);
    const rel = ws.closed[ws.closed.length - 1];
    return openTab({ ...ws, closed }, rel, { preview: false });
  }

  // Entering edit mode promotes a preview tab to permanent (ADR-0008).
  function setMode(ws, id, mode) {
    const tab = ws.tabs.find((t) => t.id === id);
    if (!tab) return ws;
    return patchTab(ws, id, { mode, preview: mode === "edit" ? false : tab.preview });
  }

  // `dirty` is the unsaved-buffer dot; going dirty promotes a preview tab.
  function markDirty(ws, id, dirty) {
    const tab = ws.tabs.find((t) => t.id === id);
    if (!tab) return ws;
    return patchTab(ws, id, { dirty: !!dirty, preview: dirty ? false : tab.preview });
  }

  function pin(ws, id) {
    return ws.tabs.some((t) => t.id === id) ? patchTab(ws, id, { pinned: true, preview: false }) : ws;
  }

  function promotePreview(ws, id) {
    return ws.tabs.some((t) => t.id === id) ? patchTab(ws, id, { preview: false }) : ws;
  }

  function moveTab(ws, id, toIndex) {
    const from = ws.tabs.findIndex((t) => t.id === id);
    if (from === -1) return ws;
    const tabs = ws.tabs.slice();
    const [tab] = tabs.splice(from, 1);
    const idx = Math.max(0, Math.min(toIndex, tabs.length));
    tabs.splice(idx, 0, tab);
    return { ...ws, tabs };
  }

  function renameTab(ws, id, rel) {
    return ws.tabs.some((t) => t.id === id)
      ? patchTab(ws, id, { rel, title: basename(rel), kind: deriveKind(rel) })
      : ws;
  }

  // Id of the most-recent tab other than the active one (Ctrl-Tab target).
  function nextMru(ws) {
    for (const id of ws.mru) {
      if (id !== ws.activeId && ws.tabs.some((t) => t.id === id)) return id;
    }
    return null;
  }

  return {
    empty,
    openTab,
    closeTab,
    reopenClosed,
    setActive,
    setMode,
    markDirty,
    pin,
    promotePreview,
    moveTab,
    renameTab,
    closeByRel,
    nextMru,
    activeTab,
  };
});
