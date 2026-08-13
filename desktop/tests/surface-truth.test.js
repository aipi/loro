// Critic round 2 — the new-code and resolution lenses. The same family once
// more: a surface that renders what it should have parsed, an empty state that
// is unreachable, a form pre-refused before the first keystroke, and layout
// state that survives a restart into a broken window.
//
//   N17  the ideia surface rendered indice.md RAW: the YAML front-matter came
//        out as prose and the title appeared twice (two <h1> in one region)
//   N18  the meeting surface's three "sem transcrição" empty states were dead
//        code — every meeting file starts with "# <título>", so body.trim()
//        was always truthy
//   N19  "＋ novo projeto" opened on a red refusal: the prefilled default
//        folder is the one the first project already owns
//   N20  a path that is a FILE was accepted with "a pasta é criada se ainda
//        não existir", then answered with "Not a directory (os error 20)"
//   N22  #brainDirNote is written BEFORE being revealed — the anti-pattern the
//        a11y suite already enforces for the toast and the wizard alert
//   N23  the same destructive act had two confirmation UIs (app sheet vs the
//        OS confirm())
//   N24  below the panel's breakpoint the ✦ IA panel is display:none while the
//        toggle, its aria state and the terminal routing act as if it existed
//   N26  persisted pane sizes were never re-clamped to the current window
//
// DESIGN.md §1/§2/§5/§7, WCAG 1.3.1 / 1.4.10 / 4.1.3.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const { EN, tErr, setLang } = require("../src/i18n.js");
const LM = require("../src/meeting.js");
const R = require("../src/refs.js");

function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}
function fnBody(name) {
  const src = fnSource(name);
  return src.slice(src.indexOf("{") + 1, -1);
}
function loadPure(name, extra) {
  // eslint-disable-next-line no-new-func
  return new Function("R", "const t = (s) => s;\n" + (extra || "") + "return (" + fnSource(name) + ");")(R);
}
function pair(msgid) {
  assert.ok(EN[msgid] && EN[msgid] !== msgid, `falta o par em inglês de “${msgid}”`);
}

// ---------------------------------------------------------------- N17
test("N17 — a superfície da ideia não imprime o front-matter nem repete o título", () => {
  const f = loadPure("ideaBodyMarkdown");
  const raw = "---\nloro: 1\nid: ideia-de-regressao\ntema: ideia-de-regressao\n---\n\n# Ideia de regressao\n";
  assert.equal(f(raw).trim(), "", "só front-matter + o próprio título: não sobra corpo");
  const withBody = raw + "\numa linha de material\n";
  const out = f(withBody);
  assert.ok(!/loro: 1|^id:/m.test(out), "o front-matter é do arquivo, não do leitor (ADR-0009)");
  assert.ok(!/^#\s/m.test(out), "o h1 do arquivo duplicava o h1 da superfície (WCAG 1.3.1)");
  assert.match(out, /uma linha de material/);
  // sem front-matter e sem título, o material passa intacto
  assert.equal(f("só um texto").trim(), "só um texto");
});

test("N17 — o pintor da ideia usa o mesmo leitor de front-matter das outras vistas", () => {
  const body = fnBody("renderIdeaSurface");
  assert.match(body, /ideaBodyMarkdown\(/);
  assert.ok(!/body\.trim\(\) \? mdRender\(body\)/.test(body),
    "renderView e paintMeetingSurface separam o front-matter; esta era a única que não");
});

// ---------------------------------------------------------------- N18
test("N18 — 'sem transcrição' é alcançável: o título semeado não é transcrição", () => {
  // meeting.rs escreve sempre "# <título>\n\n<!-- loro:transcricao -->\n"
  const seeded = LM.stripMarker("# Reunião\n\n<!-- loro:transcricao -->\n");
  assert.equal(LM.transcriptText(seeded).trim(), "", "era isto que fazia body.trim() sempre verdadeiro");
  const withSpeech = LM.stripMarker("# Reunião\n\n<!-- loro:transcricao -->\n[00:03 · você] olá\n");
  assert.match(LM.transcriptText(withSpeech), /olá/);
  // um corpo sem título nenhum continua sendo transcrição
  assert.match(LM.transcriptText("linha solta"), /linha solta/);
});

test("N18 — a superfície decide o vazio pela transcrição, não pelo arquivo", () => {
  const body = fnBody("paintMeetingSurface");
  assert.match(body, /transcriptText\(/);
  assert.ok(!/body\.trim\(\) \? `<div class="annotatable transcript"/.test(body),
    "o título semeado não pode contar como fala capturada");
});

// ---------------------------------------------------------------- N19
test("N19 — o wizard não abre oferecendo a pasta que outro projeto já tem", () => {
  // a normalização é a MESMA que o resto do wizard usa (nada de cópia no teste)
  const f = loadPure("freeAcervoDir", fnSource("normalizeAcervoDir") + "\n");
  const acervos = [{ name: "Engenharia", dir: "/Users/x/Documents/Loro" }];
  assert.equal(f("/Users/x/Documents/Loro", acervos, false), "/Users/x/Documents/Loro",
    "reconfigurar o mesmo projeto continua apontando para a pasta dele");
  assert.equal(f("/Users/x/Documents/Loro", acervos, true), "/Users/x/Documents/Loro-2");
  assert.equal(f("/Users/x/Documents/Loro", [
    { dir: "/Users/x/Documents/Loro" }, { dir: "/Users/x/Documents/Loro-2" },
  ], true), "/Users/x/Documents/Loro-3");
  assert.equal(f("", acervos, true), "", "sem padrão conhecido não há o que sugerir");
});

test("N19 — o preparo do wizard usa a pasta livre", () => {
  assert.match(fnBody("resetWizardFields"), /freeAcervoDir\(/,
    "setWizDir(wizDefaultDir) abria todo segundo projeto em vermelho");
});

// ---------------------------------------------------------------- N20
test("N20 — um caminho que é ARQUIVO não é anunciado como pasta a criar", () => {
  setLang("pt");
  assert.match(tErr("Not a directory (os error 20)"), /pasta/,
    "um errno em inglês não é uma mensagem que o produto escreveu (ADR-0001 §10)");
  assert.ok(!/os error/.test(tErr("Not a directory (os error 20)")));
  setLang("en");
  assert.match(tErr("Not a directory (os error 20)"), /folder/);
  setLang("pt");
  assert.match(tErr("Permission denied (os error 13)"), /permiss/i);
});

// A varredura de errnos acima é a REDE, não o contrato: ela adivinha a intenção
// do sistema operacional a partir de um texto em inglês. O contrato é o backend
// devolver um código estável para cada recusa da pasta — e cada um deles precisa
// dizer o que está errado E o passo seguinte, nos dois idiomas.
test("N20 — a pasta recusada volta como código do produto, não como errno", () => {
  const TAURI = path.join(__dirname, "..", "src-tauri", "src");
  const rust = ["lib.rs", "paths.rs", "config.rs"]
    .map((f) => fs.readFileSync(path.join(TAURI, f), "utf8")).join("\n");
  for (const code of ["err.acervo_dir_is_file", "err.acervo_dir_not_writable", "err.acervo_dir_unusable"]) {
    assert.ok(rust.includes(`"${code}"`), `o backend precisa emitir ${code}`);
    for (const [lang, palavra] of [["pt", /pasta/i], ["en", /folder/i]]) {
      setLang(lang);
      const msg = tErr(code);
      assert.notEqual(msg, code, `${code} chega cru à tela em ${lang}`);
      assert.match(msg, palavra, `${code} (${lang}) não nomeia a pasta`);
      assert.match(msg, /escolha outra|pick another/i, `${code} (${lang}) não diz o passo seguinte`);
    }
  }
  setLang("pt");
  // e o caminho de semeadura não pode mais devolver o texto do io::Error
  const seed = rust.slice(rust.indexOf("fn ensure_acervo_structure("), rust.indexOf("fn resolve_acervo_slot("));
  assert.ok(!/map_err\(\|e\| e\.to_string\(\)\)/.test(seed),
    "um std::io::Error em inglês voltava para o assistente (ADR-0001 §10)");
});

test("N20 — depois da recusa o campo para de prometer", () => {
  const body = fnBody("paintWizDirNote");
  assert.match(body, /reject|override/, "a nota seguia dizendo 'a pasta é criada' para o caminho recusado");
  const create = APP.slice(APP.indexOf("B.createBtn.addEventListener"));
  assert.match(create.slice(0, create.indexOf("\n});")), /paintWizDirNote\(/);
});

// ---------------------------------------------------------------- N22
test("N22 — a nota de 'onde guardar' é revelada ANTES de receber o texto", () => {
  const body = fnBody("paintWizDirNote");
  const iReveal = body.indexOf("note.hidden");
  const iWrite = body.indexOf("note.textContent = ");
  assert.ok(iReveal > -1 && iWrite > -1);
  assert.ok(iReveal < iWrite,
    "uma região viva só é lida quando o texto MUDA com ela na árvore visível (WCAG 4.1.3)");
});

// ---------------------------------------------------------------- N23
test("N23 — nenhuma ação destrutiva usa o diálogo do sistema", () => {
  assert.ok(!/\bconfirm\(/.test(APP),
    "cinco atos destrutivos ficaram no confirm() nativo, fora do sistema de design (§5)");
  for (const fn of ["clearTranscript", "delPessoal", "mtgDeleteAudio", "closeTabById"]) {
    assert.match(fnBody(fn), /openModal\(/, `${fn} confirma na folha do app`);
  }
  pair("Descartar alterações não salvas?");
});

// ---------------------------------------------------------------- N24
test("N24 — o botão ✦ IA não afirma 'aberto' quando o painel não é desenhado", () => {
  assert.match(APP, /function panelRendered/);
  const src = APP.slice(APP.indexOf('$("aiPanelBtn").addEventListener'));
  const handler = src.slice(0, src.indexOf("\n});") + 4);
  assert.match(handler, /panelRendered\(\)|panelUnavailable\(/,
    "abaixo do ponto de quebra o painel é display:none e o botão ficava 'expandido'");
  pair("o painel ✦ IA não cabe nesta largura — alargue a janela");
});

test("N24 — o chat e o terminal não somem sem aviso na janela estreita", () => {
  assert.match(fnBody("openChatComposer"), /panelRendered\(\)|panelUnavailable\(/,
    "o card 'Perguntar à IA' focava um campo dentro de um subárvore display:none");
  assert.match(fnBody("setTermPanel") + fnBody("applyTermLayout"), /panelRendered\(\)/,
    "com o terminal roteado para o painel invisível, não havia como alcançá-lo");
});

// ---------------------------------------------------------------- N26
test("N26 — as larguras guardadas são re-limitadas à janela atual", () => {
  // os pisos/tetos reais entram do fonte: um teste com números próprios provaria
  // outra coisa
  const mins = APP.match(/const PANEL_MIN = \d+;/)[0] +
    APP.match(/const SIDE_MIN = [\s\S]*?;\n/)[0];
  const clamp = loadPure("clampPanes", mins);
  // (A) os dois tetos somavam 105vw: 45vw + 60vw deixava a coluna de conteúdo em 0
  const a = clamp(1512, 900, { sideW: 680, panelW: 907, aiPanelOpen: true, termH: 0 });
  assert.ok(a.sideW + a.panelW <= 1512 - 400, "a coluna de conteúdo nunca fica abaixo do piso");
  // (B) um painel de 1536px (60vw de um monitor externo) reaberto em 1512
  const b = clamp(1512, 900, { sideW: 0, panelW: 1536, aiPanelOpen: true, termH: 0 });
  assert.ok(b.panelW <= 1512 * 0.6, "o teto vale na aplicação, não só no arrasto");
  assert.ok(b.panelW >= 300, "e o piso continua valendo");
  // (C) a doca do terminal guardada em 1080px num viewport de 830
  assert.ok(clamp(1512, 830, { termH: 1080, aiPanelOpen: false }).termH <= 830 * 0.75);
  // o que cabe não é mexido
  const keep = clamp(1512, 900, { sideW: 250, panelW: 330, aiPanelOpen: true, termH: 200 });
  assert.deepEqual(keep, { sideW: 250, panelW: 330, termH: 200 });
});

test("N26 — o re-limite roda na aplicação e no resize", () => {
  assert.match(APP, /function reclampPanes/);
  for (const fn of ["applySideWidth", "applyPanelWidth", "applyTermHeight"]) {
    assert.match(fnBody(fn), /reclampPanes\(\)/, `${fn} aplica a largura já limitada`);
  }
  assert.match(APP, /addEventListener\("resize", *\(\) *=> *\{[\s\S]{0,200}reclampPanes\(\)/,
    "nada re-limitava ao redimensionar: o estado quebrado sobrevivia ao restart");
});
