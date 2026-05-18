//go:build !freerdp

package rdp

import (
	"context"
	"errors"

	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	"go.uber.org/zap"
)

// stubClient is the build-tag-default implementation. Without
// `-tags freerdp` we cannot link libfreerdp, so any call to Start returns
// a clear error. This keeps `go build ./...` green on machines that don't
// have libfreerdp installed.
type stubClient struct {
	logger *zap.Logger
	out    chan desktop.ServerMessage
}

func NewClient(logger *zap.Logger) desktop.DesktopWorker {
	out := make(chan desktop.ServerMessage, 1)
	out <- desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase:   desktop.PhaseError,
		Message: "freerdp-worker not built with `-tags freerdp` (libfreerdp missing at build time)",
		Code:    0xFF01,
	}}
	close(out)
	return &stubClient{logger: logger, out: out}
}

func (c *stubClient) Start(ctx context.Context, p desktop.StartParams) error {
	return errors.New("freerdp not built; rebuild cmd/freerdp-worker with -tags freerdp on a libfreerdp 3.x host")
}
func (c *stubClient) Send(_ desktop.ClientMessage) error { return errors.New("stub") }
func (c *stubClient) Recv() <-chan desktop.ServerMessage { return c.out }
func (c *stubClient) Close() error                       { return nil }
