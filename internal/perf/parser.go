package perf

import (
	"strconv"
	"strings"
)

// snapshotScript samples PSI, a 1-second vmstat, iostat (if present), and the
// kernel ring tail in one round-trip. vmstat/iostat use `1 2` so the second
// sample is a true per-second rate rather than a since-boot counter.
const snapshotScript = `LC_ALL=C
echo '===LOAD==='
cat /proc/loadavg 2>/dev/null
echo '===UPTIME==='
cat /proc/uptime 2>/dev/null
echo '===PSI_CPU==='
cat /proc/pressure/cpu 2>/dev/null
echo '===PSI_IO==='
cat /proc/pressure/io 2>/dev/null
echo '===PSI_MEM==='
cat /proc/pressure/memory 2>/dev/null
echo '===VMSTAT==='
vmstat 1 2 2>/dev/null | tail -1
echo '===IOSTAT==='
iostat -dx 1 2 2>/dev/null
echo '===DMESG==='
(dmesg -T 2>/dev/null || dmesg 2>/dev/null) | tail -60
echo '===END==='
`

func parseLoad(s string) [3]float64 {
	var out [3]float64
	f := strings.Fields(strings.TrimSpace(s))
	for i := 0; i < 3 && i < len(f); i++ {
		out[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return out
}

func parseUptime(s string) int64 {
	f := strings.Fields(strings.TrimSpace(s))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

// parsePSI reads one /proc/pressure/* file. Returns some/full metrics; full is
// zero for the cpu file (which has no "full" line on most kernels).
func parsePSI(s string) (some, full PressureMetric, ok bool) {
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		m := PressureMetric{}
		for _, f := range fields[1:] {
			k, v, has := strings.Cut(f, "=")
			if !has {
				continue
			}
			val, _ := strconv.ParseFloat(v, 64)
			switch k {
			case "avg10":
				m.Avg10 = val
			case "avg60":
				m.Avg60 = val
			case "avg300":
				m.Avg300 = val
			}
		}
		ok = true
		switch fields[0] {
		case "some":
			some = m
		case "full":
			full = m
		}
	}
	return
}

// parseVMStat reads the second (steady) `vmstat 1 2` row:
// r b swpd free buff cache si so bi bo in cs us sy id wa st
func parseVMStat(s string) VMStat {
	line := strings.TrimSpace(firstNonEmptyFromBottom(s))
	fields := strings.Fields(line)
	if len(fields) < 17 {
		return VMStat{Available: false}
	}
	at := func(i int) int { v, _ := strconv.Atoi(fields[i]); return v }
	at64 := func(i int) int64 { v, _ := strconv.ParseInt(fields[i], 10, 64); return v }
	return VMStat{
		Available:       true,
		ProcsR:          at(0),
		ProcsB:          at(1),
		SwapInKBs:       at64(6),
		SwapOutKBs:      at64(7),
		BlockInKBs:      at64(8),
		BlockOutKBs:     at64(9),
		Interrupts:      at64(10),
		ContextSwitches: at64(11),
		CPUUser:         at(12),
		CPUSystem:       at(13),
		CPUIdle:         at(14),
		CPUIOWait:       at(15),
		CPUSteal:        at(16),
	}
}

// parseIOStat reads `iostat -dx 1 2`, returning the LAST report's device rows.
// It's header-driven so it tolerates sysstat column-layout differences across
// versions (kB_read/s vs rkB/s, r_await/w_await vs await).
func parseIOStat(s string) []PerfDisk {
	lines := splitNonEmptyLines(s)
	// Find the last "Device" header line.
	headerIdx := -1
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "Device") {
			headerIdx = i
		}
	}
	if headerIdx < 0 || headerIdx+1 >= len(lines) {
		return nil
	}
	cols := strings.Fields(lines[headerIdx])
	idx := map[string]int{}
	for i, c := range cols {
		idx[strings.ToLower(c)] = i
	}
	get := func(fields []string, names ...string) float64 {
		for _, n := range names {
			if i, ok := idx[n]; ok && i < len(fields) {
				v, _ := strconv.ParseFloat(fields[i], 64)
				return v
			}
		}
		return 0
	}
	out := []PerfDisk{}
	for _, l := range lines[headerIdx+1:] {
		if strings.HasPrefix(strings.TrimSpace(l), "Device") {
			break // next report block — shouldn't happen since we took the last
		}
		fields := strings.Fields(l)
		if len(fields) < 4 || fields[0] == "" {
			continue
		}
		d := PerfDisk{
			Device:   fields[0],
			TPS:      get(fields, "tps"),
			ReadKBs:  get(fields, "rkb/s", "kb_read/s"),
			WriteKBs: get(fields, "wkb/s", "kb_wrtn/s"),
			AwaitMs:  get(fields, "await", "r_await"),
			UtilPct:  get(fields, "%util"),
		}
		out = append(out, d)
	}
	return out
}

// classifyDmesg splits the kernel ring tail into the recent lines and the OOM
// subset (lines mentioning OOM / killed process / out of memory).
func classifyDmesg(s string) (tail, oom []string) {
	for _, line := range splitNonEmptyLines(s) {
		tail = append(tail, line)
		low := strings.ToLower(line)
		if strings.Contains(low, "out of memory") || strings.Contains(low, "killed process") ||
			strings.Contains(low, "oom-kill") || strings.Contains(low, "oom_reaper") {
			oom = append(oom, line)
		}
	}
	return
}

func firstNonEmptyFromBottom(s string) string {
	lines := splitNonEmptyLines(s)
	if len(lines) == 0 {
		return ""
	}
	return lines[len(lines)-1]
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
