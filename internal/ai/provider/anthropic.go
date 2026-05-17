package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	anthropic "github.com/anthropics/anthropic-sdk-go"
	anthropicopt "github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/packages/param"
)

// AnthropicProvider speaks Claude's Messages API.
type AnthropicProvider struct {
	name         string
	client       anthropic.Client
	defaultModel string
	models       []ModelInfo
}

type AnthropicConfig struct {
	Name         string
	APIKey       string
	BaseURL      string
	DefaultModel string
	HTTPProxy    string
	Models       []ModelInfo
}

func NewAnthropic(cfg AnthropicConfig) (*AnthropicProvider, error) {
	if cfg.APIKey == "" {
		return nil, errors.New("anthropic: api key required")
	}
	opts := []anthropicopt.RequestOption{anthropicopt.WithAPIKey(cfg.APIKey)}
	if strings.TrimSpace(cfg.BaseURL) != "" {
		opts = append(opts, anthropicopt.WithBaseURL(cfg.BaseURL))
	}
	if cfg.HTTPProxy != "" {
		hc, err := proxiedClient(cfg.HTTPProxy)
		if err != nil {
			return nil, err
		}
		opts = append(opts, anthropicopt.WithHTTPClient(hc))
	}
	return &AnthropicProvider{
		name:         cfg.Name,
		client:       anthropic.NewClient(opts...),
		defaultModel: cfg.DefaultModel,
		models:       cfg.Models,
	}, nil
}

func (p *AnthropicProvider) Name() string { return p.name }
func (p *AnthropicProvider) Kind() Kind   { return KindAnthropic }

func (p *AnthropicProvider) ListModels(ctx context.Context) ([]ModelInfo, error) {
	if len(p.models) > 0 {
		return p.models, nil
	}
	// Anthropic exposes a Models.List on the beta endpoint; fall back to a
	// hard-coded baseline if discovery fails so the UI is always populated.
	return []ModelInfo{
		{ID: "claude-opus-4-5", Label: "Claude Opus 4.5", Tools: true, Vision: true, ContextWindow: 1_000_000},
		{ID: "claude-sonnet-4-5", Label: "Claude Sonnet 4.5", Tools: true, Vision: true, ContextWindow: 1_000_000},
		{ID: "claude-haiku-4-5", Label: "Claude Haiku 4.5", Tools: true, Vision: true, ContextWindow: 200_000},
	}, nil
}

func (p *AnthropicProvider) Ping(ctx context.Context) error {
	// Cheapest probe: 1-token completion with a trivial prompt.
	_, err := p.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(orDefaultStr(p.defaultModel, "claude-haiku-4-5")),
		MaxTokens: 1,
		Messages:  []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("ping"))},
	})
	return err
}

func (p *AnthropicProvider) Stream(ctx context.Context, req Request) (<-chan Event, error) {
	model := req.Model
	if model == "" {
		model = p.defaultModel
	}
	if model == "" {
		return nil, errors.New("anthropic: model not specified")
	}
	messages := buildAnthropicMessages(req)
	tools := buildAnthropicTools(req.Tools)
	maxTok := int64(req.MaxTokens)
	if maxTok <= 0 {
		maxTok = 4096
	}
	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(model),
		MaxTokens: maxTok,
		Messages:  messages,
		Tools:     tools,
	}
	if req.System != "" {
		params.System = []anthropic.TextBlockParam{{Text: req.System}}
	}
	if req.Temperature != nil {
		params.Temperature = param.NewOpt(*req.Temperature)
	}
	if req.TopP != nil {
		params.TopP = param.NewOpt(*req.TopP)
	}

	stream := p.client.Messages.NewStreaming(ctx, params)

	out := make(chan Event, 32)
	go func() {
		defer close(out)
		defer stream.Close()
		emit(out, ctx, Event{Type: EvtMessageStart})

		type pending struct {
			id   string
			name string
			args strings.Builder
		}
		toolByIndex := map[int64]*pending{}
		// Track which content blocks are extended-thinking so we can emit
		// reasoning events only for those. Anthropic interleaves thinking +
		// tool_use + text blocks; each has its own index.
		thinkingBlocks := map[int64]bool{}
		finish := ""

		for stream.Next() {
			ev := stream.Current()
			switch ev.Type {
			case "content_block_start":
				switch ev.ContentBlock.Type {
				case "tool_use":
					toolByIndex[ev.Index] = &pending{
						id:   ev.ContentBlock.ID,
						name: ev.ContentBlock.Name,
					}
					emit(out, ctx, Event{Type: EvtToolCallStart, ToolCallID: ev.ContentBlock.ID, ToolName: ev.ContentBlock.Name})
				case "thinking":
					thinkingBlocks[ev.Index] = true
					emit(out, ctx, Event{Type: EvtReasoningStart})
				}
			case "content_block_delta":
				switch ev.Delta.Type {
				case "thinking_delta":
					if ev.Delta.Thinking != "" {
						emit(out, ctx, Event{Type: EvtReasoningDelta, Text: ev.Delta.Thinking})
					}
				case "text_delta":
					if ev.Delta.Text != "" {
						emit(out, ctx, Event{Type: EvtTextDelta, Text: ev.Delta.Text})
					}
				case "input_json_delta":
					if p := toolByIndex[ev.Index]; p != nil && ev.Delta.PartialJSON != "" {
						p.args.WriteString(ev.Delta.PartialJSON)
						emit(out, ctx, Event{Type: EvtToolArgsDelta, ToolCallID: p.id, ToolName: p.name, ToolArgs: ev.Delta.PartialJSON})
					}
				}
			case "content_block_stop":
				if p, ok := toolByIndex[ev.Index]; ok {
					emit(out, ctx, Event{Type: EvtToolCallEnd, ToolCallID: p.id, ToolName: p.name, ToolArgs: p.args.String()})
					delete(toolByIndex, ev.Index)
				}
				if thinkingBlocks[ev.Index] {
					emit(out, ctx, Event{Type: EvtReasoningEnd})
					delete(thinkingBlocks, ev.Index)
				}
			case "message_delta":
				if ev.Delta.StopReason != "" {
					finish = string(ev.Delta.StopReason)
				}
				if ev.Usage.OutputTokens > 0 || ev.Usage.InputTokens > 0 {
					emit(out, ctx, Event{
						Type:         EvtUsage,
						InputTokens:  uint32(ev.Usage.InputTokens),
						OutputTokens: uint32(ev.Usage.OutputTokens),
					})
				}
			case "message_stop":
				// fall through to the final emit below
			}
		}
		if err := stream.Err(); err != nil && !errors.Is(err, context.Canceled) {
			emit(out, ctx, Event{Type: EvtError, Err: err})
		}
		emit(out, ctx, Event{Type: EvtMessageEnd, FinishReason: finish})
	}()
	return out, nil
}

// ----- helpers -----

func buildAnthropicMessages(req Request) []anthropic.MessageParam {
	out := make([]anthropic.MessageParam, 0, len(req.Messages))
	for _, m := range req.Messages {
		switch m.Role {
		case RoleUser:
			blocks := []anthropic.ContentBlockParamUnion{anthropic.NewTextBlock(collectText(m.Content))}
			out = append(out, anthropic.NewUserMessage(blocks...))
		case RoleAssistant:
			blocks := make([]anthropic.ContentBlockParamUnion, 0, 1+len(m.ToolCalls))
			if t := collectText(m.Content); t != "" {
				blocks = append(blocks, anthropic.NewTextBlock(t))
			}
			for _, tc := range m.ToolCalls {
				var input any
				if tc.Arguments != "" {
					_ = json.Unmarshal([]byte(tc.Arguments), &input)
				}
				if input == nil {
					input = map[string]any{}
				}
				blocks = append(blocks, anthropic.NewToolUseBlock(tc.ID, input, tc.Name))
			}
			out = append(out, anthropic.NewAssistantMessage(blocks...))
		case RoleTool:
			out = append(out, anthropic.NewUserMessage(
				anthropic.NewToolResultBlock(m.ToolCallID, collectText(m.Content), false),
			))
		}
	}
	return out
}

func buildAnthropicTools(tools []ToolSchema) []anthropic.ToolUnionParam {
	if len(tools) == 0 {
		return nil
	}
	out := make([]anthropic.ToolUnionParam, 0, len(tools))
	for _, t := range tools {
		schema := anthropic.ToolInputSchemaParam{}
		if len(t.JSONSchema) > 0 {
			var raw map[string]any
			if err := json.Unmarshal(t.JSONSchema, &raw); err == nil {
				if props, ok := raw["properties"]; ok {
					schema.Properties = props
				}
				if req, ok := raw["required"].([]any); ok {
					reqStrs := make([]string, 0, len(req))
					for _, r := range req {
						if s, ok := r.(string); ok {
							reqStrs = append(reqStrs, s)
						}
					}
					schema.Required = reqStrs
				}
			}
		}
		out = append(out, anthropic.ToolUnionParam{
			OfTool: &anthropic.ToolParam{
				Name:        t.Name,
				Description: param.NewOpt(t.Description),
				InputSchema: schema,
			},
		})
	}
	return out
}

func orDefaultStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// Defensive: keep fmt import alive (anthropic SDK error messages helpfully fed back).
var _ = fmt.Sprintf
