package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
)

// RegisterSSHTools adds the three SSH-execution tools:
//   - ssh_exec        : arbitrary command (HIGH danger, requires approval in normal mode)
//   - ssh_exec_readonly: whitelisted prefix-only commands (LOW)
//   - health_check    : canned diagnostic bundle (LOW)
func RegisterSSHTools(reg *Registry, deps Deps, readonlyAllow []string) {
	allow := normaliseAllow(readonlyAllow)

	reg.Register(&Tool{
		Name:        "ssh_exec",
		Description: "在指定节点上执行任意 shell 命令。会产生实际变更，需用户确认。",
		Danger:      DangerHigh,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"command":{"type":"string","description":"要执行的命令（单条 shell 行）"},
			"timeout_sec":{"type":"integer","description":"最大执行秒数，默认 30","minimum":1,"maximum":600}},
			"required":["node_id","command"]}`),
		Run:    sshExecRunner(deps, false, nil),
		DryRun: sshExecDryRun,
	})

	reg.Register(&Tool{
		Name:        "ssh_exec_readonly",
		Description: "只允许预设白名单（ls/cat/grep/uptime/free/df/du/ps/top/journalctl/systemctl status/docker ps/kubectl get 等）开头的命令，安全的只读诊断使用。",
		Danger:      DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"command":{"type":"string"},
			"timeout_sec":{"type":"integer","minimum":1,"maximum":120}},
			"required":["node_id","command"]}`),
		Run: sshExecRunner(deps, true, allow),
	})

	reg.Register(&Tool{
		Name:        "health_check",
		Description: "一次性收集节点的系统健康指标：uptime / free -m / df -h / 负载 / 当前登录会话。",
		Danger:      DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"}},
			"required":["node_id"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.NodeID == 0 {
				return "", fmt.Errorf("node_id required")
			}
			cmd := "echo '== uptime ==' && uptime && echo '== free ==' && free -m 2>/dev/null && echo '== df ==' && df -h 2>/dev/null && echo '== load ==' && cat /proc/loadavg 2>/dev/null && echo '== who ==' && who 2>/dev/null"
			out, errOut, exit, err := deps.NodeRunner.Exec(ctx, tctx.UserID, a.NodeID, cmd, 30)
			if err != nil {
				return "", err
			}
			body, _ := Truncate(out + "\n" + errOut)
			return body + fmt.Sprintf("\n[exit=%d]", exit), nil
		},
	})
}

func sshExecRunner(deps Deps, readonly bool, allow []string) RunFn {
	return func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
		var a struct {
			NodeID  uint64 `json:"node_id"`
			Command string `json:"command"`
			Timeout int    `json:"timeout_sec"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return "", err
		}
		if a.NodeID == 0 || strings.TrimSpace(a.Command) == "" {
			return "", fmt.Errorf("node_id and command required")
		}
		if readonly && !commandAllowed(a.Command, allow) {
			return "", fmt.Errorf("command %q not in readonly allow-list", firstToken(a.Command))
		}
		if a.Timeout <= 0 {
			a.Timeout = 30
		}
		out, errOut, exit, err := deps.NodeRunner.Exec(ctx, tctx.UserID, a.NodeID, a.Command, a.Timeout)
		if err != nil {
			return "", err
		}
		merged := out
		if errOut != "" {
			merged += "\n[stderr]\n" + errOut
		}
		body, _ := Truncate(merged)
		return body + fmt.Sprintf("\n[exit=%d]", exit), nil
	}
}

func sshExecDryRun(_ context.Context, _ ToolCtx, raw json.RawMessage) (string, error) {
	var a struct {
		NodeID  uint64 `json:"node_id"`
		Command string `json:"command"`
	}
	_ = json.Unmarshal(raw, &a)
	return fmt.Sprintf("[plan mode] would execute on node %d: %s", a.NodeID, a.Command), nil
}

func normaliseAllow(in []string) []string {
	if len(in) == 0 {
		return []string{
			"ls", "cat", "grep", "tail", "head", "uptime", "free", "df", "du",
			"ps", "top -bn1", "journalctl -n", "systemctl status",
			"docker ps", "docker images", "kubectl get", "kubectl describe",
			"ip a", "ip r", "ss -tunlp", "iostat", "vmstat", "netstat -tunlp",
		}
	}
	return in
}

func commandAllowed(cmd string, allow []string) bool {
	trimmed := strings.TrimSpace(cmd)
	for _, prefix := range allow {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

func firstToken(cmd string) string {
	for i, c := range cmd {
		if c == ' ' {
			return cmd[:i]
		}
	}
	return cmd
}
