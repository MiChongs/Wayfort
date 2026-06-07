// Package sse provides Server-Sent-Events streaming helpers shared by the
// ops-dock live telemetry endpoints across the api and domain handlers.
//
// The log viewer's Follow handler established the SSE shape for this codebase —
// text/event-stream, a producer goroutine, `event:/data:` frames plus a
// periodic comment ping, and teardown driven by request-context cancellation.
// These helpers generalise that pattern so every module can expose a `/stream`
// endpoint without re-implementing the plumbing.
package sse

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// WriteHeaders puts the response into streaming mode. Call once before frames.
func WriteHeaders(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no") // disable nginx proxy buffering
	c.Writer.WriteHeader(http.StatusOK)
	c.Writer.Flush()
}

// Frame writes one `event: <event>\ndata: <data>\n\n` frame and flushes.
// Returns false when the connection is gone (caller should stop).
func Frame(c *gin.Context, event, data string) bool {
	if _, err := c.Writer.WriteString("event: " + event + "\ndata: " + data + "\n\n"); err != nil {
		return false
	}
	c.Writer.Flush()
	return true
}

// Ping writes a keep-alive comment frame.
func Ping(c *gin.Context) bool {
	if _, err := c.Writer.WriteString(": ping\n\n"); err != nil {
		return false
	}
	c.Writer.Flush()
	return true
}

func jsonStr(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// Snapshots streams `first` immediately, then re-runs produce every interval and
// streams each result as an `event: snapshot` frame. produce runs in a goroutine
// so a slow snapshot never blocks pings or disconnect detection, and snapshots
// never stack (a new run begins only after the previous returns). The loop ends
// when the client disconnects (ctx cancelled). The caller is expected to fetch
// `first` synchronously beforehand so hard failures keep their HTTP status.
func Snapshots(c *gin.Context, interval time.Duration, first any, produce func(context.Context) (any, error)) {
	WriteHeaders(c)
	ctx := c.Request.Context()

	if !Frame(c, "snapshot", jsonStr(first)) {
		return
	}

	type result struct {
		v   any
		err error
	}
	resCh := make(chan result, 1)
	run := func() {
		v, err := produce(ctx)
		select {
		case resCh <- result{v, err}:
		case <-ctx.Done():
		}
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	busy := false
	for {
		select {
		case <-ctx.Done():
			return
		case r := <-resCh:
			busy = false
			if r.err != nil {
				if !Frame(c, "err", jsonStr(r.err.Error())) {
					return
				}
				continue
			}
			if !Frame(c, "snapshot", jsonStr(r.v)) {
				return
			}
		case <-ticker.C:
			if !busy {
				busy = true
				go run()
			}
		case <-ping.C:
			if !Ping(c) {
				return
			}
		}
	}
}

// Lines pipes lines produced by a long-lived remote command as `event: line`
// frames. produce is expected to block, invoking emit per line, returning when
// ctx is cancelled or the remote process exits. A terminal `event: done` is
// always sent. Mirrors logs.Manager.Follow.
func Lines(c *gin.Context, produce func(ctx context.Context, emit func(string)) error) {
	WriteHeaders(c)
	ctx := c.Request.Context()

	lineCh := make(chan string, 512)
	errCh := make(chan error, 1)
	go func() {
		errCh <- produce(ctx, func(l string) {
			select {
			case lineCh <- l:
			case <-ctx.Done():
			}
		})
	}()

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case l := <-lineCh:
			if !Frame(c, "line", jsonStr(l)) {
				return
			}
		case err := <-errCh:
			if err != nil {
				Frame(c, "err", jsonStr(err.Error()))
			}
			Frame(c, "done", "{}")
			return
		case <-ping.C:
			if !Ping(c) {
				return
			}
		}
	}
}
