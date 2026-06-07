# WebRDP Investigation — Layer: WebSocket handler + binary wire format + coalescing

Scope: `internal/desktop/ws_handler.go`, `internal/desktop/binary_frame.go`,
`internal/desktop/binary_frame_test.go`, `internal/desktop/types.go`,
`internal/desktop/control_handler.go`, plus the TS decoder it must match
(`web/src/lib/desktop/frame-client.ts`, `types.ts`,
`canvas-renderer.ts`, `decode.worker.ts`).

## How the layer works

### Path through this layer
1. Worker subprocess (`cmd/freerdp-worker/main.go:159-171`) encodes every
   `ServerMessage` with `desktop.EncodeServerMessageBinaryPayload` and writes
   it length-prefixed (4-byte BE) on stdout.
2. `FreeRDPWorker.pumpStdout` (`worker_freerdp.go:190-218`) reads each stdio
   frame, calls `DecodeServerMessageBinaryPayload`, and pushes the resulting
   `ServerMessage` onto the buffered `out` channel (cap 256).
3. `WSHandler.Handle` (`ws_handler.go:35`) authenticates (owner check), upgrades
   via `webssh.AcceptWS("desktop.v2","desktop.v1")`, then runs three goroutines
   in an errgroup:
   - browser→worker: JSON-decode `ClientMessage`, `sess.Worker.Send`.
   - worker→browser: drain `Worker.Recv()`, **coalesce** frame messages
     (`coalesceFrameMessages`, max 32), encode via
     `encodeServerMessageForWS`, `conn.Write(MessageBinary)`.
   - 20s `conn.Ping` keepalive.
4. The same encoder/decoder pair is the **single source of truth** for both the
   stdio hop and the WS hop. The browser only sees the WS hop.

### Wire format (binary_frame.go, 32-byte header)
`[0]=Kind`(1 JSON,2 Rect,3 Cursor,4 Batch) `[1]=Encoding`(0 none,1 rawBGRA,
2 JPEG,3 PNG,4 zlibBGRA,5 H264,6 RFX) `[2]=Flags`(bit0 keyframe) `[3..7]` reserved
`[8:12]`X `[12:16]`Y `[16:20]`W `[20:24]`H `[24:28]`PayloadN, all BigEndian uint32.
Batch payload = uint32 count then count×(header+payload).

**This is byte-identical to the TS decoder** (`frame-client.ts:28-44`,
`handleBinaryV2` 192-247, `decodeFrameBatchPayload` 301-332): same offsets,
same `getUint32(off,false)` (BigEndian), same kind/encoding/flag constants,
same length validation. `binary_frame_test.go` covers header round-trip, rect,
zlib, batch, JSON, and the "ignore plain JSON" guard. **No wire mismatch found.**

### JSON fallback (desktop.v1)
If the negotiated subprotocol is `desktop.v1`, `encodeServerMessageForWS`
`json.Marshal`s the `ServerMessage` instead. `[]byte` payload fields become
base64; the TS JSON path (`handleServerMessage`) base64-decodes them
(`bytesFromFramePayload`, `base64ToBytes`). Cursor payloads are base64 on both
the binary path (`bytesToBase64`) and JSON path. Consistent.

### Cursor encoding gating
`EncodeServerMessageBinaryPayload` only emits a binary Cursor (kind 3) when
`len(Cursor.Payload) > 0` (`binary_frame.go:131`). System / hidden cursors carry
no bitmap, so they fall through to the JSON envelope (kind 1) and are decoded by
`handleServerMessage`→`onCursor` on the browser. Binary cursor encoding is
restricted to rawBGRA/PNG (`binaryEncodingFromCursor`). Correct and intentional.

### Coalescing / ordering
The worker already emits frames **in sequence order** (`frame_encode.go`
`frameEmitNext` reorder buffer), so the channel is ordered. `coalesceFrameMessages`
(`ws_handler.go:176-199`) only greedily drains *additional* frame messages
(up to 32) that are immediately available, appends them in receive order, and
**stashes any non-frame message it pulls into `pending`** so it is delivered next
(order preserved). Frame ordering is preserved across the layer; full-canvas
"reset" handling is done browser-side in `canvas-renderer.ts`
(`isNearFullCanvasFrame`) and is not violated by gateway batching.

## Findings

### F1 (medium) — `conn.Write` has no write deadline → slow/wedged browser stalls the worker drain
`ws_handler.go:129` `conn.Write(gctx, …)` uses the parent context, which has no
timeout. coder/websocket has no built-in write timeout. A browser whose TCP
receive window is stuck blocks the worker→browser goroutine indefinitely; the
worker `out` channel (cap 256) fills, after which the worker's `emit`
(`client.go:1384-1398`) silently **drops frames** (and, worse, drops Status /
Cursor / Clipboard because `serverMessageFrameCount==0` takes the no-op default).
A dropped `Status{CLOSED/ERROR}` means the WS never tears down on that path; the
ping loop (20s, 10s timeout) is the only liveness backstop, so teardown can lag
~30s and a CLOSED/ERROR status can be lost entirely.
Fix: wrap each `conn.Write` in `context.WithTimeout(gctx, ~10s)` (mirror the ping
timeout) and return on timeout so the errgroup tears the session down.

### F2 (medium) — `Manager.Take` does not remove the session; concurrent/duplicate WS attaches share one worker
`ws_handler.go:46` calls `Manager.Take`, which **returns without deleting** from
`live` (`manager.go:396-404`). Only the *successful* WS handler deletes on exit
(`ws_handler.go:164-166`). Two WS connections to the same `session_id` (same
owner — e.g. a duplicated tab or a reconnect that races the old socket's
teardown) both pass the owner check and both attach to the **same**
`Worker.Recv()` channel and the same `Worker.Send`. Recv is a single channel, so
the two readers split frames between them → both canvases garble / go blank.
Whichever WS exits first deletes the live entry and `Worker.Close()`s the shared
worker, killing the other still-"connected" session.
Fix: make `Take` atomically mark the session as attached (e.g. a
`sync.Once`/`atomic.Bool` "claimed" flag) and reject a second WS with 409, or
have `Take` delete-and-own so a second lookup 404s.

### F3 (low) — Double `recordEnd` → duplicate session-end audit + redundant DB update
On the normal path the WS handler calls `Manager.recordEnd` directly
(`ws_handler.go:167`). If the session is also ended via
`DELETE /desktop/sessions/:id` (`control_handler.go:47`→`Manager.End`→
`recordEnd`, `manager.go:406-428`) — or via `Session.Cancel` — `recordEnd` runs
twice on the same `sessionRow`. It is **not idempotent** (`manager.go:472-495`):
two `AuditSessionEnd` events and two `sessions.Update`s are written, and the
`runErr` from whichever path runs second wins (an operator DELETE after a real
error would overwrite the error reason with a clean close).
Fix: guard `recordEnd` with `Session.closeOnce` / a `sync.Once`, or move all
teardown bookkeeping behind `Session.Cancel`’s `closeOnce` and have the WS
handler call that instead of `recordEnd` directly.

### F4 (low) — WS handler bypasses `Session.cancel` / `Session.Cancel` on teardown
`ws_handler.go:162-173` closes the worker and deletes the live entry directly,
but never calls `sess.cancel` (the `context.WithCancel` that scopes
`worker.Start`, `manager.go:306-319`) nor `sess.Cancel()`. `FreeRDPWorker.Close`
does signal/kill the subprocess so the process is reaped, but the
`exec.CommandContext` cancel func is leaked until GC, and the manager and WS
teardown paths are not unified (root cause shared with F3). No screen impact;
correctness/lifecycle hygiene only.
Fix: route WS teardown through `Session.Cancel()` (which already wraps
`Manager.End` in a `sync.Once`) instead of the ad-hoc
`Worker.Close()`+`delete`+`recordEnd` block.

### F5 (info) — `RFX` (encoding 6) is fully wired on the wire but has no browser decoder
`binary_frame.go:316-352` maps `EncodingRFX`↔6 in both directions and the TS
decoder maps 6→`"rfx"` (`frame-client.ts:295,41`), so an RFX frame traverses
this layer intact — then `decode.worker.ts:79-86` throws "rfx decode path not
implemented" for every such frame and posts a one-time `warn`. If a node has
RemoteFX enabled and the server negotiates RFX, **the screen stays blank** even
though the byte plumbing is correct. This is a known gap (commented as such), not
a wire bug, but it is a real "connect succeeds, no picture" outcome.
Fix (out of this layer): either disable RFX negotiation in the worker when the
browser can't decode it (the `ClientCaps.rfx` gate already exists in
`types.go:229-233`), or implement the RFX decode path.

## Things verified OK (no action)
- Header encode/decode offsets, endianness, and constants are byte-identical
  Go↔TS for JSON / Rect / Cursor / Batch and all 7 encodings + keyframe flag.
- Length validation guards: `DecodeServerMessageBinaryPayload` and
  `decodeFrameBatchPayload` both bounds-check `PayloadN`/batch offsets and reject
  trailing bytes; TS mirrors this (returns `[]`/`undefined` on mismatch). No OOB.
- `looksLikeBinaryServerPayload` correctly disambiguates binary vs JSON on stdio
  so the v1 JSON envelope still round-trips (`pumpStdout` falls back to
  `jsonDecode`).
- Frame ordering is preserved end-to-end; coalescing never reorders or merges a
  non-frame message ahead of pending frames.
- Auth: owner check (`UserID`) is enforced; WS token is accepted via
  `?token=` query (`auth/middleware.go:126`) and the route sits under the
  authed `ops` group.
- CLOSED/ERROR status triggers WS teardown (`ws_handler.go:136-138`) — subject to
  F1 (could be dropped if the channel is full).
