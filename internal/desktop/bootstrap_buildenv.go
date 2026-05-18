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

// windowsBuildEnv prepends MSYS2's mingw64 bin to PATH so cgo's default
// `gcc` lookup finds the MinGW-w64 toolchain, and adds the matching
// pkgconfig dir. When MSYS2 is installed via the vcpkg path (less
// common), the caller should supply CC + CGO_LDFLAGS manually — we
// don't try to guess.
func windowsBuildEnv() []string {
	tk := detectWindowsToolkit()
	if tk.Kind != "msys2" || tk.Root == "" {
		// vcpkg path: rely on the user's shell having %VCPKG_ROOT% set.
		// We don't synthesize anything because vcpkg's CMake/triplet
		// integration is more complex than cgo's pkg-config flow.
		return nil
	}
	mingw := filepath.Join(tk.Root, "mingw64")
	bin := filepath.Join(mingw, "bin")
	pc := []string{
		filepath.Join(mingw, "lib", "pkgconfig"),
		filepath.Join(mingw, "share", "pkgconfig"),
	}
	if existing := os.Getenv("PKG_CONFIG_PATH"); existing != "" {
		pc = append(pc, existing)
	}
	newPath := bin
	if existing := os.Getenv("PATH"); existing != "" {
		newPath = bin + ";" + existing
	}
	return []string{
		"PKG_CONFIG_PATH=" + strings.Join(pc, string(os.PathListSeparator)),
		"PATH=" + newPath,
		"CC=gcc",
		"CGO_ENABLED=1",
	}
}
