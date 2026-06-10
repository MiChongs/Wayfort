package model

import "time"

// DocStatus is the ingest lifecycle of one uploaded document.
type DocStatus string

const (
	DocPending   DocStatus = "pending"
	DocChunking  DocStatus = "chunking"
	DocEmbedding DocStatus = "embedding"
	DocReady     DocStatus = "ready"
	DocFailed    DocStatus = "failed"
)

// MemoryKind classifies a remembered fact.
type MemoryKind string

const (
	MemFact       MemoryKind = "fact"
	MemPreference MemoryKind = "preference"
	MemResolution MemoryKind = "resolution"
)

// ValidMemoryKind reports whether k is a recognised memory kind.
func ValidMemoryKind(k MemoryKind) bool {
	switch k {
	case MemFact, MemPreference, MemResolution:
		return true
	}
	return false
}

// KnowledgeBase groups documents for retrieval-augmented generation. The
// embedding model + dimension are FROZEN at creation so every chunk in the base
// is comparable and a single fixed-dimension vector index stays valid. Backend
// records whether vectors are indexed by pgvector or by the application-layer
// cosine fallback.
type KnowledgeBase struct {
	ID             uint64     `gorm:"primaryKey" json:"id"`
	Name           string     `gorm:"size:128;index;not null" json:"name"`
	Description    string     `gorm:"size:512" json:"description"`
	Scope          AgentScope `gorm:"size:16;index;not null" json:"scope"`
	OwnerID        *uint64    `gorm:"index" json:"owner_id,omitempty"`
	EmbeddingModel string     `gorm:"size:128" json:"embedding_model"`
	EmbeddingDim   int        `json:"embedding_dim"`
	Backend        string     `gorm:"size:16" json:"backend"` // "pgvector" | "fallback"
	DocumentCount  int        `json:"document_count"`
	ChunkCount     int        `json:"chunk_count"`
	Enabled        bool       `gorm:"default:true" json:"enabled"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

func (KnowledgeBase) TableName() string { return "ai_knowledge_bases" }

// KnowledgeDocument is one ingested source (file / url / distilled resolution).
type KnowledgeDocument struct {
	ID              uint64    `gorm:"primaryKey" json:"id"`
	KnowledgeBaseID uint64    `gorm:"index;not null" json:"knowledge_base_id"`
	Title           string    `gorm:"size:256" json:"title"`
	Source          string    `gorm:"size:512" json:"source"` // filename / url / "distilled:conv:<id>"
	MIME            string    `gorm:"size:128" json:"mime,omitempty"`
	SHA256          string    `gorm:"size:64;index" json:"sha256,omitempty"`
	Status          DocStatus `gorm:"size:16;index" json:"status"`
	ErrorMessage    string    `gorm:"type:text" json:"error,omitempty"`
	// ExtractedText is the plain text pulled from the upload, kept so re-ingest
	// (e.g. after changing the embedding model) can re-chunk without the original
	// bytes. Not surfaced in the API.
	ExtractedText string `gorm:"type:text" json:"-"`
	ChunkCount    int    `json:"chunk_count"`
	ByteSize        int64     `json:"size"`
	CreatedBy       uint64    `json:"created_by,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func (KnowledgeDocument) TableName() string { return "ai_knowledge_documents" }

// KnowledgeChunk is one embedded slice of a document. The vector lives in either
// the pgvector `embedding` column (added by the migrator when the extension is
// present) or the EmbeddingJSON fallback — EmbeddingJSON is always written so the
// data is portable and the fallback cosine path works regardless of backend.
type KnowledgeChunk struct {
	ID              uint64    `gorm:"primaryKey" json:"id"`
	KnowledgeBaseID uint64    `gorm:"index;not null" json:"knowledge_base_id"`
	DocumentID      uint64    `gorm:"index;not null" json:"document_id"`
	Ordinal         int       `json:"ordinal"`
	Content         string    `gorm:"type:text" json:"content"`
	TokenCount      int       `json:"token_count"`
	EmbeddingJSON   string    `gorm:"type:text" json:"-"`
	CreatedAt       time.Time `json:"created_at"`
}

func (KnowledgeChunk) TableName() string { return "ai_knowledge_chunks" }

// AgentMemory is one durable fact recalled across conversations, scoped to a
// (user, agent) pair. Salience + LastUsedAt drive recency/usefulness ranking when
// no embedding is available.
type AgentMemory struct {
	ID            uint64     `gorm:"primaryKey" json:"id"`
	UserID        uint64     `gorm:"index:idx_mem_user_agent;not null" json:"user_id"`
	AgentID       uint64     `gorm:"index:idx_mem_user_agent;not null" json:"agent_id"`
	Kind          MemoryKind `gorm:"size:24;index" json:"kind"`
	Content       string     `gorm:"type:text" json:"content"`
	SourceConvID  string     `gorm:"size:64" json:"source_conversation_id,omitempty"`
	EmbeddingJSON string     `gorm:"type:text" json:"-"`
	Salience      int        `gorm:"default:1" json:"salience"`
	LastUsedAt    *time.Time `json:"last_used_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

func (AgentMemory) TableName() string { return "ai_agent_memories" }
