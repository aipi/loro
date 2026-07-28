# Loro — app desktop (Tauri)

App nativo (Tauri v2) de transcrição ao vivo. O backend em Rust executa o
`whisper-stream` já compilado e transmite a saída para o frontend via eventos.
O frontend é HTML/CSS/JS puro (sem framework nem bundler), usando apenas o
global `window.__TAURI__`.

## Estrutura

```
desktop/
├─ src/                        frontend (servido estático)
│  ├─ index.html               janela principal (superfície única)
│  ├─ overlay.html/.js         janela de legenda flutuante
│  ├─ app.js                   estado, eventos, onda de áudio, gravação
│  ├─ text.js                  utilidades de texto/markdown (testável, UMD)
│  └─ style.css                sistema de design (mono/hairline, tema do sistema)
├─ tests/text.test.js          testes JS (node --test)
└─ src-tauri/
   ├─ src/lib.rs               comandos + spawn + tray + atalho global
   ├─ tauri.conf.json          janelas, CSP, bundle, ícones
   ├─ capabilities/default.json permissões
   ├─ Info.plist               NSMicrophoneUsageDescription (macOS)
   └─ icons/                   ícones (fonte: parrot-src.svg)
```

## Contrato backend ↔ frontend

**Comandos** (`invoke`):

| Comando | Args | Retorno | Função |
|---|---|---|---|
| `start` | `cfg: {model, lang, translate, threads}` | `()` / erro | spawna whisper-stream |
| `stop` | — | `()` | mata o processo |
| `save_transcript` | `content` | caminho salvo ou `null` | diálogo nativo + grava |
| `save_recording` | `data: bytes, filename` | caminho | grava áudio p/ diarizar |
| `diarize` | `audioPath` | Markdown | roda `loro.sh diarize` |
| `toggle_overlay` | `show: bool` | `()` | mostra/oculta a legenda |
| `client_log` | `msg` | — | diagnóstico → `loro-client.log` |
| `selftest_enabled` | — | `bool` | true se `LORO_SELFTEST` setado |
| `pick_folder` | — | caminho ou `null` | seletor nativo de pasta |
| `default_save_dir` | — | caminho | pasta padrão (`<acervo>/inbox`) |
| `auto_save` | `content, dir, filename` | caminho | grava sem diálogo (auto-save) |
| `list_capture_devices` | — | `[{index,name}]` | dispositivos de captura (índices do `-c`) |
| `brain_get_config` | — | config ou `null` | lê `~/.loro/config.json` |
| `brain_setup` | `dir, contexts[]` | config | cria a estrutura do acervo + config |
| `brain_add_context` | `name` | config | adiciona contexto (pasta + seeds) |
| `brain_remove_context` | `name` | config | remove da lista (pasta preservada) |
| `brain_import` | `context?` | nº copiados | seletor multi-arquivo → inbox (prefixo `<ctx>--`) |
| `brain_delete_inbox` | `name` | `()` | apaga pendente da inbox (nunca será processado) |
| `brain_write_inbox` | `name, content` | `()` | edita item pendente da fila |
| `brain_write` | `rel, content` | `()` | edita qualquer .md/.txt do acervo (anti-traversal) |
| `brain_list_dir` | `rel` | entradas | lista um nível de diretório (árvore) |
| `brain_read_guide` / `brain_write_guide` | — / `content` | texto / `()` | instruções do loop (`inbox/_prompt.md`) |
| `brain_status` | — | status | contextos/entradas, inbox, processadas, atividade |
| `brain_read` | `rel` | conteúdo | lê arquivo dentro do acervo (anti-traversal) |

**Eventos** (`emit` → `listen`):

| Evento | Payload | Significado |
|---|---|---|
| `transcript-line` | `string` | novo trecho transcrito |
| `rec-state` | `bool` | gravando / parado (fonte da verdade da UI) |
| `hotkey-toggle` | — | atalho global ou item do tray acionado |

Resolução de caminhos: `LORO_PROJECT_DIR` (o `loro.sh` exporta) ou fallback
`~/Desktop/dente/loro`; `WHISPER_STREAM_BIN` sobrescreve o binário.

## Desenvolvimento

```bash
# a partir da raiz do projeto:
./loro.sh app          # = npm --prefix desktop run tauri dev
./loro.sh app-build    # = npm --prefix desktop run tauri build
./loro.sh test         # cargo test --lib + node --test
```

Dev direto:
```bash
cd desktop
LORO_PROJECT_DIR=/caminho/para/loro npm run tauri dev
```

## Testes

- **Rust** (`cargo test --lib`): `extract_text` (parsing das linhas do
  whisper-stream), `stream_args` (montagem de argumentos), resolução de caminhos.
- **JS** (`npm test`): `esc`/`mdInline` de `src/text.js`.

## Diagnóstico

- `LORO_SELFTEST=1` faz o app rodar um ciclo automático start→(7s)→stop no load,
  logando em `loro-client.log` — útil para validar o pipeline sem interação.
- `loro-engine.log` recebe o stderr do whisper-stream (erros de dyld, áudio,
  carga de modelo).

## Empacotamento / distribuição

`tauri build` gera `.app`+`.dmg` (macOS), `.msi` (Windows), `.deb`/AppImage
(Linux). O app é assinado ad-hoc por padrão (POC).

⚠️ O bundle **não** inclui o `whisper-stream` nem os modelos — ele os localiza em
`LORO_PROJECT_DIR`. Para um app autocontido em outra máquina, empacote o
`whisper-stream` + libs como **sidecar** (`tauri.conf.json > bundle > externalBin`)
e o modelo como resource. Ver "roadmap" no README raiz.

## Fonte de áudio (mic × sistema)

A config **fonte** escolhe entre microfone e áudio do sistema. Em `system`, o
frontend chama `list_capture_devices`, acha o dispositivo cujo nome casa
`/blackhole/i` e passa seu índice como `capture` no `StartCfg` → o backend
adiciona `-c <índice>` ao whisper-stream. O medidor/onda tenta captar o próprio
BlackHole via `getUserMedia({deviceId})` (best-effort; sem isso a onda fica
parada, mas o ponto/tray/timer continuam indicando gravação). Setup do driver:
`./loro.sh sysaudio-setup`.

## Acervo (aba "acervo")

O Loro é genérico: ele gera um **acervo de contextos** definidos pelo usuário
(nenhuma taxonomia embutida). Na primeira execução, um wizard pergunta **onde
gerar** e **quais contextos**; `brain_setup` cria a estrutura autocontida
(guia.md + CHANGELOG.md + brainstorming/ por contexto, CLAUDE.md, skill /brain)
— e **respeita estrutura existente** (só completa lacunas; ADR-0001 §4).

Depois do setup, a aba é um **shell estilo site de documentação**:
- **Lateral esquerda (árvore):** *visão geral* · **fila** (pendentes; itens de
  texto são **editáveis** ✎, com apagar em 2 cliques) · **contextos** (expandem
  em guia do domínio / histórico / brainstorming) · **fontes** (reuniões e notas
  **agrupadas por mês**, para escalar com listas grandes).
- **Centro:** a visão geral traz stats (na fila/processadas/contextos/fontes),
  ações claras ("＋ enviar arquivos" com direcionamento de contexto; "✎ instruções
  do loop" = `inbox/_prompt.md`) e a atividade do loop. Abrir um arquivo mostra
  breadcrumb + selo da natureza do arquivo (pendente / regenerado pelo loop /
  histórico) + **modos visualizar|editar**: qualquer `.md`/`.txt` do acervo pode
  ser editado inline (`brain_write`, path-guarded); o guia avisa que edições
  podem ser sobrescritas na próxima regeneração. O renderizador cobre markdown
  completo (h1–h6, tabelas, blockquote, listas aninhadas/ordenadas, task lists,
  tachado, imagens http/data, código com linguagem) com escape seguro.

## Comportamento de segundo plano e tray

- **Fechar a janela não encerra o app**: ela é escondida e o Loro segue vivo na
  barra de menu. Sair só pelo menu do tray ("Sair") ou **⌘Q**. Clicar no ícone
  do Dock reabre a janela (macOS `RunEvent::Reopen`).
- **Tray**: silhueta do papagaio como *template icon* (`icons/tray-on.png` +
  `tray-dim.png`, gerados de `tray-src.svg`) — o macOS a renderiza branca/preta
  conforme o tema, sem fundo. Uma thread pisca o ícone (~2 Hz alternando as duas
  versões) enquanto `AppState.recording` estiver ativo. Menu: Abrir Loro ·
  Iniciar/Parar transcrição · Sair.
- **Configurações persistidas** (`localStorage`, chave `loro-settings`, mescladas
  por `mergeSettings` de `text.js`): modelo, idioma, tradução, auto-scroll,
  **auto-save** e **pasta de armazenamento**. Com auto-save ligado, ao parar a
  sessão o texto é gravado direto em `<pasta>/loro-<timestamp>.md` (comando
  `auto_save`, nome validado por `is_safe_filename`); sem ele, a barra
  salvar/descartar aparece como antes.

## Design

Tese: **"o papagaio se acende quando ouve"** — a onda de áudio é o indicador de
gravação e ganha o gradiente de plumagem (teal→amarelo→vermelho, cores do ícone)
quando detecta fala; cinza enquanto só ouve; pontilhada parada.

- Tokens em `src/style.css` (`:root` claro + `prefers-color-scheme: dark`):
  papel-creme `#fbfaf6` no claro, teal profundo `#121719` no escuro.
- Wordmark `loro●` no topo — o ponto é o estado de gravação (pulsa em vermelho).
- Layout dos controles: **play à esquerda**, onda ao centro, badge de
  privacidade à direita (oculta <440px). Espaçamentos com `clamp()`.
- Mono (`SF Mono`) nos rótulos/timers; sans do sistema no texto transcrito.
- `prefers-reduced-motion` respeitado; foco visível em teal.

## Ícone

Fonte em `src-tauri/icons/parrot-src.svg`. Para regenerar todos os tamanhos:
```bash
qlmanage -t -s 1024 -o /tmp icons/parrot-src.svg      # SVG -> PNG 1024
cd desktop && npx tauri icon /tmp/parrot-src.svg.png  # gera .icns/.ico/PNGs
```
