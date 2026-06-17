package repo

import (
	"context"
	"time"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
	"gorm.io/gorm"
)

// KnowledgeRepo is the data-access layer for knowledge bases, documents, chunks,
// and long-term agent memory. Vector similarity itself lives in the
// internal/ai/knowledge VectorStore; this repo owns the row CRUD.
type KnowledgeRepo struct{ db *gorm.DB }

func NewKnowledgeRepo(db *gorm.DB) *KnowledgeRepo { return &KnowledgeRepo{db: db} }

// ----- knowledge bases -----

func (r *KnowledgeRepo) CreateKB(ctx context.Context, kb *aimodel.KnowledgeBase) error {
	return r.db.WithContext(ctx).Create(kb).Error
}

func (r *KnowledgeRepo) GetKB(ctx context.Context, id uint64) (*aimodel.KnowledgeBase, error) {
	var kb aimodel.KnowledgeBase
	err := r.db.WithContext(ctx).First(&kb, id).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &kb, nil
}

// ListKBs returns the bases visible to a user (global + owned). adminAll returns
// every base regardless of scope.
func (r *KnowledgeRepo) ListKBs(ctx context.Context, userID uint64, adminAll bool) ([]aimodel.KnowledgeBase, error) {
	var out []aimodel.KnowledgeBase
	q := r.db.WithContext(ctx).Order("name")
	if !adminAll {
		q = q.Where("scope = ? OR owner_id = ?", aimodel.AgentScopeGlobal, userID)
	}
	return out, q.Find(&out).Error
}

func (r *KnowledgeRepo) UpdateKB(ctx context.Context, id uint64, fields map[string]any) error {
	return r.db.WithContext(ctx).Model(&aimodel.KnowledgeBase{}).Where("id = ?", id).Updates(fields).Error
}

// DeleteKB removes the base and every document + chunk under it.
func (r *KnowledgeRepo) DeleteKB(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("knowledge_base_id = ?", id).Delete(&aimodel.KnowledgeChunk{}).Error; err != nil {
			return err
		}
		if err := tx.Where("knowledge_base_id = ?", id).Delete(&aimodel.KnowledgeDocument{}).Error; err != nil {
			return err
		}
		return tx.Delete(&aimodel.KnowledgeBase{}, id).Error
	})
}

// RecountKB refreshes the denormalised document + chunk counts on the base.
func (r *KnowledgeRepo) RecountKB(ctx context.Context, id uint64) error {
	var docs, chunks int64
	r.db.WithContext(ctx).Model(&aimodel.KnowledgeDocument{}).Where("knowledge_base_id = ?", id).Count(&docs)
	r.db.WithContext(ctx).Model(&aimodel.KnowledgeChunk{}).Where("knowledge_base_id = ?", id).Count(&chunks)
	return r.db.WithContext(ctx).Model(&aimodel.KnowledgeBase{}).Where("id = ?", id).
		Updates(map[string]any{"document_count": docs, "chunk_count": chunks}).Error
}

// ----- documents -----

func (r *KnowledgeRepo) CreateDoc(ctx context.Context, d *aimodel.KnowledgeDocument) error {
	return r.db.WithContext(ctx).Create(d).Error
}

func (r *KnowledgeRepo) GetDoc(ctx context.Context, id uint64) (*aimodel.KnowledgeDocument, error) {
	var d aimodel.KnowledgeDocument
	err := r.db.WithContext(ctx).First(&d, id).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *KnowledgeRepo) ListDocs(ctx context.Context, kbID uint64) ([]aimodel.KnowledgeDocument, error) {
	var out []aimodel.KnowledgeDocument
	return out, r.db.WithContext(ctx).Where("knowledge_base_id = ?", kbID).
		Order("created_at desc").Find(&out).Error
}

func (r *KnowledgeRepo) FindDocBySHA(ctx context.Context, kbID uint64, sha string) (*aimodel.KnowledgeDocument, error) {
	if sha == "" {
		return nil, nil
	}
	var d aimodel.KnowledgeDocument
	err := r.db.WithContext(ctx).Where("knowledge_base_id = ? AND sha256 = ?", kbID, sha).First(&d).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *KnowledgeRepo) UpdateDocStatus(ctx context.Context, id uint64, status aimodel.DocStatus, errMsg string, chunkCount int) error {
	fields := map[string]any{"status": status, "error_message": errMsg, "updated_at": time.Now()}
	if chunkCount >= 0 {
		fields["chunk_count"] = chunkCount
	}
	return r.db.WithContext(ctx).Model(&aimodel.KnowledgeDocument{}).Where("id = ?", id).Updates(fields).Error
}

func (r *KnowledgeRepo) DeleteDoc(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("document_id = ?", id).Delete(&aimodel.KnowledgeChunk{}).Error; err != nil {
			return err
		}
		return tx.Delete(&aimodel.KnowledgeDocument{}, id).Error
	})
}

// ----- chunks -----

// ReplaceDocChunks atomically swaps all chunks of a document and returns the
// inserted rows with fresh ids (so the vector store can index by id).
func (r *KnowledgeRepo) ReplaceDocChunks(ctx context.Context, docID uint64, chunks []aimodel.KnowledgeChunk) ([]aimodel.KnowledgeChunk, error) {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("document_id = ?", docID).Delete(&aimodel.KnowledgeChunk{}).Error; err != nil {
			return err
		}
		if len(chunks) == 0 {
			return nil
		}
		return tx.Create(&chunks).Error
	})
	if err != nil {
		return nil, err
	}
	return chunks, nil
}

// KeywordSearchChunks returns chunks of a KB whose content matches ANY of the
// terms (case-insensitive substring). The caller ranks by hit count; this just
// bounds the candidate set. Terms must be pre-escaped plain words.
func (r *KnowledgeRepo) KeywordSearchChunks(ctx context.Context, kbID uint64, terms []string, limit int) ([]aimodel.KnowledgeChunk, error) {
	if len(terms) == 0 {
		return nil, nil
	}
	if limit <= 0 {
		limit = 50
	}
	or := r.db.Where("content ILIKE ?", "%"+escapeLike(terms[0])+"%")
	for _, t := range terms[1:] {
		or = or.Or("content ILIKE ?", "%"+escapeLike(t)+"%")
	}
	var out []aimodel.KnowledgeChunk
	err := r.db.WithContext(ctx).
		Where("knowledge_base_id = ?", kbID).
		Where(or).
		Limit(limit).
		Find(&out).Error
	return out, err
}

// ----- memory -----

// MemoryFilter scopes a memory listing. Nil pointers mean "any".
type MemoryFilter struct {
	UserID  *uint64
	AgentID *uint64
	Query   string
	Limit   int
}

func (r *KnowledgeRepo) CreateMemory(ctx context.Context, m *aimodel.AgentMemory) error {
	return r.db.WithContext(ctx).Create(m).Error
}

func (r *KnowledgeRepo) GetMemory(ctx context.Context, id uint64) (*aimodel.AgentMemory, error) {
	var m aimodel.AgentMemory
	err := r.db.WithContext(ctx).First(&m, id).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (r *KnowledgeRepo) ListMemories(ctx context.Context, f MemoryFilter) ([]aimodel.AgentMemory, error) {
	var out []aimodel.AgentMemory
	q := r.db.WithContext(ctx).Model(&aimodel.AgentMemory{})
	if f.UserID != nil {
		q = q.Where("user_id = ?", *f.UserID)
	}
	if f.AgentID != nil {
		q = q.Where("agent_id = ?", *f.AgentID)
	}
	if f.Query != "" {
		q = q.Where("content ILIKE ?", "%"+f.Query+"%")
	}
	q = q.Order("last_used_at desc nulls last, salience desc, updated_at desc")
	if f.Limit > 0 {
		q = q.Limit(f.Limit)
	}
	return out, q.Find(&out).Error
}

// RecallCandidates returns memories for a (user, agent) pair ranked by
// recency/salience, capped at limit — used as the candidate set for embedding
// rerank, or directly when no embedding is available.
func (r *KnowledgeRepo) RecallCandidates(ctx context.Context, userID, agentID uint64, limit int) ([]aimodel.AgentMemory, error) {
	if limit <= 0 {
		limit = 50
	}
	var out []aimodel.AgentMemory
	return out, r.db.WithContext(ctx).
		Where("user_id = ? AND agent_id = ?", userID, agentID).
		Order("last_used_at desc nulls last, salience desc, updated_at desc").
		Limit(limit).Find(&out).Error
}

func (r *KnowledgeRepo) UpdateMemory(ctx context.Context, id uint64, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	return r.db.WithContext(ctx).Model(&aimodel.AgentMemory{}).Where("id = ?", id).Updates(fields).Error
}

func (r *KnowledgeRepo) DeleteMemory(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&aimodel.AgentMemory{}, id).Error
}

// BumpSalience increments salience + stamps LastUsedAt for recalled memories.
func (r *KnowledgeRepo) BumpSalience(ctx context.Context, ids []uint64) error {
	if len(ids) == 0 {
		return nil
	}
	now := time.Now()
	return r.db.WithContext(ctx).Model(&aimodel.AgentMemory{}).Where("id IN ?", ids).
		Updates(map[string]any{"salience": gorm.Expr("salience + 1"), "last_used_at": now}).Error
}
