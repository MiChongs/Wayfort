package desktop

// webrtc.go — gateway-side WebRTC video bridge (Pion). When a freerdp session
// runs in VideoMode "vp8", the worker VP8-encodes the composited framebuffer
// and emits ServerMessage.Video access units. This bridge owns a per-session
// Pion PeerConnection with a single VP8 video track: it answers the browser's
// SDP offer over the existing desktop WS, trickles ICE both ways, writes each
// VP8 access unit to the track (browser GPU-decodes it in a <video> element),
// and relays RTCP PLI/FIR back to the worker as a keyframe request.
//
// The bridge never sends video over the WS — only signaling (answer + ICE).
// If WebRTC negotiation fails, the browser switches the worker back to the
// bitmap path (ClientMessage.VideoMode "bitmap"); this bridge then simply stops
// receiving Video messages and the WS handler forwards the legacy frames again.

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/michongs/wayfort/internal/config"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"go.uber.org/zap"
)

// ABR bounds (kbps). The GCC estimate is clamped into this band before it's fed
// to the worker's encoder: never below the floor (keep text legible on a starved
// link) nor above the per-session quality-tier ceiling (don't exceed what the
// operator provisioned). abrFloorKbps doubles as the GCC min.
const (
	abrFloorKbps   = 500
	abrDefaultCeil = 8000
	abrPollEvery   = time.Second
)

// webrtcBridge is one session's Pion peer connection + VP8 track. It is created
// up front by the WS handler (cheap); the PeerConnection itself is built lazily
// on the browser's first offer. All exported methods are safe to call from the
// two WS pump goroutines: HandleSignal runs on the browser→worker reader,
// WriteVideo on the worker→browser writer.
type webrtcBridge struct {
	cfg             config.DesktopWebRTCConfig
	logger          *zap.Logger
	codec           string // "vp8" | "vp9" | "av1" — must match the worker's encoder
	requestKeyframe func() // relays a PLI to the worker (forces a keyframe)
	// setBitrate relays the GCC bandwidth estimate to the worker's encoder
	// (ClientMessage.SetBitrateKbps). ceilingKbps is the per-session quality-tier
	// target, used as the ABR upper bound + GCC max.
	setBitrate  func(kbps int)
	ceilingKbps int
	abrStarted  atomic.Bool

	// signals carries gateway-originated SDP answers + ICE candidates back to
	// the browser. The WS writer goroutine drains it alongside worker messages
	// so all WS writes stay on one goroutine (coder/websocket allows one writer).
	signals       chan ServerMessage
	frameInterval time.Duration // fallback sample duration before the first frame

	mu    sync.Mutex
	pc    *webrtc.PeerConnection
	track *webrtc.TrackLocalStaticSample

	needKeyframe atomic.Bool // drop delta frames until the next keyframe (post-connect / PLI)
	closed       atomic.Bool
	lastSampleAt time.Time // WriteVideo-only; drives per-sample RTP timestamp delta
}

// isWebRTCVideoMode reports whether a VideoMode value selects the WebRTC video
// track ("vp8", "vp9", or "av1") rather than the legacy WS bitmap path.
func isWebRTCVideoMode(mode string) bool {
	return mode == "vp8" || mode == "vp9" || mode == "av1"
}

func newWebRTCBridge(cfg config.DesktopWebRTCConfig, logger *zap.Logger, codec string, ceilingKbps int, requestKeyframe func(), setBitrate func(kbps int)) *webrtcBridge {
	fps := cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	if codec != "vp9" && codec != "av1" {
		codec = "vp8"
	}
	if ceilingKbps <= 0 {
		ceilingKbps = abrDefaultCeil
	}
	if ceilingKbps < abrFloorKbps {
		ceilingKbps = abrFloorKbps
	}
	return &webrtcBridge{
		cfg:             cfg,
		logger:          logger,
		codec:           codec,
		requestKeyframe: requestKeyframe,
		setBitrate:      setBitrate,
		ceilingKbps:     ceilingKbps,
		signals:         make(chan ServerMessage, 16),
		frameInterval:   time.Second / time.Duration(fps),
	}
}

// Signals is the channel of gateway→browser signaling messages the WS writer
// goroutine must drain and forward.
func (b *webrtcBridge) Signals() <-chan ServerMessage { return b.signals }

// HandleSignal consumes one browser→gateway signaling message (offer / ICE
// candidate). Called from the WS reader goroutine.
func (b *webrtcBridge) HandleSignal(sig *WebRTCSignal) {
	if sig == nil {
		return
	}
	switch sig.Type {
	case "offer":
		b.handleOffer(sig.SDP)
	case "candidate":
		b.addCandidate(sig)
	default:
		b.logger.Debug("webrtc ignoring unknown signal", zap.String("type", sig.Type))
	}
}

func (b *webrtcBridge) handleOffer(sdp string) {
	b.mu.Lock()
	pc, err := b.ensurePCLocked()
	b.mu.Unlock()
	if err != nil {
		b.logger.Warn("webrtc peer connection setup failed", zap.Error(err))
		return
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		b.logger.Warn("webrtc set remote description", zap.Error(err))
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		b.logger.Warn("webrtc create answer", zap.Error(err))
		return
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		b.logger.Warn("webrtc set local description", zap.Error(err))
		return
	}
	b.enqueue(ServerMessage{WebRTC: &WebRTCSignal{Type: "answer", SDP: answer.SDP}})
}

func (b *webrtcBridge) addCandidate(sig *WebRTCSignal) {
	if sig.Candidate == "" { // empty = end-of-candidates sentinel; nothing to add
		return
	}
	b.mu.Lock()
	pc := b.pc
	b.mu.Unlock()
	if pc == nil {
		return
	}
	init := webrtc.ICECandidateInit{Candidate: sig.Candidate, SDPMid: sig.SDPMid, SDPMLineIndex: sig.SDPMLineIndex}
	if err := pc.AddICECandidate(init); err != nil {
		b.logger.Debug("webrtc add ice candidate", zap.Error(err))
	}
}

// ensurePCLocked builds the PeerConnection + VP8 track on first use. Caller
// holds b.mu.
func (b *webrtcBridge) ensurePCLocked() (*webrtc.PeerConnection, error) {
	if b.pc != nil {
		return b.pc, nil
	}
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	// Send-side bandwidth estimation (Google Congestion Control over transport-cc
	// feedback). The estimate drives the worker's encoder bitrate, closing the
	// loop: climb toward the quality ceiling on a fat link, back off fast under
	// loss/queueing so latency stays low and flow stays bounded. Bitrates are in
	// bits/sec at this API; we work in kbps everywhere else.
	// Start conservatively and let GCC ramp up — a safe initial avoids an opening
	// congestion spike on a thin link while a fat link reaches the ceiling within
	// a second or two of probing.
	initKbps := b.ceilingKbps / 2
	if initKbps > 2500 {
		initKbps = 2500
	}
	initialBps := clampKbps(initKbps, b.ceilingKbps) * 1000
	ccFactory, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(
			gcc.SendSideBWEInitialBitrate(initialBps),
			gcc.SendSideBWEMinBitrate(abrFloorKbps*1000),
			gcc.SendSideBWEMaxBitrate(b.ceilingKbps*1000),
		)
	})
	if err != nil {
		return nil, err
	}
	ccFactory.OnNewPeerConnection(func(_ string, est cc.BandwidthEstimator) {
		if b.abrStarted.Swap(true) {
			return
		}
		go b.runABR(est)
	})
	ir.Add(ccFactory)
	if err := webrtc.ConfigureTWCCHeaderExtensionSender(me, ir); err != nil {
		return nil, err
	}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		return nil, err
	}
	se := webrtc.SettingEngine{}
	if b.cfg.PublicIP != "" {
		se.SetNAT1To1IPs([]string{b.cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}
	if b.cfg.UDPPortMin > 0 && b.cfg.UDPPortMax >= b.cfg.UDPPortMin {
		if err := se.SetEphemeralUDPPortRange(uint16(b.cfg.UDPPortMin), uint16(b.cfg.UDPPortMax)); err != nil {
			return nil, err
		}
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se))
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: b.iceServers()})
	if err != nil {
		return nil, err
	}
	mimeType := webrtc.MimeTypeVP8
	switch b.codec {
	case "vp9":
		mimeType = webrtc.MimeTypeVP9
	case "av1":
		mimeType = webrtc.MimeTypeAV1
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: mimeType},
		"video", "wayfort-desktop")
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil { // nil = gathering complete
			return
		}
		ci := cand.ToJSON()
		b.enqueue(ServerMessage{WebRTC: &WebRTCSignal{
			Type:          "candidate",
			Candidate:     ci.Candidate,
			SDPMid:        ci.SDPMid,
			SDPMLineIndex: ci.SDPMLineIndex,
		}})
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		b.logger.Info("webrtc connection state", zap.String("state", s.String()))
		if s == webrtc.PeerConnectionStateConnected {
			// The track just attached; the worker's earlier keyframe is long
			// gone. Ask for a fresh one and drop deltas until it lands so the
			// browser decoder starts cleanly.
			b.needKeyframe.Store(true)
			b.requestKeyframe()
		}
	})
	go b.readRTCP(sender)
	b.pc = pc
	b.track = track
	return pc, nil
}

func (b *webrtcBridge) iceServers() []webrtc.ICEServer {
	var servers []webrtc.ICEServer
	if len(b.cfg.STUNURLs) > 0 {
		servers = append(servers, webrtc.ICEServer{URLs: b.cfg.STUNURLs})
	}
	if b.cfg.TURNURL != "" {
		servers = append(servers, webrtc.ICEServer{
			URLs:       []string{b.cfg.TURNURL},
			Username:   b.cfg.TURNUsername,
			Credential: b.cfg.TURNPassword,
		})
	}
	return servers
}

// readRTCP drains the sender's RTCP stream. A PLI / FIR from the browser (it
// lost the video or its decoder errored) becomes a keyframe request to the
// worker. Reading also drives the interceptor chain, so it must run for the
// life of the sender. Exits when the peer connection closes.
func (b *webrtcBridge) readRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		pkts, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}
		for _, p := range pkts {
			switch p.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				b.needKeyframe.Store(true)
				b.requestKeyframe()
			}
		}
	}
}

// runABR polls the GCC bandwidth estimate once a second and relays it to the
// worker's encoder as a target bitrate, clamped to [abrFloorKbps, ceilingKbps].
// Only meaningful moves (≥8% relative) are sent so the worker isn't spammed; the
// first estimate is pushed immediately so the encoder leaves its ceiling start
// before a thin link can queue up. Exits when the bridge closes.
func (b *webrtcBridge) runABR(est cc.BandwidthEstimator) {
	if b.setBitrate == nil || est == nil {
		return
	}
	ticker := time.NewTicker(abrPollEvery)
	defer ticker.Stop()
	last := 0
	for {
		if b.closed.Load() {
			return
		}
		kbps := clampKbps(est.GetTargetBitrate()/1000, b.ceilingKbps)
		if last == 0 || abs(kbps-last)*100 >= last*8 {
			b.setBitrate(kbps)
			b.logger.Debug("webrtc abr target",
				zap.Int("kbps", kbps), zap.Int("ceiling", b.ceilingKbps))
			last = kbps
		}
		<-ticker.C
	}
}

func clampKbps(v, ceil int) int {
	if ceil <= 0 {
		ceil = abrDefaultCeil
	}
	if v < abrFloorKbps {
		return abrFloorKbps
	}
	if v > ceil {
		return ceil
	}
	return v
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// WriteVideo feeds one VP8 access unit to the track. Called from the WS writer
// goroutine. Drops frames until the track is negotiated and (after connect /
// PLI) until the next keyframe arrives.
func (b *webrtcBridge) WriteVideo(v *VideoData) {
	if v == nil {
		return
	}
	b.mu.Lock()
	track := b.track
	b.mu.Unlock()
	if track == nil {
		return // not negotiated yet
	}
	if b.needKeyframe.Load() {
		if !v.Keyframe {
			return
		}
		b.needKeyframe.Store(false)
	}
	// Data is raw encoded bytes: the worker emits video as a BinaryFrameVideo
	// stdout frame (and any JSON fallback hop already yields []byte) — the old
	// per-frame base64 decode is gone.
	data := v.Data
	if len(data) == 0 {
		return
	}
	// RTP timestamps advance by the real elapsed time between samples — the
	// desktop is variable-rate (frames only when it changes), so a fixed
	// duration would make playback drift.
	dur := b.frameInterval
	if !b.lastSampleAt.IsZero() {
		dur = time.Since(b.lastSampleAt)
		if dur < time.Millisecond {
			dur = time.Millisecond
		}
		if dur > time.Second {
			dur = time.Second
		}
	}
	b.lastSampleAt = time.Now()
	if err := track.WriteSample(media.Sample{Data: data, Duration: dur}); err != nil {
		b.logger.Debug("webrtc write sample", zap.Error(err))
	}
}

// Close tears down the peer connection. Idempotent; safe after partial setup.
func (b *webrtcBridge) Close() {
	b.closed.Store(true)
	b.mu.Lock()
	pc := b.pc
	b.pc = nil
	b.track = nil
	b.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
}

func (b *webrtcBridge) enqueue(msg ServerMessage) {
	if b.closed.Load() {
		return
	}
	select {
	case b.signals <- msg:
	default:
		b.logger.Warn("webrtc signal queue full; dropping signal")
	}
}
