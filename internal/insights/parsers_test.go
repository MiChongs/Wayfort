package insights

import (
	"testing"
	"time"
)

func TestParseUname(t *testing.T) {
	in := "Linux 5.15.0-89-generic x86_64\nweb-prod-01\n"
	os, kernel, arch, host := parseUname(in)
	if os != "Linux" || kernel != "5.15.0-89-generic" || arch != "x86_64" || host != "web-prod-01" {
		t.Fatalf("got %q %q %q %q", os, kernel, arch, host)
	}
}

func TestParseOSRelease(t *testing.T) {
	in := `NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
PRETTY_NAME="Ubuntu 22.04.3 LTS"
ID=ubuntu
`
	if got := parseOSRelease(in); got != "Ubuntu 22.04.3 LTS" {
		t.Fatalf("got %q", got)
	}
}

func TestParseUptime(t *testing.T) {
	if got := parseUptime("123456.78 4567.89"); got != 123456 {
		t.Fatalf("got %d", got)
	}
	if got := parseUptime("garbage"); got != 0 {
		t.Fatalf("garbage should be 0, got %d", got)
	}
}

func TestParseLoadavg(t *testing.T) {
	got := parseLoadavg("0.21 0.14 0.13 1/220 12345\n")
	if got[0] != 0.21 || got[1] != 0.14 || got[2] != 0.13 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseCPUInfo(t *testing.T) {
	in := "8\nIntel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz\n"
	cores, model := parseCPUInfo(in)
	if cores != 8 || model != "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz" {
		t.Fatalf("got %d %q", cores, model)
	}
}

func TestParseProcStatCPU(t *testing.T) {
	in := "cpu  100 0 50 1000 10 0 5 0 0 0\n"
	s, ok := parseProcStatCPU(in)
	if !ok || s.Idle != 1010 || s.Total != 1165 {
		t.Fatalf("got %+v ok=%v", s, ok)
	}
}

func TestCPUUsagePctFromDelta(t *testing.T) {
	prev := procStat{Idle: 1000, Total: 2000}
	cur := procStat{Idle: 1500, Total: 3000}
	// idleDelta=500 totalDelta=1000 → 50% busy.
	if got := cpuUsagePctFromDelta(prev, cur); got != 50 {
		t.Fatalf("got %v", got)
	}
	if got := cpuUsagePctFromDelta(procStat{}, cur); got != -1 {
		t.Fatalf("no-prev should return -1, got %v", got)
	}
}

func TestParseMeminfo(t *testing.T) {
	in := `MemTotal:       16384000 kB
MemFree:         1024000 kB
MemAvailable:   12000000 kB
Buffers:          200000 kB
Cached:          3000000 kB
SReclaimable:     100000 kB
SwapTotal:       4096000 kB
SwapFree:        4000000 kB
`
	m := parseMeminfo(in)
	if m.TotalKb != 16384000 {
		t.Errorf("total: %d", m.TotalKb)
	}
	if m.AvailableKb != 12000000 {
		t.Errorf("avail: %d", m.AvailableKb)
	}
	if m.UsedKb != 16384000-12000000 {
		t.Errorf("used: %d", m.UsedKb)
	}
	if m.BuffCacheKb != 3300000 {
		t.Errorf("buffcache: %d", m.BuffCacheKb)
	}
	if m.SwapUsedKb != 96000 {
		t.Errorf("swap used: %d", m.SwapUsedKb)
	}
}

func TestParseDF(t *testing.T) {
	in := `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1         20480000  12000000   8000000      60% /
tmpfs              1024000     50000    974000       5% /run
/dev/sdb1         51200000   1024000  50176000       3% /var/data
`
	disks := parseDF(in)
	if len(disks) != 3 {
		t.Fatalf("want 3 disks, got %d", len(disks))
	}
	if disks[0].Mount != "/" || disks[0].UsedPct != 60 || disks[0].TotalKb != 20480000 {
		t.Errorf("disk 0: %+v", disks[0])
	}
	if disks[2].Source != "/dev/sdb1" {
		t.Errorf("disk 2 source: %s", disks[2].Source)
	}
}

func TestParseDFMountWithSpace(t *testing.T) {
	in := `Filesystem  1024-blocks  Used  Available  Capacity  Mounted on
/dev/sda1     20480000 12000000  8000000      60% /mnt/data folder
`
	disks := parseDF(in)
	if len(disks) != 1 {
		t.Fatalf("want 1 disk, got %d", len(disks))
	}
	if disks[0].Mount != "/mnt/data folder" {
		t.Errorf("mount with space lost: %q", disks[0].Mount)
	}
}

func TestParseIPJSON(t *testing.T) {
	in := `[{"ifindex":1,"ifname":"lo","operstate":"UNKNOWN","address":"00:00:00:00:00:00","addr_info":[{"family":"inet","local":"127.0.0.1"},{"family":"inet6","local":"::1"}]},{"ifindex":2,"ifname":"eth0","operstate":"UP","address":"aa:bb:cc:dd:ee:ff","addr_info":[{"family":"inet","local":"10.0.0.5"}]}]`
	ifs, ok := parseIPJSON(in)
	if !ok || len(ifs) != 2 {
		t.Fatalf("ok=%v ifs=%v", ok, ifs)
	}
	if ifs[0].Name != "lo" || ifs[0].IPv4 != "127.0.0.1" || ifs[0].IPv6 != "::1" {
		t.Errorf("lo: %+v", ifs[0])
	}
	if ifs[1].Name != "eth0" || ifs[1].OperState != "UP" || ifs[1].IPv4 != "10.0.0.5" || ifs[1].MAC != "aa:bb:cc:dd:ee:ff" {
		t.Errorf("eth0: %+v", ifs[1])
	}
}

func TestParseIPJSON_bad(t *testing.T) {
	if _, ok := parseIPJSON("garbage"); ok {
		t.Fatal("expected ok=false")
	}
}

func TestParseNetDev(t *testing.T) {
	in := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 12345    99    0    0    0     0          0         0      67890    99    0    0    0     0       0          0
  eth0: 1000000  500    0    0    0     0          0         0    2000000   600    0    0    0     0       0          0
`
	m := parseNetDev(in)
	if got := m["lo"]; got[0] != 12345 || got[1] != 67890 {
		t.Errorf("lo: %v", got)
	}
	if got := m["eth0"]; got[0] != 1000000 || got[1] != 2000000 {
		t.Errorf("eth0: %v", got)
	}
}

func TestParsePsOutput(t *testing.T) {
	in := `    1     0 root      0.0  0.1   8800 Ss   systemd /sbin/init splash
 1234     1 www-data 12.5  3.2 120000 Sl   nginx nginx: master process /usr/sbin/nginx -g daemon off;
`
	procs := parsePsOutput(in)
	if len(procs) != 2 {
		t.Fatalf("want 2, got %d", len(procs))
	}
	p := procs[0]
	if p.PID != 1 || p.PPID != 0 || p.User != "root" || p.CPUPct != 0 || p.Comm != "systemd" {
		t.Errorf("p0: %+v", p)
	}
	if p.Args != "/sbin/init splash" {
		t.Errorf("p0 args: %q", p.Args)
	}
	p = procs[1]
	if p.PID != 1234 || p.User != "www-data" || p.CPUPct != 12.5 || p.MemPct != 3.2 || p.RSSKb != 120000 {
		t.Errorf("p1: %+v", p)
	}
	if p.Args != "nginx: master process /usr/sbin/nginx -g daemon off;" {
		t.Errorf("p1 args lost: %q", p.Args)
	}
}

func TestParseSsListen(t *testing.T) {
	in := `tcp   LISTEN 0      511                0.0.0.0:80               0.0.0.0:*    users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))
tcp   LISTEN 0      128                   [::]:22                  [::]:*    users:(("sshd",pid=987,fd=3))
udp   UNCONN 0      0                   0.0.0.0:53               0.0.0.0:*    users:(("dnsmasq",pid=42,fd=4))
`
	rows := parseSsListen(in)
	if len(rows) != 3 {
		t.Fatalf("want 3, got %d", len(rows))
	}
	if rows[0].Proto != "tcp" || rows[0].LocalPort != 80 || rows[0].Process != "nginx" || rows[0].PID != 1234 {
		t.Errorf("nginx: %+v", rows[0])
	}
	if rows[1].LocalAddr != "::" || rows[1].LocalPort != 22 || rows[1].Process != "sshd" {
		t.Errorf("sshd: %+v", rows[1])
	}
	if rows[2].Proto != "udp" || rows[2].Process != "dnsmasq" {
		t.Errorf("dnsmasq: %+v", rows[2])
	}
}

func TestParseNetstatListen(t *testing.T) {
	in := `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1234/sshd
tcp6       0      0 :::8080                 :::*                    LISTEN      9876/java
`
	rows := parseNetstatListen(in)
	if len(rows) != 2 {
		t.Fatalf("want 2, got %d", len(rows))
	}
	if rows[0].LocalPort != 22 || rows[0].Process != "sshd" || rows[0].PID != 1234 {
		t.Errorf("sshd: %+v", rows[0])
	}
	if rows[1].Proto != "tcp6" || rows[1].LocalPort != 8080 || rows[1].Process != "java" {
		t.Errorf("java: %+v", rows[1])
	}
}

func TestParseCPUTimesAll(t *testing.T) {
	in := "cpu  100 10 50 1000 20 0 5 2 0 0\n" +
		"cpu0 60 5 25 500 10 0 2 1 0 0\n" +
		"cpu1 40 5 25 500 10 0 3 1 0 0\n"
	agg, per := parseCPUTimesAll(in)
	if agg.User != 100 || agg.System != 50 || agg.Idle != 1000 || agg.IOWait != 20 || agg.Steal != 2 {
		t.Fatalf("agg: %+v", agg)
	}
	if len(per) != 2 {
		t.Fatalf("want 2 cores, got %d", len(per))
	}
	if per[0].User != 60 || per[1].User != 40 {
		t.Errorf("per-core: %+v", per)
	}
}

func TestCPUBreakdownFromDelta(t *testing.T) {
	prev := cpuTimes{User: 100, System: 100, Idle: 1000, IOWait: 0, Steal: 0}
	// +100 user, +100 system, +800 idle → total delta 1000 → 10% user, 10% system.
	cur := cpuTimes{User: 200, System: 200, Idle: 1800, IOWait: 0, Steal: 0}
	u, s, io, st := cpuBreakdownFromDelta(prev, cur)
	if u != 10 || s != 10 || io != 0 || st != 0 {
		t.Fatalf("got u=%v s=%v io=%v st=%v", u, s, io, st)
	}
	if u, _, _, _ := cpuBreakdownFromDelta(cpuTimes{}, cpuTimes{}); u != -1 {
		t.Errorf("no-delta should be -1, got %v", u)
	}
}

func TestPerCoreUsage(t *testing.T) {
	prev := map[int]cpuTimes{0: {Idle: 1000}, 1: {Idle: 1000}}
	// core0: +500 idle, +500 busy → 50%. core1: +1000 idle, +0 busy → 0%.
	cur := map[int]cpuTimes{0: {User: 500, Idle: 1500}, 1: {Idle: 2000}}
	got := perCoreUsage(prev, cur)
	if len(got) != 2 || got[0] != 50 || got[1] != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseDiskstatsAndDelta(t *testing.T) {
	// Field layout (after the name): reads rmerged rsect msread writes wmerged
	// wsect mswrite inflight io_ms weighted. io_ms is index 12 (0-based).
	// sda is a whole disk, sda1 a partition (skipped), loop0 virtual (skipped).
	line := "   8       0 sda 100 0 2000 50 200 0 4000 80 0 130 200\n" +
		"   8       1 sda1 10 0 20 1 5 0 40 2 0 1 2\n" +
		"   7       0 loop0 1 0 2 0 0 0 0 0 0 0 0\n"
	t0 := time.Unix(1000, 0)
	prev := parseDiskstats(line, t0)
	if len(prev) != 1 {
		t.Fatalf("want only sda, got %d (%v)", len(prev), prev)
	}
	// One second later sda read +1000 sectors, wrote +2000 sectors, io_ms +500.
	line2 := "   8       0 sda 150 0 3000 60 300 0 6000 90 0 630 800\n"
	cur := parseDiskstats(line2, t0.Add(time.Second))
	io := diskIOFromDelta(prev, cur)
	if len(io) != 1 {
		t.Fatalf("want 1 device, got %d", len(io))
	}
	d := io[0]
	if d.Device != "sda" || d.ReadBps != 1000*512 || d.WriteBps != 2000*512 {
		t.Errorf("throughput: %+v", d)
	}
	if d.ReadIOPS != 50 || d.WriteIOPS != 100 || d.UtilPct != 50 {
		t.Errorf("iops/util: %+v", d)
	}
}

func TestParseThermalAndPick(t *testing.T) {
	in := "x86_pkg_temp 54000\nacpitz 38000\nbogus 999000\n"
	sensors := parseThermal(in)
	if len(sensors) != 2 {
		t.Fatalf("want 2 (999°C dropped), got %d (%v)", len(sensors), sensors)
	}
	if sensors[0].Label != "x86_pkg_temp" || sensors[0].TempC != 54 {
		t.Errorf("sensor0: %+v", sensors[0])
	}
	if got := pickCPUTemp(sensors); got != 54 {
		t.Errorf("pick: %v", got)
	}
}

func TestParseProcState(t *testing.T) {
	in := "    220 S\n      2 R\n      1 Z\n      3 D\n"
	ps := parseProcState(in)
	if ps.Total != 226 || ps.Running != 2 || ps.Sleeping != 223 || ps.Zombie != 1 {
		t.Fatalf("got %+v", ps)
	}
}

func TestParseWho(t *testing.T) {
	in := "root     pts/0        2024-06-07 09:12 (10.0.0.5)\n" +
		"alice    tty1         2024-06-06 22:01\n"
	rows := parseWho(in)
	if len(rows) != 2 {
		t.Fatalf("want 2, got %d", len(rows))
	}
	if rows[0].User != "root" || rows[0].TTY != "pts/0" || rows[0].From != "10.0.0.5" || rows[0].Login != "2024-06-07 09:12" {
		t.Errorf("root: %+v", rows[0])
	}
	if rows[1].User != "alice" || rows[1].From != "" {
		t.Errorf("alice: %+v", rows[1])
	}
}

func TestParseCPUMHz(t *testing.T) {
	if got := parseCPUMHz(" 2400.000\n"); got != 2400 {
		t.Errorf("got %v", got)
	}
	if got := parseCPUMHz("garbage"); got != 0 {
		t.Errorf("garbage should be 0, got %v", got)
	}
}

func TestSplitAddrPort(t *testing.T) {
	tests := []struct {
		in       string
		wantPort int
		wantAddr string
	}{
		{"0.0.0.0:8080", 8080, "0.0.0.0"},
		{"[::]:443", 443, "::"},
		{"[2001:db8::1]:22", 22, "2001:db8::1"},
		{"*:53", 53, "*"},
	}
	for _, tc := range tests {
		p, a := splitAddrPort(tc.in)
		if p != tc.wantPort || a != tc.wantAddr {
			t.Errorf("%q: got (%d,%q) want (%d,%q)", tc.in, p, a, tc.wantPort, tc.wantAddr)
		}
	}
}
