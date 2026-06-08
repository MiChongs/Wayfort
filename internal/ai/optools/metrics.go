package optools

import (
	"context"
	"encoding/json"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
)

func registerMetricsTools(reg *tools.Registry, deps Deps) {
	if deps.Perf != nil {
		nodeReadTool(reg, "perf_snapshot",
			"采集节点的实时性能快照：负载、CPU 各态占比、内存/交换、压力(PSI)、磁盘 util、网络吞吐。用于性能诊断。",
			objSchema(nodeIDProp, "node_id"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				s, err := deps.Perf.Snapshot(ctx, t.UserID, nid)
				if err != nil {
					return "", err
				}
				return view("metrics", s)
			})

		nodeReadTool(reg, "perf_dmesg",
			"读取内核环形缓冲区(dmesg)的最近若干行，用于排查 OOM、硬件错误、内核告警。",
			objSchema(nodeIDProp+`,"lines":{"type":"integer","minimum":1,"maximum":1000,"description":"行数，默认 200"}`, "node_id"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				var a struct {
					Lines int `json:"lines"`
				}
				_ = json.Unmarshal(raw, &a)
				if a.Lines == 0 {
					a.Lines = 200
				}
				d, err := deps.Perf.Dmesg(ctx, t.UserID, nid, a.Lines)
				if err != nil {
					return "", err
				}
				return view("log", d)
			})
	}
}
