package kernel

import (
	"regexp"
	"strconv"
	"strings"
)

const snapshotScript = `LC_ALL=C
echo '===HOST==='
uname -n; uname -sr
cat /etc/timezone 2>/dev/null || (timedatectl show -p Timezone --value 2>/dev/null)
echo '===SYSCTL==='
sysctl -a 2>/dev/null
echo '===LSMOD==='
lsmod 2>/dev/null
echo '===LIMITS==='
sh -c 'ulimit -a' 2>/dev/null
echo '===END==='
`

// sysctlKeyRe matches the safe sysctl key charset (a.b.c / net.ipv4.tcp_*).
var sysctlKeyRe = regexp.MustCompile(`^[a-zA-Z0-9._/-]{1,256}$`)

// sysctlValRe matches a safe scalar value (numbers, words, whitespace-separated
// tuples). Forbids shell metacharacters.
var sysctlValRe = regexp.MustCompile(`^[a-zA-Z0-9._:%/ \t-]{1,256}$`)

func validKey(k string) bool   { return k != "" && sysctlKeyRe.MatchString(k) }
func validValue(v string) bool { return v != "" && sysctlValRe.MatchString(v) }

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func parseHost(s string) (hostname, kernel, tz string) {
	lines := splitNonEmptyLines(s)
	if len(lines) > 0 {
		hostname = strings.TrimSpace(lines[0])
	}
	if len(lines) > 1 {
		kernel = strings.TrimSpace(lines[1])
	}
	if len(lines) > 2 {
		tz = strings.TrimSpace(lines[2])
	}
	return
}

func parseSysctl(s string) []Sysctl {
	out := []Sysctl{}
	for _, line := range splitNonEmptyLines(s) {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out = append(out, Sysctl{Key: strings.TrimSpace(k), Value: strings.TrimSpace(v)})
	}
	return out
}

// parseLsmod reads `lsmod`: Module Size Used_by_count Used_by_list (skips the
// header row).
func parseLsmod(s string) []Module {
	out := []Module{}
	for i, line := range splitNonEmptyLines(s) {
		if i == 0 && strings.HasPrefix(line, "Module") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		size, _ := strconv.ParseInt(fields[1], 10, 64)
		mod := Module{Name: fields[0], SizeKb: size / 1024}
		if len(fields) >= 4 {
			mod.UsedBy = fields[3]
		}
		out = append(out, mod)
	}
	return out
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
