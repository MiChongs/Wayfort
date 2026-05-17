// Package runner drives one conversation turn: pulls deltas from the Provider,
// translates tool calls into Tool invocations (after passing the gate), feeds
// the results back into the next round, and pushes everything to a Sink so
// the SSE handler can stream to the browser.
package runner

import (
	"encoding/json"
	"sync"
)

// EventKind enumerates the SSE event names we emit. The frontend literally
// sees these strings in the SSE `event:` field.
type EventKind string

const (
	KindMessageStart       EventKind = "message_start"
	KindTextDelta          EventKind = "text_delta"
	KindToolCall           EventKind = "tool_call"
	KindToolStart          EventKind = "tool_start"
	KindToolOutput         EventKind = "tool_output"
	KindToolError          EventKind = "tool_error"
	KindPermissionRequired EventKind = "permission_required"
	KindUsage              EventKind = "usage"
	KindMessageEnd         EventKind = "message_end"
	KindError              EventKind = "error"
	KindDone               EventKind = "done"
	KindPing               EventKind = "ping"
	KindSubAgent           EventKind = "subagent_event"
)

// Event is the payload pushed through the Sink. Data marshals to JSON for SSE.
type Event struct {
	Kind EventKind   `json:"-"`
	Data interface{} `json:"-"`
}

// Sink is the channel the runner publishes events to. The SSE handler is the
// canonical consumer; tests use a buffered channel sink.
type Sink interface {
	Emit(ev Event)
	Close()
}

// ChannelSink is a Sink backed by a buffered chan, used both by the SSE handler
// and tests.
type ChannelSink struct {
	ch   chan Event
	once sync.Once
}

func NewChannelSink(buf int) *ChannelSink {
	if buf <= 0 {
		buf = 64
	}
	return &ChannelSink{ch: make(chan Event, buf)}
}

func (s *ChannelSink) Emit(ev Event) {
	defer func() { _ = recover() }() // tolerate emit after Close
	select {
	case s.ch <- ev:
	default:
	}
}

func (s *ChannelSink) Close() {
	s.once.Do(func() { close(s.ch) })
}

func (s *ChannelSink) C() <-chan Event { return s.ch }

// EncodeData marshals an event payload to JSON for SSE transmission.
func EncodeData(v interface{}) []byte {
	if v == nil {
		return []byte("{}")
	}
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"error":"encode_failed"}`)
	}
	return b
}
