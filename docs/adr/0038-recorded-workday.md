# ADR-0038 — Dia gravado: o Loro grava o expediente sozinho, em horas emendadas

- **Status:** superseded by [ADR-0041](0041-recording-bubble-and-agenda.md) (2026-11-18). Originally: accepted and implemented (decisão do dono, 2026-11-18; implementado na mesma data), macOS primeiro.
- **Extends:** ADR-0001 §2 (modo reunião), ADR-0022 (pausa/retomada e segmentos),
  ADR-0025 (âncora de época por segmento), ADR-0018 (a transcrição ao vivo é a saída)
- **Revokes:** nothing.

## Context

O pedido do dono: gravar **o dia de trabalho inteiro, sem dar play**, todos os
dias das 9:00 às 18:30, e deixar um agente externo (Claude Code com o conector de
agenda) **recortar depois** a transcrição pelos horários das reuniões e mandar
cada trecho para o registro certo. Decisões dele, tomadas antes de qualquer linha:

1. **Sem aviso a participantes e sem confirmação.** É organização pessoal; as
   pessoas estão cientes. Só ele precisa saber que está gravando (a bandeja já
   mostra).
2. **O Loro não lê a agenda.** Quem lê é o agente, com os conectores dele (BR-9:
   o app nunca guarda credencial). O Loro só grava e carimba a hora.
3. **Janela fixa diária**, 9:00–18:30, todos os dias.

O mapa do código (2026-11-18) mostrou por que "uma reunião de 9h30" não serve:

| Fato medido no código | Consequência para 9h30 contínuas |
|---|---|
| o sidecar grava 48 kHz × 2 canais × Float32 (`loro-syscap.swift:43-44,78-79`) = 384 kB/s ≈ **1,38 GB/h** | ≈ 13 GB num WAV; o cabeçalho RIFF de 32 bits estoura em **≈ 3h06** (`wav.rs:54`, `lib.rs:924`) |
| `transcribe_tail_blocking` copia e lê **o WAV inteiro** a cada 18 s (`meeting.rs:1617-1618`) | na 9ª hora, ≈ 12 GB copiados e carregados por tique |
| `append_timed` relê e reescreve o `meeting.md` inteiro por janela (`meeting.rs:1022-1057`) | custo O(n) que cresce o dia todo |
| o bloco carimba só `mm:ss` relativo; `started_epoch_ms` não é persistido (`meeting.rs:299-330, 577-584, 719-727`) | o agente **não consegue** saber a hora de relógio de cada fala |
| `pickMeeting` sempre abre modal (`app.js:7006`); `loopTick` retorna com `document.hidden` (`app.js:12748`) | não há caminho de início sem clique nem relógio que rode com a janela na bandeja |
| nenhuma asserção de energia no código | o Mac dorme e o WAV encolhe em relação ao relógio |

## Decision

### §1 O dia é uma sequência de reuniões de no máximo uma hora

Dentro da janela, o Loro mantém **uma reunião comum** gravando e a **rotaciona na
virada de cada hora cheia** (9:00, 10:00, …, 18:00) e encerra no fim da janela
(18:30). Cada hora é uma reunião normal — mesmo `brain_meeting_start`, mesma
transcrição ao vivo, mesmo `finalizeMeeting`, mesmo `purge_audio`. Nada no
pipeline muda; só o tamanho de cada pedaço fica limitado (≈ 1,4 GB de WAV, longe
do teto de 4 GB, e a cópia por tique para de crescer depois de uma hora).

- Tema fixo `dia` (`brainstorming/dia/meetings/…`), título `Dia AAAA-MM-DD HH:00`.
- A rotação é **parar e começar**: entre uma hora e outra há um buraco de
  alguns segundos (o flush do último segmento). Aceito: o agente recorta por
  reunião de agenda, e um buraco de segundos na virada da hora não muda o que foi
  decidido numa reunião.
- Se o app abrir **dentro** da janela (ex.: 10:17), começa na hora e grava até a
  próxima virada.
- Se a pessoa **parar à mão** uma gravação do dia, o dia fica suspenso **até a
  próxima virada de hora** — parar é uma decisão dela, e respeitar isso por uma
  hora evita brigar com o clique. Um botão "retomar dia" volta antes.
- Se já houver **uma reunião manual** gravando quando a janela começa ou vira,
  o dia não interrompe: espera ela acabar e começa na próxima verificação.

### §2 O relógio do dia vive no app, e roda com a janela escondida

Um tique próprio a cada 15 s no frontend (o app conhece o fuso, como em
ADR-0029 §4.6), **sem** o `document.hidden` que trava os loops: o dia gravado
precisa rodar com o Loro só na bandeja. A decisão é **pura** (módulo testável,
`workday.js`): dado `{agora, janela, estado}` devolve `iniciar | rotacionar |
encerrar | nada`. O início usa o caminho que já existe sem modal,
`startMeetingWith({tema, titulo})`.

### §3 Cada fala carrega a hora de relógio

- O `manifest.json` passa a guardar `startedEpochMs` (a época do início) e
  `pausedMs` (o total pausado, somado a cada retomada).
- O comentário de cada bloco ganha a época absoluta da fala:
  `<!-- loro:t=754000 e=1763474054000 -->`. O `t` relativo continua (é o que
  ordena), o `e` é o que o agente usa para recortar pela agenda.
- O carimbo visível passa de `mm:ss` para `h:mm:ss` depois da primeira hora (corrige
  `[570:00 · você]`).

### §4 O Mac não dorme enquanto o dia grava

Durante a janela, o Loro segura uma asserção de "não dormir por inatividade"
(`caffeinate -i -w <pid do Loro>`, lançado e morto pelo próprio app; nada de
privilégio). Tampa fechada sem monitor externo ainda dorme — é o sistema, e está
fora do alcance de um app sem privilégio.

### §5 Configuração

Em `~/.loro/config.json` (preferência da pessoa, não do acervo — vale para
qualquer acervo ativo, e a gravação vai para o acervo ativo):

```json
"diaGravado": { "ligado": true, "inicio": "09:00", "fim": "18:30", "dias": [0,1,2,3,4,5,6] }
```

`dias` usa 0 = domingo, como os ritmos de loop. Ausente = desligado. A tela de
configurações ganha o liga/desliga e os dois horários; o arquivo pode ser escrito
também pelo agente.

## Consequences

- O agente externo recebe, por dia, até 10 reuniões `dia` com épocas absolutas por
  fala, e recorta pela agenda. Fala fora de qualquer evento fica no registro do
  dia, sem reunião.
- Custo de máquina: a transcrição ao vivo roda o dia todo (≈ 1,7 s de whisper a
  cada 18 s por trilha, `meeting.rs:1561-1566`). É o custo de uma reunião, estendido.
- O áudio continua sendo apagado no fim de cada hora (decisão anterior do dono):
  uma janela que falhar durante o dia não tem como ser retranscrita.

## Explicitly NOT done

- O Loro não lê agenda, não recorta por evento e não sabe quem participa.
- Sem aviso, contagem ou confirmação antes de gravar (decisão do dono).
- Windows: o tique e a rotação valem igual, mas a asserção de energia (§4) é só macOS nesta versão.

## What the implementation taught

- **A época de cada fala vem do frontend, não do manifesto.** O §3 sugere que
  `startedEpochMs + pausedMs` bastam; não bastam para a fala. O `t` desconta o
  total pausado *quando o segmento começou* (`segPausedMs`, ADR-0025), e a última
  janela de um segmento anterior a uma pausa pode ser escrita depois do retomar —
  recalculada no backend com o `pausedMs` corrente, ela sairia deslocada pela
  própria pausa que a precedeu. O `e=` é a âncora do segmento (a primeira amostra
  do sidecar, ou o início do segmento de microfone) mais o offset da fala,
  calculado em `meeting.js::blockEpoch` e enviado como `eMs` em
  `brain_meeting_append_timed`. Os dois campos do manifesto continuam gravados
  como o §3 pede (`startedEpochMs` no início, `pausedMs` somado em cada
  `brain_meeting_resume`, medido entre os comandos de pausa e retomada).
- **Rotacionar espera o fechamento inteiro.** `meeting.active` cai no primeiro
  passo do encerramento, mas o flush, o `brain_meeting_finish`, a purga e a aba da
  reunião concluída ainda rodam; começar a hora seguinte nesse intervalo deixava o
  cromo e a aba da hora anterior chegarem por cima. A rotação espera um contador
  de fechamentos em curso zerar (teto de 120 s).
- **Uma partida que falha também suspende até a próxima hora.** Sem isso, uma
  permissão de Gravação de Tela negada repetia o aviso a cada 15 s o dia inteiro.
  «Retomar o dia gravado» tenta de novo antes.
- **Escolhas onde a ADR era silenciosa:** desligar no meio da janela encerra a
  gravação do dia; uma reunião manual nunca é encerrada pelo fim da janela; uma
  janela com início ≥ fim é recusada (`err.workday_invalid_window`) em vez de
  atravessar a meia-noite, e `24:00` vale como fim do dia; `dias` não aparece na
  tela (só no arquivo); «Retomar o dia gravado» está na paleta, não na bandeja (os
  rótulos da bandeja são do backend e o menu tem três itens fixos).
- **Não verificado sem rodar o app:** que o `setInterval` do WKWebView continue a
  15 s com a janela escondida por horas (App Nap / throttling de timers de uma
  webview oculta); a asserção do `caffeinate` em `pmset -g assertions`; uma
  rotação real com captura de sistema e microfone.
