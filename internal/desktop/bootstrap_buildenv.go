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

// windowsBuildEnv builds the env extension for the worker compile step.
// It locks the build to a single MSYS2 sub-environment (ucrt64 / mingw64
// / clang64 / mingw32) — never the union — because subenvs use
// incompatible C runtimes and thread models. Mixing them, e.g. UCRT64's
// gcc compiling MinGW64's libfreerdp headers, fails the moment cgo
// touches <threads.h> in winpr's platform.h.
//
// pickWindowsSubenv (see bootstrap_winhost.go) chooses the subenv that
// already has the most pieces of the toolchain in place; ties prefer
// ucrt64 (MSYS2's modern recommendation).
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
	sub := pickWindowsSubenv(tk.Root)
	if sub == "" {
		// MSYS2 root present but no sub-env populated.
		return nil
	}
	bin := filepath.Join(tk.Root, sub, "bin")
	pcDirs := []string{}
	for _, rel := range []string{"lib/pkgconfig", "share/pkgconfig"} {
		d := filepath.Join(tk.Root, sub, filepath.FromSlash(rel))
		if dirExists(d) {
			pcDirs = append(pcDirs, d)
		}
	}
	sep := string(os.PathListSeparator)
	// PATH only gets the chosen subenv's bin plus usr/bin (for the MSYS
	// shell utilities the worker module may call out to). Crucially, no
	// other subenv's bin is included — cross-subenv gcc invocation is
	// the failure mode we're avoiding.
	pathDirs := []string{bin}
	if usr := filepath.Join(tk.Root, "usr", "bin"); dirExists(usr) {
		pathDirs = append(pathDirs, usr)
	}
	newPath := strings.Join(pathDirs, sep)
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

// fileExists is the file-equivalent of dirExists.
func fileExists(p string) bool {
	if p == "" {
		return false
	}
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
