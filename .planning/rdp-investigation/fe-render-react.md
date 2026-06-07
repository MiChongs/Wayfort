# RDP Investigation — Frontend canvas renderer + React display + page

Layer: `web/src/lib/desktop/canvas-renderer.ts`, `web/src/lib/desktop/decode.worker.ts`,
`web/src/lib/desktop/frame-client.ts`, `web/src/components/desktop/desktop-display.tsx`,
`web/src/components/desktop/desktop-cursor-map.ts`, `web/src/components/desktop/desktop-key-map.ts`,
`web/src/lib/desktop/input.ts` (dead), `web/src/app/(app)/nodes/[id]/rdp-next/page.tsx`.

## How the layer works

1. **Page** (`rdp-next/page.tsx`) parses `?backend=` (default `freerdp`), fetches the node, and renders
   `<DesktopDisplay>` inside a `h-[calc(100vh-56px)]` box.
2. **DesktopDisplay** dispatches to `IronRdpDesktopShell` for `backend==="ironrdp"` else `LegacyDesktopDisplay`.
3. **LegacyDesktopDisplay** runs one big connect `useEffect` keyed on `[nodeId, backend, bumpKey]`:
   creates a `CanvasRendererHandle`, appends `renderer.canvas` to `hostRef`, wires renderer callbacks
   (resize/cursor/error/metrics/refresh), then `connect()`:
   - `collectClientCapabilities()` → `POST /desktop/sessions` (`desktopControl.startSession`) →
     gets `session_id` + `remote_width/height` → `renderer.resize(remoteW, remoteH)` →
     opens `FrameClient` (WS `/api/v1/ws/v2/desktop/:id`) → `attachInputs(...)`.
   - Effect cleanup: cancels reconnect timer, detaches renderer cbs, `closeCurrentSession(true)`
     (DELETE /sessions), `renderer.destroy()`.
4. **FrameClient** decodes desktop.v2 binary (32-byte header) → calls `onFrameBytes` / `onFrameBatch` /
   `onCursor` / `onStatus`. Outgoing input/clipboard/refresh/caps go as JSON over the same WS.
5. **CanvasRenderer** queues frame bytes in `pendingFrames`, flushes on `requestAnimationFrame`, hands the
   batch to **decode.worker.ts** (off-thread), then paints: `drawImage` for `ImageBitmap`, `putImageData`
   for `ImageData`. Emits 1 Hz `RenderMetrics`.
6. **decode.worker.ts** decodes per encoding: raw/zlib BGRA→RGBA hand swap (`putImageData`), JPEG/PNG via
   ImageDecoder→createImageBitmap→Blob→jpeg-js/fast-png fallback chain, H264 via a single per-session
   `VideoDecoder` (avc1.42E01E). RFX is rejected (no decoder).

## Data / format consumed & produced

- **Consumes** desktop.v2 binary frames. I verified the 32-byte header byte layout and encoding/kind
  numbers in `frame-client.ts` match `internal/desktop/binary_frame.go` **exactly**
  (Kind 1/2/3/4, Encoding 0-6, Flags bit0=keyframe, BigEndian uint32 at [8],[12],[16],[20],[24],
  batch = uint32 count + repeated header+payload). No wire mismatch found.
- **Produces** to canvas: RGBA pixels. Outgoing JSON `ClientMessage` (key/mouse/hb/clipboard/caps/refresh).

## Findings

### CRITICAL — none that break the happy path outright (wire contract verified correct).

### HIGH

1. **StrictMode "fix" is a global escape hatch, not a real idempotency fix; regression is one config flip
   away** — `web/next.config.mjs:22` sets `reactStrictMode:false` with a long comment admitting the
   underlying double-invoke teardown race (orphaned `freerdp-worker.exe`, "画面出现一下就掉") was never
   actually solved; PR #27's LiveCache + 200ms deferred teardown "still fired synchronously with a
   populated session". The connect effect (`desktop-display.tsx:210-467`) is NOT double-invoke safe: on
   the second mount it `++sessionEpochRef`, the first cleanup runs `closeCurrentSession(true)` which
   DELETEs the just-created session. If StrictMode is ever re-enabled, or any parent remounts the
   component twice quickly, the 1.5s-and-drop bug returns. Real risk to 画面 stability.

2. **Mouse coordinate mapping uses host rect, not the canvas's rendered rect → wrong remote coordinates
   whenever the canvas is letterboxed/scaled** — `attachInputs.toRemote` (`desktop-display.tsx:694-704`)
   computes `sx = canvas.width / rect.width` using `host.getBoundingClientRect()`. The canvas only ever
   carries `maxWidth/maxHeight:100%` (`canvas-renderer.ts:90-91`) with NO `object-fit`, no aspect lock,
   no `w-full/h-full`. In `fit`/`center`/`actual` modes the host is `items-center justify-center`, so the
   canvas's painted box is centered and usually smaller than the host in at least one axis. Dividing by
   the host width/height (instead of the canvas's actual `getBoundingClientRect()`) yields mouse positions
   that drift increasingly off-target away from the top-left. Clicks land in the wrong place. This breaks
   interactive use (转发/操作 correctness) in the common non-1:1 case.

### MEDIUM

3. **`stretch` and non-1:1 `fit` scaling can distort the picture; per-axis maxWidth/maxHeight breaks aspect
   ratio** — canvas has only `maxWidth:100%;maxHeight:100%` (`canvas-renderer.ts:90-91`). `scaleHostClass`
   returns `items-stretch justify-stretch` for `stretch` (`desktop-display.tsx:854`) but a flex item won't
   fill both axes without `w-full h-full`, so "stretch" doesn't actually stretch. And when a canvas larger
   than the host is clamped, the two independent max-* constraints can shrink width and height by different
   factors → non-uniform squish (aspect distortion). Picture geometry is wrong in those modes.

4. **H.264 paint scales the full decoded surface into the region rect — garbles partial-region AVC420
   updates** — renderer paints `ctx.drawImage(bitmap, frame.x, frame.y, frame.width, frame.height)`
   (`canvas-renderer.ts:256`). For H264 the worker forwards the raw NAL stream after stripping the AVC420
   region-rect wrapper (`channels.go:413-426`) and sets `frame.width/height` to the surface-command
   destination rect (`channels.go:342-364, 379-396`), but `createImageBitmap(videoFrame)` yields the codec's
   full coded surface (16-aligned, e.g. 1920×1088). drawImage then *stretches the entire surface into the
   sub-rect*. For full-surface keyframes this is only a tiny vertical squish (1080 vs 1088); for any partial
   region update it badly garbles. The renderer should blit at the bitmap's native size (or crop the source
   region), coordinated with what the worker actually guarantees. RENDERING risk on the H264 path.

5. **RFX is negotiated-able server-side but has no browser decoder → black region + thrown error** —
   `decode.worker.ts:79-86` rejects every `rfx` frame and posts a one-shot warn. The frame is silently
   dropped (paint promise rejects, caught at `canvas-renderer.ts:281-283` → console.warn only). If a server
   only emits RFX (e.g. `enable_remote_fx` on, H264 unavailable) the user sees a frozen/black screen with no
   surfaced UI error. capabilities.ts sends `rfx:false` to suppress it, but this depends on the worker
   honoring it; nothing on the FE recovers if RFX still arrives.

6. **`decodeJSONFrameBatch` payload decode ignores `keyframe`/uses string payload, but JSON v1 path is mostly
   dead** — `frame-client.ts:334-339` maps `FrameBatch.frames` straight through with `payload` decoded by
   `bytesFromFramePayload`; the per-frame `keyframe` flag is preserved by the spread, OK. Lower impact since
   desktop.v2 binary is the negotiated subprotocol; only a relevant gap if a server ever falls back to v1.

### LOW / INFO

7. **`web/src/lib/desktop/input.ts` is dead code** — the live input handler is the inline `attachInputs`
   in `desktop-display.tsx:685`. The standalone module (`input.ts:26`) is never imported (verified via
   grep). It also has the *correct-shaped* `getScale()` contract the inline version lacks, and a worse
   keysym table than `desktop-key-map.ts`. Risk: a future dev edits the wrong file. Delete it.

8. **`ensureRectFits`→`resize()` mid-stream clears the canvas (HTML spec: setting canvas.width/height wipes
   the backing store)** — `canvas-renderer.ts:184-190, 170-182`. On a grow event (remote desktop enlarges,
   or a rect extends past current bounds) the whole picture is cleared to transparent/black until the next
   full frame repaints. Usually masked because resize is set up-front from `start.remote_*`
   (`desktop-display.tsx:338-341`) and the server sends a full frame after, but a late grow can flash blank.
   Low because it's transient and rare.

9. **Latin-1 keysym range only** — `desktop-key-map.ts:161-165` sends codepoints 0x20-0xff directly and
   `0x01000000|cp` for >0xff. For CJK/IME text it relies on `isComposing`/`Process` early-out
   (`desktop-key-map.ts:143`); composed text never reaches the remote via keysyms (expected, clipboard is
   the path). The inline `onKeyDown/onKeyUp` (`desktop-display.tsx:736-749`) correctly uses
   `keysymForEvent` from `desktop-key-map.ts` (not the weaker inline one in `input.ts`).

10. **Docs vs code on H264/RDPGFX (stale doc)** — confirmed indirectly: `capabilities.ts` probes and enables
    H264 by default, `decode.worker.ts` has a full VideoDecoder path, and the renderer treats H264 as a
    first-class codec. `docs/rdp-backend-capabilities.md` claiming "Disabled" is stale (this layer enables
    it). Info only.

## Notes on the three concerns

- **画面 (display):** Wire contract correct; main display-stability risk is the StrictMode escape-hatch
  (HIGH #1) and the transient resize-clear (LOW #8).
- **绘制 (rendering):** BGRA→RGBA swap is correct (`decode.worker.ts:294-308`, alpha forced 255). Cursor
  raw_bgra swap correct (`desktop-cursor-map.ts:106-111`). Real rendering bugs are H264 sub-region stretch
  (MEDIUM #4) and aspect distortion in fit/stretch (MEDIUM #3).
- **转发 (forwarding):** Out of this layer's scope (worker dials target directly) — not assessable here;
  this layer faithfully relays input/clipboard/refresh/caps over the WS.
