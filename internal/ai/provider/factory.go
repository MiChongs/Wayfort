package provider

import (
	"context"
	"encoding/json"
	"fmt"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
)

// Build constructs a runtime Provider from a stored DB row. The Sealer is used
// to decrypt the API key in-memory; the plaintext never escapes this call.
func Build(ctx context.Context, row *aimodel.AIProvider, sealer *pkgcrypto.Sealer) (Provider, error) {
	if row == nil {
		return nil, fmt.Errorf("nil provider row")
	}
	if !row.Enabled {
		return nil, fmt.Errorf("provider %s disabled", row.Name)
	}
	keyPlain, err := sealer.Open(row.APIKeyEncrypted)
	if err != nil {
		return nil, fmt.Errorf("decrypt api key: %w", err)
	}
	models := parseModels(row.Models)
	switch row.Kind {
	case aimodel.ProviderOpenAI:
		return NewOpenAI(OpenAIConfig{
			Name: row.Name, Kind: KindOpenAI, APIKey: string(keyPlain),
			BaseURL: row.BaseURL, DefaultModel: row.DefaultModel,
			HTTPProxy: row.ProxyURL, Models: models,
		})
	case aimodel.ProviderOpenAICompat:
		return NewOpenAI(OpenAIConfig{
			Name: row.Name, Kind: KindOpenAICompat, APIKey: string(keyPlain),
			BaseURL: row.BaseURL, DefaultModel: row.DefaultModel,
			HTTPProxy: row.ProxyURL, Models: models,
		})
	case aimodel.ProviderAnthropic:
		return NewAnthropic(AnthropicConfig{
			Name: row.Name, APIKey: string(keyPlain), BaseURL: row.BaseURL,
			DefaultModel: row.DefaultModel, HTTPProxy: row.ProxyURL, Models: models,
		})
	case aimodel.ProviderGemini:
		return NewGemini(ctx, GeminiConfig{
			Name: row.Name, APIKey: string(keyPlain),
			DefaultModel: row.DefaultModel, Models: models,
		})
	default:
		return nil, fmt.Errorf("unsupported provider kind %q", row.Kind)
	}
}

func parseModels(raw string) []ModelInfo {
	if raw == "" {
		return nil
	}
	var out []ModelInfo
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}
