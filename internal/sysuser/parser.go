package sysuser

import (
	"regexp"
	"strconv"
	"strings"
)

const snapshotScript = `LC_ALL=C
echo '===PASSWD==='
getent passwd 2>/dev/null
echo '===GROUP==='
getent group 2>/dev/null
echo '===WHO==='
who 2>/dev/null
echo '===LAST==='
last -n 25 -w 2>/dev/null | grep -vE '^$|^wtmp' | head -25
echo '===LASTB==='
(sudo -n lastb -n 15 -w 2>/dev/null || lastb -n 15 -w 2>/dev/null) | grep -vE '^$|^btmp' | head -15
echo '===SUDOERS==='
ls /etc/sudoers.d/ 2>/dev/null
echo '===END==='
`

var nameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,32}$`)

func validName(s string) bool { return s != "" && nameRe.MatchString(s) }

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// parsePasswd reads getent passwd: name:x:uid:gid:gecos:home:shell.
func parsePasswd(s string) []User {
	out := []User{}
	for _, line := range splitNonEmptyLines(s) {
		f := strings.Split(line, ":")
		if len(f) < 7 {
			continue
		}
		uid, _ := strconv.Atoi(f[2])
		gid, _ := strconv.Atoi(f[3])
		out = append(out, User{
			Name: f[0], UID: uid, GID: gid, Gecos: f[4], Home: f[5], Shell: f[6],
			System: uid < 1000,
		})
	}
	return out
}

// parseGroup reads getent group: name:x:gid:members(csv).
func parseGroup(s string) []Group {
	out := []Group{}
	for _, line := range splitNonEmptyLines(s) {
		f := strings.Split(line, ":")
		if len(f) < 3 {
			continue
		}
		gid, _ := strconv.Atoi(f[2])
		g := Group{Name: f[0], GID: gid}
		if len(f) >= 4 && strings.TrimSpace(f[3]) != "" {
			for _, mem := range strings.Split(f[3], ",") {
				if m := strings.TrimSpace(mem); m != "" {
					g.Members = append(g.Members, m)
				}
			}
		}
		out = append(out, g)
	}
	return out
}

func parseWho(s string) []LoginSession {
	out := []LoginSession{}
	for _, line := range splitNonEmptyLines(s) {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		u := LoginSession{User: f[0], TTY: f[1]}
		if len(f) >= 4 && strings.Contains(f[2], "-") {
			u.Login = f[2] + " " + f[3]
		}
		if last := f[len(f)-1]; strings.HasPrefix(last, "(") && strings.HasSuffix(last, ")") {
			u.From = strings.TrimSuffix(strings.TrimPrefix(last, "("), ")")
		}
		out = append(out, u)
	}
	return out
}

// parseLast reads `last`/`lastb` rows. failed marks lastb rows.
func parseLast(s string, failed bool) []LoginHistory {
	out := []LoginHistory{}
	for _, line := range splitNonEmptyLines(s) {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		h := LoginHistory{User: f[0], Failed: failed}
		// last format: user tty from  Wed Jun 8 09:00 ... — `from` is field 2 if it
		// looks like an IP/host (contains . or :), else the date starts.
		if strings.ContainsAny(f[2], ".:") && !strings.Contains(f[2], ":0") {
			h.From = f[2]
			if len(f) >= 7 {
				h.When = strings.Join(f[3:7], " ")
			}
		} else {
			h.When = strings.Join(f[2:min(len(f), 6)], " ")
		}
		out = append(out, h)
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
