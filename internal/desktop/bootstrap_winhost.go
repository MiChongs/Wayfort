package desktop

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
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

// pickWindowsSubenv returns the MSYS2 sub-environment the worker build
// should target. Choice criteria, in order:
//
//  1. Subenv whose `bin/` directory exists at all (others don't have
//     anything we can use).
//  2. Among those, the one with the most pieces of the toolchain already
//     installed (gcc, pkg-config, freerdp3.pc). Maximises the chance
//     auto-install only has to add 1-2 packages.
//  3. Tie-breaker: prefer ucrt64 (MSYS2's modern recommendation), then
//     mingw64 (legacy default), clang64, mingw32.
//
// Returns "" when no MSYS2 subenv directory exists at all.
//
// Picking a single subenv (rather than letting PATH span all of them)
// keeps the C runtime + thread-model + header set internally consistent.
// Cross-subenv compilation fails on `<threads.h>` in winpr's platform.h
// and on subtle ABI mismatches downstream — better to lock the choice
// up-front than to debug mixed-CRT link errors.
func pickWindowsSubenv(root string) string {
	if root == "" {
		return ""
	}
	priority := map[string]int{"ucrt64": 0, "mingw64": 1, "clang64": 2, "mingw32": 3}
	type cand struct {
		name  string
		score int
		order int
	}
	var cands []cand
	for sub, order := range priority {
		bin := filepath.Join(root, sub, "bin")
		if !dirExists(bin) {
			continue
		}
		score := 0
		if fileExists(filepath.Join(bin, "gcc.exe")) {
			score++
		}
		if fileExists(filepath.Join(bin, "pkg-config.exe")) {
			score++
		}
		if fileExists(filepath.Join(root, sub, "lib", "pkgconfig", "freerdp3.pc")) {
			score++
		}
		cands = append(cands, cand{name: sub, score: score, order: order})
	}
	if len(cands) == 0 {
		return ""
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].score != cands[j].score {
			return cands[i].score > cands[j].score
		}
		return cands[i].order < cands[j].order
	})
	return cands[0].name
}

// pkgPrefixForSubenv returns the MSYS2 package name prefix that installs
// into the given subenv. Critical because installing `mingw-w64-x86_64-X`
// (MinGW64 prefix) into a UCRT64-targeted build produces the
// cross-runtime mismatch we're avoiding.
func pkgPrefixForSubenv(sub string) string {
	switch sub {
	case "ucrt64":
		return "mingw-w64-ucrt-x86_64-"
	case "clang64":
		return "mingw-w64-clang-x86_64-"
	case "mingw32":
		return "mingw-w64-i686-"
	}
	// mingw64 (and unknown) — historical default prefix.
	return "mingw-w64-x86_64-"
}

// planInstallWindows dispatches on toolkit. The package prefix is
// derived from pickWindowsSubenv so install lands in the same subenv
// the build will compile against.
func planInstallWindows(info osInfo) installPlan {
	tk := detectWindowsToolkit()
	switch tk.Kind {
	case "msys2":
		// Choose the subenv before deciding which package names to ask
		// pacman for. If the operator already has gcc in UCRT64 we want
		// to install the UCRT64 variants of freerdp/pkgconf so the build
		// step sees a single consistent subenv. Missing subenv selection
		// (returned "") falls through to mingw64 — the historical default.
		sub := pickWindowsSubenv(tk.Root)
		if sub == "" {
			sub = "mingw64"
		}
		prefix := pkgPrefixForSubenv(sub)
		pkgs := []string{
			prefix + "freerdp",
			prefix + "pkgconf",
			prefix + "gcc",
			prefix + "go",
		}
		return installPlan{
			Pretty: info.PrettyName + " (MSYS2/" + sub + ")",
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
