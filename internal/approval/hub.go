package approval

import (
	"sync"
	"time"
)

// Hub is the in-process realtime fan-out for approval state changes. Every
// transition (create / task decided / approved / rejected / cancelled /
// expired / grant issued) is Published here; SSE handlers Subscribe to stream
// it to the browser. This is also the seam a future notification system plugs
// into — SubscribeUser yields every event addressed to a given user.
//
// Sends are non-blocking (drop on a full buffer); clients re-fetch the
// authoritative state on (re)connect, so a dropped frame is never fatal.
type Hub struct {
	mu   sync.RWMutex
	subs map[*subscriber]struct{}
}

// Event is the realtime envelope. It is intentionally a flat status snapshot
// (not the tamper-evident ledger row) so the browser can render without an
// extra round-trip. The notification center consumes the same shape.
type Event struct {
	RequestID    string     `json:"request_id"`
	RequesterID  uint64     `json:"requester_id"`
	Audience     []uint64   `json:"-"` // recipients for the per-user stream (requester + current approvers)
	Kind         string     `json:"kind"`
	Status       string     `json:"status"`
	Title        string     `json:"title"`
	BusinessType string     `json:"business_type"`
	ResourceType string     `json:"resource_type"`
	ResourceID   string     `json:"resource_id"`
	RiskLevel    string     `json:"risk_level"`
	CurrentStage int        `json:"current_stage"`
	TotalStages  int        `json:"total_stages"`
	GrantID      string     `json:"grant_id,omitempty"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	At           time.Time  `json:"at"`
}

type subscriber struct {
	ch        chan Event
	requestID string // non-empty: only events for this request
	userID    uint64 // non-zero: only events whose Audience contains this user
}

func NewHub() *Hub { return &Hub{subs: map[*subscriber]struct{}{}} }

// SubscribeRequest streams every event for one request id.
func (h *Hub) SubscribeRequest(requestID string) (<-chan Event, func()) {
	return h.add(&subscriber{ch: make(chan Event, 16), requestID: requestID})
}

// SubscribeUser streams every event addressed to userID (their own requests +
// tasks assigned to them). Backs the in-app notification center.
func (h *Hub) SubscribeUser(userID uint64) (<-chan Event, func()) {
	return h.add(&subscriber{ch: make(chan Event, 32), userID: userID})
}

func (h *Hub) add(s *subscriber) (<-chan Event, func()) {
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

// Publish fans an event to every matching subscriber. Never blocks.
func (h *Hub) Publish(ev Event) {
	if h == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		if s.requestID != "" && s.requestID != ev.RequestID {
			continue
		}
		if s.userID != 0 && !containsAudience(ev.Audience, s.userID) {
			continue
		}
		select {
		case s.ch <- ev:
		default: // slow consumer — drop; it re-syncs on reconnect
		}
	}
}

func containsAudience(a []uint64, id uint64) bool {
	for _, v := range a {
		if v == id {
			return true
		}
	}
	return false
}
