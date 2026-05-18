package desktop

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Plan 19 — Windows-specific bootstrap helpers.
//
// Reality check: libfreerdp 3.x on Windows is **not** in winget /
// chocolatey / scoop main repos. The only practical sources are:
//   - MSYS2's `mingw-w64-x86_64-freerdp` package (pacman) — full set
//     including pkg-config + mingw-gcc + go
//   - vcpkg `freerdp[client]:x64-windows` — provides FreeRDP but not Go
//
// We detect both and emit a plan that uses whichever is present. If
// neither is, we print a clear "install MSYS2 then re-run" message and
// the gateway keeps running with workerReady=false.

type windowsToolkit struct {
	Kind     string // "msys2" | "vcpkg" | "none"
	Root     string // C:\msys64  or  C:\vcpkg
	PacBin   string // C:\msys64\usr\bin\pacman.exe   (msys2)
	VcpkgBin string // C:\vcpkg\vcpkg.exe              (vcpkg)
}

// detectWindows returns an osInfo for Windows. We don't probe the
// registry — runtime.GOARCH plus runtime.GOOS is enough; the toolkit
// detection happens inside planInstallWindows when we need it.
func detectWindows() osInfo {
	return osInfo{
		ID:         distroWindows,
		PrettyName: "Windows " + windowsRelease(),
		Arch:       runtime.GOARCH,
	}
}

func windowsRelease() string {
	// `cmd /c ver` returns e.g. "Microsoft Windows [Version 10.0.22631.4317]".
	// Falls back to runtime.GOOS if cmd isn't on PATH (very unusual).
	if out, err := exec.Command("cmd", "/c", "ver").Output(); err == nil {
		line := strings.TrimSpace(string(out))
		if i := strings.Index(line, "[Version "); i >= 0 {
			rest := line[i+len("[Version "):]
			if j := strings.Index(rest, "]"); j > 0 {
				return rest[:j]
			}
		}
	}
	return runtime.GOOS
}

// detectWindowsToolkit looks for MSYS2 first (preferred — includes the
// full build chain), then vcpkg.
func detectWindowsToolkit() windowsToolkit {
	// MSYS2 default install root + a couple of common alternatives.
	for _, root := range []string{`C:\msys64`, `C:\msys2`, `D:\msys64`} {
		pac := root + `\usr\bin\pacman.exe`
		if _, err := os.Stat(pac); err == nil {
			return windowsToolkit{Kind: "msys2", Root: root, PacBin: pac}
		}
	}
	// MSYS2 might be on PATH (the user added it manually).
	if p, err := exec.LookPath("pacman.exe"); err == nil {
		return windowsToolkit{Kind: "msys2", PacBin: p}
	}
	// vcpkg.
	if p, err := exec.LookPath("vcpkg.exe"); err == nil {
		return windowsToolkit{Kind: "vcpkg", VcpkgBin: p, Root: trimVcpkgBin(p)}
	}
	for _, root := range []string{`C:\vcpkg`, `C:\dev\vcpkg`} {
		vb := root + `\vcpkg.exe`
		if _, err := os.Stat(vb); err == nil {
			return windowsToolkit{Kind: "vcpkg", VcpkgBin: vb, Root: root}
		}
	}
	return windowsToolkit{Kind: "none"}
}

func trimVcpkgBin(p string) string {
	if i := strings.LastIndexAny(p, `\/`); i > 0 {
		return p[:i]
	}
	return p
}

// planInstallWindows dispatches on toolkit. The hardcoded "x64" arch
// suffix mirrors what vcpkg / MSYS2 expect; on arm64 Windows we still
// build CGo against x64 toolchains for now (no aarch64 libfreerdp
// upstream packaging at time of writing).
func planInstallWindows(info osInfo) installPlan {
	tk := detectWindowsToolkit()
	switch tk.Kind {
	case "msys2":
		// pacman --noconfirm fetches packages without user interaction.
		// MSYS2 packages target the MinGW-w64 x86_64 environment that
		// CGo expects when `gcc` is at C:\msys64\mingw64\bin\gcc.exe.
		pkgs := []string{
			"mingw-w64-x86_64-freerdp",
			"mingw-w64-x86_64-pkgconf",
			"mingw-w64-x86_64-gcc",
			"mingw-w64-x86_64-go",
		}
		return installPlan{
			Pretty: info.PrettyName + " (MSYS2)",
			Cmds: []installCmd{{
				Argv:         append([]string{tk.PacBin, "-S", "--noconfirm", "--needed"}, pkgs...),
				RequiresRoot: false,
			}},
			HumanInstall: tk.PacBin + " -S --noconfirm --needed " + strings.Join(pkgs, " "),
		}
	case "vcpkg":
		// vcpkg supplies FreeRDP but not Go — operator still has to
		// install Go separately. Provide both pieces in HumanInstall.
		return installPlan{
			Pretty: info.PrettyName + " (vcpkg)",
			Cmds: []installCmd{{
				Argv:         []string{tk.VcpkgBin, "install", "freerdp[client]:x64-windows"},
				RequiresRoot: false,
			}},
			HumanInstall: tk.VcpkgBin + ` install freerdp[client]:x64-windows && winget install GoLang.Go`,
		}
	}
	// Neither toolkit found — we can't auto-install libfreerdp on Windows.
	return installPlan{
		Pretty: info.PrettyName + " (no toolkit)",
		Reason: "Windows auto-install requires MSYS2 (preferred) or vcpkg, neither is installed.",
		HumanInstall: strings.Join([]string{
			"# Option A (recommended): MSYS2",
			"#   Download installer from https://www.msys2.org/ → run → open MSYS2 shell:",
			"#     pacman -Syu",
			"#     pacman -S mingw-w64-x86_64-freerdp mingw-w64-x86_64-pkgconf mingw-w64-x86_64-gcc mingw-w64-x86_64-go",
			"# Option B: vcpkg",
			"#   git clone https://github.com/microsoft/vcpkg.git C:\\vcpkg && C:\\vcpkg\\bootstrap-vcpkg.bat",
			"#   C:\\vcpkg\\vcpkg.exe install freerdp[client]:x64-windows",
			"#   winget install GoLang.Go",
		}, "\n"),
	}
}
