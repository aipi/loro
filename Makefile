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
JS_SRC := desktop/src/app.js desktop/src/overlay.js desktop/src/text.js desktop/src/audio.js

.PHONY: help test test-rust test-js lint fmt build app test-docker syscap vendor-cm6

help: ## Show this help menu
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

test: test-rust test-js ## Run the full suite (Rust + JS)

test-rust: ## Run the Rust backend tests (cargo test)
	cd desktop/src-tauri && cargo test

test-js: ## Run the JS frontend tests (node --test)
	cd desktop && node --test tests/*.test.js

lint: ## Lint: clippy (deny warnings) + rustfmt --check + node --check on the JS sources
	cargo clippy --manifest-path desktop/src-tauri/Cargo.toml -- -D warnings
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
	@for f in $(JS_SRC); do echo "node --check $$f"; node --check $$f; done

fmt: ## Format the Rust code (cargo fmt)
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml

syscap: ## Compile the macOS system-audio capturer (ScreenCaptureKit, ADR-0005)
	swiftc -O desktop/src-tauri/syscap/loro-syscap.swift -o desktop/src-tauri/syscap/loro-syscap

build: syscap ## Build the production app bundle (tauri build)
	cd desktop && npm run tauri build

app: syscap ## Run the app in development mode (tauri dev)
	cd desktop && npm run tauri dev

test-docker: ## Run the test suite inside Docker (reproducible/headless)
	docker compose -f docker-compose.test.yml run --rm test

vendor-cm6: ## Rebuild the vendored CodeMirror 6 IIFE (dev-only, ADR-0008; never shipped)
	cd tools/vendor-cm6 && npm ci && node build.mjs
