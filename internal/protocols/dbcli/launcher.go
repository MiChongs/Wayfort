package dbcli

import (
	"context"
	"fmt"
	"io"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	dockertypes "github.com/docker/docker/api/types"
	dclient "github.com/docker/docker/client"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/dockerx"
)

// Launcher creates a one-shot container preloaded with a database CLI client
// connected to the target node. It mirrors anonymous.DockerLauncher in spirit
// but with per-protocol image/command and the credential injected as env.
type Launcher struct {
	cli *dclient.Client
	cfg config.DBCLIConfig
}

func New(cfg config.DBCLIConfig) (*Launcher, error) {
	cli, err := dockerx.NewClient()
	if err != nil {
		return nil, err
	}
	return &Launcher{cli: cli, cfg: cfg}, nil
}

func (l *Launcher) Config() config.DBCLIConfig { return l.cfg }

// Launch creates and starts the CLI container, attaches a TTY, and returns the
// hijacked stream + container id + exec id (always empty for one-shot mode).
func (l *Launcher) Launch(ctx context.Context, sessionID string, spec LaunchSpec) (dockertypes.HijackedResponse, string, error) {
	if err := l.ensureImage(ctx, spec.Image); err != nil {
		return dockertypes.HijackedResponse{}, "", err
	}
	cfg := &container.Config{
		Image:        spec.Image,
		Cmd:          spec.Command,
		Env:          spec.Env,
		Tty:          true,
		OpenStdin:    true,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		StdinOnce:    true,
		Labels: map[string]string{
			"wayfort.session": sessionID,
			"wayfort.kind":    "dbcli",
		},
	}
	hostCfg := &container.HostConfig{
		AutoRemove:  true,
		NetworkMode: container.NetworkMode("bridge"),
		Resources: container.Resources{
			Memory: 256 * 1024 * 1024,
		},
		SecurityOpt: []string{"no-new-privileges"},
	}
	resp, err := l.cli.ContainerCreate(ctx, cfg, hostCfg, nil, nil, "webssh-dbcli-"+sessionID)
	if err != nil {
		return dockertypes.HijackedResponse{}, "", fmt.Errorf("create dbcli container: %w", err)
	}
	hr, err := l.cli.ContainerAttach(ctx, resp.ID, container.AttachOptions{
		Stdin: true, Stdout: true, Stderr: true, Stream: true,
	})
	if err != nil {
		_ = l.cli.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		return dockertypes.HijackedResponse{}, "", err
	}
	if err := l.cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		hr.Close()
		_ = l.cli.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		return dockertypes.HijackedResponse{}, "", err
	}
	return hr, resp.ID, nil
}

func (l *Launcher) Resize(ctx context.Context, containerID string, cols, rows uint32) error {
	return l.cli.ContainerResize(ctx, containerID, container.ResizeOptions{Width: uint(cols), Height: uint(rows)})
}

func (l *Launcher) Remove(ctx context.Context, containerID string) error {
	return l.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})
}

func (l *Launcher) ensureImage(ctx context.Context, name string) error {
	images, err := l.cli.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return err
	}
	for _, img := range images {
		for _, tag := range img.RepoTags {
			if tag == name {
				return nil
			}
		}
	}
	r, err := l.cli.ImagePull(ctx, name, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("pull %s: %w", name, err)
	}
	_, _ = io.Copy(io.Discard, r)
	_ = r.Close()
	return nil
}
