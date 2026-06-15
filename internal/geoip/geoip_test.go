package geoip

import (
	"bytes"
	"compress/gzip"
	"context"
	"strings"
	"testing"
	"time"
)

func TestSSRFGuardBlocksPrivate(t *testing.T) {
	s := New(Config{Enabled: true}, nil)
	// Default (AllowPrivateURL=false): downloading from a loopback address is
	// refused at the dialer Control hook before any connection is made.
	_, err := s.fetchDatabase(context.Background(), "http://127.0.0.1:9/db.mmdb", 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "non-public") {
		t.Fatalf("expected SSRF refusal for loopback, got %v", err)
	}
	// Link-local cloud-metadata address is also refused.
	if _, err := s.fetchDatabase(context.Background(), "http://169.254.169.254/latest/meta-data", 2*time.Second); err == nil || !strings.Contains(err.Error(), "non-public") {
		t.Fatalf("expected SSRF refusal for 169.254.169.254, got %v", err)
	}
}

func TestSSRFGuardOptOut(t *testing.T) {
	// With AllowPrivateURL set, the guard is relaxed — the request is allowed to
	// proceed to dial (and then fails with a connection error, NOT the SSRF
	// refusal), proving the guard was bypassed for the internal-mirror use case.
	s := New(Config{Enabled: true, AllowPrivateURL: true}, nil)
	_, err := s.fetchDatabase(context.Background(), "http://127.0.0.1:9/db.mmdb", 2*time.Second)
	if err == nil {
		t.Fatal("expected a connection error dialing 127.0.0.1:9")
	}
	if strings.Contains(err.Error(), "non-public") {
		t.Fatalf("guard should have been bypassed, got SSRF refusal: %v", err)
	}
}

func TestTemplateURL(t *testing.T) {
	now := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	got := templateURL("https://x/dbip-city-lite-{year}-{month}.mmdb.gz", now)
	want := "https://x/dbip-city-lite-2026-06.mmdb.gz"
	if got != want {
		t.Fatalf("templateURL = %q, want %q", got, want)
	}
	// Untemplated URLs pass through unchanged.
	if got := templateURL("https://x/db.mmdb", now); got != "https://x/db.mmdb" {
		t.Fatalf("passthrough = %q", got)
	}
	// {DD} variant.
	if got := templateURL("a/{YYYY}{MM}{DD}", now); got != "a/20260615" {
		t.Fatalf("DD variant = %q", got)
	}
}

func TestLookupDegraded(t *testing.T) {
	// No database loaded → Lookup never panics, marks private addresses, returns
	// the IP for public ones with no geo.
	s := New(Config{Enabled: true, DBPath: "/nonexistent/none.mmdb"}, nil)

	priv := s.Lookup("10.0.0.5")
	if !priv.Private || priv.HasGeo() {
		t.Fatalf("private IP: got %+v", priv)
	}
	loop := s.Lookup("127.0.0.1")
	if !loop.Private {
		t.Fatalf("loopback not flagged private: %+v", loop)
	}
	pub := s.Lookup("8.8.8.8")
	if pub.Private || pub.HasGeo() {
		t.Fatalf("public IP without db should have no geo: %+v", pub)
	}
	if pub.IP != "8.8.8.8" {
		t.Fatalf("IP not echoed: %+v", pub)
	}
	bad := s.Lookup("not-an-ip")
	if bad.HasGeo() || bad.Private {
		t.Fatalf("unparseable IP: %+v", bad)
	}
}

func TestNilServiceSafe(t *testing.T) {
	var s *Service
	if s.Enabled() {
		t.Fatal("nil service should be disabled")
	}
	loc := s.Lookup("8.8.8.8")
	if loc.IP != "8.8.8.8" || loc.HasGeo() {
		t.Fatalf("nil Lookup = %+v", loc)
	}
	s.Close() // must not panic
}

func TestDecompressGzip(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	payload := []byte("fake-mmdb-bytes")
	_, _ = zw.Write(payload)
	_ = zw.Close()

	out, err := decompress("https://x/db.mmdb.gz", buf.Bytes())
	if err != nil {
		t.Fatalf("decompress gz: %v", err)
	}
	if !bytes.Equal(out, payload) {
		t.Fatalf("gunzip mismatch: %q", out)
	}

	// A plain .mmdb is returned untouched.
	raw := []byte("raw")
	if out, _ := decompress("https://x/db.mmdb", raw); !bytes.Equal(out, raw) {
		t.Fatalf("passthrough mismatch: %q", out)
	}
}

func TestPickName(t *testing.T) {
	names := map[string]string{"en": "China", "zh-CN": "中国"}
	if got := pickName(names, "zh-CN"); got != "中国" {
		t.Fatalf("preferred lang = %q", got)
	}
	if got := pickName(names, "fr"); got != "中国" { // falls back to zh-CN then en
		t.Fatalf("fallback = %q", got)
	}
	if got := pickName(map[string]string{"en": "X"}, "zh-CN"); got != "X" {
		t.Fatalf("en fallback = %q", got)
	}
	if got := pickName(nil, "en"); got != "" {
		t.Fatalf("empty = %q", got)
	}
}
