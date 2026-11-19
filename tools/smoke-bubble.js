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
window.__SMOKE__ = { errors: [], calls: {}, handlers: {}, sent: [], expand: [], drags: 0 };
window.__SMOKE__.fire = (name, payload) => {
  for (const fn of window.__SMOKE__.handlers[name] || []) fn({ payload });
};
window.addEventListener("error", (e) => window.__SMOKE__.errors.push("error: " + e.message + " @ " + (e.filename||"").split("/").pop() + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => window.__SMOKE__.errors.push("reject: " + (e.reason && e.reason.message || e.reason)));
window.__TAURI__ = {
  core: {
    invoke: (cmd, args) => {
      window.__SMOKE__.calls[cmd] = (window.__SMOKE__.calls[cmd] || 0) + 1;
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
  const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
  const mouse = (type, target, x, y) => (target || document).dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y, clientX: x, clientY: y }));
  const lastSent = () => S.sent[S.sent.length - 1] || {};
  let stopped = false;
  const step = async (name, fn) => {
    if (stopped) return;
    try { await fn(); seen[name] = "ok"; }
    catch (e) { seen[name] = "THREW: " + (e && e.message || e); }
    await wait(60);
    if (STOP && name === STOP) { stopped = true; document.title = "RESULT" + JSON.stringify({ steps: seen, errors: S.errors.slice(0, 12) }); }
  };
  const NOW = Date.now();
  const BASE = {
    lang: "pt", rec: "idle", meeting: false, canRecord: true, startedAt: 0, pausedMs: 0, pauseStart: 0,
    titulo: "", tema: "", destino: "frota-2026",
    temas: [{ slug: "frota-2026", nome: "frota 2026" }, { slug: "vendas", nome: "vendas" }],
    linhas: [], agenda: { status: "ok", eventos: [] }, prompt: null, aviso: "",
  };
  const state = (over) => S.fire("bubble-state", Object.assign({}, BASE, over || {}));
  await wait(300);

  await step("boot", async () => {
    if (!q("#icon img")) throw new Error("sem o ícone");
    if (!/loro-icon\\.png$/.test(q("#icon img").src)) throw new Error("o ícone não é o do app: " + q("#icon img").src);
    if (!S.sent.some((c) => c.cmd === "hello")) throw new Error("o balão não pediu o estado à janela principal");
    if (vis(q("#panel"))) throw new Error("o painel nasce aberto");
    const r = q("#icon").getBoundingClientRect();
    if (Math.round(r.width) !== 64 || Math.round(r.height) !== 64) throw new Error("o ícone não tem 64pt: " + r.width + "x" + r.height);
  });

  await step("ocioso-sem-selo", async () => {
    state();
    await wait(50);
    if (vis(q("#badge"))) throw new Error("ocioso mostra selo");
    if (vis(q("#time"))) throw new Error("ocioso mostra tempo");
  });

  await step("gravando-selo-estavel", async () => {
    state({ rec: "recording", meeting: true, startedAt: NOW - 65000, tema: "frota-2026", titulo: "Semanal" });
    await wait(50);
    const b = q("#badge");
    if (!vis(b) || !b.classList.contains("rec")) throw new Error("gravando sem o ponto vermelho");
    if (!vis(q("#time")) || !/^1:0[5-9]$/.test(q("#time").textContent)) throw new Error("tempo: " + q("#time").textContent);
    // NÃO PISCA: medido, não lido do CSS — duas leituras com 1,3 s entre elas
    const look = () => { const cs = getComputedStyle(b); return [cs.backgroundColor, cs.opacity, cs.visibility, cs.display, cs.transform].join("|"); };
    const a1 = look();
    for (const el of [b, q("#time"), q("#icon"), q("#icon img")]) {
      const cs = getComputedStyle(el);
      if (cs.animationName !== "none") throw new Error("animação em " + el.id + ": " + cs.animationName);
      if (cs.transitionDuration !== "0s") throw new Error("transição em " + (el.id || el.tagName) + ": " + cs.transitionDuration);
    }
    await wait(1300);
    if (look() !== a1) throw new Error("o selo mudou sozinho: " + a1 + " → " + look());
    // a única coisa que muda é o número do relógio
    const r = q("#time").getBoundingClientRect();
    if (r.right > 84 || r.bottom > 84 || r.left < 0) throw new Error("o tempo sai da janela recolhida (84×84): " + JSON.stringify([r.left, r.right, r.bottom]));
  });

  await step("pausado", async () => {
    state({ rec: "paused", meeting: true, startedAt: NOW - 65000, pauseStart: NOW - 5000, tema: "frota-2026" });
    await wait(50);
    if (!q("#badge").classList.contains("pause")) throw new Error("pausado sem o selo de pausa");
  });

  await step("clique-abre", async () => {
    const before = S.sent.length;
    mouse("mousedown", q("#icon"), 100, 100);
    mouse("mousemove", document, 102, 101);
    mouse("mouseup", document, 102, 101);
    await wait(80);
    if (!document.body.classList.contains("open")) throw new Error("o clique não abriu o painel");
    if (S.expand[S.expand.length - 1] !== true) throw new Error("não pediu ao backend para crescer");
    if (S.drags) throw new Error("um clique virou arrasto");
    const cmds = S.sent.slice(before).map((c) => c.cmd);
    if (cmds.some((c) => /start|pause|resume|stop|toggle/.test(c))) throw new Error("o clique no ícone mandou gravar/pausar: " + cmds);
    if (vis(q("#time"))) throw new Error("aberto, o tempo vai para o cabeçalho, não para baixo do ícone");
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

  await step("painel-cinco-partes", async () => {
    state({ rec: "recording", meeting: true, startedAt: NOW - 125000, tema: "frota-2026", titulo: "Semanal de custos",
      linhas: [{ who: "mic", text: "vamos começar pelo orçamento" }, { who: "system", text: "o número fechou ontem" }],
      agenda: { status: "ok", eventos: [
        { id: "e1", titulo: "1:1 com a equipe", inicioMs: NOW + 3600000, fimMs: NOW + 5400000, comConvidados: true, agendada: false },
        { id: "e2", titulo: "Planejamento", inicioMs: NOW + 7200000, fimMs: NOW + 9000000, comConvidados: true, agendada: true },
      ] } });
    await wait(80);
    if (!/gravando · 2:0/.test(q("#bStatus").textContent)) throw new Error("cabeçalho: " + q("#bStatus").textContent);
    const tail = q("#bTail").textContent;
    if (!/você/.test(tail) || !/sistema/.test(tail)) throw new Error("a transcrição não diz quem falou: " + tail);
    if (vis(q("#bGravar")) || !vis(q("#bPausar")) || !vis(q("#bEncerrar")) || !vis(q("#bNova"))) throw new Error("controles errados para «gravando»");
    if (!q("#bTema").disabled) throw new Error("a ideia de uma gravação em curso não pode ser trocada pelo seletor");
    const lis = document.querySelectorAll("#bAgenda li");
    if (lis.length !== 2) throw new Error("próximas reuniões: " + lis.length);
    if (lis[0].querySelector("input").checked || !lis[1].querySelector("input").checked) throw new Error("o «gravar» por evento não reflete o agendado");
    if (!vis(q("#bAbrir"))) throw new Error("sem «Abrir no Loro»");
    lis[0].querySelector("input").click();
    await wait(30);
    const c = lastSent();
    if (c.cmd !== "schedule" || c.id !== "e1" || c.on !== true || c.tema !== "frota-2026") throw new Error("agendar mandou " + JSON.stringify(c));
    // nada estoura a largura do painel
    const p = q("#panel"), body = q("#body");
    if (body.scrollWidth > body.clientWidth + 1) throw new Error("o painel estoura na horizontal: " + body.scrollWidth + " em " + body.clientWidth);
    const pr = p.getBoundingClientRect();
    if (Math.round(pr.width) !== document.body.clientWidth || Math.round(pr.height) !== document.body.clientHeight) {
      throw new Error("o painel não ocupa a janela: " + pr.width + "x" + pr.height + " em " + document.body.clientWidth + "x" + document.body.clientHeight);
    }
    // tudo o que importa cabe DENTRO do painel: o «gravar» de cada evento e o rodapé
    const fora = [];
    for (const el of [q("#bAbrir"), ...document.querySelectorAll("#bAgenda label")]) {
      const r = el.getBoundingClientRect();
      if (r.right > pr.right - 4 || r.bottom > pr.bottom - 4 || r.width === 0) fora.push((el.id || el.textContent.trim()) + " " + JSON.stringify([Math.round(r.right), Math.round(r.bottom)]));
    }
    if (fora.length) throw new Error("fora do painel (" + Math.round(pr.right) + "x" + Math.round(pr.bottom) + "): " + fora.join(" · "));
  });

  await step("gravar-do-painel", async () => {
    state({ rec: "idle", linhas: [], agenda: { status: "missing", eventos: [] } });
    await wait(50);
    if (!vis(q("#bGravar"))) throw new Error("ocioso sem «Gravar»");
    if (q("#bTema").value !== "frota-2026") throw new Error("a última ideia não veio selecionada: " + q("#bTema").value);
    if (!/agenda não atualizada/.test(q("#bAgendaNota").textContent)) throw new Error("sem agenda, o painel não diz: " + q("#bAgendaNota").textContent);
    q("#bTema").value = "vendas"; q("#bTema").dispatchEvent(new Event("change"));
    q("#bGravar").click();
    await wait(30);
    const c = lastSent();
    if (c.cmd !== "start" || c.tema !== "vendas" || c.nova) throw new Error("gravar mandou " + JSON.stringify(c));
    // uma ideia nova pelo campo
    q("#bTema").value = "__nova__"; q("#bTema").dispatchEvent(new Event("change"));
    if (!vis(q("#bNovaIdeia"))) throw new Error("«+ nova ideia…» não abriu o campo");
    q("#bNovaIdeia").value = "lançamento q4";
    q("#bGravar").click();
    await wait(30);
    const c2 = lastSent();
    if (c2.cmd !== "start" || c2.tema !== "lançamento q4" || c2.nova !== true) throw new Error("ideia nova mandou " + JSON.stringify(c2));
    q("#bTema").value = "frota-2026"; q("#bTema").dispatchEvent(new Event("change"));
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
    state({ rec: "recording", meeting: true, startedAt: NOW - 60000, prompt: { kind: "extend", eventId: "e2", titulo: "Planejamento", minutos: 2 } });
    await wait(50);
    if (!/termina em 2 min — estender\\?/.test(q("#bPromptText").textContent)) throw new Error("estender: " + q("#bPromptText").textContent);
    state({ rec: "recording", meeting: true, startedAt: NOW - 60000, prompt: null });
  });

  await step("esc-fecha", async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(60);
    if (document.body.classList.contains("open")) throw new Error("Esc não fechou");
    if (S.expand[S.expand.length - 1] !== false) throw new Error("não pediu ao backend para encolher");
  });

  await step("clique-fora-fecha", async () => {
    mouse("mousedown", q("#icon"), 10, 10); mouse("mouseup", document, 10, 10);
    await wait(60);
    if (!document.body.classList.contains("open")) throw new Error("não reabriu");
    window.dispatchEvent(new Event("blur"));
    await wait(60);
    if (document.body.classList.contains("open")) throw new Error("perder o foco não fechou");
  });

  await step("pergunta-nova-abre", async () => {
    state({ rec: "idle", prompt: { kind: "suggest", eventId: "e1", titulo: "1:1 com a equipe" } });
    await wait(80);
    if (!document.body.classList.contains("open")) throw new Error("uma pergunta nova não abriu o painel");
    if (!/Gravar 1:1 com a equipe\\?/.test(q("#bPromptText").textContent)) throw new Error("sugestão: " + q("#bPromptText").textContent);
  });

  await step("ingles", async () => {
    state({ lang: "en", rec: "idle", prompt: null });
    await wait(60);
    if (!/ready to record/.test(q("#bStatus").textContent)) throw new Error("status em inglês: " + q("#bStatus").textContent);
    if (!/Record/.test(q("#bGravar").textContent)) throw new Error("botão: " + q("#bGravar").textContent);
    if (!/Open in Loro/.test(q("#bAbrir").textContent)) throw new Error("abrir: " + q("#bAbrir").textContent);
  });

  document.title = "RESULT" + JSON.stringify({ steps: seen, errors: S.errors.slice(0, 12), viewport: [document.body.clientWidth, document.body.clientHeight] });
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
const FRAME = `<style>html, body { width: ${W}px !important; height: ${H}px !important; }</style>`;
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
if (out.errors.length) {
  console.log("\nERROS DE JS NO CONSOLE:");
  for (const e of out.errors) console.log("  · " + e);
}
console.log(bad || out.errors.length ? "\nSMOKE DO BALÃO FALHOU" : "\nSMOKE DO BALÃO OK");
process.exit(bad || out.errors.length ? 1 : 0);
