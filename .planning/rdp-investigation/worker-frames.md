# RDP Investigation — Layer: Worker Frame Production

Scope: GDI bitmap path, SurfaceBits, RDPGFX surface/frame commands, H.264/AVC420
encode/forward, cursor, frame ordering. Files:
`cmd/freerdp-worker/rdp/{client.go,channels.go,frame_encode.go,cgo_exports.go,cgo_wrappers.go}`,
`cmd/freerdp-worker/main.go`, `internal/desktop/{binary_frame.go,types.go,manager.go}`,
`web/src/lib/desktop/decode.worker.ts`.

## How the layer works

There are TWO distinct frame-production paths feeding the same wire format:

1. GDI / legacy path (no GFX, or GFX-but-non-AVC). libfreerdp's own
   `BitmapUpdate`/`SurfaceBits` handlers decode/composite into
   `ctx->gdi->primary_buffer` (BGRA32, set by `gdi_init(... PIXEL_FORMAT_BGRA32)` in
   `goPostConnect`, cgo_exports.go:65). Our wrappers (`wBitmapUpdate`,`wSurfaceBits`)
   call the original first, then our `//export` handlers. `goOnEndPaint` /
   `goOnSurfaceBits` call `flushGDIInvalidRegions`, which reads the GDI invalid
   region(s), computes a bounding box, and `emitGDIRegion` copies the BGRA rows out
   of `primary_buffer` (respecting `gdi.stride`) and hands them to `submitFrame`.
   `submitFrame` (frame_encode.go) chooses raw BGRA / zlib BGRA / JPEG based on size
   and heuristics, assigning an ordered sequence number `frameSeq`. The async encode
   pool reorders completions back into `frameSeq` order via `frameReady`/`frameEmitNext`
   in `completeFrame`.

2. RDPGFX path (GFX negotiated). `goRdpgfxSurfaceCommand` (channels.go:273) forwards
   the SURFACE_COMMAND payload directly: AVC420 -> `EncodingH264` (after stripping the
   MS-RDPEGFX AVC420 wrapper and normalizing to Annex-B), CAPROGRESSIVE ->
   `EncodingRFX`. All other GFX codecs (uncompressed/planar/clearcodec/cavideo/AVC444)
   return `(_, false)` and are dropped. These frames also take a `frameSeq` slot and go
   through `completeFrame`, but they BYPASS the encode pool (emitted synchronously on
   the FreeRDP event-loop thread).

Output: `desktop.ServerMessage{Frame|FrameBatch|Cursor|Status|Clipboard}` on `c.out`
(buffered 1024). `main.go` length-prefixes each, body =
`EncodeServerMessageBinaryPayload` (32-byte binary header + payload). Header byte layout
verified byte-identical to the documented wire contract (binary_frame.go:63-92):
Kind@0, Encoding@1, Flags@2, X@8, Y@12, W@16, H@20, PayloadN@24, all BigEndian.
Encoding tags match (raw=1,jpeg=2,png=3,zlib=4,h264=5,rfx=6).

## Confirmed correct

- BGRA byte order: GDI primary buffer is BGRA32; raw/zlib payloads ship BGRA and the
  browser handles `raw_bgra`/`zlib_bgra` (decode.worker.ts:61). `bgraToRGBA` for JPEG
  swaps B/R correctly (frame_encode.go:442-447) and forces alpha 0xff.
- Stride handling in `emitGDIRegion` is correct: per-row copy at
  `(uy+row)*stride + ux*4`, with surface-bounds clamping (cgo_exports.go:452-465).
- H.264 AVC420 wrapper stripping + Annex-B normalization (channels.go:399-482) is sound.
- Frame ordering (frameSeq monotonic; completeFrame drains in order; skipFrame fills
  gaps) is coherent. Backlog cap (256) drops oldest and requests a resync.
- Encoding tag round-trips Go<->TS for all 6 codecs.

## Bugs / gaps found (see structured findings for severity)

1. CURSOR pixel format wrong (cgo_exports.go:543-572). `goOnPointerNew` is a no-op; the
   client never decodes `rdpPointer.xorMaskData` from its native `xorBpp` + AND-mask
   form into BGRA. The handler ships `xorMaskData` verbatim tagged `raw_bgra`. Only 32bpp
   ARGB cursors with no transparency render correctly; 1/16/24bpp cursors and any cursor
   relying on the AND mask render garbled / wrong-transparency. This is the standard job
   of a client `Pointer.New` callback (`freerdp_image_copy_from_pointer_data`).

2. RFX path produces unrenderable frames (channels.go:365-373 + decode.worker.ts:79-85).
   When `enable_remote_fx` is on, GFX CAPROGRESSIVE SURFACE_COMMANDs are forwarded as
   `EncodingRFX`, but the browser has NO RFX decoder — it throws. Result: black/blank
   screen with a thrown decode error, no fallback. The worker advertises a codec it
   cannot get rendered.

3. GFX non-AVC codecs silently dropped, no GDI fallback (channels.go:374-376). If the
   server picks uncompressed/planar/clearcodec/AVC444 for a SURFACE_COMMAND,
   `rdpgfxSurfaceCommandFrame` returns false and nothing is emitted. Because RDPGFX is
   handled GDI-side too, libfreerdp DOES decode it into primary_buffer, but no
   BeginPaint/EndPaint fires for GFX so `flushGDIInvalidRegions` never runs for these.
   The only safety net is `goRdpgfxEndFrameAfter` (cgo_exports.go via channels.go:715),
   which emits a full GDI frame ONLY if `frameSeq` did not advance during the frame.
   This works for an all-non-AVC frame, but a MIXED frame (one AVC surface cmd advances
   frameSeq + one planar surface cmd dropped) will NOT trigger the fallback — the planar
   region is lost (partial/stale画面).

4. No proxy-chain / gateway forwarding for the freerdp backend (client.go:318-322,
   manager.go:293-305, types.go:270). The worker sets only
   `FreeRDP_ServerHostname`/`FreeRDP_ServerPort` and dials the target DIRECTLY.
   `StartParams` carries no dialer/SOCKS/gateway info. Compare guacamole
   (`socks_local.go` -> `chain.Build().DialContext`) and tcpfwd (proxy.ContextDialer).
   Nodes reachable only via an SSH bastion / SOCKS chain CANNOT be reached by the
   freerdp backend. This is a real missing capability, not just a doc gap.

5. `goRdpgfxEndFrameAfter` fallback is effectively dead code (channels.go:704-730).
   Wire order within one GFX channel buffer is StartFrame -> SurfaceCommand(s) ->
   EndFrame, dispatched sequentially. So `goRdpgfxEndFrame` captures
   `cmdBase = rdpgfxSurfaceCommands.Load()` and `seqBase = frameSeq.Load()` AFTER this
   frame's surface commands already incremented both counters. Nothing increments
   `rdpgfxSurfaceCommands` between `goRdpgfxEndFrame` and `goRdpgfxEndFrameAfter` (they
   run back-to-back inside `wRdpgfxEndFrame`, cgo_wrappers.go:460-468). Therefore the
   guard at channels.go:721 (`rdpgfxSurfaceCommands == cmdBase`) is ALWAYS true for any
   frame that carried >=1 surface command, so `emitFullGDIFrame` never runs.
   Consequence: the intended GDI fallback for dropped non-AVC GFX surfaces (#3) never
   fires. Combined with #3, any GFX frame using a codec other than AVC420/CAPROGRESSIVE
   (planar/clearcodec/uncompressed/AVC444) is silently lost — frozen/partial画面.

6. JPEG full-desktop heuristic can ship lossy frames over the GFX/text path
   (frame_encode.go:337-367). Not a correctness break, but `isNearFullDesktopFrame`
   JPEG-encodes near-full GDI frames; for text-heavy desktops JPEG introduces visible
   chroma artifacts. Mitigated by `preferLosslessOverJPEG`. Info-level.

7. Memory: GDI C buffers are owned/freed by libfreerdp (`gdi_free` in goPostDisconnect).
   `C.GoBytes` copies in surface/cursor/clipboard paths, so no C leak observed.
   No bug here — recorded as verified.

8. Doc staleness: `docs/rdp-backend-capabilities.md` reportedly says RDPGFX/H264
   "Disabled"; code enables both by default (client.go:522-536,
   manager.go gates only on client H264 capability). Verify/refresh the doc. Low.
