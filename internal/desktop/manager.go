package desktop

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/michongs/wayfort/internal/approval"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/livewatch"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/michongs/wayfort/internal/socks5"
	pkgssh "github.com/michongs/wayfort/internal/ssh"
	"go.uber.org/zap"
	"golang.org/x/net/proxy"
)

// DialChainFunc resolves a node's Wayfort proxy chain into a ContextDialer
// that tunnels TCP to the target through every hop, plus a release func that
// MUST be called exactly once when the session ends to decrement bastion
// refcounts. Wired from main.go using the same webssh.Gateway ResolveHops +
// BuildChain path guacamole and tcpfwd use. A nil DialChain (or a node with no
// proxy_chain) means the worker dials the target directly.
type DialChainFunc func(ctx context.Context, node *model.Node) (proxy.ContextDialer, func(), error)

// Manager orchestrates Plan 17 desktop sessions: validates auth, picks a
// worker backend, spawns it, and hands the WS handler a Session it can
// drive end-to-end.
type Manager struct {
	cfg      config.DesktopConfig
	logger   *zap.Logger
	nodes    *repo.NodeRepo
	creds    *repo.CredentialRepo
	asset    *asset.Resolver
	sealer   PasswordOpener
	audit    *audit.Writer
	sessions *repo.SessionRepo
	// metrics is the lifecycle-v3 connection-quality sample queue. Nil-safe.
	metrics *audit.MetricWriter
	// liveHub fans a desktop session's frames to read-only observers. Nil-safe.
	liveHub *livewatch.Hub
	// approval is wired post-construction via SetApproval; nil = no
	// gating (StartSession behaves as before Phase 16).
	approval *approval.Service

	mu      sync.Mutex
	live    map[string]*Session // sessionID → Session
	maxLive int
	created atomic.Int64
	// Plan 18 — true once EnsureWorker has either found or built the
	// worker binary. Sessions started before this flips get a 503.
	workerReady atomic.Bool
	// Plan 19.5 — bootstrap state surfaced via /desktop/stats so the
	// operator can debug "why isn't auto_install running?" without
	// grepping logs. All three are accessed via atomic.Value to keep
	// reader paths lock-free.
	bootstrapErr      atomic.Value // string — empty when no error
	bootstrapAt       atomic.Value // time.Time — last bootstrap attempt finish
	bootstrapInFlight atomic.Bool
	// Resolved path to the worker binary, populated by EnsureWorker.
	// Mirrored back into m.cfg.WorkerPath for backwards compat but
	// exposed here so /desktop/stats can show the resolved path even
	// when the operator left worker_path blank.
	workerPath atomic.Value // string

	// Plan 29 — ironrdp backend. Both nil for builds that don't use
	// Devolutions Gateway; the manager checks before serving an
	// `ironrdp` StartSession request. Set once at startup via
	// AttachIronRDP() and never mutated thereafter.
	jwtSigner  *JWTSigner
	gatewaySup *GatewaySupervisor

	// dialChain routes the freerdp worker's TCP connection through the node's
	// Wayfort proxy chain via a per-session SOCKS5 listener. Nil = direct
	// dial (matches pre-proxy-chain behaviour).
	dialChain DialChainFunc
}

// PasswordOpener is the subset of pkgcrypto.Sealer we need (decrypt one blob).
type PasswordOpener interface {
	Open(secret []byte) ([]byte, error)
}

type Deps struct {
	Logger   *zap.Logger
	Nodes    *repo.NodeRepo
	Creds    *repo.CredentialRepo
	Asset    *asset.Resolver
	Sealer   PasswordOpener
	Audit    *audit.Writer
	Sessions *repo.SessionRepo
	// Metrics (optional) is the connection-quality sample queue. Leave nil to
	// disable RTT / bandwidth sampling for desktop sessions.
	Metrics *audit.MetricWriter
	// LiveHub (optional) fans desktop frames to read-only observers. Nil disables
	// monitoring.
	LiveHub *livewatch.Hub
	// DialChain (optional) routes the freerdp worker through the node's proxy
	// chain. Leave nil to keep direct-dial behaviour.
	DialChain DialChainFunc
}

func NewManager(cfg config.DesktopConfig, deps Deps) *Manager {
	max := cfg.MaxConcurrentSessions
	if max <= 0 {
		max = 64
	}
	return &Manager{
		cfg:       cfg,
		logger:    deps.Logger,
		nodes:     deps.Nodes,
		creds:     deps.Creds,
		asset:     deps.Asset,
		sealer:    deps.Sealer,
		audit:     deps.Audit,
		sessions:  deps.Sessions,
		metrics:   deps.Metrics,
		liveHub:   deps.LiveHub,
		dialChain: deps.DialChain,
		live:      map[string]*Session{},
		maxLive:   max,
	}
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// WebRTCConfig exposes the WebRTC video-path tuning to the WS handler so it can
// build per-session Pion bridges with the operator's ICE / bitrate settings.
func (m *Manager) WebRTCConfig() config.DesktopWebRTCConfig { return m.cfg.WebRTC }

// AttachIronRDP wires in the JWT signer + Devolutions Gateway supervisor
// that back the `ironrdp` desktop backend. Must be called before
// StartSession can serve `ironrdp` requests. Idempotent.
func (m *Manager) AttachIronRDP(signer *JWTSigner, sup *GatewaySupervisor) {
	m.jwtSigner = signer
	m.gatewaySup = sup
}

// SetApproval wires the Phase 16 approval gate; pass nil to keep the
// pre-Phase-16 behaviour.
func (m *Manager) SetApproval(svc *approval.Service) { m.approval = svc }

// EnsureGateway brings up the Devolutions Gateway subprocess (and
// generates its on-disk config) if the ironrdp backend is enabled.
// Safe to call when no supervisor is attached — it's a no-op then.
// Called once at startup from cmd/wayfort/main.go inside the same
// errgroup that runs EnsureWorker, so both backends are independent.
func (m *Manager) EnsureGateway(ctx context.Context) error {
	if m.gatewaySup == nil {
		return nil
	}
	return m.gatewaySup.Ensure(ctx)
}

// StopGateway tears down the Devolutions Gateway subprocess. Called on
// graceful shutdown from main.go.
func (m *Manager) StopGateway() error {
	if m.gatewaySup == nil {
		return nil
	}
	return m.gatewaySup.Stop()
}

// StartSession handles the control-plane request. It performs auth, looks
// up node + credential, spawns the worker, registers the live Session.
// Returns the opaque session_id the browser uses to open the WS data
// channel.
func (m *Manager) StartSession(ctx context.Context, claims *auth.Claims, clientIP string, req StartSessionRequest) (*StartSessionResponse, error) {
	if !m.cfg.Enabled {
		return nil, errors.New("desktop subsystem disabled")
	}
	// Plan 18 — gate the freerdp backend on workerReady. The dummy
	// in-process backend is always available.
	backend := req.Backend
	if backend == "" {
		backend = m.cfg.DefaultBackend
	}
	if backend == "freerdp" && !m.workerReady.Load() {
		return nil, errors.New("desktop worker bootstrapping (libfreerdp + go build); retry in 30-90s")
	}
	if backend == "ironrdp" {
		if m.jwtSigner == nil || m.gatewaySup == nil {
			return nil, errors.New("ironrdp backend not configured (set desktop.devolutions_gateway.enabled = true)")
		}
		if !m.gatewaySup.Ready() {
			return nil, errors.New("devolutions gateway subprocess not ready; check /desktop/stats")
		}
	}
	m.mu.Lock()
	if len(m.live) >= m.maxLive {
		m.mu.Unlock()
		return nil, fmt.Errorf("too many desktop sessions (max %d)", m.maxLive)
	}
	m.mu.Unlock()

	// Authorise on the node.
	if m.asset != nil {
		ok, err := m.asset.Check(ctx, claims.UserID, req.NodeID, asset.ActionConnect)
		if err != nil {
			return nil, fmt.Errorf("asset check: %w", err)
		}
		if !ok {
			return nil, errors.New("not authorised on this node")
		}
	}

	// Phase 16 — approval gate (asset_access). Same flag as webssh /
	// dbcli / guacamole; the desktop backend is just another way to
	// reach the same privileged target.
	var grantDeadline time.Time
	approvalCheck := approval.EnforcementCheck{
		UserID:       claims.UserID,
		BusinessType: model.ApprovalBizAssetAccess,
		ResourceType: "node",
		ResourceID:   strconv.FormatUint(req.NodeID, 10),
		Action:       "connect",
	}
	if m.approval != nil {
		res, err := m.approval.CheckEnforced(ctx, approvalCheck)
		if err != nil {
			return nil, fmt.Errorf("approval check failed: %w", err)
		}
		if !res.Allowed {
			return nil, errors.New(res.Reason)
		}
		if res.Required && !res.ExpiresAt.IsZero() {
			grantDeadline = res.ExpiresAt
		}
	}
	node, err := m.nodes.FindByID(ctx, req.NodeID)
	if err != nil || node == nil {
		return nil, fmt.Errorf("node %d not found", req.NodeID)
	}
	if node.Disabled {
		return nil, errors.New("node disabled")
	}
	// Decode credential. RDP needs a password credential; we re-use the
	// same Sealer path the guacd handler uses (Plan 12 bridge.go).
	cred, err := m.creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return nil, errors.New("credential lookup failed")
	}
	if cred.Kind != model.CredentialPassword {
		return nil, errors.New("desktop subsystem requires a password credential (V1)")
	}
	pw, err := m.sealer.Open(cred.Secret)
	if err != nil {
		return nil, fmt.Errorf("decrypt credential: %w", err)
	}

	// Common bookkeeping shared by all backends. We mint our own UUID
	// because the session row table doesn't need to know which backend
	// is running underneath.
	sessionID := uuid.NewString()
	rdpOpts := ParseRdpOptions(node.ProtoOptions)
	// Expand the network preset (lan/wan/mobile/…) into concrete connection-
	// tuning fields BEFORE capability gating, so the worker only ever sees fully
	// resolved values. The preset fills only the fields the operator left unset,
	// so explicit per-field overrides survive.
	rdpOpts = rdpOpts.ResolveNetworkPreset()
	// Apply browser-side capability gating. The frontend probes
	// WebCodecs.VideoDecoder + ImageDecoder via lib/desktop/capabilities.ts
	// before this POST and sends the result in req.ClientCaps. If the
	// browser can't decode H.264 we suppress GFX + H.264 here so
	// libfreerdp's negotiation never advertises a codec that would
	// land unrendered. RFX stays guided by the per-node options because
	// it's currently always off client-side.
	if req.ClientCaps != nil {
		if !req.ClientCaps.H264 {
			no := false
			rdpOpts.EnableH264 = &no
			rdpOpts.EnableGraphicsPipeline = &no
		}
		// The browser currently never ships an RFX decoder (ClientCaps.RFX is
		// always false). If a node opted into RemoteFX, suppress it here so the
		// worker can't negotiate a codec whose frames the browser would drop —
		// which would otherwise leave a connected session on a blank screen.
		if !req.ClientCaps.RFX {
			no := false
			rdpOpts.EnableRemoteFx = &no
		}
		// zstd is opt-in per client: the worker only emits zstd_bgra when the
		// browser advertised it can inflate it (its decode worker bundles a
		// zstd-wasm decoder). Older/cached frontends stay on zlib_bgra.
		if req.ClientCaps.Zstd {
			yes := true
			rdpOpts.PreferZstd = &yes
		}
	}
	keyboard := req.Keyboard
	if keyboard == "" {
		keyboard = rdpOpts.Keyboard
	}
	username := pkgssh.PreferredUser(cred, node.Username)
	width := req.Width
	height := req.Height
	if width == 0 {
		width = 1280
	}
	if height == 0 {
		height = 720
	}

	// High-DPI scale factor (percent). The browser sends its devicePixelRatio-
	// derived scale in req.Scale; the node can disable it (rdp.high_dpi=false)
	// or cap it (rdp.max_scale). Default ON. width/height above are the LOGICAL
	// resolution; for the freerdp backend we multiply by scale below to get the
	// physical render resolution and hand the worker the scale factor so Windows
	// applies matching display scaling. ironrdp keeps the logical size (its Wasm
	// client exposes no scale-factor API).
	scale := int(req.Scale)
	if scale <= 0 {
		scale = 100
	}
	if rdpOpts.HighDPI != nil && !*rdpOpts.HighDPI {
		scale = 100
	}
	if scale < 100 {
		scale = 100
	}
	if scale > 500 {
		scale = 500
	}
	if rdpOpts.MaxScale != nil && *rdpOpts.MaxScale >= 100 && scale > int(*rdpOpts.MaxScale) {
		scale = int(*rdpOpts.MaxScale)
	}

	if backend == "ironrdp" {
		dst := fmt.Sprintf("%s:%d", node.Host, node.Port)
		ttl := m.cfg.DevolutionsGateway.TokenTTL
		if ttl <= 0 {
			ttl = 90 * time.Second
		}
		token, err := m.jwtSigner.SignForwardRDP(dst, ttl)
		if err != nil {
			return nil, fmt.Errorf("mint jwt: %w", err)
		}
		sess := &Session{
			ID:        sessionID,
			NodeID:    req.NodeID,
			UserID:    claims.UserID,
			Username:  claims.Username,
			ClientIP:  clientIP,
			StartedAt: time.Now(),
			manager:   m,
		}
		m.register(sess)
		m.recordStart(ctx, sess, node)
		return &StartSessionResponse{
			SessionID:    sessionID,
			RemoteWidth:  width,
			RemoteHeight: height,
			Backend:      "ironrdp",
			GatewayURL:   m.gatewaySup.AdvertisedURL(),
			Token:        token,
			Destination:  dst,
			Username:     username,
			Password:     string(pw),
			Domain:       rdpOpts.Domain,
		}, nil
	}

	// freerdp / dummy path — spawn the local worker subprocess (or
	// in-process test pattern) and stream frames through our WS handler.
	worker, err := m.pickWorker(req.Backend)
	if err != nil {
		return nil, fmt.Errorf("pick worker: %w", err)
	}

	// Route the worker's TCP connection through the node's resolved connectivity
	// (network domain or legacy ProxyChain) when it has any hops — mirrors how
	// guacamole and tcpfwd reach the same targets. A per-session SOCKS5
	// listener on 127.0.0.1 tunnels libfreerdp's connect through the resolved
	// chain; libfreerdp still connects to node.Host:node.Port, just via the
	// proxy. dialChain returns a nil dialer for zero-hop (direct) nodes, so the
	// listener is set up only when there's an actual chain. No DialChain wired =
	// direct dial.
	var socksHost string
	var socksPort int
	var socksClose func()
	if m.dialChain != nil {
		dlr, release, derr := m.dialChain(ctx, node)
		if derr != nil {
			return nil, fmt.Errorf("build proxy chain for node %d: %w", req.NodeID, derr)
		}
		if dlr != nil {
			target := fmt.Sprintf("%s:%d", node.Host, node.Port)
			sl, lerr := socks5.New(context.Background(), "127.0.0.1", dlr, target, m.logger)
			if lerr != nil {
				if release != nil {
					release()
				}
				return nil, fmt.Errorf("start socks listener: %w", lerr)
			}
			socksHost = sl.Host()
			socksPort = sl.Port()
			var once sync.Once
			socksClose = func() {
				once.Do(func() {
					_ = sl.Close()
					if release != nil {
						release()
					}
				})
			}
		} else if release != nil {
			release()
		}
	}

	// Redirect the per-user file drive into the session (freerdp only). A
	// failure here must never block the session — the desktop just comes up
	// without the drive.
	driveName, drivePath := "", ""
	if backend == "freerdp" {
		if dir, derr := m.ensureUserDrive(claims.UserID); derr != nil {
			m.logger.Warn("desktop drive folder unavailable",
				zap.Uint64("user", claims.UserID), zap.Error(derr))
		} else if dir != "" {
			drivePath = dir
			driveName = m.cfg.Drive.Name
			if driveName == "" {
				driveName = "Wayfort"
			}
			m.logger.Info("desktop drive redirect prepared",
				zap.Uint64("user", claims.UserID),
				zap.String("drive_name", driveName),
				zap.String("drive_path", drivePath))
		}
	} else {
		m.logger.Debug("desktop drive redirect skipped (non-freerdp backend)",
			zap.String("backend", backend))
	}

	// WebRTC video path. Only for the freerdp backend, only when the operator
	// enabled it AND the browser advertised it can run an RTCPeerConnection +
	// decode VP8 (req.ClientCaps.WebRTC). Otherwise the session uses the legacy
	// WS bitmap path. The worker reads VideoMode at connect to disable the GFX
	// pipeline and VP8-encode the composited framebuffer instead.
	videoMode := ""
	var iceServers []ICEServer
	videoBitrate := m.cfg.WebRTC.BitrateKbps
	if backend == "freerdp" {
		videoMode = m.decideVideoMode(req, rdpOpts.PreferAV1 != nil && *rdpOpts.PreferAV1)
		if videoMode != "" {
			iceServers = m.webrtcICEServers()
			videoBitrate = m.videoBitrateForQuality(req.VideoQuality)
			m.logger.Info("desktop webrtc video path enabled for session",
				zap.String("session", sessionID),
				zap.String("codec", videoMode),
				zap.String("transport_pref", req.VideoTransport),
				zap.String("quality", req.VideoQuality),
				zap.Int("bitrate_kbps", videoBitrate),
				zap.Int("fps", m.cfg.WebRTC.FPS),
				zap.Int("ice_servers", len(iceServers)))
		}
	}

	// RD Gateway (MS-TSGU): resolve the gateway config when the node is published
	// only through a Microsoft Remote Desktop Gateway. Same-credentials (default)
	// lets the worker reuse the target login for the gateway; otherwise a separate
	// sealed credential supplies the gateway login (keeps its password out of
	// proto_options). freerdp backend only.
	var gw struct {
		host, user, pass, domain, transport string
		port                                int
		useSame                             bool
	}
	if backend == "freerdp" && strings.TrimSpace(rdpOpts.GatewayHost) != "" {
		gw.host = strings.TrimSpace(rdpOpts.GatewayHost)
		gw.port = 443
		if rdpOpts.GatewayPort != nil && *rdpOpts.GatewayPort > 0 && *rdpOpts.GatewayPort <= 65535 {
			gw.port = int(*rdpOpts.GatewayPort)
		}
		gw.transport = rdpOpts.GatewayTransport
		gw.domain = rdpOpts.GatewayDomain
		gw.useSame = rdpOpts.GatewayUseSameCredentials == nil || *rdpOpts.GatewayUseSameCredentials
		if gw.useSame {
			if gw.domain == "" {
				gw.domain = rdpOpts.Domain
			}
		} else if rdpOpts.GatewayCredentialID != nil {
			if gwCred, gerr := m.creds.FindByID(ctx, *rdpOpts.GatewayCredentialID); gerr == nil && gwCred != nil && gwCred.Kind == model.CredentialPassword {
				if gwpw, oerr := m.sealer.Open(gwCred.Secret); oerr == nil {
					gw.user = gwCred.Username
					gw.pass = string(gwpw)
				} else {
					m.logger.Warn("rd gateway credential decrypt failed",
						zap.Uint64("credential", *rdpOpts.GatewayCredentialID), zap.Error(oerr))
				}
			} else {
				m.logger.Warn("rd gateway credential lookup failed (gateway login may be incomplete)",
					zap.Uint64("credential", *rdpOpts.GatewayCredentialID))
			}
		}
		m.logger.Info("rd gateway enabled for session",
			zap.String("session", sessionID),
			zap.String("gateway_host", gw.host),
			zap.Int("gateway_port", gw.port),
			zap.Bool("same_credentials", gw.useSame),
			zap.String("transport", gw.transport))
	}

	// freerdp path: scale the LOGICAL resolution up to the physical render
	// resolution. The recorder + StartSessionResponse below then report the
	// physical size, so the browser canvas backing store matches 1:1 with the
	// client's physical pixels (crisp), while the worker's scale factor makes
	// Windows render its UI at the right size rather than tiny.
	if scale > 100 {
		physW := uint32(int(width) * scale / 100)
		physH := uint32(int(height) * scale / 100)
		const maxDim = 8192 // FreeRDP / Windows desktop dimension ceiling
		if physW > maxDim {
			physW = maxDim
		}
		if physH > maxDim {
			physH = maxDim
		}
		width, height = physW, physH
	}

	startParams := StartParams{
		NodeID:                    req.NodeID,
		Host:                      node.Host,
		Port:                      node.Port,
		Username:                  username,
		Password:                  string(pw),
		Domain:                    rdpOpts.Domain,
		Width:                     int(width),
		Height:                    int(height),
		Scale:                     scale,
		Keyboard:                  keyboard,
		Quality:                   req.Quality,
		RDP:                       rdpOpts,
		SOCKSHost:                 socksHost,
		SOCKSPort:                 socksPort,
		DriveName:                 driveName,
		DrivePath:                 drivePath,
		VideoMode:                 videoMode,
		VideoBitrateKbps:          videoBitrate,
		VideoFPS:                  m.cfg.WebRTC.FPS,
		GatewayHost:               gw.host,
		GatewayPort:               gw.port,
		GatewayUseSameCredentials: gw.useSame,
		GatewayUsername:           gw.user,
		GatewayPassword:           gw.pass,
		GatewayDomain:             gw.domain,
		GatewayTransport:          gw.transport,
	}
	wctx, cancel := context.WithCancel(context.Background())
	if err := worker.Start(wctx, startParams); err != nil {
		cancel()
		if socksClose != nil {
			socksClose()
		}
		return nil, fmt.Errorf("worker start: %w", err)
	}
	sess := &Session{
		ID:               sessionID,
		Worker:           worker,
		NodeID:           req.NodeID,
		UserID:           claims.UserID,
		Username:         claims.Username,
		ClientIP:         clientIP,
		StartedAt:        time.Now(),
		VideoMode:        videoMode,
		VideoBitrateKbps: videoBitrate,
		cancel:           cancel,
		manager:          m,
		socksClose:       socksClose,
	}
	// Session recording (.dtr tape) — best-effort: a recorder failure must
	// never block the live session, so we just log and carry on unrecorded.
	if m.cfg.Recording.Enabled {
		if rec, recPath, rerr := m.startRecorder(sessionID, uint16(width), uint16(height)); rerr != nil {
			m.logger.Warn("desktop recording unavailable for session",
				zap.String("session", sessionID), zap.Error(rerr))
		} else {
			sess.recorder = rec
			sess.recordingPath = recPath
			rec.WriteEvent(RecordingEvent{Type: "session-start", Width: uint32(width), Height: uint32(height)})
		}
	}
	m.register(sess)
	// Server-side hard cutoff (renewal-aware): end the session when the approval
	// grant lapses; a renewal before expiry keeps it alive.
	if m.approval != nil && !grantDeadline.IsZero() {
		sess.expiryStop = m.approval.WatchGrant(wctx, approvalCheck, grantDeadline, func(reason string) {
			_ = m.End(context.Background(), sessionID)
		})
	}
	m.recordStart(ctx, sess, node)
	return &StartSessionResponse{
		SessionID:    sessionID,
		RemoteWidth:  width,
		RemoteHeight: height,
		Backend:      backend,
		VideoMode:    videoMode,
		ICEServers:   iceServers,
	}, nil
}

// decideVideoMode resolves the per-session video transport (and, for WebRTC,
// the codec) from the user's explicit choice, the browser's advertised
// capabilities, and the operator's config. Returns the codec ("vp8"/"vp9") for
// the WebRTC path or "" for the legacy JS bitmap path.
//
//   - operator gate: desktop.webrtc.enabled = false → always "" (bitmap).
//   - user "bitmap"  → "" (force JS).
//   - user "webrtc"/"auto"/"" → WebRTC iff the browser advertised it can run a
//     peer connection (ClientCaps.WebRTC); a browser that can't always falls to
//     bitmap regardless of the choice.
//   - codec: "vp9" when the operator prefers it (desktop.webrtc.codec) and the
//     browser can decode VP9 (ClientCaps.WebRTCVP9); otherwise "vp8".
func (m *Manager) decideVideoMode(req StartSessionRequest, preferAV1 bool) string {
	if !m.cfg.WebRTC.Enabled {
		return ""
	}
	if strings.EqualFold(strings.TrimSpace(req.VideoTransport), "bitmap") {
		return ""
	}
	caps := req.ClientCaps
	if caps == nil || !caps.WebRTC {
		return "" // browser can't run a WebRTC peer connection
	}
	// AV1 first when the node opted in (rdp.prefer_av1) and the browser advertised
	// it can decode an AV1 WebRTC track — most bandwidth-efficient at equal
	// quality. Falls through to VP9/VP8 when either side can't do AV1.
	if preferAV1 && caps.WebRTCAV1 {
		return "av1"
	}
	if strings.EqualFold(strings.TrimSpace(m.cfg.WebRTC.Codec), "vp9") && caps.WebRTCVP9 {
		return "vp9"
	}
	return "vp8"
}

// videoBitrateForQuality maps the per-session quality choice onto a VP8/VP9
// target bitrate, scaling the operator's configured "balanced" baseline.
func (m *Manager) videoBitrateForQuality(quality string) int {
	base := m.cfg.WebRTC.BitrateKbps
	if base <= 0 {
		base = 8000
	}
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "smooth":
		return base / 2
	case "sharp":
		return base * 2
	default: // "balanced" / ""
		return base
	}
}

// webrtcICEServers builds the browser-facing ICE configuration from the WebRTC
// config (STUN list + optional TURN). The same servers the gateway's own Pion
// bridge uses, so both ends agree on the relay path.
func (m *Manager) webrtcICEServers() []ICEServer {
	var servers []ICEServer
	if len(m.cfg.WebRTC.STUNURLs) > 0 {
		servers = append(servers, ICEServer{URLs: m.cfg.WebRTC.STUNURLs})
	}
	if m.cfg.WebRTC.TURNURL != "" {
		servers = append(servers, ICEServer{
			URLs:       []string{m.cfg.WebRTC.TURNURL},
			Username:   m.cfg.WebRTC.TURNUsername,
			Credential: m.cfg.WebRTC.TURNPassword,
		})
	}
	return servers
}

func (m *Manager) pickWorker(backend string) (DesktopWorker, error) {
	if backend == "" {
		backend = m.cfg.DefaultBackend
	}
	switch backend {
	case "dummy":
		return NewDummyWorker(m.logger), nil
	case "freerdp":
		path, _ := m.workerPath.Load().(string)
		if path == "" {
			return nil, errors.New("freerdp worker path not resolved; check /desktop/stats and ensure bootstrap completed")
		}
		return NewFreeRDPWorker(m.logger, path, WithDebugLog(m.cfg.DebugLog)), nil
	case "ironrdp":
		return nil, errors.New("ironrdp backend doesn't use a local worker; route through StartSession's ironrdp branch")
	default:
		return nil, fmt.Errorf("unknown desktop backend %q (supported: freerdp, dummy, ironrdp)", backend)
	}
}

// BootstrapStatus snapshots the current worker / bootstrap state. Used by
// the /desktop/stats handler so operators can debug auto_install without
// digging through logs.
type BootstrapStatus struct {
	Enabled       bool      `json:"enabled"`
	Backend       string    `json:"default_backend"`
	WorkerReady   bool      `json:"worker_ready"`
	WorkerPath    string    `json:"worker_path"`
	AutoInstall   bool      `json:"auto_install"`
	InFlight      bool      `json:"bootstrap_in_flight"`
	LastError     string    `json:"last_bootstrap_error,omitempty"`
	LastAttemptAt time.Time `json:"last_bootstrap_at,omitempty"`
	// Gateway is the Devolutions Gateway supervisor snapshot when the
	// ironrdp backend is configured. Zero-value struct otherwise.
	Gateway GatewayStatus `json:"devolutions_gateway"`
}

func (m *Manager) BootstrapStatus() BootstrapStatus {
	path, _ := m.workerPath.Load().(string)
	lastErr, _ := m.bootstrapErr.Load().(string)
	lastAt, _ := m.bootstrapAt.Load().(time.Time)
	bs := BootstrapStatus{
		Enabled:       m.cfg.Enabled,
		Backend:       m.cfg.DefaultBackend,
		WorkerReady:   m.workerReady.Load(),
		WorkerPath:    path,
		AutoInstall:   m.cfg.AutoInstall,
		InFlight:      m.bootstrapInFlight.Load(),
		LastError:     lastErr,
		LastAttemptAt: lastAt,
	}
	if m.gatewaySup != nil {
		bs.Gateway = m.gatewaySup.Snapshot()
	}
	return bs
}

func (m *Manager) register(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.live[s.ID] = s
	m.created.Add(1)
}

func (m *Manager) Take(sessionID string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.live[sessionID]
	if !ok {
		return nil
	}
	return s
}

// LiveHub exposes the read-only monitoring hub to the observe handler.
func (m *Manager) LiveHub() *livewatch.Hub { return m.liveHub }

// RunReaper closes desktop sessions whose browser never opened the data WS
// within the grace window. StartSession registers a live session + active row
// before the browser connects /ws/v2/desktop/:id; if that WS never arrives
// (tab closed during connect, network drop), nothing else would ever close the
// row — it would linger as a phantom "active" session. Attached sessions clean
// themselves up via the WS handler's teardown, so this only reaps the stragglers.
func (m *Manager) RunReaper(ctx context.Context) error {
	const attachGrace = 2 * time.Minute
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case now := <-t.C:
			var stale []string
			m.mu.Lock()
			for id, s := range m.live {
				if !s.attached.Load() && now.Sub(s.StartedAt) > attachGrace {
					stale = append(stale, id)
				}
			}
			m.mu.Unlock()
			for _, id := range stale {
				m.logger.Info("reaping desktop session that never attached", zap.String("session", id))
				_ = m.End(context.Background(), id)
			}
		}
	}
}

func (m *Manager) End(ctx context.Context, sessionID string) error {
	m.mu.Lock()
	s, ok := m.live[sessionID]
	if !ok {
		m.mu.Unlock()
		return errors.New("session not found")
	}
	delete(m.live, sessionID)
	m.mu.Unlock()
	if s.expiryStop != nil {
		s.expiryStop()
	}
	if s.cancel != nil {
		s.cancel()
	}
	// Worker is nil for ironrdp sessions — the browser talks RDP
	// directly to the Devolutions Gateway subprocess, so there's
	// nothing local to close.
	if s.Worker != nil {
		if err := s.Worker.Close(); err != nil {
			m.logger.Warn("worker close", zap.String("session", sessionID), zap.Error(err))
		}
	}
	if s.socksClose != nil {
		s.socksClose()
	}
	if s.recorder != nil {
		s.recorder.WriteEvent(RecordingEvent{Type: "session-end"})
		_ = s.recorder.Close()
	}
	m.recordEnd(ctx, s, nil)
	return nil
}

// TerminateSession force-closes a live desktop session owned by this manager.
// It reports whether the session was found so the API handler can fall back to
// a direct row update for sessions it doesn't own.
func (m *Manager) TerminateSession(ctx context.Context, sessionID string) bool {
	m.mu.Lock()
	s, ok := m.live[sessionID]
	if ok {
		s.terminated = true
	}
	m.mu.Unlock()
	if !ok {
		return false
	}
	_ = m.End(ctx, sessionID)
	return true
}

// ensureUserDrive returns the per-user folder that gets redirected into RDP
// sessions as a drive, creating it on first use. Returns "" (no error) when
// drive redirection is disabled. The same folder is what the browser file
// panel reads and writes, so uploads appear in the remote desktop instantly.
func (m *Manager) ensureUserDrive(userID uint64) (string, error) {
	if !m.cfg.Drive.Enabled || m.cfg.Drive.Dir == "" {
		return "", nil
	}
	dir := filepath.Join(m.cfg.Drive.Dir, fmt.Sprintf("user-%d", userID))
	// Always hand libfreerdp an absolute path. A relative drive path makes the
	// drive subsystem resolve files against the worker's cwd, which the remote
	// server's root enumeration can't follow — the drive then gets dropped.
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	return dir, nil
}

// startRecorder opens a .dtr tape for the session under the configured
// recording dir (resolved to <sessions_dir>/desktop-recordings in main.go;
// falls back to a relative dir otherwise).
func (m *Manager) startRecorder(sessionID string, w, h uint16) (*Recorder, string, error) {
	dir := m.cfg.Recording.Dir
	if dir == "" {
		dir = "desktop-recordings"
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, "", err
	}
	p := filepath.Join(dir, sessionID+".dtr")
	rec, err := NewRecorder(p, w, h, m.cfg.Recording.IncludeInput, time.Now())
	if err != nil {
		return nil, "", err
	}
	return rec, p, nil
}

// Stats for ops visibility.
func (m *Manager) Stats() (live int, total int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.live), m.created.Load()
}

// recordStart writes session + audit rows so existing /sessions list +
// audit_logs queries pick up the new desktop sessions automatically.
func (m *Manager) recordStart(ctx context.Context, s *Session, node *model.Node) {
	if m.sessions == nil || m.audit == nil {
		return
	}
	row := &model.Session{
		ID:        s.ID,
		Kind:      model.SessionGraphical,
		UserID:    s.UserID,
		Username:  s.Username,
		ClientIP:  s.ClientIP,
		StartedAt: s.StartedAt,
		Status:    model.SessionActive,
	}
	if s.recordingPath != "" {
		row.RecordingPath = s.recordingPath
		row.RecordingType = model.RecordingDesktop
	}
	if node != nil {
		nid := node.ID
		row.NodeID = &nid
		row.NodeName = node.Name
	}
	if err := m.sessions.Create(ctx, row); err != nil {
		m.logger.Warn("desktop session create failed", zap.Error(err))
	}
	s.sessionRow = row
	s.sink = m.metrics.Sink(s.ID)
	if m.liveHub != nil {
		m.liveHub.EnsureSession(s.ID, livewatch.ModeDesktop)
	}
	m.audit.Log(model.AuditLog{
		Kind:      model.AuditGraphicalStart,
		UserID:    s.UserID,
		Username:  s.Username,
		SessionID: s.ID,
		NodeID:    row.NodeID,
		ClientIP:  s.ClientIP,
		Payload:   "desktop-v2",
	})
}

func (m *Manager) recordEnd(ctx context.Context, s *Session, runErr error) {
	if m.liveHub != nil {
		m.liveHub.CloseSession(s.ID)
	}
	if m.sessions == nil || m.audit == nil || s.sessionRow == nil {
		return
	}
	end := time.Now()
	s.sessionRow.EndedAt = &end
	switch {
	case s.terminated:
		s.sessionRow.Status = model.SessionTerminated
		s.sessionRow.Reason = "管理员强制下线"
	case runErr != nil:
		s.sessionRow.Status = model.SessionErrored
		s.sessionRow.Reason = truncateReason(runErr.Error())
	default:
		s.sessionRow.Status = model.SessionClosed
	}
	// Backfill phase + quality rollups, then persist the end fields with a
	// partial update so ready_at / current_phase set mid-session aren't
	// clobbered by a full-row Save.
	m.finalizeLifecycle(s)
	if err := m.sessions.Finish(ctx, s.ID, map[string]any{
		"ended_at":        end,
		"bytes_in":        s.bytesIn.Load(),
		"bytes_out":       s.bytesOut.Load(),
		"status":          s.sessionRow.Status,
		"reason":          s.sessionRow.Reason,
		"current_phase":   s.sessionRow.CurrentPhase,
		"peak_rtt_ms":     s.sessionRow.PeakRTTMs,
		"avg_rtt_ms":      s.sessionRow.AvgRTTMs,
		"reconnect_count": s.sessionRow.ReconnectCount,
	}); err != nil {
		m.logger.Warn("desktop session finish failed", zap.Error(err))
	}
	m.audit.Log(model.AuditLog{
		Kind:      model.AuditSessionEnd,
		UserID:    s.UserID,
		Username:  s.Username,
		SessionID: s.ID,
		NodeID:    s.sessionRow.NodeID,
		ClientIP:  s.ClientIP,
	})
}

func truncateReason(s string) string {
	if len(s) > 250 {
		return s[:250]
	}
	return s
}
