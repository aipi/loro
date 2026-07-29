// Loro — acervo instruction templates (context.md, AGENTS/CLAUDE, /brain-context
// skill, CODEOWNERS, PR template). Extracted from lib.rs for a cleaner core.
//
// Model: each domain lives in a single `context.md` (the official source of
// truth). Unconsolidated/contradictory/ambiguous knowledge is marked inline as
// HOTSPOTS inside that file — never as separate idea documents. Change proposals
// travel as a branch + Pull Request (the PR is the RFC); once approved they are
// merged into `context.md`. CODEOWNERS defines who approves each domain.

// Business-readable domain context (the final product, MARKDOWN).
// {{CONTEXT}} = context name. Section 6 (Hotspots) holds every not-yet-settled
// point (open questions, contradictions, ideas under study) as the evolution
// backlog of the domain. The lenses facts/thoughts/emotions/actions guide HOW
// the loop interprets material — they are not the file's structure.
pub const CONTEXT_TEMPLATE: &str = "# {{CONTEXT}} — contexto do domínio\n\n\
_Fonte oficial da verdade deste domínio (markdown, legível para negócio). Evolui por RFC (branch + PR) revisada pelos donos do contexto._\n\n\
## 1 · Visão geral\n\n(sem registros ainda)\n\n\
## 2 · Como funciona\n\n(sem registros ainda)\n\n\
## 3 · Fluxos principais\n\n(sem registros ainda)\n\n\
## 4 · Quem participa e sistemas\n\n(sem registros ainda)\n\n\
## 5 · Decisões e fatos\n\n(sem registros ainda)\n\n\
## 6 · Hotspots\n\n\
_Pontos de evolução ainda não consolidados — dúvidas em aberto, contradições entre fontes, temas ambíguos ou ideias em estudo. Cada hotspot é origem de reuniões, discussões e RFCs. Formato:_\n\n\
> [!HOTSPOT] título curto do ponto em aberto\n\
> O que está indefinido/contraditório e por quê.\n\n\
(sem registros ainda)\n";

pub const CONTEXT_TEMPLATE_EN: &str = "# {{CONTEXT}} — domain context\n\n\
_Official source of truth for this domain (business-readable markdown). It evolves via RFC (branch + PR) reviewed by the context owners._\n\n\
## 1 · Overview\n\n(no records yet)\n\n\
## 2 · How it works\n\n(no records yet)\n\n\
## 3 · Main flows\n\n(no records yet)\n\n\
## 4 · Who takes part & systems\n\n(no records yet)\n\n\
## 5 · Decisions & facts\n\n(no records yet)\n\n\
## 6 · Hotspots\n\n\
_Evolution points not yet consolidated — open questions, contradictions between sources, ambiguous topics or ideas under study. Each hotspot seeds meetings, discussions and RFCs. Format:_\n\n\
> [!HOTSPOT] short title of the open point\n\
> What is undefined/contradictory and why.\n\n\
(no records yet)\n";

pub fn brain_claude_template(contexts: &[String]) -> String {
    let list = contexts
        .iter()
        .map(|c| format!("- `{c}`"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"# Acervo de contextos — gerado pelo Loro

Este diretório é autocontido: guarda o conhecimento estruturado, as instruções
do loop (este arquivo) e a skill `/brain-context` (`.claude/commands/brain-context.md`).
Um loop do Claude lê a **fila de geração de contexto** (`inbox/`), estrutura e
arquiva por contexto. Tudo é local; não copie dados pessoais sensíveis para os
registros. (Fluxo do Loro: brainstorming → fila → contexto; esta skill é o passo
fila → contexto.)

## Contextos deste acervo
{list}

(a lista vive em `~/.loro/config.json`; gerencie pela aba "acervo" do Loro.
Contextos são **recursivos**: um domínio é uma pasta com `context.md` +
`CHANGELOG.md` que **pode conter subdomínios** — pastas-filhas na MESMA estrutura,
recursivamente (ex.: `frota/`, `frota/multas/`, `frota/eletrica/piloto/`). Cada
segmento é um slug minúsculo; a árvore vai até 6 níveis.)

## Estrutura (um arquivo por domínio)
- `inbox/` — entrada CRUA do loop: transcrições do Loro **ou qualquer texto/nota
  avulsa** (`.md`/`.txt`) que você soltar aqui · `processed/` — cruas já processadas
- `inbox/_prompt.md` — **guia opcional**: se existir, siga-o ANTES do processamento
  padrão (só afeta os itens pendentes)
- `reunioes/` — registro estruturado por reunião (markdown; fonte efêmera) ·
  `notas/` — registro estruturado de textos avulsos que não são reuniões
- `contextos/<c>/context.md` — **FONTE OFICIAL DA VERDADE**: o contexto do domínio
- `contextos/<c>/CHANGELOG.md` — histórico datado, append-only
- `contextos/<c>/<subdomínio>/` — subdomínio: MESMA estrutura (`context.md` +
  `CHANGELOG.md`), recursivamente. Um domínio grande vira pai-índice + subdomínios.
- `.github/CODEOWNERS` — dono(s) de cada contexto (quem aprova RFCs)
- `.github/pull_request_template.md` — o corpo da RFC (usado ao propor mudança)
- `INDEX.md` — navegação · `.brain/` — estado e atividade do loop

Regra geral: **tudo é markdown**; o conhecimento consolidado vive **só** no
`context.md`. Materiais de apoio (gravações, apresentações, docs de reunião) são
efêmeros: apenas referenciados, nunca a fonte da verdade.

## Tipos de contexto (domínio × prática)
Há duas naturezas — o loop escolhe o molde do `context.md` pelo caminho:
- **Domínio** (negócio: o *quê* — ex.: `frota`, `assinatura`): 6 seções de negócio.
- **Prática** (forma de trabalho: o *como* — tudo sob `engenharia/`): mesmas seções,
  descrevendo práticas/ferramentas/decisões técnicas.

## Hotspots (em vez de documentos de ideia)
Ideias **não** viram arquivos soltos. Todo conteúdo ainda não consolidado —
dúvida em aberto, contradição entre fontes, tema ambíguo, ideia em estudo — é
registrado como **hotspot** dentro da seção 6 do `context.md`, no formato:

> [!HOTSPOT] título curto
> O que está em aberto e por quê.

Os hotspots são o backlog de evolução do domínio: origem de reuniões, discussões
e RFCs. Uma ideia só é **promovida** a fato (seções 1–5) via RFC aprovada.

## Ideia = RFC = branch + PR (evolução do conhecimento)
Uma proposta de mudança **não** é um documento: é uma RFC materializada como uma
branch + Pull Request. A mudança é aplicada direto no `context.md` (+ CHANGELOG);
o PR (título/corpo pelo `pull_request_template.md`) **é** a RFC. Os donos do
contexto (`CODEOWNERS`) revisam e aprovam; ao fazer merge na `main`, a proposta
vira a nova fonte oficial da verdade. Você (loop) NÃO abre PRs — quem versiona e
propõe é a pessoa, pelos botões "Versionar" e "Propor mudança" do Loro.

## Como interpretar o material (as quatro lentes)
Ao ler cada fonte, separe **fatos** (concreto/decidido → seções 1–5),
**pensamentos** (hipóteses/dúvidas → hotspots), **emoções** (sentimento do grupo:
tensões, riscos percebidos) e **ações** (o que fazer, com responsável e prazo).
Isso guia PARA ONDE cada coisa vai — não é a estrutura de saída. Participantes são
descritos por **arquétipo** (produto, negócio, engenharia), não por área.

## O produto final (`contextos/<c>/context.md`)
Markdown **acessível para negócio** (sem jargão técnico/DDD), com 6 seções fixas:
1 Visão geral · 2 Como funciona · 3 Fluxos principais · 4 Quem participa e
sistemas · 5 Decisões e fatos · 6 Hotspots. Mantenha os títulos; sem informação,
use `(sem registros ainda)`. Consolidado derivado do CHANGELOG + fontes (seguro
reescrever seções 1–5; fontes são efêmeras). O que não estiver consolidado vira
hotspot, nunca é inventado como fato.

## Estilo (IMPORTANTE)
Prosa de documentação — parágrafos claros e completos — e não bullets soltos
(tabelas e listas curtas são bem-vindas quando estruturam melhor). Entrada de
CHANGELOG: `## AAAA-MM-DD — <título>` + 1–3 parágrafos. **NÃO referencie o arquivo
de reunião** (fonte efêmera, não versionada); escreva de forma autossuficiente.

**Escrita objetiva do NEGÓCIO (regra dura).** O documento descreve o **domínio**,
nunca o processo. NÃO cite metodologia nem mecânica interna do acervo (DDD,
"reestruturação/quebra/separação/migração", "varredura/pull fresh", "conector",
"gerado a partir de Jira/Confluence/Slack", "não de um `context.md` anterior").
Evite **desambiguação por negação** ("não é um X", "não confundir com", "apesar do
nome"): afirme o que a coisa é. Dúvida real de negócio vira **hotspot curto** (§6),
não narração no corpo. O CHANGELOG registra a evolução do **conhecimento/decisões
do domínio**, não a ferramenta nem o passo de reestruturação.

## Regras do loop
0. **Guia opcional:** se `inbox/_prompt.md` existir, leia e siga-o ANTES de tudo.
1. Processar apenas arquivos novos de `inbox/` (fora de `.brain/state.json`).
   Aceita qualquer arquivo legível. Ignore `inbox/_prompt.md`.
2. **Direcionamento explícito:** arquivo com nome `<contexto>--<nome>` pertence
   àquele contexto — respeite. Sem prefixo, classifique pelo conteúdo. Se nenhum
   contexto existente couber, **sugira criar um novo** (não force o encaixe).
3. Classificar a origem: reunião → `reunioes/`; documento/nota → `notas/`. Gerar
   o registro estruturado em markdown.
4. **Append-only** no CHANGELOG. Conhecimento consolidado atualiza `context.md`
   (seções 1–5); o não-consolidado vira **hotspot** (seção 6). Nunca crie arquivos
   de ideia. Cru movido p/ `processed/`, nunca apagado.
5. Regenerar o `context.md` dos contextos tocados (6 seções). Use as lentes só
   para INTERPRETAR.
6. Atualizar `INDEX.md`, `state.json` e `.brain/activity.log`. Idempotente; na
   dúvida de contexto, NÃO assuma: registre a incerteza como hotspot com `?`
   e só destine o item quando a evidência for clara.
7. **Quebra em subdomínios (DDD):** quando um domínio virar um COMPOSTO de
   bounded contexts (vários fluxos/fronteiras distintos), quebre-o em subdomínios
   `contextos/<c>/<sub>/` — cada um com seu `context.md` + `CHANGELOG.md`. O
   `context.md` do PAI vira overview + índice dos subdomínios + fatos transversais;
   o detalhe desce para os filhos. Fixe a "casa canônica" de temas transversais
   (ex.: multas) num só subdomínio e trate os demais como sobreposição.

## Respeite a estrutura existente
Se o acervo/contexto já tem estrutura própria (arquivos, subpastas), **entenda e
respeite** — só complete o que faltar, nunca sobrescreva o que já existe. Loro é
um **companheiro** do seu fluxo/agentes, não os substitui.
"#
    )
}

// /brain-context skill written INSIDE the acervo (the directory is self-contained).
// ADR-0013: it is the queue → context step of the brainstorming → queue → context flow.
pub const BRAIN_SKILL: &str = r#"---
description: Gera contexto a partir da fila (inbox) — reuniões, relatórios e textos viram context.md + CHANGELOG.md
---

Você é o curador deste acervo de conhecimento. Leia `AGENTS.md` (ou `CLAUDE.md`)
na raiz do acervo — ele define estrutura, estilo, a fonte oficial da verdade
(`context.md`), os hotspots e as regras — e siga-o à risca. Trabalhe somente
dentro desta pasta.

0. Se `inbox/_prompt.md` existir, siga-o ANTES do processamento padrão. Ao
   terminar, **arquive-o** em `.brain/prompt-history/<AAAA-MM-DD-HHMM>.md` e
   **remova** `inbox/_prompt.md` (o histórico não é versionado).
1. Leia `.brain/state.json`; liste `inbox/` e filtre o que ainda não foi processado (ignore `_prompt.md`).
2. Nada novo? Responda `brain: nada novo` e encerre.
3. Para cada arquivo novo: se o nome tiver prefixo `<contexto>--`, direcione
   àquele contexto (pode ser hierárquico `area/sub`); senão classifique pelo
   conteúdo — e se nenhum contexto existente couber, **sugira criar um novo**.
   Classifique a origem (reunião × documento/nota), gere o registro em `reunioes/`
   ou `notas/`, acrescente entrada em prosa no `contextos/<c>/CHANGELOG.md`, e
   **atualize o `contextos/<c>/context.md`**: o consolidado nas seções 1–5, o que
   ainda estiver em aberto/contraditório como **hotspot** na seção 6. Nunca crie
   arquivos de ideia. **Nunca referencie o arquivo de reunião** (fonte efêmera).
   Se o domínio virar um COMPOSTO (DDD), quebre em subdomínios
   `contextos/<c>/<sub>/` (mesma estrutura, recursiva); o pai vira overview+índice.
4. Mova o cru para `processed/`, atualize `state.json`, anexe em
   `.brain/activity.log` e atualize `INDEX.md`.
5. Respeite estrutura já existente (só complete lacunas; nunca sobrescreva). Não
   abra PRs nem versione: quem propõe mudança é a pessoa, pelos botões do Loro.
6. Ao final, informe em 1–2 linhas o que fez.

Regras de rigor (ADR-0002 §5):
- **Nunca assuma premissas** não declaradas. O que não estiver na base ou no
  pedido é incerteza: registre-a explicitamente (hotspot/`?` ou uma linha de
  "incertezas" na resposta) e, quando a interação permitir, pergunte.
- **Varredura eficiente:** para listar/ler muitos arquivos, delegue a leitura a
  subagentes (Task) com um modelo rápido (ex.: Haiku), recebendo só o essencial;
  reserve o modelo principal para a síntese.
"#;

// ---- English variants (selected by the project language) ----

pub fn agents_template_en(contexts: &[String]) -> String {
    let list = contexts
        .iter()
        .map(|c| format!("- `{c}`"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"# Knowledge base — generated by Loro

This directory is self-contained: it holds the structured knowledge, the loop
instructions (this file) and the `/brain-context` skill
(`.claude/commands/brain-context.md`). A Claude loop reads the **context-generation
queue** (`inbox/`), structures it and files it by context. Everything is local; do
not copy sensitive personal data into the records. (Loro's flow: brainstorming →
queue → context; this skill is the queue → context step.)

## Contexts in this base
{list}

(the list lives in `~/.loro/config.json`; manage it from Loro's "acervo" tab.
Contexts are **recursive**: a domain is a folder with `context.md` + `CHANGELOG.md`
that **may contain subdomains** — child folders in the SAME shape, recursively
(e.g. `frota/`, `frota/multas/`, `frota/eletrica/piloto/`). Each segment is a
lowercase slug; the tree goes up to 6 levels.)

## Structure (one file per domain)
- `inbox/` — raw loop input (Loro transcripts or any dropped `.md`/`.txt`) ·
  `processed/` — raw already processed
- `inbox/_prompt.md` — **optional guide**: if present, follow it BEFORE the default
  processing (affects only the pending items); archive & clear it after the run
- `reunioes/` — structured record per meeting (ephemeral source) · `notas/` —
  structured record for standalone notes
- `contextos/<c>/context.md` — **OFFICIAL SOURCE OF TRUTH**: the domain context
- `contextos/<c>/CHANGELOG.md` — dated history, append-only
- `contextos/<c>/<subdomain>/` — subdomain: SAME shape (`context.md` +
  `CHANGELOG.md`), recursively. A large domain becomes a parent-index + subdomains.
- `.github/CODEOWNERS` — owner(s) of each context (who approves RFCs)
- `.github/pull_request_template.md` — the RFC body (used when proposing a change)

Consolidated knowledge lives **only** in `context.md`. Supporting material
(recordings, decks, meeting docs) is ephemeral: referenced, never the truth.

## Hotspots (instead of idea documents)
Ideas are **not** loose files. Anything not yet consolidated — open question,
contradiction between sources, ambiguous topic, idea under study — is recorded as
a **hotspot** inside section 6 of `context.md`:

> [!HOTSPOT] short title
> What is open and why.

Hotspots are the domain's evolution backlog: they seed meetings, discussions and
RFCs. An idea is only **promoted** to fact (sections 1–5) via an approved RFC.

## Idea = RFC = branch + PR
A change proposal is **not** a document: it is an RFC materialized as a branch +
Pull Request. The change is applied directly to `context.md` (+ CHANGELOG); the PR
(title/body from `pull_request_template.md`) **is** the RFC. The context owners
(`CODEOWNERS`) review and approve; merging into `main` makes it the new source of
truth. You (the loop) do NOT open PRs — the person versions and proposes via
Loro's "Versionar" and "Propor mudança" buttons.

## Interpretation lens (facts / thoughts / emotions / actions)
Read each source separating facts (concrete/decided → sections 1–5), thoughts
(hypotheses/open questions → hotspots), emotions (group sentiment/risks) and
actions (owner + deadline). This guides WHERE things go. Describe participants by
**archetype** (product, business, engineering), not by department.

## Final product (`contextos/<c>/context.md`)
Business-readable markdown (no DDD jargon), 6 fixed sections: Overview · How it
works · Main flows · Who takes part & systems · Decisions & facts · Hotspots.
Keep the titles; with no info use `(no records yet)`. Never invent facts —
unconsolidated material becomes a hotspot.

**Objective BUSINESS writing (hard rule).** Describe the **domain**, never the
process. Do not cite methodology or acervo internals (DDD, "restructuring/split/
migration", "fresh sweep/pull", "connector", "generated from Jira/Confluence/Slack",
"not from a prior `context.md`"). Avoid **disambiguation-by-negation** ("it is not
an X", "not to be confused with", "despite the name"): state what the thing is. A
real business open question becomes a short **hotspot** (§6), not body narration.
The CHANGELOG records the evolution of the domain's **knowledge/decisions**, not
the tooling or the restructuring step.

## Loop rules
0. If `inbox/_prompt.md` exists, follow it first; then archive it to
   `.brain/prompt-history/` and remove it (not versioned).
1. Process only new files in `inbox/` (ignore `_prompt.md`).
2. `<context>--name` prefix routes a file to that context. With no fitting
   context, **suggest creating a new one** — do not force the fit.
3. Meeting transcript -> `reunioes/`; note/document -> `notas/`.
4. Append-only CHANGELOG; consolidated knowledge updates `context.md` (1–5),
   the rest becomes a **hotspot** (section 6). Never create idea files. Raw moved
   to `processed/`, never deleted.
5. Regenerate the touched `context.md` (6 sections).
6. Update `INDEX.md`, `state.json`, `.brain/activity.log`. Idempotent; when in
   doubt about the context, do NOT assume: record the uncertainty as a `?`
   hotspot and only file the item when the evidence is clear.
7. **Split into subdomains (DDD):** when a domain becomes a COMPOSITE of bounded
   contexts, split it into `contextos/<c>/<sub>/` subdomains — each with its own
   `context.md` + `CHANGELOG.md`. The PARENT `context.md` becomes an overview +
   index of its subdomains + cross-cutting facts; detail moves down. Pin the
   canonical home of a cross-cutting topic (e.g. fines) to one subdomain.

## Respect existing structure
If a base/context already has its own structure, understand and respect it — only
fill gaps, never overwrite. Loro is a **companion** to your workflow/agents.
"#
    )
}

pub const BRAIN_SKILL_EN: &str = r#"---
description: Generates context from the queue (inbox) — meetings, reports and notes become context.md + CHANGELOG.md
---

You are the curator of this knowledge base. Read `AGENTS.md` (or `CLAUDE.md`) at
the base root — it defines the structure, style, source of truth (`context.md`),
hotspots and rules — and follow it strictly. Work only inside this folder.

0. If `inbox/_prompt.md` exists, follow it BEFORE default processing; then archive
   it to `.brain/prompt-history/<YYYY-MM-DD-HHMM>.md` and remove it (not versioned).
1. Read `.brain/state.json`; list `inbox/` and filter unprocessed (ignore `_prompt.md`).
2. Nothing new? Reply `brain: nothing new` and stop.
3. For each new file: honor a `<context>--` prefix; else classify by content, and
   if no existing context fits, **suggest creating a new one**. Classify (meeting
   vs note), write the structured record in `reunioes/` or `notas/`, append a prose
   entry to `contextos/<c>/CHANGELOG.md`, and **update `contextos/<c>/context.md`**:
   consolidated knowledge in sections 1–5, anything still open/contradictory as a
   **hotspot** in section 6. Never create idea files. **Never reference the meeting
   file** (ephemeral, unversioned). If the domain becomes a COMPOSITE (DDD), split
   it into `contextos/<c>/<sub>/` subdomains (same recursive shape); the parent
   becomes an overview + index.
4. Move raw to `processed/`, update `state.json`, append to `.brain/activity.log`,
   update `INDEX.md`.
5. Respect existing structure (fill gaps only; never overwrite). Do not open PRs
   or version: the person proposes changes via Loro's buttons.
6. Finish with a 1–2 line summary of what you did.

Rigor rules (ADR-0002 §5):
- **Never assume unstated premises.** Anything not in the base or in the request
  is an uncertainty: record it explicitly (hotspot/`?` or an "uncertainties"
  line in the answer) and, when the interaction allows, ask.
- **Efficient scanning:** to list/read many files, delegate reading to subagents
  (Task) on a fast model (e.g. Haiku) returning only the essentials; keep the
  main model for synthesis.
"#;

// ---- meeting-AI skills run by the terminal Claude (ADR-0012) ----
//
// The meeting AI is NOT a Rust model spawn: it is a Claude Code skill the
// terminal-resident Claude runs (the /brain pattern). The app injects the
// invocation into the terminal PTY; the skill READS the meeting's live stream
// (reuniao.md + manifest.json + relevant contextos/) and responds. It uses
// Claude Code's own Read/Write tools (no loro IPC) and MUST NOT edit
// manifest.json — the app owns it with an atomic writer (ADR-0012), and editing
// it here would race that writer. `$ARGUMENTS` carries the meeting directory
// (acervo-relative), so the skills render with a meeting-dir placeholder.

pub const MEETING_ANALYSE_SKILL: &str = r#"---
description: Analisa a reunião ao vivo e escreve investigação + relatório objetivos (ADR-0012)
argument-hint: <dir-da-reuniao>
---

Diretório da reunião (relativo à raiz do acervo): `$ARGUMENTS`

Você é o analista de reunião do Loro (ADR-0012). Trabalhe SOMENTE dentro do
diretório acima. Use apenas suas próprias ferramentas Read/Write — não chame IPC
do loro e NÃO edite `manifest.json` (o app é o dono e o escreve de forma atômica;
editar aqui geraria corrida com esse escritor).

1. **Investigue PRIMEIRO no contexto LOCAL.** Leia `$ARGUMENTS/reuniao.md` (a
   transcrição AO VIVO, que cresce durante a reunião), `$ARGUMENTS/manifest.json`
   (metadados + marcadores sem PII) e o(s) `contextos/<c>/context.md` claramente
   relevante(s) — a base de conhecimento LOCAL é sempre a primeira fonte. Não leia
   a transcrição de outra reunião nem notas em `brainstorming/` para as quais você
   não foi apontado (BR-8).
2. **SOMENTE DEPOIS** de esgotar o que a base local oferece, se ainda faltar
   evidência, você PODE buscar em fontes externas (internet, MCP, qualquer lugar).
   Deixe claro no resultado o que veio da base local e o que veio de fora.
3. Produza, de forma OBJETIVA (prosa de negócio, sem metodologia): tema
   predominante, decisões, riscos, inconsistências e perguntas sugeridas.
4. Escreva o resultado em `$ARGUMENTS/artefatos/investigacoes/analise-<ISO>.md`
   (carimbo ISO 8601 em UTC, ex.: `analise-2026-07-27T1430Z.md`).
5. Registre estatísticas SEM PII: para cada dúvida/decisão/investigação/pergunta
   identificada, acrescente UMA linha JSON em `$ARGUMENTS/marcadores.jsonl` no
   formato `{"tipo":"decisao","ref":"artefatos/investigacoes/analise-<ISO>.md"}`
   (só `tipo` + `t_ms?`/`ref?`, NUNCA texto de transcrição). O app incorpora esses
   marcadores ao relatório — não edite `manifest.json`.
6. Atualize `$ARGUMENTS/relatorio.md`: substitua a prosa provisória das seções
   `## Resumo`, `## Decisões` e `## Dúvidas & Respostas` (ou suas equivalentes em
   inglês: `## Summary`, `## Decisions`, `## Questions & Answers` — o notebook
   pode ter nascido em qualquer um dos dois idiomas) por prosa real e objetiva
   derivada da transcrição, mantendo os títulos existentes. Se `relatorio.md`
   ainda não existir, crie-o com essas seções no idioma deste skill.
7. Acrescente UMA linha JSON, orientada a evento, em `$ARGUMENTS/auditoria.jsonl`
   registrando o que leu e produziu — nunca texto de transcrição, PII ou segredos
   (BR-8/BR-9), ex.:
   `{"em":"<ISO>","event":"analyse","read":["reuniao.md","manifest.json"],"wrote":["artefatos/investigacoes/analise-<ISO>.md","relatorio.md","marcadores.jsonl"]}`.

Ao final, responda em pt-BR com 1–2 linhas do que você escreveu.

Regras de rigor (ADR-0002 §5):
- **Nunca assuma premissas** não declaradas. O que não estiver na base ou no
  pedido é incerteza: registre-a explicitamente (hotspot/`?` ou uma linha de
  "incertezas" na resposta) e, quando a interação permitir, pergunte.
- **Varredura eficiente:** para listar/ler muitos arquivos, delegue a leitura a
  subagentes (Task) com um modelo rápido (ex.: Haiku), recebendo só o essencial;
  reserve o modelo principal para a síntese.
"#;

pub const MEETING_ANSWER_SKILL: &str = r#"---
description: Responde de forma objetiva a uma pergunta sobre a reunião ao vivo (ADR-0012)
argument-hint: <dir-da-reuniao> <pergunta>
---

Argumentos: `$ARGUMENTS`
O PRIMEIRO token é o diretório da reunião (relativo à raiz do acervo); o RESTANTE
é a pergunta.

Você é o assistente de reunião do Loro (ADR-0012). Trabalhe SOMENTE dentro desse
diretório. Use apenas suas próprias ferramentas Read/Write — não chame IPC do loro
e NÃO edite `manifest.json` (o app é o dono; editar aqui geraria corrida com o
escritor atômico).

1. **Investigue PRIMEIRO no contexto LOCAL:** leia `<dir>/reuniao.md` (a
   transcrição AO VIVO), `<dir>/manifest.json` e o(s) `contextos/<c>/context.md`
   claramente relevante(s) — a base LOCAL é sempre a primeira fonte. Não leia a
   transcrição de outra reunião nem notas em `brainstorming/` para as quais não foi
   apontado (BR-8).
2. Responda à pergunta de forma OBJETIVA, ancorada no que a reunião e a base local
   de fato dizem. **SOMENTE DEPOIS** de esgotar a base local, se ainda faltar
   evidência, você PODE buscar em fontes externas (internet, MCP, qualquer lugar) —
   deixando claro o que veio de fora. Se nada resolver, diga isso claramente.
3. Quando um artefato escrito ajudar (uma tabela, uma nota curta), escreva-o em
   `<dir>/artefatos/respostas/<slug>.md` e referencie-o na resposta.
4. Acrescente UMA linha JSON sem PII em `<dir>/auditoria.jsonl` (evento `answer`,
   o que leu/produziu — nunca texto de transcrição, PII ou segredos: BR-8/BR-9).

Responda em pt-BR.

Regras de rigor (ADR-0002 §5):
- **Nunca assuma premissas** não declaradas. O que não estiver na base ou no
  pedido é incerteza: registre-a explicitamente (hotspot/`?` ou uma linha de
  "incertezas" na resposta) e, quando a interação permitir, pergunte.
- **Varredura eficiente:** para listar/ler muitos arquivos, delegue a leitura a
  subagentes (Task) com um modelo rápido (ex.: Haiku), recebendo só o essencial;
  reserve o modelo principal para a síntese.
"#;

pub const MEETING_ANALYSE_SKILL_EN: &str = r#"---
description: Analyses the live meeting and writes an objective investigation + report (ADR-0012)
argument-hint: <meeting-dir>
---

Meeting directory (relative to the acervo root): `$ARGUMENTS`

You are Loro's meeting analyst (ADR-0012). Work ONLY inside the directory above.
Use only your own Read/Write tools — do not call loro IPC and do NOT edit
`manifest.json` (the app owns it and writes it atomically; editing it here would
race that writer).

1. **Investigate the LOCAL context FIRST.** Read `$ARGUMENTS/reuniao.md` (the LIVE
   transcript, accreting during the meeting), `$ARGUMENTS/manifest.json` (metadata
   + PII-free markers) and the clearly relevant `contextos/<c>/context.md` — the
   LOCAL knowledge base is always the first source. Do not read any other meeting's
   transcript or `brainstorming/` notes you were not pointed at (BR-8).
2. **ONLY AFTER** exhausting the local base, if evidence is still missing, you MAY
   search external sources (internet, MCP, anywhere). Make clear what came from the
   local base and what came from outside.
3. Produce, OBJECTIVELY (business prose, no methodology talk): predominant theme,
   decisions, risks, inconsistencies and suggested questions.
4. Write the result to `$ARGUMENTS/artefatos/investigacoes/analise-<ISO>.md`
   (ISO 8601 UTC stamp, e.g. `analise-2026-07-27T1430Z.md`).
5. Record PII-free stats: for each doubt/decision/investigation/question, append
   ONE JSON line to `$ARGUMENTS/marcadores.jsonl` like
   `{"tipo":"decisao","ref":"artefatos/investigacoes/analise-<ISO>.md"}` (only
   `tipo` + `t_ms?`/`ref?`, NEVER transcript text). The app folds these markers
   into the report — do not edit `manifest.json`.
6. Update `$ARGUMENTS/relatorio.md`: replace the placeholder prose in the
   `## Summary`, `## Decisions` and `## Questions & Answers` sections (or their
   pt equivalents `## Resumo`, `## Decisões`, `## Dúvidas & Respostas` — the
   notebook may have been born in either language) with real, objective prose
   derived from the transcript, keeping the existing titles. If `relatorio.md`
   does not exist yet, create it with those sections in this skill's language.
7. Append ONE event-oriented JSON line to `$ARGUMENTS/auditoria.jsonl` recording
   what you read and produced — never transcript text, PII or secrets (BR-8/BR-9).

Finish with a 1–2 line summary (in English) of what you wrote.

Rigor rules (ADR-0002 §5):
- **Never assume unstated premises.** Anything not in the base or in the request
  is an uncertainty: record it explicitly (hotspot/`?` or an "uncertainties"
  line in the answer) and, when the interaction allows, ask.
- **Efficient scanning:** to list/read many files, delegate reading to subagents
  (Task) on a fast model (e.g. Haiku) returning only the essentials; keep the
  main model for synthesis.
"#;

pub const MEETING_ANSWER_SKILL_EN: &str = r#"---
description: Answers a question about the live meeting objectively (ADR-0012)
argument-hint: <meeting-dir> <question>
---

Arguments: `$ARGUMENTS`
The FIRST token is the meeting directory (relative to the acervo root); the REST
is the question.

You are Loro's meeting assistant (ADR-0012). Work ONLY inside that directory. Use
only your own Read/Write tools — do not call loro IPC and do NOT edit
`manifest.json` (the app owns it; editing here would race the atomic writer).

1. **Investigate the LOCAL context FIRST:** read `<dir>/reuniao.md` (the LIVE
   transcript), `<dir>/manifest.json` and the clearly relevant
   `contextos/<c>/context.md` — the LOCAL base is always the first source. Do not
   read another meeting's transcript or `brainstorming/` notes you were not pointed
   at (BR-8).
2. Answer the question OBJECTIVELY, grounded in what the meeting and the local base
   actually say. **ONLY AFTER** exhausting the local base, if evidence is still
   missing, you MAY search external sources (internet, MCP, anywhere), making clear
   what came from outside. If nothing settles it, say so plainly.
3. When a written artifact helps (a table, a short note), write it under
   `<dir>/artefatos/respostas/<slug>.md` and reference it from the answer.
4. Append ONE PII-free JSON line to `<dir>/auditoria.jsonl` (event `answer`, what
   you read/produced — never transcript text, PII or secrets: BR-8/BR-9).

Reply in English.

Rigor rules (ADR-0002 §5):
- **Never assume unstated premises.** Anything not in the base or in the request
  is an uncertainty: record it explicitly (hotspot/`?` or an "uncertainties"
  line in the answer) and, when the interaction allows, ask.
- **Efficient scanning:** to list/read many files, delegate reading to subagents
  (Task) on a fast model (e.g. Haiku) returning only the essentials; keep the
  main model for synthesis.
"#;

pub fn meeting_analyse_skill(lang: &str) -> &'static str {
    if lang == "en" {
        MEETING_ANALYSE_SKILL_EN
    } else {
        MEETING_ANALYSE_SKILL
    }
}
pub fn meeting_answer_skill(lang: &str) -> &'static str {
    if lang == "en" {
        MEETING_ANSWER_SKILL_EN
    } else {
        MEETING_ANSWER_SKILL
    }
}

// ---- general Q&A over the knowledge base (ADR-0013) ----
//
// `/brain-ask` answers ANY question from the acervo's versioned contexts (the local
// knowledge base) FIRST, and only after that may use MCP connectors / external
// search — the same local-first rule as the meeting AI. It is not meeting-scoped and
// writes nothing: the answer appears in the terminal. Same terminal-Claude skill
// pattern as /brain-context and /brain-analyse.
pub const BRAIN_ASK_SKILL: &str = r#"---
description: Responde uma dúvida a partir dos contextos do acervo (base local) e, se preciso, MCP/externo
argument-hint: <pergunta>
---

Pergunta: `$ARGUMENTS`

Você é o consultor deste acervo. Responda a pergunta de forma OBJETIVA (prosa de
negócio, sem metodologia).

1. **Investigue PRIMEIRO no contexto LOCAL.** Leia os `contextos/<c>/context.md`
   relevantes — a FONTE OFICIAL DA VERDADE do negócio — escolhendo os contextos pelo
   tema da pergunta; consulte o `CHANGELOG.md` do contexto quando ajudar. A base
   local é sempre a primeira fonte.
2. **SOMENTE DEPOIS**, se a base local não resolver, você PODE usar os conectores
   MCP disponíveis ou uma busca externa — deixando claro o que veio de fora.
3. Responda citando quais contextos embasaram a resposta (ex.: `contextos/frota`).
   Se a base não resolver, diga isso claramente e aponte o hotspot (§6) relevante,
   se houver — uma dúvida em aberto é um bom candidato a virar reunião/RFC.

Não modifique arquivos (isto é uma consulta). Responda em pt-BR.

Regras de rigor (ADR-0002 §5):
- **Nunca assuma premissas** não declaradas. O que não estiver na base ou no
  pedido é incerteza: registre-a explicitamente (hotspot/`?` ou uma linha de
  "incertezas" na resposta) e, quando a interação permitir, pergunte.
- **Varredura eficiente:** para listar/ler muitos arquivos, delegue a leitura a
  subagentes (Task) com um modelo rápido (ex.: Haiku), recebendo só o essencial;
  reserve o modelo principal para a síntese.
"#;

pub const BRAIN_ASK_SKILL_EN: &str = r#"---
description: Answers a question from the acervo's contexts (local base) and, if needed, MCP/external
argument-hint: <question>
---

Question: `$ARGUMENTS`

You are this acervo's consultant. Answer OBJECTIVELY (business prose, no methodology).

1. **Investigate the LOCAL context FIRST.** Read the relevant `contextos/<c>/context.md`
   — the business SOURCE OF TRUTH — choosing contexts by the question's topic; consult
   the context `CHANGELOG.md` when it helps. The local base is always the first source.
2. **ONLY AFTER**, if the local base does not settle it, you MAY use the available
   MCP connectors or an external search — making clear what came from outside.
3. Answer citing which contexts grounded it (e.g. `contextos/frota`). If the base does
   not settle it, say so plainly and point at the relevant hotspot (§6) if any.

Do not modify files (this is a query). Reply in English.

Rigor rules (ADR-0002 §5):
- **Never assume unstated premises.** Anything not in the base or in the request
  is an uncertainty: record it explicitly (hotspot/`?` or an "uncertainties"
  line in the answer) and, when the interaction allows, ask.
- **Efficient scanning:** to list/read many files, delegate reading to subagents
  (Task) on a fast model (e.g. Haiku) returning only the essentials; keep the
  main model for synthesis.
"#;

pub fn brain_ask_skill(lang: &str) -> &'static str {
    if lang == "en" {
        BRAIN_ASK_SKILL_EN
    } else {
        BRAIN_ASK_SKILL
    }
}

// ---- CODEOWNERS (who approves changes per context/domain) ----
// Generated commented so an unfilled file never blocks GitHub's owner checks;
// the user uncomments and fills @user / @org/team per context. Approval itself
// happens on GitHub (branch protection); Loro only reads the resulting status.
pub fn codeowners_template(contexts: &[String], lang: &str) -> String {
    let header = if lang == "en" {
        "# CODEOWNERS — who approves changes to each context (domain).\n\
# Each line maps a context folder to its owner(s) on GitHub; only they can\n\
# approve PRs (RFCs) touching that folder. Uncomment and set @user or @org/team.\n\n"
    } else {
        "# CODEOWNERS — quem aprova mudanças em cada contexto (domínio).\n\
# Cada linha mapeia uma pasta de contexto ao(s) seu(s) dono(s) no GitHub; só eles\n\
# podem aprovar PRs (RFCs) que tocam aquela pasta. Descomente e defina @usuario ou @org/time.\n\n"
    };
    let lines = contexts
        .iter()
        .map(|c| format!("# /contextos/{c}/    @owner"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{header}{lines}\n")
}

// ---- Pull Request template = the RFC body ----
pub const PR_TEMPLATE: &str = r#"## Resumo da mudança
<!-- O que muda e por quê, em 1–2 frases. -->

## Contexto afetado
<!-- Qual domínio/pasta (ex.: contextos/frota). -->

## O que muda no conhecimento
<!-- As alterações no context.md (seções 1–5). -->

## Entrada de CHANGELOG
<!-- A entrada datada correspondente (## AAAA-MM-DD — título). -->

## Hotspots
<!-- Hotspots resolvidos e/ou criados por esta mudança. -->

## Riscos e pendências
<!-- O que ainda fica em aberto. -->
"#;

pub const PR_TEMPLATE_EN: &str = r#"## Change summary
<!-- What changes and why, in 1–2 sentences. -->

## Affected context
<!-- Which domain/folder (e.g. contextos/frota). -->

## What changes in the knowledge
<!-- The edits to context.md (sections 1–5). -->

## CHANGELOG entry
<!-- The matching dated entry (## YYYY-MM-DD — title). -->

## Hotspots
<!-- Hotspots resolved and/or created by this change. -->

## Risks and open points
<!-- What remains open. -->
"#;

// ---- language selectors ----
pub fn context_template(lang: &str) -> &'static str {
    if lang == "en" {
        CONTEXT_TEMPLATE_EN
    } else {
        CONTEXT_TEMPLATE
    }
}
pub fn agents_template(contexts: &[String], lang: &str) -> String {
    if lang == "en" {
        agents_template_en(contexts)
    } else {
        brain_claude_template(contexts)
    }
}
pub fn brain_skill(lang: &str) -> &'static str {
    if lang == "en" {
        BRAIN_SKILL_EN
    } else {
        BRAIN_SKILL
    }
}
pub fn pr_template(lang: &str) -> &'static str {
    if lang == "en" {
        PR_TEMPLATE_EN
    } else {
        PR_TEMPLATE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ADR-0002 §5 — every skill forbids unstated premises and instructs
    // fast-model subagent scanning for bulk file reading, in both languages.
    #[test]
    fn skills_forbid_assumptions_and_instruct_fast_scanning() {
        for lang in ["pt", "en"] {
            let (no_assume, fast) = if lang == "en" {
                ("Never assume unstated premises", "fast model")
            } else {
                ("Nunca assuma premissas", "modelo rápido")
            };
            for (name, body) in [
                ("brain", brain_skill(lang)),
                ("ask", brain_ask_skill(lang)),
                ("analyse", meeting_analyse_skill(lang)),
                ("answer", meeting_answer_skill(lang)),
            ] {
                assert!(
                    body.contains(no_assume),
                    "{name}/{lang}: missing no-premise rule"
                );
                assert!(
                    body.contains(fast),
                    "{name}/{lang}: missing fast-scanning rule"
                );
            }
        }
    }

    // ADR-0002 §5 — the loop's rule 6 records doubt instead of guessing.
    #[test]
    fn agents_rule_records_doubt_instead_of_guessing() {
        let pt = agents_template(&["frota".into()], "pt");
        assert!(!pt.contains("escolher o mais provável"));
        assert!(pt.contains("NÃO assuma"));
        let en = agents_template(&["fleet".into()], "en");
        assert!(en.contains("do NOT assume"));
    }

    // ADR-0012: the terminal Claude runs `analyse`/`answer` skills that take the
    // meeting dir as an argument. Assert both render (both languages) with the
    // meeting-dir placeholder and the acervo-facing contract (read the live
    // stream, do NOT touch manifest.json, write to the fixed artefatos subtree).
    #[test]
    fn meeting_skills_render_with_meeting_dir_argument() {
        for lang in ["pt", "en"] {
            let analyse = meeting_analyse_skill(lang);
            let answer = meeting_answer_skill(lang);
            // meeting-dir argument placeholder is present in both
            assert!(
                analyse.contains("$ARGUMENTS"),
                "analyse [{lang}] lacks $ARGUMENTS"
            );
            assert!(
                answer.contains("$ARGUMENTS"),
                "answer [{lang}] lacks $ARGUMENTS"
            );
            // reads the LIVE stream (reuniao.md + manifest.json)
            assert!(analyse.contains("reuniao.md") && analyse.contains("manifest.json"));
            assert!(answer.contains("reuniao.md") && answer.contains("manifest.json"));
            // never edits the manifest (avoids racing the app's atomic writer)
            let edict = if lang == "en" {
                "NOT edit"
            } else {
                "NÃO edite"
            };
            assert!(
                analyse.contains(edict),
                "analyse [{lang}] must forbid editing manifest"
            );
            assert!(
                answer.contains(edict),
                "answer [{lang}] must forbid editing manifest"
            );
            // analyse writes its findings under the fixed investigacoes subtree
            assert!(analyse.contains("artefatos/investigacoes/analise-"));
            assert!(analyse.contains("auditoria.jsonl"));
            // ADR-0013: analyse persists PII-free markers via the sidecar the app folds in
            assert!(analyse.contains("marcadores.jsonl"));
            // answer writes optional artifacts under respostas + audits
            assert!(answer.contains("artefatos/respostas/"));
            assert!(answer.contains("auditoria.jsonl"));
            // ADR-0012 is cited so the WHY is traceable
            assert!(analyse.contains("ADR-0012") && answer.contains("ADR-0012"));
            // ADR-0013: investigate the LOCAL context FIRST, external only AFTER
            let (first, only_after) = if lang == "en" {
                ("LOCAL context FIRST", "ONLY AFTER")
            } else {
                ("PRIMEIRO no contexto LOCAL", "SOMENTE DEPOIS")
            };
            assert!(
                analyse.contains(first) && analyse.contains(only_after),
                "analyse [{lang}] must be local-first"
            );
            assert!(
                answer.contains(first) && answer.contains(only_after),
                "answer [{lang}] must be local-first"
            );
            // never read another brainstorming's notes (renamed world, ADR-0013)
            assert!(analyse.contains("brainstorming/") && !analyse.contains("pessoal/"));
        }
    }

    // ADR-0013: /brain-ask answers ANY question from the contexts (local base)
    // FIRST, MCP/external only after — not meeting-scoped, writes nothing.
    #[test]
    fn brain_ask_skill_is_local_first_over_contexts() {
        for lang in ["pt", "en"] {
            let ask = brain_ask_skill(lang);
            assert!(ask.contains("$ARGUMENTS"));
            assert!(ask.contains("contextos/"));
            assert!(ask.to_lowercase().contains("mcp"));
            let (first, after) = if lang == "en" {
                ("LOCAL context FIRST", "ONLY AFTER")
            } else {
                ("PRIMEIRO no contexto LOCAL", "SOMENTE DEPOIS")
            };
            assert!(
                ask.contains(first) && ask.contains(after),
                "ask [{lang}] must be local-first"
            );
        }
    }

    // ADR-0013: the loop skill is /brain-context (hyphen; a dot is not a valid
    // Claude Code command name), materialized as .claude/commands/brain-context.md.
    #[test]
    fn brain_context_skill_renamed_from_brain() {
        for lang in ["pt", "en"] {
            let agents = agents_template(&["frota".into()], lang);
            assert!(agents.contains("/brain-context"));
            assert!(agents.contains("brain-context.md"));
            // the bare old form is gone from the AGENTS skill reference
            assert!(!agents.contains("`/brain`"));
            assert!(!agents.contains("commands/brain.md"));
        }
    }
}
