package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
)

// Maximum bytes a single sftp_read call may return (256 KB is plenty for logs/configs).
const SFTPReadMaxBytes int64 = 256 * 1024

func RegisterSFTPTools(reg *Registry, deps Deps) {
	reg.Register(&Tool{
		Name:        "sftp_list",
		Description: "通过 SFTP 列出节点上指定目录的条目。只读。",
		Danger:      DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"path":{"type":"string","description":"绝对路径，默认 /"}},
			"required":["node_id"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
				Path   string `json:"path"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if a.Path == "" {
				a.Path = "/"
			}
			entries, err := deps.SFTPRunner.ListDir(ctx, tctx.UserID, a.NodeID, a.Path)
			if err != nil {
				return "", err
			}
			b, _ := json.Marshal(map[string]any{"path": a.Path, "entries": entries})
			out, _ := Truncate(string(b))
			return out, nil
		},
	})

	reg.Register(&Tool{
		Name:        "sftp_read",
		Description: "读取节点上的文件内容（UTF-8 文本），最大 256KB。",
		Danger:      DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"path":{"type":"string"}},
			"required":["node_id","path"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
				Path   string `json:"path"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if a.Path == "" {
				return "", fmt.Errorf("path required")
			}
			data, err := deps.SFTPRunner.ReadFile(ctx, tctx.UserID, a.NodeID, a.Path, SFTPReadMaxBytes)
			if err != nil {
				return "", err
			}
			body, _ := Truncate(string(data))
			return body, nil
		},
	})

	reg.Register(&Tool{
		Name:        "sftp_write",
		Description: "把内容写入节点上的文件。content_base64 为 base64 编码原始字节。会真正改变远端文件，需用户确认。",
		Danger:      DangerHigh,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"path":{"type":"string"},
			"content_base64":{"type":"string"},
			"mode":{"type":"integer","description":"如 420 (0644)"}},
			"required":["node_id","path","content_base64"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID  uint64 `json:"node_id"`
				Path    string `json:"path"`
				Content string `json:"content_base64"`
				Mode    uint32 `json:"mode"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if a.Mode == 0 {
				a.Mode = 0o644
			}
			data, err := base64.StdEncoding.DecodeString(a.Content)
			if err != nil {
				return "", fmt.Errorf("bad base64: %w", err)
			}
			if err := deps.SFTPRunner.WriteFile(ctx, tctx.UserID, a.NodeID, a.Path, data, a.Mode); err != nil {
				return "", err
			}
			return fmt.Sprintf("wrote %d bytes to %s", len(data), a.Path), nil
		},
		DryRun: func(_ context.Context, _ ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
				Path   string `json:"path"`
			}
			_ = json.Unmarshal(raw, &a)
			return fmt.Sprintf("[plan mode] would write to %s on node %d", a.Path, a.NodeID), nil
		},
	})

	reg.Register(&Tool{
		Name:        "sftp_delete",
		Description: "删除节点上的文件或目录。需用户确认。",
		Danger:      DangerHigh,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"path":{"type":"string"}},
			"required":["node_id","path"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
				Path   string `json:"path"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if err := deps.SFTPRunner.DeletePath(ctx, tctx.UserID, a.NodeID, a.Path); err != nil {
				return "", err
			}
			return fmt.Sprintf("deleted %s on node %d", a.Path, a.NodeID), nil
		},
		DryRun: func(_ context.Context, _ ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
				Path   string `json:"path"`
			}
			_ = json.Unmarshal(raw, &a)
			return fmt.Sprintf("[plan mode] would delete %s on node %d", a.Path, a.NodeID), nil
		},
	})
}
