package provider

// ModelCapabilities describes what a given provider+model can do, so the runner
// can gate request features (tools, vision, extended thinking, caching) and pick
// a tokenizer without scattering model-string sniffing across the codebase.
type ModelCapabilities struct {
	Tools         bool   `json:"tools"`
	Vision        bool   `json:"vision"`
	Reasoning     bool   `json:"reasoning"`
	Caching       bool   `json:"caching"`
	Streaming     bool   `json:"streaming"`
	Tokenizer     string `json:"tokenizer"` // "tiktoken" | "anthropic" | "heuristic"
	MaxOutput     int    `json:"max_output,omitempty"`
	ContextWindow int    `json:"context_window,omitempty"`
}

// DefaultCapabilities is the per-provider-kind baseline, before model-specific
// overrides and provider-reported flags are layered on.
func DefaultCapabilities(kind Kind) ModelCapabilities {
	c := ModelCapabilities{Streaming: true, Tokenizer: "heuristic"}
	switch kind {
	case KindAnthropic:
		c.Tools, c.Vision, c.Reasoning, c.Caching = true, true, true, true
		c.Tokenizer = "anthropic"
	case KindOpenAI:
		c.Tools, c.Vision, c.Caching = true, true, true
		c.Tokenizer = "tiktoken"
	case KindGemini:
		c.Tools, c.Vision, c.Reasoning, c.Caching = true, true, true, true
	case KindOpenAICompat:
		// Conservative: gateways vary wildly. Tools default on (most support it);
		// vision/reasoning are turned on by model-substring rules in the resolver.
		c.Tools = true
	}
	return c
}
