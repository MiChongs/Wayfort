package tools

import (
	"context"
	"encoding/json"
	"errors"
)

// Interactive tools are handled specially by the runner (it intercepts them by
// name in runOneTool to drive the user-facing pause). They are registered only
// so their JSON schemas reach the model; their Run funcs are never invoked, but
// return an error defensively in case the interception ever regresses.

// AskUserToolName / ExitPlanModeToolName are the canonical names the runner
// special-cases.
const (
	AskUserToolName      = "ask_user"
	ExitPlanModeToolName = "exit_plan_mode"
)

func RegisterAskUserTool(reg *Registry) {
	reg.Register(&Tool{
		Name: AskUserToolName,
		Description: "向用户提出一个需要其决策/澄清的问题，并暂停等待回答。" +
			"当关键信息缺失、存在多个可选方案、或动作有歧义时使用——不要自己瞎猜。" +
			"可附带选项（单选或多选）；也可允许用户自由文本输入。用户的回答会作为工具结果返回给你。",
		Danger: DangerLow,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"question":{"type":"string","description":"要问用户的问题（简明、具体）"},
			"options":{"type":"array","description":"可选项；省略则为纯文本提问","items":{"type":"object","properties":{
				"label":{"type":"string","description":"选项标题"},
				"description":{"type":"string","description":"选项补充说明（可选）"}},"required":["label"]}},
			"allow_multiple":{"type":"boolean","description":"是否允许多选；默认 false"},
			"allow_text":{"type":"boolean","description":"是否允许用户额外自由文本输入；默认在无选项时为 true"}},
			"required":["question"]}`),
		Run: func(_ context.Context, _ ToolCtx, _ json.RawMessage) (string, error) {
			return "", errors.New("ask_user is handled by the runner, not executed directly")
		},
	})
}

func RegisterExitPlanModeTool(reg *Registry) {
	reg.Register(&Tool{
		Name: ExitPlanModeToolName,
		Description: "在【计划模式】下，把你的完整执行计划呈现给用户审批。" +
			"仅在完成只读调研、且准备好一份分步骤、可执行的计划后调用。" +
			"用户批准后系统会自动切换到执行模式，你再按计划逐步执行；" +
			"用户驳回则请根据反馈修订计划后重新呈现。",
		Danger: DangerLow,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"plan":{"type":"string","description":"完整的执行计划（Markdown）：目标、前置检查、分步骤动作、风险与回滚、预期结果"}},
			"required":["plan"]}`),
		Run: func(_ context.Context, _ ToolCtx, _ json.RawMessage) (string, error) {
			return "", errors.New("exit_plan_mode is handled by the runner, not executed directly")
		},
	})
}
