// i18n module — gettext-style: the pt-BR string in the code IS the msgid;
// EN holds the translations. Backend errors arrive as stable "err.*" codes.
const test = require("node:test");
const assert = require("node:assert");
const { t, tErr, setLang, getLang, EN, ERR_PT } = require("../src/i18n.js");

test("t returns the msgid itself in pt (source language)", () => {
  setLang("pt");
  assert.equal(t("configurações"), "configurações");
  assert.equal(t("string desconhecida"), "string desconhecida");
});

test("t translates to en and falls back to the msgid when missing", () => {
  setLang("en");
  assert.equal(t("configurações"), "settings");
  assert.equal(t("string sem tradução"), "string sem tradução");
  setLang("pt");
});

test("setLang normalizes unknown languages to pt", () => {
  setLang("fr");
  assert.equal(getLang(), "pt");
  setLang("en");
  assert.equal(getLang(), "en");
  setLang("pt");
});

test("tErr translates backend error codes in both languages", () => {
  setLang("pt");
  assert.equal(tErr("err.acervo_not_found"), "acervo não encontrado");
  setLang("en");
  assert.equal(tErr("err.acervo_not_found"), "knowledge base not found");
  setLang("pt");
});

test("tErr interpolates the detail after the first colon", () => {
  setLang("pt");
  assert.equal(
    tErr("err.model_not_found:/tmp/x.bin"),
    "modelo não encontrado: /tmp/x.bin"
  );
  // detail appended when the message has no {detail} placeholder
  assert.equal(tErr("err.invalid_name:abc"), "nome inválido: abc");
  setLang("pt");
});

test("tErr passes through unknown codes and plain messages", () => {
  setLang("pt");
  assert.equal(tErr("err.unknown_thing"), "err.unknown_thing");
  assert.equal(tErr("Operation not permitted (os error 1)"), "Operation not permitted (os error 1)");
  assert.equal(tErr(""), "");
});

test("ffmpeg error renders the platform install hint from the detail", () => {
  // o backend manda o comando certo do SO no detail, então a mesma mensagem
  // serve para macOS e Windows sem citar Homebrew no lugar errado
  setLang("pt");
  assert.equal(
    tErr("err.ffmpeg_not_found:winget install Gyan.FFmpeg"),
    "ffmpeg não encontrado. Instale (winget install Gyan.FFmpeg)."
  );
  setLang("en");
  assert.equal(
    tErr("err.ffmpeg_not_found:brew install ffmpeg"),
    "ffmpeg not found. Install it (brew install ffmpeg)."
  );
  setLang("pt");
});

test("every err code has both pt and en messages", () => {
  for (const key of Object.keys(ERR_PT)) {
    assert.ok(key.startsWith("err."), `${key} is not an err code`);
    assert.ok(EN[key], `missing EN message for ${key}`);
  }
});

// T-9 (#44) — todo msgid REALMENTE USADO no app tem par em inglês. A primeira
// versão deste teste iterava as chaves de EN e checava que os valores não eram
// vazios: isso valida a tabela contra si mesma e deixa passar exatamente o buraco
// que ele diz fechar — um t("string nova") sem entrada em EN.
const fs = require("node:fs");
const path = require("node:path");

function usedMsgids(file) {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
  const out = new Set();
  // t("literal") / t('literal') — só literais; t(variavel) não é verificável
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"\s*[,)]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*[,)]/g)) out.add(m[1]);
  return out;
}

// Débito pré-existente: 82 msgids já usados no app.js sem par em EN, anteriores a
// esta issue. Congelados aqui para o teste travar QUALQUER msgid novo sem par —
// que é o buraco que o T-9 existe para fechar — em vez de ficar vermelho por
// dívida velha. A lista só encolhe: ver a issue de i18n.
const SEM_PAR_CONHECIDOS = new Set([
  "## Resumo da mudança\\n\\n\\n## Contexto afetado\\n\\n\\n## Riscos e pendências\\n",
  "Adicionar um arquivo do computador aos anexos deste contexto",
  "Adicionar um arquivo do computador aos anexos deste tema",
  "Escrever uma nota nos anexos deste contexto",
  "Importar habilidade existente",
  "Nova habilidade (IA)",
  "Pedir à IA sobre esta habilidade",
  "Seu Nome\\nseu@email",
  "Trazer uma nota de reunião externa (Google Drive/Gemini) para os anexos deste tema",
  "a IA lê a habilidade e aplica o pedido nela mesma — evolui, não apaga.",
  "a pergunta roda no Claude do terminal (ADR-0012); a resposta aparece lá e nas notas da reunião.",
  "alvo",
  "analisar, ver relatório e enviar para a fila ficam disponíveis quando a reunião terminar — perguntar já funciona agora",
  "anexos",
  "aplica um pedido seu sobre este arquivo — evolui, não apaga.",
  "argumentos",
  "arquivo anexado",
  "arquivos anexados",
  "ações (usar, editar, pedir à IA, excluir)",
  "busca enviada ao agente do terminal",
  "buscar",
  "cole o conteúdo de uma skill (.md) que você já tem.",
  "comando enviado ao agente do terminal",
  "comentar",
  "comentar trecho",
  "comentário",
  "comentários",
  "commita as mudanças deste contexto numa branch rfc/… local.",
  "conteúdo",
  "criar",
  "crie um brainstorming primeiro",
  "descreva a habilidade",
  "descreva o que a habilidade deve fazer — a IA cria a skill; ela aparece na lateral quando terminar.",
  "descrição",
  "desgrifar",
  "do computador",
  "escreva um comentário",
  "escrever",
  "ex.: adicione um passo para validar o input",
  "ex.: preciso da sua ajuda com isso",
  "ex.: resume um ticket do Jira em 3 bullets",
  "ex.: resumo-jira",
  "excluir",
  "excluir esta habilidade?",
  "excluída",
  "executar",
  "executar habilidade",
  "executar habilidade…",
  "grifar",
  "grifo removido",
  "habilidade",
  "habilidade importada",
  "habilidade indisponível",
  "habilidade padrão",
  "habilidade padrão — não pode ser excluída",
  "importar",
  "importar skill existente",
  "informe",
  "informe o tema",
  "mostrar/ocultar as notas da reunião",
  "nada por aqui ainda",
  "nenhum anexo ainda",
  "nenhum brainstorming encontrado para",
  "nenhuma habilidade ainda — crie uma com IA ou importe uma pronta (＋)",
  "nenhuma habilidade disponível",
  "nenhuma nota ainda",
  "nenhuma reunião ainda",
  "nova habilidade (IA)",
  "não abri o link",
  "opcional",
  "padrão",
  "pedido enviado ao agente do terminal",
  "pedido enviado ao agente do terminal — a habilidade aparece na lateral",
  "pedir à IA",
  "preencha nome e conteúdo",
  "rodar",
  "sem comentários",
  "sincronizar",
  "tema",
  "trechos órfãos",
  "usar",
  "ver todos"
]);

test("nenhum msgid NOVO entra sem par em inglês", () => {
  const novos = [...usedMsgids("app.js")]
    .filter((k) => k && !k.startsWith("err.") && !(k in EN) && !SEM_PAR_CONHECIDOS.has(k))
    .sort();
  assert.deepStrictEqual(novos, [], "msgids novos sem par:\n  " + novos.join("\n  "));
});

test("a lista de débito só encolhe — nenhuma entrada dela ganhou par sem ser removida", () => {
  const jaTraduzidos = [...SEM_PAR_CONHECIDOS].filter((k) => k in EN).sort();
  assert.deepStrictEqual(jaTraduzidos, [],
    "traduzidos: tire-os de SEM_PAR_CONHECIDOS\n  " + jaTraduzidos.join("\n  "));
});

test("os msgids da move de reunião existem e têm par", () => {
  for (const k of ["Mover reunião", "movida", "mover para…", "destino", "mover"]) {
    assert.ok(EN[k] && EN[k].trim(), `sem par em inglês: ${k}`);
  }
});
