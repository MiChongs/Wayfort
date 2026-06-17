package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/wayfort/internal/ai/tools"
)

// registerKnowledgeTools wires the RAG retrieval + ops-knowledge distillation
// tools. Both are scoped to the running agent's attached knowledge bases
// (ToolCtx.KnowledgeBaseIDs), so an agent can only search/write bases it owns.
func registerKnowledgeTools(reg *tools.Registry, deps Deps) {
	if deps.Knowledge == nil {
		return
	}
	svc := deps.Knowledge

	// knowledge_search — semantic retrieval over the agent's knowledge bases.
	reg.Register(&tools.Tool{
		Name: "knowledge_search",
		Description: "在本智能体挂载的知识库中做语义检索,返回最相关的文档片段。用于回答需要" +
			"参考已上传文档/运维知识的问题。可选 knowledge_base_id 限定单个库。",
		Danger: tools.DangerLow,
		Schema: objSchema(
			`"query":{"type":"string","description":"检索的自然语言问题或关键词"},`+
				`"top_k":{"type":"integer","description":"返回片段数,默认 5"},`+
				`"knowledge_base_id":{"type":"integer","description":"可选:限定的知识库 ID(必须是本智能体已挂载的)"}`,
			"query"),
		Run: func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				Query string `json:"query"`
				TopK  int    `json:"top_k"`
				KBID  uint64 `json:"knowledge_base_id"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if a.Query == "" {
				return "", fmt.Errorf("query required")
			}
			if len(t.KnowledgeBaseIDs) == 0 {
				return "", fmt.Errorf("本智能体未挂载任何知识库")
			}
			targets := t.KnowledgeBaseIDs
			if a.KBID != 0 {
				if !containsU64(t.KnowledgeBaseIDs, a.KBID) {
					return "", fmt.Errorf("knowledge_base_id %d 不在本智能体允许的知识库范围内", a.KBID)
				}
				targets = []uint64{a.KBID}
			}
			hits, err := svc.SearchAcross(ctx, targets, a.Query, a.TopK)
			if err != nil {
				return "", err
			}
			return view("knowledge_search", map[string]any{"query": a.Query, "hits": hits})
		},
	})

	// distill_resolution — write a confirmed troubleshooting resolution back into
	// a knowledge base so future agents can retrieve it. Medium danger: approval
	// in normal mode. The model is instructed (seed prompts) to call this ONLY
	// after a fix is user-confirmed.
	reg.Register(&tools.Tool{
		Name: "distill_resolution",
		Description: "把一次已被用户确认有效的排障过程沉淀进知识库(问题→解决方案),供后续检索复用。" +
			"仅在修复确认生效后调用。",
		Danger: tools.DangerMedium,
		Schema: objSchema(
			`"knowledge_base_id":{"type":"integer","description":"写入的知识库 ID(必须是本智能体已挂载的)"},`+
				`"title":{"type":"string","description":"简短标题"},`+
				`"problem":{"type":"string","description":"问题现象/背景"},`+
				`"resolution":{"type":"string","description":"已验证有效的解决步骤"}`,
			"knowledge_base_id", "title", "resolution"),
		Run: func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				KBID       uint64 `json:"knowledge_base_id"`
				Title      string `json:"title"`
				Problem    string `json:"problem"`
				Resolution string `json:"resolution"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if a.KBID == 0 || a.Title == "" || a.Resolution == "" {
				return "", fmt.Errorf("knowledge_base_id, title, resolution 必填")
			}
			if !containsU64(t.KnowledgeBaseIDs, a.KBID) {
				return "", fmt.Errorf("knowledge_base_id %d 不在本智能体允许的知识库范围内", a.KBID)
			}
			text := fmt.Sprintf("# %s\n\n## 问题\n%s\n\n## 解决方案\n%s\n", a.Title, a.Problem, a.Resolution)
			source := "distilled:conv:" + t.ConvID
			docID, err := svc.IngestText(ctx, a.KBID, t.UserID, a.Title, source, "text/markdown", text, "")
			if err != nil {
				return "", err
			}
			// Embed + index in the background; status is observable in the KB UI.
			go func() { _ = svc.IngestDocument(context.Background(), docID) }()
			return fmt.Sprintf("已沉淀「%s」到知识库 %d(正在索引)。", a.Title, a.KBID), nil
		},
		DryRun: writeDryRun("沉淀排障经验到知识库"),
	})
}

func containsU64(s []uint64, v uint64) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
