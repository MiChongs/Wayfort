# RDP Backend Capabilities

| Capability | Status | Required before enabling |
| --- | --- | --- |
| Classic bitmap display | Enabled | `desktop.v2` binary transport, frame drop metrics |
| Keyboard/mouse input | Enabled | FreeRDP owner-thread dispatch |
| Text clipboard | Enabled | `CF_UNICODETEXT` round trip |
| Dynamic resize (RDPEDISP) | Disabled | DISP channel callback, browser resize ack, reconnect fallback |
| Audio playback (RDPSND) | Disabled | custom rdpsnd device plugin, browser AudioWorklet queue, mute policy |
| Graphics pipeline (RDPGFX) | Disabled | surface lifecycle, AVC/RFX decode, frame ack, codec negotiation |
| Drive redirection (RDPDR) | Disabled | scoped virtual filesystem, audit events, upload/download UI |
| Printers/smartcards | Disabled | explicit security review and operator policy |

Disabled capabilities must remain forced off in `cmd/freerdp-worker/rdp/client.go` until the worker, gateway, browser protocol, UI, audit, and operator policy are implemented end to end.
