package livewatch

import "testing"

func TestHubPublishSubscribe(t *testing.T) {
	h := NewHub()
	h.EnsureSession("s1", ModeTerminal)

	ob, base, unsub, ok := h.Subscribe("s1")
	if !ok {
		t.Fatal("subscribe should succeed for a live session")
	}
	defer unsub()
	if base == nil {
		t.Fatal("terminal baseline should be non-nil")
	}

	h.Publish("s1", Frame{Kind: KindOutput, Data: []byte("hello")})
	select {
	case fr := <-ob.Frames():
		if string(fr.Data) != "hello" {
			t.Fatalf("got %q, want hello", fr.Data)
		}
	default:
		t.Fatal("expected a published frame")
	}

	if got := h.Observers("s1"); got != 1 {
		t.Fatalf("observers = %d, want 1", got)
	}
}

func TestHubScrollbackBaseline(t *testing.T) {
	h := NewHub()
	h.EnsureSession("s1", ModeTerminal)
	// Output + a resize arrive before anyone subscribes.
	h.Publish("s1", Frame{Kind: KindResize, Cols: 100, Rows: 40})
	h.Publish("s1", Frame{Kind: KindOutput, Data: []byte("scrollback-")})
	h.Publish("s1", Frame{Kind: KindOutput, Data: []byte("here")})

	_, base, unsub, ok := h.Subscribe("s1")
	if !ok {
		t.Fatal("subscribe failed")
	}
	defer unsub()
	if base.Cols != 100 || base.Rows != 40 {
		t.Fatalf("baseline dims = %dx%d, want 100x40", base.Cols, base.Rows)
	}
	if string(base.Scrollback) != "scrollback-here" {
		t.Fatalf("baseline scrollback = %q", base.Scrollback)
	}
}

func TestHubCloseSession(t *testing.T) {
	h := NewHub()
	h.EnsureSession("s1", ModeDesktop)
	ob, _, _, ok := h.Subscribe("s1")
	if !ok {
		t.Fatal("subscribe failed")
	}
	h.CloseSession("s1")
	// The observer channel must be closed so the handler sees EOF.
	if _, open := <-ob.Frames(); open {
		t.Fatal("observer channel should be closed after CloseSession")
	}
	// Subscribing to a closed session fails gracefully.
	if _, _, _, ok := h.Subscribe("s1"); ok {
		t.Fatal("subscribe to a closed session should fail")
	}
}

func TestHubPublishUnknownNoPanic(t *testing.T) {
	h := NewHub()
	h.Publish("ghost", Frame{Kind: KindOutput, Data: []byte("x")}) // must not panic
	if h.Observers("ghost") != 0 {
		t.Fatal("unknown session should have 0 observers")
	}
}

func TestHubBackpressureDrops(t *testing.T) {
	h := NewHub()
	h.EnsureSession("s1", ModeDesktop) // 64-slot buffer
	ob, _, unsub, _ := h.Subscribe("s1")
	defer unsub()
	// Overrun the buffer without draining — excess frames are dropped, counted,
	// and the publisher never blocks.
	for i := range 200 {
		h.Publish("s1", Frame{Kind: KindOutput, Data: []byte{byte(i)}})
	}
	if ob.Dropped() == 0 {
		t.Fatal("expected dropped frames under backpressure")
	}
}
