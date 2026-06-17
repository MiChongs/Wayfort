# install-devolutions-gateway-windows.ps1
#
# One-shot installer that fetches the latest Devolutions Gateway
# release from GitHub and drops the binary into $InstallPrefix. The
# upstream Windows release artefact is a plain PE executable (NOT a
# zip / MSI), so this script just downloads and copies — no extraction,
# no installer prompts.
#
# Parameters / env overrides:
#   -Version          DGW release tag (default: latest from GitHub API)
#   -InstallPrefix    where the binary ends up (default:
#                     $env:LOCALAPPDATA\Programs\Wayfort\devolutions-gateway)
#   -Mirror           alternate base URL when GitHub release CDN is slow
#                     from the deploy host

[CmdletBinding()]
param(
    [string]$Version = $env:DGW_VERSION,
    [string]$InstallPrefix = $(if ($env:INSTALL_PREFIX) { $env:INSTALL_PREFIX } else { "$env:LOCALAPPDATA\Programs\Wayfort\devolutions-gateway" }),
    [string]$Mirror = $(if ($env:DGW_MIRROR) { $env:DGW_MIRROR } else { "https://github.com/Devolutions/devolutions-gateway/releases/download" }),
    [string]$Api = $(if ($env:DGW_API) { $env:DGW_API } else { "https://api.github.com/repos/Devolutions/devolutions-gateway/releases/latest" })
)

$ErrorActionPreference = "Stop"
function Log($msg) { Write-Host "[install-devolutions-gateway] $msg" }

# Architecture / asset platform. The Windows release is a ZIP named
# `DevolutionsGateway-<ver>-windows-x64.zip` (NOT the underscore/.exe form the
# Linux/macOS assets use — that naming 404s). Upstream ships only x64 for the
# gateway; refuse arm64 with a clear message rather than 404'ing.
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "windows-x64" }
    "ARM64" { throw "Devolutions Gateway upstream does not ship a Windows ARM64 gateway binary. Run on x64 (incl. Windows-on-ARM emulation) or build from source." }
    default { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

# Resolve version: explicit override → env → latest-from-GitHub-API.
if (-not $Version) {
    Log "querying GitHub for latest release tag"
    try {
        $release = Invoke-RestMethod -Uri $Api -UseBasicParsing
    } catch {
        throw "GitHub API request failed ($_). Pin a version via -Version or `$env:DGW_VERSION = 'x.y.z'`."
    }
    $Version = $release.tag_name -replace '^v', ''
    if (-not $Version) { throw "could not parse tag_name from $Api" }
}
Log "installing Devolutions Gateway $Version ($arch) into $InstallPrefix"

if (-not (Test-Path $InstallPrefix)) { New-Item -ItemType Directory -Force -Path $InstallPrefix | Out-Null }
$configDir = Join-Path $InstallPrefix "config"
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Force -Path $configDir | Out-Null }

# e.g. DevolutionsGateway-2026.2.2-windows-x64.zip
$asset = "DevolutionsGateway-${Version}-${arch}.zip"
$url = "$Mirror/v$Version/$asset"
$dest = Join-Path $InstallPrefix "devolutions-gateway.exe"
$tmp = New-TemporaryFile
$extract = $null

try {
    Log "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

    # Sanity check: a small response usually means the GitHub CDN returned an
    # HTML 404 page instead of the ~22MB zip.
    if ((Get-Item $tmp).Length -lt 1MB) {
        $head = Get-Content -LiteralPath $tmp -TotalCount 1
        throw "downloaded payload too small ($((Get-Item $tmp).Length) bytes; first line: $head). Asset name or version likely wrong."
    }

    # The Windows asset is a ZIP whose root holds DevolutionsGateway.exe + xmf.dll
    # (its runtime DLL) + a webapp/ folder. Extract to a temp dir, then move the
    # whole payload into $InstallPrefix and place the gateway under our canonical
    # name devolutions-gateway.exe (xmf.dll + webapp/ must sit beside it).
    $extract = Join-Path ([System.IO.Path]::GetTempPath()) ("dgw_" + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $tmp -DestinationPath $extract -Force
    $innerExe = Get-ChildItem -LiteralPath $extract -Filter 'DevolutionsGateway.exe' -Recurse | Select-Object -First 1
    if (-not $innerExe) {
        $innerExe = Get-ChildItem -LiteralPath $extract -Filter '*.exe' -Recurse | Sort-Object Length -Descending | Select-Object -First 1
    }
    if (-not $innerExe) { throw "no gateway .exe found inside $asset" }
    $srcDir = $innerExe.Directory.FullName

    # If a running gateway holds devolutions-gateway.exe, Windows allows rename
    # but not overwrite — move the existing one aside first.
    if (Test-Path $dest) {
        $stale = "$dest.$([Guid]::NewGuid().ToString('N')).old"
        try {
            Rename-Item -LiteralPath $dest -NewName (Split-Path -Leaf $stale) -ErrorAction Stop
        } catch {
            Write-Warning "Could not rename existing binary ($_). Stop the running gateway and rerun this script."
            throw
        }
    }
    Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPrefix -Recurse -Force
    $placed = Join-Path $InstallPrefix $innerExe.Name
    if ($placed -ne $dest) { Move-Item -LiteralPath $placed -Destination $dest -Force }
    Log "installed: $dest (+ xmf.dll, webapp/)"
    & $dest --version

    # Best-effort cleanup of stale `.old` siblings from prior installs.
    Get-ChildItem -LiteralPath $InstallPrefix -Filter "devolutions-gateway.exe.*.old" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
} finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if ($extract -and (Test-Path $extract)) { Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue }
}