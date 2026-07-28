---
name: loro-release-checklist
description: Readiness checklist before packaging/shipping a Loro release. Use before `make build`/`tauri build` or cutting a version. Verifies tests, lint, footprint, no vendored engine, no temp files, logging and security posture.
---

# Loro release checklist

Run these checks and produce a report (✅/⚠️/❌ per item, with the file/command and
how to fix). Do not ship on any ❌.

## 1. Tests & lint green
- `make test` (cargo test + node --test) passes.
- `make lint` (`cargo clippy -- -D warnings`, `node --check`) passes.
- `cargo fmt --check` clean.
- **Fix:** address failures; every touched `BR-` has a named test.

## 2. No vendored engine, no heavy artifacts (ADR-0003)
- `git status` / tree shows **no** `whisper.cpp/` and no `target/`, `node_modules/`,
  `.venv/`, `transcripts/`, `*.log` tracked. `grep -r "whisper.cpp" desktop/src*` empty.
- **Fix:** remove and add to `.gitignore`.

## 3. Engine resolved from the system
- Binaries resolve via `PATH` / `WHISPER_STREAM_BIN` — no hardcoded fork/personal paths.
- **Fix:** route through `~/.loro/config.json` and env.

## 4. No brand / no `stt` leftovers
- `grep -rIi -e "\bstt\b"` over code/docs (excluding upstream whisper) returns
  nothing; no company/brand names leak into the generic product; bundle
  identifier is generic.
- **Fix:** rename to `loro`.

## 5. Logging & security posture (ADR-0011)
- Logs are structured, English, and contain no transcript content / PII / secrets.
- Restrictive CSP present; command allowlist minimal; `brain_read`/filename guards in place.
- **Fix:** scrub logs; tighten capabilities.

## 6. Footprint
- Idle app ≈ 0% CPU; bundle size reasonable (report `.app`/`.dmg` size).
- **Fix:** investigate leaks (audio/analyser released on stop; polling backoff).

## 7. Docs current
- PRD/ARCHITECTURE/ADRs reflect the release; any new non-trivial decision has an ADR.

## Expected output
A short report per section, the overall verdict (ship / do not ship), and the exact
commands run.
