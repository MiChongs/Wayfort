package webssh

import (
	"errors"
	"fmt"
	"testing"

	"github.com/coder/websocket"
	"github.com/michongs/wayfort/internal/agentgw"
	"github.com/michongs/wayfort/internal/domain"
)

// TestCloseForError locks the mapping the frontend relies on: an agent-domain
// asset with no online agent must surface the machine-readable "agent_unavailable"
// token (which inferDisconnect turns into an actionable message), while unknown
// errors fall back to their raw text.
func TestCloseForError(t *testing.T) {
	// The real wrapped shape produced by DialerForNode → runNodeSession.
	wrapped := fmt.Errorf("resolve dialer: %w", fmt.Errorf("domain 5: %w", agentgw.ErrNoAgent))
	if _, reason := closeForError(wrapped); reason != "agent_unavailable" {
		t.Fatalf("ErrNoAgent: want agent_unavailable, got %q", reason)
	}
	if _, reason := closeForError(domain.ErrAgentDomain); reason != "agent_unavailable" {
		t.Fatalf("ErrAgentDomain: want agent_unavailable, got %q", reason)
	}
	if _, reason := closeForError(errors.New("boom")); reason != "boom" {
		t.Fatalf("unknown error: want raw text, got %q", reason)
	}
	if code, _ := closeForError(errors.New("x")); code != websocket.StatusInternalError {
		t.Fatalf("want StatusInternalError close code, got %v", code)
	}
}
