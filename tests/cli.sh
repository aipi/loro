#!/bin/bash
#
# tests/cli.sh — regression tests for loro.sh, run under the SYSTEM bash.
#
# macOS ships bash 3.2.57 (frozen for licensing). Under `set -u`, expanding an
# empty array as a plain "${arr[@]}" aborts with "unbound variable" — a class of
# bug that never shows up under the bash 5 used in CI/Docker. These tests drive
# loro.sh through /bin/bash so that portability floor is actually exercised.
#
# Pure shell: no bats/shellspec dependency. Run via `./loro.sh test` or make.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SYS_BASH="/bin/bash"   # the stock macOS bash we must not regress against

pass=0 fail=0
ok()  { pass=$((pass + 1)); printf '  \033[1;32mok\033[0m   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  \033[1;31mFAIL\033[0m %s\n' "$1"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Stub engine: record the exact args it was called with, then exit cleanly —
# no real inference, so the test is fast and offline.
stub="$work/whisper-stream"
cat >"$stub" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >"$WHISPER_STUB_ARGS"
exit 0
STUB
chmod +x "$stub"

# A present model file so cmd_live's existence check passes.
models="$work/models"; mkdir -p "$models"
: >"$models/ggml-large-v3-turbo.bin"
args_file="$work/args.txt"

run_live() {  # SOURCE=$1 -> captures combined output, sets global rc
  out="$(SOURCE="$1" \
    WHISPER_STREAM_BIN="$stub" \
    WHISPER_STUB_ARGS="$args_file" \
    LORO_MODELS_DIR="$models" \
    OUTDIR="$work/transcripts" \
    "$SYS_BASH" "$ROOT/loro.sh" live 2>&1)"
  rc=$?
}

printf 'loro.sh CLI tests — %s\n' "$($SYS_BASH --version | head -1)"

# --- #1: `live` (mic) must not abort under bash 3.2 nounset ------------------
: >"$args_file"
run_live mic
[ "$rc" -eq 0 ] \
  && ok "live (mic) exits 0 under system bash" \
  || bad "live (mic) exited $rc: $out"

case "$out" in
  *"unbound variable"*) bad "live (mic) hit 'unbound variable' (empty array under set -u)" ;;
  *)                    ok  "live (mic) free of unbound-variable error" ;;
esac

# The engine must be reached with -f and WITHOUT a -c device flag (mic has none).
recorded="$(cat "$args_file" 2>/dev/null || true)"
case "$recorded" in
  *"-c "*) bad "mic branch leaked a -c device flag: $recorded" ;;
  *"-f "*) ok  "mic branch invoked engine with -f and no -c" ;;
  *)       bad "engine not invoked as expected: '$recorded'" ;;
esac

# --- download_model: a bad download must never reach the final path ----------
#
# Regression. `curl -o "$dest"` wrote straight to the model path, so a
# Ctrl-C or a dropped connection left a truncated ggml-*.bin that the app read
# as an installed model; whisper then aborted inside every recording with "not
# all tensors loaded from model file".
#
# Stub curl (first on PATH) so these run offline and we control the failure.
mkdir -p "$work/bin"
cat >"$work/bin/curl" <<'STUB'
#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) shift; out="$1" ;; esac
  shift
done
case "$CURL_MODE" in
  truncated) printf 'partial-body' >"$out"; exit 1 ;;  # connection dropped mid-stream
  garbage)   printf 'not-a-model'  >"$out"; exit 0 ;;  # completes, wrong bytes
  *)         printf 'model-bytes'  >"$out"; exit 0 ;;
esac
STUB
chmod +x "$work/bin/curl"

dlmodels="$work/dlmodels"; mkdir -p "$dlmodels"
# $0 must be loro.sh itself: sourcing runs its dispatch, whose no-arg branch
# greps $0 for the help header — and under `set -e` a failing grep aborts.
run_download() {  # $1 = CURL_MODE, $2 = model id -> sets rc, out
  out="$(CURL_MODE="$1" PATH="$work/bin:$PATH" LORO_MODELS_DIR="$dlmodels" \
    "$SYS_BASH" -c '. "$1" >/dev/null 2>&1; download_model "$2"' \
    "$ROOT/loro.sh" "$ROOT/loro.sh" "$2" 2>&1)"
  rc=$?
}

run_download truncated small
[ "$rc" -ne 0 ] \
  && ok "interrupted download exits non-zero" \
  || bad "interrupted download reported success: $out"
[ ! -e "$dlmodels/ggml-small.bin" ] \
  && ok "interrupted download leaves no file at the model path" \
  || bad "interrupted download left a truncated model behind"
[ ! -e "$dlmodels/ggml-small.bin.part" ] \
  && ok "interrupted download cleans up its .part file" \
  || bad "interrupted download left $dlmodels/ggml-small.bin.part behind"

run_download garbage small
[ "$rc" -ne 0 ] \
  && ok "checksum mismatch exits non-zero" \
  || bad "checksum mismatch reported success: $out"
[ ! -e "$dlmodels/ggml-small.bin" ] \
  && ok "checksum mismatch installs nothing" \
  || bad "a model that failed SHA-256 was installed anyway"
case "$out" in
  *"SHA-256"*) ok  "checksum mismatch says so" ;;
  *)           bad "checksum mismatch message unclear: $out" ;;
esac

# A model the catalog does not pin still installs — the CLI has always taken any
# ggml id — but it must say the integrity check was skipped.
run_download ok medium
[ "$rc" -eq 0 ] && [ -f "$dlmodels/ggml-medium.bin" ] \
  && ok "an unpinned model still installs" \
  || bad "unpinned model install failed (rc=$rc): $out"
[ ! -e "$dlmodels/ggml-medium.bin.part" ] \
  && ok "a successful install moves the .part into place" \
  || bad "the .part file survived a successful install"
case "$out" in
  *"without integrity verification"*) ok  "unpinned model warns about the skipped check" ;;
  *)                                  bad "unpinned model installed silently: $out" ;;
esac

# The digests the app pins must be reachable from the CLI (the Rust test
# `loro_sh_pins_every_catalog_sha256` guards the other direction).
for m in small large-v3-turbo; do
  d="$("$SYS_BASH" -c '. "$1" >/dev/null 2>&1; model_sha256 "$2"' \
    "$ROOT/loro.sh" "$ROOT/loro.sh" "$m" 2>/dev/null)"
  case "$d" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
      [ "${#d}" -eq 64 ] && ok "$m has a pinned sha256" || bad "$m digest is ${#d} chars, want 64" ;;
    *) bad "$m has no pinned sha256 in loro.sh" ;;
  esac
done

# --- the version must be the same in every file that carries it --------------
#
# tauri.conf.json is canonical (release.yml reads it), but four other files
# repeat the number. package.json and package-lock.json were left out of
# prepare-release.sh and drifted to 0.7.0 while the app shipped 0.9.1 — nothing
# broke, which is exactly why nobody noticed. Asserting it here means the next
# release PR goes red instead of drifting.
versions="$(
  python3 - "$ROOT" <<'PY'
import json, re, sys
root = sys.argv[1]
def j(path, *keys):
    d = json.load(open(f"{root}/{path}"))
    for k in keys:
        d = d[k]
    return path, d
out = [
    j("desktop/src-tauri/tauri.conf.json", "version"),
    j("desktop/package.json", "version"),
    j("desktop/package-lock.json", "version"),
    j("desktop/package-lock.json", "packages", "", "version"),
]
toml = open(f"{root}/desktop/src-tauri/Cargo.toml").read()
out.append(("desktop/src-tauri/Cargo.toml", re.search(r'(?m)^version = "([^"]+)"', toml).group(1)))
lock = open(f"{root}/desktop/src-tauri/Cargo.lock").read()
m = re.search(r'\[\[package\]\]\nname = "desktop"\nversion = "([^"]+)"', lock)
out.append(("desktop/src-tauri/Cargo.lock", m.group(1)))
for path, v in out:
    print(f"{v}\t{path}")
PY
)"
distinct="$(printf '%s\n' "$versions" | cut -f1 | sort -u | wc -l | tr -d ' ')"
if [ "$distinct" = "1" ]; then
  ok "every version file agrees ($(printf '%s\n' "$versions" | head -1 | cut -f1))"
else
  bad "version files disagree:"
  printf '%s\n' "$versions" | sed 's/^/         /' >&2
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
