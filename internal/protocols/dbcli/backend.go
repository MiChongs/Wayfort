package dbcli

import (
	"context"
	"errors"
	"io"

	dockertypes "github.com/docker/docker/api/types"
)

// Backend wraps the hijacked docker attach stream as a webssh.Backend.
type Backend struct {
	launcher    *Launcher
	containerID string
	resp        dockertypes.HijackedResponse
}

func NewBackend(l *Launcher, containerID string, resp dockertypes.HijackedResponse) *Backend {
	return &Backend{launcher: l, containerID: containerID, resp: resp}
}

func (b *Backend) Read(p []byte) (int, error) {
	return b.resp.Reader.Read(p)
}

func (b *Backend) Write(p []byte) (int, error) {
	return b.resp.Conn.Write(p)
}

func (b *Backend) Resize(cols, rows uint32) error {
	return b.launcher.Resize(context.Background(), b.containerID, cols, rows)
}

func (b *Backend) Close() error {
	b.resp.Close()
	_ = b.launcher.Remove(context.Background(), b.containerID)
	return nil
}

var _ io.ReadWriteCloser = (*Backend)(nil)
var ErrUnsupported = errors.New("dbcli unsupported protocol")
