package optools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/protocols/oss"
)

// withStore opens the object store for a node, runs fn, and always releases the
// proxy-chain closer. The gate has already verified the caller's "connect"
// access to the node before Run is invoked.
func withStore(ctx context.Context, deps Deps, nid uint64, fn func(oss.ObjectStore) (string, error)) (string, error) {
	store, _, closer, err := deps.OSS.Open(ctx, nid)
	if err != nil {
		return "", err
	}
	defer closer()
	return fn(store)
}

func registerOSSTools(reg *tools.Registry, deps Deps) {
	if deps.OSS == nil {
		return
	}

	nodeReadTool(reg, "oss_list_buckets",
		"列出对象存储节点上凭据可见的所有桶（aliyun OSS / 腾讯 COS / S3 兼容）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			return withStore(ctx, deps, nid, func(st oss.ObjectStore) (string, error) {
				bs, err := st.ListBuckets(ctx)
				if err != nil {
					return "", err
				}
				return view("oss_buckets", bs)
			})
		})

	nodeReadTool(reg, "oss_list_objects",
		"列出某个桶在给定前缀下的对象与子目录（按 / 分隔为文件夹），支持分页 token。",
		objSchema(nodeIDProp+`,"bucket":{"type":"string"},"prefix":{"type":"string","description":"键前缀，可空"},"token":{"type":"string","description":"分页游标，可空"},"max_keys":{"type":"integer","minimum":1,"maximum":1000,"description":"单页上限，默认 100"}`, "node_id", "bucket"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Bucket  string `json:"bucket"`
				Prefix  string `json:"prefix"`
				Token   string `json:"token"`
				MaxKeys int    `json:"max_keys"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Bucket == "" {
				return "", fmt.Errorf("bucket required")
			}
			if a.MaxKeys == 0 {
				a.MaxKeys = 100
			}
			return withStore(ctx, deps, nid, func(st oss.ObjectStore) (string, error) {
				res, err := st.ListObjects(ctx, a.Bucket, a.Prefix, "/", a.Token, a.MaxKeys)
				if err != nil {
					return "", err
				}
				return view("oss_objects", res)
			})
		})

	nodeReadTool(reg, "oss_stat",
		"查看单个对象的元数据（大小、内容类型、ETag、最后修改时间、存储类）。",
		objSchema(nodeIDProp+`,"bucket":{"type":"string"},"key":{"type":"string","description":"对象键"}`, "node_id", "bucket", "key"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Bucket string `json:"bucket"`
				Key    string `json:"key"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Bucket == "" || a.Key == "" {
				return "", fmt.Errorf("bucket and key required")
			}
			return withStore(ctx, deps, nid, func(st oss.ObjectStore) (string, error) {
				meta, err := st.HeadObject(ctx, a.Bucket, a.Key)
				if err != nil {
					return "", err
				}
				return view("oss_stat", meta)
			})
		})

	nodeReadTool(reg, "oss_read",
		"读取一个文本对象的前若干字节内容（用于预览配置/日志等小文件）。",
		objSchema(nodeIDProp+`,"bucket":{"type":"string"},"key":{"type":"string"}`, "node_id", "bucket", "key"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Bucket string `json:"bucket"`
				Key    string `json:"key"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Bucket == "" || a.Key == "" {
				return "", fmt.Errorf("bucket and key required")
			}
			return withStore(ctx, deps, nid, func(st oss.ObjectStore) (string, error) {
				rc, err := st.GetObjectRange(ctx, a.Bucket, a.Key, 0, int64(tools.MaxOutputBytes-1))
				if err != nil {
					return "", err
				}
				defer rc.Close()
				body, err := io.ReadAll(io.LimitReader(rc, tools.MaxOutputBytes))
				if err != nil {
					return "", err
				}
				out, _ := tools.Truncate(string(body))
				return out, nil
			})
		})

	ossWrite(reg, deps, "oss_put",
		"向桶写入/覆盖一个文本对象。高危操作，需审批。",
		"上传对象",
		objSchema(nodeIDProp+`,"bucket":{"type":"string"},"key":{"type":"string"},"content":{"type":"string","description":"文本内容"},"content_type":{"type":"string","description":"MIME 类型，可空"}`, "node_id", "bucket", "key", "content"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64, st oss.ObjectStore) (string, error) {
			var a struct {
				Bucket      string `json:"bucket"`
				Key         string `json:"key"`
				Content     string `json:"content"`
				ContentType string `json:"content_type"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Bucket == "" || a.Key == "" {
				return "", fmt.Errorf("bucket and key required")
			}
			if a.ContentType == "" {
				a.ContentType = "text/plain"
			}
			r := strings.NewReader(a.Content)
			if err := st.PutObject(ctx, a.Bucket, a.Key, r, int64(len(a.Content)), a.ContentType); err != nil {
				return "", err
			}
			return fmt.Sprintf("已写入 %s/%s（%d 字节）", a.Bucket, a.Key, len(a.Content)), nil
		})

	ossWrite(reg, deps, "oss_delete",
		"删除桶中的一个对象。高危操作，需审批。",
		"删除对象",
		objSchema(nodeIDProp+`,"bucket":{"type":"string"},"key":{"type":"string"}`, "node_id", "bucket", "key"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64, st oss.ObjectStore) (string, error) {
			var a struct {
				Bucket string `json:"bucket"`
				Key    string `json:"key"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Bucket == "" || a.Key == "" {
				return "", fmt.Errorf("bucket and key required")
			}
			if err := st.DeleteObject(ctx, a.Bucket, a.Key); err != nil {
				return "", err
			}
			return fmt.Sprintf("已删除 %s/%s", a.Bucket, a.Key), nil
		})

	ossWrite(reg, deps, "oss_copy",
		"在对象存储内服务端复制一个对象（可跨桶）。高危操作，需审批。",
		"复制对象",
		objSchema(nodeIDProp+`,"src_bucket":{"type":"string"},"src_key":{"type":"string"},"dst_bucket":{"type":"string"},"dst_key":{"type":"string"}`, "node_id", "src_bucket", "src_key", "dst_bucket", "dst_key"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64, st oss.ObjectStore) (string, error) {
			var a struct {
				SrcBucket string `json:"src_bucket"`
				SrcKey    string `json:"src_key"`
				DstBucket string `json:"dst_bucket"`
				DstKey    string `json:"dst_key"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.SrcBucket == "" || a.SrcKey == "" || a.DstBucket == "" || a.DstKey == "" {
				return "", fmt.Errorf("src/dst bucket and key required")
			}
			if err := st.CopyObject(ctx, a.SrcBucket, a.SrcKey, a.DstBucket, a.DstKey); err != nil {
				return "", err
			}
			return fmt.Sprintf("已复制 %s/%s → %s/%s", a.SrcBucket, a.SrcKey, a.DstBucket, a.DstKey), nil
		})
}

// ossWrite registers a high-danger OSS mutation that needs an open store. RBAC
// perm is empty (gated by asset "connect" + approval); the store is opened and
// always released around the closure.
func ossWrite(reg *tools.Registry, deps Deps, name, desc, dryAction string, schema json.RawMessage,
	run func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64, st oss.ObjectStore) (string, error)) {
	nodeWriteTool(reg, name, desc, "", dryAction, schema,
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			return withStore(ctx, deps, nid, func(st oss.ObjectStore) (string, error) {
				return run(ctx, t, raw, nid, st)
			})
		})
}
