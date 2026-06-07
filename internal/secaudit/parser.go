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
echo '===UID0==='
awk -F: '($3==0){print $1}' /etc/passwd 2>/dev/null
echo '===SELINUX==='
getenforce 2>/dev/null
aa-status --enabled 2>/dev/null && echo '__APPARMOR_ENFORCING__'
echo '===HARDEN==='
printf 'randomize_va_space=%s\n' "$(sysctl -n kernel.randomize_va_space 2>/dev/null)"
printf 'tcp_syncookies=%s\n' "$(sysctl -n net.ipv4.tcp_syncookies 2>/dev/null)"
printf 'rp_filter=%s\n' "$(sysctl -n net.ipv4.conf.all.rp_filter 2>/dev/null)"
echo '===REBOOT==='
[ -f /var/run/reboot-required ] && echo '__REBOOT_REQUIRED__'
(needs-restarting -r >/dev/null 2>&1; echo "needsrestart_rc=$?")
echo '===AUTHKEYS==='
find /root /home -maxdepth 3 -name authorized_keys 2>/dev/null | head -20
echo '===PASSPOLICY==='
grep -E '^PASS_MAX_DAYS' /etc/login.defs 2>/dev/null
echo '===UNATTENDED==='
(dpkg-query -W -f '${Status}' unattended-upgrades 2>/dev/null | grep -q 'install ok installed' && echo '__UNATTENDED_ON__')
(systemctl is-enabled dnf-automatic.timer 2>/dev/null | grep -q enabled && echo '__DNF_AUTO_ON__')
echo '===ROOTCRON==='
(crontab -l -u root 2>/dev/null || cat /var/spool/cron/crontabs/root 2>/dev/null || cat /var/spool/cron/root 2>/dev/null) | grep -vE '^\s*#|^\s*$' | head -20
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
