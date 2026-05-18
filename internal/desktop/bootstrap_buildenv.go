package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Plan 19 — environment preparation for the `go build -tags freerdp`
// step. CGo via pkg-config is the cross-platform contract, but the
// .pc-file search path varies wildly between OSes / package managers.
// We assemble PKG_CONFIG_PATH (and on Windows, PATH for MinGW gcc)
// explicitly so the bootstrap doesn't rely on the operator's shell
// having sourced the right env.

// buildEnv returns the additional env vars to pass to `go build`. The
// caller appends these to os.Environ(). Empty slice if the host defaults
// already work (typical on Linux with system-installed libfreerdp).
func buildEnv() []string {
	switch runtime.GOOS {
	case "darwin":
		return darwinBuildEnv()
	case "windows":
		return windowsBuildEnv()
	}
	return nil
}

// darwinBuildEnv prepends brew's pkgconfig and lib dirs to the env so
// `pkg-config --libs freerdp3` resolves. The arch detection inside
// darwinBrewPrefix() picks /opt/homebrew (Apple Silicon) vs /usr/local
// (Intel) automatically. We also add the brew bin dir to PATH so
// `pkg-config` itself is reachable when the gateway process has a
// stripped-down environment (e.g. systemd / launchd default).
func darwinBuildEnv() []string {
	prefix := darwinBrewPrefix()
	pc := []string{
		filepath.Join(prefix, "lib", "pkgconfig"),
		filepath.Join(prefix, "share", "pkgconfig"),
		filepath.Join(prefix, "opt", "freerdp", "lib", "pkgconfig"),
	}
	if existing := os.Getenv("PKG_CONFIG_PATH"); existing != "" {
		pc = append(pc, existing)
	}
	pathExtra := filepath.Join(prefix, "bin")
	newPath := pathExtra
	if existing := os.Getenv("PATH"); existing != "" {
		newPath = pathExtra + ":" + existing
	}
	return []string{
		"PKG_CONFIG_PATH=" + strings.Join(pc, ":"),
		"PATH=" + newPath,
	}
}

// windowsBuildEnv prepends every existing MSYS2 sub-environment's bin
// dir (ucrt64 / mingw64 / clang64 / mingw32) plus `usr/bin` to PATH, and
// builds PKG_CONFIG_PATH from the matching pkgconfig dirs. MSYS2's
// "preferred" sub-env changed from MinGW64 → UCRT64 in 2022, and operators
// commonly install only one of them — probing all four means the gateway
// works regardless of which one they picked.
//
// Order matters: ucrt64 first (MSYS2's modern recommendation), then
// mingw64 (legacy default, still widespread), then clang64, then mingw32.
// `usr/bin` is appended last so the cygwin-style pkg-config is reachable
// as a fallback when no mingw subenv installed its own.
//
// When MSYS2 is installed via the vcpkg path (less common), the caller
// should supply CC + CGO_LDFLAGS manually — we don't try to guess.
func windowsBuildEnv() []string {
	tk := detectWindowsToolkit()
	if tk.Kind != "msys2" || tk.Root == "" {
		// vcpkg path: rely on the user's shell having %VCPKG_ROOT% set.
		// We don't synthesize anything because vcpkg's CMake/triplet
		// integration is more complex than cgo's pkg-config flow.
		return nil
	}
	subenvs := []string{"ucrt64", "mingw64", "clang64", "mingw32"}
	var binDirs []string
	var pcDirs []string
	for _, sub := range subenvs {
		bin := filepath.Join(tk.Root, sub, "bin")
		if !dirExists(bin) {
			continue
		}
		binDirs = append(binDirs, bin)
		for _, rel := range []string{"lib/pkgconfig", "share/pkgconfig"} {
			d := filepath.Join(tk.Root, sub, filepath.FromSlash(rel))
			if dirExists(d) {
				pcDirs = append(pcDirs, d)
			}
		}
	}
	if usr := filepath.Join(tk.Root, "usr", "bin"); dirExists(usr) {
		binDirs = append(binDirs, usr)
	}
	if len(binDirs) == 0 {
		// MSYS2 root present but no sub-env populated — nothing to add.
		return nil
	}
	sep := string(os.PathListSeparator)
	newPath := strings.Join(binDirs, sep)
	if existing := os.Getenv("PATH"); existing != "" {
		newPath = newPath + sep + existing
	}
	pc := pcDirs
	if existing := os.Getenv("PKG_CONFIG_PATH"); existing != "" {
		pc = append(pc, existing)
	}
	return []string{
		"PKG_CONFIG_PATH=" + strings.Join(pc, sep),
		"PATH=" + newPath,
		"CC=gcc",
		"CGO_ENABLED=1",
	}
}

// dirExists is a small helper used by buildEnv probes; nil-safe and
// returns false on any stat error.
func dirExists(p string) bool {
	if p == "" {
		return false
	}
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
