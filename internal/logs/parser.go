package logs

import (
	"regexp"
	"strconv"
	"strings"
)

// unitRe / pathRe guard caller-supplied refs before they reach the shell.
var (
	unitRe = regexp.MustCompile(`^[a-zA-Z0-9@._:\\-]{1,256}$`)
	pathRe = regexp.MustCompile(`^/[A-Za-z0-9._/\-]{1,512}$`)
)

func validUnit(s string) bool {
	return s != "" && !strings.HasPrefix(s, "-") && unitRe.MatchString(s)
}

// validPath accepts an absolute path with a safe charset and no traversal.
func validPath(s string) bool {
	if !pathRe.MatchString(s) || strings.Contains(s, "..") {
		return false
	}
	return true
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// fileListScript enumerates common readable log files with size (KiB) + mtime.
const fileListScript = `LC_ALL=C
command -v journalctl >/dev/null 2>&1 && echo '__HASJOURNAL__'
echo '===FILES==='
for f in /var/log/syslog /var/log/messages /var/log/auth.log /var/log/secure /var/log/kern.log /var/log/dmesg /var/log/boot.log /var/log/cron /var/log/maillog /var/log/nginx/access.log /var/log/nginx/error.log /var/log/httpd/access_log /var/log/httpd/error_log /var/log/mysql/error.log /var/log/audit/audit.log; do
  [ -r "$f" ] && stat -c '%n|%s|%y' "$f" 2>/dev/null
done
echo '===END==='
`

// parseFileList reads the stat lines `path|sizebytes|mtime`.
func parseFileList(out string) (hasJournal bool, files []LogFile) {
	for _, line := range splitNonEmptyLines(out) {
		if strings.TrimSpace(line) == "__HASJOURNAL__" {
			hasJournal = true
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) < 2 {
			continue
		}
		size, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		f := LogFile{Path: parts[0], SizeKb: size / 1024}
		if len(parts) == 3 {
			f.Modified = strings.TrimSpace(parts[2])
		}
		files = append(files, f)
	}
	return
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
