// ADR-0010 — pure meeting helpers (parsing meeting ids from acervo-relative
// paths, stripping the append marker, joining the acervo base for the
// transcription filesystem path). No DOM/Tauri: exercised in Node via require().
const test = require("node:test");
const assert = require("node:assert");
const LM = require("../src/meeting.js");

test("filterHallucinations drops whisper silence-artifacts, keeps real speech", () => {
  // the exact field report: a caption-credit hallucination on silence
  assert.strictEqual(LM.filterHallucinations("Legenda por Sônia Ruberti"), "");
  assert.strictEqual(LM.filterHallucinations("Legendas pela comunidade Amara.org"), "");
  assert.strictEqual(LM.filterHallucinations("♪"), "");
  assert.strictEqual(LM.filterHallucinations("[Música]"), "");
  assert.strictEqual(LM.filterHallucinations("...   "), "");
  // real speech survives untouched
  assert.strictEqual(LM.filterHallucinations("Vamos decidir o prazo da frota."), "Vamos decidir o prazo da frota.");
  // mixed: keep the speech line, drop the credit line
  assert.strictEqual(
    LM.filterHallucinations("Decidimos migrar em agosto.\nLegenda por Sônia Ruberti"),
    "Decidimos migrar em agosto."
  );
});

// T-7 (ADR-0018): the report is gone, so reuniao.md is the only door into a
// meeting. A relatorio.md left on disk by an old version is NOT a meeting file.
test("livingId extracts the meeting id only from the canonical home", () => {
  const living = "pessoal/temas/frota-2026/reunioes/2026-07-27-1430-semanal/reuniao.md";
  const report = "pessoal/temas/frota-2026/reunioes/2026-07-27-1430-semanal/relatorio.md";
  assert.strictEqual(LM.livingId(living), "2026-07-27-1430-semanal");
  // wrong file / wrong world / traversal-ish never match
  assert.strictEqual(LM.livingId(report), null);
  assert.strictEqual(LM.livingId("contextos/x/context.md"), null);
  assert.strictEqual(LM.livingId("pessoal/temas/t/reunioes/../reuniao.md"), null);
  assert.strictEqual(LM.livingId(null), null);
  // the report helpers are gone with the report itself
  assert.strictEqual(LM.reportId, undefined);
  assert.strictEqual(LM.isReport, undefined);
});

test("isLiving mirrors the id extractor", () => {
  const living = "pessoal/temas/t/reunioes/2026-07-27-1430-x/reuniao.md";
  assert.strictEqual(LM.isLiving(living), true);
  assert.strictEqual(LM.isLiving("pessoal/temas/t/reunioes/2026-07-27-1430-x/relatorio.md"), false);
});

test("stripMarker removes every occurrence of the append marker (BR-8: never shows the raw comment)", () => {
  const body = `intro\n\n${LM.MARKER}\n\n[00:00] olá\n\n${LM.MARKER}`;
  const out = LM.stripMarker(body);
  assert.ok(!out.includes(LM.MARKER));
  assert.ok(out.includes("[00:00] olá") && out.includes("intro"));
  assert.strictEqual(LM.stripMarker(null), "");
});

test("acervoJoin resolves an acervo-relative path against the base with one separator", () => {
  const rel = "pessoal/temas/t/reunioes/2026-07-27-1430-x/audio/completo.wav";
  assert.strictEqual(LM.acervoJoin("/Users/me/acervo", rel), "/Users/me/acervo/" + rel);
  // trailing base slash and leading rel slash collapse to a single separator
  assert.strictEqual(LM.acervoJoin("/Users/me/acervo/", "/" + rel), "/Users/me/acervo/" + rel);
  // empty base degrades to the rel unchanged
  assert.strictEqual(LM.acervoJoin("", rel), rel);
});

// ADR-0011 análise rail: aiStatusLine turns the ai_doctor posture into one
// honest pt-BR line. Booleans only — never a secret/token (BR-9); deferred
// surfaces read "—" so the UI cannot imply a live cloud/MCP pass in v1.
test("aiStatusLine formats the ai_doctor posture in pt-BR (booleans only)", () => {
  // v1 default posture: local resolvable, cloud binary present, MCP deferred.
  assert.strictEqual(
    LM.aiStatusLine({ localModelReady: true, localModelName: "ollama", cloudAvailable: true, mcpAvailable: false }),
    "local: pronto (ollama) · nuvem: disponível · MCP: —"
  );
  // nothing resolvable: no cloud/model names leak, everything reads off.
  assert.strictEqual(
    LM.aiStatusLine({ localModelReady: false, localModelName: "", cloudAvailable: false, mcpAvailable: false }),
    "local: indisponível · nuvem: — · MCP: —"
  );
  // ready without a name still reads "pronto" (no empty parens).
  assert.strictEqual(
    LM.aiStatusLine({ localModelReady: true, cloudAvailable: false }),
    "local: pronto · nuvem: — · MCP: —"
  );
  // missing/undefined doctor degrades safely to all-off.
  assert.strictEqual(LM.aiStatusLine(undefined), "local: indisponível · nuvem: — · MCP: —");
});

// i18n: pure modules cannot reach the window-level i18n dictionary, so the
// UI-text producers take an optional `lang` ("pt" default | "en") and emit the
// localized text directly.
test("aiStatusLine renders in English when lang is 'en'", () => {
  assert.strictEqual(
    LM.aiStatusLine({ localModelReady: true, localModelName: "ollama", cloudAvailable: true, mcpAvailable: false }, "en"),
    "local: ready (ollama) · cloud: available · MCP: —"
  );
  assert.strictEqual(
    LM.aiStatusLine({ localModelReady: false, cloudAvailable: false, mcpAvailable: false }, "en"),
    "local: unavailable · cloud: — · MCP: —"
  );
  assert.strictEqual(LM.aiStatusLine(undefined, "en"), "local: unavailable · cloud: — · MCP: —");
  // explicit "pt" matches the default
  assert.strictEqual(LM.aiStatusLine(undefined, "pt"), "local: indisponível · nuvem: — · MCP: —");
});

// ADR-0012 terminal trigger: the app injects a Claude Code slash command into
// the terminal PTY. These helpers build that exact string, so they are the unit
// that must never leak a premature submit (a raw newline) or a bad dir.
const DIR = "pessoal/temas/frota-2026/reunioes/2026-07-27-1430-x";

test("meetingDir derives the acervo-relative dir from the living path", () => {
  assert.strictEqual(LM.meetingDir(DIR + "/reuniao.md"), DIR);
  assert.strictEqual(LM.meetingDir(DIR + "/relatorio.md"), null);
  // non-meeting paths, the bare dir, and nullish input never match
  assert.strictEqual(LM.meetingDir("contextos/frota/context.md"), null);
  assert.strictEqual(LM.meetingDir(DIR), null);
  assert.strictEqual(LM.meetingDir(null), null);
});

test("sanitizeSkillArg flattens whitespace/newlines to one PTY line", () => {
  assert.strictEqual(LM.sanitizeSkillArg("qual   o\nrisco?\t"), "qual o risco?");
  assert.strictEqual(LM.sanitizeSkillArg("\r\n  a  b \r\n"), "a b");
  assert.strictEqual(LM.sanitizeSkillArg(""), "");
  assert.strictEqual(LM.sanitizeSkillArg(null), "");
});

test("meetingSkillCmd builds the analyse and answer slash commands", () => {
  assert.strictEqual(LM.meetingSkillCmd("analyse", DIR), "/loro-analyse " + DIR);
  assert.strictEqual(
    LM.meetingSkillCmd("question", DIR, "qual foi a decisão?"),
    "/loro-question " + DIR + " qual foi a decisão?"
  );
});

test("meetingSkillCmd flattens a multiline question — never a premature submit", () => {
  const cmd = LM.meetingSkillCmd("question", DIR, "linha 1\nlinha 2");
  assert.strictEqual(cmd, "/loro-question " + DIR + " linha 1 linha 2");
  assert.ok(!/[\r\n]/.test(cmd));
});

test("meetingSkillCmd returns null without a dir, or with an empty answer question", () => {
  assert.strictEqual(LM.meetingSkillCmd("analyse", ""), null);
  assert.strictEqual(LM.meetingSkillCmd("analyse", null), null);
  assert.strictEqual(LM.meetingSkillCmd("question", DIR, "   \n  "), null);
  assert.strictEqual(LM.meetingSkillCmd("question", DIR, ""), null);
});

test("ADR-0013: meeting helpers recognize the brainstorming/ world", () => {
  const dir = "brainstorming/frota-2026/reunioes/2026-07-27-1430-x";
  assert.strictEqual(LM.meetingDir(dir + "/reuniao.md"), dir);
  assert.strictEqual(LM.livingId(dir + "/reuniao.md"), "2026-07-27-1430-x");
  assert.strictEqual(LM.isLiving(dir + "/reuniao.md"), true);
});

test("meetingLabel strips the timestamp and humanizes the slug", () => {
  assert.strictEqual(LM.meetingLabel("2026-07-27-1430-semanal-de-custos"), "semanal de custos");
  assert.strictEqual(LM.meetingLabel("sem-stamp"), "sem-stamp");
  assert.strictEqual(LM.meetingLabel(null), "");
});

test("meetingLabel identifies untitled meetings by date/time, never a bare 'reuniao'", () => {
  // a meeting created without a title gets the generic "reuniao" slug tail —
  // the sidebar must still identify it (owner ask, 2026-07-28)
  assert.strictEqual(LM.meetingLabel("2026-07-28-1430-reuniao"), "reunião 28/07 14:30");
  assert.strictEqual(LM.meetingLabel("2026-07-28-0905-nova-reuniao"), "reunião 28/07 09:05");
});

test("meetingLabel identifies untitled meetings in English when lang is 'en'", () => {
  assert.strictEqual(LM.meetingLabel("2026-07-28-1430-reuniao", "en"), "meeting 28/07 14:30");
  assert.strictEqual(LM.meetingLabel("2026-07-28-0905-nova-reuniao", "en"), "meeting 28/07 09:05");
  // a titled slug is data, not UI copy — lang never changes it
  assert.strictEqual(LM.meetingLabel("2026-07-27-1430-semanal-de-custos", "en"), "semanal de custos");
  assert.strictEqual(LM.meetingLabel("sem-stamp", "en"), "sem-stamp");
});

test("meetingTitleFromManifest prefers titulo, never the stale default", () => {
  assert.strictEqual(LM.meetingTitleFromManifest({ titulo: "Semanal" }, "id-x"), "Semanal");
  // the default "Reunião"/"nova reunião" falls back to the id (fixes the bug)
  assert.strictEqual(LM.meetingTitleFromManifest({ titulo: "Reunião" }, "id-x"), "id-x");
  assert.strictEqual(LM.meetingTitleFromManifest({}, "id-x"), "id-x");
});

test("meetingTitleFromManifest also rejects the English stale defaults (manifest data may be en)", () => {
  // manifests written under an English UI carry the en default titles; the
  // stale-default check is a data comparison, so it accepts both languages
  assert.strictEqual(LM.meetingTitleFromManifest({ titulo: "Meeting" }, "id-x"), "id-x");
  assert.strictEqual(LM.meetingTitleFromManifest({ titulo: "new meeting" }, "id-x"), "id-x");
  // the pt defaults keep being rejected too
  assert.strictEqual(LM.meetingTitleFromManifest({ titulo: "nova reunião" }, "id-x"), "id-x");
});

// O que acontece com o buffer avulso quando uma sessão termina. Bug relatado:
// ao encerrar uma gravação feita NUM BRAINSTORMING, o painel da transcrição
// avulsa subia por cima. A superfície da reunião é a aba reuniao.md — o rodapé
// avulso não tem nada a fazer ali (o onStarted já respeitava isso; o onStopped
// não respeitava).
test("reunião nunca aciona o rodapé avulso, mesmo com sobras no buffer", () => {
  assert.strictEqual(LM.looseEndAction({ meetingActive: true, lineCount: 12, autosave: false }), "none");
  assert.strictEqual(LM.looseEndAction({ meetingActive: true, lineCount: 12, autosave: true }), "none");
});

test("sem linhas não há o que salvar", () => {
  assert.strictEqual(LM.looseEndAction({ meetingActive: false, lineCount: 0, autosave: false }), "none");
  assert.strictEqual(LM.looseEndAction({ meetingActive: false, lineCount: 0, autosave: true }), "none");
});

test("transcrição avulsa com linhas: salva sozinha ou oferece a barra", () => {
  assert.strictEqual(LM.looseEndAction({ meetingActive: false, lineCount: 3, autosave: true }), "autosave");
  assert.strictEqual(LM.looseEndAction({ meetingActive: false, lineCount: 3, autosave: false }), "offer");
});

test("looseEndAction tolera entrada faltando", () => {
  assert.strictEqual(LM.looseEndAction(), "none");
  assert.strictEqual(LM.looseEndAction({}), "none");
});

// ---- #44: mover uma reunião com toda a sua análise -------------------------
// Uma reunião só existe em `<brainstorming>/reunioes/`, porque é exatamente esse
// caminho que o list_meetings varre — então o destino nunca é avulso/notas/anexos.
test("meetingMoveTargets exclui o brainstorming atual", () => {
  const temas = [
    { slug: "a", nome: "Alfa" },
    { slug: "b", nome: "Beta" },
    { slug: "c", nome: "" },
  ];
  const alvos = LM.meetingMoveTargets(temas, "b");
  assert.deepStrictEqual(alvos.map((d) => d.slug), ["a", "c"]);
  assert.strictEqual(alvos[0].label, "Alfa");
  assert.strictEqual(alvos[1].label, "c", "sem nome, cai no slug");
});

test("meetingMoveTargets tolera lista vazia ou ausente", () => {
  assert.deepStrictEqual(LM.meetingMoveTargets([], "a"), []);
  assert.deepStrictEqual(LM.meetingMoveTargets(undefined, "a"), []);
  assert.deepStrictEqual(LM.meetingMoveTargets([{ slug: "a" }], "a"), []);
});

// O alvo de drop: só o cabeçalho `reuniões` de outro brainstorming aceita uma
// reunião. Soltar numa pasta de arquivos não é aceito.
test("meetingDropTarget aceita só reuniões de OUTRO brainstorming", () => {
  assert.strictEqual(LM.meetingDropTarget("bsfolder:destino:reunioes", "origem"), "destino");
  assert.strictEqual(LM.meetingDropTarget("bsfolder:origem:reunioes", "origem"), null,
    "o próprio brainstorming não é destino");
  for (const k of ["bsfolder:destino:notas", "bsfolder:destino:anexos", "pes:avulso", "", null]) {
    assert.strictEqual(LM.meetingDropTarget(k, "origem"), null, `não pode aceitar ${k}`);
  }
});

// T-9 · AC-5 (ADR-0018) — o fim de uma gravação SUGERE a análise. O desfecho é
// puro: só "analisar" produz um comando, e ele é o mesmo que o menu injeta.
test("analyseOffer só injeta quando o usuário aceita", () => {
  const dir = "brainstorming/frota/reunioes/2026-07-27-1430-x";
  assert.strictEqual(LM.analyseOffer("analisar", dir), LM.meetingSkillCmd("analyse", dir));
  // dispensar não roda nada
  assert.strictEqual(LM.analyseOffer("agora não", dir), null);
  assert.strictEqual(LM.analyseOffer(null, dir), null);
  // sem reunião não há o que oferecer
  assert.strictEqual(LM.analyseOffer("analisar", null), null);
});

// T-12 · AC-7 — a análise É a saída da reunião: sem nenhuma, não há o que enviar.
test("meetingQueueBlock declara o motivo quando não há análise", () => {
  assert.strictEqual(LM.meetingQueueBlock(0), "analise a reunião antes de enviar para a fila");
  assert.strictEqual(LM.meetingQueueBlock("0"), "analise a reunião antes de enviar para a fila");
  assert.strictEqual(LM.meetingQueueBlock(undefined), "analise a reunião antes de enviar para a fila");
  // uma nota basta
  assert.strictEqual(LM.meetingQueueBlock(1), null);
  assert.strictEqual(LM.meetingQueueBlock("3"), null);
});

// #53 — relatado em uso real: a MESMA fala aparecia duas vezes na transcrição,
// uma como "você" e outra como "sistema", com ~1s de diferença. Com o som saindo
// por alto-falante o microfone escuta de volta o que o áudio do sistema já
// gravou. O texto nunca vem idêntico (são dois sinais), então o teste usa os
// pares reais da captura que o dono enviou.
const ECO_MIC = "Tô, tô gripadão, tô zoado. Mas assim, eu tô sofrendo um negócio que você falou muito, você falou muito, você não passou lá no buraco de ar, velho. A minha aplicaçãozinha pra fechar ela lá.";
const ECO_SYS = "Tô gripadão, tô zoado, mas eu tô sofrendo um negócio que você falou muito, você falou muito, você vai passar lá no buraco de ar, velho, a minha aplicaçãozinha pra fechar ela lá.";

test("o eco de uma trilha na outra é barrado (par real da captura)", () => {
  const recent = [{ tMs: 18000, source: "mic", tokens: LM.speechTokens(ECO_MIC) }];
  const eco = LM.echoOfOtherSource({ text: ECO_SYS, tMs: 19000, source: "system" }, recent);
  assert.ok(eco, "não reconheceu o eco entre trilhas");
  assert.strictEqual(eco.source, "mic");
});

test("fala diferente na outra trilha NÃO é barrada", () => {
  const recent = [{ tMs: 18000, source: "mic", tokens: LM.speechTokens(ECO_MIC) }];
  const outra = "Vamos fechar o orçamento da frota antes de sexta, então preciso dos números do fornecedor.";
  assert.strictEqual(LM.echoOfOtherSource({ text: outra, tMs: 19000, source: "system" }, recent), null);
});

test("a mesma trilha repetindo é fala repetida, não eco", () => {
  const recent = [{ tMs: 18000, source: "mic", tokens: LM.speechTokens(ECO_MIC) }];
  assert.strictEqual(LM.echoOfOtherSource({ text: ECO_MIC, tMs: 19000, source: "mic" }, recent), null);
});

test("trecho curto nunca é barrado — 'tá bom' repete numa conversa de verdade", () => {
  const recent = [{ tMs: 1000, source: "system", tokens: LM.speechTokens("tá bom, pode ser") }];
  assert.strictEqual(LM.echoOfOtherSource({ text: "Tá bom, pode ser.", tMs: 1500, source: "mic" }, recent), null);
});

test("longe no tempo não é eco — a mesma frase dita de novo dez minutos depois", () => {
  const recent = [{ tMs: 18000, source: "mic", tokens: LM.speechTokens(ECO_MIC) }];
  assert.strictEqual(LM.echoOfOtherSource({ text: ECO_SYS, tMs: 618000, source: "system" }, recent), null);
});

test("speechTokens normaliza acento e pontuação (tô/to é a mesma palavra)", () => {
  assert.deepStrictEqual(LM.speechTokens("Tô, sim!"), ["to", "sim"]);
});

// Esta asserção começou errada: media só o lado menor e dava 1 para "a b c"
// dentro de "a b c d e f" — o mesmo defeito que fazia um segmento curto de
// microfone derrubar uma janela inteira de sistema. Cobertura é MÚTUA.
test("tokenContainment exige cobertura dos DOIS lados", () => {
  const tk = LM.speechTokens;
  assert.strictEqual(LM.tokenContainment(tk("a b c"), tk("a b c d e f")), 0.5);
  assert.strictEqual(LM.tokenContainment(tk("a b c"), tk("a b c")), 1);
});

// O achado da revisão, com o cenário exato: uma frase curta de microfone cujas
// palavras funcionais aparecem todas numa janela de 18s sobre OUTRO assunto.
// Antes: 0,91 → a janela com a fala de todo mundo era descartada em silêncio.
test("um trecho curto NÃO derruba uma janela longa de outro assunto", () => {
  const curto = "Eu acho que a gente pode fechar isso com o time.";
  const janela = "Então o fornecedor mandou a proposta ontem e eu acho que a gente pode discutir o prazo com o time de compras, porque isso trava tudo. A gente pode ver isso amanhã. O time de logística falou que com esse volume a rota fica cara.";
  const recent = [{ tMs: 1000, source: "mic", tokens: LM.speechTokens(curto) }];
  assert.strictEqual(LM.echoOfOtherSource({ text: janela, tMs: 5000, source: "system" }, recent), null,
    "a janela de sistema seria descartada — a transcrição é a ÚNICA saída da reunião (ADR-0018)");
});
