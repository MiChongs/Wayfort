package tools

import (
	"context"
	"encoding/json"
	"errors"
)

// UpdatePlanToolName is the runner-intercepted tool the long-horizon agent uses
// to maintain its live execution plan (the task panel). Like ask_user /
// exit_plan_mode it is registered only so its schema reaches the model; the
// runner handles it by name and its Run func is never executed.
const UpdatePlanToolName = "update_plan"

func RegisterUpdatePlanTool(reg *Registry) {
	reg.Register(&Tool{
		Name: UpdatePlanToolName,
		Description: "维护你的执行计划（任务清单），驱动长程自主执行。接收【完整的有序任务数组】，每次整体替换当前计划（始终传全量，类似 TodoWrite）。" +
			"用法：接到多步骤目标时先调用本工具把目标拆解为全部步骤（status=pending）；开始执行某一步前把它标为 active，完成后标 done（失败 failed / 跳过 skipped），随做随更新——任何时刻只应有一个任务为 active。" +
			"计划会作为任务面板实时展示给用户。请连续自主地执行各步骤，直到全部完成再给出最终结论，不要做一步就停下等待。",
		Danger: DangerLow,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"tasks":{"type":"array","description":"完整的有序任务清单（整体替换当前计划）","items":{"type":"object","properties":{
				"title":{"type":"string","description":"任务简述（一行）"},
				"status":{"type":"string","enum":["pending","active","done","skipped","failed"],"description":"任务状态；默认 pending"},
				"detail":{"type":"string","description":"可选补充说明"}},"required":["title"]}}},
			"required":["tasks"]}`),
		Run: func(_ context.Context, _ ToolCtx, _ json.RawMessage) (string, error) {
			return "", errors.New("update_plan is handled by the runner, not executed directly")
		},
	})
}
