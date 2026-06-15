# Build + install the freerdp-worker binary on Windows via MSYS2.
#
# Usage:
#   .\scripts\build-worker-windows.ps1
#   .\scripts\build-worker-windows.ps1 -Subenv mingw64
#   .\scripts\build-worker-windows.ps1 -Msys2Root D:\msys64
#   .\scripts\build-worker-windows.ps1 -InstallDir "C:\Program Files\JumpServer"
#   .\scripts\build-worker-windows.ps1 -SkipDeps
#
# MSYS2 sub-environments are mutually incompatible (different C runtimes
# and thread models). We lock the build to a single chosen subenv: PATH,
# PKG_CONFIG_PATH and the pacman package prefix all come from the same
# place. Default is ucrt64 (MSYS2's recommended default since 2022).
#
# Install location defaults to %LOCALAPPDATA%\Programs\JumpServer so no
# admin privileges are needed. Pass -InstallDir "$env:ProgramFiles\JumpServer"
# for a machine-wide install (run PowerShell as Administrator).

[CmdletBinding()]
param(
    [ValidateSet("ucrt64", "mingw64", "clang64", "mingw32")]
    [string]$Subenv = "ucrt64",
    [string]$Msys2Root = "C:\msys64",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\JumpServer",
    [switch]$SkipDeps
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$prefixMap = @{
    "ucrt64"  = "mingw-w64-ucrt-x86_64-"
    "mingw64" = "mingw-w64-x86_64-"
    "clang64" = "mingw-w64-clang-x86_64-"
    "mingw32" = "mingw-w64-i686-"
}
$pkgPrefix = $prefixMap[$Subenv]
$subenvBin = Join-Path $Msys2Root "$Subenv\bin"
$pkgCfgDir = Join-Path $Msys2Root "$Subenv\lib\pkgconfig"
$pacBin    = Join-Path $Msys2Root "usr\bin\pacman.exe"

if (-not (Test-Path $pacBin)) {
    Write-Error "MSYS2 not found at $Msys2Root (looked for $pacBin). Install from https://www.msys2.org/ or override with -Msys2Root <path>."
}

if (-not $SkipDeps) {
    Write-Host "[build-worker-windows] installing deps into $Subenv subenv via pacman"
    # libvpx/aom back the WebRTC video encoders (vp8.go / av1.go) and
    # libjpeg-turbo the SIMD JPEG rect encoder (jpeg_turbo.go). freerdp pulls
    # vpx/aom in transitively via ffmpeg today, but list them explicitly so a
    # leaner future freerdp package can't silently break the build.
    & $pacBin -S --noconfirm --needed `
        "${pkgPrefix}freerdp" `
        "${pkgPrefix}libvpx"  `
        "${pkgPrefix}aom"     `
        "${pkgPrefix}libjpeg-turbo" `
        "${pkgPrefix}pkgconf" `
        "${pkgPrefix}gcc"     `
        "${pkgPrefix}go"
    if ($LASTEXITCODE -ne 0) { Write-Error "pacman -S failed with exit $LASTEXITCODE" }
}

# Confirm the subenv now has what we need.
$gccExe = Join-Path $subenvBin "gcc.exe"
$pkgCfgExe = Join-Path $subenvBin "pkg-config.exe"
$goExe = Join-Path $subenvBin "go.exe"
$freerdpPc = Join-Path $pkgCfgDir "freerdp3.pc"
foreach ($p in @($gccExe, $pkgCfgExe, $goExe, $freerdpPc)) {
    if (-not (Test-Path $p)) {
        Write-Error "Expected toolchain piece missing after install: $p (subenv=$Subenv). Try a different -Subenv, or check pacman output above for failures."
    }
}

# Lock the build to a single subenv — no cross-CRT contamination.
$env:PATH = "$subenvBin;$Msys2Root\usr\bin;$env:PATH"
$env:PKG_CONFIG_PATH = $pkgCfgDir
$env:CGO_ENABLED = "1"
$env:CC = "gcc"
# MSYS2's go.exe is built with -trimpath and refuses to detect its own
# GOROOT. Point it at the matching subenv's lib/go so the runtime + std
# library load correctly. Without this we get
# `go: cannot find GOROOT directory: 'go' binary is trimmed and GOROOT is not set`.
$msysGoRoot = Join-Path $Msys2Root "$Subenv\lib\go"
if (Test-Path $msysGoRoot) {
    $env:GOROOT = $msysGoRoot
}

if (-not (Test-Path $InstallDir)) {
    Write-Host "[build-worker-windows] creating install dir $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

$out = Join-Path $InstallDir "freerdp-worker.exe"
$tmpOut = Join-Path ([System.IO.Path]::GetTempPath()) ("freerdp-worker-" + [Guid]::NewGuid().ToString("N") + ".exe")

Push-Location $root
try {
    Write-Host "[build-worker-windows] compiling (this typically takes 10-30s)"
    & $goExe build -tags freerdp -trimpath -o $tmpOut .\cmd\freerdp-worker
    if ($LASTEXITCODE -ne 0) { Write-Error "go build failed with exit $LASTEXITCODE" }

    # If the old binary is in use, rename it aside so the new one can
    # take its place. Windows lets us rename a file with an open handle,
    # just not delete or overwrite it. We MUST use a unique suffix per
    # build because a previous "freerdp-worker.exe.old" can itself still
    # be locked by an even-older worker process — using a plain ".old"
    # collides and Rename-Item then fails, leaving the original $out in
    # place and the next Move-Item -Force erroring with "Cannot create a
    # file when that file already exists".
    if (Test-Path $out) {
        $stale = "$out.$([Guid]::NewGuid().ToString('N')).old"
        try {
            Rename-Item -LiteralPath $out -NewName (Split-Path -Leaf $stale) -ErrorAction Stop
        } catch {
            Write-Error @"
Cannot rename existing $out aside ($_).
Most likely a running gateway/worker process is holding the binary open.
Stop the gateway and any leftover freerdp-worker.exe, then re-run:
  Get-Process freerdp-worker -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-Process jumpserver     -ErrorAction SilentlyContinue | Stop-Process -Force
"@
        }
    }
    Move-Item -LiteralPath $tmpOut -Destination $out
    Write-Host "[build-worker-windows] installed: $out"
    Get-Item $out | Format-List Name, Length, LastWriteTime

    # Best-effort cleanup of stale ".old" siblings left over from earlier
    # runs. Matches both the legacy plain "freerdp-worker.exe.old"
    # (pre-fix script) and the new GUID-suffixed
    # "freerdp-worker.exe.<guid>.old" form. They were unlinked from $out
    # but Windows keeps them on disk until the holding process exits;
    # once it does, this sweep removes them so the install dir doesn't
    # accumulate junk.
    Get-ChildItem -LiteralPath $InstallDir -Filter "freerdp-worker.exe*.old" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
} finally {
    if (Test-Path $tmpOut) { Remove-Item -Force $tmpOut -ErrorAction SilentlyContinue }
    Pop-Location
}
