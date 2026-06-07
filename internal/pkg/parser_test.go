package pkg

import "testing"

func TestDetectManager(t *testing.T) {
	if detectManager("apt-get\n") != KindApt {
		t.Error("apt")
	}
	if detectManager("dnf\nyum\n") != KindDnf {
		t.Error("dnf priority")
	}
	if detectManager("apk\n") != KindApk {
		t.Error("apk")
	}
	if detectManager("") != KindNone {
		t.Error("none")
	}
}

func TestParseUpgradableApt(t *testing.T) {
	in := "nginx/focal-updates 1.18.0-2 amd64 [upgradable from: 1.18.0-1]\n" +
		"openssl/focal-security 1.1.1f-1ubuntu2.16 amd64 [upgradable from: 1.1.1f-1ubuntu2.15]\n"
	ups := parseUpgradable(KindApt, in)
	if len(ups) != 2 {
		t.Fatalf("want 2, got %d", len(ups))
	}
	if ups[0].Name != "nginx" || ups[0].Candidate != "1.18.0-2" || ups[0].Current != "1.18.0-1" {
		t.Errorf("nginx: %+v", ups[0])
	}
	if !ups[1].Security {
		t.Errorf("openssl should be security: %+v", ups[1])
	}
}

func TestActionCommand(t *testing.T) {
	c, err := actionCommand(KindApt, VerbInstall, "nginx")
	if err != nil || c != "DEBIAN_FRONTEND=noninteractive apt-get -y install 'nginx' 2>&1" {
		t.Errorf("apt install: %q err=%v", c, err)
	}
	c, _ = actionCommand(KindApk, VerbRemove, "curl")
	if c != "apk del 'curl' 2>&1" {
		t.Errorf("apk del: %q", c)
	}
	c, _ = actionCommand(KindDnf, VerbUpgradeAll, "")
	if c != "dnf -y upgrade 2>&1" {
		t.Errorf("dnf upgrade-all: %q", c)
	}
	if _, err := actionCommand(KindApt, VerbInstall, "bad;rm"); err == nil {
		t.Error("bad name should error")
	}
}

func TestValidName(t *testing.T) {
	for _, n := range []string{"nginx", "lib32z1", "python3.9", "g++", "foo:i386"} {
		if !validName(n) {
			t.Errorf("want valid: %q", n)
		}
	}
	for _, n := range []string{"", "a b", "x;rm", "$(id)"} {
		if validName(n) {
			t.Errorf("want invalid: %q", n)
		}
	}
}

func TestParseSearchApt(t *testing.T) {
	in := "nginx - small, powerful, scalable web/proxy server\nnginx-common - small, powerful, scalable web/proxy server - common files\n"
	res := parseSearch(KindApt, in)
	if len(res) != 2 || res[0].Name != "nginx" || res[0].Summary == "" {
		t.Fatalf("got %+v", res)
	}
}
