#!/usr/bin/env python3
"""Converte a saída JSON do WhisperX (com diarização) em Markdown legível,
agrupando falas consecutivas do mesmo locutor. Consumido pela UI (loro.sh ui).

Uso: python diarize_to_md.py <arquivo.json>  > saida.diarized.md
"""
import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("uso: diarize_to_md.py <arquivo.json>\n")
        return 2
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = json.load(fh)

    segments = data.get("segments", [])
    out = ["# Transcrição com locutores", ""]
    current = None
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            label = current or "SPEAKER"
            out.append(f"**{label}:** " + " ".join(buffer).strip())
            out.append("")

    for seg in segments:
        speaker = seg.get("speaker", "SPEAKER_?")
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        if speaker != current:
            flush()
            buffer.clear()
            current = speaker
        buffer.append(text)
    flush()

    if len(out) <= 2:
        out.append("_(sem segmentos — verifique o token HF e o áudio)_")

    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
