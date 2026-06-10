package knowledge

import (
	"context"
	"regexp"
	"sort"
	"strings"
)

// Hybrid retrieval: vector similarity fused with keyword (substring) matching
// via Reciprocal Rank Fusion. Keyword matching is what catches exact tokens
// embeddings blur — error codes, command names, IPs, file paths — and it keeps
// retrieval alive (degraded) when no embedding provider is reachable.

// asciiToken pulls command/path/error-code-like tokens out of mixed CJK+ASCII
// queries ("nginx 502 错误怎么排查" → nginx, 502).
var asciiToken = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9_.\-/]{1,63}`)

// keywordTerms derives the keyword candidates from a natural-language query:
// whitespace-separated words plus embedded ASCII tokens, deduplicated,
// lowercased, capped at 8.
func keywordTerms(query string) []string {
	seen := map[string]bool{}
	var terms []string
	add := func(t string) {
		t = strings.ToLower(strings.TrimSpace(t))
		// Single CJK chars / one-letter words are noise.
		if len(t) < 2 || seen[t] {
			return
		}
		seen[t] = true
		terms = append(terms, t)
	}
	for _, f := range strings.Fields(query) {
		add(f)
	}
	for _, m := range asciiToken.FindAllString(query, 8) {
		add(m)
	}
	if len(terms) > 8 {
		terms = terms[:8]
	}
	return terms
}

// keywordSearch ranks the KB's substring-matching chunks by how many distinct
// terms they contain (then by shorter content as a weak tiebreaker, since a
// dense short chunk is likelier to be on-topic than a sprawling one).
func (s *Service) keywordSearch(ctx context.Context, kbID uint64, query string, k int) ([]Hit, error) {
	terms := keywordTerms(query)
	if len(terms) == 0 {
		return nil, nil
	}
	rows, err := s.repo.KeywordSearchChunks(ctx, kbID, terms, k*4)
	if err != nil {
		return nil, err
	}
	type scored struct {
		hit  Hit
		hits int
	}
	ranked := make([]scored, 0, len(rows))
	for _, r := range rows {
		lc := strings.ToLower(r.Content)
		n := 0
		for _, t := range terms {
			if strings.Contains(lc, t) {
				n++
			}
		}
		if n == 0 {
			continue
		}
		ranked = append(ranked, scored{
			hit:  Hit{ChunkID: r.ID, DocumentID: r.DocumentID, Content: r.Content, Match: MatchKeyword},
			hits: n,
		})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].hits != ranked[j].hits {
			return ranked[i].hits > ranked[j].hits
		}
		return len(ranked[i].hit.Content) < len(ranked[j].hit.Content)
	})
	if len(ranked) > k {
		ranked = ranked[:k]
	}
	out := make([]Hit, 0, len(ranked))
	for _, r := range ranked {
		out = append(out, r.hit)
	}
	return out, nil
}

// fuseRRF merges the two ranked lists with Reciprocal Rank Fusion
// (score = Σ 1/(60+rank)) and returns the global top-k. Cosine similarity is
// preserved on Hit.Score for display; ordering and cross-KB comparison use the
// fused rank score (Hit.fused).
func fuseRRF(vec, kw []Hit, topK int) []Hit {
	const c = 60.0
	merged := map[uint64]*Hit{}
	order := make([]uint64, 0, len(vec)+len(kw))
	for i := range vec {
		h := vec[i]
		h.fused = 1.0 / (c + float64(i+1))
		h.Match = MatchVector
		merged[h.ChunkID] = &h
		order = append(order, h.ChunkID)
	}
	for i, h := range kw {
		if e, ok := merged[h.ChunkID]; ok {
			e.fused += 1.0 / (c + float64(i+1))
			e.Match = MatchHybrid
			continue
		}
		hh := h
		hh.fused = 1.0 / (c + float64(i+1))
		hh.Match = MatchKeyword
		merged[hh.ChunkID] = &hh
		order = append(order, hh.ChunkID)
	}
	out := make([]Hit, 0, len(order))
	for _, id := range order {
		out = append(out, *merged[id])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].fused > out[j].fused })
	if topK > 0 && len(out) > topK {
		out = out[:topK]
	}
	return out
}
