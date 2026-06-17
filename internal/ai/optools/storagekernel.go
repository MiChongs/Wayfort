package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/auth"
)

func registerStorageKernelTools(reg *tools.Registry, deps Deps) {
	// ----- storage -----
	if deps.Storage != nil {
		nodeReadTool(reg, "storage_list",
			"列出节点存储：文件系统挂载点(容量/已用/inode)、块设备树、SMART 健康。",
			objSchema(nodeIDProp, "node_id"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				info, err := deps.Storage.Info(ctx, t.UserID, nid)
				if err != nil {
					return "", err
				}
				return view("storage", info)
			})

		nodeWriteTool(reg, "storage_mount",
			"挂载 /etc/fstab 中已声明的挂载点。高危操作，需审批。",
			auth.PermStorageManage, "挂载文件系统",
			objSchema(nodeIDProp+`,"target":{"type":"string","description":"挂载点路径"}`, "node_id", "target"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				target, err := strArg(raw, "target")
				if err != nil {
					return "", err
				}
				if err := deps.Storage.Mount(ctx, t.UserID, nid, storageClaims(t), target); err != nil {
					return "", err
				}
				return fmt.Sprintf("已在节点 %d 挂载 %s", nid, target), nil
			})

		nodeWriteTool(reg, "storage_unmount",
			"卸载某个挂载点。高危操作，需审批。",
			auth.PermStorageManage, "卸载文件系统",
			objSchema(nodeIDProp+`,"target":{"type":"string","description":"挂载点路径"}`, "node_id", "target"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				target, err := strArg(raw, "target")
				if err != nil {
					return "", err
				}
				if err := deps.Storage.Unmount(ctx, t.UserID, nid, storageClaims(t), target); err != nil {
					return "", err
				}
				return fmt.Sprintf("已在节点 %d 卸载 %s", nid, target), nil
			})
	}

	// ----- kernel -----
	if deps.Kernel != nil {
		nodeReadTool(reg, "kernel_info",
			"获取内核信息：版本、已加载模块、关键 sysctl 参数。",
			objSchema(nodeIDProp, "node_id"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				info, err := deps.Kernel.Info(ctx, t.UserID, nid)
				if err != nil {
					return "", err
				}
				return view("kernel", info)
			})

		nodeWriteTool(reg, "kernel_param_set",
			"设置一个内核 sysctl 参数(可选持久化到 /etc/sysctl.d)。高危操作，需审批。",
			auth.PermKernelManage, "设置 sysctl 参数",
			objSchema(nodeIDProp+`,"key":{"type":"string","description":"如 net.ipv4.ip_forward"},"value":{"type":"string"},"persist":{"type":"boolean","description":"是否写入配置持久化"}`, "node_id", "key", "value"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				var a struct {
					Key     string `json:"key"`
					Value   string `json:"value"`
					Persist bool   `json:"persist"`
				}
				if err := json.Unmarshal(raw, &a); err != nil || a.Key == "" {
					return "", fmt.Errorf("key and value required")
				}
				if err := deps.Kernel.SetSysctl(ctx, t.UserID, nid, kernelClaims(t), a.Key, a.Value, a.Persist); err != nil {
					return "", err
				}
				return fmt.Sprintf("已在节点 %d 设置 %s=%s", nid, a.Key, a.Value), nil
			})
	}

	// ----- hardware -----
	if deps.Hardware != nil {
		nodeReadTool(reg, "hardware_info",
			"获取节点硬件信息：CPU/内存/主板/BIOS/磁盘/网卡/温度等。",
			objSchema(nodeIDProp, "node_id"),
			func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
				hw, err := deps.Hardware.Info(ctx, t.UserID, nid)
				if err != nil {
					return "", err
				}
				return view("hardware", hw)
			})
	}
}
