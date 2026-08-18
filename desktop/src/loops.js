// Loro — pure derivations for loops (ADR-0029 §3.8/§3.9). Isolated, testable
// module: loaded in the browser via <script> (defines window.LoroLoops) and in
// Node via require() for node --test.
//
// Two contracts, both load-bearing (the same ones review.js states):
//
// 1. It is PURE. It takes the plain data `loop_status` sends and returns NEW
//    plain data — no DOM, no IPC, no mutation of an input. The schedule maths
//    has one home and one test.
// 2. It is LANGUAGE-FREE. Every function returns semantic enums, numbers or
//    dates (`tone: "amber"`, `kind: "noop"`); app.js turns them into msgids at
//    paint time. The msgid scanners (tests/i18n.test.js, tests/vocabulary.test.js)
//    read app.js, so a pt-BR literal parked here would escape both.
//
// THE CLOCK LIVES HERE, and that is the whole point of ADR-0029 §4.6(a): a loop
// runs only while the app is open, so the app's own `Date` is the clock. It knows
// the person's timezone and its DST rules, which is why the backend never needs a
// timezone database: it receives `nowFields(new Date())` and compares civil
// values (§3.10 B3/B4).
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroLoops = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const p2 = (n) => String(n).padStart(2, "0");

  // ---- the rhythm ---------------------------------------------------------
  // `min:<n>` · `dia:<hh>:<mm>` · `semana:<dow 0=Sunday>:<hh>:<mm>` — the same
  // three shapes the backend parses, and the only ones either side accepts.
  function parseRhythm(ritmo) {
    const parts = String(ritmo || "").trim().split(":");
    const n = (i) => {
      const v = Number(parts[i]);
      return Number.isInteger(v) ? v : NaN;
    };
    if (parts[0] === "min") {
      const minutes = n(1);
      return minutes >= 1 && minutes <= 1440 ? { kind: "min", minutes } : null;
    }
    if (parts[0] === "dia") {
      const hh = n(1), mi = n(2);
      return hh >= 0 && hh < 24 && mi >= 0 && mi < 60 ? { kind: "dia", hh, mi } : null;
    }
    if (parts[0] === "semana") {
      const dow = n(1), hh = n(2), mi = n(3);
      return dow >= 0 && dow < 7 && hh >= 0 && hh < 24 && mi >= 0 && mi < 60
        ? { kind: "semana", dow, hh, mi }
        : null;
    }
    return null;
  }

  function buildRhythm(r) {
    if (!r) return "";
    if (r.kind === "min") return `min:${r.minutes}`;
    if (r.kind === "dia") return `dia:${p2(r.hh)}:${p2(r.mi)}`;
    if (r.kind === "semana") return `semana:${r.dow}:${p2(r.hh)}:${p2(r.mi)}`;
    return "";
  }

  // ---- the clock ----------------------------------------------------------
  // The local civil time the backend decides with. One builder, so no surface
  // can hand it a different notion of "now".
  function nowFields(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return {
      epochMs: dt.getTime(),
      date: `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`,
      hh: dt.getHours(),
      mi: dt.getMinutes(),
      weekday: dt.getDay(),
    };
  }

  // When this loop runs next, in epoch ms (0 = never / unreadable rhythm).
  // Uses the platform's own calendar, so a rhythm expressed in wall-clock terms
  // survives a DST change instead of drifting an hour.
  function nextRunAt(ritmo, lastRunMs, nowMs) {
    const r = parseRhythm(ritmo);
    if (!r) return 0;
    const now = Number(nowMs) || 0;
    if (r.kind === "min") {
      const from = Number(lastRunMs) || now;
      const next = from + r.minutes * 60000;
      return next > now ? next : now;
    }
    const at = new Date(now);
    at.setHours(r.hh, r.mi, 0, 0);
    if (r.kind === "dia") {
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.getTime();
    }
    let delta = (r.dow - at.getDay() + 7) % 7;
    if (delta === 0 && at.getTime() <= now) delta = 7;
    at.setDate(at.getDate() + delta);
    return at.getTime();
  }

  // ---- state, as the surfaces read it ------------------------------------
  // The seven states of §3.9. `blocked` is the one every scheduler forgets:
  // "armed" and "able to run" are different facts.
  const STATES = ["off", "armed", "running", "queued", "blocked", "failing", "expired"];

  // Which existing semantic colour a state wears. No new token: amber = needs
  // you · teal = AI · muted = does nothing (DESIGN.md §3).
  function stateTone(state) {
    if (state === "running") return "teal";
    if (state === "armed" || state === "queued") return "teal-soft";
    if (state === "blocked" || state === "failing") return "amber";
    return "muted";
  }

  // Does this state mean the loop is going to act on its own? The header mark
  // exists for exactly this question.
  function isLive(state) {
    return state === "running" || state === "queued";
  }

  // What the header mark has to say, or null when nothing is happening: an idle
  // tick must not touch the DOM (the recording pill's own rule).
  function headerCounts(status) {
    const running = ((status && status.running) || []).length;
    const queued = ((status && status.queued) || []).length;
    if (!running && !queued) return null;
    return { running, queued };
  }

  // ---- history -----------------------------------------------------------
  // Consecutive quiet cycles collapse into ONE row with a count (§3.10 D1), so
  // a loop that had nothing to say for six weeks does not become an activity
  // feed. Input is newest-first, and so is the output.
  function collapseCycles(cycles) {
    const out = [];
    for (const c of cycles || []) {
      const last = out[out.length - 1];
      if (c && c.outcome === "nothing" && last && last.outcome === "nothing") {
        last.n += 1;
        last.from = c.startedDate || last.from;   // input is newest-first
        continue;
      }
      out.push({ ...c, n: 1, from: (c && c.startedDate) || "", to: (c && c.startedDate) || "" });
    }
    return out;
  }

  // The timeline of §3.9's third distance: what each cycle did, «now» when one is
  // running, and the next run in outline. Oldest → newest, left to right.
  function timelineDots(cycles, opts) {
    const o = opts || {};
    const past = (cycles || []).slice(0, o.max || 4).reverse().map((c) => ({
      kind: "cycle",
      outcome: c.outcome,
      date: c.startedDate || "",
      files: (c.files || []).length,
      n: c.n || 1,
      err: c.err || "",
    }));
    const dots = past;
    if (o.running) dots.push({ kind: "now", outcome: "running" });
    if (o.nextAt) dots.push({ kind: "next", at: o.nextAt });
    return dots;
  }

  // A cycle's outcome → the tone its dot wears. `ok` is the only one that earns
  // green: a quiet cycle is not a failure and must not read as one.
  //
  // `blocked` was MISSING here, and the omission produced the exact lie §3.9 exists to
  // prevent: a cycle stopped by a question only a person can answer fell through to
  // `muted` and was labelled «falhou» by the row painter. It is amber — the tone of
  // «precisa de você» — like the state of the loop it left behind.
  function outcomeTone(outcome) {
    if (outcome === "ok") return "green";
    if (outcome === "failed") return "amber";
    if (outcome === "stopped") return "amber";
    if (outcome === "blocked") return "amber";
    if (outcome === "running") return "teal";
    return "muted";   // nothing · skipped · expired
  }

  // §4.17 — pode ESTA ferramenta ser liberada para um loop? A mesma regra do
  // `safe_tool_name` do backend, e ela mora aqui para a tela não oferecer um botão
  // que o backend vai recusar: comando livre e curinga solto nunca são de um ciclo.
  function grantableTool(name) {
    const t = String(name || "").trim();
    if (!t || t.length > 80 || t.startsWith("-")) return false;
    if (!/^[A-Za-z0-9_.*-]+$/.test(t)) return false;
    if (t.toLowerCase() === "bash") return false;
    if (t.includes("*") && !(t.startsWith("mcp__") && t.endsWith("__*") && t.length > 8)) return false;
    return true;
  }

  // ---- the loop's own document -------------------------------------------
  const REL_PREFIX = "loops/";

  function relOf(slug) {
    return `${REL_PREFIX}${slug}.md`;
  }

  // The slug a rel names, or "" when the rel is not a loop's document. One
  // reader, so the tab, the sidebar and the dispatcher cannot disagree.
  function slugOfRel(rel) {
    const r = String(rel || "").replace(/\\/g, "/");
    if (!r.startsWith(REL_PREFIX) || !r.endsWith(".md")) return "";
    const stem = r.slice(REL_PREFIX.length, -3);
    return stem && !stem.includes("/") ? stem : "";
  }

  // ---- o escopo: onde o loop olha ----------------------------------------
  // `projeto` · `ideia:<slug>` · `pasta:<rel>` · `conhecimento:<slug>` — as quatro
  // formas, e esta é a única leitura do formato nos dois lados (§4.15). Um escopo
  // APONTADO (as três últimas) faz o ciclo ler aquilo e nada mais.
  const SCOPE_KINDS = ["projeto", "ideia", "pasta", "conhecimento"];

  function scopeKind(escopo) {
    const s = String(escopo || "").trim();
    for (const k of ["ideia", "pasta", "conhecimento"]) {
      if (s.startsWith(k + ":")) return k;
    }
    return "projeto";
  }

  function scopeValue(escopo) {
    const s = String(escopo || "").trim();
    const k = scopeKind(s);
    return k === "projeto" ? "" : s.slice(k.length + 1).trim();
  }

  // Um caminho DIGITADO, na forma que o backend guarda. Ele chega com a barra
  // sobrando, com o espaço do que se colou e com a barra do Windows. Um pedaço `..`
  // devolve "" — e não o caminho com o `..` removido: apagá-lo mandaria o ciclo ler
  // uma pasta DIFERENTE da que a pessoa escreveu, em silêncio.
  function cleanFolder(rel) {
    const parts = String(rel || "").replace(/\\/g, "/").split("/").map((p) => p.trim());
    if (parts.some((p) => p === "..")) return "";
    return parts.filter((p) => p && p !== ".").join("/");
  }

  function buildScope(kind, value) {
    if (kind === "pasta") {
      const rel = cleanFolder(value);
      return rel ? "pasta:" + rel : "";
    }
    if (kind === "ideia" || kind === "conhecimento") {
      const v = String(value || "").trim();
      return v ? kind + ":" + v : "";
    }
    return "projeto";
  }

  // ---- brakes ------------------------------------------------------------
  // What a form is allowed to save. A brake is a number with a floor and a
  // ceiling, never free text: the field decides, so the backend never has to
  // guess what "8 vezes" meant.
  function clampBrakes(b) {
    const num = (v, lo, hi, dflt) => {
      // parseInt, not Number: the field shows the unit beside the value ("3
      // arquivos"), and Number("3 arquivos") is NaN — which would silently give
      // back the default instead of what the person typed.
      const n = typeof v === "number" ? Math.round(v) : parseInt(String(v == null ? "" : v).trim(), 10);
      if (!Number.isFinite(n)) return dflt;
      return Math.min(Math.max(n, lo), hi);
    };
    return {
      maxArquivos: num(b && b.maxArquivos, 1, 50, 3),
      maxCiclosDia: num(b && b.maxCiclosDia, 1, 96, 8),
      expiraDias: num(b && b.expiraDias, 1, 365, 30),
      paralelo: num(b && b.paralelo, 1, 4, 1),
    };
  }

  // A date `n` days from `from`, as YYYY-MM-DD in the person's own calendar —
  // what «desliga sozinho depois de 30 dias» becomes on disk.
  function dateIn(days, from) {
    const d = from instanceof Date ? new Date(from.getTime()) : new Date(from || Date.now());
    d.setDate(d.getDate() + (Number(days) || 0));
    return nowFields(d).date;
  }

  // ---- what a cycle is doing, for the panel ------------------------------
  // Steps arrive on the same stream the chat uses (`loop-tool` / `loop-tool-result`,
  // ADR-0029 §5), each carrying the loop it belongs to. This keeps them separated
  // per loop so a parallel cycle cannot paint into another's list.
  function stepsFor(steps, slug) {
    return (steps || []).filter((s) => s && s.loop === slug);
  }

  return {
    parseRhythm,
    buildRhythm,
    nowFields,
    nextRunAt,
    STATES,
    stateTone,
    isLive,
    headerCounts,
    collapseCycles,
    timelineDots,
    outcomeTone,
    grantableTool,
    relOf,
    slugOfRel,
    SCOPE_KINDS,
    scopeKind,
    scopeValue,
    cleanFolder,
    buildScope,
    clampBrakes,
    dateIn,
    stepsFor,
  };
});
