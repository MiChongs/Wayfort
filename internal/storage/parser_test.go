package storage

import "testing"

func TestParseLsblk(t *testing.T) {
	in := `{"blockdevices":[{"name":"sda","type":"disk","size":"50G","fstype":null,"mountpoint":null,"model":"Virtual Disk","children":[{"name":"sda1","type":"part","size":"50G","fstype":"ext4","mountpoint":"/","model":null}]}]}`
	d := parseLsblk(in)
	if len(d) != 1 || d[0].Name != "sda" || d[0].Model != "Virtual Disk" {
		t.Fatalf("disk: %+v", d)
	}
	if len(d[0].Children) != 1 || d[0].Children[0].Name != "sda1" || d[0].Children[0].MountPoint != "/" || d[0].Children[0].FSType != "ext4" {
		t.Errorf("part: %+v", d[0].Children)
	}
}

func TestParseFilesystems(t *testing.T) {
	cap := "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 20480000 12000000 8480000 60% /\n"
	ino := "Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 1310720 250000 1060720 20% /\n"
	fs := parseFilesystems(cap, ino)
	if len(fs) != 1 {
		t.Fatalf("want 1, got %d", len(fs))
	}
	if fs[0].Mount != "/" || fs[0].UsePct != 60 || fs[0].SizeKb != 20480000 || fs[0].InodePct != 20 {
		t.Errorf("fs: %+v", fs[0])
	}
}

func TestParseFstab(t *testing.T) {
	in := "UUID=abc / ext4 defaults 0 1\n/dev/sdb1 /data xfs noatime 0 2\n"
	e := parseFstab(in)
	if len(e) != 2 || e[0].Mount != "/" || e[0].FSType != "ext4" || e[1].Spec != "/dev/sdb1" || e[1].Options != "noatime" {
		t.Fatalf("got %+v", e)
	}
}

func TestParseSmart(t *testing.T) {
	in := "sda|SMART overall-health self-assessment test result: PASSED\nsdb|SMART overall-health self-assessment test result: FAILED!\nsdc|\n"
	s := parseSmart(in)
	if len(s) != 3 || s[0].Health != "PASSED" || s[1].Health != "FAILED" || s[2].Health != "unknown" {
		t.Fatalf("got %+v", s)
	}
}

func TestValidMount(t *testing.T) {
	if !validMount("/data") || !validMount("/mnt/backup") {
		t.Error("want valid")
	}
	for _, p := range []string{"", "/", "data", "/data/../etc", "/data;rm", "/d ata"} {
		if validMount(p) {
			t.Errorf("want invalid: %q", p)
		}
	}
}
