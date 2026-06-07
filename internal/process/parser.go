package process

import (
	"sort"
	"strconv"
	"strings"
)

// listScript collects the process table. Columns are fixed-order; args is last
// and may contain spaces, so it's reconstructed by column position.
const listScript = `LC_ALL=C
ps -eo pid,ppid,user,pcpu,pmem,rss,vsz,nlwp,ni,stat,etimes,comm,args --no-headers --sort=-pcpu 2>/dev/null | head -500
`

// validPID guards every place a caller PID reaches the shell.
func validPID(pid int) bool { return pid > 0 && pid < 1<<31 }

// parsePsList parses the 13-column ps output. The first 12 columns are
// whitespace-delimited; everything after is the args string (original spacing).
func parsePsList(out string) []Process {
	procs := []Process{}
	for _, line := range splitNonEmptyLines(out) {
		fields := strings.Fields(line)
		if len(fields) < 12 {
			continue
		}
		p := Process{
			PID:        atoi(fields[0]),
			PPID:       atoi(fields[1]),
			User:       fields[2],
			CPUPct:     atof(fields[3]),
			MemPct:     atof(fields[4]),
			RSSKb:      atoi64(fields[5]),
			VSZKb:      atoi64(fields[6]),
			Threads:    atoi(fields[7]),
			Nice:       atoi(fields[8]),
			State:      fields[9],
			ElapsedSec: atoi64(fields[10]),
			Comm:       fields[11],
		}
		p.Args = reconstructArgs(line, 12)
		if p.Args == "" {
			p.Args = p.Comm
		}
		procs = append(procs, p)
	}
	return procs
}

// reconstructArgs returns the substring after the first `cols` whitespace-
// delimited columns, preserving the original spacing of the args field.
func reconstructArgs(line string, cols int) string {
	idx := 0
	for i := 0; i < cols; i++ {
		for idx < len(line) && (line[idx] == ' ' || line[idx] == '\t') {
			idx++
		}
		for idx < len(line) && line[idx] != ' ' && line[idx] != '\t' {
			idx++
		}
	}
	for idx < len(line) && (line[idx] == ' ' || line[idx] == '\t') {
		idx++
	}
	if idx < len(line) {
		return line[idx:]
	}
	return ""
}

func sortProcs(procs []Process, by string) {
	switch by {
	case "mem":
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].MemPct > procs[j].MemPct })
	case "rss":
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].RSSKb > procs[j].RSSKb })
	case "pid":
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].PID < procs[j].PID })
	default:
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].CPUPct > procs[j].CPUPct })
	}
}

// statusKeys are the curated /proc/<pid>/status fields surfaced in Detail.
var statusKeys = map[string]bool{
	"Name": true, "State": true, "Tgid": true, "Pid": true, "PPid": true,
	"Uid": true, "Gid": true, "Threads": true, "VmRSS": true, "VmSize": true,
	"VmPeak": true, "VmHWM": true, "voluntary_ctxt_switches": true,
	"nonvoluntary_ctxt_switches": true, "FDSize": true,
}

func parseStatus(out string) map[string]string {
	m := map[string]string{}
	for _, line := range splitNonEmptyLines(out) {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if statusKeys[k] {
			m[k] = strings.TrimSpace(v)
		}
	}
	return m
}

// parseIO parses /proc/<pid>/io into read_bytes / write_bytes.
func parseIO(out string) (read, write int64) {
	for _, line := range splitNonEmptyLines(out) {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "read_bytes":
			read = atoi64(strings.TrimSpace(v))
		case "write_bytes":
			write = atoi64(strings.TrimSpace(v))
		}
	}
	return
}

func atoi(s string) int        { n, _ := strconv.Atoi(strings.TrimSpace(s)); return n }
func atoi64(s string) int64    { n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64); return n }
func atof(s string) float64    { f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return f }

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
