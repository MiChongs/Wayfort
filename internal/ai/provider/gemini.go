package provider

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"google.golang.org/genai"
)

// GeminiProvider speaks Google's GenAI API.
type GeminiProvider struct {
	name         string
	client       *genai.Client
	defaultModel string
	models       []ModelInfo
}

type GeminiConfig struct {
	Name         string
	APIKey       string
	DefaultModel string
	Models       []ModelInfo
}

func NewGemini(ctx context.Context, cfg GeminiConfig) (*GeminiProvider, error) {
	if cfg.APIKey == "" {
		return nil, errors.New("gemini: api key required")
	}
	c, err := genai.NewClient(ctx, &genai.ClientConfig{APIKey: cfg.APIKey, Backend: genai.BackendGeminiAPI})
	if err != nil {
		return nil, err
	}
	return &GeminiProvider{
		name: cfg.Name, client: c,
		defaultModel: cfg.DefaultModel, models: cfg.Models,
	}, nil
}

func (p *GeminiProvider) Name() string { return p.name }
func (p *GeminiProvider) Kind() Kind   { return KindGemini }

func (p *GeminiProvider) ListModels(ctx context.Context) ([]ModelInfo, error) {
	if len(p.models) > 0 {
		return p.models, nil
	}
	return []ModelInfo{
		{ID: "gemini-2.5-pro", Label: "Gemini 2.5 Pro", Tools: true, Vision: true, ContextWindow: 2_000_000},
		{ID: "gemini-2.5-flash", Label: "Gemini 2.5 Flash", Tools: true, Vision: true, ContextWindow: 1_000_000},
	}, nil
}

func (p *GeminiProvider) Ping(ctx context.Context) error {
	model := p.defaultModel
	if model == "" {
		model = "gemini-2.5-flash"
	}
	_, err := p.client.Models.GenerateContent(ctx, model,
		[]*genai.Content{genai.NewContentFromText("ping", genai.RoleUser)},
		nil)
	return err
}

func (p *GeminiProvider) Stream(ctx context.Context, req Request) (<-chan Event, error) {
	model := req.Model
	if model == "" {
		model = p.defaultModel
	}
	if model == "" {
		return nil, errors.New("gemini: model not specified")
	}
	contents := buildGeminiContents(req)
	cfg := &genai.GenerateContentConfig{}
	if req.System != "" {
		cfg.SystemInstruction = genai.NewContentFromText(req.System, genai.RoleUser)
	}
	if len(req.Tools) > 0 {
		decls := make([]*genai.FunctionDeclaration, 0, len(req.Tools))
		for _, t := range req.Tools {
			var schema *genai.Schema
			if len(t.JSONSchema) > 0 {
				var raw map[string]any
				if err := json.Unmarshal(t.JSONSchema, &raw); err == nil {
					b, _ := json.Marshal(raw)
					schema = &genai.Schema{}
					_ = json.Unmarshal(b, schema)
				}
			}
			decls = append(decls, &genai.FunctionDeclaration{
				Name: t.Name, Description: t.Description, Parameters: schema,
			})
		}
		cfg.Tools = []*genai.Tool{{FunctionDeclarations: decls}}
	}
	if req.Temperature != nil {
		t := float32(*req.Temperature)
		cfg.Temperature = &t
	}
	if req.TopP != nil {
		t := float32(*req.TopP)
		cfg.TopP = &t
	}
	if req.MaxTokens > 0 {
		cfg.MaxOutputTokens = int32(req.MaxTokens)
	}

	out := make(chan Event, 32)
	go func() {
		defer close(out)
		emit(out, ctx, Event{Type: EvtMessageStart})
		finish := ""
		var totalIn, totalOut int32
		toolIdx := 0
		for resp, err := range p.client.Models.GenerateContentStream(ctx, model, contents, cfg) {
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					emit(out, ctx, Event{Type: EvtError, Err: err})
				}
				break
			}
			if resp == nil || len(resp.Candidates) == 0 {
				continue
			}
			cand := resp.Candidates[0]
			if cand.Content == nil {
				continue
			}
			for _, part := range cand.Content.Parts {
				if part.Text != "" {
					emit(out, ctx, Event{Type: EvtTextDelta, Text: part.Text})
				}
				if part.FunctionCall != nil {
					toolIdx++
					id := part.FunctionCall.ID
					if id == "" {
						id = part.FunctionCall.Name
					}
					argsBytes, _ := json.Marshal(part.FunctionCall.Args)
					emit(out, ctx, Event{Type: EvtToolCallStart, ToolCallID: id, ToolName: part.FunctionCall.Name})
					emit(out, ctx, Event{Type: EvtToolCallEnd, ToolCallID: id, ToolName: part.FunctionCall.Name, ToolArgs: string(argsBytes)})
				}
			}
			if cand.FinishReason != "" {
				finish = string(cand.FinishReason)
			}
			if resp.UsageMetadata != nil {
				totalIn = resp.UsageMetadata.PromptTokenCount
				totalOut = resp.UsageMetadata.CandidatesTokenCount
			}
		}
		if totalIn > 0 || totalOut > 0 {
			emit(out, ctx, Event{Type: EvtUsage, InputTokens: uint32(totalIn), OutputTokens: uint32(totalOut)})
		}
		emit(out, ctx, Event{Type: EvtMessageEnd, FinishReason: finish})
	}()
	return out, nil
}

func buildGeminiContents(req Request) []*genai.Content {
	out := make([]*genai.Content, 0, len(req.Messages))
	for _, m := range req.Messages {
		role := genai.RoleUser
		switch m.Role {
		case RoleAssistant:
			role = genai.RoleModel
		case RoleTool:
			role = genai.RoleUser
		}
		parts := []*genai.Part{}
		if t := collectText(m.Content); t != "" {
			parts = append(parts, &genai.Part{Text: t})
		}
		for _, tc := range m.ToolCalls {
			var args map[string]any
			if tc.Arguments != "" {
				_ = json.Unmarshal([]byte(tc.Arguments), &args)
			}
			parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{
				ID: tc.ID, Name: tc.Name, Args: args,
			}})
		}
		if m.Role == RoleTool {
			var resp map[string]any
			if err := json.Unmarshal([]byte(collectText(m.Content)), &resp); err != nil {
				resp = map[string]any{"result": collectText(m.Content)}
			}
			parts = append(parts, &genai.Part{FunctionResponse: &genai.FunctionResponse{
				ID: m.ToolCallID, Name: m.Name, Response: resp,
			}})
		}
		out = append(out, &genai.Content{Role: role, Parts: parts})
	}
	return out
}

// silence unused-import warnings in tight refactors
var _ = strings.TrimSpace
