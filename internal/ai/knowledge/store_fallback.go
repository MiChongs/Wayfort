package knowledge

import (
	"context"
	"encoding/json"
	"sort"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// fallbackStore is used when pgvector is unavailable. It stores nothing extra
// (the chunk row's EmbeddingJSON is the source of truth) and computes cosine
// similarity in Go over the KB's chunks, capped at maxChunks to bound memory.
type fallbackStore struct {
	db        *gorm.DB
	maxChunks int
	logger    *zap.Logger
}

// NewFallbackStore builds the application-layer cosine store. maxChunks ≤ 0
// defaults to 5000.
func NewFallbackStore(db *gorm.DB, maxChunks int, logger *zap.Logger) VectorStore {
	if maxChunks <= 0 {
		maxChunks = 5000
	}
	return &fallbackStore{db: db, maxChunks: maxChunks, logger: logger}
}

func (s *fallbackStore) Backend() string { return "fallback" }

// UpsertChunks is a no-op: the embedding already lives in the chunk row's
// EmbeddingJSON written by the repo.
func (s *fallbackStore) UpsertChunks(ctx context.Context, kbID uint64, dim int, chunks []ChunkVec) error {
	return nil
}

func (s *fallbackStore) Search(ctx context.Context, kbID uint64, query []float32, topK int) ([]Hit, error) {
	if len(query) == 0 {
		return nil, nil
	}
	if topK <= 0 {
		topK = 5
	}
	type chunkRow struct {
		ID            uint64
		DocumentID    uint64
		Content       string
		EmbeddingJSON string
	}
	var rows []chunkRow
	q := s.db.WithContext(ctx).
		Table("ai_knowledge_chunks").
		Select("id, document_id, content, embedding_json").
		Where("knowledge_base_id = ? AND embedding_json <> ''", kbID).
		Limit(s.maxChunks)
	if err := q.Scan(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == s.maxChunks && s.logger != nil {
		s.logger.Warn("knowledge fallback search hit chunk cap; results may be incomplete",
			zap.Uint64("knowledge_base_id", kbID), zap.Int("cap", s.maxChunks))
	}
	hits := make([]Hit, 0, len(rows))
	for _, r := range rows {
		var vec []float32
		if json.Unmarshal([]byte(r.EmbeddingJSON), &vec) != nil || len(vec) == 0 {
			continue
		}
		hits = append(hits, Hit{
			ChunkID:    r.ID,
			DocumentID: r.DocumentID,
			Content:    r.Content,
			Score:      cosine(query, vec),
		})
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > topK {
		hits = hits[:topK]
	}
	return hits, nil
}
