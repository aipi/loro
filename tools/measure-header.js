#!/usr/bin/env node
// Loro — mede o CABEÇALHO numa varredura de larguras de viewport.
//
// Por que isto existe: o cabeçalho já teve três larguras de corte escritas à mão
// (1080 → 1140 → 1015), cada uma medida uma vez, num idioma, com um conteúdo — e
// cada uma envelheceu, porque o conteúdo do cabeçalho é variável (idioma, nome do
// projeto, contadores, e o chip do rascunho até o seu teto de 190px). A última
// delas colidia na largura PADRÃO da janela. Uma medição que ninguém pode repetir
// é uma afirmação sem prova: aqui ela é repetível.
//
// O markup medido é EXTRAÍDO do index.html que envia e a folha é a style.css que
// envia — nada é redigitado. O que o script escreve é só o conteúdo que o app
// preenche em tempo de execução, e escreve o PIOR CASO de propósito.
//
// Uso:  node tools/measure-header.js            (falha se houver sobreposição)
//       node tools/measure-header.js --verbose   (imprime a tabela inteira)
// Precisa do Google Chrome instalado; sem ele, sai com 0 e diz que pulou (este
// script NÃO entra no `make test`, que é portátil).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const SRC = path.join(__dirname, "..", "desktop", "src");
const VERBOSE = process.argv.includes("--verbose");
const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const CHROME = CHROMES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } });
if (!CHROME) {
  console.log("measure-header: pulado — nenhum Chrome/Chromium encontrado.");
  console.log("  (esta medição é opcional e não faz parte de `make test`)");
  process.exit(0);
}

const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const m = /<header class="apphead" id="appHead">[\s\S]*?<\/header>/.exec(html);
if (!m) {
  console.error("measure-header: não achei o <header id=\"appHead\"> no index.html");
  process.exit(1);
}
const header = m[0];

// O conteúdo que o app escreve em tempo de execução. Cada caso é um PIOR CASO
// plausível, não um caso típico: prever o típico foi o erro que produziu os
// cortes anteriores.
const CASES = [
  { nome: "en · rascunho longo · gravando · contadores", lang: "en", proj: "Loro", draft: "feat/acervo-navegacao-lateral", rec: true, badges: true },
  { nome: "pt · rascunho longo · gravando · contadores", lang: "pt", proj: "Loro", draft: "feat/acervo-navegacao-lateral", rec: true, badges: true },
  { nome: "pt · projeto longo · rascunho longo · gravando", lang: "pt", proj: "Base de conhecimento do time", draft: "feat/acervo-navegacao-lateral", rec: true, badges: true },
  { nome: "pt · sem rascunho · sem gravação", lang: "pt", proj: "Loro", draft: "", rec: false, badges: false },
];
// 860 é o piso do tauri.conf; 1280 é a largura PADRÃO da janela — a largura em
// que a versão anterior colidia, e por isso ela nunca sai desta lista.
const WIDTHS = [1600, 1400, 1300, 1284, 1280, 1200, 1141, 1140, 1100, 1050, 1016, 1015, 980, 940, 900, 860];

const ROTULOS_EN = { home: "Home", organize: "Organize", knowledge: "Knowledge", review: "Review" };

function page(c) {
  return `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${SRC}/style.css"></head>
<body><div id="app">${header}</div>
<script>
document.getElementById("acervoName").textContent = ${JSON.stringify(c.proj)};
document.getElementById("appVersion").textContent = "v0.13.0";
const dr = document.getElementById("headDraft");
dr.hidden = ${!c.draft};
if (${!!c.draft}) dr.innerHTML = '<span class="mono">' + ${JSON.stringify(c.draft)} + '</span><span class="rvchipcaret">\\u2304</span>';
const rec = document.getElementById("headRec");
rec.hidden = ${!c.rec};
if (${!!c.rec}) rec.textContent = "\\u25cf gravando \\u00b7 12:34";
document.getElementById("recLabel").textContent = ${JSON.stringify(c.lang === "en" ? "Record" : "Gravar")};
if (${c.lang === "en"}) {
  const rot = ${JSON.stringify(ROTULOS_EN)};
  for (const b of document.querySelectorAll("#destNav .dest")) {
    (b.querySelector("span[data-i18n]") || b).textContent = rot[b.dataset.dest];
  }
}
if (${!!c.badges}) for (const id of ["destQueueBadge", "destReviewBadge"]) {
  const n = document.getElementById(id); n.hidden = false; n.textContent = "2";
}
const head = document.getElementById("appHead"), nav = document.getElementById("destNav");
const left = document.getElementById("acervoSwitch"), right = head.querySelector(".headright");
const r = (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
const H = r(head), N = r(nav), L = r(left), R = r(right);
document.title = "RESULT" + JSON.stringify({
  W: H.w, nav: N, left: L, right: R,
  colideDireita: N.r - R.l,
  colideEsquerda: L.r - N.l,
  foraDoEixo: Math.round((N.l + N.r) / 2 - (H.l + H.r) / 2),
  rolagemLateral: document.documentElement.scrollWidth - document.documentElement.clientWidth,
});
</script></body></html>`;
}

function measure(file, w) {
  const dom = execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
    `--window-size=${w},830`, "--virtual-time-budget=800", "--dump-dom", `file://${file}`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 });
  const t = /<title>RESULT(\{.*?\})<\/title>/.exec(dom);
  if (!t) throw new Error(`sem resultado em ${w}px`);
  return JSON.parse(t[1]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loro-head-"));
const falhas = [];
try {
  for (const c of CASES) {
    const file = path.join(tmp, `head-${CASES.indexOf(c)}.html`);
    fs.writeFileSync(file, page(c));
    if (VERBOSE) {
      console.log("\n=== " + c.nome + " ===");
      console.log("   W  | nav          | esq→ | ←dir (larg) | colisão dir/esq | eixo | rolagem");
    }
    for (const w of WIDTHS) {
      const o = measure(file, w);
      const ruim = o.colideDireita > 0 || o.colideEsquerda > 0 || o.rolagemLateral > 0;
      if (ruim) {
        falhas.push(`${c.nome} @ ${w}px — colisão direita=${o.colideDireita} esquerda=${o.colideEsquerda} rolagem=${o.rolagemLateral}`);
      }
      if (VERBOSE) {
        console.log(
          `${String(w).padStart(5)} | ${String(o.nav.l).padStart(4)}→${String(o.nav.r).padEnd(5)} ` +
          `| ${String(o.left.r).padStart(4)} | ${String(o.right.l).padStart(4)} (${String(o.right.w).padStart(3)}) ` +
          `| ${String(o.colideDireita).padStart(5)} /${String(o.colideEsquerda).padStart(5)} ` +
          `| ${String(o.foraDoEixo).padStart(4)} | ${String(o.rolagemLateral).padStart(4)}${ruim ? "  ❌" : ""}`
        );
      }
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (falhas.length) {
  console.error("\nmeasure-header: DEFEITO — a pílula é sobreposta ou o corpo rola de lado:");
  for (const f of falhas) console.error("  " + f);
  console.error("\nDESIGN.md §2 regra 9 (nenhum controle cortado) e §7 (o corpo nunca rola de lado).");
  process.exit(1);
}
console.log(`measure-header: OK — ${CASES.length} casos × ${WIDTHS.length} larguras, ` +
  "nenhuma sobreposição e nenhuma rolagem lateral.");
