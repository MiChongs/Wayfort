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
	inPerMTok  float64 // USD per 1M input tokens
	outPerMTok float64 // USD per 1M output tokens
}

// Ordered longest-prefix first so e.g. "claude-3-5-haiku" beats "claude-3".
var priceTable = []struct {
	prefix string
	rate   modelRate
}{
	// Anthropic
	{"claude-opus-4", modelRate{15, 75}},
	{"claude-sonnet-4", modelRate{3, 15}},
	{"claude-haiku-4", modelRate{1, 5}},
	{"claude-3-5-sonnet", modelRate{3, 15}},
	{"claude-3-5-haiku", modelRate{0.8, 4}},
	{"claude-3-opus", modelRate{15, 75}},
	{"claude-3-haiku", modelRate{0.25, 1.25}},
	{"claude-3", modelRate{3, 15}},
	// OpenAI
	{"gpt-4o-mini", modelRate{0.15, 0.6}},
	{"gpt-4o", modelRate{2.5, 10}},
	{"gpt-4.1-mini", modelRate{0.4, 1.6}},
	{"gpt-4.1", modelRate{2, 8}},
	{"o3-mini", modelRate{1.1, 4.4}},
	{"o1-mini", modelRate{1.1, 4.4}},
	{"o1", modelRate{15, 60}},
	{"gpt-4-turbo", modelRate{10, 30}},
	{"gpt-4", modelRate{30, 60}},
	{"gpt-3.5", modelRate{0.5, 1.5}},
	// Google
	{"gemini-2.5-pro", modelRate{1.25, 10}},
	{"gemini-2.5-flash", modelRate{0.3, 2.5}},
	{"gemini-1.5-pro", modelRate{1.25, 5}},
	{"gemini-1.5-flash", modelRate{0.075, 0.3}},
	{"gemini", modelRate{0.3, 2.5}},
	// DeepSeek
	{"deepseek-reasoner", modelRate{0.55, 2.19}},
	{"deepseek-chat", modelRate{0.27, 1.1}},
	{"deepseek", modelRate{0.27, 1.1}},
}

// costMicros returns the estimated cost in micro-dollars (1e-6 USD) for the
// given token counts. Returns 0 when the model is unknown.
func costMicros(model string, inTok, outTok uint32) uint64 {
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
	// rate is USD / 1e6 tokens → micro-dollars / token = rate. So
	// micro-dollars = tokens * rate.
	cost := float64(inTok)*best.inPerMTok + float64(outTok)*best.outPerMTok
	if cost < 0 {
		return 0
	}
	return uint64(cost + 0.5)
}
