# Loro — guided Windows setup for the whisper engine (see ADR-0003, ADR-0012).
#
# whisper.cpp ships prebuilt Windows binaries for whisper-cli, but NOT for
# whisper-stream (the live mode needs SDL2), so this script builds both from
# source with SDL2 and installs them into ~/.loro/bin.
#
# It installs into %USERPROFILE%\.loro\bin, which Loro always searches
# (paths.rs::engine_search_dirs), so the user's PATH is left untouched. Voice
# models are NOT handled here: the in-app model manager downloads them with a
# pinned SHA-256 and an atomic install (ADR-0006).
#
# The script is idempotent: every step is skipped when its result already
# exists. Re-running it after a failure resumes where it stopped.

$ErrorActionPreference = "Stop"

$Loro   = Join-Path $env:USERPROFILE ".loro"
$Bin    = Join-Path $Loro "bin"
$Work   = Join-Path $Loro "src"
$WhisperTag = "v1.9.1"

New-Item -ItemType Directory -Force -Path $Bin, $Work | Out-Null

function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# schannel on corporate networks can fail cert-revocation checks; --ssl-no-revoke
# skips only the revocation lookup, not certificate validation.
#
# Downloads land on a .part file and are only moved into place once curl reports
# success, so an interrupted transfer can never be mistaken for a finished one.
function Download($url, $out) {
  Write-Host "[loro] baixando $([IO.Path]::GetFileName($out))"
  $part = "$out.part"
  curl.exe -L --fail --ssl-no-revoke -o $part $url
  if ($LASTEXITCODE -ne 0) { throw "download falhou: $url" }
  Move-Item $part $out -Force
}

function Winget($id) {
  Write-Host "[loro] winget install $id"
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --disable-interactivity
}

# ---- 1. toolchain (ffmpeg, cmake, git, MSVC C++) ---------------------------
if (-not (Have ffmpeg)) { Winget "Gyan.FFmpeg" }  else { Write-Host "[loro] ffmpeg ok" }
if (-not (Have cmake))  { Winget "Kitware.CMake" } else { Write-Host "[loro] cmake ok" }
if (-not (Have git))    { Winget "Git.Git" }      else { Write-Host "[loro] git ok" }
$env:Path = "C:\Program Files\CMake\bin;C:\Program Files\Git\cmd;$env:Path"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = (Test-Path $vswhere) -and (& $vswhere -latest -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (-not $hasMsvc) {
  Write-Host "[loro] instalando VS Build Tools (workload C++), download grande, pode demorar"
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
    --accept-source-agreements --accept-package-agreements `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
} else { Write-Host "[loro] MSVC C++ ok" }

# ---- 2-4. engine (SDL2 + build + install) ----------------------------------
# Skipped wholesale when the engine is already in place, so a run that only
# needs a missing dependency (ffmpeg, say) does not clone and rebuild whisper.
if ((Test-Path "$Bin\whisper-stream.exe") -and (Test-Path "$Bin\whisper-cli.exe")) {
  Write-Host "[loro] motor ja instalado em $Bin"
} else {

# ---- 2. SDL2 (needed by whisper-stream / live mode) ------------------------
$SdlRoot = Get-ChildItem "$Work\sdl2" -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'SDL2-*' } | Select-Object -First 1
if (-not $SdlRoot) {
  $rel = Invoke-RestMethod "https://api.github.com/repos/libsdl-org/SDL/releases" -Headers @{ 'User-Agent' = 'loro' }
  $sdl = $rel | Where-Object { $_.tag_name -like 'release-2.*' } | Select-Object -First 1
  $asset = $sdl.assets | Where-Object { $_.name -like 'SDL2-devel-*-VC.zip' } | Select-Object -First 1
  $zip = "$Work\sdl2.zip"
  Download $asset.browser_download_url $zip
  Expand-Archive -Path $zip -DestinationPath "$Work\sdl2" -Force
  $SdlRoot = Get-ChildItem "$Work\sdl2" -Directory | Where-Object { $_.Name -like 'SDL2-*' } | Select-Object -First 1
}
Write-Host "[loro] SDL2: $($SdlRoot.Name)"

# ---- 3. build whisper.cpp (whisper-stream + whisper-cli) --------------------
$Src = Join-Path $Work "whisper.cpp"
if (-not (Test-Path $Src)) {
  Write-Host "[loro] clonando whisper.cpp $WhisperTag"
  git clone --depth 1 --branch $WhisperTag https://github.com/ggml-org/whisper.cpp $Src
}
$Build = Join-Path $Src "build"
Write-Host "[loro] configurando o build (SDL2 ligado)"
cmake -S $Src -B $Build -DWHISPER_SDL2=ON -DSDL2_DIR="$($SdlRoot.FullName)\cmake" -DCMAKE_BUILD_TYPE=Release
Write-Host "[loro] compilando whisper-stream e whisper-cli (pode demorar alguns minutos)"
cmake --build $Build --config Release --target whisper-stream whisper-cli
$Release = Join-Path $Build "bin\Release"
if (-not (Test-Path "$Release\whisper-stream.exe")) { throw "build nao gerou whisper-stream.exe" }

# ---- 4. install engine + runtime DLLs into ~/.loro/bin ---------------------
Copy-Item "$Release\*.exe" -Destination $Bin -Force
# the shared-library build drops ggml/whisper DLLs next to the exes; a static
# build produces none, so this must not be fatal
Copy-Item "$Release\*.dll" -Destination $Bin -Force -ErrorAction SilentlyContinue
Copy-Item "$($SdlRoot.FullName)\lib\x64\SDL2.dll" -Destination $Bin -Force
Write-Host "[loro] engine instalado em $Bin"

} # fim do bloco do motor

Write-Host ""
Write-Host "[loro] pronto. Feche e reabra o Loro para ele detectar o motor." -ForegroundColor Green
Write-Host "[loro] o modelo de voz e baixado dentro do app, no gerenciador de modelos."
