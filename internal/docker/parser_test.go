package docker

import "testing"

func TestParseContainers(t *testing.T) {
	out := `{"Command":"\"/entrypoint.sh\"","CreatedAt":"2024-01-15 10:30:00 +0000 UTC","ID":"abc123","Image":"nginx:latest","Names":"web","Ports":"0.0.0.0:80->80/tcp","State":"running","Status":"Up 5 minutes","Size":"12MB"}
{"Command":"sleep infinity","CreatedAt":"2024-01-15 10:31:00 +0000 UTC","ID":"def456","Image":"alpine:3.19","Names":"sandbox","Ports":"","State":"exited","Status":"Exited (0) 2 hours ago","Size":"5MB"}
`
	got, err := parseContainers(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d", len(got))
	}
	if got[0].ID != "abc123" || got[0].State != "running" || got[0].Image != "nginx:latest" {
		t.Errorf("first: %+v", got[0])
	}
	if got[1].State != "exited" {
		t.Errorf("second state: %q", got[1].State)
	}
}

func TestParseImages(t *testing.T) {
	out := `{"Repository":"nginx","Tag":"latest","ID":"sha256:abc","Size":"187MB","CreatedAt":"2024-01-10"}
{"Repository":"alpine","Tag":"3.19","ID":"sha256:def","Size":"7MB","CreatedAt":"2024-01-09"}
`
	got, err := parseImages(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d", len(got))
	}
	if got[0].Repository != "nginx" || got[0].Tag != "latest" {
		t.Errorf("first: %+v", got[0])
	}
}

func TestParseVersion(t *testing.T) {
	t.Run("server-up", func(t *testing.T) {
		v := `{"Client":{"Version":"24.0.7","ApiVersion":"1.43","Os":"linux"},"Server":{"Version":"24.0.7","ApiVersion":"1.43","Os":"linux"}}`
		s := parseVersion(v)
		if !s.Available {
			t.Error("expected available")
		}
		if s.Version != "24.0.7" {
			t.Errorf("version = %q", s.Version)
		}
	})
	t.Run("client-only", func(t *testing.T) {
		v := `{"Client":{"Version":"24.0.7","ApiVersion":"1.43","Os":"linux"}}`
		s := parseVersion(v)
		if s.Available {
			t.Error("expected unavailable when only Client present")
		}
		if s.Reason == "" {
			t.Error("expected reason for daemon unreachable")
		}
	})
	t.Run("empty", func(t *testing.T) {
		s := parseVersion("")
		if s.Available {
			t.Error("expected unavailable")
		}
	})
}

func TestSafeContainerID(t *testing.T) {
	good := []string{
		"abc123", "deadbeef0001", "web-1", "my.app_v2",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	for _, s := range good {
		if !safeContainerID(s) {
			t.Errorf("good rejected: %q", s)
		}
	}
	bad := []string{
		"", "; rm -rf /", "id$(whoami)", "id `id`", "id|cat", "id\nrm",
		"-flag", ".start",
	}
	for _, s := range bad {
		if safeContainerID(s) {
			t.Errorf("bad accepted: %q", s)
		}
	}
}
