#!/usr/bin/env bash
# Cross-platform dispatcher — picks the right build-worker-* script based
# on `uname -s`. Pass any extra args through to the per-OS script.
#
# Usage:
#   scripts/build-worker.sh                          # auto-detect OS
#   scripts/build-worker.sh ~/.local/bin             # Linux/macOS: custom prefix
#   scripts/build-worker.sh -Subenv mingw64          # MSYS shell: PowerShell args pass through

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)

case "$(uname -s)" in
    Linux*)
        exec "$ROOT/scripts/build-worker-linux.sh" "$@"
        ;;
    Darwin*)
        exec "$ROOT/scripts/build-worker-darwin.sh" "$@"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        # Running inside an MSYS/Git-Bash shell on Windows — invoke
        # PowerShell directly. Use cmd.exe-style path so PowerShell can
        # find the .ps1 regardless of MSYS's mount mapping.
        psScript="$ROOT/scripts/build-worker-windows.ps1"
        if command -v powershell.exe >/dev/null; then
            exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$psScript" "$@"
        elif command -v pwsh >/dev/null; then
            exec pwsh -NoProfile -ExecutionPolicy Bypass -File "$psScript" "$@"
        else
            echo "ERROR: powershell.exe / pwsh not on PATH. Run scripts/build-worker-windows.ps1 directly from a PowerShell prompt." >&2
            exit 1
        fi
        ;;
    *)
        echo "ERROR: unsupported OS: $(uname -s)" >&2
        echo "See scripts/README.md for manual build instructions." >&2
        exit 1
        ;;
esac
