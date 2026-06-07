package sysuser

import "testing"

func TestParsePasswd(t *testing.T) {
	in := "root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice,,,:/home/alice:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n"
	u := parsePasswd(in)
	if len(u) != 3 {
		t.Fatalf("want 3, got %d", len(u))
	}
	if u[0].Name != "root" || !u[0].System {
		t.Errorf("root: %+v", u[0])
	}
	if u[1].Name != "alice" || u[1].UID != 1000 || u[1].System || u[1].Shell != "/bin/bash" {
		t.Errorf("alice: %+v", u[1])
	}
}

func TestParseGroup(t *testing.T) {
	in := "sudo:x:27:alice,bob\nwww-data:x:33:\n"
	g := parseGroup(in)
	if len(g) != 2 || g[0].Name != "sudo" || len(g[0].Members) != 2 || g[0].Members[1] != "bob" {
		t.Fatalf("got %+v", g)
	}
	if len(g[1].Members) != 0 {
		t.Errorf("empty members: %+v", g[1])
	}
}

func TestParseLast(t *testing.T) {
	in := "alice pts/0 10.0.0.9 Wed Jun 8 09:00 still logged in\n"
	h := parseLast(in, false)
	if len(h) != 1 || h[0].User != "alice" || h[0].From != "10.0.0.9" || h[0].Failed {
		t.Fatalf("got %+v", h)
	}
	hb := parseLast("bob ssh:notty 1.2.3.4 Wed Jun 8 08:00\n", true)
	if len(hb) != 1 || !hb[0].Failed {
		t.Errorf("failed flag: %+v", hb)
	}
}

func TestValidName(t *testing.T) {
	for _, n := range []string{"root", "www-data", "alice.test", "user_1"} {
		if !validName(n) {
			t.Errorf("want valid: %q", n)
		}
	}
	for _, n := range []string{"", "a b", "x;rm", "$(id)", "a/b"} {
		if validName(n) {
			t.Errorf("want invalid: %q", n)
		}
	}
}
