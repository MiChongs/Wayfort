package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/process"
)

func registerProcessTools(reg *tools.Registry, deps Deps) {
	if deps.Process == nil {
		return
	}

	nodeReadTool(reg, "process_list",
		"列出节点上的进程（按 CPU/内存/RSS/PID 排序）。返回 PID、用户、CPU%、内存%、RSS、状态、命令行。",
		objSchema(nodeIDProp+`,"by":{"type":"string","enum":["cpu","mem","rss","pid"],"description":"排序字段，默认 cpu"}`, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				By string `json:"by"`
			}
			_ = json.Unmarshal(raw, &a)
			list, err := deps.Process.List(ctx, t.UserID, nid, a.By)
			if err != nil {
				return "", err
			}
			return view("process", list)
		})

	nodeReadTool(reg, "process_detail",
		"查看单个进程的详细信息（打开文件数、线程、环境、cgroup、限额等）。",
		objSchema(nodeIDProp+`,"pid":{"type":"integer","description":"进程 PID"}`, "node_id", "pid"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				PID int `json:"pid"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.PID <= 0 {
				return "", fmt.Errorf("pid required")
			}
			d, err := deps.Process.Detail(ctx, t.UserID, nid, a.PID)
			if err != nil {
				return "", err
			}
			return view("process_detail", d)
		})

	nodeWriteTool(reg, "process_signal",
		"向进程发送信号（TERM/KILL/HUP/INT/STOP/CONT/USR1/USR2/QUIT）。高危操作，需审批。",
		auth.PermProcessManage, "向进程发送信号",
		objSchema(nodeIDProp+`,"pid":{"type":"integer"},"signal":{"type":"string","enum":["TERM","KILL","HUP","INT","STOP","CONT","USR1","USR2","QUIT"],"description":"信号名，默认 TERM"}`, "node_id", "pid"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				PID    int    `json:"pid"`
				Signal string `json:"signal"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.PID <= 0 {
				return "", fmt.Errorf("pid required")
			}
			sig := process.Signal(a.Signal)
			if sig == "" {
				sig = process.SigTERM
			}
			if !process.ValidSignal(sig) {
				return "", fmt.Errorf("unsupported signal %q", a.Signal)
			}
			if err := deps.Process.Signal(ctx, t.UserID, nid, processClaims(t), a.PID, sig); err != nil {
				return "", err
			}
			return fmt.Sprintf("已向节点 %d 的进程 %d 发送信号 %s", nid, a.PID, sig), nil
		})

	nodeWriteTool(reg, "process_renice",
		"调整进程的调度优先级 nice 值（-20..19，越小优先级越高）。高危操作，需审批。",
		auth.PermProcessManage, "调整进程 nice 值",
		objSchema(nodeIDProp+`,"pid":{"type":"integer"},"nice":{"type":"integer","minimum":-20,"maximum":19}`, "node_id", "pid", "nice"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				PID  int `json:"pid"`
				Nice int `json:"nice"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.PID <= 0 {
				return "", fmt.Errorf("pid required")
			}
			if err := deps.Process.Renice(ctx, t.UserID, nid, processClaims(t), a.PID, a.Nice); err != nil {
				return "", err
			}
			return fmt.Sprintf("已将节点 %d 的进程 %d nice 调整为 %d", nid, a.PID, a.Nice), nil
		})
}
