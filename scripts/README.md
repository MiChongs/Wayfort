# Build scripts

## Gateway

```bash
bash scripts/build-gateway.sh           # → ./bin/jumpserver{,.exe}
bash scripts/build-gateway.sh /opt/js   # → /opt/js/jumpserver{,.exe}
```

Pure Go, no CGo, works on every OS Go supports.

## FreeRDP worker

The workspace v2 `rdp_next` protocol uses a separate `freerdp-worker`
binary built from `cmd/freerdp-worker` against libfreerdp 3.x via CGo.
The gateway binary itself doesn't depend on libfreerdp; the worker is a
standalone process the gateway spawns when a session needs the new RDP
stack. Classic RDP/VNC (Guacamole) does **not** need the worker.

Pick the script matching your OS:

| OS | Command | Default install path |
| --- | --- | --- |
| Linux (Debian/Ubuntu/Fedora/Alpine) | `bash scripts/build-worker-linux.sh` | `/usr/local/bin/freerdp-worker` |
| macOS | `bash scripts/build-worker-darwin.sh` | `$(brew --prefix)/bin/freerdp-worker` |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts/build-worker-windows.ps1` | `%LOCALAPPDATA%\Programs\JumpServer\freerdp-worker.exe` |

Or auto-detect (run from any shell, including Git Bash on Windows):

```bash
bash scripts/build-worker.sh
```

The install paths match what
[`internal/desktop/bootstrap_paths.go`](../internal/desktop/bootstrap_paths.go)
searches at gateway startup, so once the worker is in place the next
gateway start picks it up automatically. No `desktop.worker_path`
override needed.

### Common variations

```bash
# Linux: install per-user (no sudo)
bash scripts/build-worker-linux.sh ~/.local/bin

# Linux: skip apt/dnf, build only (deps already installed)
SKIP_DEPS=1 bash scripts/build-worker-linux.sh

# macOS: install per-user
bash scripts/build-worker-darwin.sh ~/.local/bin

# Windows: pick MinGW64 instead of UCRT64 (legacy default)
powershell -ExecutionPolicy Bypass -File scripts/build-worker-windows.ps1 -Subenv mingw64

# Windows: MSYS2 in a non-default location
powershell -ExecutionPolicy Bypass -File scripts/build-worker-windows.ps1 -Msys2Root D:\msys64

# Windows: machine-wide install (run PowerShell as Administrator)
powershell -ExecutionPolicy Bypass -File scripts/build-worker-windows.ps1 -InstallDir "$env:ProgramFiles\JumpServer"
```

### Make targets

```bash
make build              # gateway
make build-worker       # worker into ./bin (no install)
make install-worker     # worker + install via OS dispatcher
make install-worker-linux
make install-worker-darwin
make install-worker-windows
```

### Refreshing without a gateway restart

`POST /api/v1/desktop/bootstrap` re-runs the binary search. After
running the script above, hitting that endpoint surfaces the new worker
without restarting the gateway.

## Why not auto-install at runtime?

Earlier, the gateway tried to install build deps and compile the worker
on every startup via an embedded source mirror. That path produced
cross-CRT mismatches on Windows (UCRT vs MSVCRT), pacman invocations
that landed in the wrong MSYS2 subenv, and a five-stage error pipeline
that surfaced as opaque stack traces at startup. Pre-building via an
explicit script is the supported approach now — same shape as
`./configure && make install` for C projects.

Old `desktop.auto_install: true` config is recognised for backward
compatibility but ignored. The startup log surfaces a deprecation
notice; remove the line at your convenience.
