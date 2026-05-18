package desktop

import (
	"context"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// Session is one live desktop connection: a worker + bookkeeping. The
// gateway-side WS handler pulls one of these by ID and pumps frames
// between the browser and the worker.
type Session struct {
	ID        string
	Worker    DesktopWorker
	NodeID    uint64
	UserID    uint64
	Username  string
	ClientIP  string
	StartedAt time.Time

	cancel     context.CancelFunc
	manager    *Manager
	sessionRow *model.Session

	closeOnce sync.Once
}

// Cancel terminates the underlying worker and unregisters from the manager.
// Safe to call multiple times.
func (s *Session) Cancel() {
	s.closeOnce.Do(func() {
		if s.manager != nil {
			_ = s.manager.End(context.Background(), s.ID)
		}
	})
}
