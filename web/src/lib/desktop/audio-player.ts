import type { AudioData } from "./types"

// DesktopAudioPlayer plays the remote desktop's redirected audio (rdpsnd PCM
// chunks forwarded from the worker). It schedules each chunk back-to-back on a
// Web Audio timeline for gapless playback, with a small jitter buffer, and
// drops backlog if the network falls behind so latency stays bounded.
//
// AudioContext can only start after a user gesture; the desktop session is
// always opened by a click, so resume() succeeds. Until then chunks are simply
// dropped (no audio), which is correct behaviour.
export class DesktopAudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private nextTime = 0
  private muted = false

  // jitterSec is how far ahead of "now" we start a fresh stream — absorbs
  // network jitter without adding much latency. maxAheadSec caps queued audio;
  // beyond it we reset to avoid unbounded latency drift.
  private static readonly jitterSec = 0.06
  private static readonly maxAheadSec = 0.5

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        this.ctx = new Ctor()
        this.gain = this.ctx.createGain()
        this.gain.gain.value = this.muted ? 0 : 1
        this.gain.connect(this.ctx.destination)
      } catch {
        return null
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {})
    return this.ctx
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.gain) this.gain.gain.value = muted ? 0 : 1
  }

  push(data: AudioData): void {
    if (this.muted) return
    const channels = data.channels || 2
    const bits = data.bits || 16
    const sampleRate = data.sample_rate || 44100
    if (bits !== 16 || channels < 1) return // worker only ever sends 16-bit PCM

    const bytes = base64ToBytes(data.pcm)
    const bytesPerFrame = 2 * channels
    const frameCount = Math.floor(bytes.length / bytesPerFrame)
    if (frameCount <= 0) return

    const ctx = this.ensure()
    if (!ctx || !this.gain) return
    // Only schedule when the context is actually running. While it's suspended
    // (autoplay not yet unlocked, tab backgrounded, or closing) currentTime
    // doesn't advance, so scheduled BufferSources would never play and would
    // pile up unbounded — a slow audio OOM. Dropping these chunks is correct:
    // there's nothing to hear yet. ensure() already kicked off resume().
    if (ctx.state !== "running") return

    let buffer: AudioBuffer
    try {
      buffer = ctx.createBuffer(channels, frameCount, sampleRate)
    } catch {
      return
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let ch = 0; ch < channels; ch++) {
      const out = buffer.getChannelData(ch)
      let off = ch * 2
      for (let i = 0; i < frameCount; i++) {
        out[i] = view.getInt16(off, true) / 32768
        off += bytesPerFrame
      }
    }

    const now = ctx.currentTime
    if (this.nextTime < now + DesktopAudioPlayer.jitterSec) {
      this.nextTime = now + DesktopAudioPlayer.jitterSec
    } else if (this.nextTime > now + DesktopAudioPlayer.maxAheadSec) {
      // Fell behind / backlog built up — snap back to a small lead.
      this.nextTime = now + DesktopAudioPlayer.jitterSec
    }

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.gain)
    // Release the node from the graph as soon as it finishes so its buffer can
    // be collected promptly instead of lingering until the next GC sweep.
    src.onended = () => {
      try {
        src.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    try {
      src.start(this.nextTime)
    } catch {
      return
    }
    this.nextTime += buffer.duration
  }

  close(): void {
    this.nextTime = 0
    const ctx = this.ctx
    this.ctx = null
    this.gain = null
    if (ctx) void ctx.close().catch(() => {})
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const len = bin.length
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i)
  return out
}
