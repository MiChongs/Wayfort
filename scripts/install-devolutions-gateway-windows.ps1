# install-devolutions-gateway-windows.ps1
#
# Downloads the Devolutions Gateway Windows release archive and drops
# the binary into $InstallPrefix. Replacement for the libfreerdp-based
# build-worker-windows.ps1 chain — no MSYS2, no cgo toolchain. Native
# x64 binary distributed by Devolutions.
#
# Parameters / env overrides:
#   -Version          DGW release tag (default: pinned constant below)
#   -InstallPrefix    where the binary ends up (default:
#                     $env:LOCALAPPDATA\Programs\JumpServer\devolutions-gateway)
#   -Mirror           alternate base URL when GitHub releases is slow
#                     from the deploy host

[CmdletBinding()]
param(
    [string]$Version = $(if ($env:DGW_VERSION) { $env:DGW_VERSION } else { "2025.3.5" }),
    [string]$InstallPrefix = $(if ($env:INSTALL_PREFIX) { $env:INSTALL_PREFIX } else { "$env:LOCALAPPDATA\Programs\JumpServer\devolutions-gateway" }),
    [string]$Mirror = $(if ($env:DGW_MIRROR) { $env:DGW_MIRROR } else { "https://github.com/Devolutions/devolutions-gateway/releases/download" })
)

$ErrorActionPreference = "Stop"

function Log($msg) { Write-Host "[install-devolutions-gateway] $msg" }

# Devolutions ships per-arch binaries; detect from PROCESSOR_ARCHITECTURE.
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x86_64" }
    "ARM64" { "aarch64" }
    default { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

if (-not (Test-Path $InstallPrefix)) { New-Item -ItemType Directory -Force -Path $InstallPrefix | Out-Null }
$configDir = Join-Path $InstallPrefix "config"
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Force -Path $configDir | Out-Null }

$asset = "DevolutionsGateway_windows_${Version}_${arch}.zip"
$url = "$Mirror/v$Version/$asset"
$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "dgw-install-$(Get-Random)")
try {
    $archivePath = Join-Path $tmp.FullName $asset
    Log "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing
    Log "extracting"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tmp.FullName -Force

    $bin = Get-ChildItem -LiteralPath $tmp.FullName -Recurse -Filter "devolutions-gateway.exe" |
        Select-Object -First 1
    if (-not $bin) { throw "devolutions-gateway.exe not found in archive payload" }

    $dest = Join-Path $InstallPrefix "devolutions-gateway.exe"
    # The destination .exe may be running from a previous install. Rename
    # the live file out of the way so we can drop the new one in (Windows
    # allows renaming open executables but not overwriting them).
    if (Test-Path $dest) {
        $stale = "$dest.$([Guid]::NewGuid().ToString('N')).old"
        try {
            Rename-Item -LiteralPath $dest -NewName (Split-Path -Leaf $stale) -ErrorAction Stop
        } catch {
            Write-Warning "Failed to rename existing binary ($_). If a gateway process is running, stop it first."
        }
    }
    Copy-Item -LiteralPath $bin.FullName -Destination $dest -Force
    Log "installed: $dest"
    & $dest --version
} finally {
    Remove-Item -LiteralPath $tmp.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
