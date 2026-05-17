package tools

import "testing"

func TestCommandAllowedReason(t *testing.T) {
	allow := DefaultReadonlyAllow
	cases := []struct {
		name      string
		cmd       string
		wantAllow bool
		// substring expected in rejection reason (when wantAllow=false)
		wantReason string
	}{
		{"plain ss", "ss -lnt", true, ""},
		{"plain ss -tunlp", "ss -tunlp", true, ""},
		{"ip addr", "ip addr", true, ""},
		{"ip a", "ip a", true, ""},
		{"netstat lntp", "netstat -lntp", true, ""},
		{"top batch", "top -bn1", true, ""},
		{"top interactive rejected", "top", false, "not in readonly allow-list"},
		{"ls pipe grep", "ls -la /var/log | grep nginx", true, ""},
		{"pipe to xargs rm rejected", "ls /tmp | xargs rm", false, "not in readonly allow-list"},
		{"command substitution rejected", "cat $(uname -r)", false, "dangerous shell metachar"},
		{"backtick rejected", "echo `whoami`", false, "dangerous shell metachar"},
		{"redirect out rejected", "ls > /tmp/x", false, "dangerous shell metachar"},
		{"redirect in rejected", "wc -l < /tmp/x", false, "dangerous shell metachar"},
		{"semicolon rejected", "ls; pwd", false, "dangerous shell metachar"},
		{"bare ampersand rejected", "ls /tmp &", false, "backgrounding"},
		{"&& conjunction ok", "uptime && free -m", true, ""},
		{"chained pipes ok", "cat /var/log/syslog | grep err | tail -50", true, ""},
		{"systemctl status ok", "systemctl status nginx", true, ""},
		{"systemctl restart rejected", "systemctl restart nginx", false, "not in readonly allow-list"},
		{"kubectl get ok", "kubectl get pods -n default", true, ""},
		{"kubectl apply rejected", "kubectl apply -f x.yaml", false, "not in readonly allow-list"},
		{"docker ps ok", "docker ps -a", true, ""},
		{"docker run rejected", "docker run nginx", false, "not in readonly allow-list"},
		{"curl head ok", "curl -I https://example.com", true, ""},
		{"curl post rejected", "curl -X POST https://example.com", false, "not in readonly allow-list"},
		{"git status ok", "git status", true, ""},
		{"git push rejected", "git push origin main", false, "not in readonly allow-list"},
		{"awk ok", "awk '{print $1}' /etc/hosts", true, ""},
		{"sed ok", "sed -n '1,10p' /etc/hosts", true, ""},
		{"empty rejected", "   ", false, "empty"},
		// Regression cases reported by the user:
		{"docker system df", "docker system df", true, ""},
		{"docker system info", "docker system info", true, ""},
		{"docker system events --since 10m", "docker system events --since 10m", true, ""},
		{"sort -h chained", "du -sh /var/log/* | sort -h | tail -20", true, ""},
		{"find printf newline", `find /var/log -type f -printf '%TY-%Tm-%Td %s %p\n'`, true, ""},
		{"journalctl --disk-usage", "journalctl --disk-usage", true, ""},
	}

	// Sanity: extra knob appends.
	extra := normaliseAllow(nil, []string{"my-internal-cli"})
	if reason := commandAllowedReason("my-internal-cli --help", extra); reason != "" {
		t.Errorf("extra append should allow my-internal-cli; got reason=%q", reason)
	}
	// Sanity: explicit list still replaces default; extra appends on top.
	merged := normaliseAllow([]string{"ls"}, []string{"my-cli"})
	if reason := commandAllowedReason("ls", merged); reason != "" {
		t.Errorf("ls should be allowed by explicit list; got %q", reason)
	}
	if reason := commandAllowedReason("cat /tmp", merged); reason == "" {
		t.Errorf("cat should NOT be in replacement-mode allow; got allowed")
	}
	if reason := commandAllowedReason("my-cli --x", merged); reason != "" {
		t.Errorf("my-cli should be allowed via extra; got %q", reason)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := commandAllowedReason(tc.cmd, allow)
			gotAllow := reason == ""
			if gotAllow != tc.wantAllow {
				t.Errorf("commandAllowedReason(%q) allow=%v reason=%q; want allow=%v",
					tc.cmd, gotAllow, reason, tc.wantAllow)
				return
			}
			if !tc.wantAllow && tc.wantReason != "" {
				if !contains(reason, tc.wantReason) {
					t.Errorf("commandAllowedReason(%q) reason=%q; want contains %q",
						tc.cmd, reason, tc.wantReason)
				}
			}
		})
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	n := len(s) - len(sub)
	for i := 0; i <= n; i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
