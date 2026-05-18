package desktop

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Plan 18/19 — operating-system detection + package-manager mapping for
// the auto-install path. The cross-platform skeleton lives here; per-OS
// plans (Linux distros, macOS Homebrew, Windows MSYS2/vcpkg) live in
// bootstrap_linux.go / bootstrap_darwin.go / bootstrap_windows.go.

type distroID string

const (
	distroUnknown distroID = ""
	// Linux families.
	distroDebian distroID = "debian" // also ubuntu / linuxmint
	distroFedora distroID = "fedora" // also rhel / centos / rocky
	distroAlpine distroID = "alpine"
	// Non-Linux platforms.
	distroDarwin  distroID = "darwin"
	distroWindows distroID = "windows"
)

// osInfo summarises what bootstrap needs to know about the host.
type osInfo struct {
	ID         distroID
	IDLike     []string
	VersionID  string
	PrettyName string
	Arch       string // runtime.GOARCH — amd64 / arm64 / 386 / ...
}

// detectOS dispatches on runtime.GOOS first. Only the Linux branch reads
// /etc/os-release; macOS and Windows use their own detectors so we don't
// depend on a file that doesn't exist.
func detectOS() osInfo {
	switch runtime.GOOS {
	case "darwin":
		return detectDarwin()
	case "windows":
		return detectWindows()
	default:
		return detectLinux()
	}
}

// detectLinux reads /etc/os-release per the systemd standard. Falls back
// to ID_LIKE when ID isn't in our map (e.g. RHEL clones, Pop!_OS).
func detectLinux() osInfo {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return osInfo{Arch: runtime.GOARCH}
	}
	defer f.Close()
	info := osInfo{Arch: runtime.GOARCH}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		switch k {
		case "ID":
			info.ID = mapLinuxID(v)
		case "ID_LIKE":
			info.IDLike = strings.Fields(strings.Trim(v, `"`))
		case "VERSION_ID":
			info.VersionID = v
		case "PRETTY_NAME":
			info.PrettyName = v
		}
	}
	if info.ID == distroUnknown {
		for _, like := range info.IDLike {
			if m := mapLinuxID(like); m != distroUnknown {
				info.ID = m
				break
			}
		}
	}
	return info
}

func mapLinuxID(raw string) distroID {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "ubuntu", "debian", "linuxmint", "raspbian", "pop":
		return distroDebian
	case "fedora", "rhel", "centos", "rocky", "almalinux", "amzn", "ol":
		return distroFedora
	case "alpine":
		return distroAlpine
	}
	return distroUnknown
}

// installCmd is a single command to run during the install step. Each
// command carries its own elevation hint so a multi-step plan can mix
// privileged + unprivileged operations (e.g. `apt-get install` then a
// per-user `mkdir`).
type installCmd struct {
	Argv         []string
	RequiresRoot bool
	// Env adds environment variables to the child process. Inherits
	// from os.Environ() before applying.
	Env []string
}

// installPlan describes how to install build-time deps for the worker.
type installPlan struct {
	Pretty       string       // human label for logs
	Cmds         []installCmd // ordered; abort on first failure unless empty
	Reason       string       // non-empty when Cmds is empty + we want to explain
	HumanInstall string       // copy-paste line for the operator
}

// planInstall returns the install plan for the detected OS. Unknown
// platforms get an empty Cmds + a populated Reason.
func planInstall(info osInfo) installPlan {
	switch info.ID {
	case distroDebian:
		return planInstallDebian(info)
	case distroFedora:
		return planInstallFedora(info)
	case distroAlpine:
		return planInstallAlpine(info)
	case distroDarwin:
		return planInstallDarwin(info)
	case distroWindows:
		return planInstallWindows(info)
	}
	return installPlan{
		Reason:       fmt.Sprintf("unsupported platform (goos=%s, distro=%s)", runtime.GOOS, info.ID),
		HumanInstall: "install libfreerdp 3.x + pkg-config + Go ≥1.22 manually; see README",
	}
}

// ----- Per-Linux-distro plans (kept inline; small, stable, no per-OS detection) -----

func planInstallDebian(info osInfo) installPlan {
	needsBackport := false
	lower := strings.ToLower(info.PrettyName)
	if strings.Contains(lower, "22.04") || strings.Contains(lower, "bookworm") {
		// Ubuntu 22.04 / Debian 12 ship freerdp2 only. Auto-install can't
		// resolve that without a PPA or source build — surface clear
		// guidance instead of trying.
		needsBackport = true
	}
	if needsBackport {
		return installPlan{
			Pretty: info.PrettyName + " (freerdp2 only)",
			Reason: "this distribution ships libfreerdp 2.x; the worker requires 3.x. " +
				"Install a backport / build libfreerdp 3 from source, then set desktop.auto_install: false.",
			HumanInstall: "see https://github.com/FreeRDP/FreeRDP/wiki/Compilation",
		}
	}
	pkgs := []string{
		"freerdp3-dev", "libwinpr3-dev",
		"pkg-config", "build-essential", "golang",
	}
	return installPlan{
		Pretty: info.PrettyName,
		Cmds: []installCmd{{
			Argv:         append([]string{"apt-get", "install", "-y", "--no-install-recommends"}, pkgs...),
			RequiresRoot: true,
		}},
		HumanInstall: "sudo apt-get install -y " + strings.Join(pkgs, " "),
	}
}

func planInstallFedora(info osInfo) installPlan {
	pkgs := []string{"freerdp-devel", "pkg-config", "gcc", "golang"}
	return installPlan{
		Pretty: info.PrettyName,
		Cmds: []installCmd{{
			Argv:         append([]string{"dnf", "install", "-y"}, pkgs...),
			RequiresRoot: true,
		}},
		HumanInstall: "sudo dnf install -y " + strings.Join(pkgs, " "),
	}
}

func planInstallAlpine(info osInfo) installPlan {
	pkgs := []string{"freerdp-dev", "pkgconfig", "build-base", "go"}
	return installPlan{
		Pretty: "Alpine Linux " + info.VersionID,
		Cmds: []installCmd{{
			Argv:         append([]string{"apk", "add", "--no-cache"}, pkgs...),
			RequiresRoot: true,
		}},
		HumanInstall: "sudo apk add " + strings.Join(pkgs, " "),
	}
}

// runInstallCmd executes one entry from installPlan.Cmds, applying the
// platform-appropriate privilege escalation. Returns the merged
// stdout+stderr output along with the exec error.
//
// Privilege semantics by platform:
//   linux / freebsd: if RequiresRoot && euid!=0, prepend `sudo -n`
//     (passwordless sudo); if sudo missing or refuses, surface a clear
//     error so the operator can re-run as root or grant NOPASSWD.
//   darwin:          brew is per-user; we never auto-elevate. If the
//     plan explicitly marks RequiresRoot=true on darwin (rare; e.g.
//     installing into /usr/local on Intel where it's root-owned) we
//     still try sudo -n.
//   windows:         no sudo. RequiresRoot=true means we run the command
//     as the current process; if the process isn't admin and pacman /
//     vcpkg returns ACCESS_DENIED, the caller sees the error and the
//     log advises restarting the gateway as Administrator.
func runInstallCmd(ctx context.Context, c installCmd) ([]byte, error) {
	if len(c.Argv) == 0 {
		return nil, errors.New("empty argv")
	}
	argv := c.Argv
	if c.RequiresRoot {
		switch runtime.GOOS {
		case "windows":
			// No-op: Windows commands are invoked as the gateway's
			// session user. If admin is needed and we don't have it,
			// the child process will fail and the error reaches us.
		default:
			if os.Geteuid() != 0 {
				if _, err := exec.LookPath("sudo"); err != nil {
					return nil, fmt.Errorf("requires root and sudo not available; run as root or pre-install: %s",
						strings.Join(argv, " "))
				}
				argv = append([]string{"sudo", "-n"}, argv...)
			}
		}
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	if len(c.Env) > 0 {
		cmd.Env = append(os.Environ(), c.Env...)
	}
	return cmd.CombinedOutput()
}
