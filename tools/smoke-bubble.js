#!/usr/bin/env node
// Loro — smoke do BALÃO (ADR-0041): roda o bubble.html + bubble.js DE VERDADE num
// Chrome headless, com o Tauri estubado, e mede o que a suíte de fonte não vê:
// o clique que abre, o arrasto que NÃO abre, o selo que não pisca (medido em dois
// instantes, não lido do CSS), o painel com as cinco partes e o inglês.
//
// Mesma postura do smoke-ui.js: fora do `make test` (precisa de navegador), e sai
// com 0 dizendo que pulou quando não há Chrome. Roda em `make test-ui`.
//
// Uso:  node tools/smoke-bubble.js
//       SMOKE_STOP=<passo> SMOKE_SHOT=/caminho.png SMOKE_SIZE=84,84 node tools/smoke-bubble.js
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const REAL_SRC = path.join(__dirname, "..", "desktop", "src");
const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const CHROME = CHROMES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } });
if (!CHROME) { console.log("smoke-bubble: pulado — nenhum Chrome encontrado"); process.exit(0); }

const html = fs.readFileSync(path.join(REAL_SRC, "bubble.html"), "utf8");

const STUB = `
<script>
window.__SMOKE__ = { errors: [], calls: {}, handlers: {}, sent: [], expand: [], drags: 0, chat: [], heights: [], opened: [], answers: [] };
window.__SMOKE__.fire = (name, payload) => {
  for (const fn of window.__SMOKE__.handlers[name] || []) fn({ payload });
};
window.addEventListener("error", (e) => window.__SMOKE__.errors.push("error: " + e.message + " @ " + (e.filename||"").split("/").pop() + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => window.__SMOKE__.errors.push("reject: " + (e.reason && e.reason.message || e.reason)));
window.__TAURI__ = {
  core: {
    invoke: (cmd, args) => {
      window.__SMOKE__.calls[cmd] = (window.__SMOKE__.calls[cmd] || 0) + 1;
      if (cmd === "bubble_get_size") return Promise.resolve(32);
      if (cmd === "brain_open_link") { window.__SMOKE__.opened.push(args && args.url); return Promise.resolve(null); }
      // ADR-0043 — the list is the CLI's own answer to \`initialize\` (same shape)
      if (cmd === "agent_commands") return Promise.resolve([
        { name: "consulta", description: "Responde o que era esperado", argumentHint: "" },
        { name: "review", description: "Confronta um contrato com o Figma", argumentHint: "" },
        { name: "turbi-design:torque", description: "Torque 2", argumentHint: "" },
      ]);
      if (cmd === "chat_answer") { window.__SMOKE__.answers.push(args && args.input); return Promise.resolve(null); }
      if (cmd === "chat_send") { window.__SMOKE__.chat.push(args && args.input); return Promise.resolve(null); }
      if (cmd === "bubble_panel_height") { window.__SMOKE__.heights.push(args && args.height); return Promise.resolve(args && args.height); }
      if (cmd === "bubble_expand") {
        window.__SMOKE__.expand.push(!!(args && args.expanded));
        return Promise.resolve({ right: false, bottom: false });
      }
      return Promise.resolve(null);
    },
  },
  event: {
    listen: (name, fn) => {
      (window.__SMOKE__.handlers[name] = window.__SMOKE__.handlers[name] || []).push(fn);
      return Promise.resolve(() => {});
    },
    emit: (name, payload) => { if (name === "bubble-cmd") window.__SMOKE__.sent.push(payload); return Promise.resolve(); },
  },
  window: { getCurrentWindow: () => ({ startDragging: () => { window.__SMOKE__.drags++; return Promise.resolve(); } }) },
};
</script>
`;

const DRIVER = `
<script>
(async () => {
  const S = window.__SMOKE__;
  const STOP = ${JSON.stringify(process.env.SMOKE_STOP || "")};
  const seen = {};
  const q = (sel) => document.querySelector(sel);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => {
    if (!el || el.hidden) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0 && el.getBoundingClientRect().height > 0;
  };
  const mouse = (type, target, x, y) => (target || document).dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y, clientX: x, clientY: y }));
  const lastSent = () => S.sent[S.sent.length - 1] || {};
  const click = (el) => { mouse("mousedown", el, 10, 10); mouse("mouseup", document, 10, 10); };
  let stopped = false;
  const step = async (name, fn) => {
    if (stopped) return;
    try { await fn(); seen[name] = "ok"; }
    catch (e) { seen[name] = "THREW: " + (e && e.message || e); }
    await wait(60);
    if (STOP && name === STOP) { stopped = true; document.title = "RESULT" + JSON.stringify({ steps: seen, errors: S.errors.slice(0, 12) }); }
  };
  const NOW = Date.now();
  const at = (minutes) => NOW + minutes * 60000;
  const tomorrow = (() => { const d = new Date(NOW); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 30).getTime(); })();
  const EVENTOS = [
    { id: "cedo", titulo: "Café com o time", inicioMs: at(-180), fimMs: at(-150), comConvidados: true, agendada: false, tema: "" },
    { id: "agora", titulo: "Semanal de custos", inicioMs: at(-10), fimMs: at(20), comConvidados: true, agendada: true, tema: "frota-2026",
      link: "https://meet.google.com/abc-defg-hij", linkAgenda: "https://calendar.google.com/calendar/event?eid=x" },
    { id: "logo", titulo: "1:1 com a equipe", inicioMs: at(25), fimMs: at(55), comConvidados: true, agendada: false, tema: "" },
    { id: "daily", titulo: "Daily", inicioMs: tomorrow, fimMs: tomorrow + 15 * 60000, comConvidados: true, agendada: true, tema: "vendas" },
  ].filter((e) => new Date(e.inicioMs).getDate() === new Date(NOW).getDate() || e.id === "daily");
  const BASE = {
    lang: "pt", rec: "idle", meeting: false, canRecord: true, startedAt: 0, pausedMs: 0, pauseStart: 0,
    titulo: "", tema: "", destino: "frota-2026",
    temas: [{ slug: "frota-2026", nome: "frota 2026" }, { slug: "vendas", nome: "vendas" }],
    linhas: [], agenda: { status: "ok", eventos: EVENTOS }, prompt: null, aviso: "",
    chatCtx: ["brainstorming/frota-2026/meetings/x/reuniao.md", ".loro/agenda/2026-11-18.json"],
    tarefas: { status: "ok", pendentes: [], lista: (() => {
      const k = (d) => { const x = new Date(NOW); x.setDate(x.getDate() + d); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
      return [
        { id: "t1", titulo: "Enviar proposta", prazo: k(-2), notas: "ver https://docs.example.com/p\\nsegunda linha", status: "needsAction", concluidaEmMs: null, link: "https://tasks.google.com/t1" },
        { id: "t2", titulo: "Revisar orçamento", prazo: k(0), notas: "", status: "needsAction", concluidaEmMs: null, link: null },
        { id: "t3", titulo: "Planejar Q1", prazo: k(5), notas: "", status: "needsAction", concluidaEmMs: null, link: null },
        { id: "t4", titulo: "Ideias soltas", prazo: null, notas: "", status: "needsAction", concluidaEmMs: null, link: null },
        { id: "t5", titulo: "Fechar mês", prazo: k(-3), notas: "", status: "completed", concluidaEmMs: NOW - 86400000, link: null },
      ];
    })() },
  };
  const state = (over) => S.fire("bubble-state", Object.assign({}, BASE, over || {}));
  await wait(300);

  await step("boot", async () => {
    if (!q("#icon #bird")) throw new Error("sem o ícone");
    if (!S.sent.some((c) => c.cmd === "hello")) throw new Error("o balão não pediu o estado à janela principal");
    if (vis(q("#panel"))) throw new Error("o painel nasce aberto");
    const r = q("#icon").getBoundingClientRect();
    if (Math.round(r.width) !== 32 || Math.round(r.height) !== 32) throw new Error("o ícone padrão não tem 32pt: " + r.width + "x" + r.height);
    // nítido em qualquer tamanho: é vetor, e ocupa o botão inteiro
    const br0 = q("#bird").getBoundingClientRect();
    if (Math.round(br0.width) !== 32) throw new Error("o papagaio não ocupa o ícone: " + br0.width);
  });

  await step("ocioso-sem-selo", async () => {
    state();
    await wait(50);
    if (vis(q("#badge"))) throw new Error("ocioso mostra selo");
    if (!/Próxima: \\d\\d:\\d\\d 1:1 com a equipe/.test(q("#icon").title)) throw new Error("tooltip sem a próxima: " + q("#icon").title);
  });

  await step("gravando-selo-estavel", async () => {
    state({ rec: "recording", meeting: true, startedAt: NOW - 65000, tema: "frota-2026", titulo: "Semanal" });
    await wait(50);
    const b = q("#badge");
    if (!vis(b) || !b.classList.contains("rec")) throw new Error("gravando sem o ponto vermelho");
    const br = b.getBoundingClientRect(), win = document.body.getBoundingClientRect();
    if (br.width < 9) throw new Error("selo ilegível: " + br.width);
    if (br.left < 0 || br.top < 0 || br.right > win.right || br.bottom > win.bottom) throw new Error("o selo sai da janela recolhida: " + JSON.stringify([br.left, br.top, br.right, br.bottom]));
    if (!/gravando · 1:0[5-9]/.test(q("#icon").title)) throw new Error("o tooltip não diz o tempo: " + q("#icon").title);
    // NÃO PISCA: medido, não lido do CSS — duas leituras com 1,3 s entre elas
    const look = () => { const cs = getComputedStyle(b); return [cs.backgroundColor, cs.opacity, cs.visibility, cs.display, cs.transform].join("|"); };
    const a1 = look();
    // §13: gravando, as pernas andam — e SÓ elas e o corpo; o selo e o botão não
    for (const el of [q("#bird .leg.a"), q("#bird .leg.b"), q("#bird .bob")]) {
      if (!/^walk-/.test(getComputedStyle(el).animationName)) throw new Error("gravando e o papagaio não anda: " + el.getAttribute("class"));
    }
    for (const el of [b, q("#icon"), q("#bird")]) {
      const cs = getComputedStyle(el);
      if (cs.animationName !== "none") throw new Error("animação em " + (el.id || el.tagName) + ": " + cs.animationName);
      if (cs.transitionDuration !== "0s") throw new Error("transição em " + (el.id || el.tagName) + ": " + cs.transitionDuration);
    }
    await wait(1300);
    if (look() !== a1) throw new Error("o selo mudou sozinho: " + a1 + " → " + look());
  });

  await step("pausado", async () => {
    state({ rec: "paused", meeting: true, startedAt: NOW - 65000, pauseStart: NOW - 5000, tema: "frota-2026" });
    await wait(50);
    if (!q("#badge").classList.contains("pause")) throw new Error("pausado sem o selo de pausa");
    if (getComputedStyle(q("#bird .leg.a")).animationName !== "none") throw new Error("pausado e o papagaio continua andando");
  });

  await step("clique-abre", async () => {
    const before = S.sent.length;
    mouse("mousedown", q("#icon"), 100, 100);
    mouse("mousemove", document, 102, 101);
    mouse("mouseup", document, 102, 101);
    await wait(250);
    if (!document.body.classList.contains("open")) throw new Error("o clique não abriu o painel");
    if (!vis(q("#panel"))) { const cs = getComputedStyle(q("#panel")); throw new Error("o painel não aparece: " + [cs.visibility, cs.opacity, cs.display, q("#panel").getBoundingClientRect().height].join(" ")); }
    if (S.expand[S.expand.length - 1] !== true) throw new Error("não pediu ao backend para crescer");
    if (S.drags) throw new Error("um clique virou arrasto");
    const cmds = S.sent.slice(before).map((c) => c.cmd);
    if (cmds.some((c) => /start|pause|resume|stop|toggle/.test(c))) throw new Error("o clique no ícone mandou gravar/pausar: " + cmds);
  });

  await step("arrasto-nao-alterna", async () => {
    mouse("mousedown", q("#icon"), 100, 100);
    mouse("mousemove", document, 110, 104);
    mouse("mousemove", document, 160, 140);
    mouse("mouseup", document, 160, 140);
    await wait(80);
    if (S.drags !== 1) throw new Error("arrastos pedidos: " + S.drags + " (esperado 1)");
    if (!document.body.classList.contains("open")) throw new Error("terminar um arrasto fechou o painel");
  });

  await step("painel-gravando", async () => {
    state({ rec: "recording", meeting: true, startedAt: NOW - 125000, tema: "frota-2026", titulo: "Semanal de custos",
      linhas: [{ who: "mic", text: "vamos começar pelo orçamento" }, { who: "system", text: "o número fechou ontem" }] });
    await wait(80);
    if (!/gravando/.test(q("#bStatusText").textContent)) throw new Error("status: " + q("#bStatusText").textContent);
    if (!/^2:0/.test(q("#bTime").textContent)) throw new Error("tempo no cabeçalho: " + q("#bTime").textContent);
    if (!/Semanal de custos/.test(q("#bTitle").textContent)) throw new Error("título: " + q("#bTitle").textContent);
    const tail = q("#bTail").textContent;
    if (!/você/.test(tail) || !/sistema/.test(tail)) throw new Error("a transcrição não diz quem falou: " + tail);
    if (vis(q("#bGravar")) || !vis(q("#bPausar")) || !vis(q("#bEncerrar")) || !vis(q("#bNova"))) throw new Error("controles errados para «gravando»");
    // a ação principal é a vermelha
    const enc = getComputedStyle(q("#bEncerrar")), pau = getComputedStyle(q("#bPausar"));
    if (enc.backgroundColor === pau.backgroundColor) throw new Error("Encerrar não se distingue de Pausar");
    if (!q("#bDest .pickbtn").disabled) throw new Error("a ideia de uma gravação em curso não pode ser trocada");
    const body = q("#tabRec");
    if (body.scrollWidth > body.clientWidth + 1) throw new Error("estoura na horizontal: " + body.scrollWidth + " em " + body.clientWidth);
    for (const el of [q("#bAbrir"), q("#bChatIn")]) {
      const r = el.getBoundingClientRect(), p = q("#panel").getBoundingClientRect();
      if (r.bottom > p.bottom - 2 || r.right > p.right - 2) throw new Error((el.id) + " fora do painel");
    }
  });

  // CONTRASTE MEDIDO (WCAG): a cor de cada texto sobre o fundo opaco do painel
  // (--bg-solid; a translucidez real depende do que está atrás, então o piso é
  // medido contra o material sólido). Roda no tema que o Chrome estiver usando —
  // SMOKE_SCHEME=dark|light mede o outro.
  await step("contraste", async () => {
    const parse = (c) => { const m = c.match(/[0-9.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] == null ? 1 : m[3] }; };
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = (c) => { const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b); };
    const ratio = (x, y) => { const a = lum(x), b = lum(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    // o painel é OPACO: o fundo medido é o dele, e alpha tem de ser 1
    const solid = parse(getComputedStyle(q("#panel")).backgroundColor);
    if (solid.a !== 1) throw new Error("o painel não é opaco: alpha " + solid.a);
    if (getComputedStyle(q("#panel")).backdropFilter !== "none") throw new Error("ainda há backdrop-filter");
    const fails = [];
    const check = (el, min, name) => {
      if (!el) return;
      const cs = getComputedStyle(el);
      let bg = solid;
      const own = parse(cs.backgroundColor);
      if (own.a > 0) bg = over(own, solid);
      const r = ratio(over(parse(cs.color), bg), bg);
      S.contraste = S.contraste || {}; S.contraste[name] = Math.round(r * 10) / 10;
      if (r < min) fails.push(name + " " + r.toFixed(2) + " < " + min);
    };
    check(q("#bStatusText").parentElement, 4.5, "status gravando");
    check(q("#bTitle"), 4.5, "título");
    check(q(".lbl"), 4.5, "rótulo");
    check(q("#bEncerrar"), 4.5, "Encerrar (vermelho)");
    check(q("#bPausar"), 4.5, "Pausar (fantasma)");
    check(q("#bAbrir"), 4.5, "Abrir no Loro");
    check(q("#bTail .who.sistema"), 4.5, "rótulo sistema");
    if (fails.length) throw new Error(fails.join(" · "));
  });

  // o seletor de destino: um campo que abre uma lista com busca (escala)
  const pick = async (host, typed, keys) => {
    host.querySelector(".pickbtn").click(); await wait(30);
    const qq = host.querySelector(".pickq");
    if (!vis(qq)) throw new Error("a lista não abriu");
    qq.value = typed; qq.dispatchEvent(new Event("input")); await wait(20);
    for (const k of keys) { qq.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); await wait(20); }
  };
  await step("gravar-do-painel", async () => {
    state({ rec: "idle", linhas: [], recentes: ["vendas"],
      temas: [{ slug: "frota-2026", nome: "frota 2026" }, { slug: "vendas", nome: "vendas" },
        ...Array.from({ length: 30 }, (_, i) => ({ slug: "ideia-" + i, nome: "ideia " + String(i).padStart(2, "0") }))] });
    await wait(60);
    if (!vis(q("#bGravar"))) throw new Error("ocioso sem «Gravar»");
    const host = q("#bDest");
    if (!/frota 2026/.test(host.querySelector(".pickbtn").textContent)) throw new Error("o destino atual não aparece: " + host.textContent);
    // aberta e sem busca: «Recentes» em cima, 8 linhas visíveis, o resto rola
    host.querySelector(".pickbtn").click(); await wait(40);
    const list = host.querySelector(".picklist");
    const first = list.querySelector(".pickgrp");
    if (!first || !/Recentes/.test(first.textContent)) throw new Error("sem «Recentes» no topo");
    if (!/vendas/.test(list.querySelector(".pickit").textContent)) throw new Error("a recente não vem primeiro");
    const rows = list.querySelectorAll(".pickit").length;
    if (rows !== 32) throw new Error("linhas: " + rows);
    if (list.clientHeight > 8 * 28 + 2 || list.scrollHeight <= list.clientHeight) throw new Error("a lista não está limitada a ~8 linhas com rolagem: " + list.clientHeight + "/" + list.scrollHeight);
    if (host.querySelector(".pickit[title], .pickbtn[title]")) throw new Error("tooltip nativo no seletor");
    // Esc fecha a LISTA, e o painel continua aberto
    host.querySelector(".pickq").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(30);
    if (vis(host.querySelector(".pickpop"))) throw new Error("Esc não fechou a lista");
    if (!document.body.classList.contains("open")) throw new Error("Esc da lista fechou o painel");
    // busca + teclado
    await pick(host, "vend", ["Enter"]);
    if (lastSent().cmd !== "set-tema" || lastSent().tema !== "vendas") throw new Error("escolher a ideia mandou " + JSON.stringify(lastSent()));
    q("#bGravar").click();
    await wait(30);
    let c = lastSent();
    if (c.cmd !== "start" || c.tema !== "vendas" || c.nova) throw new Error("gravar mandou " + JSON.stringify(c));
    // ↓ move para a segunda linha
    await pick(host, "ideia 0", ["ArrowDown", "Enter"]);
    if (lastSent().tema !== "ideia-1") throw new Error("↓ + Enter escolheu " + JSON.stringify(lastSent()));
    // ideia nova: o que se digita e não bate com nada
    await pick(host, "lançamento q4", ["Enter"]);
    if (!/nova: lançamento q4/.test(host.querySelector(".pickbtn").textContent)) throw new Error("a ideia nova não aparece no campo");
    q("#bGravar").click();
    await wait(30);
    c = lastSent();
    if (c.cmd !== "start" || c.tema !== "lançamento q4" || c.nova !== true) throw new Error("ideia nova mandou " + JSON.stringify(c));
    state({ temas: BASE.temas, recentes: [] });
  });

  await step("agenda-hoje-amanha", async () => {
    q("#tabBtnAgenda").click();
    await wait(60);
    const txt = q("#bAgenda").textContent;
    if (!/Hoje/.test(txt) || !/Amanhã/.test(txt)) throw new Error("sem os grupos Hoje/Amanhã: " + txt);
    if (!/Daily/.test(txt)) throw new Error("o evento de amanhã não aparece");
    const now = q('.ev[data-ev="agora"]');
    if (!now || !now.classList.contains("now")) throw new Error("o evento em andamento não está destacado");
    const past = q("#bPassados");
    if (EVENTOS.some((e) => e.id === "cedo")) {
      if (past.hidden || !/Já passaram \\(1\\)/.test(past.querySelector("summary").textContent)) throw new Error("os que passaram não estão recolhidos: " + past.querySelector("summary").textContent);
      if (past.open) throw new Error("os que passaram nascem abertos");
    }
    // abrir um evento mostra os detalhes e as ações
    q('.ev[data-ev="logo"] .evhead').click();
    await wait(40);
    const det = q('.ev[data-ev="logo"] .det');
    if (!det) throw new Error("o evento não abre");
    if (!/começa em (2[4-5]) min/.test(det.textContent)) throw new Error("estado ao vivo: " + det.textContent);
    if (!/30 min/.test(det.textContent) || !/com convidados/.test(det.textContent)) throw new Error("detalhes: " + det.textContent);
    // o MESMO seletor, no detalhe do evento
    await pick(det.querySelector(".picker").parentElement, "vend", ["Enter"]);
    det.querySelector("input[type=checkbox]").click();
    await wait(30);
    let c = lastSent();
    if (c.cmd !== "schedule" || c.id !== "logo" || c.on !== true || c.tema !== "vendas") throw new Error("agendar mandou " + JSON.stringify(c));
    // o que está acontecendo agora pode ser gravado na hora
    q('.ev[data-ev="agora"] .evhead').click();
    await wait(40);
    const now2 = [...q('.ev[data-ev="agora"] .det').querySelectorAll("button")].find((b) => /Gravar agora/.test(b.textContent));
    if (!now2) throw new Error("sem «Gravar agora» no que está acontecendo");
    now2.click(); await wait(30);
    c = lastSent();
    if (c.cmd !== "record-now" || c.id !== "agora") throw new Error("gravar agora mandou " + JSON.stringify(c));
    // à noite, com hoje vazio, amanhã continua lá (o defeito que o dono viu)
    state({ agenda: { status: "ok", eventos: EVENTOS.filter((e) => e.id === "daily") } });
    await wait(40);
    if (!/Amanhã/.test(q("#bAgenda").textContent) || /nenhuma reunião/.test(q("#bAgendaNota").textContent)) throw new Error("amanhã sumiu sem hoje");
    state({ agenda: { status: "missing", eventos: [] } });
    await wait(40);
    if (!/agenda não atualizada/.test(q("#bAgendaNota").textContent)) throw new Error("sem agenda, o painel não diz");
    state();
  });

  await step("agenda-links", async () => {
    q("#tabBtnAgenda").click();
    await wait(50);
    const row = q('.ev[data-ev="agora"]');
    const j = [...row.querySelectorAll(".evrow button")].find((b) => /Entrar/.test(b.textContent));
    if (!j) throw new Error("sem «Entrar» no evento em andamento");
    j.click(); await wait(20);
    if (S.opened.pop() !== "https://meet.google.com/abc-defg-hij") throw new Error("Entrar não abriu o link no navegador");
    if (!q('.ev[data-ev="agora"] .det')) row.querySelector(".evhead").click();
    await wait(30);
    const det = q('.ev[data-ev="agora"] .det');
    const ag = [...det.querySelectorAll("button")].find((b) => /Abrir na agenda/.test(b.textContent));
    if (!ag) throw new Error("sem «Abrir na agenda» no detalhe");
    ag.click(); await wait(20);
    if (!/calendar\.google\.com/.test(S.opened.pop())) throw new Error("Abrir na agenda não abriu");
    if (q('.ev[data-ev="logo"] .evrow .join')) throw new Error("«Entrar» num evento sem link");
    // começou uma agendada com link: o balão oferece entrar
    state({ rec: "recording", meeting: true, startedAt: NOW, prompt: { kind: "join", eventId: "agora", titulo: "Semanal de custos", link: "https://meet.google.com/abc-defg-hij" } });
    await wait(40);
    const b = [...q("#bPromptActs").querySelectorAll("button")].find((x) => /Entrar na reunião/.test(x.textContent));
    if (!b) throw new Error("sem «Entrar na reunião» ao começar a gravação");
    b.click(); await wait(20);
    if (S.opened.pop() !== "https://meet.google.com/abc-defg-hij") throw new Error("Entrar na reunião não abriu");
    state();
  });

  await step("tarefas", async () => {
    const badge = q("#bTarefasBadge");
    if (badge.hidden || badge.textContent !== "2") throw new Error("o selo da aba não conta atrasadas + hoje: " + badge.textContent);
    q("#tabBtnTarefas").click();
    await wait(50);
    const txt = q("#bTarefas").textContent;
    for (const w of ["Atrasadas", "Hoje", "Próximas", "Sem prazo", "Enviar proposta", "Revisar orçamento", "Planejar Q1", "Ideias soltas"]) {
      if (!txt.includes(w)) throw new Error("falta «" + w + "» nas tarefas");
    }
    const done = q("#bConcluidas");
    if (done.hidden || done.open || !done.querySelector("summary").textContent.includes("Concluídas (1)")) throw new Error("concluídas não estão recolhidas");
    if (!q('.tk[data-tk="t1"] .prazo.late')) throw new Error("a atrasada não se distingue");
    // abrir mostra as notas em texto, com o link clicável e a quebra de linha
    q('.tk[data-tk="t1"] .tkt').click(); await wait(30);
    const notas = q('.tk[data-tk="t1"] .notas');
    if (!notas || getComputedStyle(notas).whiteSpace !== "pre-wrap") throw new Error("as notas não preservam a quebra de linha");
    notas.querySelector(".lnk").click(); await wait(20);
    if (S.opened.pop() !== "https://docs.example.com/p") throw new Error("o link das notas não abriu no navegador");
    const g = [...q('.tk[data-tk="t1"]').querySelectorAll("button")].find((b) => /Abrir no Google/.test(b.textContent));
    g.click(); await wait(20);
    if (S.opened.pop() !== "https://tasks.google.com/t1") throw new Error("Abrir no Google não abriu");
    // concluir: grava a AÇÃO e mostra «concluindo…» até o arquivo refletir
    q('.tk[data-tk="t2"] input').click(); await wait(20);
    const c = lastSent();
    if (c.cmd !== "tarefa" || c.id !== "t2" || c.acao !== "concluir") throw new Error("concluir mandou " + JSON.stringify(c));
    state({ tarefas: Object.assign({}, BASE.tarefas, { pendentes: [{ id: "t2", acao: "concluir" }] }) });
    await wait(40);
    if (!/concluindo…/.test(q('.tk[data-tk="t2"]').textContent)) throw new Error("sem «concluindo…»");
    if (q("#bTarefasBadge").textContent !== "1") throw new Error("o selo não desconta a que está concluindo");
    state({ tarefas: { status: "missing", lista: [], pendentes: [] } });
    await wait(30);
    if (!/tarefas não atualizadas/.test(q("#bTarefasNota").textContent)) throw new Error("sem o aviso de tarefas não atualizadas");
    state();
  });

  await step("chat-slash", async () => {
    q("#tabBtnRec").click();
    const ta = q("#bChatIn");
    ta.value = "/"; ta.dispatchEvent(new Event("input")); await wait(60);
    const ul = q("#bSlash");
    if (!vis(ul) || ul.querySelectorAll("li").length !== 3) throw new Error("«/» não abriu a lista de skills");
    if (!ul.textContent.includes("/consulta") || !/Responde o que era esperado/.test(ul.textContent)) throw new Error("linha sem nome e descrição");
    ta.value = "/torq"; ta.dispatchEvent(new Event("input")); await wait(40);
    if (!/turbi-design:torque/.test(ul.querySelector("li").textContent)) throw new Error("o filtro não achou o skill do plugin");
    ta.value = "/"; ta.dispatchEvent(new Event("input")); await wait(40);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await wait(10);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); await wait(20);
    if (ta.value !== "/review ") throw new Error("Tab completou para «" + ta.value + "»");
    if (vis(ul)) throw new Error("a lista não fechou ao completar");
    const n = S.chat.length;
    ta.value = "/review contrato da reserva"; ta.dispatchEvent(new Event("input")); await wait(20);
    if (vis(ul)) throw new Error("a lista reabriu nos argumentos");
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await wait(30);
    if (S.chat.length !== n + 1 || S.chat[n].prompt !== "/review contrato da reserva") throw new Error("o comando não foi cru: " + JSON.stringify(S.chat[n]));
    // Esc com a lista aberta fecha só a lista
    S.fire("bubble-chat-done", { ok: true }); await wait(20);
    ta.value = "/c"; ta.dispatchEvent(new Event("input")); await wait(40);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(20);
    if (vis(ul)) throw new Error("Esc não fechou a lista");
    if (!document.body.classList.contains("open")) throw new Error("Esc da lista fechou o painel");
    ta.value = "";
  });

  // ADR-0043 — the agent asks mid-turn: the options are buttons, one click on a
  // single question answers it, and what comes back is question → label.
  await step("chat-pergunta", async () => {
    q("#tabBtnRec").click();
    const ta = q("#bChatIn");
    ta.value = "qual cor?"; ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await wait(30);
    S.fire("bubble-chat-ask", { requestId: "r1", kind: "question", tool: "AskUserQuestion", description: "", canRemember: false,
      input: { questions: [{ question: "Qual cor?", header: "Cor", multiSelect: false,
        options: [{ label: "Vermelho", description: "a do alerta" }, { label: "Azul", description: "a calma" }] }] } });
    await wait(40);
    const box = q("#bChatLog .agentask");
    if (!vis(box)) throw new Error("a pergunta não apareceu");
    const opts = box.querySelectorAll(".askopt");
    if (opts.length !== 2 || !/Azul/.test(opts[1].textContent) || !/a calma/.test(opts[1].textContent)) throw new Error("opções sem rótulo e descrição");
    // the parent's 340px: nothing in the question may push the panel sideways
    if (box.scrollWidth > box.clientWidth + 1) throw new Error("a pergunta transborda: " + box.scrollWidth + " > " + box.clientWidth);
    opts[1].click(); await wait(30);
    const a = S.answers[S.answers.length - 1];
    if (!a || a.requestId !== "r1" || a.channel !== "bubble" || !a.allow || a.answers["Qual cor?"] !== "Azul") throw new Error("resposta errada: " + JSON.stringify(a));
    if (!box.classList.contains("answered")) throw new Error("a pergunta respondida continua aberta");
    // a permission: Allow / Deny, with what would run
    S.fire("bubble-chat-ask", { requestId: "r2", kind: "permission", tool: "Write", description: "x.md", canRemember: true,
      input: { file_path: "/acervo/notas/x.md", content: "oi" } });
    await wait(40);
    const perm = [...document.querySelectorAll("#bChatLog .agentask.perm")].pop();
    if (!perm || !perm.textContent.includes("/acervo/notas/x.md")) throw new Error("a permissão não diz o que seria escrito");
    const btns = [...perm.querySelectorAll("button")].map((b) => b.textContent);
    if (btns.length !== 3) throw new Error("botões da permissão: " + JSON.stringify(btns));
    S.fire("bubble-chat-done", { ok: true }); await wait(30);
    if (!perm.classList.contains("answered")) throw new Error("o fim do turno não fechou a pergunta pendente");
    // a terminal-only command does not go to the chat: the main window runs it
    const nChat = S.chat.length, nSent = S.sent.length;
    ta.value = "/login"; ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await wait(30);
    if (S.chat.length !== nChat) throw new Error("/login foi mandado ao chat");
    const sent = S.sent.slice(nSent).find((x) => x.cmd === "terminal-command");
    if (!sent || sent.command !== "/login") throw new Error("/login não foi para o terminal: " + JSON.stringify(S.sent.slice(nSent)));
    q("#bChatNova").click(); await wait(20);
  });

  await step("chat", async () => {
    q("#tabBtnRec").click();
    const ta = q("#bChatIn");
    ta.value = "o que o Rick pediu agora?";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(40);
    const call = S.chat[S.chat.length - 1];
    if (!call || call.channel !== "bubble") throw new Error("o chat não foi pelo canal do balão: " + JSON.stringify(call));
    if (!/@brainstorming\\/frota-2026\\/meetings\\/x\\/reuniao\\.md/.test(call.prompt) || !/o que o Rick pediu agora\\?$/.test(call.prompt)) throw new Error("prompt: " + call.prompt);
    if (!/pensando/.test(q("#bChatState").textContent) || !vis(q("#bChatStop"))) throw new Error("sem «pensando…» e Parar");
    S.fire("bubble-chat-delta", "O Rick pediu **o orçamento** até sexta.\\n- revisar frota");
    await wait(30);
    S.fire("bubble-chat-done", { ok: true });
    await wait(120);
    const a = [...document.querySelectorAll("#bChatLog .msg.a")].pop();
    if (!a || !a.querySelector("strong") || !a.querySelector("li")) throw new Error("resposta sem formatação: " + (a && a.innerHTML));
    if (!a.querySelector(".copy")) throw new Error("sem copiar");
    if (!vis(q("#bChatNova"))) throw new Error("sem «nova conversa»");
    if (S.heights.length === 0) throw new Error("o cartão não pediu para crescer com a conversa");
    // segunda pergunta segue a mesma sessão (fresh=false)
    ta.value = "e o prazo?";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(30);
    if (S.chat[S.chat.length - 1].fresh !== false) throw new Error("o seguimento abriu sessão nova");
    q("#bChatStop").click(); await wait(20);
    if (!S.calls.chat_cancel) throw new Error("Parar não matou o processo");
    // Shift+Enter não envia
    const n = S.chat.length;
    ta.value = "linha";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    await wait(20);
    if (S.chat.length !== n) throw new Error("Shift+Enter enviou");
  });

  await step("pergunta-trocar", async () => {
    state({ rec: "recording", meeting: true, startedAt: NOW - 60000, prompt: { kind: "switch", eventId: "e2", titulo: "Planejamento" } });
    await wait(50);
    if (!vis(q("#bPrompt"))) throw new Error("a pergunta não aparece");
    if (!/Começou: Planejamento — trocar para ela\\?/.test(q("#bPromptText").textContent)) throw new Error("texto: " + q("#bPromptText").textContent);
    q("#bPromptActs").querySelector("button").click();
    await wait(30);
    const c = lastSent();
    if (c.cmd !== "switch" || c.id !== "e2") throw new Error("trocar mandou " + JSON.stringify(c));
    state({ rec: "recording", meeting: true, startedAt: NOW - 60000, prompt: null });
  });

  await step("esc-fecha", async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(260);
    if (document.body.classList.contains("open")) throw new Error("Esc não fechou");
    if (S.expand[S.expand.length - 1] !== false) throw new Error("não pediu ao backend para encolher");
  });

  await step("clique-fora-fecha", async () => {
    click(q("#icon"));
    await wait(200);
    if (!document.body.classList.contains("open")) throw new Error("não reabriu");
    window.dispatchEvent(new Event("blur"));
    await wait(260);
    if (document.body.classList.contains("open")) throw new Error("perder o foco não fechou");
  });

  await step("pergunta-nova-abre", async () => {
    state({ rec: "idle", prompt: { kind: "suggest", eventId: "e1", titulo: "1:1 com a equipe" } });
    await wait(200);
    if (!document.body.classList.contains("open")) throw new Error("uma pergunta nova não abriu o painel");
    if (!/Gravar 1:1 com a equipe\\?/.test(q("#bPromptText").textContent)) throw new Error("sugestão: " + q("#bPromptText").textContent);
  });

  await step("tamanho-64", async () => {
    S.fire("bubble-size", 64);
    await wait(40);
    const r = q("#icon").getBoundingClientRect();
    if (Math.round(r.width) !== 64) throw new Error("o tamanho grande não aplicou: " + r.width);
    S.fire("bubble-size", 32);
  });

  await step("ingles", async () => {
    state({ lang: "en", rec: "idle", prompt: null });
    await wait(60);
    if (!/ready to record/.test(q("#bStatusText").textContent)) throw new Error("status em inglês: " + q("#bStatusText").textContent);
    if (!/Record/.test(q("#bGravar").textContent)) throw new Error("botão: " + q("#bGravar").textContent);
    if (!/Open in Loro/.test(q("#bAbrir").textContent)) throw new Error("abrir: " + q("#bAbrir").textContent);
    if (!/Ask Claude/.test(q("#bChatIn").placeholder)) throw new Error("chat: " + q("#bChatIn").placeholder);
  });

  document.title = "RESULT" + JSON.stringify({ steps: seen, errors: S.errors.slice(0, 12), viewport: [document.body.clientWidth, document.body.clientHeight], contraste: S.contraste });
})();
</script>
`;

for (const [nome, corpo] of [["STUB", STUB], ["DRIVER", DRIVER]]) {
  try { new Function(corpo.replace(/<\/?script>/g, "")); }
  catch (e) { console.log(nome + " com erro de sintaxe: " + e.message); process.exit(1); }
}

// O TAMANHO DA JANELA É O DO BALÃO, e o Chrome headless não desce dele: medido em
// 2026-11-18, `--window-size=340,520` deu uma viewport de 500×433 — o painel era
// medido 160px mais largo e 87px mais baixo que o de verdade, e o smoke passava
// com o rodapé fora da tela. O documento é preso no tamanho real (bubble.rs
// EXPANDED = 340×520) dentro de uma janela maior.
const [W, H] = (process.env.SMOKE_SIZE || "340,520").split(",").map(Number);
// E SEM TRANSIÇÃO: medido em 2026-11-18, o Chrome headless com --dump-dom não
// avança transições CSS — 250 ms depois de abrir, o painel seguia em opacity 0
// (visibility visible, 499px de altura: parado no primeiro quadro do scale). O
// smoke mede o ESTADO FINAL; a transição em si (140 ms, sem repetição) é
// conferida no fonte por bubble.test.js e vista no app de verdade.
const FRAME = `<style>html, body { width: ${W}px !important; height: ${H}px !important; } *, *::before { transition: none !important; }</style>`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loro-smoke-bubble-"));
const page = html
  .replace("<head>", `<head><base href="${pathToFileURL(REAL_SRC + path.sep)}">` + STUB)
  .replace("</head>", FRAME + "</head>")
  .replace("</body>", DRIVER + "</body>");
const file = path.join(tmp, "bubble.html");
fs.writeFileSync(file, page);

const shot = process.env.SMOKE_SHOT || "";
const dom = execFileSync(CHROME, [
  ...(shot ? ["--screenshot=" + shot, "--hide-scrollbars", "--default-background-color=00000000"] : []),
  // SMOKE_SCHEME=dark|light força o tema (sem ele vale o do sistema)
  ...(process.env.SMOKE_SCHEME ? ["--blink-settings=preferredColorScheme=" + (process.env.SMOKE_SCHEME === "dark" ? 0 : 1)] : []),
  "--headless", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
  "--window-size=" + Math.max(W, 600) + "," + Math.max(H + 100, 700), "--virtual-time-budget=20000", "--dump-dom", pathToFileURL(file).href,
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 });

const m = /<title>RESULT(\{[\s\S]*?\})<\/title>/.exec(dom);
if (!m) {
  fs.writeFileSync(path.join(tmp, "dom.html"), dom);
  console.log("SEM RESULTADO — o driver não chegou ao fim. DOM em", path.join(tmp, "dom.html"));
  process.exit(1);
}
const out = JSON.parse(m[1]);
let bad = 0;
for (const [k, v] of Object.entries(out.steps)) {
  const ok = v === "ok";
  if (!ok) bad++;
  console.log((ok ? "  ok   " : "  FALHA") + "  " + k + (ok ? "" : "  → " + v));
}
if (out.viewport) console.log("viewport:", out.viewport.join("x"));
if (out.contraste) console.log("contraste:", JSON.stringify(out.contraste));
if (out.errors.length) {
  console.log("\nERROS DE JS NO CONSOLE:");
  for (const e of out.errors) console.log("  · " + e);
}
console.log(bad || out.errors.length ? "\nSMOKE DO BALÃO FALHOU" : "\nSMOKE DO BALÃO OK");
process.exit(bad || out.errors.length ? 1 : 0);
