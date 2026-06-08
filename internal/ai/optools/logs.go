package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
)

func registerLogTools(reg *tools.Registry, deps Deps) {
	if deps.Logs == nil {
		return
	}

	nodeReadTool(reg, "logs_list",
		"列出节点上可读的日志源（syslog/messages、nginx、各 journal 单元等），供 logs_tail 引用。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			l, err := deps.Logs.List(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("log_sources", l)
		})

	nodeReadTool(reg, "logs_tail",
		"读取某个日志源的最近若干行。source 可为 'file' 或 'journal'，ref 为文件路径或 journal 单元名。",
		objSchema(nodeIDProp+`,"source":{"type":"string","enum":["file","journal"],"description":"日志来源类型"},"ref":{"type":"string","description":"文件路径或 journal 单元名"},"lines":{"type":"integer","minimum":1,"maximum":2000,"description":"行数，默认 200"}`, "node_id", "source", "ref"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Source string `json:"source"`
				Ref    string `json:"ref"`
				Lines  int    `json:"lines"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Source == "" || a.Ref == "" {
				return "", fmt.Errorf("source and ref required")
			}
			if a.Lines == 0 {
				a.Lines = 200
			}
			tail, err := deps.Logs.Tail(ctx, t.UserID, nid, a.Source, a.Ref, a.Lines)
			if err != nil {
				return "", err
			}
			return view("log", tail)
		})
}
