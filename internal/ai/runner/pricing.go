package runner

import "strings"

// Pricing is a best-effort static price table used only to surface an estimated
// spend in the UI (TotalCostMicros). It is intentionally approximate — list
// prices change and per-org discounts vary — so the frontend renders it with a
// "~" prefix. Rates are USD per 1M tokens, stored as micro-dollars per token.
//
// Matching is longest-prefix on the model id, lowercased. Unknown models cost
// 0 (the UI then shows tokens only).
type modelRate struct {
	inPerMTok        float64 // USD per 1M fresh (uncached) input tokens
	outPerMTok       float64 // USD per 1M output tokens
	cacheReadPerMTok float64 // USD per 1M cache-read (hit) input tokens
	cacheWritePerMTok float64 // USD per 1M cache-write input tokens
}

// anthropicRate / openaiRate encode each provider's prompt-cache pricing ratios:
// Anthropic cache read = 0.1× input, cache write (5m) = 1.25× input; OpenAI
// cache read = 0.5× input and cache writes are free (no separate charge).
func anthropicRate(in, out float64) modelRate { return modelRate{in, out, in * 0.1, in * 1.25} }
func openaiRate(in, out float64) modelRate    { return modelRate{in, out, in * 0.5, 0} }

// Ordered longest-prefix first so e.g. "claude-opus-4-8" beats "claude-opus-4".
var priceTable = []struct {
	prefix string
	rate   modelRate
}{
	// Anthropic — Claude 4.5+ dropped Opus list price to $5/$25.
	{"claude-opus-4-8", anthropicRate(5, 25)},
	{"claude-opus-4-6", anthropicRate(5, 25)},
	{"claude-opus-4-5", anthropicRate(5, 25)},
	{"claude-opus-4", anthropicRate(15, 75)}, // legacy Opus 4.0/4.1
	{"claude-sonnet-4-6", anthropicRate(3, 15)},
	{"claude-sonnet-4", anthropicRate(3, 15)},
	{"claude-haiku-4-5", anthropicRate(1, 5)},
	{"claude-haiku-4", anthropicRate(1, 5)},
	{"claude-3-5-sonnet", anthropicRate(3, 15)},
	{"claude-3-5-haiku", anthropicRate(0.8, 4)},
	{"claude-3-opus", anthropicRate(15, 75)},
	{"claude-3-haiku", anthropicRate(0.25, 1.25)},
	{"claude-3", anthropicRate(3, 15)},
	// OpenAI
	{"gpt-4o-mini", openaiRate(0.15, 0.6)},
	{"gpt-4o", openaiRate(2.5, 10)},
	{"gpt-4.1-mini", openaiRate(0.4, 1.6)},
	{"gpt-4.1", openaiRate(2, 8)},
	{"o3-mini", openaiRate(1.1, 4.4)},
	{"o1-mini", openaiRate(1.1, 4.4)},
	{"o1", openaiRate(15, 60)},
	{"gpt-4-turbo", openaiRate(10, 30)},
	{"gpt-4", openaiRate(30, 60)},
	{"gpt-3.5", openaiRate(0.5, 1.5)},
	// Google
	{"gemini-2.5-pro", openaiRate(1.25, 10)},
	{"gemini-2.5-flash", openaiRate(0.3, 2.5)},
	{"gemini-1.5-pro", openaiRate(1.25, 5)},
	{"gemini-1.5-flash", openaiRate(0.075, 0.3)},
	{"gemini", openaiRate(0.3, 2.5)},
	// DeepSeek
	{"deepseek-reasoner", openaiRate(0.55, 2.19)},
	{"deepseek-chat", openaiRate(0.27, 1.1)},
	{"deepseek", openaiRate(0.27, 1.1)},
}

// costMicros returns the estimated cost in micro-dollars (1e-6 USD) for the
// given token counts (fresh input, output, cache-read hits, cache-write).
// Returns 0 when the model is unknown.
func costMicros(model string, inTok, outTok, cacheReadTok, cacheWriteTok uint32) uint64 {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return 0
	}
	var best modelRate
	var bestLen int
	for _, e := range priceTable {
		if strings.Contains(m, e.prefix) && len(e.prefix) > bestLen {
			best = e.rate
			bestLen = len(e.prefix)
		}
	}
	if bestLen == 0 {
		return 0
	}
	// rate is USD / 1e6 tokens → micro-dollars / token = rate.
	cost := float64(inTok)*best.inPerMTok +
		float64(outTok)*best.outPerMTok +
		float64(cacheReadTok)*best.cacheReadPerMTok +
		float64(cacheWriteTok)*best.cacheWritePerMTok
	if cost < 0 {
		return 0
	}
	return uint64(cost + 0.5)
}
