package hardware

import "testing"

func TestParseLscpu(t *testing.T) {
	in := "Architecture:        x86_64\nCPU(s):              8\nModel name:          Intel(R) Xeon(R) CPU E5-2680\nThread(s) per core:  2\nL3 cache:            20480K\nIgnored field:       nope\n"
	m := parseLscpu(in)
	if m["Architecture"] != "x86_64" || m["CPU(s)"] != "8" || m["Thread(s) per core"] != "2" || m["L3 cache"] != "20480K" {
		t.Fatalf("got %+v", m)
	}
	if _, ok := m["Ignored field"]; ok {
		t.Error("uncurated key leaked")
	}
}

func TestParseDmiMemory(t *testing.T) {
	in := `Memory Device
	Size: 16384 MB
	Locator: DIMM_A1
	Type: DDR4
	Speed: 3200 MT/s
	Manufacturer: Samsung

Memory Device
	Size: No Module Installed
	Locator: DIMM_B1

Memory Device
	Size: 16384 MB
	Locator: DIMM_A2
	Type: DDR4
	Manufacturer: Unknown
`
	mods := parseDmiMemory(in)
	if len(mods) != 2 {
		t.Fatalf("want 2 populated, got %d (%+v)", len(mods), mods)
	}
	if mods[0].Locator != "DIMM_A1" || mods[0].Size != "16384 MB" || mods[0].Type != "DDR4" || mods[0].Mfr != "Samsung" {
		t.Errorf("mod0: %+v", mods[0])
	}
	if mods[1].Locator != "DIMM_A2" || mods[1].Mfr != "" {
		t.Errorf("mod1 (Unknown mfr should drop): %+v", mods[1])
	}
}

func TestParseDmiSys(t *testing.T) {
	in := "System Information\n\tManufacturer: Dell Inc.\n\tProduct Name: PowerEdge R740\n\tSerial Number: ABC123\n"
	m := parseDmiSys(in)
	if m["Manufacturer"] != "Dell Inc." || m["Product Name"] != "PowerEdge R740" {
		t.Fatalf("got %+v", m)
	}
	if _, ok := m["Serial Number"]; ok {
		t.Error("serial should not be surfaced")
	}
}
