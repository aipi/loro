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

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
