# RDP Investigation — Layer: stdio bridge + subprocess driver lifecycle

Scope: `cmd/freerdp-worker/main.go`, `internal/desktop/worker_freerdp.go`,
`internal/desktop/framed.go`, `internal/desktop/binary_frame.go` (wire codec),
`internal/desktop/worker_dummy.go` (contract reference), with cross-checks into
`internal/desktop/ws_handler.go` and `internal/desktop/manager.go`.

## How the layer works

### Spawn / start
- `Manager.StartSession` (manager.go:289) calls `pickWorker("freerdp")`
  (manager.go:339) → `NewFreeRDPWorker(logger, path, WithDebugLog(...))`.
- `FreeRDPWorker.Start` (worker_freerdp.go:65) spawns the worker binary with
  `exec.CommandContext(ctx, path)`, wires stdin/stdout/stderr pipes, optionally
  sets `WLOG_LEVEL=DEBUG` on the child env (worker_freerdp.go:74), starts the
  process, then writes the **first** stdio frame:
  `{"type":"start","p":StartParams}` (worker_freerdp.go:97-101), and launches
  `forwardStderr`, `pumpStdout`, `watchProcess`.

### Worker side (subprocess)
- `main.run` (main.go:52) reads the first frame, requires `type=="start"`
  (main.go:83), then **forces WLog to stderr** via `rdp.ConfigureWLogToStderr()`
  (main.go:90) and applies `WLOG_LEVEL` (main.go:104) BEFORE the first libfreerdp
  call (`rdp.NewClient` / `worker.Start` at main.go:117-120). This protects the
  stdout frame stream from WLog corruption.
- Two pumps: stdin→worker (main.go:128, decodes `{"type":"client"|"close"}`
  JSON envelopes), worker→stdout (main.go:159, encodes every `ServerMessage`
  via `desktop.EncodeServerMessageBinaryPayload` and `writeFrame`s it).

### Wire format (stdio hop, both directions)
- 4-byte BigEndian length prefix + payload. `writeFrame`/`readFrame` in
  framed.go; the worker re-implements identical logic inline (main.go:59,189).
- Payload of a worker→gateway frame is itself a **32-byte binary header +
  payload** (binary_frame.go): byte0=Kind (1 JSON,2 Rect,3 Cursor,4 Batch),
  byte1=Encoding, byte2=Flags(keyframe), bytes8-27 = X/Y/W/H/PayloadN
  BigEndian. Status/Clipboard/Bell are wrapped as `BinaryFrameJSON` (kind=1).
- `pumpStdout` (worker_freerdp.go:190) reads each stdio frame, calls
  `DecodeServerMessageBinaryPayload`; if that returns `binaryPayload==false`
  it falls back to plain JSON decode. The binary-vs-JSON discriminator is
  `looksLikeBinaryServerPayload(body[0])` (kind ∈ 1..4) AND `len>=32`
  (binary_frame.go:158). JSON text starts with `{`/`[`/quote/space, never
  bytes 1-4, so there is no collision. The worker always wraps, so the JSON
  fallback branch is effectively dead for the freerdp worker (harmless).

### Lifecycle / teardown
- `watchProcess` (worker_freerdp.go:228) `cmd.Wait()`s, then does a
  **non-blocking** `select{ case w.out<-Status: default: }` and `close(w.done)`.
- `Close` (worker_freerdp.go:140) is `closeOnce`-guarded: set `closing`, send a
  best-effort `close` frame (250ms timeout), close stdin, wait `<-w.done` (with
  a 2s kill fallback), then `close(w.out)`.
- WS handler drains `Worker.Recv()` (ws_handler.go:98-141); on CLOSED/ERROR
  status it tears down the browser WS and calls `Worker.Close()`
  (ws_handler.go:163).

## Findings

### F1 (CRITICAL) — send-on-closed-channel panic race in teardown
`pumpStdout` blocks in `select{ case w.out<-msg: case <-w.done: return }`
(worker_freerdp.go:212-216). `Close` does `<-w.done` then `close(w.out)`
(worker_freerdp.go:151-159). `w.done` is closed by `watchProcess` right after
`cmd.Wait()` returns (worker_freerdp.go:245). `pumpStdout` reads stdout directly
from the `StdoutPipe` and is NOT synchronized with `cmd.Wait()`. Sequence:
pumpStdout reads a frame and enters its select; watchProcess's Wait returns and
closes `done`; Close unblocks and closes `out`. Now pumpStdout's select has two
ready cases — `w.out<-msg` (send to a CLOSED channel → **panic**) and
`<-w.done`. Go picks at random; ~50% it sends and the **whole gateway process
panics/crashes**, killing every concurrent desktop/SSH/DB session. This is a
real, frequently-hit teardown path (every normal session end / target
disconnect). Breaks 画面 for all sessions on crash.
Fix: never `close(w.out)`. Instead signal completion with a separate sentinel:
keep `done` as the only close signal, have the WS reader treat channel-drain via
`<-w.done` too, OR guard every `w.out` send through `w.done` AND ensure
pumpStdout has fully returned before closing. Concretely: in `Close`, after
`<-w.done`, also wait for pumpStdout to exit (add a `pumpDone chan struct{}`
closed at the end of `pumpStdout`) before `close(w.out)`; or drop `close(w.out)`
entirely and let the WS reader exit on `<-w.done`/`gctx.Done()`.

### F2 (HIGH) — Status from watchProcess is silently dropped under load
`watchProcess` emits the terminal `PhaseClosed`/`PhaseError` status with a
**non-blocking** `select{...; default:}` (worker_freerdp.go:241-244). The `out`
channel has capacity 256 (worker_freerdp.go:56). If the browser/WS reader is
slow and the buffer is full at exit time, the terminal status is **dropped**.
The WS reader only tears down the browser on receiving CLOSED/ERROR
(ws_handler.go:136); without it, teardown relies on the channel
closing/`gctx.Done()`. With F1's `close(w.out)`, a closed channel read returns
`ok==false` (ws_handler.go:113) so the WS still closes — but the browser loses
the real error message/code, so users see a generic disconnect instead of
"auth failed / cert rejected", masking the actual failure cause. Impact on 画面:
on real connection failures the user may just see a frozen/blank screen with no
diagnostic.
Fix: make the terminal status delivery best-effort-but-prioritized — either send
with a short timeout, or drain one slot, or stash the final status so `Close`
can surface it. At minimum log the dropped status at WARN.

### F3 (HIGH) — worker→gateway frame has no outbound size cap; oversize frame
### permanently freezes the display
The worker's inline `writeFrame` (main.go:59-69) writes whatever
`EncodeServerMessageBinaryPayload` produced with **no size check**. The gateway's
`readFrame` (framed.go:33-50) rejects `n > maxFrameBytes` (64 MB). A full-screen
`EncodingRawBGRA` rect is emitted when zlib/JPEG aren't chosen
(frame_encode.go:84,97,104,111,117): 4K = ~33 MB (OK), but 8K / large
multi-monitor geometry (e.g. 7680×4320×4 ≈ 132 MB) exceeds 64 MB. On the first
oversize frame, `readFrame` errors, `pumpStdout` logs a WARN and **returns**
(worker_freerdp.go:194-198), permanently ending the stdout pump. No further
frames are delivered → frozen/blank 画面 with the session still "connected".
Also note `desktop.framed.maxFrameBytes` (framed.go:15, used by the gateway
read) and the worker's two inline `64*1024*1024` literals (main.go:198 for
stdin; no cap on stdout write) are duplicated, not shared — drift risk.
Fix: (a) add a matching size cap to the worker's outbound `writeFrame` and
split oversize raw rects into tiles before sending, or force a codec
(zlib/JPEG/H264) above a pixel threshold; (b) in `pumpStdout`, on a
`frame too big` read error, surface a PhaseError status to the browser instead
of silently returning; (c) share one `maxFrameBytes` const between framed.go
and the worker.

### F4 (MEDIUM) — Send() can block the WS read goroutine indefinitely (no real
### deadline; comment is misleading)
`Send` (worker_freerdp.go:114-136) holds `w.mu` and calls `writeFrame(w.stdin,…)`.
The comment at line 133-134 claims a "generous deadline", but **no deadline is
applied** and `*os.File` stdin pipes don't support write deadlines. `Send` is
called synchronously from the WS browser→worker reader (ws_handler.go:92). If the
subprocess stops draining stdin (hung but not dead), `Send` blocks forever
holding `w.mu`; the WS reader goroutine wedges, so client input (keyboard/mouse)
silently stops being forwarded — 转发 of input breaks while frames may still
flow. `Close`'s `sendCloseFrameWithTimeout` spawns its lock acquisition in a
goroutine with a 250ms outer timeout so Close itself won't hang, but the
mu-waiting goroutine leaks and the input path stays dead.
Fix: bound `Send` — run the stdin write in a goroutine guarded by a timeout (like
`sendCloseFrameWithTimeout` does), or drop input frames when a write is already
in flight, returning an error the WS layer logs. Remove the false "deadline"
comment.

### F5 (MEDIUM) — direct target dial only; no proxy-chain / gateway forwarding
This layer carries `StartParams{Host,Port,...}` (types.go:270, set from
`node.Host`/`node.Port` at manager.go:295-296) straight to the worker, which
hands Host/Port to libfreerdp's `FreeRDP_ServerHostname/ServerPort` (see
client.go). Unlike guacamole/tcpfwd, there is **no hook** in the StartParams
contract or the bridge to route the worker's TCP connection through
JumpServer's proxy-chain / gateway. So a node only reachable via a SOCKS/jump
chain cannot be reached by the freerdp backend — a genuine 转发 capability gap,
not a bug in existing code. Confirmed at the contract boundary: `StartParams`
has no proxy/gateway field; nothing in main.go or worker_freerdp.go consults a
proxy.
Fix (cross-layer, design): add proxy descriptor fields to `StartParams`
(e.g. `ProxyChain []ProxyHop` or a local SOCKS endpoint), have the gateway stand
up a local listener / SOCKS like tcpfwd/guacamole, and point libfreerdp at that
local endpoint (FreeRDP supports proxy via `FreeRDP_ProxyType/ProxyHostname/
ProxyPort`, or dial through the local forwarder). Out of scope to fix purely in
the bridge, but the bridge contract must grow the field.

### F6 (LOW) — stderr diagnostics silently truncate / stop on a >1MB log line
`forwardStderr` (worker_freerdp.go:220-225) uses `bufio.Scanner` with a 1 MB max
token (line 222). A single WLog TRACE line over 1 MB (rare but possible with
verbose channel dumps) makes `sc.Scan()` return false with `ErrTooLong`, ending
stderr forwarding for the rest of the session — operator loses the libfreerdp
state-machine trace exactly when debugging hard failures. Does not affect 画面.
Fix: log the scanner error on loop exit, and/or switch to a bufio.Reader with
`ReadString('\n')` that tolerates long lines.

### F7 (INFO) — `coalesceFrameMessages` can re-batch already-batched frames
Not a bug in this layer, noted for the rendering layer: ws_handler.go:119/176
coalesces consecutive Frame/Batch messages into one Batch (max 32). This relies
on `EncodeServerMessageBinaryPayload` collapsing a 1-frame batch back to a Rect
(binary_frame.go:97-100), which it does. Wire contract stays consistent; no
action here.

## Wire-contract verification (Go side, this layer)
- 32-byte header offsets/endianness match the stated contract exactly
  (binary_frame.go:67-93): Kind@0, Enc@1, Flags@2, X@8, Y@12, W@16, H@20,
  PayloadN@24, all BigEndian; bytes 3-7 reserved/zero.
- Encoding map matches: none0/rawBGRA1/JPEG2/PNG3/zlibBGRA4/H2645/RFX6
  (binary_frame.go:24-37, 316-352). Round-trip covered by
  binary_frame_test.go. Cursor encoding only supports rawBGRA/PNG
  (binary_frame.go:354-373) — `CursorEncodingSystem`/Hidden go via the JSON
  branch, fine.
- Batch payload = uint32 count + count×(header+payload), strict trailing-byte
  check (binary_frame.go:215-296). Matches contract.
- Length caps: gateway read = 64 MB (framed.go:15); worker stdin read = 64 MB
  (main.go:198); worker stdout write = UNCAPPED (see F3).
