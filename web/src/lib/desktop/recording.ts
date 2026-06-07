// Parser for the freerdp ".dtr" session tape written by internal/desktop/
// recorder.go. The tape is a single timestamped timeline of three record kinds:
//   OUTPUT — a desktop.v2 binary ServerMessage (frame/cursor) for visual replay
//   INPUT  — a JSON ClientMessage (key/mouse/clipboard) for the audit timeline
//   EVENT  — a JSON milestone (connect/resize/error/…) for seek markers
//
// OUTPUT records are decoded with the exact same 32-byte binary header layout as
// the live path (frame-client.ts / internal/desktop/binary_frame.go), then fed
// through the existing canvas-renderer + decode.worker pipeline — so playback
// reuses every codec path (raw/JPEG/PNG/zlib/H264) the live viewer supports.

import type { FrameBytes, FrameRectMeta } from "./canvas-renderer"
import type { Encoding } from "./types"

const DTR_HEADER_SIZE = 18
const REC_HEADER_SIZE = 9
const BIN_HEADER_SIZE = 32

// desktop.v2 binary kinds (mirror internal/desktop/binary_frame.go).
const BIN_KIND_RECT = 2
const BIN_KIND_CURSOR = 3
const BIN_KIND_BATCH = 4
const BIN_FLAG_KEYFRAME = 0x01

// .dtr record kinds (mirror recorder.go RecordKind).
const REC_OUTPUT = 1
const REC_INPUT = 2
const REC_EVENT = 3

export interface DtrOutput {
  tMs: number
  off: number // byte offset of the desktop.v2 payload within the tape buffer
  len: number
  // resync = the decoded frame fully (or near-fully) repaints the canvas, or is
  // an H.264 keyframe. Seeks replay from the nearest prior resync so scrubbing
  // is cheap and H.264 always starts from an IDR.
  resync: boolean
}

export interface DtrTimelineEntry {
  tMs: number
  kind: "input" | "event"
  // INPUT → a ClientMessage ({key|mouse|clipboard|…}); EVENT → a RecordingEvent
  // ({type, message?, code?, width?, height?}). Left as unknown-shaped JSON so
  // the player can render whatever it recognises.
  data: Record<string, unknown>
}

export interface DtrTape {
  buf: ArrayBuffer
  version: number
  hasInput: boolean
  width: number
  height: number
  startMs: number
  durationMs: number
  outputs: DtrOutput[]
  timeline: DtrTimelineEntry[]
}

export function parseDtr(buf: ArrayBuffer): DtrTape {
  const view = new DataView(buf)
  const dec = new TextDecoder()
  if (buf.byteLength < DTR_HEADER_SIZE || dec.decode(new Uint8Array(buf, 0, 4)) !== "DTR1") {
    throw new Error("不是有效的 .dtr 录像文件")
  }
  const version = view.getUint8(4)
  const flags = view.getUint8(5)
  const width = view.getUint16(6, false)
  const height = view.getUint16(8, false)
  const startMs = Number(view.getBigUint64(10, false))

  const outputs: DtrOutput[] = []
  const timeline: DtrTimelineEntry[] = []
  let durationMs = 0
  let off = DTR_HEADER_SIZE
  while (off + REC_HEADER_SIZE <= buf.byteLength) {
    const kind = view.getUint8(off)
    const tMs = view.getUint32(off + 1, false)
    const len = view.getUint32(off + 5, false)
    off += REC_HEADER_SIZE
    if (off + len > buf.byteLength) break
    if (tMs > durationMs) durationMs = tMs
    if (kind === REC_OUTPUT) {
      outputs.push({ tMs, off, len, resync: computeResync(view, off, len, width, height) })
    } else if (kind === REC_INPUT || kind === REC_EVENT) {
      try {
        const data = JSON.parse(dec.decode(new Uint8Array(buf, off, len))) as Record<string, unknown>
        timeline.push({ tMs, kind: kind === REC_INPUT ? "input" : "event", data })
      } catch {
        /* skip malformed record */
      }
    }
    off += len
  }
  return {
    buf,
    version,
    hasInput: (flags & 0x01) !== 0,
    width,
    height,
    startMs,
    durationMs,
    outputs,
    timeline,
  }
}

// decodeOutput parses one OUTPUT record's desktop.v2 payload into paint-ready
// FrameBytes, copying each payload into its own ArrayBuffer so the renderer can
// transfer it to the decode worker without detaching the shared tape buffer.
export function decodeOutput(buf: ArrayBuffer, rec: DtrOutput): FrameBytes[] {
  if (rec.len < BIN_HEADER_SIZE) return []
  const view = new DataView(buf, rec.off, rec.len)
  const kind = view.getUint8(0)
  if (kind === BIN_KIND_RECT) {
    const meta = readFrameHeader(view, 0)
    if (!meta) return []
    const payloadN = view.getUint32(24, false)
    if (BIN_HEADER_SIZE + payloadN > rec.len) return []
    const payload = new Uint8Array(buf.slice(rec.off + BIN_HEADER_SIZE, rec.off + BIN_HEADER_SIZE + payloadN))
    return [{ frame: meta, payload }]
  }
  if (kind === BIN_KIND_BATCH) {
    return decodeBatch(buf, rec.off, rec.len)
  }
  // Cursor (kind 3) and JSON envelopes carry no paintable rectangle.
  return []
}

function decodeBatch(buf: ArrayBuffer, base: number, total: number): FrameBytes[] {
  const view = new DataView(buf, base, total)
  if (total < 4) return []
  const count = view.getUint32(0, false)
  const frames: FrameBytes[] = []
  let off = 4
  for (let i = 0; i < count; i++) {
    if (off + BIN_HEADER_SIZE > total) break
    const meta = readFrameHeader(view, off)
    if (!meta) break
    const payloadN = view.getUint32(off + 24, false)
    const start = off + BIN_HEADER_SIZE
    const end = start + payloadN
    if (end > total) break
    frames.push({ frame: meta, payload: new Uint8Array(buf.slice(base + start, base + end)) })
    off = end
  }
  return frames
}

// readFrameHeader reads a 32-byte desktop.v2 frame header at `hOff` within
// `view` and returns its FrameRectMeta (null on an unknown encoding / cursor).
function readFrameHeader(view: DataView, hOff: number): FrameRectMeta | null {
  const encoding = decodeFrameEncoding(view.getUint8(hOff + 1))
  if (!encoding) return null
  const flags = view.getUint8(hOff + 2)
  return {
    x: view.getUint32(hOff + 8, false),
    y: view.getUint32(hOff + 12, false),
    width: view.getUint32(hOff + 16, false),
    height: view.getUint32(hOff + 20, false),
    encoding,
    keyframe: (flags & BIN_FLAG_KEYFRAME) !== 0,
  }
}

function decodeFrameEncoding(value: number): Encoding | null {
  switch (value) {
    case 1: return "raw_bgra"
    case 2: return "jpeg"
    case 3: return "png"
    case 4: return "zlib_bgra"
    case 5: return "h264"
    case 6: return "rfx"
    default: return null
  }
}

// computeResync peeks the OUTPUT record's first sub-frame header (without
// decoding pixels) to decide whether it can serve as a seek entry point.
function computeResync(view: DataView, off: number, len: number, width: number, height: number): boolean {
  if (len < BIN_HEADER_SIZE) return false
  const kind = view.getUint8(off)
  let hOff: number
  if (kind === BIN_KIND_RECT) {
    hOff = off
  } else if (kind === BIN_KIND_BATCH) {
    if (len < 4 + BIN_HEADER_SIZE) return false
    hOff = off + 4
  } else {
    return false // cursor / json — never a paint
  }
  const keyframe = (view.getUint8(hOff + 2) & BIN_FLAG_KEYFRAME) !== 0
  if (keyframe) return true
  const x = view.getUint32(hOff + 8, false)
  const y = view.getUint32(hOff + 12, false)
  const w = view.getUint32(hOff + 16, false)
  const h = view.getUint32(hOff + 20, false)
  return x === 0 && y === 0 && w * 100 >= width * 95 && h * 100 >= height * 95
}
