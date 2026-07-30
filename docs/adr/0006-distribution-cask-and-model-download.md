# ADR-0006 — Distribution via Homebrew Cask + first-run model download

- **Status:** accepted (owner decisions, 2026-07-30)
- **Context:** up to ADR-0005 Loro shipped only as an unsigned `.dmg` attached to
  a GitHub Release, and the transcription models had to be fetched by hand
  (`./loro.sh setup`) before the app could transcribe anything. That is fine for
  developers but hostile to end users: two manual steps (drag the app, run a
  shell script) stand between download and first use. This ADR makes the desktop
  app installable with one command and ready to use on first launch, **without
  changing the privacy posture** (BR-1 local inference; BR-9 no stored
  credential).

## Decision

### §1 Homebrew Cask is the primary distribution channel (macOS, Apple Silicon)

Loro is published as a Homebrew **Cask** in a dedicated tap repo,
`aipi/homebrew-loro`:

```bash
brew tap aipi/loro
brew install --cask loro
```

- The cask declares `whisper-cpp` and `ffmpeg` as **formula dependencies**, so
  the transcription engine (a system dependency since ADR-0003, never vendored)
  is installed automatically alongside the app. `paths.rs` already resolves the
  Homebrew bin dirs, so the engine is found with no extra configuration.
- The cask template `packaging/homebrew/loro.rb.tmpl` in this repo is the single
  source of truth. The `.dmg` is the same artifact the release workflow already
  builds and attaches to the GitHub Release — the cask just points its `url` at
  that asset. No second build.
- The `.dmg` remains available for manual install. Code signing with an Apple
  Developer ID stays out of scope (owner decision, carried from the release
  workflow): the app is unsigned, so a manual `.dmg` install may still require
  clearing the quarantine attribute. Signing is future work.

### §2 Models are downloaded on first use, verified by SHA-256

The ggml models are **not** bundled in the app (they are 0.5–1.5 GB; bundling
would bloat every download and pin one model choice). Instead:

- A model registry (`models.rs`, `CATALOG`) lists the models Loro uses today —
  `large-v3-turbo` (default, most accurate) and `small` (fast, light) — each
  with a pinned **SHA-256** read from the HuggingFace LFS pointer. Adding a model
  later is a single row.
- `list_models` reports each model with its installed/missing state; the
  settings sheet renders a model manager with a **download button**, a progress
  bar, and a one-line explanation per model. When transcription is attempted with
  no model present, the app opens settings instead of only erroring.
- `download_model` streams the file over **HTTPS only** (`curl --proto =https`)
  into a `.part` temp file next to the destination, emitting
  `model-download-progress`. Before the file is placed it is checked against the
  pinned SHA-256; only on a match is it atomically renamed into
  `~/.loro/models`. A tampered, truncated, or wrong-mirror download is deleted
  and never becomes the active model. No new Rust crate is introduced: download
  uses system `curl`, integrity uses system `shasum`/`sha256sum`, matching the
  engine-is-a-system-tool stance.

**Security rationale (protect the user's machine):** the only host contacted is
the model mirror (default `huggingface.co`, overridable via `LORO_HF_BASE`);
inference stays 100% local (BR-1). Integrity verification means a compromised
mirror or a network MITM cannot silently substitute the model file.

### §3 Release automation bumps the cask (Opção A)

On a `v*` tag, after the GitHub Release is published, `release.yml` computes the
`.dmg`'s SHA-256, renders the cask template, and pushes `Casks/loro.rb` to the
tap repo, so `brew upgrade --cask loro` tracks the release.

- The cross-repo push uses a **`TAP_TOKEN`** secret — a fine-grained PAT with
  `Contents: write` scoped **only** to `aipi/homebrew-loro` (least privilege).
  The default `GITHUB_TOKEN` cannot write to another repo.
- The token is never printed or committed (**BR-9**). If `TAP_TOKEN` is absent
  the bump step is skipped and the GitHub Release still publishes; the cask is
  bumped by hand.

## Consequences

- One-command install; first launch downloads only the model the user picks.
- The manual `./loro.sh setup` path stays for CLI/dev use but is no longer part
  of the app's first-run story; release notes and the manual reflect this.
- New IPC surface: commands `list_models`, `download_model`; events
  `model-download-progress`, `model-download-done` (ARCHITECTURE §4).
- New error codes: `err.unknown_model`, `err.curl_missing`,
  `err.download_failed`, `err.model_checksum`, `err.models_dir`,
  `err.model_install`, `err.sha_tool_missing`.
- Windows/Intel/Linux distribution and Developer-ID signing remain future work.
