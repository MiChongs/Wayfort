package provider

import (
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/ai/catalog"
)

// resolver.go centralizes model capability + pricing resolution so the runner
// (and the provider handler / health prober) all agree on what a given
// provider+model can do and what it costs — instead of scattering model-string
// sniffing across the codebase. Resolution order, most-authoritative first:
//
//	1. the operator-curated model row (Models JSON on the provider)
//	2. the static preset catalog (internal/ai/catalog), matched by kind+id
//	3. the per-kind default + model-substring heuristics
//
// Pricing additionally falls through to the runner's static price table when
// this returns nil (the runner handles that fallback).

// noToolModelSubstrings marks models we KNOW can't do tool calling. We gate on
// this denylist rather than a provider's Tools flag because several gateways
// don't report capability flags — defaulting those to "supports tools" avoids
// disabling tools for capable models.
var noToolModelSubstrings = []string{
	"embedding", "embed-", "whisper", "tts-", "dall-e", "dalle", "moderation",
	"text-davinci", "davinci-002", "babbage-002", "-instruct", "rerank",
}

func modelLacksTools(model string) bool {
	m := strings.ToLower(model)
	for _, s := range noToolModelSubstrings {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// applyModelHeuristics layers model-substring rules onto a baseline capability
// set: reasoning / vision detection + the tool denylist.
func applyModelHeuristics(caps *ModelCapabilities, model string) {
	lm := strings.ToLower(model)
	if modelLacksTools(model) {
		caps.Tools = false
	}
	if strings.Contains(lm, "reasoner") || strings.Contains(lm, "-r1") || strings.Contains(lm, "qwq") ||
		strings.Contains(lm, "deepseek-r") || strings.Contains(lm, "thinking") {
		caps.Reasoning = true
	}
	if strings.Contains(lm, "-vl") || strings.Contains(lm, "vision") || strings.Contains(lm, "llava") {
		caps.Vision = true
	}
}

func findModel(models []ModelInfo, id string) (ModelInfo, bool) {
	for _, m := range models {
		if m.ID == id {
			return m, true
		}
	}
	return ModelInfo{}, false
}

// hasMetadata reports whether a curated row carries real capability/pricing info
// (vs. a bare id saved straight from live discovery). Bare rows defer to the
// catalog + heuristics so we never wrongly disable tools on an unannotated id.
func (m ModelInfo) hasMetadata() bool {
	return m.Tools || m.Vision || m.Reasoning || m.Caching ||
		m.ContextWindow > 0 || m.MaxOutput > 0 || m.Pricing != nil
}

// ResolveCapabilities computes the capability descriptor for a provider+model.
// dbModels is the provider's curated Models list (may be nil).
func ResolveCapabilities(kind Kind, model string, dbModels []ModelInfo) ModelCapabilities {
	caps := DefaultCapabilities(kind)
	applyModelHeuristics(&caps, model)

	if mi, ok := findModel(dbModels, model); ok && mi.hasMetadata() {
		caps.Tools = mi.Tools
		caps.Vision = mi.Vision
		caps.Reasoning = mi.Reasoning
		caps.Caching = mi.Caching
		if mi.ContextWindow > 0 {
			caps.ContextWindow = mi.ContextWindow
		}
		if mi.MaxOutput > 0 {
			caps.MaxOutput = mi.MaxOutput
		}
		return caps
	}

	if mp, ok := catalog.ModelByKindAndID(kind, model); ok {
		caps.Tools = mp.Tools
		caps.Vision = caps.Vision || mp.Vision
		caps.Reasoning = caps.Reasoning || mp.Reasoning
		caps.Caching = caps.Caching || mp.Caching
		if mp.ContextWindow > 0 {
			caps.ContextWindow = mp.ContextWindow
		}
		if mp.MaxOutput > 0 {
			caps.MaxOutput = mp.MaxOutput
		}
	}
	return caps
}

// ResolvePricing returns the per-model rate to bill a turn at, or nil to defer
// to the runner's static price table. Order: curated row → preset catalog.
func ResolvePricing(kind Kind, model string, dbModels []ModelInfo) *ModelPricing {
	if mi, ok := findModel(dbModels, model); ok && mi.Pricing != nil && !mi.Pricing.IsZero() {
		return mi.Pricing
	}
	if mp, ok := catalog.ModelByKindAndID(kind, model); ok {
		pr := ModelPricing{
			InPerMTok:         mp.InPerMTok,
			OutPerMTok:        mp.OutPerMTok,
			CacheReadPerMTok:  mp.CacheReadPerMTok,
			CacheWritePerMTok: mp.CacheWritePerMTok,
		}
		if !pr.IsZero() {
			return &pr
		}
	}
	return nil
}
