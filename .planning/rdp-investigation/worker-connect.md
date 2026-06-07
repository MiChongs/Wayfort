# RDP Investigation — Layer: Worker connect / settings / security / fallback

Scope: `cmd/freerdp-worker/rdp/client.go`, `security_policy.go`, `errors.go`,
`internal/desktop/rdp_options.go`, `internal/desktop/types.go`, plus the cgo
bridge (`cgo_wrappers.go`, `cgo_exports.go`), `input.go`, `frame_encode.go`,
`channels.go`, `internal/desktop/manager.go`, `worker_freerdp.go`,
`binary_frame.go`.

## How the layer works

1. `Manager.StartSession` (manager.go) resolves node + credential, parses
   `RdpOptions` from `node.ProtoOptions`, applies browser capability gating
   (suppress GFX/H264 when `req.ClientCaps.H264 == false`), then builds a
   `StartParams{Host, Port, Username, Password, Domain, Width, Height,
   Keyboard, Quality, RDP}` and hands it to the worker. **Host/Port are
   `node.Host` / `node.Port` verbatim** (manager.go:294-305).
2. `FreeRDPWorker.Start` (worker_freerdp.go:65) spawns `freerdp-worker`, writes
   the start frame as length-prefixed JSON over stdin, and pumps stdout frames
   back. `main.go` decodes the start frame, forces WLog to stderr
   (`ConfigureWLogToStderr`), constructs `rdp.NewClient`, calls `Start`.
3. `Client.Start` (client.go:258) sizes the canvas (default 1280x720), inits the
   frame encoder pool, `bringUpInstance()` (freerdp_new + context_new + install
   callbacks + `applySettings`), logs the security/channel/GCC summary, then
   spawns `runLoop`.
4. `applySettings` (client.go:304) writes hostname/port/creds, the GCC
   TS_UD_CS_CORE fields (ClientHostname, ClientBuild=19045, keyboard LCID,
   OsType, EarlyCapabilityFlags, ConnectionType=BROADBAND_LOW), security
   toggles from `RdpOptions.SecurityFlags()`, ExtSecurity (HYBRID_EX) only in
   "any" mode, cert ignore, TLS sec level, TCP timeouts, codec/GFX toggles, and
   forces audio/drive/printers/smartcards/DRDYNVC off. It enables `RefreshRect`
   and `SuppressOutput` so the worker can drive the first-frame handshake.
5. `runLoop` (client.go:668) locks the OS thread, emits `PhaseConnecting`,
   calls `connectWithAutoNlaRetry`, emits `PhaseConnected`, sends focus-in +
   `requestDesktopRefresh`, then loops: drainInput → emit pending resync →
   send pending focus-in → periodic stats + first-frame diagnostics →
   `WaitForMultipleObjects(100ms)` → `freerdp_check_event_handles`. On
   check-handles failure it tries, in order: clipboard fallback, safe-graphics
   fallback, auto-reconnect, then surfaces the error.
6. `goPostConnect` (cgo_exports.go:54) runs `gdi_init(PIXEL_FORMAT_BGRA32)`,
   installs update + pointer callbacks, and reflects the server-negotiated
   desktop size into `c.width`/`c.height`.

Data consumed: `StartParams` (JSON over stdio). Data produced: `ServerMessage`
{Status | Frame | Cursor | Clipboard} → `EncodeServerMessageBinaryPayload`
(32-byte header + payload). Status messages drive the browser phase UI; the
first decoded frame flips `firstFrameLogged` (frame_encode.go:127,
channels.go:318), which gates every fallback decision.

## Fallback map

- `connectWithAutoNlaRetry`: first `freerdp_connect`; on
  `0x0002000C` + selected==0 + we didn't offer HYBRID + operator mode != any,
  rebuild with `Security=any` and retry once. (client.go:1149, 1232)
- Transport-drop (post-connect, before first frame, `0x0002000D`):
  `trySetupFallbackWithoutClipboard` (once) → `trySetupFallbackSafeGraphics`
  (once). (client.go:802, 874)
- First-frame stall (>=10s, GFX negotiated but no surfaces):
  `tryFirstFrameStallCompatGraphics` (drop H264, keep GFX) →
  `tryFirstFrameStallSafeGraphics`. (client.go:942, 965, 1022)
- `tryAutoReconnect`: only after a first frame, FreeRDP `client_auto_reconnect`,
  rate-limited to 3 per 10s. (client.go:1079)

All rebuild paths `tearDownInstanceQuietly` (disconnect+context_free+free+
registry.remove) before `bringUpInstance`, so no obvious C-memory leak.
`firstFrameLogged` is correctly set on the real emit path, so the
"only-retry-before-first-frame" / "only-auto-reconnect-after-first-frame"
gates are sound.

## State: PARTIAL / working-with-gaps

Connection establishment, security negotiation, GCC core data, and the
suppress-output + refresh-rect first-frame handshake are implemented carefully
and look correct. The biggest user-goal gap is **forwarding**: the worker dials
the target directly and has no path through JumpServer's proxy-chain/gateway.
Secondary gaps are in fallback coverage and a resize/refresh dimension
mismatch.

## Findings (see structured output for full detail)

1. CRITICAL/forwarding — No proxy-chain forwarding for freerdp/dummy. Worker
   dials `node.Host:node.Port` directly (manager.go:294-305 → client.go:307-323
   `FreeRDP_ServerHostname`/`ServerPort`). No `ContextDialer`/SOCKS5 listener
   like guacamole `socks_local.go` or `tcpfwd`. Targets reachable only via the
   SSH-bastion / SOCKS5 chain cannot be reached.
2. MEDIUM/lifecycle — First-frame stall fallback only fires for the
   RDPGFX-negotiated-but-empty case (`shouldFallbackFromRDPGFXStall` requires
   `rdpgfxResetGraphics>0 && createSurfaces==0`). A non-GFX session that
   connects but never paints (bitmap path silent) logs forever; no recovery.
   (client.go:942-956)
3. MEDIUM/display — `msg.Resize` overwrites `c.width`/`c.height` with the
   browser viewport while the RDP desktop stays at the server-negotiated size;
   subsequent `requestDesktopRefresh` / RefreshRect PDUs then use wrong bounds
   (input.go:121-127 vs client.go:1479-1496, cgo_wrappers.go:694-700).
4. LOW/docs — `docs/rdp-backend-capabilities.md` is stale: lists RDPGFX/H264 as
   "Disabled / must remain forced off", but client.go enables GFX+H264+NSCodec+
   clipboard by default. (docs:10-14 vs client.go:522-536)
5. INFO/lifecycle — Auto-NLA retry only triggers when operator mode is not
   "any". In the default "any" mode HYBRID/HYBRID_EX is already offered, so this
   is consistent, but worth noting the retry is dead for the default config.
   (client.go:1170, 1232)
