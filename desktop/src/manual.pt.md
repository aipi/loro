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

1. **Criar o acervo** — na primeira abertura, o assistente pede um nome, a
   pasta onde gerar e os contextos iniciais (ex.: `produto`, `engenharia`).
   Marque "versionar com git" para habilitar o fluxo de revisão (recomendado).
2. **Dependências** — o Loro avisa se faltar o whisper (transcrição) ou um
   modelo de voz, e instala pelos botões do banner usando o terminal embutido.
3. **Idioma** — na engrenagem (⚙), "idioma da interface" alterna pt-BR/inglês.
   Tudo que o app **gera** (relatórios, documentos de reunião, contextos)
   nasce no idioma ativo da interface.

## Gravar e transcrever

- **● (gravar)** inicia a transcrição ao vivo do microfone; o atalho global é
  `Cmd/Ctrl+Alt+Espaço`. O painel ao vivo mostra o texto conforme você fala.
- **Fontes**: microfone, áudio do sistema (requer BlackHole — o app guia a
  instalação) ou **reunião** (mic + sistema juntos; a transcrição acontece ao
  final, com mais fidelidade).
- O áudio é **transitório**: usado para transcrever e descartado. O indicador
  de privacidade na barra mostra o estado ("sem gravar" / "grava áudio").

## Brainstorming (o mundo não versionado)

- **＋ novo brainstorming** cria um espaço privado para um tema.
- Dentro dele: **＋ nova nota** (primeira linha do bloco) para escrever, e ●
  para gravar uma **reunião** ligada ao tema.
- Numa reunião: marque **dúvidas/decisões/investigações** durante a fala (via
  paleta `Cmd/Ctrl+Shift+P` ou pelos botões); depois rode **analisar** para o
  Claude preencher o relatório da reunião.
- Nada do brainstorming é versionado nem sai da máquina.

## Fila → gerar contexto

- Selecione as partes de um brainstorming e **envie o relatório para a fila**
  (ou solte arquivos `.md`/`.txt` direto na fila).
- **▶ gerar contexto** roda `/brain-context` no Claude do terminal, que
  estrutura o material em `contextos/<c>/context.md` (+ CHANGELOG).
- Com a fila **vazia**, o botão avisa e não roda: não há de onde gerar.

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
  pergunta com `/brain-ask`; a resposta se ancora nos `context.md` do acervo e
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
