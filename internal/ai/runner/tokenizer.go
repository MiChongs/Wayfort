package runner

import (
	"strings"
	"sync"

	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	tiktoken "github.com/pkoukk/tiktoken-go"
)

// Token counting. OpenAI-family models are counted with a real BPE tokenizer
// (tiktoken); Anthropic / Gemini / compatible gateways and any tiktoken load
// failure fall back to a cheap ~4-chars-per-token heuristic. The runner always
// reconciles against provider-reported usage after each turn, so an inexact
// pending-turn estimate only affects in-loop budgeting, never billing.

var (
	encMu     sync.Mutex
	encoders  = map[string]*tiktoken.Tiktoken{}
	encFailed = map[string]bool{}
)

// getEncoder returns a cached tiktoken encoder for the encoding name, building it
// at most once. tiktoken may fetch the BPE vocab from the network on first use;
// a failed load is remembered so we degrade to the heuristic without retrying.
func getEncoder(name string) *tiktoken.Tiktoken {
	encMu.Lock()
	defer encMu.Unlock()
	if e, ok := encoders[name]; ok {
		return e
	}
	if encFailed[name] {
		return nil
	}
	e, err := tiktoken.GetEncoding(name)
	if err != nil {
		encFailed[name] = true
		return nil
	}
	encoders[name] = e
	return e
}

// encodingForModel maps a model id to its tiktoken encoding (empty = not an
// OpenAI-family model → use the heuristic).
func encodingForModel(model string) string {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "gpt-4o"), strings.Contains(m, "gpt-4.1"),
		strings.Contains(m, "gpt-5"), strings.Contains(m, "o1"),
		strings.Contains(m, "o3"), strings.Contains(m, "o4"):
		return "o200k_base"
	case strings.Contains(m, "gpt-4"), strings.Contains(m, "gpt-3.5"), strings.Contains(m, "text-embedding"):
		return "cl100k_base"
	}
	return ""
}

// countTokens estimates the token size of a message for context budgeting.
func countTokens(model string, m provider.Message) int {
	if enc := encodingForModel(model); enc != "" {
		if e := getEncoder(enc); e != nil {
			return countTokensTik(e, m)
		}
	}
	return estimateTokensHeuristic(m)
}

func countTokensTik(e *tiktoken.Tiktoken, m provider.Message) int {
	n := 0
	for _, p := range m.Content {
		if p.Text != "" {
			n += len(e.Encode(p.Text, nil, nil))
		}
	}
	for _, tc := range m.ToolCalls {
		n += len(e.Encode(tc.Name, nil, nil)) + len(e.Encode(tc.Arguments, nil, nil))
	}
	return n + 4 // per-message structural overhead
}

// estimateTokensHeuristic is the cheap ~4-chars-per-token fallback.
func estimateTokensHeuristic(m provider.Message) int {
	n := 0
	for _, p := range m.Content {
		n += len(p.Text)
	}
	for _, tc := range m.ToolCalls {
		n += len(tc.Name) + len(tc.Arguments)
	}
	return n/4 + 8
}

// CountText returns the token count of a plain string for the given model, using
// the same BPE-or-heuristic path as message counting. Exported so non-runner
// callers (e.g. the knowledge chunker) can size text without importing tiktoken
// or duplicating the encoding map.
func CountText(model, text string) int {
	if text == "" {
		return 0
	}
	if enc := encodingForModel(model); enc != "" {
		if e := getEncoder(enc); e != nil {
			return len(e.Encode(text, nil, nil))
		}
	}
	return len(text)/4 + 1
}

// WarmTokenizers pre-loads the common encoders off the request path (best-effort;
// safe to call in a goroutine at startup). If the vocab can't be fetched, the
// failure is cached and counting silently uses the heuristic.
func WarmTokenizers() {
	for _, name := range []string{"o200k_base", "cl100k_base"} {
		_ = getEncoder(name)
	}
}
