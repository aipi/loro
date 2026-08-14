// Workspace reducer tests (node --test). Pure, no DOM, no CodeMirror. See ADR-0008.
const test = require("node:test");
const assert = require("node:assert");
const W = require("../src/workspace.js");

// test-local lookup: id of the tab holding a given rel
const tabId = (ws, rel) => ws.tabs.find((t) => t.rel === rel).id;

test("empty() is a serializable blank workspace", () => {
  const ws = W.empty();
  assert.deepStrictEqual(ws, { tabs: [], activeId: null, mru: [], closed: [], seq: 0 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ws)), ws);
});

test("openTab derives kind from rel (contexts/ vs pessoal/ vs other)", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "contexts/loro/context.md").ws;
  ws = W.openTab(ws, "pessoal/notes.md", { preview: false }).ws;
  ws = W.openTab(ws, "README.md", { preview: false }).ws;
  assert.strictEqual(ws.tabs[0].kind, "context");
  assert.strictEqual(ws.tabs[1].kind, "personal");
  assert.strictEqual(ws.tabs[2].kind, "other");
  // ADR-0026 §12: o título é a identidade do documento, não o nome do arquivo
  assert.strictEqual(ws.tabs[0].title, "loro");
  assert.strictEqual(ws.tabs[1].title, "notes.md");
});

test("openTab dedupes by rel and just activates the existing tab", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "a.md", { preview: false }).ws;
  ws = W.openTab(ws, "b.md", { preview: false }).ws;
  const before = ws.tabs.length;
  ws = W.openTab(ws, "a.md", { preview: false }).ws;
  assert.strictEqual(ws.tabs.length, before);
  assert.strictEqual(W.activeTab(ws).rel, "a.md");
});

test("only one preview tab: next preview open reuses the same slot (same id, same position)", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "pinned.md", { preview: false }).ws;
  ws = W.openTab(ws, "first.md").ws; // preview
  const previewId = W.activeTab(ws).id;
  const pos = ws.tabs.findIndex((t) => t.id === previewId);
  ws = W.openTab(ws, "second.md").ws; // preview again -> reuse slot
  const previews = ws.tabs.filter((t) => t.preview);
  assert.strictEqual(previews.length, 1);
  assert.strictEqual(previews[0].id, previewId);
  assert.strictEqual(previews[0].rel, "second.md");
  assert.strictEqual(ws.tabs.findIndex((t) => t.id === previewId), pos);
});

test("editing promotes a preview tab to permanent (setMode edit and markDirty)", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "draft.md").ws; // preview
  const id = W.activeTab(ws).id;
  ws = W.setMode(ws, id, "edit");
  assert.strictEqual(W.activeTab(ws).preview, false);

  let ws2 = W.openTab(W.empty(), "draft.md").ws;
  const id2 = W.activeTab(ws2).id;
  ws2 = W.markDirty(ws2, id2, true);
  assert.strictEqual(W.activeTab(ws2).preview, false);
});

test("opening a preview rel permanently promotes the existing preview tab", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "x.md").ws; // preview
  const id = W.activeTab(ws).id;
  ws = W.openTab(ws, "x.md", { preview: false }).ws; // same rel, permanent
  assert.strictEqual(ws.tabs.length, 1);
  assert.strictEqual(ws.tabs[0].id, id);
  assert.strictEqual(ws.tabs[0].preview, false);
});

test("pin and promotePreview clear the preview flag", () => {
  let ws = W.openTab(W.empty(), "x.md").ws;
  const id = W.activeTab(ws).id;
  const pinned = W.pin(ws, id);
  assert.strictEqual(W.activeTab(pinned).pinned, true);
  assert.strictEqual(W.activeTab(pinned).preview, false);
  const promoted = W.promotePreview(ws, id);
  assert.strictEqual(W.activeTab(promoted).preview, false);
});

test("closeTab picks the next active from the MRU stack", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "a.md", { preview: false }).ws;
  ws = W.openTab(ws, "b.md", { preview: false }).ws;
  ws = W.openTab(ws, "c.md", { preview: false }).ws;
  // MRU is now c,b,a; make b the second-most-recent before c
  ws = W.setActive(ws, tabId(ws, "b.md"));
  ws = W.setActive(ws, tabId(ws, "c.md")); // active c, mru: c,b,a
  ws = W.closeTab(ws, W.activeTab(ws).id); // close c -> next is b
  assert.strictEqual(W.activeTab(ws).rel, "b.md");
});

test("closeTab pushes the closed rel onto the reopen stack; reopenClosed pops it", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "a.md", { preview: false }).ws;
  ws = W.openTab(ws, "b.md", { preview: false }).ws;
  ws = W.closeTab(ws, tabId(ws, "b.md"));
  assert.deepStrictEqual(ws.closed, ["b.md"]);
  ws = W.reopenClosed(ws);
  assert.strictEqual(W.activeTab(ws).rel, "b.md");
  assert.strictEqual(W.activeTab(ws).preview, false);
  assert.deepStrictEqual(ws.closed, []);
});

test("reopenClosed on an empty stack is a no-op", () => {
  const ws = W.openTab(W.empty(), "a.md", { preview: false }).ws;
  assert.deepStrictEqual(W.reopenClosed(ws), ws);
});

test("closeByRel closes the tab that holds that rel", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "a.md", { preview: false }).ws;
  ws = W.openTab(ws, "b.md", { preview: false }).ws;
  ws = W.closeByRel(ws, "a.md");
  assert.strictEqual(ws.tabs.length, 1);
  assert.strictEqual(ws.tabs[0].rel, "b.md");
});

test("nextMru returns the most-recent tab other than the active one", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "a.md", { preview: false }).ws;
  ws = W.openTab(ws, "b.md", { preview: false }).ws;
  ws = W.openTab(ws, "c.md", { preview: false }).ws; // active c, mru c,b,a
  assert.strictEqual(W.nextMru(ws), tabId(ws, "b.md"));
});

test("setMode and renameTab update the right tab", () => {
  let ws = W.openTab(W.empty(), "contexts/x/context.md", { preview: false }).ws;
  const id = W.activeTab(ws).id;
  ws = W.setMode(ws, id, "edit");
  assert.strictEqual(W.activeTab(ws).mode, "edit");
  ws = W.renameTab(ws, id, "pessoal/y.md");
  assert.strictEqual(W.activeTab(ws).title, "y.md");
  assert.strictEqual(W.activeTab(ws).kind, "personal");
});

test("moveTab reorders tabs without mutating input", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "a.md", { preview: false }).ws;
  ws = W.openTab(ws, "b.md", { preview: false }).ws;
  ws = W.openTab(ws, "c.md", { preview: false }).ws;
  const snapshot = JSON.parse(JSON.stringify(ws));
  const moved = W.moveTab(ws, tabId(ws, "c.md"), 0);
  assert.deepStrictEqual(ws, snapshot); // input untouched
  assert.deepStrictEqual(moved.tabs.map((t) => t.rel), ["c.md", "a.md", "b.md"]);
});

test("no reducer mutates its input", () => {
  let ws = W.openTab(W.empty(), "a.md", { preview: false }).ws;
  const snapshot = JSON.parse(JSON.stringify(ws));
  const id = W.activeTab(ws).id;
  W.openTab(ws, "b.md");
  W.setActive(ws, id);
  W.setMode(ws, id, "edit");
  W.markDirty(ws, id, true);
  W.pin(ws, id);
  W.promotePreview(ws, id);
  W.renameTab(ws, id, "z.md");
  W.closeTab(ws, id);
  W.closeByRel(ws, "a.md");
  assert.deepStrictEqual(ws, snapshot);
});

test("workspace stays JSON-serializable through a realistic session", () => {
  let ws = W.empty();
  ws = W.openTab(ws, "contexts/loro/context.md", { preview: false }).ws;
  ws = W.openTab(ws, "pessoal/draft.md").ws;
  ws = W.markDirty(ws, W.activeTab(ws).id, true);
  ws = W.openTab(ws, "README.md").ws;
  ws = W.closeTab(ws, tabId(ws, "README.md"));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ws)), ws);
});

test("activeTab returns null when nothing is open", () => {
  assert.strictEqual(W.activeTab(W.empty()), null);
});

// ---- openTab eviction contract (ADR-0002 §3) ----
// openTab returns { ws, evictedId }: reusing the preview slot reports the
// evicted tab id so app.js can dispose the live editor side-maps.

test("openTab returns { ws, evictedId: null } on a fresh open", () => {
  const r = W.openTab(W.empty(), "a.md");
  assert.ok(r.ws && Array.isArray(r.ws.tabs), "returns a workspace under .ws");
  assert.strictEqual(r.evictedId, null);
  assert.strictEqual(r.ws.tabs.length, 1);
});

test("preview slot reuse reports the evicted id and resets tab state", () => {
  let ws = W.openTab(W.empty(), "a.md").ws; // preview
  const slotId = W.activeTab(ws).id;
  const pos = ws.tabs.findIndex((t) => t.id === slotId);
  const r = W.openTab(ws, "b.md"); // preview again -> reuse slot
  assert.strictEqual(r.evictedId, slotId);
  const tab = r.ws.tabs.find((t) => t.id === slotId);
  assert.strictEqual(tab.rel, "b.md");
  assert.strictEqual(tab.mode, "view");
  assert.strictEqual(tab.dirty, false);
  assert.strictEqual(tab.savedText, null);
  assert.strictEqual(r.ws.tabs.findIndex((t) => t.id === slotId), pos);
});

test("dedupe by rel never evicts", () => {
  let ws = W.openTab(W.empty(), "a.md").ws;
  const r = W.openTab(ws, "a.md");
  assert.strictEqual(r.evictedId, null);
  assert.strictEqual(r.ws.tabs.length, 1);
});

test("permanent open does not reuse the preview slot and never evicts", () => {
  let ws = W.openTab(W.empty(), "a.md").ws; // preview alive
  const r = W.openTab(ws, "b.md", { preview: false });
  assert.strictEqual(r.evictedId, null);
  assert.strictEqual(r.ws.tabs.length, 2);
  assert.strictEqual(r.ws.tabs.filter((t) => t.preview).length, 1);
});

test("reopenClosed still returns a plain ws", () => {
  let ws = W.openTab(W.empty(), "a.md", { preview: false }).ws;
  ws = W.closeTab(ws, tabId(ws, "a.md"));
  const ws2 = W.reopenClosed(ws);
  assert.ok(Array.isArray(ws2.tabs), "plain ws, not { ws, evictedId }");
  assert.strictEqual(ws2.tabs.length, 1);
  assert.strictEqual(ws2.tabs[0].preview, false);
});

// Chrome do dock do terminal (ADR-0008), não um reducer de `ws`: o glifo de
// recolher tem de apontar para onde o painel some. Embaixo ele desce (⌄); na
// lateral ele sai pela direita, e o ⌄ fixo ficava contra-intuitivo — uma seta
// para baixo num painel que se fecha para o lado.
test("o glifo de recolher segue a orientação do dock", () => {
  assert.strictEqual(W.termCollapseGlyph(false), "⌄");
  assert.strictEqual(W.termCollapseGlyph(true), "›");
});

test("termCollapseGlyph trata valores soltos como 'embaixo'", () => {
  assert.strictEqual(W.termCollapseGlyph(undefined), "⌄");
  assert.strictEqual(W.termCollapseGlyph(null), "⌄");
  assert.strictEqual(W.termCollapseGlyph(1), "›");
});

// ---- ADR-0026 §12 — a aba diz ONDE você está, não como o arquivo se chama ----
//
// Todo documento do acervo se chama `context.md`, `CHANGELOG.md` ou
// `reuniao.md`. Com o basename por título, abrir três temas dava três abas
// idênticas escritas "context.md": a faixa deixava de ser um mapa e o nome do
// arquivo — que nem é traduzido — virava a única identidade visível.

test("ADR-0026 — a aba de um tema é o NOME do tema, não context.md", () => {
  const { openTab, empty, activeTab } = W;
  let ws = openTab(empty(), "contexts/assinatura/context.md", { preview: false }).ws;
  assert.strictEqual(activeTab(ws).title, "assinatura");
  ws = openTab(ws, "contexts/trato/hardware-lifecycle/context.md", { preview: false }).ws;
  assert.strictEqual(activeTab(ws).title, "trato/hardware-lifecycle");
});

test("ADR-0026 — histórico e donos dizem de QUEM são", () => {
  const { openTab, empty, activeTab } = W;
  let ws = openTab(empty(), "contexts/assinatura/CHANGELOG.md", { preview: false }).ws;
  assert.strictEqual(activeTab(ws).title, "assinatura · histórico");
  ws = openTab(ws, "contexts/frota/multas/CHANGELOG.md", { preview: false }).ws;
  assert.strictEqual(activeTab(ws).title, "frota/multas · histórico");
});

test("ADR-0026 — a reunião é o tema e a data, não reuniao.md", () => {
  const { openTab, empty, activeTab } = W;
  const ws = openTab(empty(), "brainstorming/risco/meetings/2026-08-04-1212-reuniao/meeting.md",
    { preview: false }).ws;
  assert.strictEqual(activeTab(ws).title, "risco · 2026-08-04 12:12");
});

test("ADR-0026 — o que não é do acervo continua sendo o nome do arquivo", () => {
  const { openTab, empty, activeTab } = W;
  let ws = openTab(empty(), "INDEX.md", { preview: false }).ws;
  assert.strictEqual(activeTab(ws).title, "INDEX.md");
  ws = openTab(ws, "pessoal/temas/ideia.md", { preview: false }).ws;
  assert.strictEqual(activeTab(ws).title, "ideia.md");
});

test("ADR-0026 — seguir uma referência abre uma aba NOVA, não substitui a de preview", () => {
  const { openTab, empty } = W;
  let ws = openTab(empty(), "contexts/assinatura/context.md", { preview: true }).ws;
  ws = openTab(ws, "contexts/riscos/context.md", { preview: false }).ws;
  assert.strictEqual(ws.tabs.length, 2, "a segunda não come a primeira");
});
