package pkg

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var pkgNameRe = regexp.MustCompile(`^[a-zA-Z0-9._+:@-]{1,128}$`)

func validName(s string) bool { return s != "" && pkgNameRe.MatchString(s) }

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// detectScript probes the package managers in priority order.
const detectScript = `LC_ALL=C
for m in apt-get dnf yum apk zypper; do command -v $m >/dev/null 2>&1 && echo $m; done
`

func detectManager(out string) Kind {
	for _, line := range splitNonEmptyLines(out) {
		switch strings.TrimSpace(line) {
		case "apt-get":
			return KindApt
		case "dnf":
			return KindDnf
		case "yum":
			return KindYum
		case "apk":
			return KindApk
		case "zypper":
			return KindZypper
		}
	}
	return KindNone
}

// statusScript returns the installed count + upgradable list for the manager.
func statusScript(k Kind) string {
	switch k {
	case KindApt:
		return `LC_ALL=C
echo '===COUNT==='
dpkg-query -f '.\n' -W 2>/dev/null | wc -l
echo '===UPG==='
apt list --upgradable 2>/dev/null | grep -v '^Listing'
echo '===END==='
`
	case KindDnf, KindYum:
		bin := "dnf"
		if k == KindYum {
			bin = "yum"
		}
		return fmt.Sprintf(`LC_ALL=C
echo '===COUNT==='
rpm -qa 2>/dev/null | wc -l
echo '===UPG==='
%s -q check-update 2>/dev/null
echo '===END==='
`, bin)
	case KindApk:
		return `LC_ALL=C
echo '===COUNT==='
apk info 2>/dev/null | wc -l
echo '===UPG==='
apk version -l '<' 2>/dev/null | grep -v '^Installed'
echo '===END==='
`
	case KindZypper:
		return `LC_ALL=C
echo '===COUNT==='
rpm -qa 2>/dev/null | wc -l
echo '===UPG==='
zypper -q list-updates 2>/dev/null
echo '===END==='
`
	}
	return ""
}

// parseUpgradable parses the manager-specific upgradable list.
func parseUpgradable(k Kind, out string) []Update {
	ups := []Update{}
	for _, line := range splitNonEmptyLines(out) {
		line = strings.TrimSpace(line)
		switch k {
		case KindApt:
			// nginx/focal-updates 1.18.0-2 amd64 [upgradable from: 1.18.0-1]
			name, _, ok := strings.Cut(line, "/")
			if !ok {
				continue
			}
			f := strings.Fields(line)
			u := Update{Name: name}
			if len(f) >= 2 {
				u.Candidate = f[1]
			}
			if i := strings.Index(line, "from: "); i >= 0 {
				u.Current = strings.TrimSuffix(strings.TrimSpace(line[i+6:]), "]")
			}
			if strings.Contains(strings.ToLower(line), "security") {
				u.Security = true
			}
			ups = append(ups, u)
		case KindDnf, KindYum, KindZypper:
			f := strings.Fields(line)
			if len(f) < 2 || strings.HasPrefix(line, "Last metadata") || strings.HasPrefix(line, "Obsoleting") {
				continue
			}
			// name.arch  candidate  repo   (zypper rows differ but field[0]=name-ish)
			name := f[0]
			if k == KindZypper && len(f) >= 5 {
				// v | repo | name | current | candidate
				name = f[2]
			}
			u := Update{Name: name}
			if len(f) >= 2 {
				u.Candidate = f[1]
			}
			ups = append(ups, u)
		case KindApk:
			// pkg-1.0 < 1.1
			f := strings.Fields(line)
			if len(f) < 3 {
				continue
			}
			u := Update{Name: trimApkName(f[0]), Current: trimApkVer(f[0]), Candidate: f[2]}
			ups = append(ups, u)
		}
	}
	return ups
}

func trimApkName(s string) string {
	// strip trailing -<version> (last two dash segments are version-ish); keep simple.
	if i := strings.LastIndex(s, "-"); i > 0 {
		if j := strings.LastIndex(s[:i], "-"); j > 0 {
			return s[:j]
		}
		return s[:i]
	}
	return s
}
func trimApkVer(s string) string {
	if i := strings.LastIndex(s, "-"); i > 0 {
		if j := strings.LastIndex(s[:i], "-"); j > 0 {
			return s[j+1:]
		}
	}
	return ""
}

func countSecurity(ups []Update) int {
	n := 0
	for _, u := range ups {
		if u.Security {
			n++
		}
	}
	return n
}

// actionCommand builds the non-interactive write command for a verb/name.
func actionCommand(k Kind, verb Verb, name string) (string, error) {
	q := ""
	if verb == VerbInstall || verb == VerbRemove || verb == VerbUpgrade {
		if !validName(name) {
			return "", ErrBadName
		}
		q = " " + shellQuote(name)
	}
	switch k {
	case KindApt:
		base := "DEBIAN_FRONTEND=noninteractive apt-get -y"
		switch verb {
		case VerbInstall:
			return base + " install" + q + " 2>&1", nil
		case VerbRemove:
			return base + " remove" + q + " 2>&1", nil
		case VerbUpgrade:
			return base + " install --only-upgrade" + q + " 2>&1", nil
		case VerbUpgradeAll:
			return base + " upgrade 2>&1", nil
		case VerbUpdate:
			return "apt-get update 2>&1", nil
		case VerbAutoremove:
			return base + " autoremove 2>&1", nil
		case VerbClean:
			return "apt-get clean 2>&1", nil
		}
	case KindDnf, KindYum:
		bin := "dnf"
		if k == KindYum {
			bin = "yum"
		}
		switch verb {
		case VerbInstall:
			return bin + " -y install" + q + " 2>&1", nil
		case VerbRemove:
			return bin + " -y remove" + q + " 2>&1", nil
		case VerbUpgrade:
			return bin + " -y upgrade" + q + " 2>&1", nil
		case VerbUpgradeAll:
			return bin + " -y upgrade 2>&1", nil
		case VerbUpdate:
			return bin + " -y makecache 2>&1", nil
		case VerbAutoremove:
			return bin + " -y autoremove 2>&1", nil
		case VerbClean:
			return bin + " clean all 2>&1", nil
		}
	case KindApk:
		switch verb {
		case VerbInstall:
			return "apk add" + q + " 2>&1", nil
		case VerbRemove:
			return "apk del" + q + " 2>&1", nil
		case VerbUpgrade:
			return "apk upgrade" + q + " 2>&1", nil
		case VerbUpgradeAll:
			return "apk upgrade 2>&1", nil
		case VerbUpdate:
			return "apk update 2>&1", nil
		case VerbClean:
			return "apk cache clean 2>&1", nil
		case VerbAutoremove:
			return "", ErrUnsupported
		}
	case KindZypper:
		switch verb {
		case VerbInstall:
			return "zypper -n install" + q + " 2>&1", nil
		case VerbRemove:
			return "zypper -n remove" + q + " 2>&1", nil
		case VerbUpgrade, VerbUpgradeAll:
			return "zypper -n update" + q + " 2>&1", nil
		case VerbUpdate:
			return "zypper -n refresh 2>&1", nil
		case VerbClean:
			return "zypper clean 2>&1", nil
		case VerbAutoremove:
			return "", ErrUnsupported
		}
	}
	return "", ErrNoManager
}

// ---- info / installed / files / history / hold ----

func infoScript(k Kind, name string) (string, error) {
	if !validName(name) {
		return "", ErrBadName
	}
	q := shellQuote(name)
	switch k {
	case KindApt:
		return fmt.Sprintf("LC_ALL=C apt-cache show %s 2>/dev/null | head -60; echo '__INSTALLED__'; dpkg -s %s 2>/dev/null | grep -i '^Status:'", q, q), nil
	case KindDnf:
		return fmt.Sprintf("LC_ALL=C dnf -q info %s 2>/dev/null", q), nil
	case KindYum:
		return fmt.Sprintf("LC_ALL=C yum -q info %s 2>/dev/null", q), nil
	case KindApk:
		return fmt.Sprintf("LC_ALL=C apk info -a %s 2>/dev/null", q), nil
	case KindZypper:
		return fmt.Sprintf("LC_ALL=C zypper -q info %s 2>/dev/null", q), nil
	}
	return "", ErrNoManager
}

// parseInfo extracts common fields from the manager's info output (key:value
// across apt/dnf/yum/zypper; apk has its own layout but raw is always kept).
func parseInfo(k Kind, name, out string) Info {
	info := Info{Name: name, Raw: strings.TrimRight(out, "\n")}
	get := func(keys ...string) string {
		for _, line := range splitNonEmptyLines(out) {
			kk, vv, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			kk = strings.TrimSpace(kk)
			for _, want := range keys {
				if strings.EqualFold(kk, want) {
					return strings.TrimSpace(vv)
				}
			}
		}
		return ""
	}
	info.Version = get("Version")
	info.Size = get("Installed-Size", "Size", "Installed Size")
	info.Summary = get("Description", "Summary")
	info.Homepage = get("Homepage", "URL")
	info.Section = get("Section", "Repository", "Repo")
	if dep := get("Depends", "Requires"); dep != "" {
		for _, d := range strings.Split(dep, ",") {
			if t := strings.TrimSpace(d); t != "" {
				info.Depends = append(info.Depends, t)
			}
		}
	}
	low := strings.ToLower(out)
	info.Installed = strings.Contains(low, "status: install ok installed") ||
		strings.Contains(low, "installed packages") || strings.Contains(low, "installed size")
	return info
}

func installedScript(k Kind) string {
	switch k {
	case KindApt:
		return "LC_ALL=C dpkg-query -W -f '${Package}\\t${Version}\\n' 2>/dev/null"
	case KindDnf, KindYum, KindZypper:
		return "LC_ALL=C rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n' 2>/dev/null"
	case KindApk:
		return "LC_ALL=C apk info -v 2>/dev/null"
	}
	return ""
}

func parseInstalled(k Kind, out string) []Pkg {
	res := []Pkg{}
	for _, line := range splitNonEmptyLines(out) {
		if k == KindApk {
			// apk: name-version (split last two dash segments as version)
			res = append(res, Pkg{Name: trimApkName(line), Version: trimApkVer(line), Installed: true})
			continue
		}
		name, ver, ok := strings.Cut(line, "\t")
		if !ok {
			f := strings.Fields(line)
			if len(f) == 0 {
				continue
			}
			name = f[0]
			if len(f) > 1 {
				ver = f[1]
			}
		}
		res = append(res, Pkg{Name: strings.TrimSpace(name), Version: strings.TrimSpace(ver), Installed: true})
	}
	return res
}

func filesScript(k Kind, name string) (string, error) {
	if !validName(name) {
		return "", ErrBadName
	}
	q := shellQuote(name)
	switch k {
	case KindApt:
		return fmt.Sprintf("LC_ALL=C dpkg -L %s 2>/dev/null | head -400", q), nil
	case KindDnf, KindYum, KindZypper:
		return fmt.Sprintf("LC_ALL=C rpm -ql %s 2>/dev/null | head -400", q), nil
	case KindApk:
		return fmt.Sprintf("LC_ALL=C apk info -L %s 2>/dev/null | head -400", q), nil
	}
	return "", ErrNoManager
}

func historyScript(k Kind) string {
	switch k {
	case KindApt:
		return "LC_ALL=C (zcat -f /var/log/apt/history.log* 2>/dev/null | grep -E '^(Start-Date|Commandline|Install|Remove|Upgrade):' | tail -120)"
	case KindDnf:
		return "LC_ALL=C dnf history list 2>/dev/null | head -40"
	case KindYum:
		return "LC_ALL=C yum history list 2>/dev/null | head -40"
	case KindZypper:
		return "LC_ALL=C tail -120 /var/log/zypp/history 2>/dev/null"
	case KindApk:
		return "LC_ALL=C tail -120 /var/log/apk.log 2>/dev/null || echo '(apk 无历史日志)'"
	}
	return ""
}

// holdCommand toggles a version hold (apt-mark / dnf versionlock). Returns
// ErrUnsupported for managers without a stable hold mechanism.
func holdCommand(k Kind, name string, hold bool) (string, error) {
	if !validName(name) {
		return "", ErrBadName
	}
	q := shellQuote(name)
	switch k {
	case KindApt:
		if hold {
			return "apt-mark hold " + q + " 2>&1", nil
		}
		return "apt-mark unhold " + q + " 2>&1", nil
	case KindDnf, KindYum:
		bin := "dnf"
		if k == KindYum {
			bin = "yum"
		}
		if hold {
			return bin + " versionlock add " + q + " 2>&1", nil
		}
		return bin + " versionlock delete " + q + " 2>&1", nil
	}
	return "", ErrUnsupported
}

// searchScript builds the search command (installed + available).
func searchScript(k Kind, query string) (string, error) {
	if !validName(query) {
		return "", ErrBadName
	}
	q := shellQuote(query)
	switch k {
	case KindApt:
		return fmt.Sprintf("LC_ALL=C apt-cache search %s 2>/dev/null | head -60", q), nil
	case KindDnf:
		return fmt.Sprintf("LC_ALL=C dnf -q search %s 2>/dev/null | head -60", q), nil
	case KindYum:
		return fmt.Sprintf("LC_ALL=C yum -q search %s 2>/dev/null | head -60", q), nil
	case KindApk:
		return fmt.Sprintf("LC_ALL=C apk search -v %s 2>/dev/null | head -60", q), nil
	case KindZypper:
		return fmt.Sprintf("LC_ALL=C zypper -q search %s 2>/dev/null | head -60", q), nil
	}
	return "", ErrNoManager
}

// parseSearch parses search output into name + summary (best-effort by manager).
func parseSearch(k Kind, out string) []Pkg {
	res := []Pkg{}
	for _, line := range splitNonEmptyLines(out) {
		switch k {
		case KindApt:
			name, summary, ok := strings.Cut(line, " - ")
			if !ok {
				continue
			}
			res = append(res, Pkg{Name: strings.TrimSpace(name), Summary: strings.TrimSpace(summary)})
		case KindApk:
			f := strings.Fields(line)
			if len(f) == 0 {
				continue
			}
			res = append(res, Pkg{Name: trimApkName(f[0]), Summary: strings.Join(f[1:], " ")})
		default: // dnf/yum/zypper: "name.arch : summary" or "name.arch  ver  repo"
			if name, summary, ok := strings.Cut(line, ":"); ok {
				res = append(res, Pkg{Name: strings.TrimSpace(name), Summary: strings.TrimSpace(summary)})
				continue
			}
			f := strings.Fields(line)
			if len(f) >= 1 {
				res = append(res, Pkg{Name: f[0]})
			}
		}
		if len(res) >= 60 {
			break
		}
	}
	return res
}

func parseCount(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func splitNonEmptyLines(s string) []string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimRight(line, "\r")
		if strings.TrimSpace(t) == "" {
			continue
		}
		out = append(out, t)
	}
	return out
}
