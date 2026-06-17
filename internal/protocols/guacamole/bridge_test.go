package guacamole

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/michongs/wayfort/internal/config"
	"go.uber.org/zap"
)

// fakeGuacd accepts one TCP connection, reads the bridge's `select` and
// handshake instructions, then writes back `args` immediately followed by any
// number of extra instructions specified by `trailing`. These trailing bytes
// arrive in the *same TCP segment* most of the time, which is precisely the
// scenario that exposed the bufio.Reader-stranded-data bug fixed in Plan 13.A.1.
func fakeGuacd(t *testing.T, trailing string) (addr string, cleanup func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		// 1. Read the `select <proto>` instruction.
		if _, _, err := ReadInstruction(br); err != nil {
			return
		}
		// 2. Reply with `args` + any trailing instructions, all in one write.
		//    Empty arg list means our handshake will send `connect` with zero
		//    values, which is fine for this test (we don't actually launch RDP).
		reply := "4.args,0.,0.,0.;" + trailing
		if _, err := conn.Write([]byte(reply)); err != nil {
			return
		}
		// 3. Drain whatever the bridge sends after handshake (size/audio/...
		//    and connect) so its bw.Flush doesn't block.
		_, _ = io.Copy(io.Discard, conn)
	}()
	return ln.Addr().String(), func() {
		_ = ln.Close()
		<-done
	}
}

// dialBridgeWS spins up a tiny HTTP server that upgrades to WebSocket and
// runs Bridge.Serve. Returns a client-side *websocket.Conn ready to Read
// guacd-side bytes.
func dialBridgeWS(t *testing.T, addr string, params ConnectParams, onErr func(int, string)) (*websocket.Conn, *httptest.Server, *atomic.Uint64, chan error) {
	t.Helper()
	logger := zap.NewNop()
	br := NewBridge(config.GuacamoleConfig{GuacdAddr: addr}, logger)
	bytesOut := new(atomic.Uint64)
	doneCh := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: []string{"*"},
			Subprotocols:   []string{"guacamole"},
		})
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		params.OnError = onErr
		_, out, serr := br.Serve(ctx, conn, params)
		bytesOut.Store(out)
		doneCh <- serr
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	}))
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		Subprotocols: []string{"guacamole"},
	})
	if err != nil {
		srv.Close()
		t.Fatalf("dial ws: %v", err)
	}
	return conn, srv, bytesOut, doneCh
}

// TestBridgeForwardsBytesBufferedDuringHandshake is the regression test for
// Plan 13.A.1. The fake guacd writes `args;` plus a `ready` instruction in
// the SAME TCP segment, which forces bufio.NewReaderSize to pre-fetch both
// into its internal buffer during handshake. Pre-fix, copyGuacdToWS read
// from the raw conn and the `ready` instruction never reached the client.
// Post-fix (passing br instead of conn) the client receives it.
func TestBridgeForwardsBytesBufferedDuringHandshake(t *testing.T) {
	const trailing = "5.ready,4.sess;" // post-handshake notification from guacd
	addr, cleanup := fakeGuacd(t, trailing)
	defer cleanup()

	ws, srv, _, _ := dialBridgeWS(t, addr, ConnectParams{Protocol: "rdp"}, nil)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	typ, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("want text, got %v", typ)
	}
	if !strings.Contains(string(data), "ready") {
		t.Fatalf("post-handshake ready instruction was not forwarded — bufio bug regression. got=%q", data)
	}
	_ = ws.Close(websocket.StatusNormalClosure, "done")
}

// TestBridgeReportsErrorInstruction verifies that when guacd emits an error
// instruction the bridge invokes OnError exactly once (Plan 13.A.2).
func TestBridgeReportsErrorInstruction(t *testing.T) {
	// 0x301 = client unauthorized (NLA auth failed).
	const trailing = "5.error,3.769,19.Authentication FAIL;"
	addr, cleanup := fakeGuacd(t, trailing)
	defer cleanup()

	var captured atomic.Int32
	var capCode atomic.Int32
	var capMsg atomic.Value
	ws, srv, _, _ := dialBridgeWS(t, addr, ConnectParams{Protocol: "rdp"}, func(code int, msg string) {
		captured.Add(1)
		capCode.Store(int32(code))
		capMsg.Store(msg)
	})
	defer srv.Close()

	// Drain a couple of reads to give the bridge time to scan the chunk.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, _ = ws.Read(ctx)
	_ = ws.Close(websocket.StatusNormalClosure, "done")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && captured.Load() == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if got := captured.Load(); got != 1 {
		t.Fatalf("OnError fired %d times, want 1", got)
	}
	if got := int(capCode.Load()); got != 769 {
		t.Fatalf("OnError code = %d, want 769", got)
	}
	if got, _ := capMsg.Load().(string); got != "Authentication FAIL" {
		t.Fatalf("OnError msg = %q, want %q", got, "Authentication FAIL")
	}
}

// TestScanForGuacError unit-tests the chunk scanner directly so regressions
// are obvious without spinning up TCP servers.
func TestScanForGuacError(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		wantOK   bool
		wantCode int
		wantMsg  string
	}{
		{"no error", "10.size_image,3.123;", false, 0, ""},
		{"basic error", "5.error,3.256.16.Auth FAIL no go;", false, 0, ""}, // malformed (not real protocol)
		{"valid error", "5.error,3.769,19.Authentication FAIL;", true, 769, "Authentication FAIL"},
		{"error sandwiched", "4.sync,4.0123;5.error,3.512,11.Bad Request;6.cursor,1.0;", true, 512, "Bad Request"},
		{"no length prefix", ".error,3.769,5.thing;", false, 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, msg, ok := scanForGuacError([]byte(tc.in))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (code=%d msg=%q)", ok, tc.wantOK, code, msg)
			}
			if ok && (code != tc.wantCode || msg != tc.wantMsg) {
				t.Fatalf("got (%d,%q), want (%d,%q)", code, msg, tc.wantCode, tc.wantMsg)
			}
		})
	}
}

// TestApplyQualityPreset checks the three named presets touch the expected
// fields. Plan 13.B.2.
func TestApplyQualityPreset(t *testing.T) {
	base := ConnectParams{}
	high := ApplyQualityPreset(base, "high")
	if high.ColorDepth != 32 || !high.EnableWallpaper || !high.EnableAnimations {
		t.Errorf("high preset: %+v", high)
	}
	low := ApplyQualityPreset(base, "low")
	if low.ColorDepth != 16 || low.EnableWallpaper || low.EnableAnimations || low.EnableFontSmooth {
		t.Errorf("low preset: %+v", low)
	}
	med := ApplyQualityPreset(base, "medium")
	if med.ColorDepth != 24 || med.EnableWallpaper || !med.EnableFontSmooth {
		t.Errorf("medium preset: %+v", med)
	}
	def := ApplyQualityPreset(base, "")
	if def.ColorDepth != 24 {
		t.Errorf("empty preset (auto) should equal medium, got %+v", def)
	}
}
