package sshpool

import (
	"sync"
	"sync/atomic"
	"time"

	xssh "golang.org/x/crypto/ssh"
)

// entry holds one or more *ssh.Client instances that share the same connection
// parameters. When the active client's session count reaches maxSessions a new
// one is started lazily.
type entry struct {
	key         string
	maxSessions int32

	mu       sync.Mutex
	clients  []*clientSlot
	disposed bool
}

type clientSlot struct {
	client   *xssh.Client
	refs     atomic.Int32
	lastUsed atomic.Int64
	dead     atomic.Bool
}

func newSlot(c *xssh.Client) *clientSlot {
	s := &clientSlot{client: c}
	s.lastUsed.Store(time.Now().UnixNano())
	return s
}

// pickAvailable returns the first slot whose refs is below max and not dead.
// Caller must hold entry.mu.
func (e *entry) pickAvailable() *clientSlot {
	for _, s := range e.clients {
		if s.dead.Load() {
			continue
		}
		if s.refs.Load() < e.maxSessions {
			return s
		}
	}
	return nil
}

// pruneDead removes dead slots. Caller must hold entry.mu.
func (e *entry) pruneDead() {
	live := e.clients[:0]
	for _, s := range e.clients {
		if !s.dead.Load() {
			live = append(live, s)
		}
	}
	e.clients = live
}
