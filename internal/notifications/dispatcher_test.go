package notifications

import (
	"context"
	"testing"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

func TestAllowEmailDebounce(t *testing.T) {
	d := NewDispatcher(nil, nil, nil, nil, nil)

	// Zero window → never debounced (repeated calls all allowed).
	for i := 0; i < 3; i++ {
		if !d.allowEmail(1, "k", 0) {
			t.Fatal("zero window should always allow")
		}
	}

	// First send allowed; immediate repeat within window suppressed.
	if !d.allowEmail(7, "anomaly", time.Hour) {
		t.Fatal("first send should be allowed")
	}
	if d.allowEmail(7, "anomaly", time.Hour) {
		t.Fatal("repeat within window should be suppressed")
	}
	// Different user, same key → independent.
	if !d.allowEmail(8, "anomaly", time.Hour) {
		t.Fatal("different user should be allowed")
	}
	// Different key, same user → independent.
	if !d.allowEmail(7, "bruteforce", time.Hour) {
		t.Fatal("different key should be allowed")
	}
}

func TestNotifyNilSafe(t *testing.T) {
	var d *Dispatcher
	// Must not panic on a nil dispatcher or with no recipients.
	d.Notify(context.TODO(), Event{Title: "x"})
	if d.Hub() != nil {
		t.Fatal("nil dispatcher Hub() should be nil")
	}
	if rs := d.SecurityRecipients(context.TODO()); rs != nil {
		t.Fatal("nil dispatcher SecurityRecipients should be nil")
	}
}

func TestHubPublishRoutesByUser(t *testing.T) {
	h := NewHub()
	ch, cancel := h.SubscribeUser(42)
	defer cancel()

	// A notification for a different user is not delivered.
	h.Publish(model.Notification{UserID: 99})
	select {
	case <-ch:
		t.Fatal("should not receive another user's notification")
	default:
	}

	// A notification for the subscribed user is delivered.
	h.Publish(model.Notification{UserID: 42})
	select {
	case <-ch:
	default:
		t.Fatal("expected to receive own notification")
	}
}
