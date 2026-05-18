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
#                     $env:LOCALAPPDATA\Programs\JumpServer\devolutions-gateway)
#   -Mirror           alternate base URL when GitHub release CDN is slow
#                     from the deploy host

[CmdletBinding()]
param(
    [string]$Version = $env:DGW_VERSION,
    [string]$InstallPrefix = $(if ($env:INSTALL_PREFIX) { $env:INSTALL_PREFIX } else { "$env:LOCALAPPDATA\Programs\JumpServer\devolutions-gateway" }),
    [string]$Mirror = $(if ($env:DGW_MIRROR) { $env:DGW_MIRROR } else { "https://github.com/Devolutions/devolutions-gateway/releases/download" }),
    [string]$Api = $(if ($env:DGW_API) { $env:DGW_API } else { "https://api.github.com/repos/Devolutions/devolutions-gateway/releases/latest" })
)

$ErrorActionPreference = "Stop"
function Log($msg) { Write-Host "[install-devolutions-gateway] $msg" }

# Architecture detection. Upstream currently only ships x86_64 .exe for
# Windows; arm64 ships as `jetsocat-windows-arm64.zip` but not the
# gateway itself. Refuse arm64 with a clear message rather than 404'ing.
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x86_64" }
    "ARM64" { throw "Devolutions Gateway upstream does not yet ship a Windows ARM64 binary. Run on x64 (incl. via Windows-on-ARM emulation) or build from source." }
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

$asset = "DevolutionsGateway_Windows_${Version}_${arch}.exe"
$url = "$Mirror/v$Version/$asset"
$dest = Join-Path $InstallPrefix "devolutions-gateway.exe"
$tmp = New-TemporaryFile

try {
    Log "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

    # Sanity check: a small response usually means the GitHub CDN
    # returned an HTML 404 page instead of the binary. A real
    # devolutions-gateway.exe is ~20–40 MB.
    if ((Get-Item $tmp).Length -lt 1MB) {
        $head = Get-Content -LiteralPath $tmp -TotalCount 1
        throw "downloaded payload too small ($((Get-Item $tmp).Length) bytes; first line: $head). Asset name or version likely wrong."
    }

    # If the destination .exe is held by a running gateway process,
    # Windows refuses to overwrite it but does allow rename. Move the
    # existing binary aside (unique suffix to avoid colliding with an
    # equally-locked .old from a previous run).
    if (Test-Path $dest) {
        $stale = "$dest.$([Guid]::NewGuid().ToString('N')).old"
        try {
            Rename-Item -LiteralPath $dest -NewName (Split-Path -Leaf $stale) -ErrorAction Stop
        } catch {
            Write-Warning "Could not rename existing binary ($_). Stop the running gateway and rerun this script."
            throw
        }
    }
    Move-Item -LiteralPath $tmp -Destination $dest -Force
    $tmp = $null  # ownership transferred — skip cleanup
    Log "installed: $dest"
    & $dest --version

    # Best-effort cleanup of stale `.old` siblings from prior installs.
    Get-ChildItem -LiteralPath $InstallPrefix -Filter "devolutions-gateway.exe.*.old" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
} finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
