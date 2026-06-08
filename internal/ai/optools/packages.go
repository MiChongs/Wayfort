package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/pkg"
)

func registerPackageTools(reg *tools.Registry, deps Deps) {
	if deps.Pkg == nil {
		return
	}

	nodeReadTool(reg, "pkg_status",
		"获取节点软件包管理器状态（类型 apt/dnf/yum/pacman、已装数量、可升级数量）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			s, err := deps.Pkg.Status(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("package_status", s)
		})

	nodeReadTool(reg, "pkg_upgradable",
		"列出可升级的软件包（当前版本→候选版本，是否安全更新）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			ups, err := deps.Pkg.Upgradable(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("package_updates", ups)
		})

	nodeReadTool(reg, "pkg_search",
		"在软件源中搜索软件包。",
		objSchema(nodeIDProp+`,"query":{"type":"string","description":"搜索关键词"}`, "node_id", "query"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			q, err := strArg(raw, "query")
			if err != nil {
				return "", err
			}
			ps, err := deps.Pkg.Search(ctx, t.UserID, nid, q)
			if err != nil {
				return "", err
			}
			return view("packages", ps)
		})

	nodeReadTool(reg, "pkg_info",
		"查看单个软件包的详情（版本、来源、依赖、描述）。",
		objSchema(nodeIDProp+`,"name":{"type":"string"}`, "node_id", "name"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			name, err := strArg(raw, "name")
			if err != nil {
				return "", err
			}
			info, err := deps.Pkg.Info(ctx, t.UserID, nid, name)
			if err != nil {
				return "", err
			}
			return view("package_info", info)
		})

	nodeReadTool(reg, "pkg_list_installed",
		"列出已安装的软件包，可按关键词过滤。",
		objSchema(nodeIDProp+`,"query":{"type":"string","description":"过滤关键词，可空"}`, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Query string `json:"query"`
			}
			_ = json.Unmarshal(raw, &a)
			ps, err := deps.Pkg.Installed(ctx, t.UserID, nid, a.Query)
			if err != nil {
				return "", err
			}
			return view("packages", ps)
		})

	pkgVerbNamed(reg, deps, "pkg_install", "安装软件包", pkg.VerbInstall)
	pkgVerbNamed(reg, deps, "pkg_remove", "卸载软件包", pkg.VerbRemove)
	pkgVerbNamed(reg, deps, "pkg_upgrade", "升级软件包", pkg.VerbUpgrade)
}

func pkgVerbNamed(reg *tools.Registry, deps Deps, name, label string, verb pkg.Verb) {
	nodeWriteTool(reg, name,
		fmt.Sprintf("%s。高危操作，需审批。", label),
		auth.PermPackageManage, label,
		objSchema(nodeIDProp+`,"name":{"type":"string","description":"软件包名"}`, "node_id", "name"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			pkgName, err := strArg(raw, "name")
			if err != nil {
				return "", err
			}
			res, err := deps.Pkg.Do(ctx, t.UserID, nid, pkgClaims(t), verb, pkgName)
			if err != nil {
				return "", err
			}
			return view("package_action_result", res)
		})
}
