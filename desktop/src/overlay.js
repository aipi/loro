// Legenda flutuante — mostra as últimas falas, translúcida e sempre no topo.
const { listen } = window.__TAURI__.event;
const _inv = window.__TAURI__.core && window.__TAURI__.core.invoke;
if (_inv) _inv("client_log", { msg: "[overlay] carregado" });
const txt = document.getElementById("txt");
const dot = document.getElementById("dot");

let lines = [];
listen("transcript-line", (e) => {
  lines.push(e.payload);
  lines = lines.slice(-3); // mantém as últimas
  txt.textContent = lines.join("  ");
});
listen("rec-state", (e) => {
  dot.classList.toggle("on", !!e.payload);
  if (!e.payload) return;
});
