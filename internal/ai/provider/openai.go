package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	openai "github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/shared"
	"github.com/openai/openai-go/shared/constant"
	"golang.org/x/net/proxy"
)

// OpenAIProvider speaks OpenAI's Chat Completions API. It also handles OpenAI-
// compatible gateways (NewAPI / 硅基流动 / DeepSeek / Moonshot / 通义 / Ollama)
// when given a custom BaseURL — they share the same wire protocol.
type OpenAIProvider struct {
	name    string
	kind    Kind
	client  openai.Client
	defaultModel string
	models  []ModelInfo
}

// OpenAIConfig captures everything we need to build a client.
type OpenAIConfig struct {
	Name         string
	Kind         Kind // KindOpenAI or KindOpenAICompatible
	APIKey       string
	BaseURL      string
	DefaultModel string
	HTTPProxy    string  // optional: http(s)://... or socks5://...
	Models       []ModelInfo
}

func NewOpenAI(cfg OpenAIConfig) (*OpenAIProvider, error) {
	if cfg.APIKey == "" {
		return nil, errors.New("openai: api key required")
	}
	opts := []option.RequestOption{option.WithAPIKey(cfg.APIKey)}
	if strings.TrimSpace(cfg.BaseURL) != "" {
		opts = append(opts, option.WithBaseURL(cfg.BaseURL))
	}
	if cfg.HTTPProxy != "" {
		hc, err := proxiedClient(cfg.HTTPProxy)
		if err != nil {
			return nil, err
		}
		opts = append(opts, option.WithHTTPClient(hc))
	}
	c := openai.NewClient(opts...)
	if cfg.Kind == "" {
		cfg.Kind = KindOpenAI
	}
	return &OpenAIProvider{
		name: cfg.Name, kind: cfg.Kind, client: c,
		defaultModel: cfg.DefaultModel, models: cfg.Models,
	}, nil
}

func (p *OpenAIProvider) Name() string { return p.name }
func (p *OpenAIProvider) Kind() Kind   { return p.kind }

func (p *OpenAIProvider) ListModels(ctx context.Context) ([]ModelInfo, error) {
	if len(p.models) > 0 {
		return p.models, nil
	}
	// Best-effort: ask upstream for the live list.
	page, err := p.client.Models.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]ModelInfo, 0, len(page.Data))
	for _, m := range page.Data {
		out = append(out, ModelInfo{ID: m.ID, Label: m.ID, Tools: true})
	}
	return out, nil
}

func (p *OpenAIProvider) Ping(ctx context.Context) error {
	_, err := p.ListModels(ctx)
	return err
}

func (p *OpenAIProvider) Stream(ctx context.Context, req Request) (<-chan Event, error) {
	model := req.Model
	if model == "" {
		model = p.defaultModel
	}
	if model == "" {
		return nil, errors.New("openai: model not specified")
	}

	messages := buildOpenAIMessages(req)
	tools := buildOpenAITools(req.Tools)

	params := openai.ChatCompletionNewParams{
		Model:    openai.ChatModel(model),
		Messages: messages,
		Tools:    tools,
	}
	if req.Temperature != nil {
		params.Temperature = param.NewOpt(*req.Temperature)
	}
	if req.TopP != nil {
		params.TopP = param.NewOpt(*req.TopP)
	}
	if req.MaxTokens > 0 {
		params.MaxTokens = param.NewOpt(int64(req.MaxTokens))
	}

	stream := p.client.Chat.Completions.NewStreaming(ctx, params)
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
		finish := ""
		// o-series models + many OpenAI-compatible gateways (DeepSeek-R1,
		// Moonshot k1, 通义 qwq) put their chain-of-thought in
		// `delta.reasoning_content`. SDK v1.12 doesn't expose it as a typed
		// field, so we sniff the raw delta JSON. Switching from reasoning
		// to main content emits a reasoning_end so the UI can collapse the
		// "thinking" card.
		reasoningOpen := false

		for stream.Next() {
			chunk := stream.Current()
			if len(chunk.Choices) == 0 {
				continue
			}
			choice := chunk.Choices[0]

			// Sniff reasoning_content from raw delta JSON.
			if raw := choice.Delta.RawJSON(); raw != "" {
				var probe struct {
					ReasoningContent string `json:"reasoning_content"`
					Reasoning        string `json:"reasoning"`
				}
				if json.Unmarshal([]byte(raw), &probe) == nil {
					rc := probe.ReasoningContent
					if rc == "" {
						rc = probe.Reasoning
					}
					if rc != "" {
						if !reasoningOpen {
							reasoningOpen = true
							emit(out, ctx, Event{Type: EvtReasoningStart})
						}
						emit(out, ctx, Event{Type: EvtReasoningDelta, Text: rc})
					} else if reasoningOpen && choice.Delta.Content != "" {
						reasoningOpen = false
						emit(out, ctx, Event{Type: EvtReasoningEnd})
					}
				}
			}

			if choice.Delta.Content != "" {
				emit(out, ctx, Event{Type: EvtTextDelta, Text: choice.Delta.Content})
			}
			for _, tc := range choice.Delta.ToolCalls {
				p, ok := toolByIndex[tc.Index]
				if !ok {
					p = &pending{}
					toolByIndex[tc.Index] = p
					emit(out, ctx, Event{Type: EvtToolCallStart, ToolCallID: tc.ID, ToolName: tc.Function.Name})
				}
				if tc.ID != "" {
					p.id = tc.ID
				}
				if tc.Function.Name != "" {
					p.name = tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					p.args.WriteString(tc.Function.Arguments)
					emit(out, ctx, Event{Type: EvtToolArgsDelta, ToolCallID: p.id, ToolName: p.name, ToolArgs: tc.Function.Arguments})
				}
			}
			if choice.FinishReason != "" {
				finish = string(choice.FinishReason)
			}
			if chunk.Usage.TotalTokens > 0 {
				emit(out, ctx, Event{
					Type:         EvtUsage,
					InputTokens:  uint32(chunk.Usage.PromptTokens),
					OutputTokens: uint32(chunk.Usage.CompletionTokens),
				})
			}
		}
		// Flush completed tool calls.
		for _, p := range toolByIndex {
			emit(out, ctx, Event{Type: EvtToolCallEnd, ToolCallID: p.id, ToolName: p.name, ToolArgs: p.args.String()})
		}
		// If reasoning never transitioned to main content (e.g. answer was all
		// reasoning, or stream cut off), close the reasoning block now so the
		// UI can collapse it.
		if reasoningOpen {
			emit(out, ctx, Event{Type: EvtReasoningEnd})
		}
		if err := stream.Err(); err != nil && !errors.Is(err, context.Canceled) {
			emit(out, ctx, Event{Type: EvtError, Err: err})
		}
		emit(out, ctx, Event{Type: EvtMessageEnd, FinishReason: finish})
	}()
	return out, nil
}

// ----- helpers -----

func buildOpenAIMessages(req Request) []openai.ChatCompletionMessageParamUnion {
	out := make([]openai.ChatCompletionMessageParamUnion, 0, len(req.Messages)+1)
	if req.System != "" {
		out = append(out, openai.SystemMessage(req.System))
	}
	for _, m := range req.Messages {
		text := collectText(m.Content)
		switch m.Role {
		case RoleSystem:
			out = append(out, openai.SystemMessage(text))
		case RoleUser:
			imgs := collectImages(m.Content)
			if len(imgs) == 0 {
				out = append(out, openai.UserMessage(text))
			} else {
				parts := make([]openai.ChatCompletionContentPartUnionParam, 0, 1+len(imgs))
				if text != "" {
					parts = append(parts, openai.TextContentPart(text))
				}
				for _, img := range imgs {
					parts = append(parts, openai.ImageContentPart(
						openai.ChatCompletionContentPartImageImageURLParam{URL: img},
					))
				}
				out = append(out, openai.UserMessage(parts))
			}
		case RoleAssistant:
			if len(m.ToolCalls) > 0 {
				calls := make([]openai.ChatCompletionMessageToolCallParam, 0, len(m.ToolCalls))
				for _, tc := range m.ToolCalls {
					calls = append(calls, openai.ChatCompletionMessageToolCallParam{
						ID: tc.ID,
						Function: openai.ChatCompletionMessageToolCallFunctionParam{
							Name:      tc.Name,
							Arguments: tc.Arguments,
						},
					})
				}
				asst := openai.ChatCompletionAssistantMessageParam{
					ToolCalls: calls,
				}
				if text != "" {
					asst.Content = openai.ChatCompletionAssistantMessageParamContentUnion{
						OfString: param.NewOpt(text),
					}
				}
				out = append(out, openai.ChatCompletionMessageParamUnion{OfAssistant: &asst})
			} else {
				out = append(out, openai.AssistantMessage(text))
			}
		case RoleTool:
			out = append(out, openai.ToolMessage(text, m.ToolCallID))
		}
	}
	return out
}

func buildOpenAITools(tools []ToolSchema) []openai.ChatCompletionToolParam {
	if len(tools) == 0 {
		return nil
	}
	out := make([]openai.ChatCompletionToolParam, 0, len(tools))
	for _, t := range tools {
		var params shared.FunctionParameters
		if len(t.JSONSchema) > 0 {
			_ = json.Unmarshal(t.JSONSchema, &params)
		}
		out = append(out, openai.ChatCompletionToolParam{
			Type: constant.Function("function"),
			Function: shared.FunctionDefinitionParam{
				Name:        t.Name,
				Description: param.NewOpt(t.Description),
				Parameters:  params,
			},
		})
	}
	return out
}

func collectText(parts []ContentPart) string {
	if len(parts) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, p := range parts {
		if p.Type == "text" || p.Type == "" {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

// collectImages returns the image data (URLs / data: URLs) from a message's
// content parts. Shared by every provider that supports vision input.
func collectImages(parts []ContentPart) []string {
	var out []string
	for _, p := range parts {
		if (p.Type == "image_url" || p.Type == "image") && p.ImageURL != "" {
			out = append(out, p.ImageURL)
		}
	}
	return out
}

// parseDataURL splits "data:<media-type>;base64,<data>" into the media type and
// the raw base64 payload. ok is false for non-base64 / non-data URLs.
func parseDataURL(u string) (mediaType, data string, ok bool) {
	if !strings.HasPrefix(u, "data:") {
		return "", "", false
	}
	rest := u[len("data:"):]
	comma := strings.IndexByte(rest, ',')
	if comma < 0 {
		return "", "", false
	}
	meta := rest[:comma]
	data = rest[comma+1:]
	if !strings.Contains(meta, "base64") {
		return "", "", false
	}
	mediaType = meta
	if i := strings.IndexByte(meta, ';'); i >= 0 {
		mediaType = meta[:i]
	}
	if mediaType == "" {
		mediaType = "image/png"
	}
	return mediaType, data, true
}

func emit(ch chan<- Event, ctx context.Context, e Event) {
	select {
	case ch <- e:
	case <-ctx.Done():
	}
}

func proxiedClient(rawURL string) (*http.Client, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("proxy url: %w", err)
	}
	switch u.Scheme {
	case "http", "https":
		return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(u)}}, nil
	case "socks5":
		auth := (*proxy.Auth)(nil)
		if u.User != nil {
			pwd, _ := u.User.Password()
			auth = &proxy.Auth{User: u.User.Username(), Password: pwd}
		}
		d, err := proxy.SOCKS5("tcp", u.Host, auth, proxy.Direct)
		if err != nil {
			return nil, err
		}
		t := &http.Transport{}
		if cd, ok := d.(proxy.ContextDialer); ok {
			t.DialContext = cd.DialContext
		}
		return &http.Client{Transport: t}, nil
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q", u.Scheme)
	}
}
