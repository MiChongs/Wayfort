package guacamole

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/model"
	pkgcrypto "github.com/michongs/wayfort/pkg/crypto"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
)

// ConnectParams describes one Guacamole connection. The fields directly map to
// the connection parameter set documented at
// https://guacamole.apache.org/doc/gug/configuring-guacamole.html#connection-parameters.
type ConnectParams struct {
	Protocol   string // "rdp" / "vnc"
	Hostname   string
	Port       int
	Username   string
	Password   string
	Domain     string
	Width      int
	Height     int
	DPI        int
	Security   string // rdp: nla, tls, rdp, any
	IgnoreCert bool

	SOCKSHost string
	SOCKSPort int
	SOCKSUser string
	SOCKSPass string

	RecordingPath        string
	RecordingName        string
	RecordingIncludeKeys bool

	// Plan 13.B.1 — UX feature toggles + performance preset.
	// Defaults (zero values) intentionally produce a "medium" quality
	// profile: audio off, clipboard off, wallpaper off, etc. The gateway
	// turns them on based on query parameters.
	EnableAudio      bool
	EnableClipboard  bool
	EnableWallpaper  bool
	EnableFontSmooth bool
	EnableTheming    bool
	EnableAnimations bool
	ColorDepth       int    // 8 / 16 / 24 / 32 — 0 means "guacd default (24)".
	KeyboardLayout   string // RDP server-layout, e.g. "en-us-qwerty".

	// OnError, if non-nil, is invoked at most once when the bridge detects a
	// `4.error,<code>.<value>,<n>.<message>;` instruction emitted by guacd
	// (Plan 13.A.2). Lets the gateway translate to an audit row + log line
	// without coupling Bridge to the audit package.
	OnError func(code int, msg string)

	// BytesIn / BytesOut, if non-nil, are the live byte counters the bridge
	// increments as it proxies — the gateway reads them on a cadence to persist
	// live traffic onto the session row (otherwise bytes only land at teardown).
	// nil → the bridge uses its own local counters.
	BytesIn  *atomic.Uint64
	BytesOut *atomic.Uint64
}

// Bridge orchestrates a single guacd session: dial guacd, perform the
// select/size/audio/video/image/connect handshake, then 1:1 proxy bytes between
// the WebSocket and guacd. The WS subprotocol is "guacamole".
type Bridge struct {
	cfg    config.GuacamoleConfig
	logger *zap.Logger
}

func NewBridge(cfg config.GuacamoleConfig, logger *zap.Logger) *Bridge {
	return &Bridge{cfg: cfg, logger: logger}
}

// Serve runs until either side closes. Returns the cumulative byte counts
// in each direction plus the terminal error (nil for clean shutdown).
//
// Plan 13.A: signature changed from `error` to `(uint64, uint64, error)` so
// the gateway can write meaningful BytesIn / BytesOut into the session row
// instead of the previous hard-coded zeros.
func (b *Bridge) Serve(ctx context.Context, ws *websocket.Conn, p ConnectParams) (uint64, uint64, error) {
	if b.cfg.GuacdAddr == "" {
		return 0, 0, errors.New("guacd_addr not configured")
	}
	// Plan 13.A.5: 30s gives NLA + self-signed TLS + slow Windows boxes
	// enough room to complete the guacd-side negotiation before our dial
	// context expires.
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	dialer := &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	conn, err := dialer.DialContext(dialCtx, "tcp", b.cfg.GuacdAddr)
	if err != nil {
		return 0, 0, fmt.Errorf("dial guacd: %w", err)
	}
	if tcp, ok := conn.(*net.TCPConn); ok {
		// RDP can sit silent for minutes between user inputs; explicit TCP
		// keep-alive avoids middleboxes (firewalls, NAT) silently dropping
		// the connection.
		_ = tcp.SetKeepAlive(true)
		_ = tcp.SetKeepAlivePeriod(30 * time.Second)
	}
	defer conn.Close()

	// Plan 13.A.6: 16MB read limit absorbs large clipboard pastes coming
	// in from the browser without hitting coder/websocket's default 32KB cap.
	ws.SetReadLimit(16 * 1024 * 1024)

	br := bufio.NewReaderSize(conn, 128*1024)
	bw := bufio.NewWriter(conn)
	if err := handshake(br, bw, p); err != nil {
		return 0, 0, fmt.Errorf("guacd handshake: %w", err)
	}

	// Plan 13.A.4: byte counters. Pass atomics to the copy goroutines. Use the
	// caller's live counters when provided so the gateway can sample mid-session.
	bytesIn, bytesOut := p.BytesIn, p.BytesOut
	if bytesIn == nil {
		bytesIn = new(atomic.Uint64)
	}
	if bytesOut == nil {
		bytesOut = new(atomic.Uint64)
	}

	// Plan 13.A.2: error callback fires at most once per session.
	var errorOnce sync.Once
	cb := p.OnError
	fireErr := func(code int, msg string) {
		if cb == nil {
			return
		}
		errorOnce.Do(func() { cb(code, msg) })
	}

	// Once handshake completes, switch to raw byte streaming in both directions.
	// guacd messages remain semicolon-terminated instructions but we don't
	// need to parse them on the gateway — the browser does.
	g, gctx := errgroup.WithContext(ctx)
	// Watchdog: when any goroutine errors (or external ctx is cancelled),
	// gctx fires. net.Conn.Read does NOT honour ctx, so without this the
	// copyGuacdToWS goroutine would block on guacd's silent socket forever
	// while everyone else has already exited. Setting a past deadline forces
	// in-flight Reads/Writes to return immediately with a timeout error.
	g.Go(func() error {
		<-gctx.Done()
		_ = conn.SetDeadline(time.Now())
		return nil
	})
	g.Go(func() error { return copyWSToGuacd(gctx, ws, conn, bytesIn) })
	// Plan 13.A.1 — ★ THE BUG FIX ★. We must read from `br`, not `conn`,
	// because `bufio.Reader` greedily pre-fetched bytes from the TCP socket
	// into its 128KB buffer during handshake. Any data guacd sent
	// immediately after the `args` instruction (sync, ready, initial cursor
	// state, display size) is sitting in br's buffer right now. Reading
	// `conn` directly would strand those bytes forever, the browser would
	// never see the post-handshake stream, and 2-4 seconds later the
	// Guacamole client gives up and closes the WebSocket with no status
	// code — which is exactly the symptom users reported.
	g.Go(func() error { return copyGuacdToWS(gctx, br, ws, bytesOut, fireErr) })
	// Plan 13.A.3: 15s WS ping defeats reverse-proxy idle timeouts (Nginx
	// 60s default, AWS ALB 60s default) and keeps stateful NAT entries warm.
	g.Go(func() error { return wsPing(gctx, ws) })

	werr := g.Wait()
	if errors.Is(werr, context.Canceled) || errors.Is(werr, io.EOF) {
		werr = nil
	}
	return bytesIn.Load(), bytesOut.Load(), werr
}

// wsPing sends an application-level WebSocket ping every 15s. coder/websocket
// will deliver the pong asynchronously; we only care that Ping itself succeeds
// (a failed write means the WS is dead and we should bail out).
func wsPing(ctx context.Context, ws *websocket.Conn) error {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := ws.Ping(pctx)
			cancel()
			if err != nil {
				return err
			}
		}
	}
}

func handshake(br *bufio.Reader, bw *bufio.Writer, p ConnectParams) error {
	// 1. select <protocol>
	if err := Encode(bw, "select", p.Protocol); err != nil {
		return err
	}
	if err := bw.Flush(); err != nil {
		return err
	}
	// 2. guacd responds with `args`. Read the args list — order matters because
	//    the next `connect` instruction has to supply values in the same order.
	op, args, err := ReadInstruction(br)
	if err != nil {
		return err
	}
	if op != "args" {
		return fmt.Errorf("expected args got %q", op)
	}
	// 3. size, audio, video, image — we declare client capabilities.
	if err := Encode(bw, "size", strconv.Itoa(orDefault(p.Width, 1280)), strconv.Itoa(orDefault(p.Height, 720)), strconv.Itoa(orDefault(p.DPI, 96))); err != nil {
		return err
	}
	if err := Encode(bw, "audio", "audio/L16;rate=44100,channels=2"); err != nil {
		return err
	}
	if err := Encode(bw, "video"); err != nil {
		return err
	}
	if err := Encode(bw, "image", "image/png", "image/jpeg"); err != nil {
		return err
	}
	// 4. timezone (optional but RDP needs it)
	if err := Encode(bw, "timezone", "UTC"); err != nil {
		return err
	}
	// 5. connect <values...> — must align with the `args` order returned by guacd.
	values := make([]string, len(args))
	for i, name := range args {
		values[i] = paramValue(name, p)
	}
	if err := Encode(bw, "connect", values...); err != nil {
		return err
	}
	return bw.Flush()
}

// paramValue maps an arg name (from guacd's `args` response) to the value we
// want to send back. Unknown args get an empty string, which guacd treats as
// "use server default".
func paramValue(name string, p ConnectParams) string {
	switch name {
	case "hostname":
		return p.Hostname
	case "port":
		return strconv.Itoa(orDefault(p.Port, defaultPort(p.Protocol)))
	case "username":
		return p.Username
	case "password":
		return p.Password
	case "domain":
		return p.Domain
	case "security":
		return orDefaultStr(p.Security, "any")
	case "ignore-cert":
		return boolStr(p.IgnoreCert)
	case "color-depth":
		if p.ColorDepth > 0 {
			return strconv.Itoa(p.ColorDepth)
		}
		return "24"
	// Plan 13.B.1 — feature toggles.
	case "disable-audio":
		return boolStr(!p.EnableAudio)
	case "disable-copy":
		return boolStr(!p.EnableClipboard)
	case "disable-paste":
		return boolStr(!p.EnableClipboard)
	case "enable-wallpaper":
		return boolStr(p.EnableWallpaper)
	case "enable-font-smoothing":
		return boolStr(p.EnableFontSmooth)
	case "enable-theming":
		return boolStr(p.EnableTheming)
	case "enable-full-window-drag":
		return boolStr(p.EnableAnimations)
	case "enable-desktop-composition":
		return boolStr(p.EnableAnimations)
	case "enable-menu-animations":
		return boolStr(p.EnableAnimations)
	case "server-layout":
		// Empty = guacd default (en-us-qwerty).
		return p.KeyboardLayout
	case "socks-proxy-host":
		return p.SOCKSHost
	case "socks-proxy-port":
		if p.SOCKSPort == 0 {
			return ""
		}
		return strconv.Itoa(p.SOCKSPort)
	case "socks-proxy-username":
		return p.SOCKSUser
	case "socks-proxy-password":
		return p.SOCKSPass
	case "recording-path":
		return p.RecordingPath
	case "recording-name":
		return p.RecordingName
	case "recording-include-output":
		if p.RecordingPath == "" {
			return ""
		}
		return "true"
	case "recording-include-keys":
		return boolStr(p.RecordingIncludeKeys)
	case "recording-write-existing":
		return "true"
	}
	return ""
}

func defaultPort(proto string) int {
	switch proto {
	case "rdp":
		return 3389
	case "vnc":
		return 5900
	case "ssh":
		return 22
	case "telnet":
		return 23
	}
	return 0
}

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func orDefaultStr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func boolStr(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func copyWSToGuacd(ctx context.Context, ws *websocket.Conn, dst io.Writer, counter *atomic.Uint64) error {
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		if _, err := dst.Write(data); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		counter.Add(uint64(len(data)))
	}
}

// copyGuacdToWS pumps guacd output to the WebSocket. It also scans each chunk
// for a Guacamole `error` instruction and invokes onError on first match —
// best-effort but typically catches NLA / cert / unreachable failures.
func copyGuacdToWS(ctx context.Context, src io.Reader, ws *websocket.Conn, counter *atomic.Uint64, onError func(int, string)) error {
	// 128 KB matches the bufio reader above and absorbs full-frame RDP
	// updates without 4× fragmentation through the WebSocket.
	buf := make([]byte, 128*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if onError != nil {
				if code, msg, ok := scanForGuacError(chunk); ok {
					onError(code, msg)
				}
			}
			if werr := ws.Write(ctx, websocket.MessageText, chunk); werr != nil {
				if ctx.Err() != nil {
					return nil
				}
				return werr
			}
			counter.Add(uint64(n))
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

// scanForGuacError best-effort looks for `<n>.error,<n>.<code>,<n>.<msg>;`
// anywhere in buf. Returns (code, msg, true) on first plausible match.
//
// The scan is intentionally cheap: a single bytes.Index for the literal
// ".error," needle, then a walk backwards for the length-prefix digits, then
// a real ReadInstruction parse from there. Image binary data inside other
// instructions cannot match because they are length-prefixed text segments
// with explicit byte counts.
func scanForGuacError(buf []byte) (int, string, bool) {
	needle := []byte(".error,")
	idx := bytes.Index(buf, needle)
	if idx < 0 {
		return 0, "", false
	}
	// Walk back for the length-prefix digits.
	start := idx
	for start > 0 && buf[start-1] >= '0' && buf[start-1] <= '9' {
		start--
	}
	if start == idx {
		return 0, "", false
	}
	br := bufio.NewReader(bytes.NewReader(buf[start:]))
	op, args, perr := ReadInstruction(br)
	if perr != nil || op != "error" || len(args) < 1 {
		return 0, "", false
	}
	code, err := strconv.Atoi(args[0])
	if err != nil {
		return 0, "", false
	}
	msg := ""
	if len(args) >= 2 {
		msg = args[1]
	}
	return code, msg, true
}

// DecodeCredential pulls a plaintext (user, password) tuple out of a Credential
// row using the supplied Sealer. The credential MUST be of kind "password"; we
// don't yet support smartcard / certificate-based RDP auth in this MVP.
func DecodeCredential(sealer pkgcrypto.Vault, cred *model.Credential) (user, pass string, err error) {
	if cred == nil {
		return "", "", nil
	}
	if cred.Kind != model.CredentialPassword {
		return "", "", fmt.Errorf("guacamole only supports password credentials in this MVP")
	}
	pw, err := sealer.Open(cred.Secret)
	if err != nil {
		return "", "", err
	}
	return cred.Username, string(pw), nil
}

// ParseOptions decodes Node.ProtoOptions JSON into a small map. Used for
// per-node knobs like rdp.security, rdp.domain, vnc.color-depth.
func ParseOptions(s string) map[string]string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil
	}
	return m
}

// RecordingFilename derives a stable cast filename given a session id.
func RecordingFilename(sessionID string) string { return sessionID + ".guac" }

// JoinRecordingDir returns the absolute directory where guacd should drop the
// recording, given a base sessions root.
func JoinRecordingDir(root string) string {
	return filepath.Join(root, time.Now().Format("2006-01-02"))
}

// ApplyQualityPreset returns p with quality-related fields populated to match
// the requested preset. Plan 13.B.2 — driven by `?quality=high|medium|low|auto`
// from the gateway query string.
func ApplyQualityPreset(p ConnectParams, preset string) ConnectParams {
	switch preset {
	case "high":
		p.ColorDepth = 32
		p.EnableWallpaper = true
		p.EnableFontSmooth = true
		p.EnableTheming = true
		p.EnableAnimations = true
	case "low":
		p.ColorDepth = 16
		p.EnableWallpaper = false
		p.EnableFontSmooth = false
		p.EnableTheming = false
		p.EnableAnimations = false
	default: // medium / auto / ""
		if p.ColorDepth == 0 {
			p.ColorDepth = 24
		}
		// wallpaper / theming / animations stay off — saves bandwidth.
		// font smoothing on for legibility.
		p.EnableFontSmooth = true
	}
	return p
}
