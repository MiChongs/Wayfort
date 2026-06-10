package knowledge

import (
	"context"
	"encoding/json"
	"sort"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"go.uber.org/zap"
)

// MemoryService recalls and writes cross-session long-term memory for a
// (user, agent) pair. Recall is embedding-based when an embedding provider is
// available, otherwise recency + salience. Embedding is best-effort: a memory is
// always stored even if it can't be embedded (it just falls back to recency).
type MemoryService struct {
	repo    *airepo.KnowledgeRepo
	embed   *provider.EmbeddingResolver
	logger  *zap.Logger
	recallK int
}

func NewMemoryService(repo *airepo.KnowledgeRepo, embed *provider.EmbeddingResolver, recallK int, logger *zap.Logger) *MemoryService {
	if recallK <= 0 {
		recallK = 8
	}
	return &MemoryService{repo: repo, embed: embed, logger: logger, recallK: recallK}
}

// Recall returns the most relevant memories for the (user, agent) pair given the
// current query. It bumps salience/last-used on the returned set (best-effort).
func (m *MemoryService) Recall(ctx context.Context, userID, agentID uint64, query string) ([]aimodel.AgentMemory, error) {
	candidates, err := m.repo.RecallCandidates(ctx, userID, agentID, 50)
	if err != nil || len(candidates) == 0 {
		return nil, err
	}

	picked := candidates
	if qv := m.embedQuery(ctx, query); qv != nil {
		type scored struct {
			mem   aimodel.AgentMemory
			score float64
		}
		ranked := make([]scored, 0, len(candidates))
		for _, c := range candidates {
			var vec []float32
			if c.EmbeddingJSON == "" || json.Unmarshal([]byte(c.EmbeddingJSON), &vec) != nil {
				continue
			}
			ranked = append(ranked, scored{mem: c, score: cosine(qv, vec)})
		}
		if len(ranked) > 0 {
			sort.Slice(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
			picked = picked[:0]
			for _, r := range ranked {
				picked = append(picked, r.mem)
			}
		}
	}
	if len(picked) > m.recallK {
		picked = picked[:m.recallK]
	}

	ids := make([]uint64, 0, len(picked))
	for _, p := range picked {
		ids = append(ids, p.ID)
	}
	go func() { _ = m.repo.BumpSalience(context.Background(), ids) }()
	return picked, nil
}

// Remember stores a new memory, embedding the content best-effort for later
// semantic recall.
func (m *MemoryService) Remember(ctx context.Context, userID, agentID uint64, kind aimodel.MemoryKind, content, convID string) (*aimodel.AgentMemory, error) {
	if !aimodel.ValidMemoryKind(kind) {
		kind = aimodel.MemFact
	}
	row := &aimodel.AgentMemory{
		UserID: userID, AgentID: agentID, Kind: kind,
		Content: content, SourceConvID: convID, Salience: 1,
	}
	if qv := m.embedQuery(ctx, content); qv != nil {
		if b, err := json.Marshal(qv); err == nil {
			row.EmbeddingJSON = string(b)
		}
	}
	if err := m.repo.CreateMemory(ctx, row); err != nil {
		return nil, err
	}
	return row, nil
}

// embedQuery embeds a single string, returning nil on any failure (so callers
// degrade to recency-only behaviour).
func (m *MemoryService) embedQuery(ctx context.Context, text string) []float32 {
	if text == "" {
		return nil
	}
	res, err := m.embed.Resolve(ctx)
	if err != nil {
		return nil
	}
	resp, err := res.Provider.Embed(ctx, provider.EmbedRequest{
		Model: res.Model, Inputs: []string{text}, Dimensions: res.Dimensions,
	})
	if err != nil || len(resp.Vectors) == 0 || len(resp.Vectors[0]) == 0 {
		return nil
	}
	return resp.Vectors[0]
}
