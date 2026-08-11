# Homebrew distribution (ADR-0006)

Loro is distributed for macOS (Apple Silicon) as a Homebrew **Cask**.

```bash
brew tap aipi/loro          # adds the aipi/homebrew-loro tap
brew install --cask loro    # installs Loro.app + whisper-cpp + ffmpeg
```

The cask declares `whisper-cpp` and `ffmpeg` as formula dependencies, so the
transcription engine is installed automatically. The ggml **models are not
bundled**: the app downloads the one you pick on first use (Settings → model),
streamed over HTTPS and verified against a pinned SHA-256 before it is placed in
`~/.loro/models`. This keeps the install light and inference 100% local (BR-1).

## Files

- `loro.rb.tmpl` — the **single source of truth** for the cask. The release
  workflow (`.github/workflows/release.yml`) renders `__VERSION__` and
  `__SHA256__` from the freshly built `.dmg` and publishes the result to the tap
  repo `aipi/homebrew-loro` as `Casks/loro.rb`. Never edit the tap copy by hand.

## Release automation (Opção A)

On a `v*` tag, after the GitHub Release is published, the workflow computes the
dmg's SHA-256, renders the template, and pushes `Casks/loro.rb` to the tap repo.

This cross-repo push needs a credential the default `GITHUB_TOKEN` does not
carry. Create it once:

1. GitHub → Settings → Developer settings → **Fine-grained personal access
   token**, scoped to **only** `aipi/homebrew-loro`, permission
   **Contents: Read and write**. Nothing else.
2. In `aipi/loro` → Settings → Secrets and variables → Actions, add a secret
   named **`TAP_TOKEN`** with that value.

The token is never printed or committed (BR-9). If `TAP_TOKEN` is absent the
bump step is skipped and the release still publishes; bump the cask by hand.
