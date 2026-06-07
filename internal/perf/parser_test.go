package perf

import "testing"

func TestParsePSI(t *testing.T) {
	some, full, ok := parsePSI("some avg10=1.23 avg60=4.56 avg300=7.89 total=12345\nfull avg10=0.10 avg60=0.20 avg300=0.30 total=999\n")
	if !ok || some.Avg10 != 1.23 || some.Avg60 != 4.56 || some.Avg300 != 7.89 {
		t.Fatalf("some: %+v ok=%v", some, ok)
	}
	if full.Avg10 != 0.10 || full.Avg300 != 0.30 {
		t.Errorf("full: %+v", full)
	}
	if _, _, ok := parsePSI(""); ok {
		t.Error("empty should be ok=false")
	}
}

func TestParseVMStat(t *testing.T) {
	// header lines + two samples; only the last row matters.
	in := "procs ...\n r  b ...\n 1  0 0 100 200 300 0 0 5 6 1000 2000 10 5 80 4 1\n 2  1 0 100 200 300 7 8 9 10 1100 2200 20 6 70 3 1\n"
	v := parseVMStat(in)
	if !v.Available || v.ProcsR != 2 || v.ProcsB != 1 {
		t.Fatalf("procs: %+v", v)
	}
	if v.SwapInKBs != 7 || v.SwapOutKBs != 8 || v.BlockInKBs != 9 || v.BlockOutKBs != 10 {
		t.Errorf("io: %+v", v)
	}
	if v.Interrupts != 1100 || v.ContextSwitches != 2200 {
		t.Errorf("intr/cs: %+v", v)
	}
	if v.CPUUser != 20 || v.CPUSystem != 6 || v.CPUIdle != 70 || v.CPUIOWait != 3 || v.CPUSteal != 1 {
		t.Errorf("cpu: %+v", v)
	}
}

func TestParseIOStat(t *testing.T) {
	// Two reports; we keep the LAST. Newer sysstat header form.
	in := `Linux 5.15 (host)  06/08/2026  _x86_64_ (4 CPU)

Device  tps  rkB/s  wkB/s  await  %util
sda     1.0  10.0   20.0   0.5    0.1
nvme0n1 2.0  30.0   40.0   1.5    5.0

Device  tps  rkB/s  wkB/s  await  %util
sda     5.0  100.0  200.0  2.5    12.0
nvme0n1 6.0  300.0  400.0  3.5    50.0
`
	disks := parseIOStat(in)
	if len(disks) != 2 {
		t.Fatalf("want 2 (last report), got %d (%+v)", len(disks), disks)
	}
	if disks[0].Device != "sda" || disks[0].TPS != 5.0 || disks[0].ReadKBs != 100.0 || disks[0].UtilPct != 12.0 {
		t.Errorf("sda: %+v", disks[0])
	}
	if disks[1].Device != "nvme0n1" || disks[1].WriteKBs != 400.0 || disks[1].AwaitMs != 3.5 {
		t.Errorf("nvme: %+v", disks[1])
	}
}

func TestClassifyDmesg(t *testing.T) {
	in := "[1] usb 1-1: new device\n[2] Out of memory: Killed process 1234 (java)\n[3] random line\n"
	tail, oom := classifyDmesg(in)
	if len(tail) != 3 {
		t.Fatalf("tail: %d", len(tail))
	}
	if len(oom) != 1 || oom[0] != "[2] Out of memory: Killed process 1234 (java)" {
		t.Errorf("oom: %+v", oom)
	}
}

func TestParseLoad(t *testing.T) {
	l := parseLoad("0.50 1.20 0.80 1/200 9999\n")
	if l[0] != 0.50 || l[1] != 1.20 || l[2] != 0.80 {
		t.Errorf("load: %+v", l)
	}
}
