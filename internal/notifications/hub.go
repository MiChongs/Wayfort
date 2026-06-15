// Package notifications is the higher-level event-notification layer that sits
// on top of the low-level SMTP mailer (internal/notify). It turns a security
// event (anomalous login, brute-force burst, account lockout) into:
//   - a persisted, per-recipient in-app notification (the notification center),
//   - a realtime push to the recipient's browser over SSE (the Hub), and
//   - an optional email through the async mailer.
//
// Recipient resolution is part of the job: an event addressed to "the security
// team" is expanded to the concrete users who hold the relevant permissions.
package notifications

import (
	"sync"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// Hub is the in-process realtime fan-out for new notifications, mirroring
// approval.Hub. SSE handlers SubscribeUser to stream a user's incoming
// notifications; sends are non-blocking (a slow client drops a frame and
// re-syncs via the list endpoint on reconnect).
type Hub struct {
	mu   sync.RWMutex
	subs map[*subscriber]struct{}
}

type subscriber struct {
	ch     chan model.Notification
	userID uint64
}

func NewHub() *Hub { return &Hub{subs: map[*subscriber]struct{}{}} }

// SubscribeUser streams notifications addressed to userID.
func (h *Hub) SubscribeUser(userID uint64) (<-chan model.Notification, func()) {
	s := &subscriber{ch: make(chan model.Notification, 16), userID: userID}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, s)
			close(s.ch)
			h.mu.Unlock()
		})
	}
	return s.ch, cancel
}

// Publish fans a notification to its recipient's subscribers. Never blocks.
func (h *Hub) Publish(n model.Notification) {
	if h == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		if s.userID != n.UserID {
			continue
		}
		select {
		case s.ch <- n:
		default: // slow consumer — drop; it re-syncs on reconnect
		}
	}
}
