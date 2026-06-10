package knowledge

import "testing"

func TestKeywordTerms(t *testing.T) {
	t.Run("mixed CJK and ASCII tokens", func(t *testing.T) {
		terms := keywordTerms("nginx 502 错误怎么排查")
		want := map[string]bool{"nginx": false, "502": false}
		for _, term := range terms {
			if _, ok := want[term]; ok {
				want[term] = true
			}
		}
		for k, seen := range want {
			if !seen {
				t.Errorf("expected term %q in %v", k, terms)
			}
		}
	})
	t.Run("dedup and cap", func(t *testing.T) {
		terms := keywordTerms("a1 a1 a2 a3 a4 a5 a6 a7 a8 a9 b1 b2")
		if len(terms) > 8 {
			t.Errorf("terms not capped at 8: %v", terms)
		}
		seen := map[string]bool{}
		for _, term := range terms {
			if seen[term] {
				t.Errorf("duplicate term %q in %v", term, terms)
			}
			seen[term] = true
		}
	})
	t.Run("single-char noise dropped", func(t *testing.T) {
		for _, term := range keywordTerms("a 的 x") {
			if len(term) < 2 {
				t.Errorf("noise term %q survived", term)
			}
		}
	})
}

func TestFuseRRF(t *testing.T) {
	vec := []Hit{
		{ChunkID: 1, Score: 0.92},
		{ChunkID: 2, Score: 0.81},
		{ChunkID: 3, Score: 0.70},
	}
	kw := []Hit{
		{ChunkID: 2}, // also a vector hit → hybrid, should outrank everything
		{ChunkID: 9}, // keyword-only
	}
	out := fuseRRF(vec, kw, 10)
	if len(out) != 4 {
		t.Fatalf("want 4 fused hits, got %d", len(out))
	}
	if out[0].ChunkID != 2 || out[0].Match != MatchHybrid {
		t.Errorf("hybrid hit should rank first, got #%d (%s)", out[0].ChunkID, out[0].Match)
	}
	if out[0].Score != 0.81 {
		t.Errorf("hybrid hit must keep its cosine score, got %v", out[0].Score)
	}
	var kwOnly *Hit
	for i := range out {
		if out[i].ChunkID == 9 {
			kwOnly = &out[i]
		}
	}
	if kwOnly == nil || kwOnly.Match != MatchKeyword {
		t.Errorf("keyword-only hit missing or mislabelled: %+v", kwOnly)
	}
	if kwOnly != nil && kwOnly.Score != 0 {
		t.Errorf("keyword-only hit must carry no cosine score, got %v", kwOnly.Score)
	}

	t.Run("topK truncates", func(t *testing.T) {
		out := fuseRRF(vec, kw, 2)
		if len(out) != 2 {
			t.Fatalf("want 2, got %d", len(out))
		}
	})
	t.Run("vector-only degrade", func(t *testing.T) {
		out := fuseRRF(vec, nil, 5)
		if len(out) != 3 || out[0].ChunkID != 1 || out[0].Match != MatchVector {
			t.Errorf("vector-only order broken: %+v", out)
		}
	})
	t.Run("keyword-only degrade", func(t *testing.T) {
		out := fuseRRF(nil, kw, 5)
		if len(out) != 2 || out[0].ChunkID != 2 || out[0].Match != MatchKeyword {
			t.Errorf("keyword-only order broken: %+v", out)
		}
	})
}
