# Manual do Loro

_O Loro captura sua fala e seus textos localmente e transforma tudo em uma base
de conhecimento por contexto — privada, versionável e revisável. Nada de áudio
ou texto sai da sua máquina sem uma ação explícita sua._

## O fluxo em uma frase

**Brainstorming → Fila → Contexto**: você acumula material bruto (reuniões,
notas) num brainstorming; seleciona o que importa e envia um relatório para a
fila; o botão "gerar contexto" pede ao Claude do terminal que destile a fila em
`contextos/` — a fonte oficial da verdade, versionada em git.

## Primeiros passos

Na primeira abertura, um **modal de boas-vindas** resume as principais
funcionalidades (fluxo, gravação, modelos, agente, IA e atalhos) — reabra
quando quiser pela paleta: `Cmd/Ctrl+Shift+P` → "apresentação do Loro".

1. **Criar o acervo** — na primeira abertura, o assistente pede um nome, a
   pasta onde gerar e os contextos iniciais (ex.: `produto`, `engenharia`).
   Marque "versionar com git" para habilitar o fluxo de revisão (recomendado).
   O toggle **"modo automático"** (ligado por padrão) deixa o loop criar ou
   atribuir um contexto sozinho quando processa a fila, sem exigir que você
   defina todos os contextos de antemão; dá para desligar depois em
   Configurações — desligado, o loop deixa pendente o que não encaixa em
   nenhum contexto já existente, e avisa que precisa da sua decisão.
2. **Modelo de uso** — escolha um modelo pronto (Vendas, Engenharia,
   Produto & gestão, Aprendizado, Educação, Recrutamento, Saúde) ou o
   Genérico (em branco). O modelo pré-preenche os contextos (você pode
   editar), adiciona regras da vertical ao `AGENTS.md`, semeia o guia da
   fila e define o molde do `context.md` de cada contexto (as seções variam
   por vertical — vendas fala de pipeline e compromissos, saúde de condutas
   e protocolos). "Duplicar para personalizar" copia qualquer modelo para
   `~/.loro/templates/`, onde você edita os arquivos e ele passa a aparecer
   no assistente. Modelos com dados pessoais (Vendas, Recrutamento, Saúde)
   trazem regras de minimização — o de Saúde avisa: dados de saúde são
   sensíveis e o acervo não substitui o prontuário.
3. **Agente de IA** — o campo "agente de IA (comando)" define qual CLI o
   terminal embutido usa neste acervo: `claude` (padrão), `gemini`,
   `ollama run llama3`… O acervo é só arquivos + convenção (`AGENTS.md`),
   então qualquer agente — inclusive um modelo local — consegue trabalhar
   nele; para agentes que não entendem slash-commands, o Loro envia as
   instruções da skill como texto.
4. **Dependências** — o Loro avisa se faltar o whisper (transcrição) ou um
   modelo de voz, e instala pelos botões do banner usando o terminal embutido.
5. **Idioma** — na engrenagem (⚙), "idioma da interface" alterna pt-BR/inglês.
   Tudo que o app **gera** (relatórios, documentos de reunião, contextos)
   nasce no idioma ativo da interface.

## Gravar e transcrever

- **● (gravar)** abre o diálogo de gravação perguntando **onde salvar**: um
  brainstorming (vira uma reunião ligada ao tema) ou "transcrição avulsa"
  (o texto fica no painel ao vivo para salvar/descartar ao final). O atalho
  global é `Cmd/Ctrl+Alt+Espaço`.
- Cada comando da paleta (`Cmd/Ctrl+Shift+P`) tem um atalho `Cmd/Ctrl+Alt+
  <tecla>`, exibido ao lado do comando na própria paleta.
- **Fontes**: microfone, áudio do sistema (requer BlackHole — o app guia a
  instalação) ou **reunião** (mic + sistema juntos; a transcrição acontece ao
  final, com mais fidelidade).
- O áudio é **transitório**: usado para transcrever e descartado. O indicador
  de privacidade na barra mostra o estado ("sem gravar" / "grava áudio").

## Brainstorming (o mundo não versionado)

- O **＋** no cabeçalho da seção cria um brainstorming (espaço privado para
  um tema); o **＋** da seção contextos cria um contexto.
- Dentro dele (expanda o brainstorming na lateral): cada pasta tem sua
  própria ação de criação no topo — **notas** → **＋ nova nota**;
  **reuniões** → **● gravar reunião** (também na paleta `Cmd/Ctrl+Shift+P`
  → "nova reunião"); **anexos** → **⇄ sincronizar** (traz de Drive/Slack/
  Jira/Confluence) e **＋ do computador** (abre o seletor de arquivos e copia
  um `.pdf`/`.xlsx`/imagem que você já tem para os anexos do tema).
- **✦ nota por IA** (menu ⋯ do brainstorming) cria uma nota a partir de um
  pedido seu; **✦ pedir à IA** (menu ⋯ de uma nota/análise **e no rail à
  direita de qualquer arquivo aberto**) aplica um pedido sobre o conteúdo
  existente — a IA evolui, nunca apaga.
- **Rail de ações à direita do arquivo:** ao abrir qualquer nota/documento,
  a lateral direita mostra cartões de ação separados — **habilidade** (um
  dropdown com nomes amigáveis; a descrição da habilidade selecionada fica
  sempre visível logo abaixo, e **▶ executar** roda sobre o arquivo aberto),
  **pedir à IA…**, e **versionar** (quando o arquivo é de um contexto).
  Mesmo padrão em todo lugar onde essas ações existem — reunião, documento
  comum, cabeçalho do acervo.
- As ações **analisar**, **perguntar…**, **ver relatório** e **enviar para a
  fila** ficam no menu **⋯** da reunião na lateral. **Perguntar** funciona já
  durante a gravação; as outras três habilitam quando a reunião termina (o
  relatório é preenchido pelo analisar).
- A aba `reuniao.md` da reunião mostra, em vez de botões fixos, um único
  **dropdown de habilidades** ("o que fazer com esta reunião") — escolha
  qualquer habilidade (incluindo analisar/perguntar) e rode sobre a reunião
  aberta. Sem restrição: aparecem todas, padrão e customizadas.
- Numa reunião: marque **dúvidas/decisões/investigações** durante a fala (via
  paleta `Cmd/Ctrl+Shift+P` ou pelos botões); depois rode **analisar** (menu
  ⋯) para o Claude preencher o relatório da reunião.
- Nada do brainstorming é versionado nem sai da máquina.
- Investigações e respostas de cada reunião ficam **recolhidas por padrão**
  na lateral (toque na seta ▸ ao lado da reunião para abrir) — evita que a
  lista cresça demais quando há muitas reuniões analisadas.
- Cada brainstorming tem exatamente três pastas, visíveis na lateral como
  grupos com ícone de pasta (📁 **reuniões**, 📁 **notas**, 📁 **anexos** —
  cada uma clicável para expandir/recolher, com a contagem de itens):
  **reunioes/** (toda reunião nasce ali), **notas/** e **anexos/** (uma
  apresentação é só mais um tipo de anexo — não tem pasta própria).
  `anexos/` é alimentada por uma habilidade (sincronizar, apresentação,
  artefato) ou arrastando um arquivo
  direto na pasta real no disco.
- Com muitos brainstormings, um campo de busca aparece no topo da seção
  (acima de 8) — filtra por nome; sem busca, mostra só os mais recentes +
  "ver todos".

## Habilidades

Habilidades são ações do agente de IA — algumas já vêm prontas (padrão),
outras você cria. Não ficam mais na Visão Geral: rode uma pelo menu **⋯**
de um brainstorming → **"executar habilidade…"**, pelo botão **"executar
habilidade…"** no topo do visualizador de **qualquer arquivo markdown**, ou
pelo dropdown de habilidades numa reunião aberta. Sempre um menu/controle
compacto — a descrição de cada uma só aparece ao passar o mouse, para não
poluir a tela quando houver muitas.

- **Sincronizar** traz um item externo (Google Drive/Gemini, Slack, Jira ou
  Confluence) para um **anexo local** do brainstorming, referenciado numa
  nota. Drive traz o documento inteiro; Slack, Jira e Confluence trazem um
  **resumo** escrito pelo agente (nunca o texto/descrição crus). Cada fonte
  pede um identificador diferente: Drive aceita uma busca opcional ou um
  link; Slack pede o nome do canal; Jira, a chave do ticket ou link;
  Confluence, o título da página ou link. O agente sempre lista o que
  encontrou e pede sua confirmação antes de trazer. Itens compartilhados por
  colegas não têm pasta/organização própria na sua conta — isso é esperado,
  ainda são aceitos.
  **Pré-requisito:** o agente do terminal precisa ter o conector daquele
  serviço (Drive, Slack, Jira, Confluence) já configurado/autenticado — o
  Loro não gerencia essas credenciais.
- **Apresentação** e **artefato** são habilidades padrão que geram material
  (um deck em markdown, um diagrama, um script, uma planilha) a partir de um
  brainstorming ou de um contexto — sempre em `anexos/` (não há pasta
  própria de apresentações), e se você apontar para uma nota específica,
  ela ganha a referência automaticamente.
- **Habilidades padrão** (as de sincronizar, apresentação e artefato) podem
  ser **editadas**, mas nunca excluídas. **Habilidades customizadas** são
  skills que você mesmo cria — aparecem como comandos de barra reais
  (`/nome-da-habilidade`) assim que existem. Duas formas de criar, no **＋**
  da seção "habilidades" da lateral: **"nova habilidade (IA)"** — descreva
  o que ela deve fazer e a IA escreve a skill — ou **"importar skill
  existente"** — cole o conteúdo de uma skill que você já tem. Cada
  habilidade listada (na lateral) tem um menu **⋯** com **usar**,
  **editar** (abre o arquivo bruto), **pedir à IA** (peça para evoluir a
  habilidade, preservando o que já funciona) e **excluir** (só para as
  customizadas).
- Na lateral, o ícone diz a origem: **⚡ raio** = habilidade padrão,
  **★ estrela** = customizada. Clique no título da seção "habilidades" para
  **recolher/exibir** a lista inteira (o caret ▾/▸ mostra o estado).

## Contextos também têm anexos

Cada contexto tem sua pasta **anexos/**, sempre visível na árvore — com
**＋ nova nota** (escreve uma nota que nasce dentro do contexto) e **＋ do
computador** (seletor de arquivos). Diferente dos anexos de brainstorming,
os anexos de um contexto são **versionados junto com ele** (entram no fluxo
de versionar/propor mudança normalmente).

## Fila → gerar contexto

- Selecione as partes de um brainstorming e **envie o relatório para a fila**
  (ou solte arquivos `.md`/`.txt` direto na fila).
- **▶ gerar contexto** roda `/loro-context` no Claude do terminal, que
  estrutura o material em `contextos/<c>/context.md` (+ CHANGELOG).
- Cada `context.md` abre com um **Sumário** (1 linha por seção + IDs `D-…`/`H-…`),
  regenerado a cada atualização — é ele que deixa a leitura barata para pessoas
  e agentes; decisões e hotspots ganham IDs estáveis, localizáveis por busca.
- Com a fila **vazia**, o botão avisa e não roda: não há de onde gerar.
- O checkbox **"salvar anexos referenciados no contexto"** (opcional, marque
  antes de gerar) copia os anexos dos itens processados para
  `contextos/<c>/anexos/` — sem marcar, os anexos ficam só no brainstorming.

## Versionar e propor mudança (RFC = PR)

- **⎇ (branch)** mostra a branch atual; clique para trocar de branch ou criar
  uma nova. Mudanças de conhecimento **sempre nascem numa branch** `rfc/…` —
  a main é protegida.
- **versionar** sincroniza a main com o remoto (quando houver), cria/reusa a
  branch `rfc/<slug>` e commita suas mudanças locais. Sem rede? O fluxo segue
  local e o app avisa.
- **propor mudança** publica a branch e abre o Pull Request (a RFC). Os donos
  do contexto (CODEOWNERS) revisam; o merge torna a proposta oficial.
- Trocar de branch com alterações não versionadas é bloqueado — versione antes.

## Perguntar ao acervo

- **perguntar ao acervo** abre o Claude no terminal embutido e envia sua
  pergunta com `/loro-ask`; a resposta se ancora nos `context.md` do acervo e
  diz claramente quando a base não cobre o assunto.

## FAQ

**Onde ficam meus dados?** Na pasta do acervo que você escolheu, e só nela.
Config e modelos ficam em `~/.loro/`. Nenhum conteúdo sai da máquina sem ação
sua (rodar um skill, propor um PR).

**O que sobe para a nuvem?** Nada, por padrão. "Propor mudança" publica a
branch no seu repositório remoto; os skills do Claude leem a base local
primeiro e declaram quando consultam algo externo.

**Posso usar vários projetos?** Sim — o seletor ◆ no topo da lateral troca de
acervo e cria novos.

**Por que o botão "gerar contexto" está desabilitado?** A fila está vazia.
Envie um relatório de brainstorming ou solte arquivos na fila primeiro.

**O Claude não abre no terminal.** Confira se o CLI está instalado (`claude`
no PATH) e se há um acervo configurado. O app avisa quando não consegue abrir.

**Como mudo a largura da lateral?** Arraste a divisória entre a lateral e o
editor; com a lateral larga, os arquivos mostram data e estado git. Clique
duplo na divisória volta ao padrão.

**Uma aba mostrou conteúdo de outro arquivo.** Isso era um defeito antigo do
editor, corrigido — se voltar a acontecer, abra um issue com os passos.

**Em que idioma o conteúdo é gerado?** No idioma ativo da interface no momento
da geração. Um acervo pode conter documentos nos dois idiomas se você alternar.

**O que é uma "habilidade customizada"?** Uma skill que você mesmo cria —
descrevendo o que ela deve fazer (a IA escreve) ou importando uma que você já
tem. Vira um comando de barra de verdade (`/nome-da-habilidade`) e aparece na
seção "habilidades" da lateral; roda pelo menu ⋯ ("executar habilidade…")
de um brainstorming ou reunião.

**Posso apagar uma habilidade padrão (sincronizar, apresentação, artefato)?**
Não — pode editá-la, mas não excluí-la. Só habilidades customizadas (criadas
por você) podem ser excluídas.

**O que o "modo automático" realmente faz?** Quando ligado (padrão), o loop
pode criar um contexto novo ou decidir a qual contexto atribuir algo, sozinho,
ao processar a fila. Desligado (em Configurações), ele não cria nada novo por
conta própria — deixa o item pendente na fila e avisa que precisa da sua
decisão manual. Não afeta atribuir a um contexto que já existe.

**Por que as investigações/respostas de uma reunião não aparecem de cara?**
Ficam recolhidas por padrão para a lateral não crescer demais — toque na
seta ▸ ao lado da reunião para abrir.
