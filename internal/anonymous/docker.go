package anonymous

import (
	"bufio"
	"context"
	"fmt"
	"io"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	dockertypes "github.com/docker/docker/api/types"
	dclient "github.com/docker/docker/client"
	"github.com/michongs/jumpserver-anonymous/internal/config"
)

type DockerLauncher struct {
	cli *dclient.Client
	cfg config.AnonymousConfig
}

func NewDockerLauncher(cfg config.AnonymousConfig) (*DockerLauncher, error) {
	cli, err := dclient.NewClientWithOpts(dclient.FromEnv, dclient.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	return &DockerLauncher{cli: cli, cfg: cfg}, nil
}

func (l *DockerLauncher) Client() *dclient.Client { return l.cli }
func (l *DockerLauncher) Config() config.AnonymousConfig { return l.cfg }

// Create starts a fresh container with hardened defaults and returns its ID.
// The container runs `tail -f /dev/null` so it stays alive; the actual shell
// is later attached via ContainerExecAttach.
func (l *DockerLauncher) Create(ctx context.Context, sessionID string) (string, error) {
	if err := l.ensureImage(ctx); err != nil {
		return "", err
	}
	cfg := &container.Config{
		Image:        l.cfg.Image,
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
		NetworkMode:    container.NetworkMode(l.cfg.Network),
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,exec,nosuid,size=64m"},
		Resources: container.Resources{
			Memory:    l.cfg.MemoryMB * 1024 * 1024,
			PidsLimit: ptr(l.cfg.PidsLimit),
			NanoCPUs:  int64(l.cfg.CPU * 1e9),
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
			if tag == l.cfg.Image {
				return nil
			}
		}
	}
	r, err := l.cli.ImagePull(ctx, l.cfg.Image, image.PullOptions{})
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
	cmd := l.cfg.Shell
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
