package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/auth"
)

func registerSysUserTools(reg *tools.Registry, deps Deps) {
	if deps.SysUser == nil {
		return
	}

	nodeReadTool(reg, "sysuser_list",
		"列出节点上的系统用户（uid/gid/家目录/shell、是否系统账户、sudo 权限、当前登录）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			info, err := deps.SysUser.Info(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("users", info)
		})

	nodeWriteTool(reg, "sysuser_lock",
		"锁定/解锁某个系统账户(passwd -l/-u)。高危操作，需审批。",
		auth.PermSysUserManage, "锁定/解锁系统账户",
		objSchema(nodeIDProp+`,"user":{"type":"string"},"lock":{"type":"boolean","description":"true=锁定，false=解锁"}`, "node_id", "user", "lock"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				User string `json:"user"`
				Lock bool   `json:"lock"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.User == "" {
				return "", fmt.Errorf("user required")
			}
			if err := deps.SysUser.SetLock(ctx, t.UserID, nid, sysuserClaims(t), a.User, a.Lock); err != nil {
				return "", err
			}
			state := "解锁"
			if a.Lock {
				state = "锁定"
			}
			return fmt.Sprintf("已在节点 %d %s账户 %s", nid, state, a.User), nil
		})

	nodeWriteTool(reg, "sysuser_add_group",
		"将系统用户加入某个附加组(usermod -aG)。高危操作，需审批。",
		auth.PermSysUserManage, "将用户加入组",
		objSchema(nodeIDProp+`,"user":{"type":"string"},"group":{"type":"string"}`, "node_id", "user", "group"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				User  string `json:"user"`
				Group string `json:"group"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.User == "" || a.Group == "" {
				return "", fmt.Errorf("user and group required")
			}
			if err := deps.SysUser.AddToGroup(ctx, t.UserID, nid, sysuserClaims(t), a.User, a.Group); err != nil {
				return "", err
			}
			return fmt.Sprintf("已在节点 %d 将用户 %s 加入组 %s", nid, a.User, a.Group), nil
		})
}
