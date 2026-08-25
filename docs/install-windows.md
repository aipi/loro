# Installing Loro on Windows (10/11, x64)

Every `v*` release ships Windows installers, so the normal path is a download —
no toolchain, no C++ to compile. Everything below runs in **PowerShell**;
`loro.sh` and the `Makefile` need a POSIX shell and are not the Windows path.

## Install from the release (recommended)

1. Open the [latest release](https://github.com/aipi/loro/releases/latest) and
   download `Loro_<version>_x64_en-US.msi` (or `Loro_<version>_x64-setup.exe`,
   the NSIS installer — same app, either is fine).
2. Run it. SmartScreen says *"Windows protected your PC"* because the app is not
   code-signed — **More info → Run anyway**. See the notes at the bottom.
3. Launch **Loro** from the Start menu, then jump to
   [§4 install the transcription engine](#4-install-the-transcription-engine)
   and [§5 download a model](#5-download-a-model) — the app needs both once.

The rest of this page is the **build from source** path: use it to work on the
code, or when you'd rather compile than download a binary.

## 1. Install the toolchain

Rust and Node are needed to build the app; MSVC and CMake are needed later to
build the transcription engine.

```powershell
winget install Rustlang.Rustup OpenJS.NodeJS Kitware.CMake Git.Git Gyan.FFmpeg
```

Visual Studio Build Tools with the **C++ workload** is also required (Rust uses
the MSVC linker). If you don't have it:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

## 2. Build Loro

```powershell
git clone https://github.com/aipi/loro.git
```

```powershell
cd loro\desktop; npm install; npm run tauri build
```

That produces an installer and a standalone binary under
`desktop\src-tauri\target\release`:

| Artifact | Path |
|---|---|
| MSI installer | `bundle\msi\Loro_<version>_x64_en-US.msi` |
| NSIS setup | `bundle\nsis\Loro_<version>_x64-setup.exe` |
| Standalone exe | `Loro.exe` |

## 3. Open Loro

Run either installer, then launch **Loro** from the Start menu. To skip
installing, run `Loro.exe` from the path above — it is the same app.

To work on the code instead, `npm run tauri dev` compiles and opens the app
with the dev reload loop. The first build takes a few minutes either way; later
runs are incremental.

## 4. Install the transcription engine

Loro opens with a banner reading *"faltam dependências"* and a **configurar
agora no terminal** button. Click it — on Windows that runs a bundled
PowerShell script in the embedded terminal which builds `whisper-stream` and
`whisper-cli` from source with SDL2 and installs them into
`%USERPROFILE%\.loro\bin`, where Loro looks for them (so your `PATH` is left
alone).

whisper.cpp publishes prebuilt Windows binaries for `whisper-cli` but **not**
for `whisper-stream`, because live mode needs SDL2 — that is why this step
compiles instead of downloading. It is idempotent: rerun it after a failure and
it resumes. Restart Loro when it finishes so the engine is detected.

## 5. Download a model

**Settings (⚙) → model → + download** — `large-v3-turbo` (accurate) or `small`
(fast), verified by SHA-256 into `%USERPROFILE%\.loro\models`.

## Windows notes

| Topic | Detail |
|---|---|
| **The app is unsigned** | there is no code-signing certificate, so SmartScreen shows *"Windows protected your PC"* on first run of the installer. **More info → Run anyway**. |
| **`failed to bundle project: Acesso negado (os error 5)`** | the cached NSIS toolchain extracted only partially (a giveaway is a `makensis.exe` of a few KB). Delete `%LOCALAPPDATA%\tauri\nsis-3.11` and rebuild; the MSI is unaffected and is produced before this step. |
| **Meeting mode is macOS-only** | it captures both sides through a ScreenCaptureKit sidecar (ADR-0005), which is an Apple framework. On Windows the mode reports `err.syscap_not_found`; use **live** or **file** mode instead. |
| **System audio** | Windows has no BlackHole. Loro matches your driver's own loopback device — "Mixagem estéreo" on a pt-BR install, "Stereo Mix" in English — which usually just needs enabling in the Sound panel's Recording tab. If your driver has none, install [VB-Cable](https://vb-audio.com/Cable/) and set it as the default output. The in-app flow walks through both (ADR-0012). |
| **Data location** | `%USERPROFILE%\.loro` (models, logs, engine, config), resolved from `USERPROFILE`. Override with `LORO_HOME`. |
| **`loro.sh` / `make`** | bash and POSIX-shell only. Run the checks directly in PowerShell — see [Development in the README](../README.md#development). |
