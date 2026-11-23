// Review reducers (node --test). Pure, no DOM, no IPC — the same contract
// workspace.js keeps: every function takes plain data and returns NEW plain data.
//
// The fixtures below are the SHAPE `brain_git_diff` / `gh_pr_diff` really send
// (src-tauri/src/diff.rs): `kind` is the lowercase word, the +/-/space marker is
// already stripped from `text`, and both line numbers are computed in Rust. If
// that shape ever changes, these tests fail before a screen does.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../src/review.js");

const SRC = path.join(__dirname, "..", "src");
const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const SHELL = fs.readFileSync(path.join(SRC, "shell.js"), "utf8");

/* ---------------------------------------------------------------- fixtures */

// two hunks over one document — 15 unchanged lines between them
const MODIFIED = {
  path: "contexts/onboarding/context.md",
  oldPath: null,
  kind: "modified",
  additions: 3,
  deletions: 2,
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      rows: [
        { kind: "context", oldLine: 1, newLine: 1, text: "# Onboarding" },
        { kind: "del", oldLine: 2, newLine: null, text: "O convite expira em 48 horas." },
        { kind: "add", oldLine: null, newLine: 2, text: "O convite expira em 7 dias." },
        { kind: "add", oldLine: null, newLine: 3, text: "O painel reenvia sozinho." },
        { kind: "context", oldLine: 3, newLine: 4, text: "" },
        { kind: "context", oldLine: 4, newLine: 5, text: "## Regras" },
      ],
    },
    {
      oldStart: 19,
      oldLines: 2,
      newStart: 20,
      newLines: 2,
      rows: [
        { kind: "context", oldLine: 19, newLine: 20, text: "antes" },
        { kind: "del", oldLine: 20, newLine: null, text: "linha velha" },
        { kind: "add", oldLine: null, newLine: 21, text: "linha nova" },
      ],
    },
  ],
};

const ADDED = {
  path: "contexts/frota/nova.md",
  oldPath: null,
  kind: "added",
  additions: 2,
  deletions: 0,
  binary: false,
  hunks: [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      rows: [
        { kind: "add", oldLine: null, newLine: 1, text: "# Frota" },
        { kind: "add", oldLine: null, newLine: 2, text: "prazo de 3 dias" },
      ],
    },
  ],
};

const REMOVED = {
  path: "contexts/frota/faq-antigo.md",
  oldPath: null,
  kind: "removed",
  additions: 0,
  deletions: 2,
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 0,
      newLines: 0,
      rows: [
        { kind: "del", oldLine: 1, newLine: null, text: "# FAQ antigo" },
        { kind: "del", oldLine: 2, newLine: null, text: "Qual o prazo do convite? 48 horas." },
      ],
    },
  ],
};

// Um arquivo que a tela NÃO desenha como texto. As linhas existem no payload de
// propósito: com `hunks: []` os dois redutores devolviam `[]` pelo motivo ERRADO
// (não havia linha nenhuma), e apagar a guarda `if (f.binary)` mantinha a suíte
// inteira verde. Esta é a forma real de um arquivo passado do teto de leitura
// (git.rs::DIFF_READ_MAX_BYTES / diff.rs:63): o backend diz `binary` E manda o
// que leu, e `binary` tem de ser a única razão de os dois redutores não
// desenharem nada.
const BINARY = {
  path: "contexts/frota/foto.png",
  oldPath: null,
  kind: "added",
  additions: 2,
  deletions: 0,
  binary: true,
  hunks: [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      rows: [
        { kind: "add", oldLine: null, newLine: 1, text: "\u0000PNG\r\n\u001a\n" },
        { kind: "add", oldLine: null, newLine: 2, text: "IHDR\u0000\u0000" },
      ],
    },
  ],
};

// a change of somebody else's, with every state the decision block reads
const pr = (over) =>
  Object.assign(
    {
      number: 12,
      title: "Reorganiza o conhecimento de onboarding",
      body: "",
      sections: [],
      author: { login: "ana" },
      headRefName: "rfc/onboarding-por-etapas",
      baseRefName: "main",
      state: "OPEN",
      url: "https://example.invalid/pr/12",
      updatedAt: "2026-08-12T10:00:00Z",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      isDraft: false,
      mine: false,
      approvals: 1,
      changesRequested: 0,
      reviewRequests: [{ login: "bruno" }],
      reviews: [{ author: "carla", state: "APPROVED", body: "", when: "2026-08-12T09:00:00Z", stale: false }],
      files: [{ path: "contexts/onboarding/context.md", additions: 3, deletions: 2 }],
      checks: [{ name: "ci", state: "ok", url: "" }],
      threads: [],
    },
    over || {},
  );

/* ------------------------------------------------------------------- paths */

test("splitPath separa a pasta do nome — o cartão diz o documento, não o caminho inteiro", () => {
  assert.deepStrictEqual(R.splitPath("contexts/onboarding/context.md"), {
    dir: "contexts/onboarding/",
    name: "context.md",
  });
  assert.deepStrictEqual(R.splitPath("README.md"), { dir: "", name: "README.md" });
  // um acervo pt-BR tem nome acentuado, e um caminho vazio não pode virar "undefined"
  assert.deepStrictEqual(R.splitPath("contexts/política.md"), { dir: "contexts/", name: "política.md" });
  assert.deepStrictEqual(R.splitPath(""), { dir: "", name: "" });
});

/* -------------------------------------------------------------- classifica */

test("classifyFile toma o estado do backend e conta os TRECHOS, não as linhas", () => {
  const c = R.classifyFile(MODIFIED);
  assert.strictEqual(c.status, "modified");
  assert.strictEqual(c.name, "context.md");
  assert.strictEqual(c.dir, "contexts/onboarding/");
  assert.strictEqual(c.additions, 3);
  assert.strictEqual(c.deletions, 2);
  assert.strictEqual(c.binary, false);
  // uma remoção seguida de adições é UM trecho ("2 trechos mudaram", não 4)
  assert.strictEqual(c.changedRuns, 2);

  assert.strictEqual(R.classifyFile(ADDED).status, "added");
  assert.strictEqual(R.classifyFile(REMOVED).status, "removed");
  // um binário não tem trecho nenhum para contar: o cartão diz isso em vez de
  // desenhar um diff vazio (F2)
  assert.strictEqual(R.classifyFile(BINARY).changedRuns, 0);
  assert.strictEqual(R.classifyFile(BINARY).binary, true);

  // um documento renomeado diz de onde veio
  const renamed = R.classifyFile({ ...MODIFIED, kind: "renamed", oldPath: "contexts/onboarding/antigo.md" });
  assert.strictEqual(renamed.status, "renamed");
  assert.strictEqual(renamed.oldPath, "contexts/onboarding/antigo.md");

  // nenhuma entrada é mutada (mesmo contrato de workspace.js)
  assert.strictEqual(MODIFIED.hunks[0].rows[0].text, "# Onboarding");
});

/* ------------------------------------------------------------------- linhas */

test("diffRows numera os dois lados e nunca devolve o marcador dentro do texto", () => {
  const rows = R.diffRows(MODIFIED, { mode: "unified" });
  const uni = rows.filter((r) => r.kind === "uni");
  assert.strictEqual(uni[0].tone, "none");
  assert.deepStrictEqual([uni[0].oldNum, uni[0].newNum], [1, 1]);
  assert.strictEqual(uni[0].sign, "");

  assert.strictEqual(uni[1].tone, "del");
  assert.strictEqual(uni[1].sign, "−");
  assert.deepStrictEqual([uni[1].oldNum, uni[1].newNum], [2, null]);
  assert.strictEqual(uni[1].text, "O convite expira em 48 horas.");

  assert.strictEqual(uni[2].tone, "add");
  assert.strictEqual(uni[2].sign, "+");
  assert.deepStrictEqual([uni[2].oldNum, uni[2].newNum], [null, 2]);

  // o texto que chega já vem sem marcador: se algum reducer o recolocasse, a
  // tela estaria estilizando por sniff do primeiro caractere
  for (const r of uni) assert.ok(!/^[+\-−]/.test(r.text), `marcador dentro do texto: ${r.text}`);

  // a chave é estável: um re-render não pode perder o que estava aberto
  assert.strictEqual(new Set(rows.map((r) => r.key)).size, rows.length);
  assert.match(uni[0].key, /^contexts\/onboarding\/context\.md:0:0$/);
});

test("diffRows emparelha a remoção com a adição na leitura lado a lado", () => {
  const rows = R.diffRows(MODIFIED, { mode: "split" }).filter((r) => r.kind === "split");

  // contexto: a MESMA linha nos dois lados
  assert.deepStrictEqual(rows[0].left, { num: 1, text: "# Onboarding", tone: "none" });
  assert.deepStrictEqual(rows[0].right, { num: 1, text: "# Onboarding", tone: "none" });

  // o par: como era à esquerda, como fica à direita — uma linha só
  assert.strictEqual(rows[1].left.text, "O convite expira em 48 horas.");
  assert.strictEqual(rows[1].left.tone, "del");
  assert.strictEqual(rows[1].right.text, "O convite expira em 7 dias.");
  assert.strictEqual(rows[1].right.tone, "add");

  // a adição sem par: o lado esquerdo é "aqui não havia linha", não uma linha vazia
  assert.strictEqual(rows[2].right.text, "O painel reenvia sozinho.");
  assert.strictEqual(rows[2].left.tone, "empty");
  assert.strictEqual(rows[2].left.num, null);

  // o par ocupa UMA linha: lado a lado tem de ser mais curto que unificado
  const uni = R.diffRows(MODIFIED, { mode: "unified" }).filter((r) => r.kind === "uni").length;
  const split = rows.length;
  assert.ok(split < uni, `lado a lado (${split}) devia ser mais curto que unificado (${uni})`);
});

// Um `kind` que este módulo não conhece não podia deixar o caminhador sem
// consumir uma linha: o for() volta ao mesmo índice e a JANELA CONGELA — que é
// a classe de defeito da ADR-0022 §28, não um erro de desenho.
test("diffRows não trava com uma linha de tipo desconhecido", () => {
  const estranho = {
    path: "x.md", kind: "modified", additions: 0, deletions: 0, binary: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [
      { kind: "quem-sabe", oldLine: 1, newLine: 1, text: "linha" },
      { kind: "add", oldLine: null, newLine: 2, text: "nova" },
    ] }],
  };
  for (const mode of ["unified", "split"]) {
    const rows = R.diffRows(estranho, { mode });
    assert.strictEqual(rows.length, 2, `${mode}: toda linha é desenhada uma vez`);
    assert.strictEqual(new Set(rows.map((r) => r.key)).size, 2);
  }
  assert.strictEqual(R.diffRows(estranho, { mode: "unified" })[0].tone, "none", "o desconhecido é lido como contexto");
});

test("diffRows marca o intervalo entre dois pedaços — e não promete abrir o que não recebeu", () => {
  const rows = R.diffRows(MODIFIED, { mode: "unified" });
  const gaps = rows.filter((r) => r.kind === "gap");
  assert.strictEqual(gaps.length, 1, "um intervalo, entre os dois pedaços");
  // 20 − (1 + 5): derivado dos hunks, sem campo novo no backend
  assert.strictEqual(gaps[0].lines, 14);
  assert.match(gaps[0].key, /:gap:1$/);
  // as linhas escondidas NÃO vêm no payload (-U3), então o intervalo é um aviso
  // e não um controle: um botão que expande nada é o que DESIGN.md §1 proíbe
  assert.ok(!("expandable" in gaps[0]) || gaps[0].expandable === false);

  // o mesmo intervalo aparece nas duas leituras
  assert.strictEqual(R.diffRows(MODIFIED, { mode: "split" }).filter((r) => r.kind === "gap").length, 1);
  // um arquivo novo tem um pedaço só: não existe intervalo para anunciar
  assert.strictEqual(R.diffRows(ADDED, { mode: "unified" }).filter((r) => r.kind === "gap").length, 0);
  // e um binário não desenha linha nenhuma
  assert.deepStrictEqual(R.diffRows(BINARY, { mode: "unified" }), []);
});

/* ---------------------------------------------------------- língua de gente */

test("plainBits diz como era e como fica, aos pares, na ordem do documento", () => {
  const bits = R.plainBits(MODIFIED);
  assert.deepStrictEqual(bits.map((b) => b.kind), ["before", "after", "before", "after"]);
  assert.strictEqual(bits[0].text, "O convite expira em 48 horas.");
  // um trecho de várias linhas vira UM bloco, não uma linha por bloco
  assert.strictEqual(bits[1].text, "O convite expira em 7 dias.\nO painel reenvia sozinho.");
  assert.ok(bits.every((b) => b.whole === false));

  // o teto existe para o cartão não virar o diff inteiro
  assert.strictEqual(R.plainBits(MODIFIED, { maxBits: 2 }).length, 2);
});

test("plainBits do documento novo (ou removido) é um bloco inteiro, não 'como fica'", () => {
  const novo = R.plainBits(ADDED);
  assert.strictEqual(novo.length, 1);
  assert.strictEqual(novo[0].kind, "after");
  assert.strictEqual(novo[0].whole, true, "é o documento inteiro: o rótulo é 'documento novo'");
  assert.strictEqual(novo[0].text, "# Frota\nprazo de 3 dias");

  const fora = R.plainBits(REMOVED);
  assert.strictEqual(fora.length, 1);
  assert.strictEqual(fora[0].kind, "before");
  assert.strictEqual(fora[0].whole, true);

  // F2 · um binário não tem "como era/como fica": o cartão diz isso
  assert.deepStrictEqual(R.plainBits(BINARY), []);
});

// O caminho de falha de F2 era afirmado por ENGANO: os dois redutores devolviam
// `[]` porque o fixture não tinha linha nenhuma, então apagar `if (f.binary)`
// mantinha a suíte inteira verde e um arquivo que o cartão diz não poder mostrar
// aparecia desenhado — a tela mentindo (DESIGN.md §1).
test("F2 — um binário não desenha nada POR SER binário, não por vir sem linhas", () => {
  assert.ok(BINARY.hunks[0].rows.length, "o payload TEM linhas: `binary` é a única razão possível");
  assert.deepStrictEqual(R.diffRows(BINARY, { mode: "unified" }), []);
  assert.deepStrictEqual(R.diffRows(BINARY, { mode: "split" }), []);
  assert.deepStrictEqual(R.plainBits(BINARY), []);
  assert.strictEqual(R.classifyFile(BINARY).changedRuns, 0, "e não tem trecho para contar");
  // o mesmo payload SEM a marca desenha: sem isto, as asserções acima passariam
  // por qualquer outro motivo (foi exatamente o que aconteceu)
  const texto = { ...BINARY, binary: false };
  assert.ok(R.diffRows(texto, { mode: "unified" }).length, "sem a marca, as mesmas linhas desenham");
  assert.ok(R.plainBits(texto).length);
});

/* ---------------------------------------------- o dono de um caminho é a lista */

// ACHADO: o resumo inserido ao abrir um cartão saía de `diffFileAt(path)`, que
// procurava o caminho na árvore de trabalho PRIMEIRO e na revisão aberta depois.
// As duas listas são chaveadas pelo mesmo caminho relativo do acervo, então um
// revisor com edição local no documento que a proposta também muda via o SEU
// texto pintado como "como fica" da proposta — com o diff verdadeiro logo abaixo.
test("F7 — o resumo do cartão sai da LISTA que desenhou o cartão, não de um caminho global", () => {
  const meu = {
    ...MODIFIED,
    hunks: [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      rows: [
        { kind: "del", oldLine: 1, newLine: null, text: "o texto que estava aqui" },
        { kind: "add", oldLine: null, newLine: 1, text: "a minha edição local" },
      ],
    }],
  };
  const proposta = [MODIFIED];
  const trabalho = [meu];
  assert.strictEqual(R.fileAt(proposta, MODIFIED.path), MODIFIED);
  assert.strictEqual(R.fileAt(trabalho, MODIFIED.path), meu,
    "a lista é PARÂMETRO: não existe segunda fonte para desempatar o mesmo caminho");
  assert.strictEqual(R.plainBits(R.fileAt(proposta, MODIFIED.path))[0].text, "O convite expira em 48 horas.");
  assert.strictEqual(R.plainBits(R.fileAt(trabalho, MODIFIED.path))[0].text, "o texto que estava aqui");
  assert.strictEqual(R.fileAt(null, "x"), null);
  assert.strictEqual(R.fileAt([], "x"), null);
  assert.strictEqual(R.fileAt([{ path: "a" }], "b"), null);
});

/* ------------------------------------------------- o que bloqueia, com o nome */

// ACHADO: `CheckRun { name, state, url }` chegava inteiro do backend e a tela
// dobrava a lista numa palavra só ("✗ verificações falharam"). O revisor era
// avisado de que a mudança está bloqueada e não tinha como saber POR QUAL
// verificação nem onde vê-la — a interface sabendo algo que não diz.
test("F7 — uma verificação que falha é nomeada, com o endereço dela", () => {
  const checks = [
    { name: "ci / build", state: "ok", url: "https://example.invalid/1" },
    { name: "ci / testes", state: "failed", url: "https://example.invalid/2" },
    { name: "lint", state: "failed", url: "" },
    { name: "deploy", state: "running", url: "https://example.invalid/3" },
  ];
  assert.deepStrictEqual(R.failingChecks(checks), [
    { name: "ci / testes", url: "https://example.invalid/2" },
    { name: "lint", url: "" },
  ], "só as que falharam, na ordem em que o backend as mandou");
  assert.deepStrictEqual(R.failingChecks([]), []);
  assert.deepStrictEqual(R.failingChecks(null), []);
  assert.deepStrictEqual(R.failingChecks([{ name: "ci", state: "ok", url: "" }]), []);
  // a lista que falha e o resumo em uma palavra vêm da MESMA verdade: o chip
  // "✗ verificações falharam" e estas linhas não podem discordar
  assert.strictEqual(R.reviewState(pr({ checks }), { me: "bruno" }).checks, "fail");
  assert.ok(R.failingChecks(checks).length > 0);
  assert.strictEqual(R.reviewState(pr({ checks: [checks[0]] }), { me: "bruno" }).checks, "ok");
  assert.deepStrictEqual(R.failingChecks([checks[0]]), []);
  // um payload sem nome não some: a tela precisa saber que ele existe
  assert.deepStrictEqual(R.failingChecks([{ state: "failed", url: "u" }]), [{ name: "", url: "u" }]);
});

/* ------------------------------------------------------------------ decisão */

test("reviewState nunca oferece aprovar e juntar ao mesmo tempo (DESIGN.md §2 regra 4)", () => {
  const outra = R.reviewState(pr(), { me: "bruno" });
  assert.strictEqual(outra.mine, false);
  assert.strictEqual(outra.canReview, true);
  assert.strictEqual(outra.canMerge, false);

  const minha = R.reviewState(pr({ mine: true, author: { login: "bruno" } }), { me: "bruno" });
  assert.strictEqual(minha.canReview, false, "ninguém aprova a própria mudança dentro do Loro");
  assert.strictEqual(minha.canMerge, true);

  // a invariante, sobre TODA combinação que a tela pode receber
  for (const mine of [true, false]) {
    for (const state of ["OPEN", "MERGED", "CLOSED"]) {
      for (const gate of ["CLEAN", "BLOCKED", "DIRTY", ""]) {
        for (const mergeable of ["MERGEABLE", "CONFLICTING", "UNKNOWN"]) {
          const s = R.reviewState(pr({ mine, state, mergeStateStatus: gate, mergeable }), { me: "bruno" });
          assert.ok(!(s.canReview && s.canMerge), `dois primários: ${mine}/${state}/${gate}/${mergeable}`);
        }
      }
    }
  }
});

test("reviewState diz POR QUE não dá para juntar, em vez de esconder o botão calado", () => {
  const conflito = R.reviewState(pr({ mine: true, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), { me: "bruno" });
  assert.strictEqual(conflito.blocked, "conflict");
  assert.strictEqual(conflito.canMerge, false);

  const pedidas = R.reviewState(pr({ mine: true, changesRequested: 1 }), { me: "bruno" });
  assert.strictEqual(pedidas.blocked, "changes");
  assert.strictEqual(pedidas.canMerge, false);

  const falhou = R.reviewState(pr({ mine: true, checks: [{ name: "ci", state: "failed", url: "" }] }), { me: "bruno" });
  assert.strictEqual(falhou.checks, "fail");
  assert.strictEqual(falhou.blocked, "checks");
  assert.strictEqual(falhou.canMerge, false);

  const rodando = R.reviewState(pr({ mine: true, checks: [{ name: "ci", state: "running", url: "" }] }), { me: "bruno" });
  assert.strictEqual(rodando.checks, "pending");
  assert.strictEqual(rodando.canMerge, false, "não se junta com verificação em curso");
  assert.strictEqual(rodando.blocked, null, "em curso não é bloqueio: é espera");

  // sem nenhuma verificação configurada o estado é "não há", nunca um ✓ inventado
  assert.strictEqual(R.reviewState(pr({ checks: [] }), { me: "bruno" }).checks, null);
});

test("o portão do juntar é o que o GitHub diz, não a conta de aprovações", () => {
  // 1 de 1 aprovação e mesmo assim BLOCKED (proteção de branch que o app não lê):
  // se a aritmética fosse o portão, o botão prometeria o que não pode cumprir
  const s = R.reviewState(pr({ mine: true, approvals: 1, reviewRequests: [], mergeStateStatus: "BLOCKED" }), { me: "bruno" });
  assert.deepStrictEqual(s.approvals, { have: 1, need: 1 });
  assert.strictEqual(s.canMerge, false);

  // o denominador é gente na revisão (aprovações + pedidos), um fato — não a
  // exigência do repositório, que não é legível
  const conta = R.reviewState(pr({ approvals: 1, reviewRequests: [{ login: "bruno" }, { login: "ana" }] }), { me: "bruno" });
  assert.deepStrictEqual(conta.approvals, { have: 1, need: 3 });
});

test("reviewState lê a MINHA decisão, e diz quando ela é de uma versão anterior", () => {
  const aprovei = R.reviewState(
    pr({ reviews: [{ author: "bruno", state: "APPROVED", body: "", when: "2026-08-12T09:00:00Z", stale: false }] }),
    { me: "bruno" },
  );
  assert.strictEqual(aprovei.decided, "approved");
  assert.strictEqual(aprovei.stale, false);

  // a última submissão do mesmo autor vence: quem pediu mudanças e depois
  // aprovou conta como aprovado, uma vez só
  const virou = R.reviewState(
    pr({
      reviews: [
        { author: "bruno", state: "CHANGES_REQUESTED", body: "", when: "2026-08-11T09:00:00Z", stale: false },
        { author: "bruno", state: "APPROVED", body: "", when: "2026-08-12T09:00:00Z", stale: true },
      ],
    }),
    { me: "bruno" },
  );
  assert.strictEqual(virou.decided, "approved");
  assert.strictEqual(virou.stale, true, "aprovação de versão anterior é um fato que a tela diz");

  // um comentário não é uma decisão
  const so = R.reviewState(
    pr({ reviews: [{ author: "bruno", state: "COMMENTED", body: "", when: "x", stale: false }] }),
    { me: "bruno" },
  );
  assert.strictEqual(so.decided, null);
  assert.strictEqual(so.canReview, true, "comentar não fecha a porta de aprovar");
});

test("reviewState conta os comentários que RECEBEU, sem fingir um total", () => {
  const s = R.reviewState(
    pr({
      threads: [
        { id: 1, path: "a.md", line: 3, resolved: false, outdated: false, excerpt: "", comments: [{ author: "ana", body: "x", when: "" }, { author: "bruno", body: "y", when: "" }] },
        { id: 2, path: "b.md", line: null, resolved: true, outdated: false, excerpt: "", comments: [{ author: "ana", body: "z", when: "" }] },
      ],
    }),
    { me: "bruno" },
  );
  assert.strictEqual(s.comments, 3);
  assert.strictEqual(s.threads, 2);
});

test("uma mudança que já entrou não rearma botão nenhum", () => {
  const s = R.reviewState(pr({ mine: true, state: "MERGED" }), { me: "bruno" });
  assert.strictEqual(s.merged, true);
  assert.strictEqual(s.canMerge, false);
  assert.strictEqual(s.canReview, false);
  assert.deepStrictEqual(R.prChips(pr({ mine: true, state: "MERGED" }), { me: "bruno" }).map((c) => c.key), ["merged"]);
});

/* -------------------------------------------------------------------- chips */

test("prChips carrega ESTADOS; contador é prosa da linha, não mais um selo", () => {
  const chips = R.prChips(pr({ checks: [{ name: "ci", state: "failed", url: "" }], changesRequested: 1 }), { me: "bruno" });
  const keys = chips.map((c) => c.key);
  assert.deepStrictEqual(keys, ["changes", "checks"]);
  assert.strictEqual(chips[0].tone, "warn");
  assert.strictEqual(chips[1].tone, "danger");
  assert.strictEqual(chips[1].values.state, "fail");
  // nenhum chip carrega um número: %1 de %2 aprovações e %1 comentários são a
  // linha de prosa da revisão (quatro objetos numa linha viram dois)
  for (const c of chips) assert.ok(!("count" in c.values), `chip com contador: ${c.key}`);

  assert.deepStrictEqual(R.prChips(pr({ mergeable: "CONFLICTING" }), { me: "bruno" }).map((c) => c.key), ["conflict", "checks"]);
  assert.ok(R.prChips(pr({ mine: true }), { me: "bruno" }).some((c) => c.key === "ready"));
  assert.ok(
    R.prChips(pr({ reviews: [{ author: "bruno", state: "APPROVED", body: "", when: "", stale: false }] }), { me: "bruno" })
      .some((c) => c.key === "approvedByMe"),
  );
});

/* ------------------------------------------------------------------- listas */

test("groupReviews separa 'aguardam você' de 'suas' — e não perde nenhuma no caminho", () => {
  const lista = [
    { number: 12, author: { login: "ana" }, reviewRequests: [{ login: "bruno" }] },
    { number: 13, author: { login: "bruno" }, reviewRequests: [] },
    { number: 14, author: { login: "carla" }, reviewRequests: [{ login: "ana" }] },
  ];
  const g = R.groupReviews(lista, { me: "bruno" });
  assert.deepStrictEqual(g.forMe.map((p) => p.number), [12]);
  // a #14 não pede a minha revisão e não é minha: ela não pode sumir da tela
  assert.deepStrictEqual(g.mine.map((p) => p.number), [13, 14]);
  assert.strictEqual(g.forMe.length + g.mine.length, lista.length);

  // o handle do revisor pode vir como login, slug (time) ou nome
  const time = R.groupReviews([{ number: 15, author: { login: "ana" }, reviewRequests: [{ slug: "bruno" }] }], { me: "bruno" });
  assert.strictEqual(time.forMe.length, 1);
  // sem saber quem sou eu, nada é "meu" — e nada é perdido
  const anon = R.groupReviews(lista, {});
  assert.strictEqual(anon.forMe.length, 0);
  assert.strictEqual(anon.mine.length, 3);
});

// MIGRADO (rodada 4): a mesma asserção — "conta só o que ainda está na lista" —
// contra a chave que a lista realmente usa (changeId), porque a marca deixou de
// ser do caminho e passou a ser da MUDANÇA. Mesma força, mais um caso: uma marca
// de um arquivo que já não está na lista continua não contando.
test("viewedCount conta só o que ainda está na lista", () => {
  const files = [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }];
  const k = (f) => R.changeId(f, "now");
  assert.deepStrictEqual(R.viewedCount(files, [k(files[0]), k({ path: "z.md" })], "now"),
    { seen: 1, total: 3 });
  assert.deepStrictEqual(R.viewedCount(files, new Set([k(files[0]), k(files[1])]), "now"),
    { seen: 2, total: 3 });
  assert.deepStrictEqual(R.viewedCount([], [], "now"), { seen: 0, total: 0 });
});

// ACHADO NO APP RODANDO (rodada 3): «✓ visto» e o contador «N de M vistos»
// sobreviviam a uma versão salva. Marcar o único documento mudado como visto,
// salvar a versão, mudar o MESMO documento outra vez e reentrar no destino
// mostrava o cartão novo já com «✓ visto» e «1 de 1 vistos» — um diff que a
// pessoa nunca abriu, na ferramenta que existe para ela "não perder um documento
// numa mudança grande". A marca é uma afirmação sobre CONTEÚDO LIDO: ela tem de
// morrer com o conteúdo (DESIGN.md §1 — o estado nunca mente).
test("uma marca de «visto» não sobrevive à mudança que ela descrevia", () => {
  const antes = {
    path: "contexts/mobile/context.md", kind: "modified", additions: 1, deletions: 1, binary: false,
    hunks: [{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [
        { kind: "del", oldLine: 1, newLine: null, text: "o convite expira em 48 horas" },
        { kind: "add", oldLine: null, newLine: 1, text: "o convite expira em 7 dias" },
      ],
    }],
  };
  // a MESMA marca que a tela guardaria depois de «marcar como visto»
  const marcado = new Set([R.changeId(antes, "now")]);
  assert.deepStrictEqual(R.viewedCount([antes], marcado, "now"), { seen: 1, total: 1 });

  // o mesmo caminho, outro texto: é outra mudança, e ninguém a leu
  const depois = JSON.parse(JSON.stringify(antes));
  depois.hunks[0].rows[1].text = "o reenvio vale uma vez por convite";
  assert.notStrictEqual(R.changeId(depois, "now"), R.changeId(antes, "now"),
    "um texto diferente no mesmo caminho é outra mudança");
  assert.deepStrictEqual(R.viewedCount([depois], marcado, "now"), { seen: 0, total: 1 },
    "uma mudança que ninguém abriu não pode chegar pré-marcada como lida");

  // e o mesmo texto de um lado não marca o do outro: a árvore de trabalho e uma
  // revisão aberta falam os MESMOS caminhos
  assert.notStrictEqual(R.changeId(antes, "pr:42"), R.changeId(antes, "now"));
  assert.deepStrictEqual(R.viewedCount([antes], marcado, "pr:42"), { seen: 0, total: 1 },
    "a marca da árvore de trabalho não vale para a revisão do time");

  // o que NÃO muda a identidade: reler o mesmo diff duas vezes
  assert.strictEqual(R.changeId(antes, "now"), R.changeId(JSON.parse(JSON.stringify(antes)), "now"));
  // e um binário sem linhas ainda se distingue por caminho e estado
  assert.notStrictEqual(
    R.changeId({ path: "a.png", kind: "added", binary: true }, "now"),
    R.changeId({ path: "a.png", kind: "removed", binary: true }, "now"));
});

/* ------------------------------------------------- a superfície do destino */

// D6 · a revisão do time morava numa folha que se dispensa. Uma porta permanente
// é um destino da nav — e ele existe nos DOIS lugares que o casco lê.
test("N5 — a revisão é um destino permanente, não uma folha que se dispensa", () => {
  assert.match(HTML, /data-dest="review"/, "a nav precisa da quarta pílula");
  assert.match(HTML, /id="destReview"/, "…e do painel que ela mostra");
  assert.match(SHELL, /review:\s*"destReview"/, "o casco liga a pílula ao painel");
  // o contador da nav e o da aba são o mesmo fato: os dois nascem no HTML
  assert.match(HTML, /id="destReviewBadge"[^>]*class="destbadge"/);
});

// F12 · MEDIDO no piso de 860px que tauri.conf permite, com o painel ✦ IA aberto:
// quatro rótulos (Início 34 · Organizar 60 · Conhecimento 86 · Revisão 47) + 4×22
// de padding + 6 de gap + 8 de cromo = 329px de pílula (379 com os dois contadores).
// Contra os 32px de padding do cabeçalho, 2×14 de gap, um bloco esquerdo de até
// 247px e um direito de 186px, o cabeçalho pedia 872px numa janela de 860 — e
// #app não declara overflow:hidden, então isso é rolagem lateral do corpo, que a
// F12 proíbe. Pior antes disso: .dest não declarava white-space, então "Conhecimento"
// quebrava em duas linhas dentro de um cabeçalho preso em 54px — um controle
// cortado, que a regra 9 proíbe por escrito.
test("F12 — o quarto destino não quebra a linha do cabeçalho nem empurra a janela", () => {
  const dest = /\.dest\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(dest, ".dest tem de existir");
  assert.match(dest[1], /white-space:\s*nowrap/, "um rótulo que quebra dentro de 54px é um controle cortado");

  // A pílula NUNCA sai do fluxo. Enquanto ela era `position: absolute` nada a
  // empurrava, e o guarda contra a colisão era um breakpoint que previa as larguras
  // dos dois lados — previsão que não se sustenta, porque o conteúdo é variável
  // (idioma, nome do projeto, contadores, e o chip do rascunho até 190px). MEDIDO
  // no app a 1280px, que é a largura PADRÃO da janela: pílula 456→824 contra o
  // bloco da direita começando em 822 — a etiqueta da versão por baixo dela.
  const navBlk = /\.destnav \{([^}]*)\}/.exec(CSS);
  assert.ok(navBlk, ".destnav tem de existir");
  assert.doesNotMatch(navBlk[1], /position:\s*absolute/,
    "fora do fluxo nada empurra a pílula: o bloco da direita passa por baixo dela");
  assert.doesNotMatch(CSS, /\.destnav \{ position: absolute/,
    "nem numa regra à parte");
  // o eixo passa a ser estrutural: três trilhas, as duas laterais FLEXÍVEIS
  const head = /#appHead \{([^}]*)\}/.exec(CSS);
  assert.ok(head, "#appHead tem de declarar o seu próprio casco");
  assert.match(head[1], /display:\s*grid/);
  assert.match(head[1], /grid-template-columns:\s*1fr auto 1fr/,
    "laterais flexíveis e iguais: a do meio fica no eixo enquanto as duas couberem, " +
    "e é EMPURRADA — nunca sobreposta — quando não couberem");
  // o pill de gravação tem de morar DENTRO do bloco da direita: como quarto irmão
  // solto ele não teria trilha, e a largura dele precisa contar no bloco cuja parte
  // decide se a pílula fica no eixo
  const right = /<div class="headright">([\s\S]*?)<\/div>/.exec(HTML);
  assert.ok(right, "o bloco da direita tem de existir");
  assert.match(right[1], /id="headRec"/,
    "o pill de gravação conta na largura do bloco da direita");
  // e o que cede é PROSA (um nome já elidido, com o texto inteiro no title e no
  // menu de troca), nunca um controle — a ordem que a própria regra 9 fixa
  const flow = /@media \(max-width: (\d+)px\) \{\n  \.projname \{ max-width: 110px/.exec(CSS);
  assert.ok(flow, "a prosa cede antes, para manter o eixo por mais tempo");
  // O DEFEITO DE 2026-11-23: com `min-width: 0` a trilha da direita encolhia abaixo
  // dos seus controles e, alinhada ao fim, o excesso saía pelo INÍCIO, por baixo da
  // nav — a 1280px, em inglês e gravando, «● recording» cobria 118px da aba
  // «Review» (captura do dono). O piso da trilha é o conteúdo; quem cede são os
  // blocos de largura, na ordem da regra 9 (tools/measure-header.js: 96 de 96).
  const rightBlk = /#appHead > \.headright \{([^}]*)\}/.exec(CSS);
  assert.ok(rightBlk, "o bloco da direita é preso à trilha");
  assert.doesNotMatch(rightBlk[1], /min-width:\s*0/,
    "sem piso, o bloco da direita transborda POR BAIXO da nav em vez de empurrá-la");

  // MEDIDO com a gravação em curso, que é o pior caso e já era defeito com TRÊS
  // destinos (932px pedidos numa janela de 860). O piso só fecha porque o
  // cabeçalho cede mais em 900 — e essa regra tem de vir DEPOIS da de 1140:
  // mesma especificidade, ganha a última. Escrita antes, a de 110px vencia e a
  // medição continuava em 888px.
  const i1140 = flow.index;
  const yield900 = CSS.indexOf(".projname { max-width: 70px");
  assert.ok(yield900 > i1140, "a regra que cede mais vem depois, ou a de 1140 vence");
  // MIGRADA (rodada 3): a asserção era `min-width: 0` no .headrec, para o corpo
  // nunca rolar de lado. Ela cumpria isso deixando o pill — um CONTROLE, que volta
  // para a gravação — ser o único item encolhível do flex: medido, ele ia a 35px
  // dos 151px que pede entre 901 e 1015px, sem relógio e sem a palavra "gravando".
  // A mesma garantia, na ordem da regra 9: quem encolhe é a PROSA (o nome do
  // projeto, que já elide e cujo texto inteiro está no title e no menu), e o
  // controle mantém o tamanho — então continua havendo um item que cede, e o corpo
  // continua sem rolar.
  const rec = /\.headrec \{([^}]*)\}/.exec(CSS);
  assert.match(rec[1], /flex: none/, "um controle não é o item que absorve o déficit do cabeçalho");
  const switchBlk = /\.apphead \.switch \{([^}]*)\}/.exec(CSS);
  assert.match(switchBlk[1], /min-width: 0/,
    "quem cede é o bloco do projeto (prosa, não controle): é este piso 0 que autoriza " +
    "a trilha da esquerda a encolher");
  assert.match(switchBlk[1], /display: flex/,
    "sem isto o botão de dentro fica no tamanho do conteúdo e transborda em vez de elidir");
  const name = /\.projname \{([^}]*)\}/.exec(CSS);
  assert.match(name[1], /text-overflow: ellipsis/, "e encurta dizendo que encurtou (nunca cortado no meio)");
  assert.match(name[1], /min-width: 0/);
});

// MEDIDO no piso de 860 com o painel ✦ IA aberto: a coluna tem 342px, e a tira
// de abas pedia 337px dentro dos 298px úteis, o campo do compositor 326px
// (um <input> não encolhe abaixo da sua largura intrínseca) e a linha do cartão
// 313px (um item de flex não encolhe abaixo do min-content sem min-width: 0).
// Resultado: #destReview rolava de lado dentro da coluna — o que §7 proíbe.
test("F12 — no piso de 860 nada da Revisão passa da coluna que a contém", () => {
  const cq = /@container \(max-width: 400px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(cq, "a tira responde à COLUNA (o painel ✦ IA a estreita), nunca à janela");
  assert.match(cq[1], /#revTabs \.segbtn \{ flex: 1 1 100%/, "as duas metades empilham inteiras: nenhuma palavra cortada");
  assert.match(CSS, /\.wfield\.stack > input \{ min-width: 0/, "o campo tinha largura intrínseca e esticava o cartão");
  const sum = /\.revcard > summary\.revsum \{([^}]*)\}/.exec(CSS);
  assert.match(sum[1], /flex-wrap: wrap/, "a linha do cartão quebra antes de inflar a coluna");
  assert.match(CSS, /\.revsum \.rvpath \{ min-width: 0/, "o caminho já tem reticências: ele encolhe, não o cartão");
  // a linha de diff é prosa: ela QUEBRA, então o corpo nunca rola de lado
  const txt = /\.rvtxt \{([^}]*)\}/.exec(CSS);
  assert.match(txt[1], /overflow-wrap: break-word/);
  assert.match(txt[1], /white-space: pre-wrap/);
});
