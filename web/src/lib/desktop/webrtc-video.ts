// webrtc-video.ts — browser side of the desktop WebRTC video path.
//
// When the gateway starts a session in VP8 video mode it streams the desktop as
// a single VP8 video track over WebRTC instead of WS bitmap frames. This client
// owns the RTCPeerConnection: it offers (recvonly video), trickles ICE, attaches
// the inbound track to a <video> element for GPU decode, and reports success /
// failure so the component can show the video or fall back to the canvas path.
//
// Signaling rides the existing desktop WS (FrameClient): `send` puts a
// WebRTCSignal on the socket; `handleSignal` consumes the gateway's answer /
// candidates. The browser offers and the gateway answers (see internal/desktop/
// webrtc.go) so the gateway controls the track/codec from its VP8 encoder.

import type { WebRTCSignal } from "./types"

export interface WebRTCVideoOpts {
  /** The <video> element the decoded stream is attached to. */
  video: HTMLVideoElement
  /** ICE configuration from StartSessionResponse.ice_servers (STUN / TURN). */
  iceServers: RTCIceServer[]
  /** Puts a signaling message on the desktop WS (browser → gateway). */
  send: (sig: WebRTCSignal) => void
  /** Fires once video is actually playing — the component shows the <video>. */
  onConnected: () => void
  /** Fires on negotiation / ICE failure or timeout — the component falls back. */
  onFailed: () => void
  /** How long to wait for playback before declaring failure. Default 8s. */
  connectTimeoutMs?: number
}

export class WebRTCVideoClient {
  private pc: RTCPeerConnection | null = null
  private closed = false
  private remoteSet = false
  private connected = false
  private failedOnce = false
  private pendingCandidates: RTCIceCandidateInit[] = []
  private timer: number | null = null
  private onPlaying: (() => void) | null = null

  constructor(private opts: WebRTCVideoOpts) {}

  /** Build the peer connection, create the offer, and start signaling. */
  async start(): Promise<void> {
    if (this.closed || this.pc) return
    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({ iceServers: this.opts.iceServers })
    } catch {
      this.fail()
      return
    }
    this.pc = pc

    // We only receive video. Prefer AV1 then VP9 in the offer so the gateway can
    // negotiate the most bandwidth-efficient screen-content codec it's willing to
    // produce for this session (AV1 ≫ VP9 ≫ VP8 on desktop text/UI at equal
    // bitrate). Best-effort: the gateway answers with its single chosen track
    // regardless of order, but stating the preference keeps the SDP intent
    // explicit and ensures AV1/VP9 are actually offered so the gateway may pick
    // them. The gateway only switches a session to AV1 when the node opted in.
    const tx = pc.addTransceiver("video", { direction: "recvonly" })
    try {
      const caps = RTCRtpReceiver.getCapabilities?.("video")
      if (caps?.codecs && typeof tx.setCodecPreferences === "function") {
        const av1 = caps.codecs.filter((c) => /av01|av1/i.test(c.mimeType))
        const vp9 = caps.codecs.filter((c) => /vp9/i.test(c.mimeType))
        const rest = caps.codecs.filter((c) => !/av01|av1|vp9/i.test(c.mimeType))
        if (av1.length > 0 || vp9.length > 0) {
          tx.setCodecPreferences([...av1, ...vp9, ...rest])
        }
      }
    } catch {
      /* setCodecPreferences unsupported — the gateway's answer still pins its codec */
    }

    pc.ontrack = (e) => {
      // Low-latency playout: shrink the receiver's jitter buffer toward zero so
      // frames paint as soon as they arrive rather than after a smoothing delay.
      // Remote desktop favours latency over jitter-smoothing (the encoder never
      // drops frames and the picture is mostly static). Both knobs are
      // Chromium-only and best-effort; jitterBufferTarget is ms, the legacy
      // playoutDelayHint is seconds.
      try {
        const r = e.receiver as RTCRtpReceiver & {
          jitterBufferTarget?: number | null
          playoutDelayHint?: number | null
        }
        // Assigning an unsupported property just creates a harmless own prop;
        // where supported it shrinks the buffer. jitterBufferTarget is ms (newer
        // Chromium), playoutDelayHint is seconds (legacy) — set both to minimum.
        if (r) {
          r.jitterBufferTarget = 0
          r.playoutDelayHint = 0
        }
      } catch {
        /* unsupported — default buffering applies */
      }
      const stream = e.streams[0] ?? new MediaStream([e.track])
      const video = this.opts.video
      if (video.srcObject !== stream) video.srcObject = stream
      // Autoplay needs muted (there's no audio on this track anyway — audio
      // rides the WS Web Audio path).
      video.muted = true
      void video.play().catch(() => {
        /* autoplay can reject before user gesture; 'playing' may still fire */
      })
    }

    pc.onicecandidate = (e) => {
      if (this.closed || !e.candidate) return
      this.opts.send({
        type: "candidate",
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      })
    }

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState
      if (st === "failed" || st === "disconnected" || st === "closed") {
        this.fail()
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.fail()
    }

    // Success is "video is actually painting", not just "ICE connected" — a
    // connected PC with a stalled decoder is still a failure from the user's POV.
    this.onPlaying = () => this.markConnected()
    this.opts.video.addEventListener("playing", this.onPlaying)

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.opts.send({ type: "offer", sdp: offer.sdp })
    } catch {
      this.fail()
      return
    }

    const timeout = this.opts.connectTimeoutMs ?? 8000
    this.timer = window.setTimeout(() => {
      if (!this.connected) this.fail()
    }, timeout)
  }

  /** Consume a gateway → browser signaling message (answer / ICE candidate). */
  async handleSignal(sig: WebRTCSignal): Promise<void> {
    const pc = this.pc
    if (!pc || this.closed) return
    try {
      if (sig.type === "answer" && sig.sdp) {
        await pc.setRemoteDescription({ type: "answer", sdp: sig.sdp })
        this.remoteSet = true
        const pending = this.pendingCandidates
        this.pendingCandidates = []
        for (const c of pending) {
          await pc.addIceCandidate(c).catch(() => {})
        }
      } else if (sig.type === "candidate" && sig.candidate) {
        const init: RTCIceCandidateInit = {
          candidate: sig.candidate,
          sdpMid: sig.sdpMid ?? undefined,
          sdpMLineIndex: sig.sdpMLineIndex ?? undefined,
        }
        // Buffer candidates that arrive before the answer is applied — adding
        // one before setRemoteDescription throws.
        if (this.remoteSet) await pc.addIceCandidate(init).catch(() => {})
        else this.pendingCandidates.push(init)
      }
    } catch {
      this.fail()
    }
  }

  /** Tear down the peer connection. Idempotent. */
  close(): void {
    this.closed = true
    this.clearTimer()
    if (this.onPlaying) {
      this.opts.video.removeEventListener("playing", this.onPlaying)
      this.onPlaying = null
    }
    const pc = this.pc
    this.pc = null
    if (pc) {
      pc.ontrack = null
      pc.onicecandidate = null
      pc.oniceconnectionstatechange = null
      pc.onconnectionstatechange = null
      try {
        pc.close()
      } catch {
        /* */
      }
    }
    // Detach the stream so the <video> doesn't hold a dead track.
    if (this.opts.video.srcObject) this.opts.video.srcObject = null
  }

  private markConnected(): void {
    if (this.connected || this.closed) return
    this.connected = true
    this.clearTimer()
    this.opts.onConnected()
  }

  private fail(): void {
    if (this.failedOnce || this.closed) return
    this.failedOnce = true
    this.clearTimer()
    this.opts.onFailed()
  }

  private clearTimer(): void {
    if (this.timer != null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }
}
