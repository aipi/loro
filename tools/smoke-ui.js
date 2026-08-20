#!/usr/bin/env node
// Loro — smoke da INTERFACE: roda o index.html + app.js DE VERDADE num Chrome
// headless, com o backend Tauri estubado, e exercita a superfície da ADR-0029 (a
// seção LOOPS da árvore, a tela do loop em visualizar e editar, um loop impedido,
// a folha do instalar plugin, a aba ⟳ Loops do painel, as duas seções novas de
// Configurações e a troca de idioma).
//
// POR QUE ISTO EXISTE. A suíte de `make test` lê o FONTE (não há DOM sob
// `node --test`, por decisão: ver o cabeçalho de state-truth.test.js). Isso deixa
// passar uma classe inteira de defeito que só existe em tempo de carregamento —
// e ela apareceu de verdade nesta ADR: o `setInterval(loopTick, LOOP_TICK_MS)`
// ficou acima da declaração do `const`, a zona morta derrubou o carregamento
// inteiro do app.js, e os 849 testes continuaram verdes. Este script pega isso.
//
// NÃO faz parte de `make test`, que é portátil: precisa de Chrome/Chromium, e sai
// com 0 dizendo que pulou quando não há nenhum (a mesma postura de
// tools/measure-header.js).
//
// Uso:  node tools/smoke-ui.js
// Uma superfície nova acrescenta um `step(...)` no driver — a lista de passos é a
// documentação executável do que a tela precisa saber fazer.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const REAL_SRC = path.join(__dirname, "..", "desktop", "src");
const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const CHROME = CHROMES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } });
if (!CHROME) { console.log("smoke: pulado — nenhum Chrome encontrado"); process.exit(0); }

const html = fs.readFileSync(path.join(REAL_SRC, "index.html"), "utf8");
// O DOCUMENTO REAL DO EXEMPLO, lido AQUI (lado node) e interpolado no dublê: o
// dublê não tem view própria, então o exemplo e o teste não podem divergir.
const BOARD_REAL = fs.readFileSync(
  path.join(__dirname, "..", "examples", "extensions", "hotspots-board", "surface", "board.json"), "utf8");

// ---- o dublê do backend: só o que o boot e a superfície nova pedem ----
const STUB = `
<script>
window.__SMOKE__ = { errors: [], calls: {}, handlers: {}, dirs: {} };
window.__SMOKE__.fire = (name, payload) => {
  for (const fn of window.__SMOKE__.handlers[name] || []) fn({ payload });
};
window.addEventListener("error", (e) => window.__SMOKE__.errors.push("error: " + e.message + " @ " + (e.filename||"").split("/").pop() + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => window.__SMOKE__.errors.push("reject: " + (e.reason && e.reason.message || e.reason) + " || " + String((e.reason && e.reason.stack || "").split("\\n").slice(0,4).join(" ⏎ "))));
const NOW = Date.now();
const LOOPS = [
  { slug: "o-que-falta", titulo: "o-que-falta", habilidade: "/loro-digest", instrucao: "escreva o que falta decidir",
    ritmo: "semana:1:14:30", escopo: "projeto", destino: "pasta", ligado: true, criado: "2026-07-01",
    modelo: "opus", esforco: "xhigh",
    expira: "2026-09-16", maxArquivos: 3, maxCiclosDia: 8,
    rel: "loops/o-que-falta.md", dest: "loops/o-que-falta", scope: "brainstorming/ e contexts/",
    state: "running", blocked: null, missed: 0,
    runtime: { slug: "o-que-falta", lastRunMs: NOW - 6*86400000, lastRunDate: "2026-08-11", lastOutcome: "ok",
      failStreak: 0, nextAttemptMs: 0, runsDate: "", runsToday: 0, missed: 0,
      cycles: [
        { startedMs: NOW - 6*86400000, endedMs: NOW - 6*86400000 + 4000, startedDate: "2026-08-11", outcome: "ok", files: ["loops/o-que-falta/decidir.md"], steps: 3, err: "" },
        { startedMs: NOW - 13*86400000, endedMs: 0, startedDate: "2026-08-04", outcome: "nothing", files: [], steps: 7, err: "" },
        { startedMs: NOW - 20*86400000, endedMs: 0, startedDate: "2026-07-28", outcome: "nothing", files: [], steps: 1, err: "" },
        { startedMs: NOW - 27*86400000, endedMs: 0, startedDate: "2026-07-21", outcome: "skipped", files: [], steps: 0, err: "err.loop_overlap" },
      ] } },
  { slug: "atas-pendentes", titulo: "atas-pendentes", habilidade: "", instrucao: "olhe as atas",
    ritmo: "dia:09:00", escopo: "ideia:lancamento-q3", destino: "ideia:lancamento-q3", ligado: true, criado: "2026-08-01",
    expira: "", maxArquivos: 2, maxCiclosDia: 4, rel: "loops/atas-pendentes.md", dest: "brainstorming/lancamento-q3/attachments",
    scope: "brainstorming/lancamento-q3", state: "blocked",
    blocked: "err.loop_permission_refused:mcp__conector-do-time__ler", missed: 2,
    runtime: { slug: "atas-pendentes", lastRunMs: 0, lastRunDate: "", lastOutcome: "blocked", failStreak: 0, nextAttemptMs: 0,
      runsDate: "", runsToday: 0, missed: 0, cycles: [
        { startedMs: NOW - 1800000, endedMs: NOW - 1799000, startedDate: "2026-08-18", outcome: "blocked", files: [], steps: 2,
          err: "err.loop_permission_refused:mcp__conector-do-time__ler" },
      ] } },
  { slug: "radar", titulo: "radar", habilidade: "", instrucao: "olhe os concorrentes", ritmo: "min:30",
    escopo: "pasta:contexts/produto", destino: "conhecimento", ligado: false, criado: "2026-08-02", expira: "", maxArquivos: 1,
    modelo: "", esforco: "", maxCiclosDia: 8, rel: "loops/radar.md", dest: "contexts", scope: "contexts/produto",
    state: "off", blocked: null, missed: 0,
    runtime: { slug: "radar", lastRunMs: 0, lastRunDate: "", lastOutcome: "", failStreak: 0, nextAttemptMs: 0, runsDate: "", runsToday: 0, missed: 0, cycles: [] } },
];
const PLUGINS = [
  { id: "juridico-br", name: "juridico-br", version: "1.2.0",
    source: { kind: "dir", path: "/Users/x/Downloads/juridico-br" }, kinds: ["skills","seed","loops"],
    installedAt: "2026-08-17",
    files: [{ rel: ".claude/commands/loro-parecer.md", sha256: "a" }, { rel: "loops/revisao-de-prazos.md", sha256: "b" }],
    brings: { skills: ["/loro-parecer"], contexts: ["juridico"], loops: ["revisao-de-prazos"] } },
];
const PREVIEW = {
  id: "juridico-br", name: "juridico-br", description: "habilidades juridicas", version: "1.2.0", author: "OAB",
  source: "/Users/x/Downloads/juridico-br", kinds: ["skills","seed","loops"], class: "declarative", executable: [],
  brings: { skills: ["/loro-parecer","/loro-contrato"], contexts: ["juridico"], loops: ["revisao-de-prazos"] },
  writes: [], unsupported: [],
  findings: [{ rel: "pt/AGENTS.md", findings: [{ severity: "warn", rule: "intake.cpf", line: 3, count: 1 }] }],
  blocked: false, conflicts: [], installed: null,
};
// A extensão de nível 1 do repositório, e uma de nível 2 parada: os dois estados
// que a tela tem de saber dizer sem mentir (§5.1 — hasProgram:false é o que
// impede a tela de oferecer iniciar/parar).
const EXTS = [
  { id: "hotspots-board", name: "Pontos em aberto", version: "1.0.0", state: "running", reason: "",
    lastAnswerMs: 0, hasSurface: true, hasProgram: false, canStop: false, trusted: true,
    surfaceLayout: "wide",
    kinds: ["surface"], origin: "/Users/x/loro/examples/extensions/hotspots-board" },
  // canStop e program sao o que o backend passou a mandar (ExtRow): um duble que
  // nao os tem prova o duble e nao a tela -- «o campo que o backend envia e o campo
  // que a tela le».
  { id: "mcp-python", name: "Pontos (Python)", version: "1.0.0", state: "stopped", reason: "",
    lastAnswerMs: 0, hasSurface: true, hasProgram: true, canStop: false, trusted: true,
    program: { protocol: "mcp/stdio", server: "pontos", command: "python3", args: ["server/main.py"], cwd: "" },
    kinds: ["surface", "program"], origin: "/Users/x/loro/examples/extensions/mcp-python" },
];
// o board.json REAL do exemplo, interpolado na geração do driver (lado node)
const EXT_DOC = ${BOARD_REAL};
// A ESCALA REAL medida no acervo do dono em 2026-08-20 (79 conhecimentos, 312
// pontos): foi exatamente esta escala que provou o defeito das colunas de 12px,
// então o dublê nunca mais encolhe para 2 cartões. Gerado determinístico (sem
// Math.random: o smoke tem de medir os MESMOS pixels em toda rodada).
const EXT_FACTS = (() => {
  const areas = ["frota", "financeiro", "atendimento", "comercial", "engenharia", "produto",
    "locacao", "sinistro", "cadastro", "assinatura", "governanca", "tesouraria",
    "kyc", "b2b", "manutencao", "vistoria", "precificacao", "integracoes"];
  const subs = ["eletrica", "conciliacao", "canais", "empresas", "portfolio", "danos",
    "seguro", "verificacao", "cancelamento", "padroes", "balanco", "identidade"];
  const statuses = ["aberto", "aberto", "aberto", "em-pauta", "em-resolucao", "concluido"];
  const ctxs = [], hs = [];
  for (let c = 0; c < 79; c++) {
    const area = areas[c % areas.length];
    const sub = subs[(c * 3) % subs.length];
    const context = c % 3 ? area + "/" + sub + "-" + c : area + "/" + sub;
    const rel = "contexts/" + context + "/context.md";
    const n = 2 + ((c * 7) % 5);
    ctxs.push({ context, area, rel, title: context, hotspots: n, decisions: 0, inlinks: 0, outlinks: 0 });
    for (let k = 0; k < n && hs.length < 312; k++) {
      const hid = k % 2 ? "H-2026-08-13-" + sub + "-fonte-verdade-dados" : "H-" + (hs.length + 1);
      hs.push({ id: context + "#" + hid, hotspot: hid, context, area, rel, title: context,
        status: statuses[(c + k) % statuses.length], comments: (c + k) % 4 === 0 ? ((c + k) % 3) + 1 : 0 });
    }
  }
  const per = new Map();
  for (const c2 of ctxs) {
    const e = per.get(c2.area) || { area: c2.area, contexts: 0, hotspots: 0 };
    e.contexts += 1; e.hotspots += c2.hotspots; per.set(c2.area, e);
  }
  return {
    "acervo.hotspots": { count: hs.length, rows: hs },
    "acervo.contexts": { count: ctxs.length, rows: ctxs },
    "acervo.orphans": { count: 0, rows: [] },
    "acervo.broken": { count: 0, rows: [] },
    "acervo.areas": { count: per.size, rows: [...per.values()].sort((x, y) => x.area.localeCompare(y.area)) },
  };
})();

const EXT_PREVIEW = {
  id: "hotspots-board", name: "Pontos em aberto", version: "1.0.0", author: "loro",
  source: "/Users/x/loro/examples/extensions/hotspots-board",
  kinds: ["surface"], points: ["surface"], unsupported: ["facts@1"],
  program: null, surface: { title: { pt: "Pontos em aberto", en: "Open points" }, served: false, viewFile: "surface/board.json" },
  capabilities: [], settings: [], writes: [{ rel: ".claude/commands/pontos-em-aberto.md", classe: "declarative" }],
  findings: [], blocked: false, conflicts: [], installed: null, trust: false,
};
// os ajustes do dublê são MUTÁVEIS: ext_settings_set mescla aqui, e o quadro
// re-renderiza lendo isto — o mesmo ciclo do backend real (mescla por escopo)
const EXT_SETTINGS = { rotulo: "Pontos em aberto", filtro: "", mostrar_comentarios: true, dica_de_uso: true };
const ANSWERS = {
  selftest_enabled: false,
  ui_get_lang: "pt",
  app_version: "0.13.0",
  brain_get_config: { brainDir: "/tmp/acervo", contexts: ["produto"], agent: "claude" },
  brain_list_acervos: { acervos: [{ id: "turbi", name: "Turbi", dir: "/tmp/acervo", color: "", lang: "pt", template: "generico", agent: "claude", autoContext: true, ticketBase: "" }], active: "turbi" },
  brain_status: { configured: true, contexts: [{ name: "produto", updated: "2026-08-01" }], inbox: [], processed: 0,
                  activity: [], meetings: [], notes: [], legacyLayout: false },
  brain_list_all: [{ path: ".claude/commands/loro-analyse.md", name: "loro-analyse.md", kind: "tool" },
                   { path: ".claude/commands/loro-parecer.md", name: "loro-parecer.md", kind: "tool" }],
  brain_list_brainstorms: [{ slug: "lancamento-q3", nome: "lancamento-q3", categoria: "" }],
  brain_list_meetings: [],
  brain_list_dir: [],
  brain_read: "# doc\\n",
  brain_read_guide: "",
  brain_git_state: { repo: true, pending: 2, branch: "rfc/plugin-juridico", default: "main", ahead: 1, behind: 0, dirty: true },
  brain_git_files: [{ path: "contexts/juridico/context.md", status: "M" },
                    { path: ".claude/commands/loro-parecer.md", status: "??" }],
  brain_git_diff: [
    { path: "contexts/juridico/context.md", oldPath: null, kind: "modified", additions: 3, deletions: 2, binary: false,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, rows: [
        { kind: "context", oldLine: 1, newLine: 1, text: "# juridico" },
        { kind: "del", oldLine: 2, newLine: null, text: "prazo de 30 dias" },
        { kind: "add", oldLine: null, newLine: 2, text: "prazo de 60 dias" }] }] },
    { path: ".claude/commands/loro-parecer.md", oldPath: null, kind: "added", additions: 2, deletions: 0, binary: false,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, rows: [
        { kind: "add", oldLine: null, newLine: 1, text: "# parecer" },
        { kind: "add", oldLine: null, newLine: 2, text: "escreva um parecer" }] }] },
  ],
  brain_timeline: [],
  brain_notifications: { connected: false, categories: [] },
  brain_knowledge_graph: { nodes: [], edges: [], broken: [], orphans: [] },
  brain_index_terms: [],
  brain_pii_scan: [],
  list_models: [],
  list_capture_devices: [],
  default_save_dir: "/tmp/acervo/inbox",
  term_status: { open: false, agentRunning: false, justLaunched: false },
  term_agent: "claude",
  chat_status: { running: false, hasSession: false, agent: "claude" },
  env_doctor: (() => { const c = { ok: false, detail: "", hint: "", fixable: false };
    return { git: c, gh: c, ghAuth: c, gitIdentity: { ...c, fixable: true }, remote: c,
             versioningEnabled: false, offline: false, account: "" }; })(),
  gh_pr_list: { prs: [], ageMs: 0 },
  loop_status: { loops: LOOPS, running: ["o-que-falta"], queued: ["atas-pendentes"],
                 cycles: [{ slug: "o-que-falta", startedMs: NOW - 160000 }], agentBusy: false, paralelo: 1,
                 permite: ["WebSearch"], recusa: [],
                 requests: [{ tool: "mcp__conector-do-time__ler", loops: ["atas-pendentes"], atMs: NOW - 1800000 }] },
  loop_tick: { started: [], queued: [], skipped: [] },
  loop_policy: { maxArquivos: 3, maxCiclosDia: 8, expiraDias: 30, paralelo: 1,
                 permite: ["WebSearch"], recusa: ["mcp__antigo__*"] },
  loop_folders: ["brainstorming", "brainstorming/lancamento-q3", "brainstorming/lancamento-q3/meetings",
                 "contexts", "contexts/produto", "inbox", "loops"],
  loop_capabilities: [
    { id: "WebFetch", label: "WebFetch", kind: "web", origin: "" },
    { id: "WebSearch", label: "WebSearch", kind: "web", origin: "" },
    { id: "mcp__conector-do-time__*", label: "conector-do-time", kind: "mcp", origin: "juridico-br" },
  ],
  brain_drop_into: ["brainstorming/lancamento-q3/attachments/relatorio.pdf"],
  loop_permit: { maxArquivos: 3, maxCiclosDia: 8, expiraDias: 30, paralelo: 1,
                 permite: ["WebSearch", "mcp__conector-do-time__ler"], recusa: [] },
  loop_set_policy: { maxArquivos: 3, maxCiclosDia: 8, expiraDias: 30, paralelo: 2 },
  loop_save: "loops/novo-teste.md",
  loop_arm: null, loop_delete: null, loop_stop: null, loop_run_now: null, loop_enrich: "instrução nova",
  brain_list_plugins: PLUGINS,
  brain_plugin_manifest: PREVIEW,
  brain_install_plugin: { id: "juridico-br", version: "1.2.0", written: [".claude/commands/loro-parecer.md"], skipped: [], brings: PREVIEW.brings },
  brain_remove_plugin: { removed: [".claude/commands/loro-parecer.md"], kept: ["loops/revisao-de-prazos.md"] },
  pick_folder: "/Users/x/Downloads/juridico-br",
  brain_topic_doc: "contexts/produto/context.md",
  brain_abs_path: "/tmp/acervo/x",
  client_log: null,
  ui_set_lang: "en",
  brain_resolve_ref: null,
  brain_annotations_get: { doc: "", anotacoes: [] },
  // ADR-0031 R5a — as extensões. A tela usa o board.json DE VERDADE do exemplo
  // (examples/extensions/hotspots-board), lido em tempo de geração deste arquivo:
  // um documento inventado aqui provaria o dublê, não o renderizador.
  ext_list: EXTS,
  get ext_view() {
    return { id: "hotspots-board", state: "running", view: EXT_DOC, facts: EXT_FACTS,
      servedMs: 0, source: "manifest", settings: Object.assign({}, EXT_SETTINGS) };
  },
  ext_preview: EXT_PREVIEW,
  ext_install: { id: "hotspots-board", version: "1.0.0", written: [".claude/commands/pontos-em-aberto.md"], skipped: [], trust: false },
  ext_remove: { removed: [".claude/commands/pontos-em-aberto.md"], kept: [], dataKept: false, dataDir: "" },
  ext_start: { ...EXTS[1], state: "running" },
  ext_stop: { ...EXTS[1], state: "stopped" },
  ext_action: { outcome: "ok", message: { pt: "marcado", en: "marked" }, invalidate: false },
  ext_settings_schema: [
    { id: "rotulo", kind: "string", escopo: "projeto", label: { pt: "título do quadro", en: "board title" }, default: "Pontos em aberto" },
    { id: "filtro", kind: "string", escopo: "maquina", label: { pt: "busca", en: "search" }, default: "" },
    { id: "mostrar_comentarios", kind: "bool", escopo: "projeto", label: { pt: "comentários", en: "comments" }, default: true },
    { id: "dica_de_uso", kind: "bool", escopo: "maquina", label: { pt: "dica de uso", en: "usage hint" }, default: true },
  ],
  get ext_settings_get() { return Object.assign({}, EXT_SETTINGS); },
  ext_capabilities: [{ id: "acervo.read:projeto", label: "acervo.read:projeto", kind: "acervo", decision: "", why: { pt: "para contar os pontos em aberto", en: "to count the open points" } }],
  ext_permit: { permite: {}, recusa: {} },
};
window.__SMOKE__.answers = ANSWERS;
window.__TAURI__ = {
  core: {
    invoke: (cmd, args) => {
      window.__SMOKE__.calls[cmd] = (window.__SMOKE__.calls[cmd] || 0) + 1;
      // O DISCO PODE MUDAR. brain_list_dir respondia sempre a mesma lista fixa, então
      // nenhum passo podia perguntar «um arquivo que nasceu aparece na árvore?» — que é
      // exatamente a pergunta do auto-reload. Agora ele lê de __SMOKE__.dirs, que o
      // roteiro altera.
      if (cmd === "brain_list_dir") {
        const rel = (args && args.rel) || "";
        return Promise.resolve(window.__SMOKE__.dirs[rel] || []);
      }
      if (cmd === "ext_settings_set") {
        Object.assign(EXT_SETTINGS, (args && args.values) || {});
        return Promise.resolve(Object.assign({}, EXT_SETTINGS));
      }
      // o prompt inteiro fica no registro: o passo do modal afirma sobre a
      // LINHA que chegou ao chat, não sobre o clique
      if (cmd === "chat_send") {
        (window.__SMOKE__.chat = window.__SMOKE__.chat || []).push(
          String((args && args.input && args.input.prompt) || ""));
        return Promise.resolve(null);
      }
      if (cmd in ANSWERS) return Promise.resolve(ANSWERS[cmd]);
      // (a tabela e exposta em __SMOKE__.answers: o roteiro muda UMA resposta para
      // perguntar «e quando o handle esta vivo?», como ja faz com dirs)
      return Promise.resolve(null);
    },
  },
  // O DUBLÊ GUARDA OS OUVINTES. Antes ele os jogava fora, e toda superfície movida por
  // EVENTO (os passos de um ciclo, o fim de um ciclo, o delta do chat) ficava fora do
  // alcance do smoke — verificada só por varredura de fonte. Com __SMOKE__.fire o
  // roteiro dispara o evento de verdade e mede o DOM que ele produz.
  event: {
    listen: (name, fn) => {
      (window.__SMOKE__.handlers[name] = window.__SMOKE__.handlers[name] || []).push(fn);
      return Promise.resolve(() => {});
    },
    emit: () => Promise.resolve(),
  },
  window: { getCurrentWindow: () => ({ onCloseRequested: () => {}, setFocus: () => {}, listen: () => Promise.resolve(() => {}) }) },
  webviewWindow: { getCurrentWebviewWindow: () => ({ listen: () => Promise.resolve(() => {}), onCloseRequested: () => {} }) },
};
</script>
`;

// o driver roda DEPOIS do app.js: exercita a superfície e escreve o resultado no title
const DRIVER = `
<script>
(async () => {
  const S = window.__SMOKE__;
  const STOP = ${JSON.stringify(process.env.SMOKE_STOP || "")};
  const seen = {};
  const q = (sel) => document.querySelector(sel);
  const vis = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  let stopped = false;
  const step = async (name, fn) => {
    if (stopped) return;
    try { await fn(); seen[name] = "ok"; }
    catch (e) { seen[name] = "THREW: " + (e && e.message || e); }
    await new Promise((r) => setTimeout(r, 60));
    // com SMOKE_STOP a captura mostra ESTE estado, em vez do fim do roteiro
    if (STOP && name === STOP) { stopped = true; document.title = "RESULT" + JSON.stringify({ steps: seen, errors: S.errors.slice(0, 12), calls: Object.keys(S.calls).length }); }
  };
  await new Promise((r) => setTimeout(r, 900));   // deixa o boot correr

  await step("boot", async () => {
    if (!q("#brainShell")) throw new Error("sem casco");
    // o cartão de primeiro uso cobre a tela num ambiente sem preferências
    // guardadas (ele é a folha única do app): dispensá-lo é parte de chegar ao
    // estado que se quer medir
    if (!q("#pmWrap").hidden && /Bem-vindo|Welcome/.test(q("#pmTitle").textContent)) q("#pmConfirm").click();
    await new Promise((r) => setTimeout(r, 150));
  });
  await step("sidebar-loops", async () => {
    await window.refreshLoops(true);
    const rows = document.querySelectorAll("#navLoops [data-loop]");
    if (rows.length !== 3) throw new Error("linhas: " + rows.length);
    const txt = q("#navLoops").textContent;
    for (const w of ["o-que-falta", "rodando", "atas-pendentes", "impedido", "radar", "desligado"]) {
      if (!txt.includes(w)) throw new Error("falta “" + w + "” na árvore");
    }
    // O NOME É A IDENTIDADE, e a linha tem 225px: ícone/seta + nome + estado + ponto + ⋯.
    // Quando a seta de «o que este loop produziu» foi acrescentada ela custou 22px e o
    // nome caiu de 80 para 59 precisando de 69 (medido) — por isso ela ocupa o lugar do
    // ícone, e não um lugar novo. Este piso é o que impede o próximo controle de comer o
    // nome em silêncio.
    for (const r of document.querySelectorAll("#navLoops [data-loop]")) {
      const nm = r.querySelector(".bn");
      const w = nm.getBoundingClientRect().width;
      if (w < 70) throw new Error("o nome do loop “" + nm.textContent + "” ficou com " + Math.round(w) + "px");
    }
  });
  // O cabeçalho tem DUAS marcas agora (gravação e loops), as duas flex:none. A
  // regra 8 do DESIGN.md §2 diz que ele cede prosa e decoração antes de encostar
  // num controle — então a sobreposição é medida aqui, no DOM real, com o conteúdo
  // real (o measure-header.js mede o cabeçalho isolado).
  await step("header-sem-sobreposicao", async () => {
    const nav = q("#destNav").getBoundingClientRect();
    const rightEl = q(".headright");
    const right = rightEl.getBoundingClientRect();
    const left = q("#acervoSwitch").getBoundingClientRect();
    // A CAIXA do bloco direito mente: com justify-content: flex-end, o conteúdo que
    // não cabe sai pelo INÍCIO — a caixa fica onde estava e o primeiro filho aparece
    // à esquerda dela, por baixo do nav (que é absoluto e centrado). O que se mede é
    // a extensão do CONTEÚDO.
    const kids = [...rightEl.children].filter((el) => !el.hidden && el.getBoundingClientRect().width > 0);
    const conteudoEsq = Math.min(right.left, ...kids.map((el) => el.getBoundingClientRect().left));
    const dir = nav.right - conteudoEsq, esq = left.right - nav.left;
    S.header = { nav: [Math.round(nav.left), Math.round(nav.right)], right: [Math.round(conteudoEsq), Math.round(right.right)],
                 left: [Math.round(left.left), Math.round(left.right)], pill: (() => { const p = q("#headLoops"); const b = p.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), p.hidden]; })() };
    if (dir > 0 || esq > 0) {
      throw new Error("colisão no cabeçalho: à direita " + Math.round(dir) + "px, à esquerda " + Math.round(esq) + "px");
    }
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) throw new Error("o cabeçalho empurra a página de lado");
  });

  await step("header-pill", async () => {
    const pill = q("#headLoops");
    if (pill.hidden) throw new Error("a marca não apareceu com um ciclo rodando");
    if (!/rodando/.test(pill.textContent)) throw new Error("texto: " + pill.textContent);
    if (q("#ptabLoopsN").hidden) throw new Error("a contagem da aba não apareceu");
  });
  await step("panel-loops", async () => {
    window.openLoopsPanel();
    if (!vis(q("#panelLoops"))) throw new Error("o painel não abriu");
    // §4.18 — o PEDIDO aparece aqui, com o nome da ferramenta e as duas respostas
    const reqs = q("#pLoopReqs");
    if (reqs.hidden) throw new Error("a seção de pedidos não apareceu");
    const card = q("#pLoopReqList .preq");
    if (!card) throw new Error("o pedido não foi desenhado");
    if (!/mcp__conector-do-time__ler/.test(card.textContent)) throw new Error("o pedido não nomeia a ferramenta");
    if (!/atas-pendentes/.test(card.textContent)) throw new Error("o pedido não diz de qual loop veio");
    if (!card.querySelector("[data-reqok]") || !card.querySelector("[data-reqno]")) {
      throw new Error("o pedido não oferece as duas respostas");
    }
    if (!/todos os loops deste projeto/.test(reqs.textContent)) throw new Error("não diz a escala da concessão");
    // e o cartão n\u00e3o transborda a coluna do painel
    const cb = card.getBoundingClientRect(), pb = q("#panelLoops").getBoundingClientRect();
    if (cb.right > pb.right + 1) throw new Error("o pedido transborda o painel");
    card.querySelector("[data-reqok]").click();
    await new Promise((r) => setTimeout(r, 300));
    if (!window.__SMOKE__.calls.loop_permit) throw new Error("permitir não chamou o backend");
    const rows = document.querySelectorAll("#pLoopsList [data-watch]");
    if (rows.length !== 2) throw new Error("linhas do painel: " + rows.length);
    rows[1].click();
  });
  // O ciclo QUIETO é o que mais precisa de explicação e era o único que não abria: a
  // pessoa mandava rodar, o ciclo lia sete documentos e a tela mostrava uma linha cinza
  // sem nada por trás (medido no acervo do dono, 2026-08-18).
  await step("ciclo-quieto-abre-e-explica", async () => {
    await window.openLoop("o-que-falta");
    await new Promise((r) => setTimeout(r, 250));
    const rows = [...q("#brainDoc .loopcycles").children];
    if (!rows.length) throw new Error("sem linhas de ciclo");
    for (const r of rows) {
      if (r.tagName !== "DETAILS") throw new Error("uma linha de ciclo não abre: " + r.className);
    }
    const quieto = rows.find((r) => /nada novo/.test(r.textContent));
    if (!quieto) throw new Error("sem linha de ciclo quieto");
    quieto.open = true;
    await new Promise((r) => setTimeout(r, 60));
    if (!/não achou o que acrescentar/.test(quieto.textContent)) {
      throw new Error("o ciclo quieto abriu e não explicou: " + quieto.textContent.trim().slice(0, 120));
    }
    // e o corpo não transborda o cartão
    const card = q("#brainDoc").closest(".doccard") || q("#brainDoc");
    const cb = card.getBoundingClientRect(), rb = quieto.getBoundingClientRect();
    if (rb.right > cb.right + 1) throw new Error("a linha do ciclo transborda o cartão");
  });

  // §4.18 — UMA RECUSA DE PERMISSÃO NUM PASSO tem nome e ação, e um passo que só falhou
  // mostra o motivo. Antes os dois eram o mesmo «!» mudo: um Read numa pasta (EISDIR)
  // era indistinguível de uma recusa, e a pessoa concluía que faltava permissão — pelo
  // que a tela dava, corretamente (relatado 2026-08-18). Exercitado pelo EVENTO real.
  await step("passo-recusado-tem-nome-e-acao", async () => {
    window.openLoopsPanel();
    await new Promise((r) => setTimeout(r, 120));
    // o painel mostra os passos do ciclo SELECIONADO: um passo-a-passo de outro loop é de
    // outro loop (a regra que o LP.stepsFor existe para manter)
    const linha = [...document.querySelectorAll("#pLoopsList [data-watch]")]
      .find((r) => r.dataset.watch === "o-que-falta");
    if (!linha) throw new Error("sem a linha do loop no painel");
    linha.click();
    await new Promise((r) => setTimeout(r, 120));
    const S2 = window.__SMOKE__;
    if (!S2.handlers["loop-tool"]) throw new Error("o app não ouve loop-tool");
    S2.fire("loop-cycle", { slug: "o-que-falta", phase: "started", startedMs: Date.now() });
    S2.fire("loop-tool", { id: "t1", name: "Read", input: '{"file_path":"/x/pasta"}', loop: "o-que-falta" });
    S2.fire("loop-tool-result", { id: "t1", isError: true, permission: false,
      text: "EISDIR: illegal operation on a directory, read '/x/pasta'", loop: "o-que-falta" });
    S2.fire("loop-tool", { id: "t2", name: "mcp__conector-do-time__ler", input: "{}", loop: "o-que-falta" });
    S2.fire("loop-tool-result", { id: "t2", isError: true, permission: true,
      text: "requested permissions to use mcp__conector-do-time__ler", loop: "o-que-falta" });
    await new Promise((r) => setTimeout(r, 200));
    const steps = q("#pLoopSteps");
    // 1 · o passo que só falhou MOSTRA O MOTIVO
    if (!/EISDIR/.test(steps.textContent)) throw new Error("a resposta do passo não aparece: " + steps.textContent.slice(0, 160));
    // 2 · o passo recusado por permissão DIZ que é permissão, e oferece a decisão
    if (!/faltou permissão/.test(steps.textContent)) throw new Error("a recusa não se identifica");
    const btn = steps.querySelector("[data-stepperm]");
    if (!btn) throw new Error("a recusa não oferece permitir");
    if (btn.dataset.stepperm !== "mcp__conector-do-time__ler") throw new Error("libera outra coisa: " + btn.dataset.stepperm);
    // 3 · e os dois não se confundem: só um deles é uma pergunta
    if (steps.querySelectorAll(".stepperm").length !== 1) {
      throw new Error("passos com pergunta: " + steps.querySelectorAll(".stepperm").length);
    }
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    if (!S2.calls.loop_permit) throw new Error("permitir no passo não decidiu nada");
  });

  // E o fim de um ciclo que a PESSOA mandou rodar diz o que aconteceu — era silêncio
  // em «ok» e em «nada novo», e só falava em falha.
  await step("rodar-agora-diz-o-que-aconteceu", async () => {
    const S2 = window.__SMOKE__;
    const antes = document.querySelectorAll(".toast, #toast").length;
    await window.runLoopNow("o-que-falta");
    await new Promise((r) => setTimeout(r, 150));
    S2.fire("loop-cycle", { slug: "o-que-falta", phase: "ended", outcome: "nothing", err: null, files: [], startedMs: Date.now() });
    await new Promise((r) => setTimeout(r, 200));
    const txt = document.body.textContent;
    if (!/nada novo/.test(txt)) throw new Error("o fim do ciclo não foi dito");
    if (!/não achou o que acrescentar/.test(txt)) throw new Error("disse «nada novo» sem explicar");
    void antes;
  });

  // «Os arquivos gerados não estão aparecendo em auto reload na árvore lateral» (dono,
  // 2026-08-18). Exercitado ponta a ponta: expande o loop, um arquivo nasce no disco, o
  // ciclo termina — e a árvore mostra o arquivo SEM ninguém clicar em nada.
  await step("arquivo-novo-aparece-na-arvore-sozinho", async () => {
    const S2 = window.__SMOKE__;
    const seta = q('#navLoops [data-looptoggle="o-que-falta"]');
    if (!seta) throw new Error("a linha do loop não abre");
    seta.click();
    await new Promise((r) => setTimeout(r, 250));
    const holder = [...document.querySelectorAll("#navLoops [data-loopchild]")]
      .find((h) => h.dataset.loopchild === "o-que-falta");
    if (!holder || holder.hidden) throw new Error("o corpo do loop não apareceu");
    if (!/nada produzido ainda/.test(holder.textContent)) {
      throw new Error("um loop sem saída não diz isso: " + holder.textContent.trim().slice(0, 80));
    }
    // o ciclo produz: o arquivo passa a existir no disco…
    S2.dirs["loops/o-que-falta"] = [
      { name: "decidir.md", path: "loops/o-que-falta/decidir.md", dir: false },
    ];
    // …e o fim do ciclo é o que a tela ouve
    S2.fire("loop-cycle", { slug: "o-que-falta", phase: "ended", outcome: "ok", err: null,
      files: ["loops/o-que-falta/decidir.md"], startedMs: Date.now() });
    await new Promise((r) => setTimeout(r, 600));
    const depois = [...document.querySelectorAll("#navLoops [data-loopchild]")]
      .find((h) => h.dataset.loopchild === "o-que-falta");
    if (!/decidir\.md/.test(depois.textContent)) {
      throw new Error("o arquivo não apareceu sozinho: " + depois.textContent.trim().slice(0, 100));
    }
    const linha = depois.querySelector("[data-doc]");
    if (!linha || linha.dataset.doc !== "loops/o-que-falta/decidir.md") {
      throw new Error("o arquivo não abre como documento");
    }
    // §8.5 — e o arquivo tem o ⋯ de um documento comum: mover, copiar caminho, apagar
    const menu = depois.querySelector("[data-artmenu]");
    if (!menu) throw new Error("o arquivo do loop não tem o ⋯ de documento comum");
    menu.click();
    await new Promise((r) => setTimeout(r, 250));
    const flut = q("#bMenu");
    if (!flut || flut.hidden) throw new Error("o ⋯ do arquivo não abriu");
    for (const w of ["mover para", "copiar caminho", "apagar", "renomear"]) {
      if (!new RegExp(w, "i").test(flut.textContent)) {
        throw new Error("o menu não oferece “" + w + "”: " + flut.textContent.replace(/\s+/g, " ").slice(0, 120));
      }
    }
    if (!flut.querySelector("[data-mv]") || !flut.querySelector("[data-del]")) {
      throw new Error("o menu do arquivo do loop não é o menu comum");
    }
    document.body.click();
    await new Promise((r) => setTimeout(r, 120));
    // e o clique na LINHA continua abrindo o documento (o ⋯ é dele, não da linha)
    if (!/decidir\.md/.test(depois.textContent)) throw new Error("a linha se perdeu");

    // e o TIQUE também pega, sem evento nenhum (um ciclo automático de outra janela)
    S2.dirs["loops/o-que-falta"].push({ name: "outro.md", path: "loops/o-que-falta/outro.md", dir: false });
    await window.refreshLoops(false);
    await new Promise((r) => setTimeout(r, 250));
    const tarde = [...document.querySelectorAll("#navLoops [data-loopchild]")]
      .find((h) => h.dataset.loopchild === "o-que-falta");
    if (!/outro\.md/.test(tarde.textContent)) {
      throw new Error("o repintar por assinatura não viu o arquivo novo");
    }
    seta.click();
  });

  // ADR-0028 (extensão de 2026-08-18) — ARRASTAR DO COMPUTADOR PARA UMA PASTA DA ÁRVORE.
  // Exercitado pelo evento real do Tauri, com a POSIÇÃO da linha de verdade: é
  // elementFromPoint quem decide o destino, então medir a linha é a única forma de saber
  // que o solto cai onde a pessoa mirou.
  await step("soltar-do-computador-numa-pasta-da-arvore", async () => {
    const S2 = window.__SMOKE__;
    // as TRÊS famílias de pasta se oferecem: uma ideia, um tema do conhecimento e um loop
    // — mais os grupos de pasta de dentro de uma ideia, que existem quando ela está aberta
    const linhaTema = q('#navPessoal [data-tema][data-dropdir]');
    const linhaCtx = q('#navCtx [data-ctx][data-dropdir]');
    const linhaLoop = q('#navLoops [data-loop][data-dropdir]');
    for (const [nome, el] of [["ideia", linhaTema], ["conhecimento", linhaCtx], ["loop", linhaLoop]]) {
      if (!el) throw new Error("a linha de " + nome + " não se oferece como destino de solto");
    }
    if (linhaTema.dataset.dropdir !== "brainstorming/lancamento-q3/attachments") {
      throw new Error("a ideia arquiva no lugar errado: " + linhaTema.dataset.dropdir);
    }
    // endsWith, e não regex: dentro do template literal do DRIVER a barra escapada colapsa
    // e a expressão virava um comentário, que derrubava o script todo
    if (!linhaCtx.dataset.dropdir.endsWith("/attachments")) {
      throw new Error("o tema arquiva fora dos anexos: " + linhaCtx.dataset.dropdir);
    }
    linhaTema.click();   // abre a ideia: os grupos de pasta nascem aí
    await new Promise((r) => setTimeout(r, 400));
    const grupo = q('#navPessoal [data-pestoggle][data-dropdir]');
    if (!grupo) throw new Error("um grupo de pasta (notas/anexos) não se oferece como destino");
    const row = q('#navPessoal [data-tema][data-dropdir]');
    if (!row) throw new Error("nenhuma pasta da árvore se oferece como destino");
    const b = row.getBoundingClientRect();
    const pos = { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    // 1 · o realce acende NA LINHA, e não na fila
    S2.fire("tauri://drag-over", { position: pos, paths: [] });
    await new Promise((r) => setTimeout(r, 80));
    if (!row.classList.contains("droprow")) throw new Error("a pasta não acende como destino");
    if (document.getElementById("app").classList.contains("dropping")) {
      throw new Error("o realce da fila acendeu prometendo o destino errado");
    }
    // 2 · o solto vai para a porta que ARQUIVA (move), com a pasta certa
    S2.fire("tauri://drag-drop", { position: pos, paths: ["/Users/x/Desktop/relatorio.pdf"] });
    await new Promise((r) => setTimeout(r, 400));
    if (!S2.calls.brain_drop_into) throw new Error("o solto não chamou a porta de arquivar");
    if (S2.calls.brain_import_paths) throw new Error("foi para a FILA: o lugar não decidiu");
    const txt = document.body.textContent;
    if (!/o original saiu de/.test(txt)) throw new Error("a tela não disse que o original saiu");
    // 3 · e o realce apaga depois do solto
    if (row.classList.contains("droprow")) throw new Error("o realce ficou aceso");
  });

  await step("loop-screen-view", async () => {
    await window.openLoop("o-que-falta");
    const doc = q("#brainDoc");
    if (!vis(doc)) throw new Error("o documento não apareceu");
    for (const w of ["instrução efetiva", "rodar agora", "ciclos", "ajustar conversando", "×2"]) {
      if (!doc.textContent.includes(w)) throw new Error("falta “" + w + "” na tela");
    }
    if (!q("#bModes") || q("#bModes").hidden) throw new Error("sem visualizar/editar");
    if (!doc.querySelector("[data-lrun]")) throw new Error("sem a ação primária");
  });
  await step("loop-screen-edit", async () => {
    await window.setActiveMode("edit");
    const doc = q("#brainDoc");
    if (!doc.querySelector("[data-f='titulo']")) throw new Error("o formulário não abriu");
    if (!doc.querySelector("[data-lsave]")) throw new Error("sem salvar");
    // trocar o ritmo repinta o formulário
    const seg = doc.querySelector("[data-seg='dia']");
    if (!seg) throw new Error("sem o segmentado do ritmo");
    seg.click();
    if (!q("#brainDoc").querySelector("[data-f='hora']")) throw new Error("o repintar perdeu o campo de hora");
    await window.setActiveMode("view");
  });
  await step("loop-blocked-screen", async () => {
    await window.openLoop("atas-pendentes");
    const txt = q("#brainDoc").textContent;
    if (!/impedido/.test(txt)) throw new Error("não diz que está impedido");
    if (/próxima execução/.test(txt)) throw new Error("prometeu uma próxima execução estando impedido");
    if (!/não rodou 2 vez/.test(txt)) throw new Error("não contou as janelas perdidas");
    // §4.17 — um impedimento de permissão NOMEIA a ferramenta e oferece a ação. Sem
    // isto a tela dizia «faltou permissão» e a pessoa não tinha para onde ir.
    if (!/mcp__conector-do-time__ler/.test(txt)) throw new Error("não disse QUAL ferramenta faltou");
    const allow = q("#brainDoc [data-lallow]");
    if (!allow) throw new Error("não ofereceu permitir neste loop");
    if (allow.dataset.lallow !== "mcp__conector-do-time__ler") throw new Error("o botão libera outra coisa: " + allow.dataset.lallow);
    allow.click();
    await new Promise((r) => setTimeout(r, 300));
    if (!window.__SMOKE__.calls.loop_permit) throw new Error("permitir não chamou o backend");
  });

  // §4.17 — e permitir NÃO depende de uma recusa: o controle está na tela, ao lado das
  // ações, em qualquer loop (o dono não achou o botão porque ele só existia no editar).
  await step("permitir-e-um-controle-da-tela", async () => {
    await window.openLoop("radar");   // um loop sem impedimento nenhum
    await new Promise((r) => setTimeout(r, 200));
    const btn = q("#brainDoc [data-lperms]");
    if (!btn) throw new Error("a tela do loop não oferece «pode usar»");
    if (!/pode usar/.test(btn.textContent)) throw new Error("rótulo: " + btn.textContent);
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
    const menu = q("#bMenu");
    if (!menu || menu.hidden) throw new Error("o menu não abriu");
    const itens = [...menu.querySelectorAll("[data-lcap]")];
    if (itens.length !== 3) throw new Error("itens do menu: " + itens.length);
    if (!/conector-do-time/.test(menu.textContent)) throw new Error("o conector do projeto não está no menu");
    if (/tudo, sem perguntar»?\s*$/.test(menu.textContent) === false && !/não são de um ciclo/.test(menu.textContent)) {
      throw new Error("o menu não diz o que nunca é oferecido");
    }
    // e o NOME DO CONECTOR não é cortado: .fn é nowrap+ellipsis na coluna de 196px,
    // e o corte escondia justamente qual conector é (DESIGN.md §2.9)
    for (const it of itens) {
      const fn = it.querySelector(".fn");
      if (fn.scrollWidth > fn.clientWidth + 1) {
        throw new Error("nome de conector cortado no menu: “" + fn.textContent + "” pede " +
          fn.scrollWidth + "px em " + fn.clientWidth + "px");
      }
    }
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth - 1 || box.left < 1) throw new Error("o menu saiu da janela");
    itens[0].click();
    await new Promise((r) => setTimeout(r, 300));
    if (!window.__SMOKE__.calls.loop_permit) throw new Error("o menu não decidiu nada");
  });

  // §3.9 — «impedido» e «falhou» são fatos diferentes, e o histórico dizia «falhou»
  // para um ciclo parado por uma pergunta que só a pessoa responde.
  await step("ciclo-impedido-nao-le-como-falha", async () => {
    await window.openLoop("atas-pendentes");
    await new Promise((r) => setTimeout(r, 200));
    const ciclos = q("#brainDoc .loopcycles");
    if (!ciclos) throw new Error("sem a lista de ciclos");
    if (/falhou|failed/.test(ciclos.textContent)) throw new Error("o ciclo impedido lê como falha: " + ciclos.textContent.trim().slice(0, 120));
    if (!/impedido|blocked/.test(ciclos.textContent)) throw new Error("não diz que ficou impedido: " + ciclos.textContent.trim().slice(0, 120));
    const dot = q("#brainDoc .looptl .ldot.amber");
    if (!dot) throw new Error("a bolinha do ciclo impedido não é âmbar (era cinza, o tom de «não faz nada»)");
  });
  await step("new-loop", async () => {
    await window.openNewLoop();
    const doc = q("#brainDoc");
    if (!doc.querySelector("[data-f='titulo']")) throw new Error("a tela do novo loop não abriu");
    if (!doc.textContent.includes("o preço, dito agora")) throw new Error("sem o preço");
    if (!doc.querySelector("[data-lsaveoff]")) throw new Error("sem «criar desligado»");
    doc.querySelector("[data-f='titulo']").value = "resumo-semanal";
    doc.querySelector("[data-f='titulo']").dispatchEvent(new Event("input"));
  });
  // GEOMETRIA — um fecha-div no lugar de um fecha-label aninha o resto da tela
  // dentro de um flex e o formulário sai deitado, transbordando o cartão. Nenhuma
  // asserção de conteúdo vê isso; medir vê.
  await step("new-loop-geometry", async () => {
    const doc = q("#brainDoc");
    const card = doc.closest(".doccard") || doc;
    const cb = card.getBoundingClientRect();
    const rows = [...doc.querySelectorAll(".loopfield")];
    if (rows.length < 6) throw new Error("linhas de campo: " + rows.length);
    let prev = -1;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (b.top <= prev) throw new Error("os campos não empilham (um deles em cima do outro)");
      if (b.right > cb.right + 1 || b.left < cb.left - 1) {
        throw new Error("campo fora do cartão: " + Math.round(b.left) + "–" + Math.round(b.right) +
          " contra " + Math.round(cb.left) + "–" + Math.round(cb.right));
      }
      if (b.width < 200) throw new Error("linha estreita demais: " + Math.round(b.width) + "px");
      prev = b.top;
    }
    // o controle de cada linha tem largura de controle, não de sobra
    for (const sel of ["[data-f='titulo']", "[data-f='habilidade']", "[data-f='instrucao']", "[data-f='destino']"]) {
      const w = doc.querySelector(sel).getBoundingClientRect().width;
      if (w < 150) throw new Error(sel + " tem " + Math.round(w) + "px");
    }
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) {
      throw new Error("a página rola de lado: " + de.scrollWidth + " > " + de.clientWidth);
    }
    // a hora e a data usam o seletor do sistema
    if (!doc.querySelector('input[type="time"][data-f="hora"]')) throw new Error("a hora não é um seletor de hora");
    if (!doc.querySelector('input[type="date"][data-f="expira"]')) throw new Error("a data não é um seletor de data");
    // e a LINHA COM DOIS CONTROLES (escopo → uma ideia; ritmo → dias + hora) não
    // transborda: era o caso que sobrava depois do formulário empilhar
    doc.querySelector('[data-seg="ideia"]').click();
    await new Promise((r) => setTimeout(r, 120));
    const doc2 = q("#brainDoc");
    const cb2 = (doc2.closest(".doccard") || doc2).getBoundingClientRect();
    for (const row of doc2.querySelectorAll(".looprow")) {
      const b = row.getBoundingClientRect();
      if (b.right > cb2.right + 1) {
        throw new Error("linha de dois controles transborda: " + Math.round(b.right) + " > " + Math.round(cb2.right));
      }
      for (const c of row.children) {
        const cbx = c.getBoundingClientRect();
        if (cbx.right > cb2.right + 1) throw new Error("um controle da linha sai do cartão: " + Math.round(cbx.right));
      }
    }
  });
  // §4.15/§4.16 — os campos novos existem na tela de verdade, e o escopo apontado
  // deixa ESCREVER (o campo) ou ESCOLHER (a lista de pastas do projeto).
  await step("new-loop-modelo-esforco-e-escopo-apontado", async () => {
    await window.openNewLoop();
    await new Promise((r) => setTimeout(r, 150));
    const doc = q("#brainDoc");
    for (const sel of ["[data-f='modelo']", "[data-f='esforco']"]) {
      const el = doc.querySelector(sel);
      if (!el) throw new Error("falta " + sel);
      if (!/padrão do agente/.test(el.textContent)) throw new Error(sel + " não oferece o padrão: " + el.textContent);
    }
    if (!/opus/.test(doc.querySelector("[data-f='modelo']").textContent)) throw new Error("sem os modelos");
    doc.querySelector("[data-seg='pasta']").click();
    await new Promise((r) => setTimeout(r, 150));
    const d2 = q("#brainDoc");
    const campo = d2.querySelector("[data-f='escopoPasta']");
    if (!campo) throw new Error("o campo da pasta não apareceu");
    const list = d2.querySelector("#loopScopeDirs");
    if (!list || list.options.length < 3) throw new Error("as pastas do projeto não foram sugeridas");
    if (!/lê SÓ o que está aí dentro/.test(d2.textContent)) throw new Error("a tela não diz que ele lê só aquilo");
    // e o campo tem largura de CAMPO (um caminho não cabe em 64px)
    if (campo.getBoundingClientRect().width < 150) {
      throw new Error("o campo da pasta tem " + Math.round(campo.getBoundingClientRect().width) + "px");
    }
    d2.querySelector("[data-seg='conhecimento']").click();
    await new Promise((r) => setTimeout(r, 150));
    if (!q("#brainDoc").querySelector("[data-f='escopoCtx']")) throw new Error("o seletor de conhecimento não apareceu");
  });

  // §4.18 — O FORMULÁRIO NÃO PEDE PERMISSÃO DE ANTEMÃO. As permissões são ilimitadas e
  // não-enumeráveis: quem declara antes declara o que não sabe. A concessão acontece no
  // PEDIDO (painel) e vale para o projeto — então criar um loop não tem essa pergunta.
  await step("new-loop-nao-pergunta-permissao-antes", async () => {
    await window.openNewLoop();
    await new Promise((r) => setTimeout(r, 200));
    const doc = q("#brainDoc");
    if (doc.querySelector("[data-perm]")) throw new Error("o formulário voltou a declarar permissão de antemão");
    if (/pode usar/.test(doc.textContent)) throw new Error("o formulário fala de permissão: isso é do projeto agora");
    // e o que ele PEDE continua lá
    for (const sel of ["[data-f='titulo']", "[data-f='modelo']", "[data-f='esforco']", "[data-f='destino']"]) {
      if (!doc.querySelector(sel)) throw new Error("falta " + sel);
    }
  });

  // DESIGN.md §2.9 — UM CONTROLE NUNCA É CORTADO. O defeito real (2026-08-18): numa
  // janela de ~1040px com o painel aberto, a coluna do controle fica com ~200px e o
  // segmentado do ritmo — que é UM filho do .looprow, e portanto não quebrava —
  // somava ~260px e saía do cartão pela direita, com «toda semana» cortada por baixo
  // do painel. Estreitar o cartão aqui é a mesma coluna, medida sem depender do
  // tamanho da janela do teste.
  await step("ritmo-nao-corta-numa-coluna-estreita", async () => {
    await window.openNewLoop();
    await new Promise((r) => setTimeout(r, 150));
    const card = q("#brainDoc").closest(".doccard") || q("#brainDoc");
    card.style.maxWidth = "430px";
    const fora = [];
    for (const kind of ["min", "dia", "semana"]) {
      q("#brainDoc").querySelector("[data-seg='" + kind + "']").click();
      await new Promise((r) => setTimeout(r, 120));
      const doc = q("#brainDoc");
      const cb = (doc.closest(".doccard") || doc).getBoundingClientRect();
      for (const row of doc.querySelectorAll(".looprow")) {
        for (const c of [row, ...row.children, ...row.querySelectorAll(".segbtn, input, select")]) {
          const b = c.getBoundingClientRect();
          if (b.width > 0 && b.right > cb.right + 1) {
            fora.push(kind + ": " + (c.className || c.tagName) + " termina em " + Math.round(b.right) +
              " e o cartão em " + Math.round(cb.right));
          }
        }
      }
    }
    card.style.maxWidth = "";
    if (fora.length) throw new Error("cortado: " + fora.slice(0, 4).join(" · "));
  });

  await step("install-sheet", async () => {
    // PELO BOTÃO, como uma pessoa abre. Este passo chamava openInstallPlugin() direto, e
    // então o único elo que a pessoa usa — o clique em «instalar plugin…» de
    // Configurações → Plugins — nunca era exercitado (relatado 2026-08-18 como «não
    // funciona»: a função estava certa, e o elo não tinha cobertura).
    await window.openCfgPlugins();
    await new Promise((r) => setTimeout(r, 250));
    const abrir = q("#cfgInstallPlugin");
    if (!abrir) throw new Error("Configurações → Plugins não tem o botão de instalar");
    if (abrir.getBoundingClientRect().height <= 0) throw new Error("o botão de instalar não está visível");
    abrir.click();
    await new Promise((r) => setTimeout(r, 300));
    // ESTAR ABERTA NÃO É ESTAR VISÍVEL. A folha vinha em z-index 40 e Configurações em 45:
    // aberta de dentro dela, a folha nascia ATRÁS — hidden false, altura > 0, e o centro
    // dela devolvendo .cfgcard. Os botões inalcançáveis, e o gesto lido como «clico e não
    // acontece nada» (2026-08-18). A ordem de PINTURA é o que se mede.
    const folha = q("#pmWrap .sheet") || q("#pmWrap");
    const fb = folha.getBoundingClientRect();
    const noTopo = document.elementFromPoint(Math.round(fb.left + fb.width / 2), Math.round(fb.top + fb.height / 2));
    if (!noTopo || !q("#pmWrap").contains(noTopo)) {
      throw new Error("a folha abriu ATRÁS de algo: no centro dela está " +
        (noTopo ? noTopo.tagName + "." + String(noTopo.className).slice(0, 30) : "nada"));
    }
    if (!vis(q("#pmWrap"))) throw new Error("a folha não abriu: hidden=" + q("#pmWrap").hidden);
    if (q("#pmTitle").textContent !== "Instalar plugin") throw new Error("título: " + q("#pmTitle").textContent);
    q("#plugPick").click();
    await new Promise((r) => setTimeout(r, 200));
    const prev = q("#plugPrev").textContent;
    for (const w of ["juridico-br", "/loro-parecer", "revisao-de-prazos", "CPF"]) {
      if (!prev.includes(w)) throw new Error("o preview não diz “" + w + "”");
    }
    // o campo do caminho tem largura de CAMPO: com 78px (a regra do span filho de
    // .wfield) ele ficava sem espaço para mostrar o que a pessoa digita
    const dw = q("#plugDir").getBoundingClientRect().width;
    if (dw < 150) {
      const r = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.left) + "–" + Math.round(b.right) + " (" + Math.round(b.width) + ")"; };
      throw new Error("o campo do caminho tem " + Math.round(dw) + "px | linha " + r(q("#plugDir").closest(".wfield")) +
        " | rótulo " + r(q("#plugDir").closest(".wfield").firstElementChild) +
        " | dirpick " + r(q("#plugDir").closest(".dirpick")) + " | botão " + r(q("#plugPick")) +
        " | folha " + r(q("#pmWrap .sheet")));
    }
    const box = q("#plugDir").closest(".dirpick").getBoundingClientRect();
    const sheet = q("#pmWrap .sheet").getBoundingClientRect();
    if (box.right > sheet.right + 1) throw new Error("o seletor de pasta transborda a folha");
  });
  // O PRIMÁRIO RESPONDE: com o campo vazio ele recusa DENTRO da folha (a folha não
  // fecha e o motivo aparece); com um caminho, ele instala.
  await step("install-primary", async () => {
    q("#plugDir").value = "";
    q("#pmConfirm").click();
    await new Promise((r) => setTimeout(r, 250));
    if (q("#pmWrap").hidden) throw new Error("a folha fechou numa recusa");
    if (q("#pmErr").hidden) throw new Error("recusou em silêncio: o motivo não apareceu");
    if (!/pasta/.test(q("#pmErrMsg").textContent)) throw new Error("motivo: " + q("#pmErrMsg").textContent);
    q("#plugDir").value = "/Users/x/Downloads/juridico-br";
    q("#pmConfirm").click();
    await new Promise((r) => setTimeout(r, 400));
    if (!window.__SMOKE__.calls.brain_install_plugin) throw new Error("o install não foi chamado");
    if (!q("#pmWrap").hidden) throw new Error("o sucesso tem de fechar a folha");
  });
  await step("cfg-plugins", async () => {
    try { await window.openCfgPlugins(); } catch (e) { throw new Error("openCfgPlugins lançou: " + e.message + " | " + (e.stack||"").split("\\n")[1]); }
    if (!vis(q("#cfgWrap"))) throw new Error("Configurações não abriu: hidden=" + q("#cfgWrap").hidden);
    await new Promise((r) => setTimeout(r, 200));
    const list = q("#pluginList").textContent;
    if (!list.includes("juridico-br")) throw new Error("a lista não tem o plugin");
    if (!list.includes("1 loop(s)")) throw new Error("não diz o que trouxe: " + list);
    if (!q("#pluginList [data-pluginmenu]")) throw new Error("sem o ⋯ da linha");
  });
  // ADR-0022 §24b — o interruptor do microfone nas reuniões existe, nasce LIGADO e o
  // empurrão do eco escreve nele. O que resolve o eco é uma escolha da pessoa, e ela tem
  // de aparecer no controle (senão a tela e o ajuste discordam).
  await step("cfg-microfone-nas-reunioes", async () => {
    window.showCfgSection("cap");
    await new Promise((r) => setTimeout(r, 250));
    const mm = q("#optMeetingMic");
    if (!mm) throw new Error("Captura não tem o interruptor do microfone nas reuniões");
    if (!mm.checked) throw new Error("ele nasce DESLIGADO: com fone não há eco, e a sua voz é metade da análise");
    const secao = mm.closest(".cfgcard").textContent;
    if (!/uma trilha/.test(secao)) throw new Error("a dica não diz o que desligar significa");
    // desligar escreve no ajuste, e o pintor único devolve o estado
    mm.checked = false;
    mm.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 150));
    window.paintCaptureSettings();
    await new Promise((r) => setTimeout(r, 80));
    if (q("#optMeetingMic").checked) throw new Error("o pintor desfez a escolha da pessoa");
    mm.checked = true;
    mm.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 120));
  });

  await step("cfg-loops", async () => {
    // sem rolar nem realçar: um campo de limite vazio afirma «sem limite»
    for (const id of ["cfgLoopFiles", "cfgLoopRuns", "cfgLoopDays"]) {
      if (!q("#" + id).value) throw new Error("#" + id + " está vazio antes do realce");
    }
    // e o botão tem a largura do seu rótulo, não a da coluna
    const bb = q("#cfgInstallPlugin").getBoundingClientRect();
    const col = q("#cfgInstallPlugin").closest(".field").getBoundingClientRect();
    if (bb.width > col.width * 0.6) throw new Error("o botão esticou: " + Math.round(bb.width) + " de " + Math.round(col.width));
    window.showCfgSection("loops");
    await new Promise((r) => setTimeout(r, 250));
    if (q("#cfgLoopFiles").value !== "3") throw new Error("freio de arquivos: " + q("#cfgLoopFiles").value);
    if (!q("#loopParSeg .segbtn.on")) throw new Error("o segmentado não tem estado");
    // §4.18 — o que os ciclos podem usar se LÊ e se DESFAZ aqui: sem esta lista, uma
    // concessão dada no pedido não teria onde ser revista se o loop fosse apagado
    const perms = q("#cfgLoopPerms");
    if (!perms) throw new Error("sem a lista do que os ciclos podem usar");
    if (!/WebSearch/.test(perms.textContent)) throw new Error("o liberado não aparece: " + perms.textContent);
    if (!/mcp__antigo/.test(perms.textContent)) throw new Error("o recusado não aparece");
    if (!/liberado/.test(perms.textContent) || !/recusado/.test(perms.textContent)) {
      throw new Error("a linha não diz o estado da decisão");
    }
    if (!perms.querySelector("[data-permforget]")) throw new Error("não dá para desfazer");
    perms.querySelector("[data-permforget]").click();
    await new Promise((r) => setTimeout(r, 300));
    if (!window.__SMOKE__.calls.loop_permit) throw new Error("esquecer não chamou o backend");
    q("#cfgClose").click();
  });
  // Um eixo só (pedido do dono, 2026-08-18): Início e o cartão do documento
  // centravam, e os outros três destinos encostavam à esquerda. Medir é o que
  // impede a próxima tela de nascer fora do eixo.
  await step("destinos-no-mesmo-eixo", async () => {
    const fora = [];
    for (const d of ["organize", "knowledge", "review"]) {
      window.goDest(d);
      await new Promise((r) => setTimeout(r, 220));
      const col = q(".bmain").getBoundingClientRect();
      const vis = (sel) => [...document.querySelectorAll(sel)]
        .find((el) => el.getBoundingClientRect().width > 0);
      const head = vis(".viewhead");
      if (!head) { fora.push(d + ": sem cabeçalho de destino visível"); continue; }
      const hb = head.getBoundingClientRect();
      const esq = hb.left - col.left, dir = col.right - hb.right;
      if (Math.abs(esq - dir) > 24) fora.push(d + " fora do eixo (" + Math.round(esq) + " vs " + Math.round(dir) + ")");
      // O invariante NÃO é "as folgas são simétricas": é UMA BORDA ESQUERDA. A
      // primeira versão media só o cabeçalho — que era justamente o bloco que não
      // centrava — e passou com quatro bordas diferentes na mesma tela.
      for (const sel of [".orglist", ".knowgrid", ".revlist", ".revcard", ".revsave", ".revempty", ".orgfoot"]) {
        const el = vis(sel);
        if (!el) continue;
        const b = el.getBoundingClientRect();
        if (Math.abs(b.left - hb.left) > 2) {
          fora.push(d + " " + sel + " começa em " + Math.round(b.left) + " e o cabeçalho em " + Math.round(hb.left));
        }
      }
    }
    if (fora.length) throw new Error("destinos fora do eixo: " + fora.join(" · "));
  });

  await step("language-switch", async () => {
    // trocar de idioma pelo CONTROLE de verdade repinta a árvore e a marca (F25)
    const sel = q("#uiLang");
    if (!sel) throw new Error("sem o seletor de idioma");
    sel.value = "en";
    sel.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 400));
    await window.refreshLoops(true);
    const txt = q("#navLoops").textContent;
    if (!/running/.test(txt)) throw new Error("a árvore ficou em português: " + txt.slice(0, 120));
    // e o FORMULÁRIO também: os círculos do dia da semana liam «D S T Q Q S S» com
    // a interface em inglês, porque a inicial vinha de uma segunda lista, pt-BR fixa
    await window.openNewLoop();
    await new Promise((r) => setTimeout(r, 150));
    q("#brainDoc").querySelector("[data-seg='semana']").click();
    await new Promise((r) => setTimeout(r, 150));
    const dows = [...q("#brainDoc").querySelectorAll("[data-dow]")].map((b) => b.textContent).join("");
    if (dows !== "SMTWTFS") throw new Error("os dias da semana não falam o idioma da tela: " + dows);
    for (const b of q("#brainDoc").querySelectorAll("[data-dow]")) {
      if (!b.getAttribute("aria-label")) throw new Error("um círculo de uma letra sem nome acessível");
    }
    sel.value = "pt";
    sel.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 200));
  });

  // ADR-0031 R5a — a SEXTA seção da lateral. A colocação foi MEDIDA aqui antes de
  // ser escolhida (contrato §7.5 #4): a hairline só pode ficar entre duas
  // seções que estão na tela, senão ela pende sob um vazio recolhido.
  await step("sidebar-ext", async () => {
    await window.refreshExt(true);
    const rows = document.querySelectorAll("#navExt [data-ext]");
    if (rows.length !== 2) throw new Error("esperava 2 extensões na árvore, achei " + rows.length);
    const grupo = q('[data-sectbody="ext"]');
    if (!vis(grupo)) throw new Error("a seção EXTENSÕES não está na tela");
    // a hairline nova não pende sob um vazio: o grupo ACIMA dela tem altura
    const seps = [...document.querySelectorAll(".sidescroll .secsep")];
    if (seps.length !== 2) throw new Error("esperava 2 hairlines na lateral, achei " + seps.length);
    const nova = seps[1];
    const acima = nova.previousElementSibling;
    if (!vis(acima)) throw new Error("a linha nova pende sob um vazio: " + (acima && acima.className));
    const rb = nova.getBoundingClientRect(), gb = grupo.getBoundingClientRect();
    if (!(rb.bottom <= gb.top + 1)) throw new Error("a linha não está acima da seção que ela separa");
    // e a linha da extensão SEM programa não mostra selo de processo
    const l1 = [...rows].find((r) => r.dataset.ext === "hotspots-board");
    if (l1.querySelector(".lstate")) throw new Error("uma extensão sem programa ganhou selo de processo");
    const l2 = [...rows].find((r) => r.dataset.ext === "mcp-python");
    if (!l2.querySelector(".lstate")) throw new Error("uma extensão COM programa tem de dizer o estado dele");
    // o botão da lateral recolhida chega na seção (e não em Início)
    const mini = q('#sideMini .minibtn[data-mini="ext"]');
    if (!mini) throw new Error("sem o botão de extensões na lateral recolhida");
    mini.click();
    await new Promise((r) => setTimeout(r, 200));
    if (!vis(q('[data-sectbody="ext"]'))) throw new Error("o botão não trouxe a seção para a tela");
  });

  // A TELA de uma extensão, desenhada pelo renderizador de verdade a partir do
  // board.json do exemplo. É o único lugar onde dá para ver que ela não recusou
  // nada e que o layout aconteceu (não há DOM sob node --test).
  await step("ext-screen", async () => {
    await window.openExt("hotspots-board");
    await new Promise((r) => setTimeout(r, 300));
    const doc = q("#brainDoc");
    if (!doc || doc.hidden) throw new Error("o documento não abriu");
    const extv = doc.querySelector(".extv");
    if (!extv) throw new Error("o renderizador não pintou nada: " + doc.textContent.slice(0, 160));
    const err = doc.querySelectorAll(".extv-err");
    if (err.length) throw new Error("a tela recusou " + err.length + " nó(s): " + [...err].map((e) => e.textContent.trim()).join(" | "));
    if (!doc.querySelector(".extv-attr")) throw new Error("sem a linha de atribuição: a tela afirmaria como se fosse do Loro");
    const cols = doc.querySelectorAll(".extv-scroll");
    if (!cols.length) throw new Error("nenhuma coluna: o each sobre os fatos não produziu nada");
    const links = doc.querySelectorAll("a[data-extv-rel]");
    if (!links.length) throw new Error("nenhum localizador ligado");
    // o gancho está LIGADO (um controle que não faz nada é o defeito proibido)
    if (typeof links[0].onclick !== "function") throw new Error("o localizador não tem manipulador");
    // a aba e a trilha nomeiam a extensão, não o sentinela cru
    const aba = q("#wsTabs .wstab.on");
    if (!aba || !/Pontos em aberto/.test(aba.textContent)) throw new Error("a aba não nomeia a extensão: " + (aba && aba.textContent));
    if (q("#bCrumb").textContent.indexOf("loro://ext") >= 0) throw new Error("a trilha mostra o sentinela cru");
    // nada transborda para o lado (WCAG 1.4.10) — a barra é do BLOCO
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      throw new Error("a página rola para o lado: " + document.documentElement.scrollWidth + " em " + document.documentElement.clientWidth);
    }
  });

  // MEDIDO NO DOM DE VERDADE, e e o defeito que fechou o buraco pior desta rodada:
  // com state no_answer o menu da linha oferecia open/start/set/cap/rm -- sem stop --
  // enquanto o processo continuava VIVO, e «iniciar» subia um segundo filho. Agora
  // quem responde e canStop, que o backend le do registro.
  // AS COLUNAS DO QUADRO, MEDIDAS NA ESCALA REAL (79 conhecimentos, 312 pontos —
  // a escala que produziu o defeito das colunas de 12px). O papel w-md promete
  // 248px; uma coluna que pode ser encolhida é uma mentira com nome de token.
  await step("ext-kanban-mede-as-colunas", async () => {
    const doc = q("#brainDoc");
    const sx = doc.querySelector(".extv-scroll-x");
    if (!sx) throw new Error("sem o rolador horizontal do quadro");
    const fila = sx.querySelector(".extv-row");
    const cols = fila ? [...fila.children] : [];
    if (cols.length !== 4) throw new Error("esperava 4 colunas de estado, achei " + cols.length);
    for (const c of cols) {
      const w = Math.round(c.getBoundingClientRect().width);
      if (w < 246 || w > 250) throw new Error("coluna fora do papel w-md: " + w + "px");
    }
    for (let i = 1; i < cols.length; i++) {
      const a = cols[i - 1].getBoundingClientRect(), b = cols[i].getBoundingClientRect();
      if (b.left < a.right - 1) throw new Error("colunas sobrepostas: " + Math.round(a.right - b.left) + "px");
    }
    // amostra de texto: nada pinta por cima do vizinho (o defeito da captura)
    const spill = [...sx.querySelectorAll(".extv-text")].slice(0, 40)
      .filter((el2) => el2.scrollWidth > el2.clientWidth + 1);
    if (spill.length) throw new Error(spill.length + " textos transbordando do cartão");
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      throw new Error("a página rola para o lado");
    }
    // e a TELA É LARGA: o layout wide larga a coluna de leitura de 700px…
    const card = q("#bDocWrap .doccard");
    const cw = Math.round(card.getBoundingClientRect().width);
    if (cw <= 700) throw new Error("layout wide preso na coluna de leitura: " + cw + "px");
    // …e o quadro inteiro pede mais do que o cartão tem — a rolagem é real
    if (!(sx.scrollWidth > sx.clientWidth + 1)) throw new Error("o quadro coube sem rolar — a medição não mede nada");
  });

  // O FILTRO É UM DROPDOWN NASCIDO DOS FATOS (dono, 2026-08-20: «ao invés de
  // busca, um dropdown»): as opções são as áreas do próprio acervo, escolher
  // uma persiste via ext_settings_set (a MESMA porta de Configurações) e
  // re-renderiza só aquela área. A opção vazia devolve todas.
  await step("ext-dropdown-de-areas-filtra-e-persiste", async () => {
    const doc = q("#brainDoc");
    const antes = doc.querySelectorAll(".extv-surface").length;
    if (antes < 20) throw new Error("o quadro cheio deveria ter dezenas de cartões, achei " + antes);
    const campo = doc.querySelector('select[data-extv-field="filtro"]');
    if (!campo) throw new Error("o filtro não é um dropdown");
    const opcoes = [...campo.options].map((o) => o.value);
    if (opcoes[0] !== "") throw new Error("sem a opção «todas»: um filtro sem volta é uma armadilha");
    if (opcoes.length < 10) throw new Error("as áreas do acervo não viraram opções: " + opcoes.length);
    if (!opcoes.includes("frota")) throw new Error("a área frota não está no dropdown");
    const setChamadas = window.__SMOKE__.calls.ext_settings_set || 0;
    campo.value = "frota";
    campo.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 350));
    if ((window.__SMOKE__.calls.ext_settings_set || 0) <= setChamadas) {
      throw new Error("a escolha não passou por ext_settings_set");
    }
    const doc2 = q("#brainDoc");
    const depois = doc2.querySelectorAll(".extv-surface").length;
    if (!(depois > 0 && depois < antes)) {
      throw new Error("o dropdown não filtrou: " + antes + " -> " + depois);
    }
    // só a área escolhida sobra na tela
    const temas = [...doc2.querySelectorAll(".extv-surface .badge")].map((b) => b.textContent);
    const fora = temas.filter((t2) => t2.indexOf("/") >= 0 && !t2.startsWith("frota"));
    if (fora.length) throw new Error("cartão de outra área sobrou: " + fora[0]);
    // a opção vazia devolve o quadro inteiro
    const campo2 = doc2.querySelector('select[data-extv-field="filtro"]');
    campo2.value = "";
    campo2.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 350));
    const cheio = q("#brainDoc").querySelectorAll(".extv-surface").length;
    if (cheio !== antes) throw new Error("«todas» não devolveu o quadro: " + cheio + " de " + antes);
  });

  // O MODAL DO ask: o clique abre uma folha do LORO, a pessoa escreve, e o que
  // chega ao chat é a habilidade + o alvo + as palavras dela. A extensão nunca
  // despacha nada sozinha — sem o clique e a frase, o chat não recebe linha.
  await step("ext-modal-pergunta-e-o-chat-recebe", async () => {
    const btn = q('#brainDoc [data-extv-ask="loro-kanban-move"]');
    if (!btn) throw new Error("sem o botão mover no cartão");
    const alvo = btn.dataset.extvAskTarget || "";
    if (!alvo.includes("#")) throw new Error("o alvo do ask não é um ponto: " + alvo);
    btn.click();
    await new Promise((r) => setTimeout(r, 120));
    if (q("#pmWrap").hidden) throw new Error("o clique não abriu a folha");
    const inp = q("#extAskInput");
    if (!inp) throw new Error("a folha não tem o campo de escrever");
    // a folha DIZ o que vai acontecer (usabilidade é premissa): a habilidade
    // aparece nomeada antes do envio
    if (!q("#pmBody").textContent.includes("/loro-kanban-move")) {
      throw new Error("a folha não nomeia a habilidade que vai rodar");
    }
    inp.value = "em-pauta — decidir na reunião de quinta";
    q("#pmConfirm").click();
    await new Promise((r) => setTimeout(r, 250));
    const linhas = window.__SMOKE__.chat || [];
    const linha = linhas.find((l) => l.includes("/loro-kanban-move"));
    if (!linha) throw new Error("o chat não recebeu a habilidade: " + JSON.stringify(linhas));
    if (!linha.includes(alvo)) throw new Error("a linha perdeu o alvo: " + linha);
    if (!linha.includes("em-pauta — decidir na reunião de quinta")) {
      throw new Error("a linha perdeu as palavras da pessoa: " + linha);
    }
    if (!q("#pmWrap").hidden) throw new Error("a folha não fechou após o envio");
  });

  // O CARTÃO LARGO É POR ABA: sair do quadro devolve a coluna de leitura.
  await step("ext-largo-volta-ao-normal-num-documento", async () => {
    await window.openDoc("loro://manual", { preview: false });
    await new Promise((r) => setTimeout(r, 250));
    if (q("#bDocWrap").classList.contains("extwide")) {
      throw new Error("o manual herdou a largura do quadro");
    }
    const cw = Math.round(q("#bDocWrap .doccard").getBoundingClientRect().width);
    if (cw > 700) throw new Error("a coluna de leitura não voltou: " + cw + "px");
    await window.openExt("hotspots-board");
    await new Promise((r) => setTimeout(r, 250));
  });

  await step("ext-programa-mudo-ainda-para", async () => {
    S.fire("ext-state", { id: "mcp-python", state: "no_answer", reason: "err.ext_timeout:5000", lastAnswerMs: 1 });
    await new Promise((r) => setTimeout(r, 60));
    const linha = q('#navExt [data-ext="mcp-python"]');
    if (!linha) throw new Error("a linha da extensão saiu da lateral");
    const selo = linha.querySelector(".lstate");
    // o idioma pode ter sido trocado por um passo anterior: as duas frases valem
    if (!selo || !/sem resposta|not answering/.test(selo.textContent)) throw new Error("o selo nao diz o estado: " + (selo && selo.textContent));
    // sem handle vivo a unica oferta e iniciar
    linha.querySelector("[data-extmenu]").click();
    await new Promise((r) => setTimeout(r, 40));
    let itens = [...document.querySelectorAll("#bMenu .fitem2")].map((n) => n.dataset.a || "");
    if (itens.indexOf("start") < 0) throw new Error("sem handle vivo a oferta é iniciar: " + itens.join(","));
    document.body.click();
    // agora COM handle vivo (o que no_answer de verdade significa)
    S.answers.ext_list = S.answers.ext_list.map((r) => (r.id === "mcp-python"
      ? { ...r, state: "no_answer", reason: "err.ext_timeout:5000", canStop: true } : r));
    S.fire("ext-state", { id: "mcp-python", state: "no_answer", reason: "err.ext_timeout:5000", lastAnswerMs: 2 });
    await new Promise((r) => setTimeout(r, 80));
    q('#navExt [data-ext="mcp-python"] [data-extmenu]').click();
    await new Promise((r) => setTimeout(r, 40));
    itens = [...document.querySelectorAll("#bMenu .fitem2")].map((n) => n.dataset.a || "");
    if (itens.indexOf("stop") < 0) throw new Error("um programa vivo e mudo tem de poder ser parado: " + itens.join(","));
    document.body.click();
    // E O SELO E VISIVEL FORA DA LATERAL: medido em rgb/familia/tamanho, porque
    // .lstate so existia sob .bitem e na tela caia em texto comum.
    const sonda = document.createElement("span");
    sonda.className = "lstate amber";
    sonda.textContent = "sem resposta";
    q("#brainDoc").appendChild(sonda);
    const cs = getComputedStyle(sonda);
    const fam = cs.fontFamily, tam = cs.fontSize, cor = cs.color;
    sonda.remove();
    if (!/mono|SF Mono|Menlo/i.test(fam)) throw new Error("o selo perdeu a face mono fora da lateral: " + fam);
    if (parseFloat(tam) > 12) throw new Error("o selo perdeu o tamanho: " + tam);
    const neutro = getComputedStyle(q("#brainDoc")).color;
    if (cor === neutro) throw new Error("o selo tem a cor do texto comum: " + cor);
  });

  // MEDIDO: .doc p / .doc hr (classe+tipo) ganhavam de .extv-text / .extv-div, entao
  // um gap 0 media 9px e uma regua de 4px era pintada com 16px. O papel que o autor
  // pede tem de ser o papel que a folha pinta.
  await step("ext-degrau-pedido-e-degrau-pintado", async () => {
    const host = q("#brainDoc");
    host.insertAdjacentHTML("beforeend",
      '<div class="extv" data-ext="probe"><div class="extv-stack g-0 p-0 al-start">' +
      '<p class="extv-text sz-body">um</p><p class="extv-text sz-body">dois</p>' +
      '<hr class="extv-div" /></div></div>');
    const probe = host.querySelector('[data-ext="probe"]');
    const ps = probe.querySelectorAll(".extv-text");
    // as strings SAEM antes do remove: getComputedStyle devolve um objeto VIVO, e
    // depois de tirar o no do documento todo campo dele volta vazio (medido: "/")
    const mb = getComputedStyle(ps[0]).marginBottom;
    const larg = getComputedStyle(ps[0]).maxWidth;
    const hrTop = getComputedStyle(probe.querySelector(".extv-div")).marginTop;
    const hrBot = getComputedStyle(probe.querySelector(".extv-div")).marginBottom;
    const dist = Math.round(ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom);
    probe.remove();
    if (parseFloat(mb) !== 0) throw new Error("gap 0 carrega margem escondida: " + mb);
    if (dist !== 0) throw new Error("gap 0 nao e 0: " + dist + "px entre as linhas");
    if (hrTop !== "4px" || hrBot !== "4px") throw new Error("a regua declarada nao e a pintada: " + hrTop + "/" + hrBot);
    if (larg !== "100%") throw new Error("sem teto de largura um token longo fura a coluna: " + larg);
  });

  // O braço novo do despachante não pode ter roubado nenhuma das telas que ele
  // já roteava: cada sentinela abre e desenha a SUA superfície.
  await step("sentinels-still-render", async () => {
    const casos = [
      ["loro://indice", "#brainDoc .idxsurf, #brainDoc .idx, #brainDoc"],
      ["loro://loop-novo", "#brainDoc .loopform, #brainDoc [data-seg]"],
      ["loops/o-que-falta.md", "#brainDoc [data-loopact], #brainDoc .loopsurf, #brainDoc"],
      ["loro://manual", "#brainDoc"],
    ];
    for (const [rel, sel] of casos) {
      await window.openDoc(rel, { preview: false });
      await new Promise((r) => setTimeout(r, 250));
      const doc = q("#brainDoc");
      if (!doc || doc.hidden) throw new Error(rel + ": o documento não abriu");
      if (doc.querySelector(".extv")) throw new Error(rel + ": a tela de extensão roubou o sentinela");
      if (!doc.querySelector(sel.split(",")[0].trim()) && !doc.textContent.trim()) {
        throw new Error(rel + ": abriu vazio");
      }
      if (window.__SMOKE__.errors.length) throw new Error(rel + ": " + window.__SMOKE__.errors[0]);
    }
  });

  document.title = "RESULT" + JSON.stringify({ steps: seen, errors: S.errors.slice(0, 12), calls: Object.keys(S.calls).length, header: S.header });
})();
</script>
`;

// O STUB E O DRIVER SÃO CONFERIDOS ANTES DE ABRIR O CHROME. Eles moram dentro de template
// literals, então `node --check` deste arquivo não vê a sintaxe deles: um erro ali derruba o
// script no navegador e a saída diz «o driver não chegou ao fim» — que se lê como defeito do
// app e não é. Duas vezes em 2026-08-18: um backtick numa frase de comentário, e um `\/` que
// o template literal colapsou em `//`, comentando a linha. Compilar aqui custa nada.
for (const [nome, corpo] of [["STUB", STUB], ["DRIVER", DRIVER]]) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(corpo.replace(/<\/?script>/g, ""));
  } catch (e) {
    console.log(nome + " com erro de sintaxe: " + e.message);
    process.exit(1);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loro-smoke-"));
const page = html
  .replace("<head>", `<head><base href="file://${REAL_SRC}/">` + STUB)
  .replace("</body>", DRIVER + "</body>");
const file = path.join(tmp, "smoke.html");
fs.writeFileSync(file, page);

const shot = process.env.SMOKE_SHOT || "";
const dom = execFileSync(CHROME, [
  ...(shot ? ["--screenshot=" + shot, "--hide-scrollbars"] : []),
  "--headless", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
  // O ORÇAMENTO É O RELÓGIO DO ROTEIRO, não uma margem: quando ele acaba o Chrome para
  // no meio e o resultado sai como «o driver não chegou ao fim» — que se lê como defeito
  // do app e não é (custou uma caçada em 2026-08-18). Ele cresce com o roteiro; cada
  // `step` novo com esperas soma. 22 passos ≈ 11s de tempo virtual.
  "--window-size=1400,900", "--virtual-time-budget=30000", "--dump-dom", `file://${file}`,
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });

const m = /<title>RESULT(\{[\s\S]*?\})<\/title>/.exec(dom);
if (!m) {
  console.log("SEM RESULTADO — o driver não chegou ao fim.");
  const t = /<title>([\s\S]*?)<\/title>/.exec(dom);
  console.log("title:", t && t[1]);
  const err = /__SMOKE__[\s\S]{0,200}/.exec(dom);
  fs.writeFileSync(path.join(tmp, "dom.html"), dom);
  console.log("DOM salvo em", path.join(tmp, "dom.html"));
  process.exit(1);
}
const out = JSON.parse(m[1]);
let bad = 0;
for (const [k, v] of Object.entries(out.steps)) {
  const ok = v === "ok";
  if (!ok) bad++;
  console.log((ok ? "  ok   " : "  FALHA") + "  " + k + (ok ? "" : "  → " + v));
}
console.log("\ncomandos IPC exercitados:", out.calls);
if (out.header) console.log("cabeçalho:", JSON.stringify(out.header));
if (out.errors.length) {
  console.log("\nERROS DE JS NO CONSOLE:");
  for (const e of out.errors) console.log("  · " + e);
}
console.log(bad || out.errors.length ? "\nSMOKE FALHOU" : "\nSMOKE OK");
process.exit(bad || out.errors.length ? 1 : 0);
