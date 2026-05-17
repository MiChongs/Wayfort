package anonymous

import (
	"context"
	"io"

	dockertypes "github.com/docker/docker/api/types"
)

// dockerBackend implements webssh.Backend on top of a docker exec hijacked stream.
type dockerBackend struct {
	launcher    *DockerLauncher
	containerID string
	execID      string
	resp        dockertypes.HijackedResponse
}

func (b *dockerBackend) Read(p []byte) (int, error)  { return b.resp.Reader.Read(p) }
func (b *dockerBackend) Write(p []byte) (int, error) { return b.resp.Conn.Write(p) }
func (b *dockerBackend) Resize(cols, rows uint32) error {
	return b.launcher.Resize(context.Background(), b.execID, cols, rows)
}
func (b *dockerBackend) Close() error {
	b.resp.Close()
	// Container removal is deferred to the janitor / service.
	return nil
}

// guarantee io.ReadWriter compliance for documentation/readers.
var _ io.ReadWriter = (*dockerBackend)(nil)
