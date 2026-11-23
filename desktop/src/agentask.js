// Loro — what the agent asks the person mid-turn, and the «/» commands, for BOTH
// chats: the main window's panel and the recording bubble (ADR-0043). One module
// so the two cannot drift: a «/» that works in one and not in the other was the
// gap the owner reported ("todos os comandos que funcionam no terminal").
//
// The pure half (classify, answersFrom, summarize) is tested under node; the DOM
// half (renderAsk, attachSlash) receives `t` (i18n) and callbacks, and never
// calls Tauri itself — each window keeps its own channel.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroAgentAsk = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const NUM_KEYS = 9; // 1–9 choose an option, as the terminal's numbered list

  // The first token of a «/» message, without the slash. null if not a command.
  function commandName(text) {
    const m = /^\/([^\s/][^\s]*)/.exec(String(text == null ? "" : text).trim());
    return m ? m[1] : null;
  }

  // Commands the CLI LISTS for the chat but whose terminal form is interactive.
  // Measured 2026-11-23 (CLI 2.1.329), each sent bare in the chat's own mode:
  //   /config /advisor → only print «Usage: …»; /mcp → «Use /mcp in the terminal
  //   for details»; /output-style → a list, where the terminal has a picker;
  //   /color → picks a colour at random. With an argument they do work here.
  //   /fast → «not available in the Agent SDK»; /focus → «isn't available here
  //   yet» — terminal-only with or without arguments.
  const TERMINAL_WHEN_BARE = ["config", "mcp", "advisor", "output-style", "color"];
  const TERMINAL_ALWAYS = ["fast", "focus"];
  // /model and /effort change the model of the conversation you type them in.
  // In the chat that is LORO's control: measured, «/model sonnet» answered «Set
  // model to Sonnet 5.5 for this session only» and the next turn ran on the model
  // Loro passes — it looked done and was not. So the chat applies them itself.
  const CHAT_SETTINGS = ["model", "effort"];

  // Where a message goes (owner, 2026-11-23: «faz sentido comandos interativos
  // abrir o terminal, como foi feito no login»):
  //   chat     — not a command
  //   setting  — /model, /effort: the chat's own model/effort control
  //   terminal — interactive in the terminal, or not runnable by the chat at all
  //   command  — runs in the chat, sent to the CLI unchanged
  // A «/name» the CLI did not list exists only in the terminal (/login, /status,
  // /resume…). With no list yet nothing is guessed: it goes to the CLI.
  function classify(text, commands) {
    const name = commandName(text);
    if (!name) return { kind: "chat", name: null, arg: "" };
    const arg = String(text).trim().slice(name.length + 1).trim();
    if (CHAT_SETTINGS.includes(name)) return { kind: "setting", name, arg };
    if (TERMINAL_ALWAYS.includes(name) || (!arg && TERMINAL_WHEN_BARE.includes(name))) {
      return { kind: "terminal", name, arg };
    }
    const list = Array.isArray(commands) ? commands : [];
    if (!list.length) return { kind: "command", name, arg };
    const known = list.some((c) => c && c.name === name);
    return { kind: known ? "command" : "terminal", name, arg };
  }

  // The `answers` map AskUserQuestion expects: question text → label, or labels
  // for a multi-select, or the person's own words when they typed them.
  function answersFrom(questions, picks) {
    const out = {};
    (questions || []).forEach((q, i) => {
      const p = (picks && picks[i]) || {};
      const other = String(p.other || "").trim();
      const labels = (p.labels || []).filter(Boolean);
      if (other) out[q.question] = q.multiSelect && labels.length ? labels.concat(other) : other;
      else if (q.multiSelect) out[q.question] = labels;
      else if (labels.length) out[q.question] = labels[0];
    });
    return out;
  }

  // Every question has an answer (the button stays disabled until then).
  function complete(questions, picks) {
    return (questions || []).every((q, i) => {
      const p = (picks && picks[i]) || {};
      return String(p.other || "").trim() || (p.labels || []).length;
    });
  }

  // One line saying WHAT would run: the command, the file, the address.
  const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "url", "pattern", "path", "query"];
  function summarize(ask) {
    const input = (ask && ask.input) || {};
    for (const k of SUMMARY_KEYS) {
      if (typeof input[k] === "string" && input[k].trim()) return input[k].trim();
    }
    if (ask && ask.description) return ask.description;
    try { return JSON.stringify(input).slice(0, 240); } catch (_) { return ""; }
  }

  // ---- DOM ------------------------------------------------------------------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The block for one ask. `onAnswer({allow, answers?, remember?, message?})` is
  // called once; the block then shows what was answered and stops taking input.
  function renderAsk(ask, opts) {
    const t = (opts && opts.t) || ((s) => s);
    const onAnswer = (opts && opts.onAnswer) || (() => {});
    // each window has its own button vocabulary (the bubble's «primary» is the
    // red of recording, which an answer is not)
    const BTN = (opts && opts.btnClass) || "btn sm";
    const PRIMARY = (opts && opts.primaryClass) || "btn sm primary";
    const box = el("div", "agentask " + (ask.kind === "question" ? "q" : "perm"));
    box.setAttribute("role", "group");
    let done = false;
    const finish = (payload, said) => {
      if (done) return;
      done = true;
      box.classList.add("answered");
      box.querySelectorAll("button, input, textarea").forEach((n) => { n.disabled = true; });
      const note = el("div", "askdone", said);
      box.appendChild(note);
      onAnswer(payload);
    };

    if (ask.kind === "question") {
      const qs = (ask.input && ask.input.questions) || [];
      const picks = qs.map(() => ({ labels: [], other: "" }));
      const submit = el("button", PRIMARY, t("Responder"));
      const refresh = () => { submit.disabled = !complete(qs, picks); };
      let firstOpt = null;
      qs.forEach((q, qi) => {
        const sec = el("div", "askq");
        if (q.header) sec.appendChild(el("span", "askhead", q.header));
        sec.appendChild(el("div", "asktext", q.question));
        const opts = el("div", "askopts");
        opts.setAttribute("role", q.multiSelect ? "group" : "radiogroup");
        (q.options || []).forEach((o, oi) => {
          const b = el("button", "askopt");
          b.type = "button";
          b.setAttribute(q.multiSelect ? "aria-pressed" : "aria-checked", "false");
          if (!q.multiSelect) b.setAttribute("role", "radio");
          const n = el("span", "asknum", String(oi + 1));
          const lab = el("span", "asklabel", o.label);
          b.append(n, lab);
          if (o.description) b.appendChild(el("span", "askdesc", o.description));
          b.onclick = () => {
            const p = picks[qi];
            if (q.multiSelect) {
              const on = !p.labels.includes(o.label);
              p.labels = on ? p.labels.concat(o.label) : p.labels.filter((x) => x !== o.label);
              b.setAttribute("aria-pressed", String(on));
            } else {
              p.labels = [o.label];
              opts.querySelectorAll(".askopt").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
              // a single question with a single choice answers on click, like
              // Enter on the terminal's list: one gesture, not two
              if (qs.length === 1) { refresh(); return submit.click(); }
            }
            refresh();
          };
          if (!firstOpt) firstOpt = b;
          opts.appendChild(b);
        });
        sec.appendChild(opts);
        const other = el("input", "askother");
        other.type = "text";
        other.placeholder = t("outra resposta…");
        other.setAttribute("aria-label", t("outra resposta…"));
        other.oninput = () => { picks[qi].other = other.value; refresh(); };
        other.onkeydown = (e) => {
          if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); if (!submit.disabled) submit.click(); }
        };
        sec.appendChild(other);
        box.appendChild(sec);
      });
      const row = el("div", "askrow");
      const skip = el("button", BTN, t("Pular"));
      submit.onclick = () => {
        const answers = answersFrom(qs, picks);
        const said = Object.values(answers).map((v) => (Array.isArray(v) ? v.join(", ") : v)).join(" · ");
        finish({ allow: true, answers }, "→ " + said);
      };
      skip.onclick = () => finish({ allow: false, message: "The user skipped this question; continue without it." }, t("pulada"));
      row.append(submit, skip);
      box.appendChild(row);
      refresh();
      // 1–9 pick an option of the FIRST unanswered question, as in the terminal
      box.addEventListener("keydown", (e) => {
        if (done || e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
        const n = Number(e.key);
        if (!(n >= 1 && n <= NUM_KEYS)) return;
        const qi = Math.max(0, picks.findIndex((p) => !p.labels.length && !p.other));
        const b = box.querySelectorAll(".askq")[qi]?.querySelectorAll(".askopt")[n - 1];
        if (b) { e.preventDefault(); b.click(); }
      });
      box.focusFirst = () => firstOpt && firstOpt.focus();
      return box;
    }

    // permission
    box.appendChild(el("b", "asktitle", t("O agente quer usar %1", [ask.tool || "?"])));
    const what = summarize(ask);
    if (what) box.appendChild(el("code", "askwhat", what));
    const row = el("div", "askrow");
    const allow = el("button", PRIMARY, t("Permitir"));
    allow.onclick = () => finish({ allow: true }, t("permitido"));
    row.appendChild(allow);
    if (ask.canRemember) {
      const always = el("button", BTN, t("Permitir sempre nesta conversa"));
      always.onclick = () => finish({ allow: true, remember: true }, t("permitido nesta conversa"));
      row.appendChild(always);
    }
    const deny = el("button", BTN, t("Negar"));
    row.appendChild(deny);
    box.appendChild(row);
    // «Negar» can carry what to do instead — the model reads it, as when you
    // answer «no, do X» in the terminal
    const instead = el("input", "askother");
    instead.type = "text";
    instead.placeholder = t("o que fazer em vez disso (opcional)");
    instead.setAttribute("aria-label", t("o que fazer em vez disso (opcional)"));
    instead.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); deny.click(); } };
    box.appendChild(instead);
    deny.onclick = () => finish({ allow: false, message: instead.value.trim() }, t("negado"));
    box.focusFirst = () => allow.focus();
    return box;
  }

  // ---- «/» completion --------------------------------------------------------
  // The text after a leading «/» while the person is still typing the NAME (no
  // space yet); null when the popover must close.
  function slashQuery(text) {
    const m = /^\/(\S*)$/.exec(String(text == null ? "" : text));
    return m ? m[1] : null;
  }
  // Every command when the query is empty (in the CLI's order), else the fuzzy
  // matches on the name (`filter` is LoroFuzzy.filter). Capped.
  function slashItems(list, q, filter, max) {
    const items = Array.isArray(list) ? list : [];
    const cap = max || 50;
    if (!q) return items.slice(0, cap);
    const f = filter || ((qq, xs, key) => xs.filter((x) => key(x).toLowerCase().includes(qq.toLowerCase())));
    return f(q, items, (x) => x.name).slice(0, cap);
  }

  // Wires a textarea to a listbox. `load()` → Promise<list>; `onEnter()` sends.
  // ↑/↓ move, Tab/Enter complete to «/name », Esc closes — Claude Code's own keys.
  function attachSlash(o) {
    const st = { list: [], at: 0, items: [], active: 0, open: false };
    const close = () => { st.open = false; o.list.hidden = true; };
    const render = () => {
      o.list.textContent = "";
      st.items.forEach((it, i) => {
        const li = el("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === st.active));
        const n = el("span", "sn", "/" + it.name + (it.argumentHint ? " " : ""));
        if (it.argumentHint) n.appendChild(el("span", "sh", it.argumentHint));
        li.append(n, el("span", "sd", it.description || ""));
        li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
        o.list.appendChild(li);
        if (i === st.active) li.scrollIntoView({ block: "nearest" });
      });
      o.list.hidden = !st.items.length;
      st.open = !!st.items.length;
    };
    const pick = (i) => {
      const it = st.items[i];
      if (!it) return;
      o.input.value = "/" + it.name + " ";
      close();
      o.input.focus();
      o.input.setSelectionRange(o.input.value.length, o.input.value.length);
      if (o.onChange) o.onChange();
    };
    const update = async () => {
      const q = slashQuery(o.input.value);
      if (q == null) return close();
      if (!st.list.length || Date.now() - st.at > 60000) {
        try { st.list = (await o.load()) || []; st.at = Date.now(); } catch (_) {}
      }
      st.items = slashItems(st.list, q, o.filter);
      st.active = 0;
      render();
    };
    o.input.addEventListener("input", update);
    o.input.addEventListener("blur", () => setTimeout(close, 120));
    // capture: the popover's keys win over the composer's own Enter-to-send
    o.input.addEventListener("keydown", (e) => {
      if (!st.open) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopImmediatePropagation();
        const n = st.items.length;
        st.active = (st.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        render();
      } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault(); e.stopImmediatePropagation(); pick(st.active);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation(); close();
      }
    }, true);
    return { close, list: () => st.list, prime: () => update() };
  }

  return { commandName, classify, answersFrom, complete, summarize, slashQuery, slashItems, renderAsk, attachSlash };
});
