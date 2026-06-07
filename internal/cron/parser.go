package cron

import (
	"regexp"
	"strings"
)

const snapshotScript = `LC_ALL=C
command -v crontab >/dev/null 2>&1 && echo '__HASCRONTAB__'
echo '===USERCRON==='
crontab -l 2>/dev/null
echo '===SYSCRON==='
grep -hvE '^\s*#|^\s*$' /etc/crontab /etc/cron.d/* 2>/dev/null | head -100
echo '===TIMERS==='
systemctl list-timers --all --no-pager --no-legend 2>/dev/null
echo '===END==='
`

// timerNameRe / cron entry validation.
var timerNameRe = regexp.MustCompile(`^[a-zA-Z0-9@._:\\-]{1,256}\.timer$`)

// cronEntryRe forbids shell control/newline metacharacters in a crontab line.
// The command portion is otherwise free-form (it's the user's own crontab), but
// we still single-quote it before interpolating into `printf`.
var cronEntryBad = regexp.MustCompile("[\n\r\x00]")

func validTimer(s string) bool { return s != "" && timerNameRe.MatchString(s) }

func validEntry(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && !strings.HasPrefix(s, "#") && !cronEntryBad.MatchString(s) && len(s) <= 1024
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// parseUserCron splits each non-comment crontab line into schedule + command.
// `@reboot`-style shortcuts keep the whole first token as the schedule.
func parseUserCron(s string) []CronEntry {
	out := []CronEntry{}
	idx := 0
	for _, raw := range splitLines(s) {
		idx++
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		e := CronEntry{Index: idx, Raw: raw}
		fields := strings.Fields(line)
		if strings.HasPrefix(fields[0], "@") {
			e.Schedule = fields[0]
			e.Command = strings.TrimSpace(strings.TrimPrefix(line, fields[0]))
		} else if len(fields) >= 6 {
			e.Schedule = strings.Join(fields[:5], " ")
			e.Command = strings.Join(fields[5:], " ")
		} else {
			e.Command = line
		}
		out = append(out, e)
	}
	return out
}

// parseTimers reads `systemctl list-timers --all --no-legend`. Column layout is
// version-dependent; we extract the *.timer and the *.service activation by
// suffix and keep the remainder as schedule hints.
func parseTimers(s string) []Timer {
	out := []Timer{}
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		t := Timer{}
		for _, f := range fields {
			if strings.HasSuffix(f, ".timer") {
				t.Unit = f
			} else if strings.HasSuffix(f, ".service") {
				t.Activates = f
			}
		}
		if t.Unit == "" {
			continue
		}
		// Heuristic NEXT/LEFT: first two columns when present.
		if len(fields) >= 2 && !strings.HasSuffix(fields[0], ".timer") {
			t.Next = fields[0]
		}
		out = append(out, t)
	}
	return out
}

func splitLines(s string) []string {
	return strings.Split(strings.TrimRight(s, "\n"), "\n")
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
