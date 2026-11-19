// O Adalto dentro da janela principal (ADR-0041 §15). Cada <img src="parrot.png">
// vira o desenho em SVG (o mesmo do balão), para seguir o tema e para andar e
// fazer truques enquanto grava. O CSS (style.css, .parrotbox) é dono do
// movimento; aqui ficam a troca, o sorteio e o relógio.
window.LoroParrot = (() => {
  const SVG = `<svg viewBox="-12.14 -4.14 116.28 116.28" aria-hidden="true"><defs><clipPath id="parrotHead__N__"><circle cx="60" cy="29" r="15"/></clipPath></defs><g class="actor"><g class="legs" fill="none" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><path class="leg a" d="M45 75 V91 H54"/><path class="leg b" d="M54 73 V89 H63"/></g><g class="bob"><path d="M36 62 L9 90 Q6 95 12 94 L46 76 Z" fill="#1F7F3B"/><path d="M30 72 L9 90 Q6 95 12 94 L36 81 Z" fill="#2D6BE0"/><path class="wing far" d="M37 40 Q29 62 47 71 Q54 57 47 41 Z" fill="#17692F"/><ellipse cx="47" cy="54" rx="17" ry="25" transform="rotate(-22 47 54)" fill="#2FA84F"/><g class="wing near"><path d="M37 40 Q29 62 47 71 Q54 57 47 41 Z" fill="#1F7F3B"/><path d="M37 40 Q34 47 35 53 Q43 51 47 41 Z" fill="#E5484D"/></g><circle cx="60" cy="29" r="15" fill="#2FA84F"/><g clip-path="url(#parrotHead__N__)"><circle cx="65" cy="29.5" r="12" fill="#F7C500"/><ellipse cx="69" cy="17" rx="10" ry="6.5" fill="#3B82F6"/></g><path d="M71 20 C84 18 90 30 84 40 C81 44 76 44 74 41 C78 37 77 31 71 30 Z" class="beak"/><circle cx="63" cy="27" r="5.6" fill="#FFFFFF"/><circle cx="64.4" cy="28.6" r="2.5" fill="#1B1B1F"/><g transform="rotate(20 63 27)"><rect x="55" y="19" width="16" height="7.2" fill="#F7C500"/><path d="M56 26.2 H70.5" stroke="#1B1B1F" stroke-width="2.6" stroke-linecap="round"/></g></g></g><g class="say"><path d="M5 -1 H27 A12 12 0 0 1 39 11 V13 A12 12 0 0 1 34 22.6 L44 32 L27 25 H5 A12 12 0 0 1 -7 13 V11 A12 12 0 0 1 5 -1 Z" fill="#FFFFFF" stroke="#1B1B1F" stroke-width="2.4" stroke-linejoin="round"/><circle cx="6" cy="12" r="2.7" fill="#1B1B1F"/><circle cx="16" cy="12" r="2.7" fill="#1B1B1F"/><circle cx="26" cy="12" r="2.7" fill="#1B1B1F"/></g></svg>`;
  const TRICKS = { jump: 1100, flap: 1100, exit: 4000, flip: 2400, spin: 900, peck: 1400, fly: 4400, talk: 2400 };
  let n = 0, recording = false, timer = null, last = "";
  const boxes = () => document.querySelectorAll(".parrotbox");

  function mount(img) {
    const box = document.createElement("span");
    box.className = "parrotbox " + (img.className || "");
    const w = img.getAttribute("width"), h = img.getAttribute("height");
    if (w) box.style.width = w + "px";
    if (h) box.style.height = h + "px";
    box.setAttribute("aria-hidden", "true");
    box.innerHTML = SVG.replace(/__N__/g, String(n++));
    box.classList.toggle("walk", recording);
    img.replaceWith(box);
  }
  function mountAll(root) {
    (root || document).querySelectorAll('img[src="parrot.png"]').forEach(mount);
  }

  function clear() { boxes().forEach((b) => { for (const k of Object.keys(TRICKS)) b.classList.remove("t-" + k); }); }
  function arm() { timer = setTimeout(next, 1200 + Math.random() * 3300); }
  function next() {
    const names = Object.keys(TRICKS).filter((k) => k !== last);
    last = names[Math.floor(Math.random() * names.length)];
    boxes().forEach((b) => b.classList.add("t-" + last));
    timer = setTimeout(() => { clear(); arm(); }, TRICKS[last] + 80);
  }
  // gravando (e não pausado): anda e faz truques; senão, fica parado
  function setRecording(on) {
    on = !!on;
    if (on === recording) return;
    recording = on;
    boxes().forEach((b) => b.classList.toggle("walk", on));
    if (on) { arm(); return; }
    clearTimeout(timer); timer = null; clear();
  }

  function start() {
    mountAll();
    // telas montadas depois (o assistente de boas-vindas) também trocam
    new MutationObserver((muts) => {
      for (const m of muts) for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('img[src="parrot.png"]')) mount(node);
        else if (node.querySelector) mountAll(node);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
  return { mountAll, setRecording };
})();
