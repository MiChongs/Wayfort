package storage

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

const snapshotScript = `LC_ALL=C
echo '===LSBLK==='
lsblk -J -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,MODEL 2>/dev/null
echo '===DF==='
df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null
echo '===DFI==='
df -P -i -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null
echo '===FSTAB==='
grep -vE '^\s*#|^\s*$' /etc/fstab 2>/dev/null
echo '===SMART==='
for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
  h=$( (sudo -n smartctl -H /dev/$d 2>/dev/null || smartctl -H /dev/$d 2>/dev/null) | grep -iE 'overall-health|SMART Health Status' | head -1)
  printf '%s|%s\n' "$d" "$h"
done
echo '===LVM==='
(echo '# PV'; pvs 2>/dev/null; echo '# VG'; vgs 2>/dev/null; echo '# LV'; lvs 2>/dev/null)
echo '===END==='
`

// mountPathRe guards mount targets before they reach the shell.
var mountPathRe = regexp.MustCompile(`^/[A-Za-z0-9._/\-]{0,512}$`)

func validMount(p string) bool {
	return p != "" && p != "/" && mountPathRe.MatchString(p) && !strings.Contains(p, "..")
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

type lsblkDoc struct {
	BlockDevices []rawBlk `json:"blockdevices"`
}
type rawBlk struct {
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	Size       string   `json:"size"`
	FSType     string   `json:"fstype"`
	MountPoint string   `json:"mountpoint"`
	Model      string   `json:"model"`
	Children   []rawBlk `json:"children"`
}

func parseLsblk(s string) []BlockDevice {
	var doc lsblkDoc
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &doc); err != nil {
		return nil
	}
	var conv func(r rawBlk) BlockDevice
	conv = func(r rawBlk) BlockDevice {
		b := BlockDevice{
			Name: r.Name, Type: r.Type, Size: r.Size,
			FSType: r.FSType, MountPoint: r.MountPoint, Model: strings.TrimSpace(r.Model),
		}
		for _, c := range r.Children {
			b.Children = append(b.Children, conv(c))
		}
		return b
	}
	out := make([]BlockDevice, 0, len(doc.BlockDevices))
	for _, r := range doc.BlockDevices {
		out = append(out, conv(r))
	}
	return out
}

// parseFilesystems merges `df -Pk` (capacity) with `df -Pi` (inodes) by mount.
func parseFilesystems(dfCap, dfInode string) []Filesystem {
	byMount := map[string]*Filesystem{}
	order := []string{}
	for i, line := range splitNonEmptyLines(dfCap) {
		if i == 0 {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 6 {
			continue
		}
		mount := strings.Join(f[5:], " ")
		fs := &Filesystem{
			Source:  f[0],
			Mount:   mount,
			SizeKb:  atoi64(f[1]),
			UsedKb:  atoi64(f[2]),
			AvailKb: atoi64(f[3]),
			UsePct:  atoiPct(f[4]),
		}
		byMount[mount] = fs
		order = append(order, mount)
	}
	for i, line := range splitNonEmptyLines(dfInode) {
		if i == 0 {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 6 {
			continue
		}
		mount := strings.Join(f[5:], " ")
		if fs, ok := byMount[mount]; ok {
			fs.InodePct = atoiPct(f[4])
		}
	}
	out := make([]Filesystem, 0, len(order))
	for _, m := range order {
		out = append(out, *byMount[m])
	}
	return out
}

func parseFstab(s string) []FstabEntry {
	out := []FstabEntry{}
	for _, line := range splitNonEmptyLines(s) {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		e := FstabEntry{Spec: f[0], Mount: f[1], FSType: f[2]}
		if len(f) >= 4 {
			e.Options = f[3]
		}
		out = append(out, e)
	}
	return out
}

func parseSmart(s string) []SmartStatus {
	out := []SmartStatus{}
	for _, line := range splitNonEmptyLines(s) {
		dev, rest, ok := strings.Cut(line, "|")
		if !ok {
			continue
		}
		health := "unknown"
		low := strings.ToLower(rest)
		switch {
		case strings.Contains(low, "passed") || strings.Contains(low, "ok"):
			health = "PASSED"
		case strings.Contains(low, "failed"):
			health = "FAILED"
		}
		out = append(out, SmartStatus{Device: dev, Health: health})
	}
	return out
}

func atoi64(s string) int64 { n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64); return n }
func atoiPct(s string) int  { n, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimSpace(s), "%")); return n }

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
