// Package knowledge implements the vector knowledge base (RAG) and long-term
// memory for the AI assistant: document ingestion (extract → chunk → embed →
// store), semantic retrieval, and embedding-based memory recall. It deliberately
// does NOT import internal/ai/runner (the runner imports this package for the
// memory service), so the token counter is injected as a func.
package knowledge

import (
	"context"
	"math"
)

// ChunkVec carries one chunk id and its embedding for the vector store to index.
type ChunkVec struct {
	ChunkID uint64
	Vector  []float32
}

// Match labels which retrieval path(s) produced a hit.
const (
	MatchVector  = "vector"  // semantic similarity only
	MatchKeyword = "keyword" // substring term match only
	MatchHybrid  = "hybrid"  // found by both paths
)

// Hit is one retrieval result. Score keeps the cosine similarity for display
// (0 for keyword-only hits); ranking across paths/KBs uses the unexported RRF
// score set by fuseRRF.
type Hit struct {
	ChunkID    uint64  `json:"chunk_id"`
	DocumentID uint64  `json:"document_id"`
	Content    string  `json:"content"`
	Score      float64 `json:"score"` // cosine similarity in [-1,1]; higher is closer
	Match      string  `json:"match,omitempty"`

	fused float64 // reciprocal-rank-fusion score; comparable across paths and KBs
}

// VectorStore persists and searches chunk embeddings. Two backends exist:
// pgvector (native index) and an application-layer cosine fallback. Chunk rows
// (content, token count, EmbeddingJSON) are written by the repo; the store only
// owns the native vector column + nearest-neighbour query.
type VectorStore interface {
	// Backend reports "pgvector" or "fallback" — frozen onto the KB at creation.
	Backend() string
	// UpsertChunks writes the native vector for each chunk (no-op for fallback,
	// which reads EmbeddingJSON at query time). dim is the KB's frozen dimension.
	UpsertChunks(ctx context.Context, kbID uint64, dim int, chunks []ChunkVec) error
	// Search returns the top-k chunks in the KB nearest to query.
	Search(ctx context.Context, kbID uint64, query []float32, topK int) ([]Hit, error)
}

// cosine computes cosine similarity between two equal-length vectors. Returns 0
// for mismatched / zero-magnitude inputs.
func cosine(a, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
