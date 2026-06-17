// Package catalog is the static, code-versioned reference list of well-known LLM
// providers and their flagship models. It powers the "add provider" gallery and
// the guided setup wizard on the frontend: picking a preset auto-fills the wire
// protocol, base URL, a curated model list (with capabilities + list pricing),
// and a brand icon token — so the operator usually only pastes an API key.
//
// This is reference data the user copies FROM, not editable rows, so a static Go
// table is the right home: zero migration, trivially testable, and it ships in
// lock-step with the provider/runner code that consumes the same shapes.
package catalog

import (
	"sort"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
)

// Region groups presets for the gallery's category tabs.
type Region string

const (
	RegionInternational Region = "international"
	RegionDomestic      Region = "domestic"
	RegionLocal         Region = "local"
)

// ModelPreset is one curated model: display + capability + list pricing. Prices
// are USD per 1M tokens; 0 means "unknown" (the runner then falls back to its
// static price table, or shows tokens only).
type ModelPreset struct {
	ID                string  `json:"id"`
	Label             string  `json:"label"`
	ContextWindow     int     `json:"context_window,omitempty"`
	MaxOutput         int     `json:"max_output,omitempty"`
	Tools             bool    `json:"tools,omitempty"`
	Vision            bool    `json:"vision,omitempty"`
	Reasoning         bool    `json:"reasoning,omitempty"`
	Caching           bool    `json:"caching,omitempty"`
	InPerMTok         float64 `json:"in_per_mtok,omitempty"`
	OutPerMTok        float64 `json:"out_per_mtok,omitempty"`
	CacheReadPerMTok  float64 `json:"cache_read_per_mtok,omitempty"`
	CacheWritePerMTok float64 `json:"cache_write_per_mtok,omitempty"`
}

// ExtraField declares a provider-specific config input the wizard should render
// (e.g. Azure deployment name). Key lands in the provider's ExtraJSON.
type ExtraField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

// Preset is one provider the operator can one-click add.
type Preset struct {
	ID          string               `json:"slug"`
	DisplayName string               `json:"name"`
	Kind        aimodel.ProviderKind `json:"kind"`
	Region      Region               `json:"category"`
	BaseURL     string               `json:"base_url,omitempty"`
	IconToken   string               `json:"icon,omitempty"`
	AuthNotes   string               `json:"key_help,omitempty"`
	DocsURL     string               `json:"docs_url,omitempty"`
	NeedsBaseURL bool                `json:"needs_base_url,omitempty"`
	ExtraFields []ExtraField         `json:"extra_fields,omitempty"`
	Models      []ModelPreset        `json:"models,omitempty"`
}

// pricing ratio helpers mirror runner/pricing.go so catalog list prices stay
// consistent with the cost estimator's static fallback.
func anthropicCache(in float64) (cr, cw float64) { return in * 0.1, in * 1.25 }
func openaiCache(in float64) (cr, cw float64)    { return in * 0.5, 0 }

func aModel(id, label string, ctx, maxOut int, vision, reasoning bool, in, out float64) ModelPreset {
	cr, cw := anthropicCache(in)
	return ModelPreset{
		ID: id, Label: label, ContextWindow: ctx, MaxOutput: maxOut,
		Tools: true, Vision: vision, Reasoning: reasoning, Caching: true,
		InPerMTok: in, OutPerMTok: out, CacheReadPerMTok: cr, CacheWritePerMTok: cw,
	}
}

func oModel(id, label string, ctx, maxOut int, vision, reasoning bool, in, out float64) ModelPreset {
	cr, cw := openaiCache(in)
	return ModelPreset{
		ID: id, Label: label, ContextWindow: ctx, MaxOutput: maxOut,
		Tools: true, Vision: vision, Reasoning: reasoning, Caching: true,
		InPerMTok: in, OutPerMTok: out, CacheReadPerMTok: cr, CacheWritePerMTok: cw,
	}
}

// presets is the master table. Domestic + local providers all speak the OpenAI
// wire protocol (openai_compatible) with their own base URL.
var presets = []Preset{
	// ---------------- International ----------------
	{
		ID: "openai", DisplayName: "OpenAI", Kind: aimodel.ProviderOpenAI,
		Region: RegionInternational, IconToken: "text:GPT",
		AuthNotes: "在 platform.openai.com → API keys 创建，形如 sk-…",
		DocsURL:   "https://platform.openai.com/api-keys",
		Models: []ModelPreset{
			oModel("gpt-4o", "GPT-4o", 128_000, 16_384, true, false, 2.5, 10),
			oModel("gpt-4o-mini", "GPT-4o mini", 128_000, 16_384, true, false, 0.15, 0.6),
			oModel("gpt-4.1", "GPT-4.1", 1_000_000, 32_768, true, false, 2, 8),
			oModel("o3-mini", "o3-mini (reasoning)", 200_000, 100_000, false, true, 1.1, 4.4),
		},
	},
	{
		ID: "anthropic", DisplayName: "Anthropic Claude", Kind: aimodel.ProviderAnthropic,
		Region: RegionInternational, IconToken: "simple:anthropic",
		AuthNotes: "在 console.anthropic.com → API Keys 创建，形如 sk-ant-…",
		DocsURL:   "https://console.anthropic.com/settings/keys",
		Models: []ModelPreset{
			aModel("claude-opus-4-8", "Claude Opus 4.8", 1_000_000, 64_000, true, true, 5, 25),
			aModel("claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, 64_000, true, true, 3, 15),
			aModel("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 32_000, true, true, 1, 5),
		},
	},
	{
		ID: "gemini", DisplayName: "Google Gemini", Kind: aimodel.ProviderGemini,
		Region: RegionInternational, IconToken: "simple:googlegemini",
		AuthNotes: "在 Google AI Studio 创建 API Key",
		DocsURL:   "https://aistudio.google.com/apikey",
		Models: []ModelPreset{
			oModel("gemini-2.5-pro", "Gemini 2.5 Pro", 2_000_000, 65_536, true, true, 1.25, 10),
			oModel("gemini-2.5-flash", "Gemini 2.5 Flash", 1_000_000, 65_536, true, true, 0.3, 2.5),
		},
	},
	{
		ID: "azure-openai", DisplayName: "Azure OpenAI", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, IconToken: "text:Az", NeedsBaseURL: true,
		AuthNotes: "BaseURL 形如 https://<resource>.openai.azure.com ；密钥在 Azure 门户 → Keys",
		ExtraFields: []ExtraField{
			{Key: "azure_deployment", Label: "部署名 Deployment", Placeholder: "my-gpt4o", Required: true},
			{Key: "azure_api_version", Label: "API 版本", Placeholder: "2024-10-21"},
		},
		Models: []ModelPreset{
			oModel("gpt-4o", "GPT-4o", 128_000, 16_384, true, false, 2.5, 10),
			oModel("gpt-4o-mini", "GPT-4o mini", 128_000, 16_384, true, false, 0.15, 0.6),
		},
	},
	{
		ID: "openrouter", DisplayName: "OpenRouter", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, BaseURL: "https://openrouter.ai/api/v1", IconToken: "text:OR",
		AuthNotes: "openrouter.ai → Keys，统一聚合多家模型",
		DocsURL:   "https://openrouter.ai/keys",
		Models: []ModelPreset{
			oModel("openai/gpt-4o", "GPT-4o", 128_000, 16_384, true, false, 2.5, 10),
			oModel("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, 64_000, true, true, 3, 15),
		},
	},
	{
		ID: "groq", DisplayName: "Groq", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, BaseURL: "https://api.groq.com/openai/v1", IconToken: "text:Gq",
		AuthNotes: "console.groq.com → API Keys，超低延迟推理",
		Models: []ModelPreset{
			oModel("llama-3.3-70b-versatile", "Llama 3.3 70B", 128_000, 32_768, false, false, 0.59, 0.79),
			oModel("deepseek-r1-distill-llama-70b", "DeepSeek-R1 Distill 70B", 128_000, 16_384, false, true, 0.75, 0.99),
		},
	},
	{
		ID: "xai", DisplayName: "xAI Grok", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, BaseURL: "https://api.x.ai/v1", IconToken: "text:xAI",
		AuthNotes: "console.x.ai → API Keys",
		Models: []ModelPreset{
			oModel("grok-4", "Grok 4", 256_000, 32_768, true, true, 3, 15),
			oModel("grok-3-mini", "Grok 3 mini", 131_072, 16_384, false, true, 0.3, 0.5),
		},
	},
	{
		ID: "mistral", DisplayName: "Mistral AI", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, BaseURL: "https://api.mistral.ai/v1", IconToken: "simple:mistralai",
		AuthNotes: "console.mistral.ai → API Keys",
		Models: []ModelPreset{
			oModel("mistral-large-latest", "Mistral Large", 128_000, 32_768, false, false, 2, 6),
			oModel("mistral-small-latest", "Mistral Small", 128_000, 32_768, false, false, 0.2, 0.6),
		},
	},
	{
		ID: "together", DisplayName: "Together AI", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, BaseURL: "https://api.together.xyz/v1", IconToken: "text:Tg",
		AuthNotes: "api.together.ai → Settings → API Keys",
		Models: []ModelPreset{
			oModel("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo", 128_000, 32_768, false, false, 0.88, 0.88),
		},
	},
	{
		ID: "fireworks", DisplayName: "Fireworks AI", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, BaseURL: "https://api.fireworks.ai/inference/v1", IconToken: "text:Fw",
		AuthNotes: "fireworks.ai → API Keys",
		Models: []ModelPreset{
			oModel("accounts/fireworks/models/deepseek-v3", "DeepSeek V3", 128_000, 16_384, false, false, 0.9, 0.9),
		},
	},
	{
		ID: "bedrock", DisplayName: "AWS Bedrock（即将支持）", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionInternational, IconToken: "text:AWS", NeedsBaseURL: true,
		AuthNotes: "暂以目录形式登记；原生 SigV4 接入计划中。可填一个 OpenAI 兼容的 Bedrock 网关 BaseURL 先行使用。",
		ExtraFields: []ExtraField{
			{Key: "bedrock_region", Label: "区域 Region", Placeholder: "us-east-1"},
		},
		Models: []ModelPreset{
			aModel("anthropic.claude-sonnet-4", "Claude Sonnet 4 (Bedrock)", 200_000, 32_000, true, true, 3, 15),
		},
	},

	// ---------------- Domestic（国内） ----------------
	{
		ID: "deepseek", DisplayName: "DeepSeek 深度求索", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://api.deepseek.com", IconToken: "text:DS",
		AuthNotes: "platform.deepseek.com → API keys",
		DocsURL:   "https://platform.deepseek.com/api_keys",
		Models: []ModelPreset{
			oModel("deepseek-chat", "DeepSeek-V3 Chat", 64_000, 8_000, false, false, 0.27, 1.1),
			oModel("deepseek-reasoner", "DeepSeek-R1 Reasoner", 64_000, 8_000, false, true, 0.55, 2.19),
		},
	},
	{
		ID: "siliconflow", DisplayName: "硅基流动 SiliconFlow", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://api.siliconflow.cn/v1", IconToken: "text:硅",
		AuthNotes: "cloud.siliconflow.cn → API 密钥，聚合多家开源模型",
		Models: []ModelPreset{
			oModel("deepseek-ai/DeepSeek-V3", "DeepSeek-V3", 64_000, 8_000, false, false, 0, 0),
			oModel("Qwen/Qwen2.5-72B-Instruct", "Qwen2.5 72B", 131_072, 8_000, false, false, 0, 0),
		},
	},
	{
		ID: "moonshot", DisplayName: "月之暗面 Kimi", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://api.moonshot.cn/v1", IconToken: "text:Ki",
		AuthNotes: "platform.moonshot.cn → API Keys",
		Models: []ModelPreset{
			oModel("kimi-k2-0905-preview", "Kimi K2", 256_000, 16_384, false, false, 0, 0),
			oModel("moonshot-v1-128k", "Moonshot v1 128k", 128_000, 8_000, false, false, 0, 0),
		},
	},
	{
		ID: "zhipu", DisplayName: "智谱 GLM", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://open.bigmodel.cn/api/paas/v4", IconToken: "text:GLM",
		AuthNotes: "open.bigmodel.cn → API Keys",
		Models: []ModelPreset{
			oModel("glm-4.6", "GLM-4.6", 200_000, 16_384, true, true, 0, 0),
			oModel("glm-4-flash", "GLM-4 Flash", 128_000, 8_000, false, false, 0, 0),
		},
	},
	{
		ID: "qwen", DisplayName: "通义千问 DashScope", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", IconToken: "simple:alibabacloud",
		AuthNotes: "阿里云百炼 → API-KEY（兼容模式 BaseURL）",
		Models: []ModelPreset{
			oModel("qwen-max", "Qwen-Max", 32_768, 8_192, false, false, 0, 0),
			oModel("qwen-plus", "Qwen-Plus", 131_072, 8_192, false, false, 0, 0),
			oModel("qwen-vl-max", "Qwen-VL-Max（视觉）", 32_768, 8_192, true, false, 0, 0),
		},
	},
	{
		ID: "volcengine", DisplayName: "火山方舟·豆包", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://ark.cn-beijing.volces.com/api/v3", IconToken: "text:豆",
		AuthNotes: "火山方舟控制台 → API Key；模型 ID 用接入点 endpoint-id",
		Models: []ModelPreset{
			oModel("doubao-pro-32k", "豆包 Pro 32k", 32_768, 4_096, false, false, 0, 0),
		},
	},
	{
		ID: "baidu", DisplayName: "百度文心 ERNIE", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://qianfan.baidubce.com/v2", IconToken: "text:文",
		AuthNotes: "千帆控制台 → 应用接入（V2 兼容 BaseURL）",
		Models: []ModelPreset{
			oModel("ernie-4.5-turbo-128k", "文心 4.5 Turbo", 128_000, 8_000, false, false, 0, 0),
		},
	},
	{
		ID: "minimax", DisplayName: "MiniMax", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://api.minimax.chat/v1", IconToken: "text:MM",
		AuthNotes: "platform.minimaxi.com → 接口密钥",
		Models: []ModelPreset{
			oModel("abab6.5s-chat", "abab6.5s", 245_000, 8_000, false, false, 0, 0),
		},
	},
	{
		ID: "stepfun", DisplayName: "阶跃星辰 Step", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://api.stepfun.com/v1", IconToken: "text:阶",
		AuthNotes: "platform.stepfun.com → API Keys",
		Models: []ModelPreset{
			oModel("step-2-16k", "Step-2 16k", 16_384, 4_096, false, false, 0, 0),
		},
	},
	{
		ID: "zeroone", DisplayName: "零一万物 Yi", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionDomestic, BaseURL: "https://api.lingyiwanwu.com/v1", IconToken: "text:零",
		AuthNotes: "platform.lingyiwanwu.com → API Keys",
		Models: []ModelPreset{
			oModel("yi-lightning", "Yi-Lightning", 16_384, 4_096, false, false, 0, 0),
		},
	},

	// ---------------- Local（本地自托管） ----------------
	{
		ID: "ollama", DisplayName: "Ollama", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionLocal, BaseURL: "http://localhost:11434/v1", IconToken: "simple:ollama",
		AuthNotes: "本地 Ollama，API Key 可填任意占位（如 ollama）",
		DocsURL:   "https://ollama.com",
		Models: []ModelPreset{
			oModel("llama3.1", "Llama 3.1 8B", 128_000, 8_000, false, false, 0, 0),
			oModel("qwen2.5", "Qwen2.5 7B", 131_072, 8_000, false, false, 0, 0),
		},
	},
	{
		ID: "lmstudio", DisplayName: "LM Studio", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionLocal, BaseURL: "http://localhost:1234/v1", IconToken: "text:LM",
		AuthNotes: "LM Studio 本地服务器，API Key 任意占位",
	},
	{
		ID: "vllm", DisplayName: "vLLM", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionLocal, BaseURL: "http://localhost:8000/v1", IconToken: "text:vL",
		AuthNotes: "vLLM OpenAI 兼容服务，按部署填 BaseURL；Key 任意占位",
	},
	{
		ID: "localai", DisplayName: "LocalAI", Kind: aimodel.ProviderOpenAICompat,
		Region: RegionLocal, BaseURL: "http://localhost:8080/v1", IconToken: "text:LA",
		AuthNotes: "LocalAI 本地服务，API Key 任意占位",
	},
}

// All returns every preset (stable order: as declared).
func All() []Preset { return presets }

// ByRegion returns presets in one region.
func ByRegion(region Region) []Preset {
	out := make([]Preset, 0, len(presets))
	for _, p := range presets {
		if p.Region == region {
			out = append(out, p)
		}
	}
	return out
}

// ByID looks up a preset by its slug.
func ByID(id string) (Preset, bool) {
	for _, p := range presets {
		if p.ID == id {
			return p, true
		}
	}
	return Preset{}, false
}

// ModelByID returns a curated model from a preset by model id.
func ModelByID(presetID, modelID string) (ModelPreset, bool) {
	p, ok := ByID(presetID)
	if !ok {
		return ModelPreset{}, false
	}
	for _, m := range p.Models {
		if m.ID == modelID {
			return m, true
		}
	}
	return ModelPreset{}, false
}

// ModelByKindAndID searches every preset of the given kind for a model id — used
// by the capability/pricing resolver as a fallback when the operator didn't save
// curated metadata on their provider row. Returns the first match.
func ModelByKindAndID(kind aimodel.ProviderKind, modelID string) (ModelPreset, bool) {
	for _, p := range presets {
		if p.Kind != kind {
			continue
		}
		for _, m := range p.Models {
			if m.ID == modelID {
				return m, true
			}
		}
	}
	return ModelPreset{}, false
}

// Regions returns the distinct regions in declared priority order — handy for
// the frontend tab list without hardcoding strings on both sides.
func Regions() []Region {
	seen := map[Region]bool{}
	var out []Region
	for _, p := range presets {
		if !seen[p.Region] {
			seen[p.Region] = true
			out = append(out, p.Region)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return regionRank(out[i]) < regionRank(out[j]) })
	return out
}

func regionRank(r Region) int {
	switch r {
	case RegionInternational:
		return 0
	case RegionDomestic:
		return 1
	case RegionLocal:
		return 2
	}
	return 9
}
