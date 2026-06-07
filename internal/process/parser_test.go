package process

import "testing"

func TestParsePsList(t *testing.T) {
	in := "    1     0 root      0.0  0.1   8800  16000  1 0 Ss 123456 systemd /sbin/init splash\n" +
		" 1234     1 www-data 12.5  3.2 120000 900000 4 -5 Sl 4000 nginx nginx: master process /usr/sbin/nginx -g daemon off;\n"
	procs := parsePsList(in)
	if len(procs) != 2 {
		t.Fatalf("want 2, got %d", len(procs))
	}
	p := procs[0]
	if p.PID != 1 || p.PPID != 0 || p.User != "root" || p.Threads != 1 || p.State != "Ss" || p.Comm != "systemd" {
		t.Errorf("p0: %+v", p)
	}
	if p.Args != "/sbin/init splash" {
		t.Errorf("p0 args: %q", p.Args)
	}
	p = procs[1]
	if p.PID != 1234 || p.CPUPct != 12.5 || p.MemPct != 3.2 || p.RSSKb != 120000 || p.VSZKb != 900000 || p.Nice != -5 || p.ElapsedSec != 4000 {
		t.Errorf("p1: %+v", p)
	}
	if p.Args != "nginx: master process /usr/sbin/nginx -g daemon off;" {
		t.Errorf("p1 args lost: %q", p.Args)
	}
}

func TestSortProcs(t *testing.T) {
	procs := []Process{
		{PID: 3, CPUPct: 1, MemPct: 9, RSSKb: 10},
		{PID: 1, CPUPct: 9, MemPct: 1, RSSKb: 30},
		{PID: 2, CPUPct: 5, MemPct: 5, RSSKb: 20},
	}
	sortProcs(procs, "cpu")
	if procs[0].PID != 1 {
		t.Errorf("cpu sort: %+v", procs)
	}
	sortProcs(procs, "mem")
	if procs[0].MemPct != 9 {
		t.Errorf("mem sort: %+v", procs)
	}
	sortProcs(procs, "rss")
	if procs[0].RSSKb != 30 {
		t.Errorf("rss sort: %+v", procs)
	}
	sortProcs(procs, "pid")
	if procs[0].PID != 1 || procs[2].PID != 3 {
		t.Errorf("pid sort: %+v", procs)
	}
}

func TestValidPID(t *testing.T) {
	if !validPID(1) || !validPID(99999) {
		t.Error("want valid")
	}
	if validPID(0) || validPID(-1) {
		t.Error("want invalid")
	}
}

func TestValidSignal(t *testing.T) {
	for _, s := range []Signal{SigTERM, SigKILL, SigHUP, SigSTOP, SigCONT} {
		if !ValidSignal(s) {
			t.Errorf("want valid: %s", s)
		}
	}
	if ValidSignal("ABRT; rm -rf /") || ValidSignal("") || ValidSignal("9") {
		t.Error("want invalid")
	}
}

func TestParseStatusAndIO(t *testing.T) {
	st := parseStatus("Name:\tnginx\nState:\tS (sleeping)\nThreads:\t4\nVmRSS:\t120000 kB\nFooBar:\tignored\n")
	if st["Name"] != "nginx" || st["Threads"] != "4" || st["VmRSS"] != "120000 kB" {
		t.Errorf("status: %+v", st)
	}
	if _, ok := st["FooBar"]; ok {
		t.Error("uncurated key leaked")
	}
	r, w := parseIO("rchar: 1\nread_bytes: 4096\nwrite_bytes: 8192\n")
	if r != 4096 || w != 8192 {
		t.Errorf("io: r=%d w=%d", r, w)
	}
}
