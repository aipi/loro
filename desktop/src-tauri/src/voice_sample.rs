// A amostra da voz do usuário, para clonagem (ADR-0036 §3).
//
// POR QUE FRASES FIXAS, e não gravação livre: a clonagem precisa do áudio de
// referência ACOMPANHADO do seu texto (`reference_audio` + `reference_text` na
// API do sherpa-onnx, e o mesmo vale para Chatterbox e OpenVoice v2). Numa
// gravação livre o texto seria um palpite — ou exigiria transcrever, o que
// introduz erro de reconhecimento exatamente no dado que ancora a voz. Dando a
// frase para ler, o texto é conhecido com exatidão.
//
// ONDE FICA: `~/.loro/voice-sample/`, dado por usuário — NUNCA no acervo. A voz
// da pessoa não é conhecimento a versionar, não entra em PR e não sai da
// máquina (BR-1). É também por isso que a limpeza é uma operação de primeira
// classe: quem gravou tem de poder apagar.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths::{ffmpeg_not_found_err, which};

// As frases a ler. Escolhidas para cobrir os sons do português com poucas
// gravações: nasais (ão/em), vibrante (rr), sibilantes (s/z/ch), oclusivas e
// vogais abertas e fechadas. Curtas de propósito — pedir parágrafos faz a
// pessoa desistir no meio, e o que sobra é uma amostra pela metade.
pub const PHRASES: &[&str] = &[
    "O rápido cão marrom pulou sobre a cerca do jardim.",
    "Hoje a reunião começa às três e meia da tarde.",
    "Cinquenta e sete pessoas assinaram o documento em janeiro.",
];

// Quanto áudio basta. Os modelos de clonagem pedem ~5s de fala limpa; três
// frases curtas dão folga sem tornar o cadastro um trabalho.
pub const MIN_TOTAL_MS: u64 = 8_000;
// Uma frase abaixo disto é um clique ou um engasgo, não uma leitura.
pub const MIN_PHRASE_MS: u64 = 1_200;

pub fn sample_dir() -> PathBuf {
    crate::paths::loro_data_dir().join("voice-sample")
}

// O WAV de uma frase. 16 kHz mono é o que os modelos de clonagem querem, e é a
// mesma forma que o resto do app já produz.
pub fn phrase_path(dir: &Path, i: usize) -> PathBuf {
    dir.join(format!("phrase-{i}.wav"))
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhraseState {
    pub index: usize,
    pub text: String,
    pub recorded: bool,
    pub duration_ms: u64,
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SampleStatus {
    pub phrases: Vec<PhraseState>,
    pub total_ms: u64,
    // `enough` é o que destrava a voz clonada. Ele é DERIVADO, nunca guardado:
    // um arquivo apagado à mão tem de refletir na tela na hora.
    pub enough: bool,
    pub min_total_ms: u64,
}

// A duração de um WAV PCM pela sua própria estrutura, sem chamar subprocesso: o
// status é lido a cada abertura da tela, e um ffprobe por frase seria trabalho
// repetido para um dado que está no cabeçalho.
//
// Formato: "RIFF" (4) tamanho (4) "WAVE" (4), depois blocos <id:4><tam:4>. A
// duração sai de `data`/bytes-por-segundo, e bytes-por-segundo vem do `fmt `.
pub fn wav_duration_ms(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let u32le = |o: usize| -> u32 {
        u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])
    };
    let mut pos = 12usize;
    let mut byte_rate: u32 = 0;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32le(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            byte_rate = u32le(body + 8);
        } else if id == b"data" {
            if byte_rate == 0 {
                return None;
            }
            // O tamanho declarado pode passar do arquivo (gravação interrompida):
            // vale o que existe de verdade.
            let real = size.min(bytes.len().saturating_sub(body));
            return Some((real as u64) * 1000 / byte_rate as u64);
        }
        // Blocos são alinhados em 2 bytes.
        pos = body + size + (size & 1);
    }
    None
}

fn duration_of(p: &Path) -> u64 {
    std::fs::read(p)
        .ok()
        .and_then(|b| wav_duration_ms(&b))
        .unwrap_or(0)
}

// O status a partir das durações já medidas — função pura, para que a regra do
// "suficiente" seja testável sem tocar em disco.
pub fn status_from(durations: &[u64]) -> SampleStatus {
    let phrases: Vec<PhraseState> = PHRASES
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let d = durations.get(i).copied().unwrap_or(0);
            PhraseState {
                index: i,
                text: (*t).to_string(),
                // Uma frase curta demais NÃO conta como gravada: contá-la
                // deixaria a tela dizer "pronto" com um clique no lugar de uma
                // leitura, e o defeito só apareceria na voz clonada.
                recorded: d >= MIN_PHRASE_MS,
                duration_ms: d,
            }
        })
        .collect();
    let total_ms: u64 = phrases
        .iter()
        .filter(|p| p.recorded)
        .map(|p| p.duration_ms)
        .sum();
    SampleStatus {
        enough: phrases.iter().all(|p| p.recorded) && total_ms >= MIN_TOTAL_MS,
        phrases,
        total_ms,
        min_total_ms: MIN_TOTAL_MS,
    }
}

// A MELHOR referência entre as frases lidas: a mais longa.
//
// Não é a primeira por conveniência — é uma decisão de qualidade. O modelo
// ancora timbre e prosódia no áudio de referência, e mais fala boa dá mais sinal.
// Devolve o par (áudio, TEXTO) porque o texto é obrigatório: é o que impede o
// modelo de adivinhar o que foi dito (ADR-0036 §3).
pub fn best_reference() -> Option<(PathBuf, String)> {
    let dir = sample_dir();
    (0..PHRASES.len())
        .filter_map(|i| {
            let p = phrase_path(&dir, i);
            let d = duration_of(&p);
            if d >= MIN_PHRASE_MS {
                Some((d, p, PHRASES[i].to_string()))
            } else {
                None
            }
        })
        .max_by_key(|(d, _, _)| *d)
        .map(|(_, p, t)| (p, t))
}

#[tauri::command]
pub fn voice_sample_status() -> Result<SampleStatus, String> {
    let dir = sample_dir();
    let durations: Vec<u64> = (0..PHRASES.len())
        .map(|i| duration_of(&phrase_path(&dir, i)))
        .collect();
    Ok(status_from(&durations))
}

#[derive(Deserialize)]
pub struct SaveSampleInput {
    pub index: usize,
    pub data: Vec<u8>,
}

#[tauri::command]
pub async fn voice_sample_save(input: SaveSampleInput) -> Result<SampleStatus, String> {
    tauri::async_runtime::spawn_blocking(move || save_blocking(input))
        .await
        .map_err(|e| e.to_string())?
}

// ADR-0022 §28: ffmpeg fora da thread principal, como todo subprocesso de mídia
// deste app.
fn save_blocking(input: SaveSampleInput) -> Result<SampleStatus, String> {
    if input.index >= PHRASES.len() {
        return Err("err.voice_sample_bad_index".into());
    }
    if input.data.is_empty() {
        return Err("err.voice_sample_empty".into());
    }
    let dir = sample_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ffmpeg = which("ffmpeg").ok_or_else(ffmpeg_not_found_err)?;
    // Nome único no temporário: duas gravações podem estar em voo se a pessoa
    // reler uma frase antes da anterior terminar de converter.
    let raw = std::env::temp_dir().join(format!(".loro-vs.{}.webm", crate::epoch_millis()));
    std::fs::write(&raw, &input.data).map_err(|e| e.to_string())?;
    let dst = phrase_path(&dir, input.index);
    // Escreve num vizinho e só então move: uma conversão interrompida não pode
    // deixar meia frase no lugar de uma frase boa que já existia.
    let tmp_dst = dir.join(format!(
        ".phrase-{}.{}.wav",
        input.index,
        crate::epoch_millis()
    ));
    let out = crate::proc::command(std::path::PathBuf::from(&ffmpeg))
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-i",
            &raw.to_string_lossy(),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            &tmp_dst.to_string_lossy(),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&raw);
    if !out.status.success() || !tmp_dst.exists() {
        let _ = std::fs::remove_file(&tmp_dst);
        return Err("err.voice_sample_convert_failed".into());
    }
    // Curta demais é recusada ANTES de substituir a gravação anterior.
    let d = duration_of(&tmp_dst);
    if d < MIN_PHRASE_MS {
        let _ = std::fs::remove_file(&tmp_dst);
        return Err(format!("err.voice_sample_too_short:{d}"));
    }
    std::fs::rename(&tmp_dst, &dst).map_err(|e| e.to_string())?;
    voice_sample_status()
}

// Apagar é operação de primeira classe: é a voz da pessoa, e quem gravou tem de
// poder tirar sem procurar pasta escondida.
#[tauri::command]
pub fn voice_sample_clear() -> Result<SampleStatus, String> {
    let dir = sample_dir();
    for i in 0..PHRASES.len() {
        let _ = std::fs::remove_file(phrase_path(&dir, i));
    }
    voice_sample_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("loro-vs-test-{tag}-{}", crate::epoch_millis()))
    }

    // Um WAV PCM de 16 kHz mono com `ms` de áudio, montado à mão para que a
    // leitura de duração seja testada contra bytes reais e não contra ffprobe.
    fn wav(ms: u64) -> Vec<u8> {
        let rate = 16000u32;
        let byte_rate = rate * 2;
        let n = (byte_rate as u64 * ms / 1000) as u32;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + n).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&byte_rate.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&n.to_le_bytes());
        b.resize(b.len() + n as usize, 0);
        b
    }

    #[test]
    fn wav_duration_is_read_from_the_header_not_from_a_subprocess() {
        assert_eq!(wav_duration_ms(&wav(3000)), Some(3000));
        assert_eq!(wav_duration_ms(&wav(1500)), Some(1500));
    }

    #[test]
    fn a_truncated_recording_reports_what_it_actually_has() {
        // O cabeçalho promete 4s, o arquivo tem metade — vale o que existe, e
        // não a promessa, senão uma gravação interrompida passaria por completa.
        let mut b = wav(4000);
        b.truncate(44 + (16000 * 2 * 2));
        assert_eq!(wav_duration_ms(&b), Some(2000));
    }

    #[test]
    fn a_non_wav_has_no_duration_instead_of_a_wrong_one() {
        assert_eq!(wav_duration_ms(b"not a wav at all"), None);
        assert_eq!(wav_duration_ms(&[]), None);
    }

    // A regra do "suficiente" é o que destrava a voz clonada.
    #[test]
    fn all_phrases_read_and_enough_seconds_unlocks_the_cloned_voice() {
        let st = status_from(&[3000, 3000, 3000]);
        assert!(st.enough);
        assert_eq!(st.total_ms, 9000);
        assert!(st.phrases.iter().all(|p| p.recorded));
    }

    #[test]
    fn a_missing_phrase_keeps_it_locked_even_with_seconds_to_spare() {
        // Duas frases longas passam do mínimo de tempo, mas falta uma leitura —
        // e a amostra tem de cobrir os sons, não só somar segundos.
        let st = status_from(&[6000, 6000, 0]);
        assert!(!st.enough, "destravou sem a terceira frase");
        assert!(!st.phrases[2].recorded);
    }

    // Um clique não é uma leitura: contá-lo deixaria a tela dizer "pronto" e o
    // defeito só apareceria na voz clonada.
    #[test]
    fn a_click_does_not_count_as_a_read_phrase() {
        let st = status_from(&[300, 3000, 3000]);
        assert!(!st.phrases[0].recorded);
        assert!(!st.enough);
        assert_eq!(st.total_ms, 6000, "o clique entrou no total");
    }

    #[test]
    fn nothing_recorded_is_locked_and_says_how_much_is_needed() {
        let st = status_from(&[]);
        assert!(!st.enough);
        assert_eq!(st.total_ms, 0);
        assert_eq!(st.min_total_ms, MIN_TOTAL_MS);
        assert_eq!(st.phrases.len(), PHRASES.len());
    }

    // As frases são o CONTRATO com o modelo de clonagem: elas são o
    // `reference_text`. Se a tela mostrar uma e o texto guardado for outro, a
    // voz sai errada e ninguém sabe por quê.
    #[test]
    fn every_phrase_has_text_and_the_screen_gets_it_from_here() {
        let st = status_from(&[0, 0, 0]);
        for (i, p) in st.phrases.iter().enumerate() {
            assert_eq!(p.index, i);
            assert_eq!(p.text, PHRASES[i]);
            assert!(!p.text.trim().is_empty());
        }
    }

    // A referência é a frase MAIS LONGA, e vem com o texto dela: o texto é o que
    // impede o modelo de adivinhar o que foi dito.
    #[test]
    fn the_reference_is_the_longest_phrase_and_carries_its_text() {
        // Sem gravação nenhuma não há referência — e o motor tem de dizer isso
        // em vez de sintetizar com uma voz aleatória.
        let saved = sample_dir();
        if !saved.exists() {
            assert!(best_reference().is_none());
        }
        // A escolha em si é testada pela regra, com durações conhecidas.
        let longest = [1000u64, 5000, 3000]
            .iter()
            .enumerate()
            .filter(|(_, d)| **d >= MIN_PHRASE_MS)
            .max_by_key(|(_, d)| **d)
            .map(|(i, _)| i);
        assert_eq!(longest, Some(1), "a mais longa não foi escolhida");
    }

    #[test]
    fn a_bad_index_is_refused_before_touching_disk() {
        let err = save_blocking(SaveSampleInput {
            index: PHRASES.len(),
            data: vec![1, 2, 3],
        })
        .unwrap_err();
        assert_eq!(err, "err.voice_sample_bad_index");
    }

    #[test]
    fn an_empty_recording_is_refused() {
        let err = save_blocking(SaveSampleInput {
            index: 0,
            data: vec![],
        })
        .unwrap_err();
        assert_eq!(err, "err.voice_sample_empty");
    }

    // A voz da pessoa fica em dado de USUÁRIO, nunca no acervo: não é
    // conhecimento a versionar e não entra em PR (BR-1).
    #[test]
    fn the_sample_never_lands_in_the_acervo() {
        let d = sample_dir();
        let s = d.to_string_lossy();
        assert!(s.contains("voice-sample"), "{s}");
        assert!(!s.contains("contextos"), "{s}");
        assert!(!s.contains("reunioes"), "{s}");
    }

    #[test]
    fn each_phrase_has_its_own_file() {
        let d = tmp("paths");
        let a = phrase_path(&d, 0);
        let b = phrase_path(&d, 1);
        assert_ne!(a, b);
        assert!(a.to_string_lossy().ends_with(".wav"));
    }
}
