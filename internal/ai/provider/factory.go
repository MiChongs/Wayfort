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
func Build(ctx context.Context, row *aimodel.AIProvider, sealer pkgcrypto.Vault) (Provider, error) {
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
	extra := ParseExtra(row.ExtraJSON)
	return buildFromParts(ctx, row.Kind, row.Name, row.BaseURL, string(keyPlain),
		row.ProxyURL, row.DefaultModel, models, extra)
}

// BuildEphemeral constructs a one-off Provider from plaintext parts (no DB row,
// no sealing) — used by the setup wizard's pre-create test + model discovery so
// the operator can validate credentials before committing a provider.
func BuildEphemeral(ctx context.Context, kind aimodel.ProviderKind, name, baseURL, apiKey, proxyURL, defaultModel string, models []ModelInfo, extra Extra) (Provider, error) {
	if apiKey == "" {
		// Local gateways (Ollama/LM Studio) accept any placeholder; fill one so the
		// SDK doesn't reject an empty key during a draft probe.
		apiKey = "draft"
	}
	return buildFromParts(ctx, kind, name, baseURL, apiKey, proxyURL, defaultModel, models, extra)
}

// buildFromParts is the shared kind-dispatch behind Build + BuildEphemeral.
func buildFromParts(ctx context.Context, kind aimodel.ProviderKind, name, baseURL, apiKey, proxyURL, defaultModel string, models []ModelInfo, extra Extra) (Provider, error) {
	switch kind {
	case aimodel.ProviderOpenAI:
		return NewOpenAI(OpenAIConfig{
			Name: name, Kind: KindOpenAI, APIKey: apiKey,
			BaseURL: baseURL, DefaultModel: defaultModel,
			HTTPProxy: proxyURL, Models: models,
			OrgID: extra.OrgID, AzureAPIVersion: extra.AzureAPIVersion, Headers: extra.Headers,
		})
	case aimodel.ProviderOpenAICompat:
		return NewOpenAI(OpenAIConfig{
			Name: name, Kind: KindOpenAICompat, APIKey: apiKey,
			BaseURL: baseURL, DefaultModel: defaultModel,
			HTTPProxy: proxyURL, Models: models,
			OrgID: extra.OrgID, AzureAPIVersion: extra.AzureAPIVersion, Headers: extra.Headers,
		})
	case aimodel.ProviderAnthropic:
		return NewAnthropic(AnthropicConfig{
			Name: name, APIKey: apiKey, BaseURL: baseURL,
			DefaultModel: defaultModel, HTTPProxy: proxyURL, Models: models,
			Headers: extra.Headers,
		})
	case aimodel.ProviderGemini:
		return NewGemini(ctx, GeminiConfig{
			Name: name, APIKey: apiKey,
			DefaultModel: defaultModel, Models: models,
		})
	default:
		return nil, fmt.Errorf("unsupported provider kind %q", kind)
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
