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
JS_SRC := desktop/src/app.js desktop/src/shell.js desktop/src/overlay.js desktop/src/text.js desktop/src/audio.js desktop/src/mdedit.js desktop/src/review.js desktop/src/workspace.js desktop/src/loops.js desktop/src/update.js

.PHONY: help test test-rust test-js test-cli test-layout test-ui lint fmt build app test-docker syscap vendor-cm6 require-rust release

help: ## Show this help menu
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

test: test-cli test-rust test-js ## Run the full suite (CLI + Rust + JS)

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

lint: ## Lint: clippy (deny warnings) + rustfmt --check + node --check on the JS sources
	cargo clippy --manifest-path desktop/src-tauri/Cargo.toml -- -D warnings
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
	@for f in $(JS_SRC); do echo "node --check $$f"; node --check $$f; done

fmt: ## Format the Rust code (cargo fmt)
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml

syscap: ## Compile the macOS system-audio capturer (ScreenCaptureKit, ADR-0005)
	swiftc -O desktop/src-tauri/syscap/loro-syscap.swift -o desktop/src-tauri/syscap/loro-syscap

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
