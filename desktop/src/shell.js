// Loro — o casco do redesign (handoff "Loro — versão final" / ADR-0020).
//
// Esta camada é só CROMO: tema, destinos da nav, barra lateral recolhível,
// painel direito e a doca do terminal. Não conhece IPC, acervo nem
// transcrição — o app.js liga os fios e guarda o estado persistido.
// Regras invioláveis do handoff que vivem aqui:
//   1. a faixa de abas começa à DIREITA da barra lateral (grid do .bshell);
//   2. não existe aba "Início" — os destinos são a nav pill do cabeçalho;
//   3. o alternador da barra lateral fica EMBAIXO, junto ao ⚙.
(function () {
  const $ = (id) => document.getElementById(id);

  // ---- tema: claro · escuro · sistema -------------------------------------
  // "sistema" é resolvido aqui para light/dark e escrito em data-theme, de modo
  // que o CSS só precise conhecer os dois estados reais.
  let themePref = "system";
  const osDark = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  const themeListeners = [];
  function resolvedTheme() {
    if (themePref === "light" || themePref === "dark") return themePref;
    return osDark && osDark.matches ? "dark" : "light";
  }
  function paintTheme() {
    const r = resolvedTheme();
    document.documentElement.setAttribute("data-theme", r);
    for (const fn of themeListeners) { try { fn(r); } catch (_) {} }
  }
  function setTheme(pref) {
    themePref = pref === "light" || pref === "dark" ? pref : "system";
    document.querySelectorAll("#themeSeg .segbtn").forEach((b) =>
      b.classList.toggle("on", b.dataset.theme === themePref));
    paintTheme();
    return themePref;
  }
  if (osDark && osDark.addEventListener) osDark.addEventListener("change", () => { if (themePref === "system") paintTheme(); });
  function onThemeChange(fn) { themeListeners.push(fn); }

  // ---- destinos: Início · Organizar · Conhecimento ------------------------
  const DESTS = { home: "destHome", organize: "destOrganize", knowledge: "destKnowledge" };
  let dest = "home";
  function setDestination(name) {
    if (!DESTS[name]) name = "home";
    dest = name;
    document.querySelectorAll("#destNav .dest").forEach((b) =>
      b.classList.toggle("on", b.dataset.dest === name));
    for (const [k, id] of Object.entries(DESTS)) {
      const node = $(id);
      if (node) node.hidden = k !== name;
    }
    return name;
  }
  const destination = () => dest;

  // ---- barra lateral: 250px ⇄ 60px ---------------------------------------
  function setSidebarCollapsed(on) {
    const shell = $("brainShell"), full = document.querySelector(".bside"), mini = $("sideMini");
    if (!shell) return !!on;
    shell.classList.toggle("collapsed", !!on);
    if (full) full.hidden = !!on;
    if (mini) mini.hidden = !on;
    return !!on;
  }

  // ---- painel direito (330px) --------------------------------------------
  function setPanelOpen(on) {
    const p = $("aiPanel"), btn = $("aiPanelBtn");
    if (p) p.hidden = !on;
    if (btn) btn.classList.toggle("on", !!on);
    return !!on;
  }
  const PANES = { doc: "panelDoc", chat: "panelChat", term: "panelTerm" };
  function setPanelTab(tab) {
    if (!PANES[tab]) tab = "doc";
    document.querySelectorAll("#panelTabs .ptab").forEach((b) =>
      b.classList.toggle("on", b.dataset.ptab === tab));
    for (const [k, id] of Object.entries(PANES)) {
      const node = $(id);
      if (node) node.hidden = k !== tab;
    }
    return tab;
  }

  // ---- doca do terminal: lateral (aba Terminal) ou embaixo ---------------
  // O mesmo elemento #termPanel é MOVIDO entre os dois pontos de montagem —
  // um xterm não pode existir em dois lugares. Quem chama refaz o fit().
  function mountTerminal(side) {
    const panel = $("termPanel"), host = side ? $("panelTerm") : $("termDock"), dock = $("termDock");
    if (!panel || !host) return !!side;
    if (panel.parentElement !== host) host.appendChild(panel);
    if (dock) dock.hidden = side || panel.hidden;
    return !!side;
  }

  window.LoroShell = {
    setTheme, resolvedTheme, onThemeChange,
    setDestination, destination,
    setSidebarCollapsed, setPanelOpen, setPanelTab, mountTerminal,
  };
})();
