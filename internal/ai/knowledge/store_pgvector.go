package knowledge

import (
	"context"
	"fmt"
	"sync"

	"github.com/pgvector/pgvector-go"
	"gorm.io/gorm"
)

// pgVectorStore indexes embeddings in the native pgvector `embedding` column and
// runs nearest-neighbour search with the cosine-distance operator (<=>). The
// column is dimension-unspecified, so every query scopes to one knowledge base
// (whose dimension is frozen) and casts the bound parameter to ::vector.
type pgVectorStore struct {
	db        *gorm.DB
	mu        sync.Mutex
	indexedDim map[int]bool // dims we've attempted an HNSW index for
}

// NewPgVectorStore builds the pgvector-backed store. Callers select it only when
// repo.EnsureVectorBackend reported the extension available.
func NewPgVectorStore(db *gorm.DB) VectorStore {
	return &pgVectorStore{db: db, indexedDim: map[int]bool{}}
}

func (s *pgVectorStore) Backend() string { return "pgvector" }

func (s *pgVectorStore) UpsertChunks(ctx context.Context, kbID uint64, dim int, chunks []ChunkVec) error {
	if len(chunks) == 0 {
		return nil
	}
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, c := range chunks {
			if len(c.Vector) == 0 {
				continue
			}
			if e := tx.Exec(
				"UPDATE ai_knowledge_chunks SET embedding = ?::vector WHERE id = ?",
				pgvector.NewVector(c.Vector), c.ChunkID,
			).Error; e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.ensureIndex(ctx, dim)
	return nil
}

func (s *pgVectorStore) Search(ctx context.Context, kbID uint64, query []float32, topK int) ([]Hit, error) {
	if len(query) == 0 {
		return nil, nil
	}
	if topK <= 0 {
		topK = 5
	}
	type row struct {
		ID         uint64
		DocumentID uint64
		Content    string
		Dist       float64
	}
	var rows []row
	err := s.db.WithContext(ctx).Raw(
		`SELECT id, document_id, content, (embedding <=> ?::vector) AS dist
		 FROM ai_knowledge_chunks
		 WHERE knowledge_base_id = ? AND embedding IS NOT NULL
		 ORDER BY embedding <=> ?::vector
		 LIMIT ?`,
		pgvector.NewVector(query), kbID, pgvector.NewVector(query), topK,
	).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	hits := make([]Hit, 0, len(rows))
	for _, r := range rows {
		hits = append(hits, Hit{
			ChunkID:    r.ID,
			DocumentID: r.DocumentID,
			Content:    r.Content,
			Score:      1 - r.Dist, // cosine distance → similarity
		})
	}
	return hits, nil
}

// ensureIndex best-effort builds one HNSW index per dimension. The column is
// dimension-unspecified so the index is on a cast expression; failures (mixed
// dimensions, privilege) are non-fatal — search still works via a sequential
// scan, just slower.
func (s *pgVectorStore) ensureIndex(ctx context.Context, dim int) {
	if dim <= 0 {
		return
	}
	s.mu.Lock()
	if s.indexedDim[dim] {
		s.mu.Unlock()
		return
	}
	s.indexedDim[dim] = true
	s.mu.Unlock()

	name := fmt.Sprintf("ai_kchunk_hnsw_%d", dim)
	stmt := fmt.Sprintf(
		"CREATE INDEX IF NOT EXISTS %s ON ai_knowledge_chunks USING hnsw ((embedding::vector(%d)) vector_cosine_ops)",
		name, dim,
	)
	_ = s.db.WithContext(ctx).Exec(stmt).Error
}
