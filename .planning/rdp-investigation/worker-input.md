# RDP Worker Layer — Input / Keyboard / Cursor / Clipboard

Scope: `cmd/freerdp-worker/rdp/input.go`, `keysym.go`, `keyboard_layout.go`,
`channel_names.go`, `channels.go` (cliprdr), `cgo_exports.go` (pointer/cursor
callbacks), `cgo_wrappers.go` (pointer trampolines / install). Cross-checked
against `internal/desktop/{types.go,binary_frame.go}` and the browser side
(`web/src/lib/desktop/input.ts`, `frame-client.ts`,
`web/src/components/desktop/{desktop-display.tsx,desktop-cursor-map.ts}`).

## How the layer works

### Input (browser → worker → server)

1. Browser captures DOM mouse/keyboard in `input.ts`. Mouse → `{mouse:{x,y,buttons,wheel}}`
   in remote pixels (CSS coords / scale). Keyboard → X11 keysym via `keysymForEvent`
   (printable chars sent as their ASCII codepoint; named keys mapped to 0xFFxx keysyms).
2. Gateway pipes the `ClientMessage` JSON to the worker. Inside the worker the
   in-process `Client.Send` (client.go:234) enqueues onto `c.in` (buffer 256);
   on overflow it returns `"input queue full"` and **drops the event**.
3. `runLoop` calls `drainInput` (input.go:25) from the FreeRDP owner thread; each
   message goes through `dispatchInput` (input.go:39):
   - `Key`: `keysymToScancode` first (keysym.go). If matched → `wSendScancode`
     (with extended flag). Else if 0x20–0x7E → `wSendUnicode`. Else if 0x100–0xFEFF
     → `wSendUnicode`. Else dropped.
   - `Mouse`: always emits `PTR_FLAGS_MOVE`, then per-button transitions vs.
     `c.prevButtons` (Left=BUTTON1, Middle=BUTTON3, Right=BUTTON2), then wheel
     (`Wheel*120`, low byte magnitude, `PTR_FLAGS_WHEEL_NEGATIVE` for down).
   - `Clipboard`: utf-16le → `pushClipboardUTF16LE`; utf-8/plain → `pushClipboardText`.
   - `Resize`: stored only (no RDPEDISP).
   - `Refresh`: `wSendContextRefreshRect`.

### Cursor (server → worker → browser)

- `goPostConnect` (cgo_exports.go:72) overrides the GDI pointer prototype with
  `wInstallPointerCallbacks`, which sets `New/Free/Set/SetNull/SetDefault/SetPosition`.
- `goOnPointerSet` (cgo_exports.go:544) reads `pointer.xorMaskData` /
  `pointer.lengthXorMask`, dedups via FNV hash (`lastCursorHash`), and emits a
  `CursorUpdate{HotspotX:xPos, HotspotY:yPos, Width, Height, Encoding:raw_bgra, Payload:xor}`.
- `goOnPointerSetNull` → `{encoding:system, hidden:true}`; `goOnPointerSetDefault`
  → `{encoding:system, system_kind:"default"}`.
- Wire: `binary_frame.go` packs `raw_bgra` cursors as Kind=3/Encoding=1 with
  hotspot in the X/Y header fields. Browser `desktop-cursor-map.ts:rawBgraCursorCss`
  swaps B↔R into RGBA, renders to a canvas, emits `url(data:png) hotX hotY`.

### Clipboard (cliprdr text round-trip)

- channels.go drives MS-RDPECLIP: MonitorReady → caps + empty format list;
  ServerFormatList → respond OK, request CF_UNICODETEXT; ServerFormatDataResponse
  → emit `Clipboard{utf-16le, body}` to browser; ServerFormatDataRequest →
  respond with staged `pendingClipText`. Browser→server uses `pushClipboard*`
  which stages UTF-16LE and pushes a CF_UNICODETEXT format list.

## Data formats consumed / produced

- Consumes `desktop.ClientMessage` (Key/Mouse/Clipboard/Resize/Refresh).
- Produces `desktop.ServerMessage{Cursor|Clipboard}`.
- Mouse button mask Left/Middle/Right = 1<<0/1<<1/1<<2 (types.go:252) and matches
  `input.ts` MOUSE_BUTTON_*. Cursor hotspot maps to header X/Y, dims to W/H — wire
  contract is consistent Go↔TS.

## Bugs / gaps

### CRITICAL — Cursor pixels are forwarded RAW (undecoded), not BGRA
`cgo_wrappers.go:295` sets `pt->New = wPointerNew`, and `goOnPointerNew`
(cgo_exports.go:534) is a no-op returning TRUE. In FreeRDP 3.x the default GDI
`Pointer_Prototype->New` (`gdi_Pointer_New`) is what calls
`freerdp_image_copy_from_pointer_data()` to decode the wire XOR/AND masks into a
normalized BGRA32 buffer **and apply the AND transparency mask**. By replacing
`New` with a no-op, no decode happens. `goOnPointerSet` (cgo_exports.go:556-570)
then reads `pointer.xorMaskData` (raw wire XOR mask in `pointer.xorBpp` depth)
and labels it `raw_bgra`. `xorBpp`, `andMaskData`, `lengthAndMask` and
`freerdp_image_copy_from_pointer_data` are referenced **nowhere** in the worker.
Effect: works only for hosts that happen to send 32bpp color pointers; for
24/16/1-bpp (monochrome / classic) cursors the bytes are the wrong width/format →
garbled cursor; the AND mask is never applied → transparent cursor regions render
opaque (black box around the arrow). This is a 绘制 correctness defect; doc.go:11
("enabled after cursor protocol fix") overstates it.

### HIGH — Letter/digit keyboard shortcuts (Ctrl+C, Alt+F4, etc.) don't work
input.ts sends printable characters (letters, digits, punctuation) as their
ASCII codepoint (input.ts:117-120); the worker routes anything 0x20–0x7E to
`wSendUnicode` (input.go:62-63). RDP Unicode keyboard events (KBDFLAGS_UNICODE)
inject the literal character and **bypass modifier/scancode state**, so when
Ctrl/Alt is held the letter still arrives as a plain Unicode char. Result:
Ctrl+C / Ctrl+V / Ctrl+A / Alt+F / Win+R style shortcuts that involve a letter or
digit do not produce the combo on the server (the modifier scancode is sent, but
the letter is Unicode and isn't combined). Only shortcuts made of mapped
non-printable keys (e.g. Alt+Tab, Ctrl+arrows) work. This degrades 转发
completeness and core usability. Fix: track modifier state (Ctrl/Alt/Win/Shift
down) on the worker (or send a `modifiers` flag from the browser) and route
printable keys through `wSendScancode` using a keysym→scancode map for the
en-US base layer whenever any non-Shift modifier is active.

### MEDIUM — No cursor capability settings negotiated (ColorPointer / pointer cache / large pointer)
applySettings never sets `FreeRDP_ColorPointerFlag`, `FreeRDP_PointerCacheSize`,
or `FreeRDP_LargePointerFlag` (grep finds none). FreeRDP defaults usually advertise
color pointers, but with no explicit pointer-cache size some servers fall back to
monochrome system pointers or omit color-pointer PDUs, compounding the CRITICAL
decode issue. Recommend explicitly enabling color pointer + a sane cache size +
large-pointer support so modern 96x96/large cursors are delivered.

### MEDIUM — `wPointerSetPosition` is a no-op, so server-driven cursor warps are lost
`cgo_wrappers.go:120` `wPointerSetPosition` ignores x/y and returns TRUE, and no
`CursorUpdate`/position message is emitted. When the server moves the pointer
itself (mouse-lock games, RDP "snap cursor", installers that recenter the
pointer), the browser never learns the new position; the local CSS cursor and the
server pointer diverge. The wire/`CursorUpdate` type also has no position-only
message, so this can't currently be surfaced. Edge/degraded for typical desktop
use; affects 绘制 for pointer-warping apps.

### LOW — Stuck modifiers across reconnect / focus loss
On the fallback/reconnect paths (`trySetupFallback*`, `tryAutoReconnect`,
`tryFirstFrameStall*`) the worker re-sends FocusIn but never re-syncs key state.
If a modifier was physically down during a drop, or a keyup is lost while the WS
hiccups, the server can keep a modifier latched. `prevButtons` (mouse) is also
not reset across reconnect, so a button that was down at drop time stays "down"
in the diff logic. Low because reconnect is uncommon and FocusIn often clears it,
but a key/button-state reset on (re)activation would harden it.

### LOW — Wheel deltas are clamped to ±1 tick; no horizontal wheel
input.ts:64 collapses any `deltaY` to `wheel: deltaY>0?-1:1`, discarding
magnitude (fast scroll = one tick) and ignoring `deltaX` (no horizontal wheel /
`PTR_FLAGS_HWHEEL`). Minor scrolling-fidelity gap.

### INFO — Pause/Break key unsupported; high-plane Unicode (emoji/SMP) dropped
keysym.go:66 explicitly returns not-ok for Pause (0xFF13). input.go:64-68 only
forwards BMP via `wSendUnicode(UINT16)`; emoji / SMP codepoints are silently
dropped. Both are documented as deferred; not user-blocking.

### INFO — Extra Shift scancode accompanies Unicode capitals
Typing a capital sends Shift-down (scancode 0x2A) plus the uppercase Unicode
codepoint. The Unicode event already yields the capital, so the extra Shift is
redundant; harmless for most apps but can confuse modifier-sensitive software.
Resolved naturally if the HIGH fix moves printable keys to scancodes.

## Things verified correct (no action)

- Mouse button mask Left/Middle/Right ↔ PTR_FLAGS_BUTTON1/3/2 and the DOM
  `e.button` 0/1/2 mapping are correct (input.go:81-101, input.ts:40-45).
- Clipboard UTF-16LE round-trip is correct and not double-encoded: browser sends
  utf-16le → `pushClipboardUTF16LE` (input.go:117); worker emits utf-16le →
  `TextDecoder("utf-16le")` trimmed at NUL (frame-client/desktop-display:401-407).
  NUL-termination handled by `utf16leEncode`/`ensureUTF16LENULTerminated`.
- Cursor BGRA→RGBA swap on the browser side is correct (desktop-cursor-map.ts:106-111).
- Hotspot is carried in header X/Y and applied as the CSS hotspot (correct).
- Non-printable keysym values match exactly between input.ts and keysym.go
  (Backspace/Tab/Enter/Esc/arrows/F1-F12/modifiers).
- Wheel rotation encoding (`*120`, low-byte magnitude, NEGATIVE flag) matches
  MS-RDPBCGR fast-path wheel semantics.
