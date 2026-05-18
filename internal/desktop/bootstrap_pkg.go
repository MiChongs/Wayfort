package desktop

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Plan 18 — operating-system detection + package-manager mapping for the
// auto-install path. Pure functions where possible; the actual exec
// shells out via runCmd().

type distroID string

const (
	distroUnknown distroID = ""
	distroDebian  distroID = "debian" // also ubuntu / linuxmint
	distroFedora  distroID = "fedora" // also rhel / centos / rocky
	distroAlpine  distroID = "alpine"
	distroDarwin  distroID = "darwin"
)

// osInfo represents the subset of /etc/os-release fields we care about.
type osInfo struct {
	ID         distroID
	IDLike     []string
	VersionID  string
	PrettyName string
}

// detectOS returns the running distribution (Linux) or "darwin" on macOS.
// `os-release(5)` is the standard cross-distro discovery file.
func detectOS() osInfo {
	if runtime.GOOS == "darwin" {
		return osInfo{ID: distroDarwin, PrettyName: "macOS"}
	}
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return osInfo{}
	}
	defer f.Close()
	info := osInfo{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		switch k {
		case "ID":
			info.ID = mapDistroID(v)
		case "ID_LIKE":
			info.IDLike = strings.Fields(strings.Trim(v, `"`))
		case "VERSION_ID":
			info.VersionID = v
		case "PRETTY_NAME":
			info.PrettyName = v
		}
	}
	if info.ID == distroUnknown {
		// Fall back to ID_LIKE so RHEL clones, Pop!_OS etc. classify.
		for _, like := range info.IDLike {
			if m := mapDistroID(like); m != distroUnknown {
				info.ID = m
				break
			}
		}
	}
	return info
}

func mapDistroID(raw string) distroID {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "ubuntu", "debian", "linuxmint", "raspbian", "pop":
		return distroDebian
	case "fedora", "rhel", "centos", "rocky", "almalinux", "amzn", "ol":
		return distroFedora
	case "alpine":
		return distroAlpine
	case "darwin":
		return distroDarwin
	}
	return distroUnknown
}

// installPlan describes how to install build-time deps for the worker.
type installPlan struct {
	// PrettyDescription used by the bootstrapper log.
	Pretty string
	// Cmds is the ordered list of shell argv slices to run. May be empty if
	// the distro is unsupported.
	Cmds [][]string
	// Reason explains an empty plan to the operator.
	Reason string
	// HumanInstall is a copy-paste string the operator can run themselves
	// if the auto-install fails.
	HumanInstall string
}

// planInstall returns the install plan for the detected OS. Distros that
// don't ship libfreerdp 3.x get an empty Cmds + a clear Reason.
func planInstall(info osInfo) installPlan {
	switch info.ID {
	case distroDebian:
		// Ubuntu 22.04 / Debian 12 only have freerdp2; 24.04 / Debian 13 have 3.
		needsBackport := false
		if info.PrettyName != "" {
			lower := strings.ToLower(info.PrettyName)
			if strings.Contains(lower, "22.04") || strings.Contains(lower, "bookworm") {
				needsBackport = true
			}
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
			Pretty:       info.PrettyName,
			Cmds:         [][]string{append([]string{"apt-get", "install", "-y", "--no-install-recommends"}, pkgs...)},
			HumanInstall: "sudo apt-get install -y " + strings.Join(pkgs, " "),
		}
	case distroFedora:
		pkgs := []string{"freerdp-devel", "pkg-config", "gcc", "golang"}
		return installPlan{
			Pretty:       info.PrettyName,
			Cmds:         [][]string{append([]string{"dnf", "install", "-y"}, pkgs...)},
			HumanInstall: "sudo dnf install -y " + strings.Join(pkgs, " "),
		}
	case distroAlpine:
		pkgs := []string{"freerdp-dev", "pkgconfig", "build-base", "go"}
		return installPlan{
			Pretty:       "Alpine Linux " + info.VersionID,
			Cmds:         [][]string{append([]string{"apk", "add", "--no-cache"}, pkgs...)},
			HumanInstall: "sudo apk add " + strings.Join(pkgs, " "),
		}
	case distroDarwin:
		pkgs := []string{"freerdp", "pkg-config", "go"}
		return installPlan{
			Pretty:       "macOS",
			Cmds:         [][]string{append([]string{"brew", "install"}, pkgs...)},
			HumanInstall: "brew install " + strings.Join(pkgs, " "),
		}
	}
	return installPlan{
		Reason:       "unsupported distribution (or detection failed)",
		HumanInstall: "see README; install libfreerdp 3.x + pkg-config + Go ≥1.22 manually",
	}
}

// runCmd executes argv as a child process, capturing stdout+stderr into a
// merged byte slice. When the caller is not root we prepend sudo -n so
// passwordless sudo elevates; if that fails the bootstrapper falls back
// to printing the human command.
func runCmd(ctx context.Context, argv []string, requiresRoot bool) ([]byte, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("empty argv")
	}
	if requiresRoot && os.Geteuid() != 0 {
		argv = append([]string{"sudo", "-n"}, argv...)
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	out, err := cmd.CombinedOutput()
	return out, err
}
