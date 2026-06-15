package anomaly

import (
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/geoip"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

func TestHaversineKm(t *testing.T) {
	// Beijing → London is ~8130 km.
	d := haversineKm(39.9042, 116.4074, 51.5074, -0.1278)
	if d < 8000 || d > 8300 {
		t.Fatalf("Beijing→London = %.0f km, expected ~8130", d)
	}
	if d := haversineKm(0, 0, 0, 0); d != 0 {
		t.Fatalf("same point = %.4f, want 0", d)
	}
}

func TestImpossibleTravel(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	london := geoip.Location{Latitude: 51.5074, Longitude: -0.1278}

	// Beijing 1h ago → London now: ~8130 km/h ≫ 900 → impossible.
	hist1h := []model.LoginHistory{{GeoLat: 39.9042, GeoLon: 116.4074, CreatedAt: now.Add(-1 * time.Hour)}}
	if !impossibleTravel(hist1h, london, now, 900) {
		t.Fatal("expected impossible travel for 8130km in 1h")
	}

	// Beijing 12h ago → London now: ~677 km/h < 900 → plausible.
	hist12h := []model.LoginHistory{{GeoLat: 39.9042, GeoLon: 116.4074, CreatedAt: now.Add(-12 * time.Hour)}}
	if impossibleTravel(hist12h, london, now, 900) {
		t.Fatal("did not expect impossible travel for 8130km in 12h")
	}

	// Nearby points (<200km) are ignored regardless of time.
	near := geoip.Location{Latitude: 51.6, Longitude: -0.2}
	if impossibleTravel(hist1h[:0], near, now, 900) {
		t.Fatal("empty history should not flag")
	}
	histNear := []model.LoginHistory{{GeoLat: 51.5074, GeoLon: -0.1278, CreatedAt: now.Add(-1 * time.Minute)}}
	if impossibleTravel(histNear, near, now, 900) {
		t.Fatal("nearby hop should not be impossible")
	}

	// No coordinates on the current location → never flagged.
	if impossibleTravel(hist1h, geoip.Location{}, now, 900) {
		t.Fatal("no current coords should not flag")
	}
}

func TestCountryKnown(t *testing.T) {
	// No prior geo → treated as known (avoid false positive on first geo login).
	if !countryKnown([]model.LoginHistory{{IP: "1.1.1.1"}}, "US") {
		t.Fatal("no prior geo should count as known")
	}
	hist := []model.LoginHistory{{GeoCountryISO: "CN"}, {GeoCountryISO: "CN"}}
	if !countryKnown(hist, "CN") {
		t.Fatal("CN should be known")
	}
	if countryKnown(hist, "US") {
		t.Fatal("US should be new")
	}
}

func TestASNKnown(t *testing.T) {
	if !asnKnown([]model.LoginHistory{{IP: "x"}}, 4134) {
		t.Fatal("no prior asn should count as known")
	}
	hist := []model.LoginHistory{{ASN: 4134}}
	if !asnKnown(hist, 4134) {
		t.Fatal("4134 should be known")
	}
	if asnKnown(hist, 9999) {
		t.Fatal("9999 should be new")
	}
}

func TestUAFamilyKnown(t *testing.T) {
	chrome := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
	hist := []model.LoginHistory{{UserAgent: chrome}}
	// Same family, different minor version → known.
	chrome2 := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
	if !uaFamilyKnown(hist, chrome2) {
		t.Fatal("same chrome family should be known")
	}
	// Empty UA is treated as known (don't penalise missing header).
	if !uaFamilyKnown(hist, "") {
		t.Fatal("empty UA should be known")
	}
	curl := "curl/8.0.1"
	if uaFamilyKnown(hist, curl) {
		t.Fatal("curl should be a new family vs chrome")
	}
}

func TestFormatLocation(t *testing.T) {
	if got := FormatLocation(geoip.Location{Private: true}); got != "内网" {
		t.Fatalf("private = %q", got)
	}
	if got := FormatLocation(geoip.Location{}); got != "未知位置" {
		t.Fatalf("empty = %q", got)
	}
	loc := geoip.Location{Country: "中国", Region: "北京", City: "北京", ASNOrg: "ChinaNet"}
	if got := FormatLocation(loc); got != "中国 北京 北京 · ChinaNet" {
		t.Fatalf("full = %q", got)
	}
}

func TestSignalReasonsCSV(t *testing.T) {
	s := Signal{Reasons: []string{ReasonNewIP, ReasonNewCountry}}
	if got := s.ReasonsCSV(); got != "new_ip,new_country" {
		t.Fatalf("csv = %q", got)
	}
	if got := (Signal{}).ReasonsCSV(); got != "" {
		t.Fatalf("empty csv = %q", got)
	}
}
