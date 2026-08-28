// Loro — transcription-model registry & first-run download.
//
// The whisper *engine* is a system dependency (ADR-0003); the ggml *models* are
// per-user data under ~/.loro/models (paths.rs). This module owns which models
// Loro uses, whether each is installed, and how to fetch a missing one with
// integrity verification. Distribution posture: ADR-0006.
//
// Security (BR-1 stays local; protect the user's machine): the download uses
// system `curl` over HTTPS only (`--proto =https`) and the file is verified
// against a pinned SHA-256 before it is placed — a tampered or truncated
// download never lands in the models dir. No new crate is added: integrity uses
// the system `shasum`/`sha256sum`, matching the engine-is-a-system-tool stance.

use crate::paths::{model_file_name, model_path, models_dir};
use std::path::Path;

// A model Loro can use. Extensible: add a row to CATALOG for a new model.
pub struct ModelSpec {
    pub id: &'static str,     // ggml id, e.g. "small" -> ggml-small.bin
    pub sha256: &'static str, // pinned integrity hash (HuggingFace LFS oid)
    pub size: u64,            // bytes; drives the progress bar and a preflight
    pub label: &'static str,  // human-facing name
    pub default: bool,        // the recommended first-run model
}

// Models Loro uses today (two). Adding another is a single row here plus its
// pinned SHA-256 (read from the HF LFS pointer, no full download needed).
pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "large-v3-turbo",
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        size: 1_624_555_275,
        label: "Large v3 Turbo",
        default: true,
    },
    ModelSpec {
        id: "small",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        size: 487_601_967,
        label: "Small",
        default: false,
    },
];

// The Silero VAD model (ADR-0034). Not a transcription model, so it is NOT in
// CATALOG — it never becomes something to transcribe *with*. It IS offered for
// download next to the models (`download_list`), because a separate row is a row
// nobody finds. It is a ModelSpec so the whole verified-download path (pinned
// SHA-256, atomic install, completeness check) is reused verbatim rather than
// re-implemented for one extra file.
pub const VAD_MODEL_ID: &str = "silero-v5.1.2";

pub const VAD_SPEC: ModelSpec = ModelSpec {
    id: VAD_MODEL_ID,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    size: 885_098,
    label: "Detector de fala (VAD)",
    default: false,
};

// Info sent to the UI (camelCase for JS): what to show and whether it is ready.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub size_bytes: u64,
    pub installed: bool,
    pub default: bool,
}

// Catalog lookup, plus the out-of-catalog VAD model: every consumer of a spec
// (download, completeness, install destination) must treat it exactly like a
// catalog entry — a truncated VAD model makes whisper abort the same way a
// truncated transcription model does.
pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    CATALOG
        .iter()
        .chain(std::iter::once(&VAD_SPEC))
        .find(|m| m.id == id)
}

// A model counts as installed only when the whole file is there. Mere existence
// is not enough: a download interrupted straight into the final path leaves a
// truncated .bin that the app then loads as if it were the model, and whisper
// aborts *after* the recording has started with "not all tensors loaded from
// model file" — the user sees capture running and no transcript. Size is the
// cheap half of the ADR-0006 integrity promise: one metadata() call, versus
// rehashing 1.6 GB on every model-list refresh.
fn is_complete(path: &Path, expected_size: u64) -> bool {
    std::fs::metadata(path)
        .map(|m| m.len() == expected_size)
        .unwrap_or(false)
}

// A model outside the catalog has no pinned size to check against, so existence
// is all we can assert — loro.sh's MODEL env accepts any ggml id.
fn is_installed_in(dir: &Path, id: &str) -> bool {
    let p = dir.join(model_file_name(id));
    match spec(id) {
        Some(s) => is_complete(&p, s.size),
        None => p.is_file(),
    }
}

pub fn is_installed(id: &str) -> bool {
    is_installed_in(&models_dir(), id)
}

// Is this file in models_dir a TRANSCRIPTION model? `doctor` answers "does the
// user have a model at all" by listing `ggml-*`, and since ADR-0034 that
// directory also holds the VAD model — which cannot transcribe anything. Without
// this filter a user whose only file is the 864 KB VAD reads as "model present",
// the setup banner stops naming the missing voice model, and "Instalar agora"
// skips fetching it.
pub fn is_transcription_model_file(name: &str) -> bool {
    name.starts_with("ggml-") && name != model_file_name(VAD_MODEL_ID)
}

// Everything the model manager offers for download: the transcription catalog
// plus the VAD model. It belongs in the SAME list — a user who has to discover a
// separate row does not discover it (measured the hard way on 2026-08-26) — but
// deliberately NOT in `CATALOG`, so it never becomes a transcription choice.
pub fn download_list() -> Vec<ModelInfo> {
    CATALOG
        .iter()
        .chain(std::iter::once(&VAD_SPEC))
        .map(|m| ModelInfo {
            id: m.id.into(),
            label: m.label.into(),
            size_bytes: m.size,
            installed: is_installed(m.id),
            default: m.default,
        })
        .collect()
}

// HuggingFace mirror (same source as loro.sh). Overridable for tests and for
// air-gapped/self-hosted mirrors.
fn hf_base() -> String {
    std::env::var("LORO_HF_BASE")
        .unwrap_or_else(|_| "https://huggingface.co/ggerganov/whisper.cpp/resolve/main".into())
}

// The VAD model is NOT in ggerganov/whisper.cpp (measured 2026-08-26: that path
// 404s); ggml-org/whisper-vad is where whisper.cpp publishes it. Hence a second
// base, overridable like the first for mirrors and air-gapped installs.
fn hf_vad_base() -> String {
    std::env::var("LORO_HF_VAD_BASE")
        .unwrap_or_else(|_| "https://huggingface.co/ggml-org/whisper-vad/resolve/main".into())
}

pub fn model_url(id: &str) -> String {
    let base = if id == VAD_MODEL_ID {
        hf_vad_base()
    } else {
        hf_base()
    };
    format!("{base}/ggml-{id}.bin")
}

// The VAD model's path when it is fully installed, else None. `None` is not an
// error: whisper then runs exactly as it did before VAD existed (ADR-0034
// "degrade, never block").
pub fn vad_model_path() -> Option<std::path::PathBuf> {
    is_installed(VAD_MODEL_ID).then(|| model_path(VAD_MODEL_ID))
}

// The temp file a download streams into, next to the final path so the rename
// is atomic (same filesystem). Kept distinct per model to avoid collisions.
pub fn download_tmp_path(id: &str) -> std::path::PathBuf {
    models_dir().join(format!("ggml-{id}.bin.part"))
}

// The lowercase 64-char hex digest found in a checksum tool's output, if any.
// Parsed by shape rather than position or label: shasum/sha256sum lead with the
// digest, while Windows certutil prints it on its own line under a *localized*
// header, and older certutil groups it in space-separated quads. Matching "the
// first token that looks like a SHA-256" covers all of them.
fn parse_sha256(out: &str) -> Option<String> {
    let is_digest = |s: &str| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit());
    for line in out.lines() {
        if let Some(tok) = line.split_whitespace().next().filter(|t| is_digest(t)) {
            return Some(tok.to_lowercase());
        }
        // certutil may space the digest into quads: join the line and retry
        let joined: String = line.split_whitespace().collect();
        if is_digest(&joined) {
            return Some(joined.to_lowercase());
        }
    }
    None
}

// Compute a file's SHA-256 via the system tool (shasum on macOS, sha256sum on
// Linux, certutil on Windows — which ships with the OS, unlike the other two).
// Returns the lowercase hex digest.
pub fn sha256_of(path: &Path) -> Result<String, String> {
    let run = |prog: &str, args: &[&str]| -> Option<String> {
        let out = crate::proc::command(prog).args(args).output().ok()?;
        if !out.status.success() {
            return None;
        }
        parse_sha256(&String::from_utf8_lossy(&out.stdout))
    };
    let p = path.to_string_lossy();
    run("shasum", &["-a", "256", &p])
        .or_else(|| run("sha256sum", &[&p]))
        .or_else(|| run("certutil", &["-hashfile", &p, "SHA256"]))
        .ok_or_else(|| "err.sha_tool_missing".into())
}

// Verify a freshly downloaded temp file against the expected digest and, only
// if it matches, atomically move it into place. On any mismatch the temp file
// is removed and the destination is left untouched — a bad download can never
// become the active model.
pub fn verify_and_install(tmp: &Path, dest: &Path, expected_sha: &str) -> Result<(), String> {
    let actual = sha256_of(tmp).inspect_err(|_| {
        let _ = std::fs::remove_file(tmp);
    })?;
    if !actual.eq_ignore_ascii_case(expected_sha) {
        let _ = std::fs::remove_file(tmp);
        return Err("err.model_checksum".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "err.models_dir".to_string())?;
    }
    std::fs::rename(tmp, dest).map_err(|_| "err.model_install".to_string())
}

// Resolve a catalog model's install destination (ggml-<id>.bin in models_dir).
pub fn install_dest(id: &str) -> std::path::PathBuf {
    model_path(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    // unique scratch dir without a tempdir crate (Date/rand-free)
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    fn scratch() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("loro-models-test-{}-{n}", std::process::id()));
        // A PASTA É NOVA, sempre. `pid + contador` colide entre execuções (o sistema
        // reusa PID), e um `ggml-medium.bin` deixado por uma rodada anterior derrubava
        // `a_model_outside_the_catalog_falls_back_to_existence` na PRIMEIRA asserção —
        // um vermelho que aparecia e sumia, que é o pior tipo (2026-08-18). É a mesma
        // limpeza que `loops::tests::tmp` já fazia.
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // SHA-256 of the ASCII string "hello" (well-known vector)
    const HELLO_SHA: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[test]
    fn catalog_has_the_two_models_used_today_with_one_default() {
        let ids: Vec<_> = CATALOG.iter().map(|m| m.id).collect();
        assert!(ids.contains(&"small"));
        assert!(ids.contains(&"large-v3-turbo"));
        assert_eq!(CATALOG.iter().filter(|m| m.default).count(), 1);
    }

    #[test]
    fn every_pinned_sha_is_64_hex_chars() {
        for m in CATALOG {
            assert_eq!(m.sha256.len(), 64, "{} sha length", m.id);
            assert!(
                m.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} sha hex",
                m.id
            );
        }
    }

    // The regression this guards: a `loro.sh setup` cut short by Ctrl-C left a
    // 41 MB ggml-large-v3-turbo.bin (of 1.6 GB) at the final path; the app listed
    // it as installed and every recording died inside whisper.
    #[test]
    fn a_truncated_model_file_does_not_count_as_installed() {
        let d = scratch();
        let size = spec("small").unwrap().size;
        std::fs::write(d.join("ggml-small.bin"), vec![0u8; 1024]).unwrap();
        assert!(!is_complete(&d.join("ggml-small.bin"), size));
        assert!(!is_installed_in(&d, "small"));
    }

    #[test]
    fn a_whole_model_file_counts_as_installed() {
        let d = scratch();
        // a one-row catalog stand-in: write exactly the pinned size
        let p = d.join("ggml-tiny-fixture.bin");
        std::fs::write(&p, vec![0u8; 64]).unwrap();
        assert!(is_complete(&p, 64));
        assert!(
            !is_complete(&p, 65),
            "a longer file is not the model either"
        );
    }

    #[test]
    fn a_missing_model_file_is_not_installed() {
        let d = scratch();
        assert!(!is_complete(&d.join("ggml-small.bin"), 1));
        assert!(!is_installed_in(&d, "small"));
    }

    #[test]
    fn a_model_outside_the_catalog_falls_back_to_existence() {
        let d = scratch();
        assert!(!is_installed_in(&d, "medium"));
        std::fs::write(d.join("ggml-medium.bin"), b"x").unwrap();
        assert!(is_installed_in(&d, "medium"));
    }

    // DRY guard: loro.sh cannot read the Rust catalog, so it repeats the pinned
    // digests. This fails the build if the two ever drift apart.
    #[test]
    fn loro_sh_pins_every_catalog_sha256() {
        let sh = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../loro.sh");
        let src = std::fs::read_to_string(&sh).expect("loro.sh is readable from the crate");
        for m in CATALOG {
            assert!(
                src.contains(m.sha256),
                "loro.sh must pin the SHA-256 of {} (models.rs CATALOG)",
                m.id
            );
        }
    }

    #[test]
    fn spec_finds_known_and_rejects_unknown() {
        assert!(spec("small").is_some());
        assert!(spec("does-not-exist").is_none());
    }

    // LORO_HF_BASE é do PROCESSO, e os testes rodam em paralelo: os dois abaixo
    // disputavam a mesma variável. Um remove a base no início; o outro a define
    // e só então compara — e quando o primeiro caía nesse meio, o segundo falhava
    // em `assert_eq` com a URL do HuggingFace no lugar do espelho. Foi assim que
    // a CI ficou vermelha em 2026-08-20 (models.rs:294, 447 passaram e 1 falhou)
    // e verde na re-execução seguinte, sem uma linha mudar: é o vermelho que
    // aparece e some, o pior tipo (CLAUDE.md §7.1). O que a trava garante não é
    // ordem, é EXCLUSÃO — enquanto um deles mexe na variável, o outro espera.
    static HF_BASE_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn model_url_is_https_and_names_the_ggml_file() {
        let _guard = HF_BASE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("LORO_HF_BASE");
        let u = model_url("small");
        assert!(u.starts_with("https://"), "url must be https: {u}");
        assert!(u.ends_with("/ggml-small.bin"), "url: {u}");
    }

    #[test]
    fn model_url_honors_mirror_override() {
        let _guard = HF_BASE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("LORO_HF_BASE", "https://mirror.example/x");
        assert_eq!(
            model_url("small"),
            "https://mirror.example/x/ggml-small.bin"
        );
        std::env::remove_var("LORO_HF_BASE");
    }

    // ---- the VAD model (ADR-0034) ----------------------------------------

    #[test]
    fn vad_spec_is_pinned_like_any_other_model() {
        assert_eq!(VAD_SPEC.sha256.len(), 64);
        assert!(VAD_SPEC.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(VAD_SPEC.size > 0);
        assert!(!VAD_SPEC.default, "the VAD model is never a default model");
    }

    // It must NOT reach the model picker: it is not something to transcribe with.
    #[test]
    fn vad_model_is_not_in_the_transcription_catalog() {
        assert!(
            !CATALOG.iter().any(|m| m.id == VAD_MODEL_ID),
            "the VAD model must stay out of CATALOG"
        );
    }

    // ...but every spec consumer (download, completeness, install dest) must
    // still resolve it, so the verified-download path is reused verbatim.
    #[test]
    fn vad_model_resolves_through_spec() {
        let s = spec(VAD_MODEL_ID).expect("VAD spec must resolve");
        assert_eq!(s.sha256, VAD_SPEC.sha256);
        assert_eq!(s.size, VAD_SPEC.size);
    }

    // Measured 2026-08-26: ggerganov/whisper.cpp does NOT host the VAD model
    // (404). It must be fetched from the whisper-vad repo instead.
    // The defect this guards: `doctor` answers "does the user have a model?" by
    // listing ggml-* in models_dir, and the VAD model lives there too. Counting
    // it would make a machine with ONLY the 864 KB VAD read as ready to
    // transcribe — the setup banner would stop naming the missing voice model.
    #[test]
    fn the_vad_file_does_not_count_as_a_transcription_model() {
        assert!(is_transcription_model_file("ggml-large-v3-turbo.bin"));
        assert!(is_transcription_model_file("ggml-small.bin"));
        assert!(!is_transcription_model_file("ggml-silero-v5.1.2.bin"));
        assert!(!is_transcription_model_file("notes.txt"));
    }

    // "Download it along with the others" — it must be in the SAME list the model
    // manager paints, because a separate row is a row nobody finds.
    #[test]
    fn the_download_list_offers_the_vad_next_to_the_models() {
        let l = download_list();
        assert!(
            l.iter().any(|m| m.id == VAD_MODEL_ID),
            "the VAD is missing from the download list"
        );
        for m in CATALOG {
            assert!(l.iter().any(|x| x.id == m.id), "{} dropped", m.id);
        }
        assert_eq!(l.len(), CATALOG.len() + 1);
        // ...and it is never the recommended one
        assert!(!l.iter().any(|m| m.id == VAD_MODEL_ID && m.default));
    }

    #[test]
    fn vad_url_points_at_the_vad_repo_not_the_model_repo() {
        std::env::remove_var("LORO_HF_VAD_BASE");
        std::env::remove_var("LORO_HF_BASE");
        let u = model_url(VAD_MODEL_ID);
        assert!(u.starts_with("https://"), "must be https: {u}");
        assert!(u.contains("whisper-vad"), "wrong host repo: {u}");
        assert!(u.ends_with("/ggml-silero-v5.1.2.bin"), "wrong file: {u}");
    }

    #[test]
    fn vad_url_is_overridable_for_mirrors() {
        std::env::set_var("LORO_HF_VAD_BASE", "https://mirror.example/vad");
        assert_eq!(
            model_url(VAD_MODEL_ID),
            "https://mirror.example/vad/ggml-silero-v5.1.2.bin"
        );
        std::env::remove_var("LORO_HF_VAD_BASE");
    }

    // A transcription model must never be routed to the VAD repo.
    #[test]
    fn a_transcription_model_still_uses_the_model_repo() {
        std::env::remove_var("LORO_HF_BASE");
        assert!(!model_url("small").contains("whisper-vad"));
    }

    #[test]
    fn parse_sha256_reads_every_tool_format() {
        // shasum / sha256sum: digest first, filename after
        assert_eq!(
            parse_sha256(&format!("{HELLO_SHA}  hello.txt\n")).unwrap(),
            HELLO_SHA
        );
        // certutil: localized header, digest alone on the next line. The header
        // must not be mistaken for the digest, hence matching on shape.
        let certutil =
            format!("SHA256 hash de C:\\t\\hello.txt:\n{HELLO_SHA}\nCertUtil: concluido.\n");
        assert_eq!(parse_sha256(&certutil).unwrap(), HELLO_SHA);
        // older certutil groups the digest into space-separated quads
        let quads = HELLO_SHA
            .as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            parse_sha256(&format!("header:\n{quads}\n")).unwrap(),
            HELLO_SHA
        );
        // uppercase is normalized
        assert_eq!(parse_sha256(&HELLO_SHA.to_uppercase()).unwrap(), HELLO_SHA);
        // nothing digest-shaped
        assert!(parse_sha256("CertUtil: falhou\n").is_none());
    }

    #[test]
    fn sha256_of_matches_known_vector() {
        let d = scratch();
        let f = d.join("hello.txt");
        std::fs::write(&f, b"hello").unwrap();
        assert_eq!(sha256_of(&f).unwrap(), HELLO_SHA);
    }

    #[test]
    fn verify_and_install_places_file_when_checksum_matches() {
        let d = scratch();
        let tmp = d.join("m.part");
        let dest = d.join("sub").join("ggml-x.bin");
        std::fs::write(&tmp, b"hello").unwrap();
        verify_and_install(&tmp, &dest, HELLO_SHA).unwrap();
        assert!(dest.is_file(), "dest should exist");
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
        assert!(!tmp.exists(), "tmp should be consumed by the rename");
    }

    // security: a tampered/corrupt download must never become the active model
    #[test]
    fn verify_and_install_rejects_and_cleans_up_on_mismatch() {
        let d = scratch();
        let tmp = d.join("m.part");
        let dest = d.join("ggml-x.bin");
        std::fs::write(&tmp, b"tampered").unwrap();
        let err = verify_and_install(&tmp, &dest, HELLO_SHA).unwrap_err();
        assert_eq!(err, "err.model_checksum");
        assert!(!dest.exists(), "bad download must not be installed");
        assert!(!tmp.exists(), "bad temp file must be removed");
    }
}
