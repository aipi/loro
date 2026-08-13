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
// #53, segunda captura do dono (o par que provou que o filtro nunca rodava).
const DUP_A = "Estabilizou, já delegamos ali, já consegui arrumar agora a casa, amanhã é mais executar a importação das multas ali, porque vai vir 600 e caralhadas multas ali, pra dentro da cestão.";
const DUP_B = "estabilizou, já delegamos ali, já consegui arrumar agora a casa, amanhã é mais executar a importação das multas ali, porque vai vir 600 e caralhadas multas ali, pra dentro do sistema.";
// O par de sobreposição PARCIAL: o microfone traz fala própria E o vazamento.
const PARC_SYS = "Ah, agora estou com esse negócio das multas, né? Eu estava com a Ordonia ali fechando, envolve tudo, está no site bot, está misturando tudo, a pressão aumentou um pouquinho, mas já";
const PARC_MIC = "E tá de boa aí? Tá pegado Ah, agora tô com esse negócio das multas, né? Porque tava com a Ardonia ali fechando Envolve tudo, tá no site bot Tá com coisa, misturou tudo A pressão aumentou um pouquinho Mas já";
// A COINCIDÊNCIA: frase curta cujas palavras funcionais aparecem todas numa
// janela sobre outro assunto. É o contraexemplo que calibra o limiar.
const CURTO = "Eu acho que a gente pode fechar isso com o time.";
const JANELA = "Então o fornecedor mandou a proposta ontem e eu acho que a gente pode discutir o prazo com o time de compras, porque isso trava tudo. A gente pode ver isso amanhã. O time de logística falou que com esse volume a rota fica cara.";

// ADR-0025 — helper: um trecho com intervalo, como as falas passam a chegar.
function fala(text, tMs, endMs, source) {
  return { tMs: tMs, endMs: endMs, source: source, tokens: LM.speechTokens(text) };
}

// ADR-0025 · o VÃO MEDIDO. O limiar não é chute: estes são os pares reais da
// captura do dono, e a separação entre eles é o que escolhe o corte. Um limiar
// sem vão não passa neste teste — é ele que impede a próxima calibração de
// escorregar para um número bonito sem evidência.
test("a cobertura por corridas separa eco real de coincidência", () => {
  const cov = (a, b) => LM.leakCoverage(LM.speechTokens(a), LM.speechTokens(b));
  // eco de verdade: as duas trilhas ouviram a MESMA fala
  assert.ok(cov(ECO_MIC, ECO_SYS) >= 0.85, "eco real: " + cov(ECO_MIC, ECO_SYS));
  assert.ok(cov(DUP_A, DUP_B) >= 0.85, "eco real: " + cov(DUP_A, DUP_B));
  // a coincidência: frase curta cujas palavras aparecem numa janela de OUTRO
  // assunto. Com corridas de 3 ela mede 0,82 — foi este número que reprovou o
  // desenho anterior, antes de virar código.
  const coinc = cov(CURTO, JANELA);
  assert.ok(coinc <= 0.6, "coincidência: " + coinc);
  // e o vão tem de existir de verdade, não por um decimal
  assert.ok(cov(ECO_MIC, ECO_SYS) - coinc >= 0.25, "sem vão não há limiar");
  // fala sem relação nenhuma não compartilha corrida alguma
  assert.strictEqual(cov(ECO_MIC, "Vamos fechar o orçamento da frota antes de sexta."), 0);
});

test("o eco de uma trilha na outra é barrado (par real da captura)", () => {
  const recent = [fala(ECO_SYS, 18000, 30000, "system")];
  const eco = LM.micLeakOfSystem(fala(ECO_MIC, 18200, 30200, "mic"), recent);
  assert.ok(eco, "não reconheceu o eco entre trilhas");
  assert.strictEqual(eco.source, "system");
});

// O INVARIANTE. O vazamento é físico e tem UM sentido: o som sai do alto-falante
// e entra no microfone. O caminho inverso não existe — o sidecar exclui o áudio
// do próprio Loro e o microfone não é saída de sistema. Então a fala do sistema
// nunca é descartada por causa do microfone, e é isso que tira o rótulo do
// sorteio: antes, quem chegasse primeiro ganhava, e a fala do outro virava "você".
test("a fala do sistema NUNCA é descartada por causa do microfone", () => {
  const recent = [fala(ECO_MIC, 18000, 30000, "mic")];
  assert.strictEqual(LM.micLeakOfSystem(fala(ECO_SYS, 18200, 30200, "system"), recent), null,
    "o vazamento não sobe do microfone para a trilha de sistema");
  // nem quando são idênticas, nem quando o microfone chegou primeiro
  assert.strictEqual(LM.micLeakOfSystem(fala(ECO_MIC, 18000, 30000, "system"), recent), null);
});

test("fala diferente na outra trilha NÃO é barrada", () => {
  const outra = "Vamos fechar o orçamento da frota antes de sexta, então preciso dos números do fornecedor.";
  const recent = [fala(outra, 18000, 30000, "system")];
  assert.strictEqual(LM.micLeakOfSystem(fala(ECO_MIC, 18200, 30200, "mic"), recent), null);
});

test("a mesma trilha repetindo é fala repetida, não eco", () => {
  const recent = [fala(ECO_MIC, 18000, 30000, "mic")];
  assert.strictEqual(LM.micLeakOfSystem(fala(ECO_MIC, 18200, 30200, "mic"), recent), null);
});

test("uma coincidência de palavras em OUTRO instante não é eco", () => {
  // o caso que reprovou o desenho anterior: as palavras batem, o tempo não.
  const recent = [fala(JANELA, 0, 18000, "system")];
  assert.strictEqual(LM.micLeakOfSystem(fala(CURTO, 30000, 33000, "mic"), recent), null,
    "fora do intervalo não há vazamento possível");
  // e mesmo DENTRO do intervalo a medida reprova: eco é simétrico, isto não é
  assert.strictEqual(LM.micLeakOfSystem(fala(CURTO, 2000, 5000, "mic"), recent), null,
    "descartar isto perderia fala legítima — a transcrição é a única saída (ADR-0018)");
});

test("longe no tempo não é eco — a mesma frase dita de novo dez minutos depois", () => {
  const recent = [fala(ECO_SYS, 18000, 30000, "system")];
  assert.strictEqual(LM.micLeakOfSystem(fala(ECO_MIC, 618000, 630000, "mic"), recent), null);
});

// A saída real que motivou o duplicado exato (ADR-0022 §B4): "[00:00 · sistema] A
// CIDADE NO BRASIL" seguido de "[00:00 · você] A CIDADE NO BRASIL". Quatro
// palavras — abaixo de qualquer piso de tamanho — duplicadas no mesmo instante.
// Agora uma regra só resolve: cobertura total + intervalos que coincidem.
test("a mesma linha curta nas duas trilhas no mesmo instante é uma só", () => {
  const recent = [fala("A CIDADE NO BRASIL", 0, 2000, "system")];
  assert.ok(LM.micLeakOfSystem(fala("A CIDADE NO BRASIL", 100, 2100, "mic"), recent));
  // mas 'tá bom, pode ser' dito por duas pessoas em TURNOS é conversa de verdade
  const conversa = [fala("tá bom, pode ser", 0, 1500, "system")];
  assert.strictEqual(LM.micLeakOfSystem(fala("Tá bom, pode ser.", 4000, 5500, "mic"), conversa), null);
  // e textos parecidos mas DIFERENTES continuam passando, curtos ou não
  assert.strictEqual(LM.micLeakOfSystem(fala("A CIDADE NO CHILE", 100, 2100, "mic"), recent), null);
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

// #53 (segunda captura do dono) — o filtro NUNCA disparava, e o log provou:
// zero descartes. As duas cópias da mesma fala chegam praticamente juntas; como o
// registro acontecia depois do await do append, ambas testavam contra uma lista
// que ainda não tinha a outra, ambas passavam e o par sobrevivia. O registro feito
// ANTES de esperar é o que vê o par (ADR-0022 §26).
test("registrar antes de esperar é o que faz o par ser visto", () => {
  const appended = [];
  // a trilha de sistema chega: nada na lista, passa, e SE REGISTRA na hora
  const daSystem = fala(DUP_B, 18000, 30000, "system");
  assert.strictEqual(LM.micLeakOfSystem(daSystem, appended), null);
  appended.push(daSystem);
  // o microfone chega em seguida, ainda com o append da primeira em voo
  assert.ok(LM.micLeakOfSystem(fala(DUP_A, 18200, 30200, "mic"), appended),
    "o par da captura real precisa ser reconhecido");
});

// Sobreposição parcial: o trecho tem fala própria E o vazamento. Não pode ser
// descartado (perderia a fala legítima), mas é evidência de que o microfone está
// ouvindo a caixa — é o que dispara a oferta do cancelamento de eco.
test("sobreposição parcial é sinalizada, não descartada", () => {
  const recent = [fala(PARC_SYS, 0, 15000, "system")];
  const novo = fala(PARC_MIC, 200, 15200, "mic");
  assert.strictEqual(LM.micLeakOfSystem(novo, recent), null,
    "tem fala própria junto — descartar perderia o que só o microfone ouviu");
  assert.ok(LM.partialCrossTalk(novo, recent), "mas o vazamento tem de ser percebido");
});

test("vazamento em OUTRO instante não é sinalizado — o empurrãozinho não pode ser falso", () => {
  const recent = [fala(PARC_SYS, 0, 15000, "system")];
  assert.strictEqual(LM.partialCrossTalk(fala(PARC_MIC, 60000, 75000, "mic"), recent), false);
});

// ADR-0025 §29 — relatado em uso real, com captura: o timestamp por fala deixou o
// texto PICADO. Uma janela de 18s virava cinco blocos, cada um com seu rótulo
// `[mm:ss · fonte]` no meio de uma frase:
//   [00:18 · sistema] modelo, e aí dando tudo
//   [00:20 · sistema] certo, depois eu apresento pra vocês
// O tempo de cada fala é o que faz a atribuição funcionar e não pode sair; o que
// muda é como o resultado é ESCRITO. Falas seguidas da mesma trilha viram um
// parágrafo, carimbado no tempo REAL da primeira delas.
test("falas seguidas da mesma trilha viram um parágrafo só", () => {
  const janela = [
    { tMs: 18000, endMs: 20000, text: "modelo, e aí dando tudo" },
    { tMs: 20000, endMs: 22000, text: "certo, depois eu apresento pra vocês" },
    { tMs: 22000, endMs: 24000, text: "aí como é que tá o projeto," },
  ];
  const blocos = LM.speechParagraphs(janela);
  assert.strictEqual(blocos.length, 1, "cinco rótulos no meio de uma frase é o defeito");
  assert.strictEqual(blocos[0].tMs, 18000, "carimbado no início da PRIMEIRA fala");
  assert.strictEqual(blocos[0].endMs, 24000, "e cobrindo até o fim da última");
  assert.strictEqual(blocos[0].text,
    "modelo, e aí dando tudo certo, depois eu apresento pra vocês aí como é que tá o projeto,");
});

test("um silêncio longo quebra o parágrafo, e a segunda metade guarda o tempo dela", () => {
  const blocos = LM.speechParagraphs([
    { tMs: 0, endMs: 3000, text: "Bom dia a todos." },
    // dez segundos de silêncio: juntar faria o carimbo do bloco mentir sobre a
    // segunda metade dele, que é justamente o que se queria consertar
    { tMs: 13000, endMs: 16000, text: "Vamos começar então." },
  ]);
  assert.strictEqual(blocos.length, 2);
  assert.strictEqual(blocos[0].tMs, 0);
  assert.strictEqual(blocos[1].tMs, 13000);
});

// A propriedade que faz o agrupamento funcionar com o whisper de verdade: numa fala
// contínua os segmentos se ENCOSTAM (medido: 0 → 5,780 → 6,780), então a fala
// corrida vira um parágrafo por construção, com qualquer limiar razoável.
test("fala contínua do whisper encosta, então junta sempre", () => {
  const real = [
    { tMs: 0, endMs: 5780, text: "Bom dia a todos, vamos revisar os custos da frota hoje, depois eu mando os números" },
    { tMs: 5780, endMs: 6780, text: "do fornecedor." },
  ];
  const blocos = LM.speechParagraphs(real);
  assert.strictEqual(blocos.length, 1);
  assert.ok(blocos[0].text.endsWith("os números do fornecedor."));
});

test("agrupar não inventa nem perde fala", () => {
  assert.deepStrictEqual(LM.speechParagraphs([]), []);
  assert.deepStrictEqual(LM.speechParagraphs(null), []);
  const uma = [{ tMs: 5000, endMs: 6000, text: "Obrigado." }];
  assert.deepStrictEqual(LM.speechParagraphs(uma), [{ tMs: 5000, endMs: 6000, text: "Obrigado." }]);
  // e não muta a entrada (o chamador ainda usa as falas soltas para o eco)
  assert.strictEqual(uma[0].text, "Obrigado.");
});

// ADR-0025 · o dono da junção. Antes as duas trilhas eram dois appendadores
// correndo para o mesmo arquivo, e a corrida decidia o rótulo. A trilha de sistema
// escreve na hora (ela nunca é descartada, não tem o que esperar); a fala do
// microfone espera a trilha de sistema cobrir o mesmo intervalo — aí a resolução é
// DECIDIDA. Com teto, para nada ficar preso esperando o que não vem.
test("o portão libera quando a trilha de sistema cobre o intervalo", async () => {
  const g = LM.coverageGate();
  let liberou = false;
  const p = g.wait(20000, 99999).then((r) => { liberou = true; return r; });
  g.advance(10000);
  await Promise.resolve();
  assert.strictEqual(liberou, false, "10s não cobrem uma fala que termina em 20s");
  g.advance(20000);
  assert.strictEqual(await p, "ready");
});

test("o portão não espera o que já está coberto", async () => {
  const g = LM.coverageGate();
  g.advance(30000);
  assert.strictEqual(await g.wait(20000, 99999), "ready");
});

test("o portão libera no teto, e diz que foi no teto", async () => {
  const g = LM.coverageGate();
  // o prazo é injetado: o teste controla o tempo, não espera por ele
  const agora = (fn) => fn();
  assert.strictEqual(await g.wait(20000, 18000, agora), "deadline",
    "vencido o prazo a fala entra do jeito que está — perder é pior que duplicar");
});

test("o portão libera quando não vem mais janela (pausar/encerrar)", async () => {
  const g = LM.coverageGate();
  const p = g.wait(20000, 99999);
  g.close();
  assert.strictEqual(await p, "ready");
  // e depois de fechado ninguém mais espera
  assert.strictEqual(await g.wait(50000, 99999), "ready");
  // retomar reabre o portão
  g.reopen();
  let liberou = false;
  g.wait(60000, 99999).then(() => { liberou = true; });
  await Promise.resolve();
  assert.strictEqual(liberou, false);
});

test("a cobertura nunca anda para trás", () => {
  const g = LM.coverageGate();
  g.advance(30000);
  g.advance(10000);
  assert.strictEqual(g.coveredMs(), 30000);
});

// ADR-0025 — as duas trilhas carimbavam a mesma fala com tempos diferentes. A
// captura de sistema começa antes de a interface se pintar (poll de TCC de 1,2s +
// espera do microfone de até 6s + openDoc), e o sistema era carimbado pelo offset
// dentro do WAV enquanto o microfone era carimbado pelo relógio da reunião. Estas
// funções puras são o único lugar que converte, e as duas convergem por
// construção — não por coincidência de constantes.
test("as duas trilhas dão o MESMO tempo para a mesma fala", () => {
  const origem = 1_700_000_000_000;      // t=0 da reunião (spawn da captura)
  const primeiraAmostra = origem + 300;  // o WAV nasce 300ms depois
  // uma fala que acontece 10s depois do t=0 da reunião:
  //   no WAV ela está em 9.700ms (o WAV começou 300ms depois)
  //   no microfone ela está a 4.000ms de um segmento que abriu em origem+6.000
  const pelaSistema = LM.sysBlockMs(primeiraAmostra, 9_700, origem, 0);
  const peloMic = LM.micBlockMs(origem + 6_000, 4_000, origem, 0);
  assert.strictEqual(pelaSistema, 10_000);
  assert.strictEqual(peloMic, 10_000);
});

test("sem âncora o sistema não some — cai no offset cru e segue", () => {
  const origem = 1_700_000_000_000;
  // sidecar antigo (sem a linha de âncora) ou primeira amostra ainda não relatada
  assert.strictEqual(LM.sysBlockMs(null, 9_700, origem, 0), 9_700);
  assert.strictEqual(LM.sysBlockMs(undefined, 5_000, origem, 1_000), 5_000);
});

test("retomar reancora e desconta a pausa das duas trilhas igualmente", () => {
  const origem = 1_700_000_000_000;
  // gravou 30s, ficou 20s pausada, retomou: o novo WAV nasce 50s depois do t=0,
  // mas na linha do tempo da reunião ele começa em 30s — a pausa não é tempo
  // gravado (ADR-0022 §19).
  const pausada = 20_000;
  assert.strictEqual(LM.sysBlockMs(origem + 50_000, 0, origem, pausada), 30_000);
  assert.strictEqual(LM.sysBlockMs(origem + 50_000, 4_000, origem, pausada), 34_000);
  assert.strictEqual(LM.micBlockMs(origem + 50_000, 4_000, origem, pausada), 34_000);
});

test("tempo nunca é negativo — um bloco antes do t=0 vai para o zero", () => {
  const origem = 1_700_000_000_000;
  // relógios de parede não são monotônicos: um ajuste de NTP durante a reunião
  // não pode produzir um timecode negativo (o sort key é u64 no backend)
  assert.strictEqual(LM.sysBlockMs(origem - 5_000, 0, origem, 0), 0);
  assert.strictEqual(LM.micBlockMs(origem - 5_000, 0, origem, 0), 0);
  // Sem origem não há o que derivar: devolver o epoch cru daria um timecode de
  // décadas. Degrada para o offset dentro do segmento — pequeno e inofensivo.
  assert.strictEqual(LM.micBlockMs(origem + 1_000, 500, null, 0), 500);
});

test("fala sem relação nenhuma não é sinalizada como vazamento", () => {
  const recent = [fala("Vamos fechar o orçamento da frota antes de sexta com o fornecedor novo.", 0, 8000, "system")];
  const novo = fala("Preciso revisar o contrato de manutenção da filial de Recife amanhã cedo.", 1000, 9000, "mic");
  assert.strictEqual(LM.partialCrossTalk(novo, recent), false);
});
