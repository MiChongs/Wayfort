// Package model holds the GORM rows for the AI assistant subsystem. They live
// under internal/ai/model to keep the (already large) top-level model package
// from sprawling further; nothing in here depends on the rest of internal/model.
package model

import "time"

// ProviderKind enumerates the wire-protocol family this provider speaks.
type ProviderKind string

const (
	ProviderOpenAI       ProviderKind = "openai"
	ProviderAnthropic    ProviderKind = "anthropic"
	ProviderOpenAICompat ProviderKind = "openai_compatible"
	ProviderGemini       ProviderKind = "gemini"
)

// AIProvider records the credentials and routing for one upstream LLM API.
// Scope is encoded by IsGlobal + OwnerID: global rows are shared with everyone;
// per-user rows are only visible (and decryptable) to their owner.
type AIProvider struct {
	ID                uint64       `gorm:"primaryKey" json:"id"`
	Name              string       `gorm:"size:64;index;not null" json:"name"`
	Kind              ProviderKind `gorm:"size:24;not null" json:"kind"`
	DisplayName       string       `gorm:"size:128" json:"display_name"`
	BaseURL           string       `gorm:"size:512" json:"base_url,omitempty"`
	APIKeyEncrypted   []byte       `json:"-"`
	APIKeyLast4       string       `gorm:"size:8" json:"api_key_last4,omitempty"`
	DefaultModel      string       `gorm:"size:128" json:"default_model"`
	Models            string       `gorm:"type:text" json:"models,omitempty"`
	IsGlobal          bool         `gorm:"index" json:"is_global"`
	OwnerID           *uint64      `gorm:"index" json:"owner_id,omitempty"`
	Enabled           bool         `gorm:"default:true" json:"enabled"`
	RateLimitRPM      int          `json:"rate_limit_rpm,omitempty"`
	RateLimitTPM      int          `json:"rate_limit_tpm,omitempty"`
	ProxyURL          string       `gorm:"size:512" json:"proxy_url,omitempty"`
	ExtraJSON         string       `gorm:"type:text" json:"extra,omitempty"`
	CreatedAt         time.Time    `json:"created_at"`
	UpdatedAt         time.Time    `json:"updated_at"`
}

func (AIProvider) TableName() string { return "ai_providers" }
