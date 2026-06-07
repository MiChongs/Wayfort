# RDP Investigation — Frontend transport + decode worker + capabilities

Layer scope: `web/src/lib/desktop/{frame-client,decode.worker,render.worker,capabilities,types,use-perf-metrics}.ts`
plus the renderer glue in `web/src/lib/desktop/canvas-renderer.ts` and consumer
`web/src/components/desktop/desktop-display.tsx`.

## How the layer works

1. **Transport (`frame-client.ts`).** Opens `WS /api/v1/ws/v2/desktop/:session_id?token=…`
   requesting subprotocols `["desktop.v2","desktop.v1"]`, `binaryType="arraybuffer"`.
   On open it async-probes codecs (`collectClientCapabilities`) and sends a JSON
   `{caps}` message, starts a 20 s app heartbeat and a 1 Hz byte-counter timer.
2. **Wire decode (`handleBinaryV2`).** When `ws.protocol === "desktop.v2"` and the
   message is an `ArrayBuffer`, it parses the 32-byte binary header:
   `[0]=Kind [1]=Encoding [2]=Flags(bit0=keyframe) [8:12]=X [12:16]=Y [16:20]=W
   [20:24]=H [24:28]=PayloadN`, all BigEndian — **byte-identical** to
   `internal/desktop/binary_frame.go`. Kinds: 1 JSON, 2 Rect, 3 Cursor, 4 Batch.
   Encodings: 1 rawBGRA, 2 JPEG, 3 PNG, 4 zlibBGRA, 5 H264, 6 RFX. Verified all
   constants and offsets match Go (`frame-client.ts:28-44, 192-247, 301-353`
   vs `binary_frame.go:10-50, 63-93, 215-296`).
3. **Render queue (`canvas-renderer.ts`).** `paintFrameBatchBytes` pushes frames into
   `pendingFrames`, drops queued frames when a near-full-canvas update arrives or when
   the queue exceeds 128, and flushes once per `requestAnimationFrame`. Flush sends the
   batch to `decode.worker.ts` (transferring payload `ArrayBuffer`s), then draws results
   on a main-thread `<canvas>` 2D context (`alpha:false`).
4. **Decode worker (`decode.worker.ts`).** Per-frame: raw/zlib BGRA→RGBA byte swap to
   `ImageData`; JPEG/PNG via `ImageDecoder`→`createImageBitmap`→Blob→`createImageBitmap`
   →jpeg-js/fast-png fallback chain; H264 via a single stateful `VideoDecoder`
   (`avc1.42E01E`, Annex-B in-band SPS/PPS, no `description`), keyframe→`"key"` chunk,
   timestamp-keyed pending map, error→close+`refresh-needed`; RFX→throws.
5. **Capabilities (`capabilities.ts`).** `probeH264Avc420` calls
   `VideoDecoder.isConfigSupported({codec:"avc1.42E01E"})`. `collectClientCapabilities`
   returns `{h264, imageDecoder, rfx:false}` sent both at WS open and at session start.

Data consumed: desktop.v2 binary frames (and JSON fallback). Data produced: decoded
`ImageBitmap`/`ImageData` painted to canvas; outgoing JSON `ClientMessage`
(key/mouse/hb/resize/caps/refresh/clipboard).

Current state: **partial**. Single-frame raw/JPEG/PNG/H264 paths are correct and the
wire contract matches Go. Several real defects degrade or break rendering in common
multi-frame / codec-mix / RFX cases (below).

## Findings

### F1 (high) — `Promise.all` makes one bad frame discard the whole coalesced batch
`decode.worker.ts:44` decodes a batch with `await Promise.all(msg.frames.map(decodeFrame))`.
Any single rejecting frame rejects the entire promise; the worker then posts
`{type:"error", id}` (`:52`) and `canvas-renderer` rejects the whole decode request
(`canvas-renderer.ts:293-301, 442-446`) → the rAF paint `.catch` fires `emitError`
(`:281-283`) and **none** of the batch's frames paint. The gateway coalesces up to 32
*mixed-encoding* consecutive frames into one `FrameBatch`
(`internal/desktop/ws_handler.go:176-199`), so a single throwing frame (RFX `:84`,
H264 delta-before-keyframe `:199-201`, or a too-small BGRA payload `:288/:296`) takes
out up to 31 good frames with it, including a keyframe coalesced alongside a bad delta.
Result: dropped/garbled regions, and for H264 a lost keyframe stalls the stream.
**Fix:** decode with `Promise.allSettled` (or per-frame try/catch returning a skip
marker); post the successfully-decoded frames and report failures out-of-band (warn),
never reject the whole batch.

### F2 (medium) — H264 keyframe/delta ordering race inside a coalesced batch
`decodeFrame` is mapped synchronously over all batch frames, so all H264 `decodeFrame`
calls start before any awaits resolve. The "delta before keyframe" guard
(`decode.worker.ts:199`) reads the module-global `hasSeenH264Keyframe`, and the keyframe
only sets it at `:202` *after* its own `await ensureVideoDecoder()`. If a keyframe and a
following delta are coalesced into the same batch, the delta's guard can run before the
keyframe sets the flag, so the delta is wrongly rejected (feeding into F1 and killing
the batch) — or, if the guard passes, both `decode()` calls race through the async
`ensureVideoDecoder()` and may build two decoders. **Fix:** decode H264 frames within a
batch strictly sequentially (await each before starting the next), and set
`hasSeenH264Keyframe` synchronously before issuing any `decode()`.

### F3 (medium) — RFX is negotiable on the wire but undecodable on the client; caps ignored
The client always advertises `rfx:false` (`capabilities.ts:78`,
`collectClientCapabilities`), but the worker negotiates RFX based only on the node option
`EnableRemoteFx` (`cmd/freerdp-worker/rdp/client.go:525-531`), not on client caps. When an
operator enables it, the worker emits `Encoding=rfx` frames (`channels.go:365-373`) that
the decode worker cannot decode and `throw`s on (`decode.worker.ts:79-85`), which via F1
poisons the whole batch → blank/frozen screen with only a one-time worker warning.
**Fix (FE-relevant part):** keep RFX un-negotiated unless a decoder exists; at minimum
the worker should honor `client_caps.rfx=false`. Until an RFX decoder lands, treat an
RFX frame as a skip (not a throw) so it can't break a batch (ties to F1).

### F4 (medium) — H264 VideoFrame drawn into the rect without cropping; coded size ≠ rect size
For H264, `deliverH264Frame` does `createImageBitmap(videoFrame)` (`decode.worker.ts:178`)
with no crop, producing a bitmap at the VideoFrame's `codedWidth×codedHeight` (often
padded to 16-px macroblock multiples, and equal to the AVC420 surface size, not the
RDPGFX destination sub-rect). The renderer then `drawImage(bitmap, x, y, frame.width,
frame.height)` (`canvas-renderer.ts:256`), scaling/squashing the full coded picture into
the destination rect. When `codedWidth/Height` differs from `frame.width/height` (padding
or regional surface command), the H264 region is mis-scaled / shows macroblock padding.
**Fix:** crop the VideoFrame to the rect — `createImageBitmap(videoFrame, 0, 0,
frame.width, frame.height)` (or pass `visibleRect`/`{resizeWidth,resizeHeight}`), or draw
1:1 (`drawImage(bitmap, sx, sy, frame.width, frame.height, dx, dy, frame.width,
frame.height)`).

### F5 (low/medium) — renderer decode errors are swallowed (console only)
`desktop-display.tsx:247-249` wires `renderer.onError` to a bare `console.warn`. Combined
with F1, a whole batch failing to decode produces no UI signal, no reconnect, no refresh
request — the user sees a frozen region with no feedback. **Fix:** for decode-path errors,
at least request a refresh and/or surface a transient toast; distinguish recoverable
decode errors from fatal transport errors.

### F6 (low) — `bytesIn`/`bytesOut` accounting is wrong for non-ASCII and binary
`send()` adds `payload.length` (JS string length, UTF-16 code units) not encoded byte
length (`frame-client.ts:150`); for string inbound frames it adds `text.length`
(`:178`). Multi-byte clipboard/text under-/over-counts. Cosmetic only (perf panel
counters), no effect on display. **Fix:** count `new TextEncoder().encode(payload).length`
for sends, and `data.byteLength` for the original frame on receive.

### F7 (info) — `render.worker.ts` is dead code
No module instantiates `render.worker.ts`; the only `new Worker` is for
`decode.worker.ts` (`canvas-renderer.ts:425`; grep confirms). The OffscreenCanvas worker
path described in the file header is not used. Its BGRA→RGBA (`render.worker.ts:132-139`)
and PNG/JPEG logic duplicate decode.worker.ts. Harmless but a maintenance trap (two copies
of byte-order logic can drift). **Fix:** delete `render.worker.ts` or document it as
unused.

### F8 (info) — `isSafeFrame` in canvas-renderer is dead code
`isSafeFrame` (`canvas-renderer.ts:399-407`) is defined but never called (grep: single
hit). The main thread does not bound-check incoming frame rects before queueing/decoding;
only the worker's `validateFrame` (`decode.worker.ts:279-283`) does — and a failed check
there throws into `Promise.all` (F1). `MAX_CANVAS_PIXELS` bounding via `isSafeCanvasSize`
*is* applied on resize, so canvas growth is capped; per-frame rect sanity is not.
**Fix:** either call `isSafeFrame` to skip junk rects before enqueue, or remove it; ensure
oversized/garbage rects are dropped, not thrown.

## Verified correct (no defect)
- 32-byte header field offsets, kinds, encodings, BigEndian, batch `count + N*(header+
  payload)` framing: byte-identical Go↔TS (`binary_frame.go` ↔ `frame-client.ts`).
- raw/zlib BGRA→RGBA byte swap (B↔R, alpha forced 255) matches FreeRDP BGRX semantics
  (`decode.worker.ts:294-308`).
- H264 codec string `avc1.42E01E` matches AVC420 and the probe codec; Annex-B in-band
  SPS/PPS means no `description` is required (`decode.worker.ts:158-162`, `capabilities.ts:47`).
- Transfer list dedups the shared WS `ArrayBuffer` across batch sub-array views, so a
  single buffer is transferred once (`canvas-renderer.ts:458-469`); H264 `decode()` copies
  the payload synchronously so transferring it afterward is safe.
- System / hidden cursors travel as JSON (worker only takes the binary cursor path when
  `len(Payload)>0`, `binary_frame.go:131`), and the JSON path carries `system_kind`/`hidden`
  consumed at `desktop-display.tsx:820-821`. The binary cursor decoder intentionally only
  maps raw_bgra/png (`frame-client.ts:348-353`), which is the only thing that arrives there.
