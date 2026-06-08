package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/docker"
)

func registerDockerTools(reg *tools.Registry, deps Deps) {
	if deps.Docker == nil {
		return
	}

	nodeReadTool(reg, "docker_status",
		"获取节点 Docker 守护进程状态（版本、容器/镜像计数、存储驱动、磁盘占用）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			s, err := deps.Docker.Status(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("docker_status", s)
		})

	nodeReadTool(reg, "docker_ps",
		"列出节点上的 Docker 容器（含已退出），返回名称、镜像、状态、端口、创建时间。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			cs, err := deps.Docker.ListContainers(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("docker_containers", cs)
		})

	nodeReadTool(reg, "docker_images",
		"列出节点上的 Docker 镜像，返回仓库:标签、镜像 ID、大小、创建时间。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			imgs, err := deps.Docker.ListImages(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("docker_images", imgs)
		})

	nodeReadTool(reg, "docker_inspect",
		"查看单个容器的完整 inspect 详情（挂载、网络、环境、健康检查等）。",
		objSchema(nodeIDProp+`,"container_id":{"type":"string","description":"容器 ID 或名称"}`, "node_id", "container_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			cid, err := strArg(raw, "container_id")
			if err != nil {
				return "", err
			}
			d, err := deps.Docker.Inspect(ctx, t.UserID, nid, cid)
			if err != nil {
				return "", err
			}
			return view("docker_inspect", d)
		})

	nodeReadTool(reg, "docker_logs",
		"读取容器最近的日志输出。",
		objSchema(nodeIDProp+`,"container_id":{"type":"string"},"tail":{"type":"integer","minimum":1,"maximum":2000,"description":"行数，默认 200"}`, "node_id", "container_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				ContainerID string `json:"container_id"`
				Tail        int    `json:"tail"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.ContainerID == "" {
				return "", fmt.Errorf("container_id required")
			}
			if a.Tail == 0 {
				a.Tail = 200
			}
			l, err := deps.Docker.Logs(ctx, t.UserID, nid, a.ContainerID, a.Tail)
			if err != nil {
				return "", err
			}
			return view("log", l)
		})

	nodeReadTool(reg, "docker_stats",
		"采集所有运行中容器的资源用量（CPU%、内存、网络、块 IO）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			st, err := deps.Docker.Stats(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("docker_stats", st)
		})

	nodeReadTool(reg, "docker_top",
		"查看单个容器内部的进程列表（docker top）。",
		objSchema(nodeIDProp+`,"container_id":{"type":"string"}`, "node_id", "container_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			cid, err := strArg(raw, "container_id")
			if err != nil {
				return "", err
			}
			tp, err := deps.Docker.Top(ctx, t.UserID, nid, cid)
			if err != nil {
				return "", err
			}
			return view("docker_top", tp)
		})

	nodeReadTool(reg, "docker_networks",
		"列出 Docker 网络。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			ns, err := deps.Docker.Networks(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("docker_networks", ns)
		})

	nodeReadTool(reg, "docker_volumes",
		"列出 Docker 卷。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			vs, err := deps.Docker.Volumes(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("docker_volumes", vs)
		})

	nodeWriteTool(reg, "docker_action",
		"对容器执行生命周期操作：start/stop/restart/remove/pause/unpause/kill。高危操作，需审批。",
		auth.PermDockerManage, "对容器执行操作",
		objSchema(nodeIDProp+`,"container_id":{"type":"string"},"action":{"type":"string","enum":["start","stop","restart","remove","pause","unpause","kill"]},"force":{"type":"boolean","description":"remove/kill 时强制"}`, "node_id", "container_id", "action"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				ContainerID string `json:"container_id"`
				Action      string `json:"action"`
				Force       bool   `json:"force"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.ContainerID == "" {
				return "", fmt.Errorf("container_id required")
			}
			act := docker.Action(a.Action)
			if !docker.ValidAction(act) {
				return "", fmt.Errorf("unsupported action %q", a.Action)
			}
			if err := deps.Docker.Do(ctx, t.UserID, nid, dockerClaims(t), act, a.ContainerID, a.Force); err != nil {
				return "", err
			}
			return fmt.Sprintf("已对节点 %d 容器 %s 执行 %s", nid, a.ContainerID, act), nil
		})

	nodeWriteTool(reg, "docker_prune",
		"清理 Docker 资源以回收磁盘：what 可为 system/container/image/volume/network/build。高危操作，需审批。",
		auth.PermDockerManage, "清理 Docker 资源",
		objSchema(nodeIDProp+`,"what":{"type":"string","enum":["system","container","image","volume","network","build"],"description":"清理目标，默认 system"}`, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				What string `json:"what"`
			}
			_ = json.Unmarshal(raw, &a)
			if a.What == "" {
				a.What = "system"
			}
			res, err := deps.Docker.Prune(ctx, t.UserID, nid, dockerClaims(t), a.What)
			if err != nil {
				return "", err
			}
			return view("docker_action_result", res)
		})

	nodeWriteTool(reg, "docker_pull",
		"在节点上拉取镜像。高危操作，需审批。",
		auth.PermDockerManage, "拉取镜像",
		objSchema(nodeIDProp+`,"ref":{"type":"string","description":"镜像引用，如 nginx:latest"}`, "node_id", "ref"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			ref, err := strArg(raw, "ref")
			if err != nil {
				return "", err
			}
			res, err := deps.Docker.PullImage(ctx, t.UserID, nid, dockerClaims(t), ref)
			if err != nil {
				return "", err
			}
			return view("docker_action_result", res)
		})
}
