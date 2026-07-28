#!/usr/bin/env bash
#
# loro.sh — Loro CLI (local speech-to-text + knowledge base)
#
# The transcription engine (whisper) is a SYSTEM dependency (see ADR-0003):
# binaries come from PATH (or WHISPER_STREAM_BIN / WHISPER_CLI_BIN); models live
# in ~/.loro/models. This script does not build or vendor whisper.
#
# Usage:
#   ./loro.sh setup            Install the engine + download models
#   ./loro.sh live             Live transcription -> file (SOURCE=mic|system)
#   ./loro.sh devices          List capture devices (index for -c)
#   ./loro.sh sysaudio-setup   Install/guide BlackHole for system-audio capture
#   ./loro.sh file <path>      Transcribe an audio file
#   ./loro.sh setup-diarize    Install WhisperX/pyannote in a venv (heavy, optional)
#   ./loro.sh diarize <file>   Transcribe + speaker separation -> Markdown
#   ./loro.sh app              Run the desktop app (Tauri) in dev mode
#   ./loro.sh app-build        Build the desktop app (.app/.dmg)
#   ./loro.sh test             Run the tests (Rust + JS)
#   ./loro.sh doctor           Report the detected environment
#
# Env (with defaults):
#   MODEL=large-v3-turbo       ggml model (small|medium|large-v3|large-v3-turbo…)
#   LANG_LORO=pt               language (pt, en, auto…)
#   THREADS=<auto>             inference threads
#   OUTDIR=transcripts         scratch output dir
#   LORO_MODELS_DIR=~/.loro/models
#   WHISPER_STREAM_BIN / WHISPER_CLI_BIN   engine overrides
#   STEP=0 LENGTH=5000 VAD_THOLD=0.6       whisper-stream tuning

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- config -----------------------------------------------------------------
MODEL="${MODEL:-large-v3-turbo}"
LANG_CODE="${LANG_LORO:-pt}"
OUTDIR="${OUTDIR:-transcripts}"
MODELS_DIR="${LORO_MODELS_DIR:-$HOME/.loro/models}"
SOURCE="${SOURCE:-mic}"                 # mic | system (system audio via BlackHole)
STEP="${STEP:-0}"
LENGTH="${LENGTH:-5000}"
VAD_THOLD="${VAD_THOLD:-0.6}"

# diarization (optional, heavy): Python venv + WhisperX/pyannote
VENV="${VENV:-.venv}"
PYTHON="${PYTHON:-python3}"
DIA_MODEL="${DIA_MODEL:-large-v3}"

BIN_STREAM="${WHISPER_STREAM_BIN:-whisper-stream}"   # resolved via PATH
BIN_CLI="${WHISPER_CLI_BIN:-whisper-cli}"

HF_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# ---- helpers ----------------------------------------------------------------
c_info() { printf '\033[1;34m[loro]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[1;32m[ok]\033[0m %s\n'  "$*"; }
c_warn() { printf '\033[1;33m[!]\033[0m %s\n'   "$*" >&2; }
c_err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }
die()    { c_err "$*"; exit 1; }
have()   { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

detect_threads() {
  if [ -n "${THREADS:-}" ]; then echo "$THREADS"; return; fi
  local n
  case "$OS" in
    Darwin) n="$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.ncpu)";;
    Linux)  n="$(nproc 2>/dev/null || echo 4)";;
    *)      n=4;;
  esac
  [ "$n" -gt 8 ] && n=8
  echo "$n"
}
THREADS_N="$(detect_threads)"

model_path() { echo "$MODELS_DIR/ggml-$1.bin"; }
need_engine() { have "$BIN_STREAM" || die "whisper-stream not found. Run ./loro.sh setup (installs whisper-cpp)."; }

# ---- doctor -----------------------------------------------------------------
cmd_doctor() {
  c_info "OS: $OS | Arch: $ARCH | Threads: $THREADS_N"
  c_info "Model: $MODEL | Lang: $LANG_CODE | Models dir: $MODELS_DIR"
  for t in whisper-stream whisper-cli ffmpeg; do
    if have "$t"; then c_ok "$t: $(command -v "$t")"; else c_warn "$t: missing"; fi
  done
  [ -f "$(model_path "$MODEL")" ] && c_ok "model $MODEL: present" || c_warn "model $MODEL: missing"
}

# ---- setup: engine + models -------------------------------------------------
download_model() {
  local m="$1" dest
  dest="$(model_path "$m")"
  if [ -f "$dest" ]; then c_ok "model $m already present"; return; fi
  mkdir -p "$MODELS_DIR"
  c_info "downloading model $m -> $dest"
  curl -L --fail --progress-bar "$HF_BASE/ggml-$m.bin" -o "$dest" \
    || die "failed to download model $m"
}

cmd_setup() {
  case "$OS" in
    Darwin)
      have brew || die "Homebrew not found. Install from https://brew.sh and retry."
      have whisper-stream || { c_info "brew install whisper-cpp"; brew install whisper-cpp; }
      have ffmpeg || { c_info "brew install ffmpeg"; brew install ffmpeg; }
      ;;
    Linux)
      c_warn "Install the whisper.cpp CLI for your distro (must provide whisper-cli and whisper-stream)."
      c_warn "Ensure ffmpeg is installed. Then set WHISPER_STREAM_BIN / WHISPER_CLI_BIN if not on PATH."
      ;;
    *) die "Unsupported OS for automatic setup: $OS";;
  esac
  download_model "$MODEL"
  [ "$MODEL" = "small" ] || download_model small   # low-latency fallback
  c_ok "setup complete. Try: ./loro.sh live"
  cmd_doctor
}

# ---- capture devices --------------------------------------------------------
# Prints "index<TAB>name" exactly as whisper-stream enumerates them (for -c).
# whisper-stream does not exit on its own: we list, wait, then kill it.
list_devices() {
  need_engine
  local m tmp pid i=0
  m="$(model_path small)"; [ -f "$m" ] || m="$(model_path "$MODEL")"
  tmp="$(mktemp)"
  "$BIN_STREAM" -m "$m" -c 999 >"$tmp" 2>&1 &
  pid=$!
  until grep -q "attempt to open" "$tmp" 2>/dev/null || [ "$i" -ge 60 ]; do i=$((i+1)); sleep 0.1; done
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  sed -n "s/.*Capture device #\([0-9]*\): '\(.*\)'.*/\1	\2/p" "$tmp"
  rm -f "$tmp"
}
cmd_devices() {
  c_info "capture devices (use the index in SOURCE/-c):"
  list_devices | while IFS=$'\t' read -r i n; do printf "  [%s] %s\n" "$i" "$n"; done
}
blackhole_index() { list_devices | awk -F'\t' 'tolower($2) ~ /blackhole/ {print $1; exit}'; }

# ---- live -------------------------------------------------------------------
cmd_live() {
  need_engine
  [ -f "$(model_path "$MODEL")" ] || die "model $MODEL missing. Run ./loro.sh setup"
  mkdir -p "$OUTDIR"
  local ts out cap=() src_label="microphone"
  ts="$(date +%Y%m%d-%H%M%S)"
  out="$OUTDIR/session-$ts.txt"
  if [ "$SOURCE" = "system" ]; then
    local bh; bh="$(blackhole_index)"
    [ -n "$bh" ] || die "BlackHole not found. Run ./loro.sh sysaudio-setup and route output to it."
    cap=(-c "$bh"); src_label="system audio (BlackHole #$bh)"
  fi
  c_info "Live [$MODEL/$LANG_CODE, $THREADS_N threads] · source: $src_label — Ctrl+C to stop"
  c_info "Saving transcript to: $out"
  "$BIN_STREAM" \
    -m "$(model_path "$MODEL")" \
    -l "$LANG_CODE" \
    --step "$STEP" --length "$LENGTH" -vth "$VAD_THOLD" \
    -t "$THREADS_N" \
    "${cap[@]}" \
    -f "$out"
}

# ---- system audio setup (BlackHole) -----------------------------------------
cmd_sysaudio_setup() {
  [ "$OS" = "Darwin" ] || die "Automatic sysaudio-setup is macOS-only (Linux: PulseAudio monitor; Windows: WASAPI loopback)."
  have brew || die "Homebrew required"
  if ! system_profiler SPAudioDataType 2>/dev/null | grep -qi blackhole; then
    c_info "installing BlackHole (virtual audio driver — may ask for your password)"
    brew install --cask blackhole-2ch
  else
    c_ok "BlackHole already installed"
  fi
  have SwitchAudioSource || brew install switchaudio-osx || true
  c_ok "BlackHole ready."
  c_warn "To hear AND transcribe, create a Multi-Output Device:"
  c_warn "  1) Open Audio MIDI Setup"
  c_warn "  2) + (bottom-left) -> Create Multi-Output Device"
  c_warn "  3) check your speakers AND 'BlackHole 2ch'"
  c_warn "  4) set that Multi-Output as the system output"
  c_warn "Then: SOURCE=system ./loro.sh live  (or pick 'system audio' in the app)"
  echo
  cmd_devices
}

# ---- file -------------------------------------------------------------------
cmd_file() {
  local src="${1:-}"
  [ -n "$src" ] || die "usage: ./loro.sh file <audio-path>"
  [ -f "$src" ] || die "file not found: $src"
  have "$BIN_CLI" || die "whisper-cli not found. Run ./loro.sh setup"
  have ffmpeg || die "ffmpeg missing. Run ./loro.sh setup"
  mkdir -p "$OUTDIR"
  local wav base
  base="$(basename "${src%.*}")"
  wav="$OUTDIR/${base}.16k.wav"
  c_info "converting to 16kHz mono WAV"
  ffmpeg -y -loglevel error -i "$src" -ar 16000 -ac 1 -c:a pcm_s16le "$wav"
  c_info "transcribing [$MODEL/$LANG_CODE]"
  time "$BIN_CLI" \
    -m "$(model_path "$MODEL")" \
    -l "$LANG_CODE" -t "$THREADS_N" \
    -f "$wav" -otxt -osrt -of "$OUTDIR/$base"
  c_ok "outputs: $OUTDIR/$base.txt and $OUTDIR/$base.srt"
}

# ---- diarization (optional) -------------------------------------------------
cmd_setup_diarize() {
  have "$PYTHON" || die "python3 not found"
  "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3,12) else 1)' \
    || die "Python >=3.12 required (current: $($PYTHON -V)). Use PYTHON=/path/to/python3.12"
  [ -d "$VENV" ] || { c_info "creating venv at $VENV"; "$PYTHON" -m venv "$VENV"; }
  c_info "installing whisperx (pulls torch + pyannote — large download)"
  "$VENV/bin/pip" install -q -U pip
  "$VENV/bin/pip" install -q whisperx
  c_ok "diarization ready."
  c_warn "pyannote is gated on Hugging Face. Before first use:"
  c_warn "  1) accept the licenses for pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0"
  c_warn "  2) authenticate YOURSELF: '! $VENV/bin/huggingface-cli login'  (or export HF_TOKEN=...)"
}

cmd_diarize() {
  local src="${1:-}"
  [ -n "$src" ] || die "usage: ./loro.sh diarize <audio-path>"
  [ -f "$src" ] || die "file not found: $src"
  [ -x "$VENV/bin/whisperx" ] || die "run ./loro.sh setup-diarize first"
  if [ -z "${HF_TOKEN:-}" ] && [ ! -f "$HOME/.cache/huggingface/token" ]; then
    die "pyannote is gated. Log in: '! $VENV/bin/huggingface-cli login' or export HF_TOKEN=..."
  fi
  have ffmpeg || die "ffmpeg missing. Run ./loro.sh setup"
  mkdir -p "$OUTDIR"
  local wav base
  base="$(basename "${src%.*}")"
  wav="$OUTDIR/${base}.16k.wav"
  c_info "converting to 16kHz mono WAV"
  ffmpeg -y -loglevel error -i "$src" -ar 16000 -ac 1 -c:a pcm_s16le "$wav"
  c_info "transcribing + diarizing [$DIA_MODEL/$LANG_CODE] — CPU int8, may take a while"
  "$VENV/bin/whisperx" "$wav" \
    --model "$DIA_MODEL" --language "$LANG_CODE" \
    --diarize --compute_type int8 \
    ${HF_TOKEN:+--hf_token "$HF_TOKEN"} \
    --output_dir "$OUTDIR" --output_format json
  c_info "generating speaker Markdown"
  "$VENV/bin/python" diarize_to_md.py "$OUTDIR/${base}.16k.json" > "$OUTDIR/${base}.diarized.md"
  c_ok "output: $OUTDIR/${base}.diarized.md"
}

# ---- desktop app (Tauri) ----------------------------------------------------
_cargo_path() { command -v cargo >/dev/null 2>&1 || export PATH="$HOME/.cargo/bin:$PATH"; }
cmd_app() {
  have node || die "Node.js required for the app"
  _cargo_path
  have cargo || die "Rust/cargo missing. Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  export LORO_PROJECT_DIR="$SCRIPT_DIR"   # used by the diarize handoff
  ( cd desktop && { [ -d node_modules ] || npm install; }; npm run tauri dev )
}
cmd_app_build() {
  _cargo_path
  have cargo || die "Rust/cargo missing."
  export LORO_PROJECT_DIR="$SCRIPT_DIR"
  ( cd desktop && { [ -d node_modules ] || npm install; }; npm run tauri build )
}
cmd_test() {
  _cargo_path
  c_info "Rust tests (backend)"
  ( cd desktop/src-tauri && cargo test --lib )
  c_info "JS tests (frontend)"
  ( cd desktop && { [ -d node_modules ] || npm install; }; npm test )
  c_ok "tests done"
}

# ---- dispatch ---------------------------------------------------------------
case "${1:-}" in
  setup)          cmd_setup ;;
  live)           cmd_live ;;
  file)           shift; cmd_file "${1:-}" ;;
  setup-diarize)  cmd_setup_diarize ;;
  diarize)        shift; cmd_diarize "${1:-}" ;;
  app)            cmd_app ;;
  app-build)      cmd_app_build ;;
  test)           cmd_test ;;
  devices)        cmd_devices ;;
  sysaudio-setup) cmd_sysaudio_setup ;;
  doctor)         cmd_doctor ;;
  *)              grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -32 ;;
esac
