package secaudit

import "strings"

const auditScript = `LC_ALL=C
echo '===SSHD==='
(sshd -T 2>/dev/null | grep -iE '^(permitrootlogin|passwordauthentication|permitemptypasswords)') || grep -hiE '^\s*(PermitRootLogin|PasswordAuthentication|PermitEmptyPasswords)' /etc/ssh/sshd_config 2>/dev/null
echo '===LISTEN==='
ss -tlnH 2>/dev/null | wc -l
echo '===SUID==='
find /usr/bin /usr/sbin /bin /sbin -perm -4000 -type f 2>/dev/null | head -50
echo '===WW==='
find /etc /usr/bin /usr/sbin -perm -0002 -type f 2>/dev/null | head -20
echo '===FAIL2BAN==='
(fail2ban-client status 2>/dev/null) || echo '__NOFAIL2BAN__'
echo '===LASTB==='
(sudo -n lastb 2>/dev/null || lastb 2>/dev/null) | grep -vcE '^$|^btmp'
echo '===EMPTYPW==='
(sudo -n awk -F: '($2==""){print $1}' /etc/shadow 2>/dev/null || awk -F: '($2==""){print $1}' /etc/shadow 2>/dev/null)
echo '===END==='
`

// kv extracts the value of a `key value` (sshd -T) or `Key value` (config) line.
func sshdVal(s, key string) (string, bool) {
	for _, line := range splitNonEmptyLines(s) {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) < 2 {
			continue
		}
		if strings.EqualFold(f[0], key) {
			return strings.ToLower(f[1]), true
		}
	}
	return "", false
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
