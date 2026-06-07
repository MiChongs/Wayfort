package anonymous

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sync/atomic"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	dockertypes "github.com/docker/docker/api/types"
	dclient "github.com/docker/docker/client"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/dockerx"
)

type DockerLauncher struct {
	cli *dclient.Client
	cfg atomic.Pointer[config.AnonymousConfig] // live config; hot-swapped by ApplyConfig
}

func NewDockerLauncher(cfg config.AnonymousConfig) (*DockerLauncher, error) {
	cli, err := dockerx.NewClient()
	if err != nil {
		return nil, err
	}
	l := &DockerLauncher{cli: cli}
	l.cfg.Store(&cfg)
	return l, nil
}

func (l *DockerLauncher) Client() *dclient.Client       { return l.cli }
func (l *DockerLauncher) conf() config.AnonymousConfig  { return *l.cfg.Load() }
func (l *DockerLauncher) Config() config.AnonymousConfig { return l.conf() }

// ApplyConfig hot-swaps the sandbox limits. Newly launched containers pick up
// the new image / resource caps immediately; in-flight containers keep theirs.
func (l *DockerLauncher) ApplyConfig(cfg config.AnonymousConfig) { l.cfg.Store(&cfg) }

// Create starts a fresh container with hardened defaults and returns its ID.
// The container runs `tail -f /dev/null` so it stays alive; the actual shell
// is later attached via ContainerExecAttach.
func (l *DockerLauncher) Create(ctx context.Context, sessionID string) (string, error) {
	if err := l.ensureImage(ctx); err != nil {
		return "", err
	}
	cfg := &container.Config{
		Image:        l.conf().Image,
		Cmd:          []string{"tail", "-f", "/dev/null"},
		Tty:          false,
		AttachStdin:  false,
		AttachStdout: false,
		AttachStderr: false,
		Labels: map[string]string{
			"jumpserver.session": sessionID,
			"jumpserver.kind":    "anonymous",
		},
	}
	hostCfg := &container.HostConfig{
		AutoRemove:     false, // we control removal in the janitor
		NetworkMode:    container.NetworkMode(l.conf().Network),
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,exec,nosuid,size=64m"},
		Resources: container.Resources{
			Memory:    l.conf().MemoryMB * 1024 * 1024,
			PidsLimit: ptr(l.conf().PidsLimit),
			NanoCPUs:  int64(l.conf().CPU * 1e9),
		},
		SecurityOpt: []string{"no-new-privileges"},
	}
	resp, err := l.cli.ContainerCreate(ctx, cfg, hostCfg, nil, nil, "webssh-anon-"+sessionID)
	if err != nil {
		return "", fmt.Errorf("container create: %w", err)
	}
	if err := l.cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = l.Remove(context.Background(), resp.ID)
		return "", err
	}
	return resp.ID, nil
}

func (l *DockerLauncher) ensureImage(ctx context.Context) error {
	images, err := l.cli.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return err
	}
	for _, img := range images {
		for _, tag := range img.RepoTags {
			if tag == l.conf().Image {
				return nil
			}
		}
	}
	r, err := l.cli.ImagePull(ctx, l.conf().Image, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("image pull: %w", err)
	}
	// Drain pull stream so the call actually completes.
	_, _ = io.Copy(io.Discard, bufio.NewReader(r))
	_ = r.Close()
	return nil
}

// Attach creates an exec instance with a TTY and returns a hijacked
// duplex connection plus the exec ID for resize calls.
func (l *DockerLauncher) Attach(ctx context.Context, containerID string, cols, rows int) (dockertypes.HijackedResponse, string, error) {
	cmd := l.conf().Shell
	if len(cmd) == 0 {
		cmd = []string{"/bin/sh"}
	}
	execResp, err := l.cli.ContainerExecCreate(ctx, containerID, container.ExecOptions{
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          true,
		Cmd:          cmd,
		Env:          []string{"TERM=xterm-256color"},
	})
	if err != nil {
		return dockertypes.HijackedResponse{}, "", err
	}
	hr, err := l.cli.ContainerExecAttach(ctx, execResp.ID, container.ExecStartOptions{Tty: true})
	if err != nil {
		return dockertypes.HijackedResponse{}, "", err
	}
	if cols > 0 && rows > 0 {
		_ = l.cli.ContainerExecResize(ctx, execResp.ID, container.ResizeOptions{Width: uint(cols), Height: uint(rows)})
	}
	return hr, execResp.ID, nil
}

func (l *DockerLauncher) Resize(ctx context.Context, execID string, cols, rows uint32) error {
	return l.cli.ContainerExecResize(ctx, execID, container.ResizeOptions{Width: uint(cols), Height: uint(rows)})
}

func (l *DockerLauncher) Remove(ctx context.Context, containerID string) error {
	return l.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true, RemoveVolumes: true})
}

func (l *DockerLauncher) ListManaged(ctx context.Context) ([]string, error) {
	cl, err := l.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: jumpserverFilter()})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(cl))
	for _, c := range cl {
		out = append(out, c.ID)
	}
	return out, nil
}

func ptr[T any](v T) *T { return &v }
