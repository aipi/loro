# ADR-0007 — Habilidades (rename + redesign), anexos de conteúdo, bugfix do terminal

- **Status:** accepted (owner decision, 2026-07-29)
- **Context:** uso real do trabalho de ADR-0005/0006 revelou um bug no
  terminal embutido e motivou uma evolução de desenho: "ferramentas" vira
  "habilidades" e sai da Visão Geral; sync passa a trazer conteúdo (não só
  link); brainstorming ganha subpastas de apresentação/anexo; contexto ganha
  uma pasta de anexos opcional; e a lateral precisa de um jeito melhor de
  navegar com muitos brainstormings.

## Decisão

### §1 Bugfix do terminal

`term_open` escrevia literalmente `b"claude\n"` no PTY, ignorando o agente
configurado (`active_agent()`) — quebrava para qualquer acervo configurado
com outro CLI. `term_status` não guardava nenhum estado de sessão: cada
chamada reconsultava `ps` ao vivo, e uma corrida logo após `term_open` já ter
digitado o lançamento fazia `termRunAgent` (frontend) achar que o agente não
estava rodando e digitá-lo de novo — o bug relatado ("já abriu o Claude e
fica digitando `claude` de novo").

Fix: `term_open` agora usa `active_agent()`; `TermSession` guarda
`launched_at`; `term_status` expõe `justLaunched` (janela de 6s, função pura
`is_within_grace` testada); `termRunAgent` só redigita o agente depois que
essa janela passa.

### §2 "Ferramentas" → "habilidades" (rótulo), sai da Visão Geral

Rótulo de UI (pt/en: "habilidade(s)"/"skill(s)" continuam existindo como
termo técnico em inglês no código — `tool`, `TOOL_BUILTINS`,
`brain_*_tool`), por convenção do CLAUDE.md §6 (código em inglês,
independente do idioma da UI). O card fixo na Visão Geral foi removido —
habilidades são geridas na lateral e executadas via **"⋯" → "executar
habilidade"**, um menu compacto sem descrições sempre visíveis (só no hover,
via `title=`), evitando poluição quando a lista crescer.

Habilidades **built-in** (as 4 fontes de sync + `apresentação`/`artefato`)
agora também aparecem na lista da lateral — antes eram totalmente ocultas.
Podem ser **editadas**, nunca **excluídas** (`brain_delete_tool` já recusava
isso; a UI só passou a refletir a regra, escondendo "excluir" para elas). As
5 habilidades "de fluxo" (`loro-note`, `loro-ask`, `loro-context`,
`loro-analyse`, `loro-question`) ficam de fora do picker "executar
habilidade" — já têm UI dedicada, listá-las de novo seria ruído.

### §3 Habilidades novas: apresentação e artefato

`/loro-presentation` e `/loro-artifact` (nomes de comando em inglês, igual
às demais skills; conteúdo/pastas continuam em português) — genéricas,
usáveis a partir de um brainstorming (`brainstorming/<tema>/anexos/`) OU de
um contexto (`contextos/<c>/anexos/`) — sem pasta própria de apresentações
(ver amendment em §5). Markdown é o formato padrão (qualquer
agente sempre consegue produzir); um `.pptx`/`.xlsx` de verdade é aceitável
se o agente tiver como gerar, nunca assumido.

### §4 `/loro-sync` passa a trazer conteúdo (supera ADR-0005 §4)

Antes: só `tipo: <fonte>`, `caminho: <link externo>` — nunca ler conteúdo.
Agora: cada fonte grava um **anexo local**
(`brainstorming/<tema>/anexos/<slug>.md`, front-matter `fonte`/`link`/`data`)
e a nota referencia esse arquivo LOCAL (`tipo: doc`,
`caminho: acervo://...`) — nunca a URL externa direto no `refs:`.

- **drive**: exporta o documento inteiro.
- **slack/jira/confluence**: o agente escreve um resumo (nunca o texto/
  descrição crus).

BR-8 continua satisfeita: o conteúdo vive no próprio acervo (igual a uma
transcrição de reunião já vive), nunca em log/manifesto.

### §5 Subpastas do brainstorming: exatamente 3 — `reunioes/`, `notas/`, `anexos/`

Aditivo: `create_brainstorming` cria `anexos/`; `all_parts_of` a enumera
para o relatório consolidado. `gather_part` já tratava qualquer `kind`
desconhecido como nota — nenhuma mudança adicional foi necessária ali
(confirmado por teste, não só leitura). Alimentação manual é só arrastar
arquivo por fora (Finder/Explorer) — sem picker novo no app.

**Amendment (mesma sessão):** a primeira versão desta ADR criou uma pasta
`apresentacoes/` separada. Revisado: **não há pasta própria de
apresentações** — uma apresentação é só mais um tipo de conteúdo dentro de
`anexos/` (ambas as habilidades, `/loro-presentation` e `/loro-artifact`,
escrevem lá). As três pastas do brainstorming que importam para o usuário
são `reunioes/`, `notas/` e `anexos/` — cada uma com uma finalidade clara;
toda reunião nasce dentro de `reunioes/`. (`investigacoes/`, `perguntas/` e
`relatorios/` seguem existindo como infraestrutura pré-existente, não
alterada por esta ADR.)

### §6 Anexos de contexto, versionamento opcional

Checkbox "salvar anexos referenciados no contexto" ao lado de "gerar
contexto": quando marcado, acrescenta uma instrução em `inbox/_prompt.md`
(reaproveitando `brain_read_guide`/`brain_write_guide` — zero comando novo)
antes de rodar `/loro-context`. O skill do loop já arquiva/limpa
`_prompt.md` a cada rodada, então a instrução é naturalmente de uso único.
O loop, ao processar, copia os anexos referenciados pelos itens da rodada
para `contextos/<c>/anexos/`.

### §7 Lateral escalável: busca/filtro de brainstormings

Acima de 8 brainstormings, a árvore sempre expansível ficava difícil de
escanear. Um campo de busca (escondido abaixo desse limiar) filtra por
nome/slug; sem busca, a lista corta para os 8 mais recentes + uma linha
"ver todos (N)". Lógica pura (`filterAndCapTemas`, testada) em
`brainstorm.js`; `renderPessoal` reaplica a cada tecla sem re-buscar.

### §8 Rail da reunião: um dropdown único e irrestrito (amendment)

A primeira versão adicionava um dropdown de habilidades como uma 5ª ação,
ao lado de 4 botões fixos ("analisar", "perguntar…", "ver relatório",
"enviar para a fila"). Revisado: **"o que fazer com esta reunião" vira só o
dropdown** — um único controle, sem nenhuma ação fixa, e sem restrição de
habilidade (`allHabilidadeEntries()`, sem o filtro dos 5 skills "de fluxo"):
`/loro-analyse` e `/loro-question` agora aparecem ali como qualquer outra
habilidade. As 4 ações continuam acessíveis pelo menu **"⋯"** da reunião
(que já tinha analisar/perguntar/ver relatório; ganhou "enviar para a fila",
que só existia no rail antes) — nada foi perdido, só reorganizado. O ícone
de raio (`ico("skill")`) identifica visualmente o controle de habilidade,
tanto no cabeçalho do rail quanto nas linhas da lateral e nos menus "⋯".

Também: o botão "executar habilidade…" passou a existir no topo do
visualizador de **qualquer** arquivo markdown (ao lado de "pedir à IA…"),
não só em reuniões — pedido explícito do dono ("todos os arquivos markdown
deverão ter as habilidades ao lado").

### §9 Rail de ações do documento + pastas visíveis na lateral (amendment)

Dois ajustes de UI pedidos após uso real:

- **Rail lateral direita, um padrão único.** "Executar habilidade" e "pedir
  à IA" saíram do cabeçalho do documento (`.dochead`) para um **rail à
  direita** (`#bDocRail`, `renderDocRail`), com **botões visíveis de
  verdade** (`.railbtn`) — não mais um botão que abre um menu flutuante.
  Habilidade virou um **dropdown + ícone de play** inline (mesmo controle
  já usado no rail da reunião, agora extraído para uma classe compartilhada
  `.rail-sec`/`.rail-row`/`.railbtn`). "Versionar" (que já existia só no
  cabeçalho do acervo) ganhou o mesmo botão no rail quando o documento
  aberto é um contexto (`tab.kind === "context"`) — mesma ação
  (`brain_version`, extraída para `promptVersionar()`), só mais um lugar de
  acesso. O rail da reunião foi migrado para as mesmas classes, garantindo
  visual idêntico nos dois lugares.
- **Estrutura de pasta visível na lateral.** As três pastas do brainstorming
  (`reuniões/`, `notas/`, `anexos/`) agora aparecem como **grupos
  colapsáveis com ícone de pasta** (`folderGroupHtml`, reaproveitando o
  toggle `[data-pestoggle]` já usado para "avulso") — antes eram só listas
  soltas sem nenhuma indicação visual de que pertenciam a pastas
  diferentes. Cada grupo mostra sua contagem e permanece visível mesmo
  vazio, deixando a estrutura sempre legível.
- Corrigido manualmente um acervo real (`../turbo`, fora deste repositório)
  que estava com uma versão antiga: faltavam `loro-tool.md`,
  `loro-presentation.md`, `loro-artifact.md`, e `loro-sync.md` era a versão
  pré-conteúdo (ADR-0005 original). O mecanismo de auto-cura do app
  (`ensure_meeting_skills`/`list_brainstormings`) resolveria os builtins e o
  `anexos/` na próxima abertura; a correção manual só adiantou os arquivos
  que o app não sobrescreve por padrão (`loro-sync.md` já existia, então
  precisou ser substituído à mão).

## Consequências

- `lib.rs`: `TermSession.launched_at`, `TermStatus.justLaunched`,
  `is_within_grace`, `term_open` usa `active_agent()`.
- `templates.rs`: `LORO_PRESENTATION_SKILL`/`LORO_ARTIFACT_SKILL` (pt/en,
  escrevem em `anexos/`, sem pasta própria); `/loro-sync` reescrito (4
  fontes, sempre `brainstorming/<tema>/anexos/` — nunca grava direto num
  contexto); `/loro-context` documenta a instrução opcional de anexos.
- `acervo.rs`: `BUILTIN_SKILLS` cresce para 9; `create_brainstorming`/
  `all_parts_of` ganham `anexos` (sem `apresentacoes` separado);
  `list_brainstormings` se auto-cura (cria a pasta que faltar a cada
  listagem — sem migração explícita).
- `app.js`/`index.html`/`style.css`: rename de rótulo, remoção do card da
  Visão Geral, ícone de raio no lugar do emoji 🧰, `openHabilidadeMenu`/
  `allHabilidadeEntries`/`pickableHabilidadeEntries` compartilhados, rail da
  reunião reduzido a um dropdown irrestrito, "executar habilidade…" em todo
  markdown, checkbox de anexos, campo de busca da lateral.
- Testes novos: `is_within_grace`, `all_parts_of_includes_anexos`,
  `list_brainstormings_backfills_missing_subfolders`,
  `sync_skill_writes_local_anexo_ref_not_external_url`,
  `loop_skill_documents_optional_anexos_versioning`, `filterAndCapTemas`
  (2 casos).
