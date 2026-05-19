package tcpfwd

import (
	"sync"
	"sync/atomic"
	"time"
)

// EventType enumerates the per-forwarder lifecycle and metric events the
// gateway pushes to subscribed browsers. The wire format is a small JSON
// envelope so the frontend can route by type without ad-hoc parsing.
type EventType string

const (
	EventOpened     EventType = "opened"      // forwarder created and listening
	EventClosed     EventType = "closed"      // forwarder torn down (manual / expiry)
	EventError      EventType = "error"       // accept / dial failure
	EventBytesTick  EventType = "bytes_tick"  // 500ms throughput snapshot
	EventConnOpen   EventType = "conn_open"   // a downstream accepted+dialed
	EventConnClose  EventType = "conn_close"  // a downstream finished
	EventMetadata   EventType = "metadata"    // label/tags/pinned changed
)

// Event is the union pushed to subscribed clients. Only fields relevant to
// the EventType are populated — keeping a single struct simplifies the WS
// JSON encoder and matches the desktop ServerMessage envelope pattern.
type Event struct {
	Type      EventType `json:"type"`
	ForwardID string    `json:"forward_id"`
	UserID    uint64    `json:"user_id"`
	TSMs      int64     `json:"ts_ms"`

	// bytes_tick payload
	BytesIn       uint64 `json:"bytes_in,omitempty"`
	BytesOut      uint64 `json:"bytes_out,omitempty"`
	InRateBps     uint64 `json:"in_rate_bps,omitempty"`
	OutRateBps    uint64 `json:"out_rate_bps,omitempty"`
	ActiveConns   uint32 `json:"active_conns,omitempty"`

	// error payload
	ErrorMessage string `json:"error_message,omitempty"`
}

// EventBus is the per-Manager fanout layer. Forwarders publish events; the
// WS endpoint subscribes per (user) and forwards everything matching the
// user_id filter. The bus does not buffer events for absent subscribers —
// metrics are sampled fresh every 500ms so brief disconnects do not need a
// replay path.
type EventBus struct {
	mu      sync.RWMutex
	subs    map[*Subscriber]struct{}
	nextID  atomic.Uint64
}

// Subscriber represents one WebSocket consumer. The Manager-level bus
// fans every Event into Subscriber.ch whose UserID matches Event.UserID;
// the consumer drains ch on its own goroutine. A full channel results in
// a dropped event (subscribers must keep up) — losing a `bytes_tick` is
// fine because the next 500ms cycle re-publishes the absolute totals.
type Subscriber struct {
	id     uint64
	userID uint64
	ch     chan Event
}

// Events returns the receive end of the subscriber channel. Use this in
// the WS handler's read loop together with the heartbeat reader.
func (s *Subscriber) Events() <-chan Event { return s.ch }

// UserID returns the user the subscription is scoped to.
func (s *Subscriber) UserID() uint64 { return s.userID }

func NewEventBus() *EventBus {
	return &EventBus{subs: make(map[*Subscriber]struct{})}
}

// Subscribe registers a new consumer scoped to the given user.
// Returns the subscriber and an unsubscribe func that's safe to call once.
// Channel capacity (128) covers a burst of conn_open + bytes_tick events
// at 500ms cadence for ~30 simultaneously active forwards before the bus
// starts dropping — beyond which the consumer is clearly stalled.
func (b *EventBus) Subscribe(userID uint64) (*Subscriber, func()) {
	s := &Subscriber{
		id:     b.nextID.Add(1),
		userID: userID,
		ch:     make(chan Event, 128),
	}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	return s, func() {
		b.mu.Lock()
		delete(b.subs, s)
		b.mu.Unlock()
		// Drain and close so any in-flight publishers don't block.
		close(s.ch)
	}
}

// Publish fans an event to every matching subscriber. Non-blocking: a
// slow consumer drops the event rather than back-pressure the publisher
// (which runs inside the forwarder's accept goroutine).
func (b *EventBus) Publish(e Event) {
	if e.TSMs == 0 {
		e.TSMs = time.Now().UnixMilli()
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for s := range b.subs {
		if s.userID != 0 && e.UserID != 0 && s.userID != e.UserID {
			continue
		}
		select {
		case s.ch <- e:
		default:
			// Drop. Next bytes_tick (500ms away) carries fresh totals;
			// conn_open/close events that miss are reconciled when the
			// client re-fetches `/portforward`.
		}
	}
}

// Close stops the bus and signals every subscriber's channel. Idempotent.
func (b *EventBus) Close() {
	b.mu.Lock()
	subs := make([]*Subscriber, 0, len(b.subs))
	for s := range b.subs {
		subs = append(subs, s)
	}
	b.subs = map[*Subscriber]struct{}{}
	b.mu.Unlock()
	for _, s := range subs {
		// Drain pending events without blocking; close signals receivers.
		select {
		case <-s.ch:
		default:
		}
		close(s.ch)
	}
}
