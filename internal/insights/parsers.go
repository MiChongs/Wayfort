package insights

import (
	"bufio"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// parseUname expects `uname -s -r -m` style output on one line (single host)
// followed by `uname -n` on another line. Tolerant: takes whatever's there.
func parseUname(s string) (os, kernel, arch, hostname string) {
	lines := splitNonEmptyLines(s)
	if len(lines) > 0 {
		fields := strings.Fields(lines[0])
		// `uname -srvmpio` prints: <kernel> <release> ... <machine> ...
		// We use uname -s -r -m which yields exactly 3 fields.
		if len(fields) >= 3 {
			os = fields[0]
			kernel = fields[1]
			arch = fields[2]
		} else if len(fields) > 0 {
			os = fields[0]
		}
	}
	if len(lines) > 1 {
		hostname = strings.TrimSpace(lines[1])
	}
	return
}

// parseOSRelease pulls PRETTY_NAME out of /etc/os-release output. Returns ""
// if absent.
func parseOSRelease(s string) string {
	for _, line := range splitNonEmptyLines(s) {
		if !strings.HasPrefix(line, "PRETTY_NAME=") {
			continue
		}
		v := strings.TrimPrefix(line, "PRETTY_NAME=")
		v = strings.Trim(v, `"' `)
		return v
	}
	return ""
}

// parseUptime returns the integer seconds from `/proc/uptime` (which prints
// "<uptime_sec.fraction> <idle_sec.fraction>").
func parseUptime(s string) int64 {
	f := strings.Fields(strings.TrimSpace(s))
	if len(f) == 0 {
		return 0
	}
	n, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0
	}
	return int64(n)
}

// parseLoadavg returns the load-average triple. `/proc/loadavg` prints e.g.
// "0.21 0.14 0.13 1/220 12345".
func parseLoadavg(s string) [3]float64 {
	var out [3]float64
	f := strings.Fields(strings.TrimSpace(s))
	for i := 0; i < 3 && i < len(f); i++ {
		v, _ := strconv.ParseFloat(f[i], 64)
		out[i] = v
	}
	return out
}

// parseCPUInfo combines `nproc` (first line) and `grep model name` (second
// line, optional).
func parseCPUInfo(s string) (cores int, model string) {
	lines := splitNonEmptyLines(s)
	if len(lines) > 0 {
		cores, _ = strconv.Atoi(strings.TrimSpace(lines[0]))
	}
	if len(lines) > 1 {
		model = strings.TrimSpace(lines[1])
	}
	return
}

// parseProcStatCPU reads the aggregate "cpu  user nice system idle iowait
// irq softirq steal guest guest_nice" line. Returns idle+iowait and total
// for usage-delta computation.
func parseProcStatCPU(s string) (procStat, bool) {
	for _, line := range splitNonEmptyLines(s) {
		if !strings.HasPrefix(line, "cpu ") && !strings.HasPrefix(line, "cpu\t") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return procStat{}, false
		}
		var nums []uint64
		for _, f := range fields[1:] {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				continue
			}
			nums = append(nums, v)
		}
		if len(nums) < 4 {
			return procStat{}, false
		}
		var idle, total uint64
		idle = nums[3] // idle
		if len(nums) >= 5 {
			idle += nums[4] // + iowait
		}
		for _, n := range nums {
			total += n
		}
		return procStat{Idle: idle, Total: total}, true
	}
	return procStat{}, false
}

// cpuUsagePctFromDelta computes 0..100 from two consecutive procStat samples.
// Returns -1 when no useful delta is available (insufficient samples or
// counter reset).
func cpuUsagePctFromDelta(prev, cur procStat) float64 {
	if prev.Total == 0 || cur.Total <= prev.Total {
		return -1
	}
	idleDelta := float64(cur.Idle - prev.Idle)
	totalDelta := float64(cur.Total - prev.Total)
	if totalDelta <= 0 {
		return -1
	}
	pct := (1.0 - idleDelta/totalDelta) * 100.0
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct
}

// parseMeminfo decodes /proc/meminfo. Values are kB.
func parseMeminfo(s string) MemoryInfo {
	get := func(line string) (string, int64) {
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			return "", 0
		}
		key := strings.TrimSpace(line[:colon])
		rest := strings.TrimSpace(line[colon+1:])
		// "12345 kB" — strip trailing unit.
		if i := strings.IndexByte(rest, ' '); i > 0 {
			rest = rest[:i]
		}
		v, _ := strconv.ParseInt(rest, 10, 64)
		return key, v
	}
	var m MemoryInfo
	for _, line := range splitNonEmptyLines(s) {
		k, v := get(line)
		switch k {
		case "MemTotal":
			m.TotalKb = v
		case "MemFree":
			m.FreeKb = v
		case "MemAvailable":
			m.AvailableKb = v
		case "Buffers":
			m.BuffCacheKb += v
		case "Cached":
			m.BuffCacheKb += v
		case "SReclaimable":
			m.BuffCacheKb += v
		case "SwapTotal":
			m.SwapTotalKb = v
		case "SwapFree":
			// Used = Total - Free.
			m.SwapUsedKb = -v // sentinel; finalised below
		}
	}
	if m.SwapTotalKb > 0 {
		m.SwapUsedKb = m.SwapTotalKb + m.SwapUsedKb // (- (-free))
	} else {
		m.SwapUsedKb = 0
	}
	// Linux conventional definition of "used".
	if m.AvailableKb > 0 {
		m.UsedKb = m.TotalKb - m.AvailableKb
	} else {
		m.UsedKb = m.TotalKb - m.FreeKb - m.BuffCacheKb
		if m.UsedKb < 0 {
			m.UsedKb = 0
		}
	}
	return m
}

// parseDF reads `df -P -k` output:
//
//	Filesystem  1024-blocks  Used  Available  Capacity  Mounted on
//	/dev/sda1     20480000 12000000  8000000      60%   /
func parseDF(s string) []DiskUsage {
	out := []DiskUsage{}
	first := true
	for _, line := range splitNonEmptyLines(s) {
		if first {
			first = false
			continue // header
		}
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		total, _ := strconv.ParseInt(fields[1], 10, 64)
		used, _ := strconv.ParseInt(fields[2], 10, 64)
		avail, _ := strconv.ParseInt(fields[3], 10, 64)
		cap := strings.TrimSuffix(fields[4], "%")
		pct, _ := strconv.Atoi(cap)
		out = append(out, DiskUsage{
			Source:  fields[0],
			Mount:   strings.Join(fields[5:], " "),
			TotalKb: total, UsedKb: used, AvailKb: avail, UsedPct: pct,
		})
	}
	return out
}

// parseIPJSON tries to decode `ip -j addr show`. Returns ok=false on any
// parse error so the caller can fall back to text parsing.
func parseIPJSON(s string) (ifaces []NetIface, ok bool) {
	type addr struct {
		Family string `json:"family"`
		Local  string `json:"local"`
	}
	type entry struct {
		IfName    string `json:"ifname"`
		Address   string `json:"address"`
		Operstate string `json:"operstate"`
		AddrInfo  []addr `json:"addr_info"`
	}
	var list []entry
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &list); err != nil {
		return nil, false
	}
	out := make([]NetIface, 0, len(list))
	for _, e := range list {
		ni := NetIface{Name: e.IfName, MAC: e.Address, OperState: strings.ToUpper(e.Operstate)}
		if ni.OperState == "" {
			ni.OperState = "UNKNOWN"
		}
		for _, a := range e.AddrInfo {
			if a.Family == "inet" && ni.IPv4 == "" {
				ni.IPv4 = a.Local
			}
			if a.Family == "inet6" && ni.IPv6 == "" {
				ni.IPv6 = a.Local
			}
		}
		out = append(out, ni)
	}
	return out, true
}

// parseNetDev reads /proc/net/dev counters: per-interface RX/TX bytes.
func parseNetDev(s string) map[string][2]int64 {
	out := map[string][2]int64{}
	for _, line := range splitNonEmptyLines(s) {
		if !strings.Contains(line, ":") {
			continue
		}
		i := strings.IndexByte(line, ':')
		name := strings.TrimSpace(line[:i])
		fields := strings.Fields(line[i+1:])
		// 0:rx_bytes 1:rx_packets ... 8:tx_bytes
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseInt(fields[0], 10, 64)
		tx, _ := strconv.ParseInt(fields[8], 10, 64)
		out[name] = [2]int64{rx, tx}
	}
	return out
}

// parsePsOutput reads `ps -eo pid,ppid,user,pcpu,pmem,rss,stat,comm,args
// --no-headers --sort=-pcpu`. The `args` column may contain spaces; we treat
// everything after the 8th field as args.
func parsePsOutput(s string) []Process {
	out := []Process{}
	r := bufio.NewScanner(strings.NewReader(s))
	r.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for r.Scan() {
		line := strings.TrimRight(r.Text(), " ")
		if line == "" {
			continue
		}
		// Manual split: respect leading whitespace then bunch tokens 1..8.
		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}
		pid, _ := strconv.Atoi(fields[0])
		ppid, _ := strconv.Atoi(fields[1])
		user := fields[2]
		cpu, _ := strconv.ParseFloat(fields[3], 64)
		mem, _ := strconv.ParseFloat(fields[4], 64)
		rss, _ := strconv.ParseInt(fields[5], 10, 64)
		state := fields[6]
		comm := fields[7]
		args := ""
		// Reconstruct the args column using the column position of the 9th
		// field. ps prints args with original spacing; splitting on
		// arbitrary whitespace loses it, so re-find by stepping past the
		// first 8 columns.
		idx := 0
		for i := 0; i < 8; i++ {
			// skip leading whitespace
			for idx < len(line) && (line[idx] == ' ' || line[idx] == '\t') {
				idx++
			}
			// skip the field
			for idx < len(line) && line[idx] != ' ' && line[idx] != '\t' {
				idx++
			}
		}
		for idx < len(line) && (line[idx] == ' ' || line[idx] == '\t') {
			idx++
		}
		if idx < len(line) {
			args = line[idx:]
		}
		out = append(out, Process{
			PID: pid, PPID: ppid, User: user,
			CPUPct: cpu, MemPct: mem, RSSKb: rss,
			State: state, Comm: comm, Args: args,
		})
	}
	return out
}

// parseSsListen reads `ss -Hntulp` lines like:
//
//	tcp   LISTEN 0  511    0.0.0.0:80   0.0.0.0:*  users:(("nginx",pid=123,fd=6))
//
// IPv6 listeners look like `[::]:80`. UDP rows have State=UNCONN.
func parseSsListen(s string) []NetListen {
	out := []NetListen{}
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		proto := fields[0]
		local := fields[4]
		port, addr := splitAddrPort(local)
		// Some `ss` builds put State as col 1, others omit -H. Be tolerant.
		listen := NetListen{Proto: proto, LocalAddr: addr, LocalPort: port}
		// Detect process info — last field, format users:(("nginx",pid=123,...))
		for _, f := range fields {
			if strings.HasPrefix(f, "users:") {
				listen.Process, listen.PID = parseSsUsers(f)
			}
		}
		out = append(out, listen)
	}
	return out
}

// parseNetstatListen reads `netstat -tunlp` output as a fallback when ss is
// unavailable.
//
// Proto Recv-Q Send-Q Local Address  Foreign Address  State  PID/Program name
// tcp        0      0 0.0.0.0:22     0.0.0.0:*        LISTEN 1234/sshd
func parseNetstatListen(s string) []NetListen {
	out := []NetListen{}
	for _, line := range splitNonEmptyLines(s) {
		if strings.HasPrefix(line, "Active ") || strings.HasPrefix(line, "Proto ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		proto := fields[0]
		local := fields[3]
		port, addr := splitAddrPort(local)
		row := NetListen{Proto: proto, LocalAddr: addr, LocalPort: port}
		if len(fields) >= 7 {
			pidProg := fields[len(fields)-1]
			if slash := strings.IndexByte(pidProg, '/'); slash > 0 {
				row.PID, _ = strconv.Atoi(pidProg[:slash])
				row.Process = pidProg[slash+1:]
			}
		}
		out = append(out, row)
	}
	return out
}

func parseSsUsers(s string) (proc string, pid int) {
	// `users:(("nginx",pid=123,fd=6),("nginx",pid=124,fd=6))`
	i := strings.Index(s, `("`)
	if i < 0 {
		return "", 0
	}
	rest := s[i+2:]
	q := strings.IndexByte(rest, '"')
	if q < 0 {
		return "", 0
	}
	proc = rest[:q]
	pidIdx := strings.Index(rest, "pid=")
	if pidIdx >= 0 {
		num := rest[pidIdx+4:]
		end := strings.IndexAny(num, ",)")
		if end > 0 {
			num = num[:end]
		}
		pid, _ = strconv.Atoi(num)
	}
	return
}

// splitAddrPort handles "0.0.0.0:8080", "[::]:8080", and "*:8080" forms.
func splitAddrPort(s string) (port int, addr string) {
	if s == "" {
		return 0, ""
	}
	if s[0] == '[' {
		end := strings.IndexByte(s, ']')
		if end < 0 {
			return 0, s
		}
		addr = s[1:end]
		rest := s[end+1:]
		if strings.HasPrefix(rest, ":") {
			port, _ = strconv.Atoi(rest[1:])
		}
		return
	}
	if i := strings.LastIndexByte(s, ':'); i >= 0 {
		addr = s[:i]
		port, _ = strconv.Atoi(s[i+1:])
		return
	}
	return 0, s
}

func splitNonEmptyLines(s string) []string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimRight(line, "\r")
		if t == "" {
			continue
		}
		out = append(out, t)
	}
	return out
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// parseCPUMHz reads the numeric value from `grep 'cpu MHz' | cut -d:`.
func parseCPUMHz(s string) float64 {
	f := strings.Fields(strings.TrimSpace(s))
	if len(f) == 0 {
		return 0
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}

// parseCPUTimesAll reads every `cpu` / `cpuN` line from `grep '^cpu' /proc/stat`,
// returning the aggregate plus a per-core map keyed by core index.
func parseCPUTimesAll(s string) (agg cpuTimes, perCore map[int]cpuTimes) {
	perCore = map[int]cpuTimes{}
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 5 || !strings.HasPrefix(fields[0], "cpu") {
			continue
		}
		ct := parseCPUTimesFields(fields[1:])
		if fields[0] == "cpu" {
			agg = ct
			continue
		}
		idx, err := strconv.Atoi(fields[0][3:])
		if err != nil {
			continue
		}
		perCore[idx] = ct
	}
	return
}

func parseCPUTimesFields(nums []string) cpuTimes {
	get := func(i int) uint64 {
		if i >= len(nums) {
			return 0
		}
		v, _ := strconv.ParseUint(nums[i], 10, 64)
		return v
	}
	return cpuTimes{
		User: get(0), Nice: get(1), System: get(2), Idle: get(3),
		IOWait: get(4), IRQ: get(5), SoftIRQ: get(6), Steal: get(7),
	}
}

// cpuBreakdownFromDelta splits the aggregate busy time into user / system /
// iowait / steal percentages (0..100) over two samples. system folds in
// irq + softirq; user folds in nice. Returns -1s when no useful delta.
func cpuBreakdownFromDelta(prev, cur cpuTimes) (user, system, iowait, steal float64) {
	totalDelta := float64(cur.total()) - float64(prev.total())
	if totalDelta <= 0 {
		return -1, -1, -1, -1
	}
	pct := func(c, p uint64) float64 {
		d := float64(c) - float64(p)
		if d < 0 {
			d = 0
		}
		return clampPct(d / totalDelta * 100)
	}
	user = pct(cur.User+cur.Nice, prev.User+prev.Nice)
	system = pct(cur.System+cur.IRQ+cur.SoftIRQ, prev.System+prev.IRQ+prev.SoftIRQ)
	iowait = pct(cur.IOWait, prev.IOWait)
	steal = pct(cur.Steal, prev.Steal)
	return
}

// perCoreUsage returns each core's busy percentage ordered by core index.
func perCoreUsage(prev, cur map[int]cpuTimes) []float64 {
	idxs := make([]int, 0, len(cur))
	for i := range cur {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)
	out := make([]float64, 0, len(idxs))
	for _, i := range idxs {
		p, ok := prev[i]
		if !ok {
			out = append(out, 0)
			continue
		}
		out = append(out, busyPct(p, cur[i]))
	}
	return out
}

func busyPct(prev, cur cpuTimes) float64 {
	totalDelta := float64(cur.total()) - float64(prev.total())
	if totalDelta <= 0 {
		return 0
	}
	idleDelta := float64(cur.idleAll()) - float64(prev.idleAll())
	return clampPct((1 - idleDelta/totalDelta) * 100)
}

// wholeDiskRe matches whole block devices, excluding partitions
// (sda1, nvme0n1p1) and virtual devices (loop, ram, sr, fd).
var wholeDiskRe = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+|dm-\d+)$`)

func isWholeDisk(name string) bool { return wholeDiskRe.MatchString(name) }

// parseDiskstats reads /proc/diskstats. Field layout (1-indexed within line):
// 1 major 2 minor 3 name 4 reads 5 rmerged 6 sectors_read 7 ms_reading
// 8 writes 9 wmerged 10 sectors_written 11 ms_writing 12 inflight 13 ms_io ...
// Sectors are 512 bytes. Only whole disks are kept.
func parseDiskstats(s string, now time.Time) map[string]diskCounter {
	out := map[string]diskCounter{}
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 13 {
			continue
		}
		name := fields[2]
		if !isWholeDisk(name) {
			continue
		}
		reads, _ := strconv.ParseInt(fields[3], 10, 64)
		rsect, _ := strconv.ParseInt(fields[5], 10, 64)
		writes, _ := strconv.ParseInt(fields[7], 10, 64)
		wsect, _ := strconv.ParseInt(fields[9], 10, 64)
		ioms, _ := strconv.ParseInt(fields[12], 10, 64)
		out[name] = diskCounter{
			ReadSectors:  rsect,
			WriteSectors: wsect,
			ReadOps:      reads,
			WriteOps:     writes,
			IOMs:         ioms,
			At:           now,
		}
	}
	return out
}

// diskIOFromDelta turns two diskstats samples into per-device rates, ordered by
// device name. Devices present only in the current sample report zero rates.
func diskIOFromDelta(prev, cur map[string]diskCounter) []DiskIO {
	names := make([]string, 0, len(cur))
	for n := range cur {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]DiskIO, 0, len(names))
	for _, n := range names {
		c := cur[n]
		io := DiskIO{Device: n}
		if p, ok := prev[n]; ok && !p.At.IsZero() {
			if dt := c.At.Sub(p.At).Seconds(); dt > 0 {
				if c.ReadSectors >= p.ReadSectors {
					io.ReadBps = int64(float64(c.ReadSectors-p.ReadSectors) * 512 / dt)
				}
				if c.WriteSectors >= p.WriteSectors {
					io.WriteBps = int64(float64(c.WriteSectors-p.WriteSectors) * 512 / dt)
				}
				if c.ReadOps >= p.ReadOps {
					io.ReadIOPS = int64(float64(c.ReadOps-p.ReadOps) / dt)
				}
				if c.WriteOps >= p.WriteOps {
					io.WriteIOPS = int64(float64(c.WriteOps-p.WriteOps) / dt)
				}
				if c.IOMs >= p.IOMs {
					io.UtilPct = clampPct(float64(c.IOMs-p.IOMs) / (dt * 1000) * 100)
				}
			}
		}
		out = append(out, io)
	}
	return out
}

// parseThermal reads the `<type> <millidegrees>` lines emitted from
// /sys/class/thermal. Implausible readings (<=0 or >150°C) are dropped.
func parseThermal(s string) []TempSensor {
	out := []TempSensor{}
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		milli, err := strconv.ParseFloat(fields[len(fields)-1], 64)
		if err != nil {
			continue
		}
		c := milli / 1000.0
		if c <= 0 || c > 150 {
			continue
		}
		out = append(out, TempSensor{
			Label: strings.Join(fields[:len(fields)-1], " "),
			TempC: c,
		})
		if len(out) >= 12 {
			break
		}
	}
	return out
}

// pickCPUTemp picks the most CPU-representative sensor, else the hottest.
func pickCPUTemp(sensors []TempSensor) float64 {
	best := 0.0
	for _, s := range sensors {
		l := strings.ToLower(s.Label)
		if strings.Contains(l, "pkg") || strings.Contains(l, "package") ||
			strings.Contains(l, "cpu") || strings.Contains(l, "core") ||
			strings.Contains(l, "tdie") || strings.Contains(l, "tctl") ||
			strings.Contains(l, "k10temp") {
			return s.TempC
		}
		if s.TempC > best {
			best = s.TempC
		}
	}
	return best
}

// parseProcState reads `ps -eo stat= | cut -c1 | sort | uniq -c` output:
// each line is "<count> <state-letter>".
func parseProcState(s string) ProcSummary {
	var ps ProcSummary
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		n, err := strconv.Atoi(fields[0])
		if err != nil || fields[1] == "" {
			continue
		}
		ps.Total += n
		switch fields[1][0] {
		case 'R':
			ps.Running += n
		case 'S', 'D', 'I':
			ps.Sleeping += n
		case 'T', 't':
			ps.Stopped += n
		case 'Z':
			ps.Zombie += n
		}
	}
	return ps
}

// parseWho reads `who` output into interactive login sessions:
//
//	root  pts/0  2024-06-07 09:12 (10.0.0.5)
//	alice tty1   2024-06-06 22:01
func parseWho(s string) []LoginUser {
	out := []LoginUser{}
	for _, line := range splitNonEmptyLines(s) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		u := LoginUser{User: fields[0], TTY: fields[1]}
		if len(fields) >= 4 && strings.Contains(fields[2], "-") {
			u.Login = fields[2] + " " + fields[3]
		} else if len(fields) >= 3 {
			u.Login = strings.Join(fields[2:], " ")
		}
		if last := fields[len(fields)-1]; strings.HasPrefix(last, "(") && strings.HasSuffix(last, ")") {
			u.From = strings.TrimSuffix(strings.TrimPrefix(last, "("), ")")
		}
		out = append(out, u)
		if len(out) >= 64 {
			break
		}
	}
	return out
}
