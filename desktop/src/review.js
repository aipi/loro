// Loro — pure reducers for the Revisão destination (ADR-0027).
// Isolated, framework-free module: loaded in the browser via <script>
// (defines window.LoroReview) and in Node via require() for node --test.
//
// Two contracts hold this module together, and both are load-bearing:
//
// 1. It is PURE. It takes the plain data `brain_git_diff` / `gh_pr_diff` /
//    `gh_pr_detail` send and returns NEW plain data — no DOM, no IPC, no
//    mutation of an input. Every off-by-one in a diff has one home and one test.
//
// 2. It is LANGUAGE-FREE. Every reducer returns semantic enums and numbers
//    (`status: "added"`, `tone: "warn"`, `blocked: "conflict"`); app.js turns
//    them into msgids at paint time. The two msgid scanners (tests/i18n.test.js,
//    tests/vocabulary.test.js) read app.js, so a pt-BR literal parked here would
//    escape both the English-pair check and the retired-vocabulary sweep. If a
//    label ever has to live "closer to the data", the fix is to widen those
//    scanners to this file — never to accept the hole.
//
// The vocabulary is the backend's own (`added|modified|removed|renamed`,
// `add|del|context`): renaming an enum on the way to the screen would be a
// second dictionary to keep in sync, and the sidebar's status idiom already
// speaks the first one.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroReview = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const str = (v) => (v === null || v === undefined ? "" : String(v));

  // The card names the DOCUMENT and keeps the path as its address.
  function splitPath(rel) {
    const s = str(rel);
    const cut = s.lastIndexOf("/");
    return cut === -1 ? { dir: "", name: s } : { dir: s.slice(0, cut + 1), name: s.slice(cut + 1) };
  }

  const rowsOf = (file) =>
    ((file && file.hunks) || []).reduce((n, h) => n + ((h && h.rows) || []).length, 0);

  // The changed document behind a path, IN THE LIST that drew the card. The list
  // is a parameter and there is no fallback: the working tree and an open review
  // are keyed by the same acervo-relative path, so a resolver that searched both
  // painted the reviewer's own uncommitted text as the proposal's "como fica".
  function fileAt(files, path) {
    return (files || []).find((f) => f && f.path === path) || null;
  }

  // "2 trechos mudaram" — a removal immediately followed by its replacement is
  // ONE passage, not two: that is what a person counts when they read a change.
  function changedRuns(file) {
    if (!file || file.binary) return 0;
    let runs = 0;
    let open = null; // "del" | "add" | null — the run being read
    for (const h of (file.hunks || [])) {
      open = null; // a run never spans two hunks: there are lines between them
      for (const r of (h.rows || [])) {
        if (r.kind === "context") { open = null; continue; }
        // del → add keeps the same passage open; add → del starts a new one
        if (open === null || (open === "add" && r.kind === "del")) runs++;
        open = r.kind;
      }
    }
    return runs;
  }

  // The status is the backend's word (diff.rs::ChangeKind), not a second
  // dictionary: the sidebar's dot and this badge then say the same thing.
  function classifyFile(file) {
    const f = file || {};
    const { dir, name } = splitPath(f.path);
    return {
      path: str(f.path),
      oldPath: f.oldPath || null,
      dir,
      name,
      status: ["added", "modified", "removed", "renamed"].includes(f.kind) ? f.kind : "modified",
      binary: !!f.binary,
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
      changedRuns: changedRuns(f),
    };
  }

  const MINUS = "−"; // the typographic minus, not a hyphen: it is a sign

  // One walker, two shapes — so a change never gets two renderings.
  //
  // The unchanged lines BETWEEN two hunks are announced, never opened: the
  // payload carries three lines of context around each hunk and nothing else,
  // so an "expand" control here would be a control that does nothing
  // (DESIGN.md §1). The count is derived from the hunk headers, so it costs the
  // backend no field.
  function diffRows(file, opts) {
    const mode = opts && opts.mode === "split" ? "split" : "unified";
    const f = file || {};
    if (f.binary) return [];
    const path = str(f.path);
    const hunks = f.hunks || [];
    const out = [];

    hunks.forEach((h, hi) => {
      if (hi > 0) {
        const prev = hunks[hi - 1];
        const lines = (Number(h.newStart) || 0) - ((Number(prev.newStart) || 0) + (Number(prev.newLines) || 0));
        if (lines > 0) out.push({ kind: "gap", key: `${path}:gap:${hi}`, lines });
      }
      const rows = h.rows || [];
      const key = (i) => `${path}:${hi}:${i}`;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (mode === "unified") {
          out.push({
            kind: "uni",
            key: key(i),
            oldNum: r.oldLine === undefined ? null : r.oldLine,
            newNum: r.newLine === undefined ? null : r.newLine,
            sign: r.kind === "add" ? "+" : r.kind === "del" ? MINUS : "",
            text: str(r.text),
            tone: r.kind === "add" || r.kind === "del" ? r.kind : "none",
          });
          continue;
        }
        // anything that is not an add or a del is read as context — a row kind
        // this module does not know must never leave the walker without
        // consuming a row (that is a frozen window, not a rendering bug)
        if (r.kind !== "add" && r.kind !== "del") {
          const side = { text: str(r.text), tone: "none" };
          out.push({
            kind: "split",
            key: key(i),
            left: { num: r.oldLine === undefined ? null : r.oldLine, ...side },
            right: { num: r.newLine === undefined ? null : r.newLine, ...side },
          });
          continue;
        }
        // The one reason side-by-side is worth having: a removal and the line
        // that replaced it read as ONE row, "como era" against "como fica".
        const dels = [];
        const adds = [];
        while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
        while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
        const start = i - dels.length - adds.length;
        i--; // the for() advances past the last consumed row
        const empty = { num: null, text: "", tone: "empty" };
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          const d = dels[k];
          const a = adds[k];
          out.push({
            kind: "split",
            key: key(start + k),
            left: d ? { num: d.oldLine === undefined ? null : d.oldLine, text: str(d.text), tone: "del" } : { ...empty },
            right: a ? { num: a.newLine === undefined ? null : a.newLine, text: str(a.text), tone: "add" } : { ...empty },
          });
        }
      }
    });
    return out;
  }

  const joinRun = (run) => run.map((r) => str(r.text)).join("\n");
  const blank = (run) => run.every((r) => !str(r.text).trim());

  // The change in the reader's own words: each run of removed lines is "como
  // era", each run of added lines "como fica". A whole new (or removed)
  // document is ONE block — that is what makes the label read "documento novo"
  // instead of "como fica".
  function plainBits(file, opts) {
    const f = file || {};
    const maxBits = opts && Number(opts.maxBits) > 0 ? Number(opts.maxBits) : 6;
    // F2's failure path: a binary or unreadable file says so instead of
    // drawing an empty diff.
    if (f.binary || !rowsOf(f)) return [];

    const all = (f.hunks || []).flatMap((h) => h.rows || []);
    if (f.kind === "added" || f.kind === "removed") {
      const kind = f.kind === "added" ? "after" : "before";
      const want = f.kind === "added" ? "add" : "del";
      const run = all.filter((r) => r.kind === want);
      return run.length ? [{ kind, text: joinRun(run), whole: true }] : [];
    }

    const bits = [];
    for (const h of (f.hunks || [])) {
      const rows = h.rows || [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].kind === "context") continue;
        const want = rows[i].kind;
        const run = [];
        while (i < rows.length && rows[i].kind === want) run.push(rows[i++]);
        i--;
        if (!blank(run)) bits.push({ kind: want === "add" ? "after" : "before", text: joinRun(run), whole: false });
        if (bits.length >= maxBits) return bits;
      }
    }
    return bits;
  }

  /* ------------------------------------------------------------- a review */

  const same = (a, b) => !!a && !!b && str(a).toLowerCase() === str(b).toLowerCase();
  // A requested reviewer arrives as a person (login), a team (slug) or a name.
  const handle = (r) => (r && (r.login || r.slug || r.name)) || "";

  // The last submission per author wins — a reviewer who requested changes and
  // then approved counts once, as approved (git.rs::latest_by_author, same rule).
  function latestByAuthor(reviews, who) {
    let last = null;
    for (const r of (reviews || [])) {
      if (!same(r.author, who)) continue;
      if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(str(r.state))) continue;
      last = r;
    }
    return last;
  }

  // ok | fail | pending | null — three states with one meaning each, so an
  // unknown gh conclusion can never be painted green (check_state does the
  // narrowing in Rust; this only folds the runs into one word).
  // «ok» é AFIRMATIVO, e por isso é o único ramo que exige que todo estado seja
  // conhecido. O `return "ok"` final pintava verde qualquer lista em que nada casasse
  // «failed» ou «running» — inclusive um estado cru do gh («FAILURE») vazando pelo
  // contrato. O lado Rust já tinha essa regra (`check_state`: um estado desconhecido
  // nunca é reportado como passando); este lado não.
  function checksState(checks) {
    const list = checks || [];
    if (!list.length) return null;
    if (list.some((c) => str(c && c.state) === "failed")) return "fail";
    if (list.some((c) => str(c && c.state) === "running")) return "pending";
    return list.every((c) => str(c && c.state) === "ok") ? "ok" : "pending";
  }

  // WHICH check failed, and where it lives. `checksState` folds the whole list
  // into one word for the chip; that word is all the screen used to say, so a
  // reviewer was told the change is blocked and could not learn by what — with
  // the name and the URL sitting in the payload (git.rs::CheckRun).
  function failingChecks(checks) {
    return (checks || [])
      .filter((c) => c && c.state === "failed")
      .map((c) => ({ name: str(c.name), url: str(c.url) }));
  }

  // WAS MY REVIEW ASKED FOR? One answer, used by the group the row lands in AND
  // by the decision block: the list filed a change under "waiting for your
  // review" while the open review offered no control, because the two surfaces
  // were reading different facts.
  function askedOf(pr, me) {
    return ((pr || {}).reviewRequests || []).some((r) => same(handle(r), me));
  }

  // THE single authority for which block the detail screen draws: it returns
  // ONE shape, so "Aprovar" and "Juntar ao conhecimento oficial" can never both
  // be on screen (DESIGN.md §2 rule 4), and a decided review is replaced by its
  // state instead of a re-armed button.
  function reviewState(pr, opts) {
    const p = pr || {};
    const me = (opts && opts.me) || "";
    const merged = str(p.state).toUpperCase() === "MERGED";
    const open = str(p.state || "OPEN").toUpperCase() === "OPEN";
    const mine = typeof p.mine === "boolean" ? p.mine : same(p.author && p.author.login, me);
    const checks = checksState(p.checks);
    const requests = p.reviewRequests || [];
    const approvals = Number(p.approvals) || 0;

    const blocked =
      str(p.mergeable).toUpperCase() === "CONFLICTING" ? "conflict"
        : (Number(p.changesRequested) || 0) > 0 ? "changes"
          : checks === "fail" ? "checks"
            : null;

    // The truthful gate is what GitHub answers, never the approval arithmetic:
    // branch protection is not readable by a non-admin, so "1 de 1 aprovações"
    // can be true while GitHub still blocks the merge.
    const gate = str(p.mergeStateStatus).toUpperCase();
    const ghBlocks = ["BLOCKED", "DIRTY", "BEHIND"].includes(gate);
    const decision = latestByAuthor(p.reviews, me);
    const decided = decision && decision.state === "APPROVED" ? "approved"
      : decision && decision.state === "CHANGES_REQUESTED" ? "changes_requested"
        : null;
    // A decision I already took can come BACK to me: the author pushed another
    // version (`stale` — the review's commit is no longer the head) or asked for
    // my review again. Either way the previous answer no longer counts on
    // GitHub, so the screen that says "você aprovou · entra quando todas as
    // aprovações chegarem" is stating something that will not happen — and it
    // used to be the whole block, with no control in it (F8 could not close).
    const canReview = !mine && open && !merged;
    const stale = !!(decision && decision.stale);
    const askedAgain = askedOf(p, me);

    return {
      mine,
      merged,
      open,
      canReview,
      // WHO STILL HAS A DECISION TO MAKE — the one answer the painter switches
      // on, so "the list says it is my turn" and "the review offers me nothing"
      // can never be true at the same time.
      canDecide: canReview && (!decided || stale || askedAgain),
      canMerge: mine && open && !merged && !blocked && !ghBlocks && checks !== "pending",
      decided,
      stale,
      askedAgain,
      blocked,
      // O DENOMINADOR É A GENTE NA REVISÃO — um fato, não a contagem exigida pelo
      // repositório, que o app não consegue ler. Mas com ninguém atribuído a soma
      // dava `0 de 0`, que LÊ como «nada pendente», enquanto o GitHub respondia
      // REVIEW_REQUIRED e bloqueava a entrada (visto no #6 do turbo). O
      // reviewDecision está no mesmo payload: quando ele diz que falta revisão, o
      // denominador é no mínimo 1 — a tela não pode dizer que a conta fechou
      // enquanto o remote diz que não (DESIGN.md §1).
      approvals: {
        have: approvals,
        need: Math.max(
          approvals + requests.length,
          String(p.reviewDecision || "").toUpperCase() === "REVIEW_REQUIRED" ? approvals + 1 : 0
        ),
      },
      comments: (p.threads || []).reduce((n, t) => n + ((t.comments || []).length), 0),
      threads: (p.threads || []).length,
      checks,
    };
  }

  // STATES only. The counters (`%1 de %2 aprovações`, `%1 comentários`) come
  // back on reviewState and are painted as the row's prose meta: chips are
  // reserved for states, so four objects on a row become two.
  function prChips(pr, opts) {
    const s = reviewState(pr, opts);
    if (s.merged) return [{ key: "merged", tone: "ok", values: {} }];
    const chips = [];
    if (s.blocked === "conflict") chips.push({ key: "conflict", tone: "danger", values: {} });
    if ((Number((pr || {}).changesRequested) || 0) > 0) chips.push({ key: "changes", tone: "warn", values: {} });
    if (s.checks) {
      chips.push({
        key: "checks",
        tone: s.checks === "ok" ? "ok" : s.checks === "fail" ? "danger" : "warn",
        values: { state: s.checks },
      });
    }
    if (s.canMerge) chips.push({ key: "ready", tone: "ok", values: {} });
    if (s.decided === "approved") chips.push({ key: "approvedByMe", tone: "ok", values: {} });
    if (s.stale) chips.push({ key: "stale", tone: "warn", values: {} });
    return chips;
  }

  // Whose turn it is, at a glance. Nothing is dropped: a change that is neither
  // mine nor waiting on me still has to be somewhere, or the list lies by
  // omission.
  function groupReviews(prs, opts) {
    const me = (opts && opts.me) || "";
    const forMe = [];
    const mine = [];
    for (const p of (prs || [])) {
      const isMine = typeof p.mine === "boolean" ? p.mine : same(p.author && p.author.login, me);
      (!isMine && askedOf(p, me) ? forMe : mine).push(p);
    }
    return { forMe, mine };
  }

  // 32-bit FNV-1a. Not a security hash: the only question asked of it is "is
  // this the same text I already read?", and the length travels next to it, so a
  // collision would have to keep both.
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  // WHICH CHANGE the "✓ visto" mark belongs to. A mark keyed by path alone
  // outlives the change it described: save a version, change the same document
  // again, and a diff nobody has opened arrives pre-marked as read — with the
  // counter saying "1 de 1 vistos" about text the reader has never seen. The
  // mark is a claim about CONTENT, so it dies with the content.
  //
  // `scope` separates the two lists that speak the same paths: the working tree
  // and an open review are keyed by the same acervo-relative path, so one set
  // shared between them would carry a mark across from the other list.
  function changeId(file, scope) {
    const f = file || {};
    const body = ((f.hunks) || []).map((h) =>
      `@${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}\n` +
      ((h.rows) || []).map((r) => `${r.kind}\u0001${str(r.text)}`).join("\n")
    ).join("\n");
    return [
      str(scope), str(f.path), str(f.kind) + (f.binary ? "b" : ""),
      `${Number(f.additions) || 0}-${Number(f.deletions) || 0}`,
      `${body.length}.${fnv1a(body)}`,
    ].join("\u0000");
  }

  // "%1 de %2 vistos" — a file marked as read that is no longer in the change
  // must not keep counting, and neither must one whose lines are no longer the
  // lines that were read (changeId).
  function viewedCount(files, viewed, scope) {
    const seen = viewed instanceof Set ? viewed : new Set(viewed || []);
    const list = files || [];
    return { seen: list.filter((f) => seen.has(changeId(f, scope))).length, total: list.length };
  }

  // A REGRA DE «este rascunho já está em revisão», uma vez. O backend decide o
  // mesmo em `propose_act` (git.rs) para escolher entre abrir uma revisão nova e
  // atualizar a aberta; a tela precisa da MESMA resposta para decidir se «enviar
  // para revisão» ainda é um passo. Duas cópias dessa regra divergem, e o preço da
  // divergência é um controle que promete abrir o que ele vai atualizar.
  function openReviewFor(prs, branch, opts) {
    const b = String(branch || "");
    if (!b) return null;
    const me = (opts && opts.me) || "";
    const p = (prs || []).find((x) => {
      if (!x || String(x.headRefName || "") !== b) return null;
      const st = x.state === null || x.state === undefined ? "open" : String(x.state);
      return st.toLowerCase() === "open";
    });
    if (!p) return null;
    return {
      number: p.number,
      url: p.url || "",
      mine: typeof p.mine === "boolean" ? p.mine : same(p.author && p.author.login, me),
    };
  }

  // O QUE A LISTA SABE. `reviewState` precisa do detalhe (revisões, threads,
  // aprovações); a linha da lista tem só o que `gh pr list` devolve. Estes três
  // fatos estão lá e são exatamente os que dizem DE QUEM É A VEZ: a verificação
  // falhou, conflita com o oficial, e a decisão que já houve. Sem eles a linha era
  // título + autor + data, e o destino não respondia a própria pergunta.
  function listChips(pr) {
    const out = [];
    const checks = checksState(pr && pr.checks);
    if (checks) out.push({ key: "checks", tone: checks === "fail" ? "danger" : checks === "ok" ? "ok" : "mut", values: { state: checks } });
    if (str(pr && pr.mergeable).toUpperCase() === "CONFLICTING") out.push({ key: "conflict", tone: "warn", values: {} });
    const d = str(pr && pr.reviewDecision).toUpperCase();
    if (d === "CHANGES_REQUESTED") out.push({ key: "changes", tone: "danger", values: {} });
    if (d === "APPROVED") out.push({ key: "approved", tone: "ok", values: {} });
    return out;
  }

  return {
    listChips,
    openReviewFor,
    splitPath,
    classifyFile,
    changedRuns,
    fileAt,
    diffRows,
    plainBits,
    failingChecks,
    reviewState,
    prChips,
    groupReviews,
    changeId,
    viewedCount,
  };
});
