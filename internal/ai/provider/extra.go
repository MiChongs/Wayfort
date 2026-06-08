package provider

import (
	"encoding/json"
	"strings"
)

// Extra is the typed view of a provider row's ExtraJSON column — provider-
// specific configuration that doesn't deserve a first-class column. It is
// optional and fully back-compatible: an empty/invalid blob parses to the zero
// value and no options are applied.
//
// Secrets note: ExtraJSON is stored as plaintext text (unlike the sealed API
// key), so credential-shaped fields must never live here. The Bedrock fields are
// region/identifier only; the handler additionally redacts any secret-shaped
// header on read.
type Extra struct {
	// Azure OpenAI: a deployment name + api-version turn an openai_compatible row
	// into an Azure endpoint call.
	AzureDeployment string `json:"azure_deployment,omitempty"`
	AzureAPIVersion string `json:"azure_api_version,omitempty"`
	AzureEndpoint   string `json:"azure_endpoint,omitempty"`
	// AWS Bedrock: region only (native SigV4 runtime is a planned follow-up).
	BedrockRegion string `json:"bedrock_region,omitempty"`
	// OrgID maps to the OpenAI-Organization header.
	OrgID string `json:"org_id,omitempty"`
	// Headers are extra static request headers (custom auth, routing tags).
	Headers map[string]string `json:"headers,omitempty"`
}

// ParseExtra decodes an ExtraJSON blob, tolerating empty/garbage input.
func ParseExtra(raw string) Extra {
	var e Extra
	if strings.TrimSpace(raw) == "" {
		return e
	}
	_ = json.Unmarshal([]byte(raw), &e)
	return e
}
