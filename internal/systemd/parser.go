package systemd

import (
	"regexp"
	"strconv"
	"strings"
)

// unitNameRe matches the safe systemd unit-name charset. systemd itself allows
// alnum plus ':-_.\@'; we forbid everything else so a unit name can never carry
// shell metacharacters into the command we build.
var unitNameRe = regexp.MustCompile(`^[a-zA-Z0-9@._:\\-]{1,256}$`)

// validUnitName guards every place a caller-supplied unit name reaches the
// shell. Must match the systemd charset and contain a '.' type suffix (so a
// bare word can't be smuggled in), and not start with '-' (would parse as a
// flag).
func validUnitName(name string) bool {
	if name == "" || strings.HasPrefix(name, "-") {
		return false
	}
	if !strings.Contains(name, ".") {
		return false
	}
	return unitNameRe.MatchString(name)
}

// shellQuote wraps s in single quotes for safe interpolation. validUnitName
// already forbids quotes; this is belt-and-suspenders.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// parseListUnits reads `systemctl list-units --type=service --all --no-legend
// --no-pager --plain`:
//
//	nginx.service   loaded active   running A high performance web server
//	foo.service     loaded failed   failed  Foo daemon
func parseListUnits(out string) []Unit {
	units := []Unit{}
	for _, line := range splitNonEmptyLines(out) {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		// Strip a stray leading status glyph if --plain wasn't honoured.
		if fields[0] == "●" || fields[0] == "*" {
			fields = fields[1:]
			if len(fields) < 4 {
				continue
			}
		}
		u := Unit{
			Name:   fields[0],
			Load:   fields[1],
			Active: fields[2],
			Sub:    fields[3],
		}
		if len(fields) > 4 {
			u.Description = strings.Join(fields[4:], " ")
		}
		units = append(units, u)
	}
	return units
}

// parseUnitFiles reads `systemctl list-unit-files --type=service --no-legend
// --no-pager` into name → enablement-state ("enabled" / "disabled" / "static"
// / "masked" / "generated" ...).
//
//	nginx.service   enabled  enabled
//	foo.service     disabled disabled
func parseUnitFiles(out string) map[string]string {
	m := map[string]string{}
	for _, line := range splitNonEmptyLines(out) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		m[fields[0]] = fields[1]
	}
	return m
}

// parseShow reads `systemctl show <unit> --no-pager` key=value lines.
func parseShow(out string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		k, v, ok := strings.Cut(line, "=")
		if !ok || k == "" {
			continue
		}
		m[k] = v
	}
	return m
}

// showKeys is the curated subset surfaced to the UI from `systemctl show`.
var showKeys = []string{
	"Id", "Description", "LoadState", "ActiveState", "SubState",
	"UnitFileState", "MainPID", "ExecMainStatus", "FragmentPath",
	"ActiveEnterTimestamp", "Restart", "Documentation",
}

// detailFromShow projects raw `systemctl show` output onto the Detail shape.
func detailFromShow(raw map[string]string) Detail {
	d := Detail{Properties: map[string]string{}}
	for _, k := range showKeys {
		if v, ok := raw[k]; ok && v != "" {
			d.Properties[k] = v
		}
	}
	d.Unit = Unit{
		Name:        raw["Id"],
		Description: raw["Description"],
		Load:        raw["LoadState"],
		Active:      raw["ActiveState"],
		Sub:         raw["SubState"],
		Enabled:     raw["UnitFileState"],
	}
	d.MainPID = parseIntSafe(raw["MainPID"])
	d.MemoryBytes = parseCounter(raw["MemoryCurrent"])
	d.TasksCurrent = parseCounter(raw["TasksCurrent"])
	d.ActiveSince = raw["ActiveEnterTimestamp"]
	return d
}

// parseVersion extracts the major version number from `systemctl --version`,
// whose first line is e.g. "systemd 249 (249.11-0ubuntu3.12)".
func parseVersion(out string) string {
	for _, line := range splitNonEmptyLines(out) {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "systemd" {
			return fields[1]
		}
	}
	return ""
}

func parseIntSafe(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}

// parseCounter reads a systemd numeric property. systemd reports "unset" as the
// u64 max sentinel or "[not set]"; both map to 0.
func parseCounter(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "[") {
		return 0
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	// 18446744073709551615 (u64 max) overflows int64 to a parse error above, so
	// the sentinel already lands on 0 — nothing more to do.
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
