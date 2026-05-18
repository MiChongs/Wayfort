package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Plan 19 — platform-aware path helpers consolidated here. Driven by
// runtime.GOOS so a single binary's behaviour adapts at runtime; tests
// can override by monkey-patching the helper functions if needed.

// workerBaseName returns the executable filename per OS convention.
func workerBaseName() string {
	if runtime.GOOS == "windows" {
		return "freerdp-worker.exe"
	}
	return "freerdp-worker"
}

// isExecutable checks whether path refers to a runnable binary on the
// current OS. Windows looks at the .exe suffix because NTFS doesn't carry
// a Unix execute bit; everywhere else we honour mode&0o111.
func isExecutable(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		// `path` may be configured without the .exe suffix; tolerate
		// that by extending and re-checking once.
		if !strings.EqualFold(filepath.Ext(path), ".exe") {
			if _, err := os.Stat(path + ".exe"); err == nil {
				return true
			}
			return false
		}
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

// candidateWorkerPaths returns the existence-check sweep performed before
// triggering a fresh build. Includes the operator-configured path first,
// then OS-defaults, then portable fallbacks (gateway-binary directory).
func candidateWorkerPaths(configured string) []string {
	paths := []string{}
	if configured != "" {
		paths = append(paths, configured)
	}
	paths = append(paths, osDefaultWorkerPaths()...)
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), workerBaseName()))
	}
	return paths
}

// installCandidates returns the targeted install path table — in order
// of preference. installBinary loops these and uses whichever is
// writeable / atomic-renamable.
func installCandidates(configuredPrefix string) []string {
	paths := []string{}
	if configuredPrefix != "" {
		paths = append(paths, configuredPrefix)
	}
	paths = append(paths, osDefaultWorkerPaths()...)
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), workerBaseName()))
	}
	paths = append(paths, filepath.Join(os.TempDir(), workerBaseName()))
	return paths
}

// osDefaultWorkerPaths returns the canonical install locations for the
// current platform. Linux: /usr/local/bin then /usr/bin. macOS: brew
// prefix's bin, plus the historical Intel-mac /usr/local. Windows:
// Program Files (admin) and per-user LOCALAPPDATA.
func osDefaultWorkerPaths() []string {
	name := workerBaseName()
	var paths []string
	switch runtime.GOOS {
	case "darwin":
		brewPrefix := darwinBrewPrefix()
		paths = append(paths, filepath.Join(brewPrefix, "bin", name))
		if brewPrefix != "/usr/local" {
			// Cover the alternative arch's brew prefix too — useful on
			// Apple Silicon hosts running an Intel-mac brew under
			// Rosetta or the reverse.
			paths = append(paths, "/usr/local/bin/"+name)
		}
		if home, err := os.UserHomeDir(); err == nil {
			paths = append(paths, filepath.Join(home, ".local/bin", name))
		}
	case "windows":
		if pf := os.Getenv("ProgramFiles"); pf != "" {
			paths = append(paths, filepath.Join(pf, "JumpServer", name))
		}
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			paths = append(paths, filepath.Join(local, "Programs", "JumpServer", name))
		}
	default:
		paths = append(paths,
			filepath.Join("/usr/local/bin", name),
			filepath.Join("/usr/bin", name),
		)
		if home, err := os.UserHomeDir(); err == nil {
			paths = append(paths, filepath.Join(home, ".local/bin", name))
		}
	}
	return paths
}
