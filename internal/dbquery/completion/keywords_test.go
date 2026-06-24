package completion

import "testing"

func TestKeywordsMySQL(t *testing.T) {
	kw := Keywords("mysql")
	if len(kw) < 20 {
		t.Fatalf("expected ≥20 mysql keywords, got %d", len(kw))
	}
	want := map[string]bool{"SELECT": true, "FROM": true, "JOIN": true, "WHERE": true, "GROUP": true}
	got := map[string]bool{}
	for _, k := range kw {
		got[k] = true
	}
	for k := range want {
		if !got[k] {
			t.Fatalf("missing keyword %q", k)
		}
	}
}

func TestKeywordsPostgres(t *testing.T) {
	kw := Keywords("postgresql")
	if len(kw) < 20 {
		t.Fatal("expected ≥20 postgresql keywords")
	}
}

func TestKeywordsUnknownFamily(t *testing.T) {
	if kw := Keywords("nonsense"); len(kw) != 0 {
		t.Fatalf("unknown family must return empty, got %v", kw)
	}
}
