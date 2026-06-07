package hardware

import "strings"

const inventoryScript = `LC_ALL=C
echo '===LSCPU==='
lscpu 2>/dev/null
echo '===FREE==='
free -h 2>/dev/null | grep -i '^mem'
echo '===DMIMEM==='
(sudo -n dmidecode -t memory 2>/dev/null || dmidecode -t memory 2>/dev/null)
echo '===DMISYS==='
(sudo -n dmidecode -t system -t bios -t baseboard 2>/dev/null || dmidecode -t system -t bios -t baseboard 2>/dev/null)
echo '===PCI==='
lspci 2>/dev/null | head -80
echo '===USB==='
lsusb 2>/dev/null | head -60
echo '===SENSORS==='
sensors 2>/dev/null | head -80
echo '===END==='
`

// lscpuKeys is the curated set surfaced from `lscpu`.
var lscpuKeys = map[string]bool{
	"Architecture": true, "CPU op-mode(s)": true, "Byte Order": true,
	"CPU(s)": true, "On-line CPU(s) list": true, "Vendor ID": true,
	"Model name": true, "CPU family": true, "Thread(s) per core": true,
	"Core(s) per socket": true, "Socket(s)": true, "CPU MHz": true,
	"CPU max MHz": true, "CPU min MHz": true, "BogoMIPS": true,
	"Virtualization": true, "L1d cache": true, "L1i cache": true,
	"L2 cache": true, "L3 cache": true, "NUMA node(s)": true,
}

func parseLscpu(s string) map[string]string {
	m := map[string]string{}
	for _, line := range splitNonEmptyLines(s) {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if lscpuKeys[k] {
			m[k] = strings.TrimSpace(v)
		}
	}
	return m
}

// dmiSysKeys curated from dmidecode system/bios/baseboard.
var dmiSysKeys = map[string]bool{
	"Manufacturer": true, "Product Name": true, "Serial Number": false,
	"Version": true, "Vendor": true, "Release Date": true, "BIOS Revision": true,
	"Family": true,
}

func parseDmiSys(s string) map[string]string {
	m := map[string]string{}
	for _, line := range splitNonEmptyLines(s) {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if want, listed := dmiSysKeys[k]; listed && want {
			val := strings.TrimSpace(v)
			if val != "" && val != "Not Specified" && m[k] == "" {
				m[k] = val
			}
		}
	}
	return m
}

// parseDmiMemory extracts populated DIMMs from `dmidecode -t memory`. Module
// blocks start at "Memory Device"; entries with Size "No Module Installed" are
// skipped.
func parseDmiMemory(s string) []MemModule {
	out := []MemModule{}
	var cur *MemModule
	flush := func() {
		if cur != nil && cur.Size != "" && !strings.Contains(strings.ToLower(cur.Size), "no module") {
			out = append(out, *cur)
		}
		cur = nil
	}
	for _, raw := range strings.Split(s, "\n") {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "Memory Device" {
			flush()
			cur = &MemModule{}
			continue
		}
		if cur == nil {
			continue
		}
		k, v, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		val := strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "Size":
			cur.Size = val
		case "Locator":
			cur.Locator = val
		case "Type":
			if val != "Unknown" {
				cur.Type = val
			}
		case "Speed", "Configured Memory Speed", "Configured Clock Speed":
			if cur.Speed == "" && val != "Unknown" {
				cur.Speed = val
			}
		case "Manufacturer":
			if val != "Unknown" && val != "Not Specified" {
				cur.Mfr = val
			}
		}
	}
	flush()
	return out
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
