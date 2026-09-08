# ADR-0037 — Ouvir o documento: leitura em voz alta, e a pausa que é medida

- **Status:** **accepted and implemented** (2026-09-08), macOS.
- **Extends:** ADR-0035 (modo intérprete — de onde vem a experiência com o `say`),
  ADR-0036 (o motor de voz é escolha), ADR-0008 (o editor fiel: CM6 por aba),
  ADR-0016 (a barra de formatação do documento)
- **Revokes:** nothing.

## Context

O pedido do dono: *"quero implementar um modo de leitura de arquivos para
acessibilidade. Ou seja, quero que ele seja capaz de ditar um arquivo usando o
say (no caso do mac)."*

Três decisões dele, tomadas antes de qualquer linha: lê **o arquivo inteiro e a
seleção**; tem **ler, pausar/retomar e parar**; e vive na **paleta e num botão do
documento**. Uma correção depois: o botão fica na **visualização**, não na barra
de formatação — *"na realidade add no modo de visualização em qualquer arquivo
markdown, ou reunião/análise"*.

## 1. A extração de prosa É a feature

Mandar markdown cru ao sintetizador não produz uma versão pior do texto —
produz algo **inutilizável**: "cerquilha cerquilha Título", "asterisco asterisco
negrito", e uma URL lida caractere por caractere leva meio minuto.

`desktop/src/readaloud.js` extrai prosa, e cada regra existe por um motivo:

| Markdown | Falado | Por quê |
|---|---|---|
| `[texto](url)` | `texto` | a URL é a regra que mais muda a experiência |
| `## Título` | `Título.` | o ponto faz o `say` pausar onde o olho pausaria |
| bloco de código | `bloco de código.` | ler código é ruído; **pular calado esconde** conteúdo |
| tabela | `a, b, c` por linha | num documento de conhecimento a tabela costuma SER o conteúdo |
| front matter | *(nada)* | metadado, e seria a primeira coisa que a pessoa ouve |
| `![alt](url)` | `imagem: alt` | o alt é a informação; a URL não |

21 testes, um por regra, mais um que roda um documento real do repo e exige que
não sobre `#`, `**`, `|`, `](`, ``` ``` ``` nem `domain:`.

## 2. A pausa é real, e isso foi MEDIDO

Pausar por sinal (`SIGSTOP`/`SIGCONT`) em vez de matar-e-recomeçar: recomeçar
voltaria ao início do documento, que para quem ouve é perder o lugar na página.

O estado do processo (`T` parado, `S` acordado) prova só que o **processo** parou.
O que prova que a **pausa** existe é o áudio — então a medida foi feita gravando
a saída, segundo a segundo (2026-09-08):

```
t=0..2s   -6,1 / -2,3 dB    falando
t=2..4s   -91,0 / -91,0 dB  SIGSTOP: silêncio digital, imediato
t=4..7s   -4,5 / -2,6 dB    SIGCONT: retomou de onde parou
```

Sem `libc`: seriam duas chamadas de `kill()` custando uma dependência nova num
`Cargo.toml` que tem 9 de propósito. Este app já resolve o que é do sistema
saindo para o sistema, e `/bin/kill -STOP` foi verificado aqui.

## 3. Onde o controle mora, e por que não na barra de formatação

Ouvir é atividade de **leitura**. O primeiro desenho pôs o botão na barra de
formatação (ADR-0016), que **só existe em modo de edição** — exigir editar para
ouvir é ao contrário. O controle foi para a **moldura do documento**, ao lado de
*visualizar / editar*, visível nos dois modos.

Ele aparece onde há markdown para ouvir, e a moldura separa os casos:

| Superfície | Oferece ouvir? |
|---|---|
| `.md` / `.txt`, guia, rascunho, análise em `notas/` | sim — pelo `textFile`, o mesmo predicado que a moldura já usa para decidir o alternador |
| **reunião ao vivo** | sim — e precisou de linha própria: ela tem moldura própria e sai por retorno antecipado, então herdaria "sem controle" em silêncio |
| loop, formulário de loop, índice remissivo | não — é tela estruturada, não prosa |

Ícone de **fone de ouvido**, não alto-falante: a ação é *ouvir*, e alto-falante
com ondas se confunde com controle de volume.

## 4. A voz padrão não pode ser "a primeira do idioma"

Medido em 2026-09-08, a ordem que o `say -v '?'` lista em pt_BR nesta máquina:

```
Eddy · Flo · Grandma · Grandpa · Luciana
```

As quatro primeiras são as vozes-**personagem** que a Apple adicionou; a voz de
verdade é a última. "A primeira do locale" escolhia o **Eddy** para ler todo
documento em português — foi o relato do dono: *"a voz está bem ruim"*.

Há agora uma lista de vozes conhecidamente boas por idioma (pt: Luciana, Joana,
Felipe · en: Samantha, Alex, Daniel, Karen · e as equivalentes em es/fr/it/de).
É lista **positiva, não de bloqueio** — diz quais são boas em vez de adivinhar
quais são piada, a lição da ADR-0034 aplicada a vozes. E é por isso que o
seletor manual continua oferecendo **todas**.

Sem preferida para o idioma, cai na primeira do locale; sem voz para o idioma,
vazio — e aí o `say` usa a do sistema, que é degradar para a preferência da
pessoa em vez de recusar a ler.

## 5. Diferenças deliberadas com o modo intérprete

O intérprete (ADR-0035/0036) parece o mesmo problema e não é:

| | intérprete | leitura |
|---|---|---|
| destino do áudio | um driver **virtual escolhido** (a outra ponta da chamada) | o dispositivo **padrão** (o fone da pessoa) |
| velocidade | 210 wpm — a pressa evita o atraso acumular na conversa | **175 wpm** — apressar piora a compreensão de quem depende do áudio |
| vozes oferecidas | só `en_*` (o `-tr` do whisper só produz inglês) | **todas** — o texto é o do documento, aqui normalmente português |

Herdar qualquer um dos três teria produzido um recurso pior: leitura no driver
virtual não sairia no ouvido, e a lista filtrada em inglês não teria uma única
voz utilizável.

## 6. O que a construção ensinou

- **`savedById` não é a fonte do texto.** A primeira versão lia o handle do
  CodeMirror, que só existe editando. A segunda leu o cache `savedById` — que é
  populado por apenas **dois** caminhos de render (o `mountEditor` e a vista de
  ideia): na visualização de um markdown comum e na reunião ninguém o popula, e
  o cache estava vazio justamente onde o controle mora. Relatado duas vezes como
  *"there is no text to read"*. A fonte é o **disco**, que existe para toda
  superfície sem depender de qual render passou antes.
- **A troca de processo tem de ser atômica.** Matar o anterior e guardar o novo
  em travas separadas deixa uma janela: dois cliques rápidos e o segundo mata
  "nada", porque o primeiro ainda não guardou — e o primeiro `say` fica órfão e
  audível junto do segundo (relatado: *"clicar duas vezes sobrepõe os áudios"*).
  Uma trava só.
- **Fechar a janela do Loro só a esconde** (`CloseRequested` faz
  `prevent_close` + `hide`, o app fica na bandeja). Sem cortar a leitura ali, a
  voz seguia lendo um documento que a pessoa não vê mais (*"fechei a aplicação e
  o audio manteve"*). Corta ao esconder **e** ao sair — um `say` filho sobrevive
  ao pai.
- **`.mini` não alinha ícone com rótulo.** A convenção dessa classe é glifo no
  texto; o `.ic` de SVG só funciona em contexto flex, como no `.footrow`. Medido
  `display: block`, e era o que fazia o botão parecer quebrado. O smoke agora
  **mede** o display e o alinhamento.
- **Uma chamada de boot na zona morta derruba o app inteiro.** `wireReadControls`
  toca um `const` declarado bem depois no arquivo; chamada cedo, o medidor
  acusou `Cannot access 'ws' before initialization` em quatro passos que nada
  têm a ver com leitura.

## 7. O que NÃO existe

- **Windows e Linux.** `say` é do macOS. Os comandos devolvem
  `err.read_aloud_unsupported` fora dele, e `read_aloud_state` reporta
  `supported: false` para a tela dizer a diferença entre "não está lendo" e "não
  existe aqui". A extração de prosa é neutra e será reusada quando houver motor.
- **Navegar por parágrafo** (avançar/voltar). O dono escolheu ler/pausar/parar; a
  fila com posição fica para quando o uso pedir.
- **Acompanhar visualmente** o trecho que está sendo lido. Seria o próximo ganho
  de acessibilidade, e exige mapear a prosa extraída de volta ao documento.

## Business rules

- **BR-1 — inference stays local.** Held: o `say` é do sistema, nada sai da
  máquina.
- **BR-8 — logs are content-free.** O texto lido nunca vai a log; vai ao `say`
  por **arquivo** (`-f`), o que também o mantém fora de qualquer `ps`. Os logs
  desta feature carregam ms, bytes e códigos de erro.
- **BR-9 — no credentials.** Nada a autenticar neste caminho.
