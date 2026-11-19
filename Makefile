# Loro — Makefile
#
# Short targets for the development loop and for local/CI quality checks.
# Loro is a Tauri v2 desktop app: Rust backend in desktop/src-tauri (crate
# `desktop`), vanilla HTML/CSS/JS frontend in desktop/src with Node test-runner
# suites in desktop/tests. Requires: Rust (stable, with clippy + rustfmt) and
# Node 20+. Whisper is provided by the system — it is not vendored here.

# Put cargo/rustup binaries on PATH for every recipe (they live under
# ~/.cargo/bin and are not always exported in non-login shells / CI).
export PATH := $(HOME)/.cargo/bin:$(PATH)

# Vanilla JS frontend files that must at least parse (node --check).
JS_SRC := desktop/src/app.js desktop/src/shell.js desktop/src/bubble.js desktop/src/bubble-core.js desktop/src/agenda.js desktop/src/text.js desktop/src/audio.js desktop/src/interpreter.js desktop/src/interp-worklet.js desktop/src/readaloud.js desktop/src/mdedit.js desktop/src/review.js desktop/src/workspace.js desktop/src/loops.js desktop/src/update.js

.PHONY: help test test-rust test-js test-cli test-aec aec-speech test-layout test-ui lint lint-offmac fmt build app test-docker syscap vendor-cm6 require-rust release

help: ## Show this help menu
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

test: test-cli test-rust test-js test-aec ## Run the full suite (CLI + Rust + JS + echo canceller)

test-cli: ## Run loro.sh regression tests under the system bash (macOS bash 3.2 floor)
	/bin/bash tests/cli.sh

test-rust: ## Run the Rust backend tests (cargo test)
	cd desktop/src-tauri && cargo test

test-js: ## Run the JS frontend tests (node --test)
	cd desktop && node --test tests/*.test.js

# Deliberately NOT part of `test`: it needs a real browser, and `test` is
# portable. The header had three hand-measured breakpoints, each one
# measured once and each one outliving its measurement; this renders the shipped
# markup and sheet across widths so the claim can be re-checked instead of
# trusted. Skips with exit 0 when no Chrome/Chromium is installed.
test-layout: ## Measure the header across viewport widths (needs Chrome)
	node tools/measure-header.js --verbose

# Também FORA do `test`, e pela mesma razão: precisa de um navegador. Ele roda o
# index.html + app.js de verdade e exercita a superfície, que é a única forma de
# pegar um defeito de CARREGAMENTO (uma const na zona morta, um id que não existe,
# um innerHTML que lança) — a suíte portátil lê o fonte e não vê nenhum deles.
test-ui: ## Smoke the real UI in headless Chrome (needs Chrome)
	node tools/smoke-ui.js
	@# ADR-0041 — o balão é outra janela (bubble.html): clique vs arrasto, o selo que
	@# não pisca (medido em dois instantes) e o painel.
	node tools/smoke-bubble.js

lint: ## Lint: clippy (deny warnings) + rustfmt --check + node --check on the JS sources
	cargo clippy --manifest-path desktop/src-tauri/Cargo.toml -- -D warnings
	@# O clippy acima só vê o HOST, e é por isso que a PR #99 passou aqui e
	@# quebrou nos CIs de ubuntu e windows: 17 itens de `interpreter.rs` ficam sem
	@# chamador fora do macOS (o caminho de fala é macOS-only, ADR-0036 §6.5) e
	@# `-D warnings` os reprova como código morto. As dependências GTK do Tauri
	@# não compilam cruzado a partir do macOS, então checar o alvo de verdade não
	@# é opção — o que dá é DESLIGAR o cfg do macOS e checar o host, que reproduz
	@# exatamente a condição de "sem chamador" que quebrou.
	@$(MAKE) --no-print-directory lint-offmac
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
	@for f in $(JS_SRC); do echo "node --check $$f"; node --check $$f; done

# Checa a metade não-macOS do código: copia a árvore, troca o cfg do macOS por um
# alvo que não existe, e roda o clippy E OS TESTES. É a reprodução mais próxima
# possível sem um toolchain cruzado, e pega duas classes que só apareciam no CI:
#
#  1. código morto — 17 itens de `interpreter.rs` ficam sem chamador fora do
#     macOS, e `-D warnings` os reprova (a PR #99 quebrou por isso);
#  2. teste cego de plataforma — a PR #102 quebrou nos dois CIs por um `unwrap()`
#     num comando que RECUSA fora do macOS.
#
# O QUE ELE NÃO PEGA, e é bom saber: renomear só o cfg do macOS deixa `unix`
# verdadeiro no host, então ele reproduz LINUX, não Windows. Um `use` que sobra
# apenas no Windows (porque o item que o usava era `#[cfg(unix)]`) passa daqui e
# reprova lá — foi o último tropeço da #102. Para Windows, o CI é a medida.
#
# DUAS LIÇÕES da primeira versão deste alvo, que era pior que não existir:
#  - copiar uma LISTA de arquivos deixava o `templates/` de fora, e o código o
#    embute por `include_str!`: 50 erros de compilação, nenhum deles de
#    plataforma. Copia-se a árvore inteira, menos o `target/`.
#  - filtrar a saída por padrões de erro fazia o alvo PASSAR quando nada
#    compilava. Vale o código de saída; a filtragem é só para mostrar o que
#    importa.
#  - e o `desktop/src` entra na cópia porque `tauri.conf.json` tem
#    `frontendDist: "../src"`, um caminho que aponta para FORA de `src-tauri`:
#    sem ele o `generate_context!` estoura antes de qualquer análise. O `loro.sh`
#    entra pela mesma razão: um teste do catálogo de modelos lê
#    `CARGO_MANIFEST_DIR/../../loro.sh` para garantir que os SHA-256 não divergem —
#    e é por isso que a cópia espelha `desktop/src-tauri/`, e não `src-tauri/` na
#    raiz: os caminhos relativos do código contam a partir dessa profundidade.
lint-offmac: ## Clippy AND tests with the macOS path off (catches non-macOS dead code and platform-blind tests)
	@t=$$(mktemp -d) && mkdir -p "$$t/desktop" \
	  && rsync -a --exclude target/ desktop/src-tauri/ "$$t/desktop/src-tauri/" \
	  && rsync -a desktop/src/ "$$t/desktop/src/" \
	  && cp loro.sh "$$t/loro.sh" \
	  && sed -i.bak 's/target_os = "macos"/target_os = "loro-offmac"/g' "$$t"/desktop/src-tauri/src/*.rs \
	  && rm -f "$$t"/desktop/src-tauri/src/*.bak \
	  && cd "$$t/desktop/src-tauri" \
	  && { out=$$(cargo clippy --target-dir $(CURDIR)/desktop/src-tauri/target/offmac \
	        -- -D warnings -A unexpected_cfgs 2>&1) ; rc=$$? ; \
	       if [ $$rc -ne 0 ] ; then echo "$$out" | grep -E "^error" | head -12 ; \
	         echo "^^ clippy reprova fora do macOS — e o CI de ubuntu/windows tambem"; \
	         cd - >/dev/null; rm -rf "$$t"; exit 1 ; fi ; \
	       out=$$(cargo test --target-dir $(CURDIR)/desktop/src-tauri/target/offmac 2>&1) ; rc=$$? ; \
	       if [ $$rc -ne 0 ] ; then \
	         echo "$$out" | grep -E "^error|FAILED|panicked at" | head -12 ; \
	         echo "^^ teste reprova fora do macOS — e o CI de ubuntu/windows tambem"; \
	         cd - >/dev/null; rm -rf "$$t"; exit 1 ; fi ; } \
	  && cd - >/dev/null && rm -rf "$$t" && echo "offmac ok"

fmt: ## Format the Rust code (cargo fmt)
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml

# ADR-0040 — the echo canceller of the meeting mic is speexdsp (vendored, BSD)
# plus a small C timeline (aec/loro_aec.c), compiled into the sidecar: no
# runtime dependency, nothing for the user to install.
SYSCAP_DIR := desktop/src-tauri/syscap
SYSCAP_BUILD := $(SYSCAP_DIR)/build
SPEEX := $(SYSCAP_DIR)/speexdsp
AEC_CFLAGS := -O2 -Wall -DFLOATING_POINT -DUSE_KISS_FFT -DEXPORT= -I$(SPEEX)/include -I$(SPEEX)/libspeexdsp -I$(SYSCAP_DIR)/aec
AEC_SRC := $(addprefix $(SPEEX)/libspeexdsp/,mdf.c preprocess.c fftwrap.c kiss_fft.c kiss_fftr.c filterbank.c) $(SYSCAP_DIR)/aec/loro_aec.c

# One object per source, rebuilt every time (seven small files): no stale-object
# class of bug for a binary that ships.
aec-objs:
	@mkdir -p $(SYSCAP_BUILD)
	@for f in $(AEC_SRC); do cc $(AEC_CFLAGS) -c $$f -o $(SYSCAP_BUILD)/$$(basename $$f .c).o || exit 1; done

# Swift only lets the file named main.swift carry top-level code when a module
# has more than one file; the sidecar's entry file keeps its name in the repo and
# is copied to main.swift for the build.
syscap: aec-objs ## Compile the macOS system-audio capturer (ScreenCaptureKit, ADR-0005; echo canceller, ADR-0040)
	cp $(SYSCAP_DIR)/loro-syscap.swift $(SYSCAP_BUILD)/main.swift
	swiftc -O -import-objc-header $(SYSCAP_DIR)/aec/loro_aec.h \
	  $(SYSCAP_BUILD)/main.swift $(SYSCAP_DIR)/aec/AecPipeline.swift $(SYSCAP_BUILD)/*.o \
	  -o $(SYSCAP_DIR)/loro-syscap

# ADR-0040 — the echo canceller, measured offline: a simulated laptop (speakers
# → room → mic, plus the person speaking) through the C canceller, and on macOS
# also through the Swift pipeline the sidecar runs above it (resampling, downmix,
# host-time placement). Fails below 20 dB of echo removed or if the person's own
# speech is attenuated. Portable C half: runs wherever `cc` exists.
test-aec: aec-objs ## Measure the meeting-mic echo canceller offline (ADR-0040)
	cc $(AEC_CFLAGS) $(SYSCAP_DIR)/aec/aec_eval.c $(SYSCAP_BUILD)/*.o -lm -o $(SYSCAP_BUILD)/aec_eval
	$(SYSCAP_BUILD)/aec_eval
	@if [ "$$(uname)" = Darwin ]; then \
	  swiftc -O -parse-as-library -import-objc-header $(SYSCAP_DIR)/aec/loro_aec.h \
	    $(SYSCAP_DIR)/aec/AecPipeline.swift $(SYSCAP_DIR)/aec/pipeline_eval.swift $(SYSCAP_BUILD)/*.o \
	    -o $(SYSCAP_BUILD)/pipeline_eval && $(SYSCAP_BUILD)/pipeline_eval; fi

# The same measurement on real speech (macOS `say`, pt-BR, two voices) — not part
# of `test` (needs `say` + ffmpeg). AEC_EVAL_OUT=<dir> also writes the WAVs.
aec-speech: test-aec ## Measure the echo canceller on synthesized pt-BR speech (macOS)
	@d=$$(mktemp -d) && \
	  say -v Luciana -o $$d/far.aiff "Bom dia pessoal, vamos começar a reunião de planejamento da semana. Primeiro eu queria revisar o orçamento da frota e depois falar dos atrasos na entrega dos carros novos. A gente precisa fechar essa conta até sexta feira sem falta." && \
	  say -v Luciana -o $$d/near.aiff "Concordo com você, mas acho que antes disso precisamos olhar os contratos de manutenção. Eu revisei ontem e tem três fornecedores com preço acima da média do mercado." && \
	  ffmpeg -y -loglevel error -i $$d/far.aiff -af "asetrate=22050*0.82,aresample=16000,atempo=1.2" -ac 1 -c:a pcm_s16le $$d/far.wav && \
	  ffmpeg -y -loglevel error -i $$d/near.aiff -ar 16000 -ac 1 -c:a pcm_s16le $$d/near.wav && \
	  $(SYSCAP_BUILD)/aec_eval $$d/far.wav $$d/near.wav && \
	  $(SYSCAP_BUILD)/pipeline_eval $$d/far.wav $$d/near.wav; rc=$$?; rm -rf $$d; exit $$rc

# npm deps are a real file prerequisite: on a fresh clone node_modules/.bin has
# no `tauri`, so `npm run tauri ...` fails with "sh: tauri: command not found".
desktop/node_modules: desktop/package.json
	cd desktop && npm install

# Fail fast with an actionable message when the Rust toolchain is absent —
# otherwise tauri dies mid-build with a cryptic "cargo metadata ... os error 2".
require-rust:
	@command -v cargo >/dev/null 2>&1 || { \
	  echo "Rust/cargo not found. Install it:"; \
	  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; \
	  echo "then open a new shell (or: source ~/.cargo/env) and re-run make."; \
	  exit 1; }

build: require-rust syscap desktop/node_modules ## Build the production app bundle (tauri build)
	cd desktop && npm run tauri build

app: require-rust syscap desktop/node_modules ## Run the app in development mode (tauri dev)
	cd desktop && npm run tauri dev

test-docker: ## Run the test suite inside Docker (reproducible/headless)
	docker compose -f docker-compose.test.yml run --rm test

vendor-cm6: ## Rebuild the vendored CodeMirror 6 IIFE (dev-only, ADR-0008; never shipped)
	cd tools/vendor-cm6 && npm ci && node build.mjs

release: ## Open a release PR that bumps the version (usage: make release VERSION=x.y.z)
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=x.y.z"; exit 1; }
	./scripts/prepare-release.sh $(VERSION)
