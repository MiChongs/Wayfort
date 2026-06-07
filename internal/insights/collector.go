package insights

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	xssh "golang.org/x/crypto/ssh"
)

// sshExec opens an SSH connection to the target node, runs `command`, and
// returns stdout (stderr discarded after merge). Caller-supplied ctx applies
// to both dial and exec phases.
//
// The connection is closed before returning — insights doesn't hold open
// clients between samples to keep target connection slots free. The 200ms
// handshake cost is acceptable at our default 5s polling cadence.
func sshExec(
	ctx context.Context,
	chain *dialer.ChainBuilder,
	resolver *pkgssh.Resolver,
	hostKey xssh.HostKeyCallback,
	dialTimeout time.Duration,
	proxies *repo.ProxyRepo,
	node *model.Node,
	cred *model.Credential,
	command string,
) (string, error) {
	hops, err := resolveHops(ctx, proxies, node.ProxyChain)
	if err != nil {
		return "", fmt.Errorf("resolve hops: %w", err)
	}
	finalDialer, release, err := chain.Build(ctx, hops, nil)
	if err != nil {
		return "", fmt.Errorf("build chain: %w", err)
	}
	defer release()
	methods, err := resolver.AuthMethods(cred)
	if err != nil {
		return "", fmt.Errorf("decode cred: %w", err)
	}
	if dialTimeout <= 0 {
		dialTimeout = 10 * time.Second
	}
	client, err := pkgssh.Connect(ctx, finalDialer, pkgssh.DialConfig{
		Addr:    pkgssh.AddrOf(node.Host, node.Port),
		User:    pkgssh.PreferredUser(cred, node.Username),
		Auth:    methods,
		HostKey: hostKey,
		Timeout: dialTimeout,
	})
	if err != nil {
		return "", err
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("new session: %w", err)
	}
	defer sess.Close()
	var stdout, stderr bytes.Buffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr
	done := make(chan error, 1)
	go func() { done <- sess.Run(command) }()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = sess.Signal(xssh.SIGINT)
		_ = sess.Close()
		return stdout.String(), ctx.Err()
	}
	// We surface stderr as appended trailing text only when stdout is empty
	// — the system snapshot script is tolerant by design (||/2>/dev/null)
	// so stderr is informational.
	if err != nil {
		if stdout.Len() == 0 {
			return "", fmt.Errorf("ssh run failed: %w (stderr: %s)", err, truncate(stderr.String(), 200))
		}
		// Partial success — return what we got.
	}
	return stdout.String(), nil
}

// systemScript returns the inline shell program collected for one SystemSnapshot
// poll. LC_ALL=C is set so numeric parsing in our parsers doesn't get bitten
// by locale (e.g. comma decimal separators).
const systemScript = `LC_ALL=C
set +e
echo '===UNAME==='
uname -srm; uname -n
echo '===OSREL==='
(cat /etc/os-release 2>/dev/null) | head -20
echo '===UPTIME==='
cat /proc/uptime
echo '===LOADAVG==='
cat /proc/loadavg
echo '===CPUINFO==='
nproc
grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-
echo '===CPUFREQ==='
grep -m1 '^cpu MHz' /proc/cpuinfo 2>/dev/null | cut -d: -f2-
echo '===STAT==='
grep -E '^cpu' /proc/stat
echo '===MEMINFO==='
cat /proc/meminfo
echo '===DF==='
df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null
echo '===DISKSTATS==='
cat /proc/diskstats 2>/dev/null
echo '===INTERFACES==='
ip -j addr show 2>/dev/null
echo '===NETDEV==='
cat /proc/net/dev
echo '===THERMAL==='
for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && printf '%s %s\n' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done 2>/dev/null
echo '===PROCSTATE==='
ps -eo stat= --no-headers 2>/dev/null | cut -c1 | sort | uniq -c
echo '===THREADS==='
ps -eL --no-headers 2>/dev/null | wc -l
echo '===WHO==='
who 2>/dev/null
echo '===END==='
`

const processesScript = `LC_ALL=C
ps -eo pid,ppid,user,pcpu,pmem,rss,stat,comm,args --no-headers --sort=-pcpu 2>/dev/null | head -200
`

const networkScript = `LC_ALL=C
echo '===LISTEN==='
ss -Hntulp 2>/dev/null
echo '===LISTEN_FALLBACK==='
ss -Hntulp 2>/dev/null || netstat -tunlp 2>/dev/null
echo '===ESTABLISHED==='
ss -Hnt state established 2>/dev/null | wc -l
echo '===END==='
`

// sampleState carries the cumulative counters from one poll that the next poll
// needs to turn into rates: aggregate + per-core CPU jiffies, per-interface
// byte counters, and per-device disk counters. Cached per node in the manager.
type sampleState struct {
	aggStat procStat
	aggCPU  cpuTimes
	perCore map[int]cpuTimes
	iface   map[string]ifaceCounter
	disk    map[string]diskCounter
}

// parseSystemBundle takes the raw stdout from systemScript and slices it by
// section markers, calling the appropriate parser for each.
//
// `prev` carries the previous poll's cumulative counters and is used to compute
// deltas (CPU usage/breakdown/per-core, interface bandwidth, disk throughput).
// On the first sample the rate fields report -1 / 0 and `cur` seeds the next call.
func parseSystemBundle(out string, prev sampleState, now time.Time) (snap SystemSnapshot, cur sampleState) {
	snap.GeneratedAt = now
	sections := splitSections(out)

	os, kernel, arch, hostname := parseUname(sections["UNAME"])
	snap.Host = HostInfo{OS: os, Kernel: kernel, Arch: arch, Hostname: hostname}
	snap.Host.Distro = parseOSRelease(sections["OSREL"])
	snap.Uptime = parseUptime(sections["UPTIME"])
	snap.LoadAvg = parseLoadavg(sections["LOADAVG"])

	cores, model := parseCPUInfo(sections["CPUINFO"])
	snap.CPU = CPUInfo{
		Cores: cores, Model: model,
		UsagePct: -1, UserPct: -1, SystemPct: -1, IOWaitPct: -1, StealPct: -1,
		MHz: parseCPUMHz(sections["CPUFREQ"]),
	}
	if stat, ok := parseProcStatCPU(sections["STAT"]); ok {
		cur.aggStat = stat
		if prev.aggStat.Total != 0 {
			snap.CPU.UsagePct = cpuUsagePctFromDelta(prev.aggStat, stat)
		}
	}
	agg, perCore := parseCPUTimesAll(sections["STAT"])
	cur.aggCPU = agg
	cur.perCore = perCore
	if prev.aggCPU.total() != 0 {
		u, s, io, st := cpuBreakdownFromDelta(prev.aggCPU, agg)
		snap.CPU.UserPct, snap.CPU.SystemPct, snap.CPU.IOWaitPct, snap.CPU.StealPct = u, s, io, st
	}
	if len(prev.perCore) > 0 {
		snap.CPU.PerCore = perCoreUsage(prev.perCore, perCore)
	}

	snap.Memory = parseMeminfo(sections["MEMINFO"])
	snap.Disks = parseDF(sections["DF"])

	// Disk I/O — delta against the previous /proc/diskstats sample.
	cur.disk = parseDiskstats(sections["DISKSTATS"], now)
	snap.DiskIO = diskIOFromDelta(prev.disk, cur.disk)

	ifs, ipOk := parseIPJSON(sections["INTERFACES"])
	if !ipOk {
		// `ip -j` unavailable on this host — we don't ship a text-mode fallback
		// here to keep the surface small. UI will show MAC/IP unknown but
		// rx/tx counters from /proc/net/dev still populate.
		ifs = []NetIface{}
	}
	counters := parseNetDev(sections["NETDEV"])
	cur.iface = map[string]ifaceCounter{}
	for name, c := range counters {
		cur.iface[name] = ifaceCounter{Rx: c[0], Tx: c[1], At: now}
	}
	byName := map[string]int{}
	for i, ni := range ifs {
		byName[ni.Name] = i
	}
	// Ensure all interfaces with counters appear, even if `ip` didn't list
	// them. Common on minimal containers.
	for name := range cur.iface {
		if _, ok := byName[name]; !ok {
			byName[name] = len(ifs)
			ifs = append(ifs, NetIface{Name: name, OperState: "UNKNOWN"})
		}
	}
	for name, idx := range byName {
		ni := ifs[idx]
		c := cur.iface[name]
		ni.RxBytes = c.Rx
		ni.TxBytes = c.Tx
		if p, ok := prev.iface[name]; ok && !p.At.IsZero() {
			dt := c.At.Sub(p.At).Seconds()
			if dt > 0 {
				if c.Rx >= p.Rx {
					ni.RxBps = int64(float64(c.Rx-p.Rx) / dt)
				}
				if c.Tx >= p.Tx {
					ni.TxBps = int64(float64(c.Tx-p.Tx) / dt)
				}
			}
		}
		ifs[idx] = ni
	}
	sort.Slice(ifs, func(i, j int) bool { return ifs[i].Name < ifs[j].Name })
	snap.Interfaces = ifs

	snap.Temps = parseThermal(sections["THERMAL"])
	if len(snap.Temps) > 0 {
		snap.CPU.TempC = pickCPUTemp(snap.Temps)
	}

	snap.Procs = parseProcState(sections["PROCSTATE"])
	if th, ok := parseIntField(sections["THREADS"]); ok {
		snap.Procs.Threads = th
	}

	snap.Sessions = parseWho(sections["WHO"])
	snap.LoggedInUsers = len(snap.Sessions)
	return
}

func parseProcessesBundle(out string, sortBy string) ProcessList {
	procs := parsePsOutput(out)
	switch sortBy {
	case "mem":
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].MemPct > procs[j].MemPct })
	case "rss":
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].RSSKb > procs[j].RSSKb })
	case "pid":
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].PID < procs[j].PID })
	default:
		// cpu — already sorted by `ps --sort=-pcpu` but resort defensively.
		sort.SliceStable(procs, func(i, j int) bool { return procs[i].CPUPct > procs[j].CPUPct })
	}
	return ProcessList{
		GeneratedAt: time.Now().UTC(),
		Total:       len(procs),
		Processes:   procs,
		SortedBy:    sortBy,
	}
}

func parseNetworkBundle(out string) NetworkSnapshot {
	sections := splitSections(out)
	listeners := parseSsListen(sections["LISTEN"])
	if len(listeners) == 0 {
		// Fall back to netstat output if ss returned nothing.
		listeners = parseNetstatListen(sections["LISTEN_FALLBACK"])
	}
	est, _ := parseIntField(sections["ESTABLISHED"])
	return NetworkSnapshot{
		GeneratedAt: time.Now().UTC(),
		Listeners:   listeners,
		Established: est,
	}
}

func splitSections(raw string) map[string]string {
	out := map[string]string{}
	lines := strings.Split(raw, "\n")
	var cur string
	var buf strings.Builder
	for _, line := range lines {
		t := strings.TrimRight(line, "\r")
		if strings.HasPrefix(t, "===") && strings.HasSuffix(t, "===") {
			if cur != "" {
				out[cur] = buf.String()
			}
			cur = strings.Trim(t, "= ")
			buf.Reset()
			continue
		}
		buf.WriteString(t)
		buf.WriteByte('\n')
	}
	if cur != "" {
		out[cur] = buf.String()
	}
	delete(out, "END")
	return out
}

func parseIntField(s string) (int, bool) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, false
	}
	// First whitespace-delimited token.
	fields := strings.Fields(t)
	if len(fields) == 0 {
		return 0, false
	}
	var v int
	_, err := fmt.Sscanf(fields[0], "%d", &v)
	if err != nil {
		return 0, false
	}
	return v, true
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func resolveHops(ctx context.Context, proxies *repo.ProxyRepo, chain string) ([]*model.Proxy, error) {
	if strings.TrimSpace(chain) == "" {
		return nil, nil
	}
	out := []*model.Proxy{}
	for _, raw := range strings.Split(chain, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		var id uint64
		if _, err := fmt.Sscanf(raw, "%d", &id); err != nil {
			return nil, fmt.Errorf("invalid proxy id %q", raw)
		}
		p, err := proxies.FindByID(ctx, id)
		if err != nil || p == nil {
			return nil, fmt.Errorf("proxy %s not found", raw)
		}
		out = append(out, p)
	}
	return out, nil
}
