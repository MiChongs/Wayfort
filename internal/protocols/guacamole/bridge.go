package guacamole

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
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

// Serve runs until either side closes. The recording, if requested, is written
// by guacd into RecordingPath/RecordingName from guacd's filesystem viewpoint.
func (b *Bridge) Serve(ctx context.Context, ws *websocket.Conn, p ConnectParams) error {
	if b.cfg.GuacdAddr == "" {
		return errors.New("guacd_addr not configured")
	}
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", b.cfg.GuacdAddr)
	if err != nil {
		return fmt.Errorf("dial guacd: %w", err)
	}
	defer conn.Close()
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	if err := handshake(br, bw, p); err != nil {
		return fmt.Errorf("guacd handshake: %w", err)
	}

	// Once handshake completes, switch to raw byte streaming in both directions.
	// guacd messages remain semicolon-terminated instructions but we don't need
	// to parse them on the gateway — the browser does. We track length to update
	// audit byte counters.
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { return copyWSToGuacd(gctx, ws, conn) })
	g.Go(func() error { return copyGuacdToWS(gctx, conn, ws) })
	err = g.Wait()
	if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
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
		return "24"
	case "disable-audio":
		return "false"
	case "enable-wallpaper":
		return "false"
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

func copyWSToGuacd(ctx context.Context, ws *websocket.Conn, dst io.Writer) error {
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		if _, err := dst.Write(data); err != nil {
			return err
		}
	}
}

func copyGuacdToWS(ctx context.Context, src io.Reader, ws *websocket.Conn) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if werr := ws.Write(ctx, websocket.MessageText, buf[:n]); werr != nil {
				return werr
			}
		}
		if err != nil {
			return err
		}
	}
}

// DecodeCredential pulls a plaintext (user, password) tuple out of a Credential
// row using the supplied Sealer. The credential MUST be of kind "password"; we
// don't yet support smartcard / certificate-based RDP auth in this MVP.
func DecodeCredential(sealer *pkgcrypto.Sealer, cred *model.Credential) (user, pass string, err error) {
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
