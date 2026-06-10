package provider

import (
	"context"
	"errors"
	"strings"
	"sync"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
)

// EmbeddingResolver decides which provider+model performs embeddings for the
// knowledge base and long-term memory. Embeddings are a SYSTEM-level capability
// (they index org content and recall facts), so resolution is independent of the
// active chat provider — an operator can run chat on Anthropic (which has no
// embeddings API) while embeddings go through a designated OpenAI / Gemini /
// openai_compatible (e.g. Voyage, a local Ollama) provider.
//
// Resolution order:
//  1. the explicitly-designated provider+model (set via SetEmbedding / config)
//  2. the first global, enabled, non-Anthropic provider that has an embedding
//     model in its curated list (or any model when none is flagged)
//
// The designated setting is held in memory (seeded from config) and persisted by
// an optional Persist hook so it survives restarts.
type EmbeddingResolver struct {
	reg  *Registry
	repo *airepo.ProviderRepo

	mu         sync.RWMutex
	providerID uint64
	model      string
	dims       int

	// Persist, when set, is called whenever SetEmbedding changes the designation
	// so the host can write it to durable storage (e.g. SystemSetting).
	Persist func(providerID uint64, model string, dims int)
}

// NewEmbeddingResolver builds the resolver, seeding the designation from config.
func NewEmbeddingResolver(reg *Registry, repo *airepo.ProviderRepo, providerID uint64, model string, dims int) *EmbeddingResolver {
	return &EmbeddingResolver{reg: reg, repo: repo, providerID: providerID, model: model, dims: dims}
}

// Setting returns the current designation (provider id, model, dimensions).
func (e *EmbeddingResolver) Setting() (providerID uint64, model string, dims int) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.providerID, e.model, e.dims
}

// SetEmbedding updates the designation and (if configured) persists it.
func (e *EmbeddingResolver) SetEmbedding(providerID uint64, model string, dims int) {
	e.mu.Lock()
	e.providerID, e.model, e.dims = providerID, model, dims
	persist := e.Persist
	e.mu.Unlock()
	if persist != nil {
		persist(providerID, model, dims)
	}
}

// Resolved is the outcome of resolving the embedding designation.
type Resolved struct {
	Provider   Provider
	ProviderID uint64
	Model      string
	Dimensions int // requested output dim (0 = model default)
}

// Resolve returns the embedding Provider, its row id, the model id, and the
// requested output dimension. It bypasses per-user visibility because the
// designation is an operator decision and ingestion runs without a user context.
func (e *EmbeddingResolver) Resolve(ctx context.Context) (Resolved, error) {
	e.mu.RLock()
	pid, model, dims := e.providerID, e.model, e.dims
	e.mu.RUnlock()

	if pid != 0 {
		row, err := e.repo.FindByID(ctx, pid)
		if err != nil {
			return Resolved{}, err
		}
		if row != nil && row.Enabled {
			p, err := e.reg.BuildFor(ctx, row)
			if err != nil {
				return Resolved{}, err
			}
			m := model
			if m == "" {
				m = pickEmbeddingModel(row)
			}
			if m == "" {
				return Resolved{}, errors.New("embedding provider has no embedding model configured")
			}
			return Resolved{Provider: p, ProviderID: row.ID, Model: m, Dimensions: dims}, nil
		}
	}

	// Fallback: scan for a usable global provider.
	rows, err := e.repo.List(ctx)
	if err != nil {
		return Resolved{}, err
	}
	for i := range rows {
		row := &rows[i]
		if !row.IsGlobal || !row.Enabled || row.Kind == aimodel.ProviderAnthropic {
			continue
		}
		if m := pickEmbeddingModel(row); m != "" {
			p, err := e.reg.BuildFor(ctx, row)
			if err != nil {
				continue
			}
			return Resolved{Provider: p, ProviderID: row.ID, Model: m, Dimensions: dims}, nil
		}
	}
	return Resolved{}, errors.New("no embedding provider configured: designate one in AI settings (OpenAI/Gemini/compatible)")
}

// pickEmbeddingModel returns the best embedding model id for a provider row:
// first a model flagged Embedding, then a heuristic name match, else the row's
// default model only when its kind clearly supports embeddings.
func pickEmbeddingModel(row *aimodel.AIProvider) string {
	models := parseModels(row.Models)
	for _, m := range models {
		if m.Embedding {
			return m.ID
		}
	}
	for _, m := range models {
		if looksLikeEmbeddingModel(m.ID) {
			return m.ID
		}
	}
	if row.DefaultModel != "" && looksLikeEmbeddingModel(row.DefaultModel) {
		return row.DefaultModel
	}
	return ""
}

func looksLikeEmbeddingModel(id string) bool {
	id = strings.ToLower(id)
	return strings.Contains(id, "embed") || strings.Contains(id, "bge") ||
		strings.Contains(id, "gte") || strings.Contains(id, "nomic")
}
