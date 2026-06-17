package knowledge

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
	"github.com/michongs/wayfort/internal/ai/provider"
	"github.com/michongs/wayfort/internal/ai/ratelimit"
	airepo "github.com/michongs/wayfort/internal/ai/repo"
	"go.uber.org/zap"
)

// Config tunes chunking, batching, and retrieval.
type Config struct {
	ChunkTokens    int
	ChunkOverlap   int
	EmbedBatchSize int
	TopK           int
}

// Service owns the ingestion pipeline (extract → chunk → embed → store) and
// semantic search. It is constructed in ai.New with a runner-backed token
// counter injected to avoid an import cycle.
type Service struct {
	repo    *airepo.KnowledgeRepo
	store   VectorStore
	embed   *provider.EmbeddingResolver
	limiter *ratelimit.Limiter
	count   TokenCounter
	logger  *zap.Logger
	cfg     Config
}

func NewService(repo *airepo.KnowledgeRepo, store VectorStore, embed *provider.EmbeddingResolver,
	limiter *ratelimit.Limiter, count TokenCounter, cfg Config, logger *zap.Logger) *Service {
	if cfg.ChunkTokens <= 0 {
		cfg.ChunkTokens = 512
	}
	if cfg.EmbedBatchSize <= 0 {
		cfg.EmbedBatchSize = 64
	}
	if cfg.TopK <= 0 {
		cfg.TopK = 5
	}
	return &Service{repo: repo, store: store, embed: embed, limiter: limiter, count: count, cfg: cfg, logger: logger}
}

// Backend reports the active vector backend ("pgvector" | "fallback") so a new
// knowledge base can record which path indexes it.
func (s *Service) Backend() string { return s.store.Backend() }

// EmbeddingModel resolves the model that will embed for a new knowledge base, so
// the handler can freeze it on the row at creation time.
func (s *Service) EmbeddingModel(ctx context.Context) (string, error) {
	r, err := s.embed.Resolve(ctx)
	if err != nil {
		return "", err
	}
	return r.Model, nil
}

// IngestDocument runs the full pipeline for one already-created document row. It
// is safe to call in a background goroutine; it updates the document status as it
// progresses and never panics out.
func (s *Service) IngestDocument(ctx context.Context, docID uint64) error {
	doc, err := s.repo.GetDoc(ctx, docID)
	if err != nil || doc == nil {
		return fmt.Errorf("ingest: load doc %d: %w", docID, err)
	}
	kb, err := s.repo.GetKB(ctx, doc.KnowledgeBaseID)
	if err != nil || kb == nil {
		_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocFailed, "knowledge base missing", -1)
		return fmt.Errorf("ingest: load kb: %w", err)
	}

	_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocChunking, "", -1)
	pieces := Chunk(doc.ExtractedText, s.cfg.ChunkTokens, s.cfg.ChunkOverlap, s.count)
	if len(pieces) == 0 {
		_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocFailed, "no extractable text", 0)
		return fmt.Errorf("ingest: no chunks")
	}

	res, err := s.embed.Resolve(ctx)
	if err != nil {
		_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocFailed, "no embedding provider: "+err.Error(), -1)
		return err
	}
	// Honour the KB's frozen model so dimensions stay consistent across re-ingest.
	model := kb.EmbeddingModel
	if model == "" {
		model = res.Model
	}

	_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocEmbedding, "", -1)
	vectors := make([][]float32, 0, len(pieces))
	dim := kb.EmbeddingDim
	for start := 0; start < len(pieces); start += s.cfg.EmbedBatchSize {
		end := start + s.cfg.EmbedBatchSize
		if end > len(pieces) {
			end = len(pieces)
		}
		batch := pieces[start:end]
		s.rateLimit(res.ProviderID, batch)
		resp, err := res.Provider.Embed(ctx, provider.EmbedRequest{
			Model: model, Inputs: batch, Dimensions: res.Dimensions,
		})
		if err != nil {
			_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocFailed, "embed: "+err.Error(), -1)
			return err
		}
		if s.limiter != nil && res.ProviderID != 0 {
			s.limiter.Commit(res.ProviderID, 0, int(resp.InputTokens))
		}
		if dim == 0 {
			dim = resp.Dimension
		}
		vectors = append(vectors, resp.Vectors...)
	}
	if len(vectors) != len(pieces) {
		_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocFailed, "embedding count mismatch", -1)
		return fmt.Errorf("ingest: got %d vectors for %d chunks", len(vectors), len(pieces))
	}

	rows := make([]aimodel.KnowledgeChunk, 0, len(pieces))
	for i, piece := range pieces {
		ej, _ := json.Marshal(vectors[i])
		rows = append(rows, aimodel.KnowledgeChunk{
			KnowledgeBaseID: kb.ID,
			DocumentID:      docID,
			Ordinal:         i,
			Content:         piece,
			TokenCount:      s.count(piece),
			EmbeddingJSON:   string(ej),
			CreatedAt:       time.Now(),
		})
	}
	saved, err := s.repo.ReplaceDocChunks(ctx, docID, rows)
	if err != nil {
		_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocFailed, "store chunks: "+err.Error(), -1)
		return err
	}

	cvs := make([]ChunkVec, 0, len(saved))
	for i := range saved {
		cvs = append(cvs, ChunkVec{ChunkID: saved[i].ID, Vector: vectors[i]})
	}
	if err := s.store.UpsertChunks(ctx, kb.ID, dim, cvs); err != nil {
		_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocFailed, "index: "+err.Error(), len(saved))
		return err
	}

	// Freeze the dimension on first successful ingest.
	if kb.EmbeddingDim == 0 && dim > 0 {
		_ = s.repo.UpdateKB(ctx, kb.ID, map[string]any{"embedding_dim": dim, "embedding_model": model})
	}
	_ = s.repo.UpdateDocStatus(ctx, docID, aimodel.DocReady, "", len(saved))
	_ = s.repo.RecountKB(ctx, kb.ID)
	return nil
}

// Search runs hybrid retrieval over one KB: vector similarity fused with
// keyword matching (RRF). Either path may fail independently — keyword keeps
// retrieval alive when no embedding provider is reachable, vector keeps it
// alive when the query has no usable terms. Both failing is an error.
func (s *Service) Search(ctx context.Context, kbID uint64, query string, topK int) ([]Hit, error) {
	if topK <= 0 {
		topK = s.cfg.TopK
	}
	kb, err := s.repo.GetKB(ctx, kbID)
	if err != nil || kb == nil {
		return nil, fmt.Errorf("knowledge base %d not found", kbID)
	}
	fetch := topK * 2
	if fetch < 10 {
		fetch = 10
	}
	vecHits, vecErr := s.vectorSearch(ctx, kb, query, fetch)
	kwHits, kwErr := s.keywordSearch(ctx, kbID, query, fetch)
	if vecErr != nil && kwErr != nil {
		return nil, vecErr
	}
	if vecErr != nil && s.logger != nil {
		s.logger.Warn("knowledge vector search unavailable; keyword-only results",
			zap.Uint64("knowledge_base_id", kbID), zap.Error(vecErr))
	}
	return fuseRRF(vecHits, kwHits, topK), nil
}

// vectorSearch embeds the query and returns the top-k nearest chunks.
func (s *Service) vectorSearch(ctx context.Context, kb *aimodel.KnowledgeBase, query string, topK int) ([]Hit, error) {
	res, err := s.embed.Resolve(ctx)
	if err != nil {
		return nil, err
	}
	model := kb.EmbeddingModel
	if model == "" {
		model = res.Model
	}
	s.rateLimit(res.ProviderID, []string{query})
	resp, err := res.Provider.Embed(ctx, provider.EmbedRequest{
		Model: model, Inputs: []string{query}, Dimensions: res.Dimensions,
	})
	if err != nil {
		return nil, err
	}
	if len(resp.Vectors) == 0 || len(resp.Vectors[0]) == 0 {
		return nil, fmt.Errorf("query embedding empty")
	}
	if s.limiter != nil && res.ProviderID != 0 {
		s.limiter.Commit(res.ProviderID, 0, int(resp.InputTokens))
	}
	return s.store.Search(ctx, kb.ID, resp.Vectors[0], topK)
}

// EnrichedHit is a search hit annotated with its source document title and
// knowledge-base name for display.
type EnrichedHit struct {
	ChunkID       uint64  `json:"chunk_id"`
	DocumentID    uint64  `json:"document_id"`
	DocumentTitle string  `json:"document"`
	KnowledgeBase string  `json:"knowledge_base"`
	Content       string  `json:"text"`
	Score         float64 `json:"score"`
	Match         string  `json:"match,omitempty"` // vector | keyword | hybrid

	fused float64 // RRF rank score; comparable across KBs (unlike raw cosine)
}

// SearchAcross runs Search over each allowed knowledge base, merges the hits,
// and returns the global top-k enriched with document + KB names.
func (s *Service) SearchAcross(ctx context.Context, kbIDs []uint64, query string, topK int) ([]EnrichedHit, error) {
	if topK <= 0 {
		topK = s.cfg.TopK
	}
	docTitle := map[uint64]string{}
	var all []EnrichedHit
	for _, kbID := range kbIDs {
		kb, err := s.repo.GetKB(ctx, kbID)
		if err != nil || kb == nil {
			continue
		}
		hits, err := s.Search(ctx, kbID, query, topK)
		if err != nil {
			return nil, err
		}
		for _, h := range hits {
			title, ok := docTitle[h.DocumentID]
			if !ok {
				if d, _ := s.repo.GetDoc(ctx, h.DocumentID); d != nil {
					title = d.Title
				}
				docTitle[h.DocumentID] = title
			}
			all = append(all, EnrichedHit{
				ChunkID: h.ChunkID, DocumentID: h.DocumentID,
				DocumentTitle: title, KnowledgeBase: kb.Name,
				Content: h.Content, Score: h.Score,
				Match: h.Match, fused: h.fused,
			})
		}
	}
	sortHits(all)
	if len(all) > topK {
		all = all[:topK]
	}
	return all, nil
}

// IngestText creates a document from in-memory text (extraction already done)
// and ingests it. Used by both the upload handler and ops-knowledge distillation.
func (s *Service) IngestText(ctx context.Context, kbID, userID uint64, title, source, mime, text string, sha string) (uint64, error) {
	doc := &aimodel.KnowledgeDocument{
		KnowledgeBaseID: kbID, Title: title, Source: source, MIME: mime,
		SHA256: sha, Status: aimodel.DocPending, ExtractedText: text,
		ByteSize: int64(len(text)), CreatedBy: userID,
	}
	if err := s.repo.CreateDoc(ctx, doc); err != nil {
		return 0, err
	}
	return doc.ID, nil
}

// sortHits orders by the RRF rank score — comparable across KBs and retrieval
// paths, unlike raw cosine (keyword-only hits carry Score 0).
func sortHits(h []EnrichedHit) {
	for i := 1; i < len(h); i++ {
		for j := i; j > 0 && h[j].fused > h[j-1].fused; j-- {
			h[j], h[j-1] = h[j-1], h[j]
		}
	}
}

// rateLimit applies a best-effort pre-check against the embedding provider's
// token bucket so large ingests don't blow the provider's TPM. Failures degrade
// to proceeding (the chat path is the primary limiter consumer).
func (s *Service) rateLimit(providerID uint64, inputs []string) {
	if s.limiter == nil || providerID == 0 {
		return
	}
	est := 0
	for _, in := range inputs {
		est += s.count(in)
	}
	ok, retry, _ := s.limiter.Allow(providerID, est)
	if !ok && retry > 0 {
		if retry > 10*time.Second {
			retry = 10 * time.Second
		}
		time.Sleep(retry)
	}
}
