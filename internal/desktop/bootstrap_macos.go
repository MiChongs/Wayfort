package desktop

import (
	"os/exec"
	"runtime"
	"strings"
)

// Plan 19 — macOS-specific bootstrap helpers. Compiled on all platforms
// (uses runtime.GOOS for behaviour) so the dispatcher in bootstrap_pkg.go
// can call planInstallDarwin from unit tests on Linux.

// detectDarwin returns an osInfo for macOS. We don't probe /etc/os-release
// (doesn't exist) — runtime.GOARCH gives us the Apple-Silicon-vs-Intel
// signal that drives the brew install prefix.
func detectDarwin() osInfo {
	pretty := "macOS"
	if out, err := exec.Command("sw_vers", "-productVersion").Output(); err == nil {
		v := strings.TrimSpace(string(out))
		if v != "" {
			pretty = "macOS " + v
		}
	}
	return osInfo{
		ID:         distroDarwin,
		PrettyName: pretty,
		Arch:       runtime.GOARCH,
	}
}

// planInstallDarwin returns the brew-driven install plan. Three states:
//   1. brew on PATH         → cmds = `brew install freerdp pkg-config go`
//   2. brew missing         → empty cmds + HumanInstall that includes
//                             the official Homebrew bootstrapper
//   3. mismatched arch      → never aborts — brew handles arch internally
//
// Homebrew is intentionally per-user (no sudo); the cmds entry's
// RequiresRoot stays false so runInstallCmd doesn't try to elevate.
func planInstallDarwin(info osInfo) installPlan {
	pkgs := []string{"freerdp", "pkg-config", "go"}
	human := "brew install " + strings.Join(pkgs, " ")
	if _, err := exec.LookPath("brew"); err != nil {
		// Brew not installed — we can't auto-install it (the official
		// installer is interactive and downloads ~500MB). Provide a
		// one-liner the operator can paste.
		return installPlan{
			Pretty: info.PrettyName + " (Homebrew missing)",
			Reason: "Homebrew is required to auto-install libfreerdp on macOS but `brew` was not found in PATH.",
			HumanInstall: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && ` + human,
		}
	}
	return installPlan{
		Pretty: info.PrettyName,
		Cmds: []installCmd{{
			Argv:         append([]string{"brew", "install"}, pkgs...),
			RequiresRoot: false,
		}},
		HumanInstall: human,
	}
}

// darwinBrewPrefix returns the standard Homebrew prefix for the current
// architecture. Apple Silicon brews install under /opt/homebrew; Intel
// under /usr/local. We probe brew --prefix when it's available so a
// non-standard install (e.g. ~/homebrew) is honoured.
func darwinBrewPrefix() string {
	if out, err := exec.Command("brew", "--prefix").Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			return p
		}
	}
	if runtime.GOARCH == "arm64" {
		return "/opt/homebrew"
	}
	return "/usr/local"
}
