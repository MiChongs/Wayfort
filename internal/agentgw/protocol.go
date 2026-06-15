// Package agentgw implements the gateway side of the reverse-connect Gateway
// Agent tunnel (security-architecture.md §4). An agent connects OUTBOUND to the
// gateway over WSS; the gateway runs a yamux client over that connection and
// opens one multiplexed stream per user session. Each stream begins with an
// OPEN frame telling the agent which target to dial inside its network; after a
// one-byte-framed ACK the stream is a raw byte pipe to the target.
//
// The agent is a dumb pipe: it never decrypts the session, holds no asset
// credentials, and only dials targets the gateway asks for. Membership of the
// target in the domain's asset set is enforced by the caller (the dial address
// is always derived from the node being connected), so the agent can't be used
// as an open SOCKS proxy.
package agentgw

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// maxFrameLen bounds a control frame so a malformed/hostile length prefix can't
// make us allocate unbounded memory. Control frames are tiny JSON objects.
const maxFrameLen = 64 * 1024

// OpenFrame is the first thing the gateway writes on a new stream: it tells the
// agent what to dial on the gateway's behalf.
type OpenFrame struct {
	RequestID  string `json:"request_id"`
	Network    string `json:"network"` // "tcp"
	Target     string `json:"target"`  // host:port, resolved on the AGENT side
	DeadlineMS int64  `json:"deadline_ms"`
}

// AckFrame is the agent's reply after attempting the dial. OK=false carries a
// human-readable Error; the gateway surfaces it and tears the stream down.
type AckFrame struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// writeFrame encodes v as JSON behind a uint32 big-endian length prefix.
func writeFrame(w io.Writer, v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(payload) > maxFrameLen {
		return fmt.Errorf("agentgw: frame too large (%d bytes)", len(payload))
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err = w.Write(payload)
	return err
}

// readFrame reads a length-prefixed JSON frame into v.
func readFrame(r io.Reader, v any) error {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > maxFrameLen {
		return fmt.Errorf("agentgw: frame too large (%d bytes)", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return err
	}
	return json.Unmarshal(buf, v)
}
