// RecordingPlugin — Plan 15.D.4. Captures the live Pixi canvas to a WebM
// file via MediaRecorder + canvas.captureStream(). For files that grow past
// memory-safe bounds, chunks are flushed to IndexedDB (idb-keyval) as they
// arrive; on stop the chunks are stitched into a single Blob and downloaded.
//
// Audio: optional. We don't tap Guacamole's audio stream here because the
// browser's MediaStream design makes it awkward — the audio track would
// need to live alongside the captureStream() video track, which is not
// well-supported across all browsers. Audio is left as a future enhancement
// (Plan 16 / 17), with the data-only WebM still useful for "look what I did
// on the remote" reviews.

import { del, get, keys, set } from "idb-keyval"
import type { RDPPlugin, RDPPluginContext } from "../types"

const STORAGE_PREFIX = "rdp-recording-chunk:"
const MAX_BYTES = 500 * 1024 * 1024 // 500MB safety cap.

export type RecordingState = "idle" | "recording" | "stopping"

export interface RecordingEvent {
  state: RecordingState
  durationMs: number
  approxBytes: number
}

export class RecordingPlugin implements RDPPlugin {
  readonly name = "recording"
  private ctx: RDPPluginContext | null = null
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunkKeys: string[] = []
  private chunkBytes = 0
  private startedAt = 0
  private nodeName: string
  private subscribers: Array<(e: RecordingEvent) => void> = []
  private tickerInterval: number | null = null

  constructor(nodeName: string) {
    this.nodeName = nodeName || "remote"
  }

  init(ctx: RDPPluginContext): void {
    this.ctx = ctx
  }

  async destroy(): Promise<void> {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop()
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.recorder = null
    this.stream = null
    if (this.tickerInterval != null) window.clearInterval(this.tickerInterval)
    this.tickerInterval = null
    // Best effort: drop any leftover chunks from a previous unfinished run.
    await this.cleanupChunks()
    this.ctx = null
  }

  subscribe(cb: (e: RecordingEvent) => void): () => void {
    this.subscribers.push(cb)
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== cb)
    }
  }

  async start(): Promise<void> {
    if (!this.ctx) throw new Error("recording plugin not initialised")
    if (this.recorder) throw new Error("recording already active")
    const canvas = this.ctx.getRenderCanvas()
    if (!canvas.captureStream) {
      throw new Error("浏览器不支持 canvas.captureStream")
    }
    this.stream = canvas.captureStream(30)
    const mimeType = this.pickMimeType()
    this.recorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: 4_000_000,
    })
    this.chunkKeys = []
    this.chunkBytes = 0
    this.startedAt = Date.now()
    this.recorder.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size === 0) return
      const key = `${STORAGE_PREFIX}${this.startedAt}-${this.chunkKeys.length}`
      try {
        await set(key, ev.data)
        this.chunkKeys.push(key)
        this.chunkBytes += ev.data.size
      } catch (e) {
        console.warn("[rdp.recording] chunk persist failed", e)
      }
      if (this.chunkBytes >= MAX_BYTES) {
        // Auto-stop to avoid blowing past IndexedDB quota.
        console.warn("[rdp.recording] reached MAX_BYTES, auto-stopping")
        await this.stop()
      }
    }
    // 2s chunks: small enough to bound memory, large enough to keep IDB
    // writes infrequent.
    this.recorder.start(2000)
    this.tickerInterval = window.setInterval(() => this.emit(), 1000)
    this.emit()
  }

  async stop(): Promise<Blob> {
    if (!this.recorder) throw new Error("not recording")
    return new Promise<Blob>((resolve, reject) => {
      const rec = this.recorder!
      rec.onstop = async () => {
        try {
          this.stream?.getTracks().forEach((t) => t.stop())
          const blob = await this.assemble()
          this.downloadBlob(blob)
          await this.cleanupChunks()
          this.recorder = null
          this.stream = null
          if (this.tickerInterval != null) {
            window.clearInterval(this.tickerInterval)
            this.tickerInterval = null
          }
          this.emit()
          resolve(blob)
        } catch (e) {
          reject(e)
        }
      }
      rec.stop()
      this.emitState("stopping")
    })
  }

  isActive(): boolean {
    return this.recorder !== null && this.recorder.state !== "inactive"
  }

  // ----- internals -----

  private async assemble(): Promise<Blob> {
    const parts: Blob[] = []
    for (const key of this.chunkKeys) {
      const blob = (await get(key)) as Blob | undefined
      if (blob) parts.push(blob)
    }
    return new Blob(parts, { type: this.pickMimeType() })
  }

  private downloadBlob(blob: Blob): void {
    const ts = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-")
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${this.nodeName}-${ts}.webm`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  private async cleanupChunks(): Promise<void> {
    // Drop any leftover keys from this prefix that we recorded.
    for (const k of this.chunkKeys) {
      try {
        await del(k)
      } catch {
        /* */
      }
    }
    this.chunkKeys = []
    this.chunkBytes = 0
    // Also clean strays from previous sessions (older startedAt prefixes).
    try {
      const all = await keys()
      for (const k of all) {
        if (typeof k === "string" && k.startsWith(STORAGE_PREFIX)) {
          await del(k)
        }
      }
    } catch {
      /* */
    }
  }

  private pickMimeType(): string {
    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ]
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c
    }
    return "video/webm"
  }

  private emit(): void {
    const state: RecordingState = this.recorder
      ? this.recorder.state === "inactive"
        ? "idle"
        : "recording"
      : "idle"
    this.emitState(state)
  }

  private emitState(state: RecordingState): void {
    const e: RecordingEvent = {
      state,
      durationMs: this.startedAt > 0 && state !== "idle" ? Date.now() - this.startedAt : 0,
      approxBytes: this.chunkBytes,
    }
    for (const cb of this.subscribers) cb(e)
  }
}
