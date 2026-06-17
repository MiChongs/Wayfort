# RDP Investigation — Forwarding / Dialing / Proxy-Chain + Session Orchestration

Branch: `claude/ssh-bastion-gateway-2GCU5`. Layer: how the freerdp/ironrdp desktop
session reaches the target, and whether it traverses Wayfort's proxy chain like
every other protocol does.

## How the layer works

### Control plane (browser → gateway)
- `POST /api/v1/desktop/sessions` → `desktop.ControlHandler.Start`
  (`internal/desktop/control_handler.go:23`) → `Manager.StartSession`
  (`internal/desktop/manager.go:141`).
- StartSession gates: backend readiness (`workerReady`/ironrdp gateway ready),
  `maxLive` cap, **asset authorization** (`m.asset.Check`, line 170), **approval**
  (`m.approval.CheckEnforced` with `ApprovalBizAssetAccess`, line 183), node lookup +
  `Disabled` check, credential lookup, and a hard requirement that the credential be
  `CredentialPassword` (line 211). Password is decrypted via `m.sealer.Open`.
- Gating is correct and matches guacamole/webssh/dbcli (same approval biz type +
  action "connect").

### freerdp path (manager.go:287-329)
- `pickWorker("freerdp")` (line 332) builds a `FreeRDPWorker` pointed at the resolved
  worker binary path.
- `StartParams` (`internal/desktop/types.go:270`) is filled with **`Host` + `Port`
  taken verbatim from `node.Host`/`node.Port`** (manager.go:296-297). There is **no
  proxy chain, no SOCKS host/port, no dialer** in `StartParams`.
- `FreeRDPWorker.Start` (`internal/desktop/worker_freerdp.go:65`) spawns the worker
  subprocess and sends `StartParams` as the first framed JSON message. The worker does
  not inherit or receive any proxy configuration.
- Inside the worker, `client.applySettings`
  (`cmd/freerdp-worker/rdp/client.go:304`) sets `FreeRDP_ServerHostname` (line 318) and
  `FreeRDP_ServerPort` (line 321) directly from `params.Host`/`params.Port`.
  libfreerdp then opens a **direct TCP socket to the target**. No
  `FreeRDP_ProxyType`/`FreeRDP_ProxyHostname`/`FreeRDP_GatewayHostname` is ever set
  (grep across the repo: zero hits).

### ironrdp path (manager.go:252-285)
- `dst := node.Host:node.Port` (line 253). A short-lived RS256 JWT is minted with
  `jet_cm="fwd"`, `jet_ap="rdp"`, `dst_hst=dst` (`jwt_signer.go:78`). The browser opens
  a WebSocket to the Devolutions Gateway subprocess and presents the token; the gateway
  **byte-proxies TCP to `dst` itself** (`gateway_proc.go` supervises the subprocess;
  the gateway dials the target). Again **no Wayfort proxy chain** is consulted —
  `dst` is the raw node address.

### Compare: how every other protocol forwards (the bastion model)
- guacamole (`internal/protocols/guacamole/gateway.go:162-186`): resolves
  `node.ProxyChain` via `h.GW.ResolveHops`, builds a `ContextDialer` via
  `h.GW.BuildChain`, starts a **per-session SOCKS5 listener**
  (`socks_local.go`) bound to 127.0.0.1 backed by that dialer, then tells guacd to dial
  through it via `socks-proxy-host/port` params (`bridge.go:287-297`). Every CONNECT the
  listener receives is translated into `dialer.DialContext` — i.e. it traverses the
  full bastion/SOCKS5 hop chain.
- tcpfwd (`internal/protocols/tcpfwd/forwarder.go:160-196`): the listener's
  `handle` dials `f.Dialer.DialContext(ctx, "tcp", f.Target)` where `Dialer` is the
  proxy chain built from `node.ProxyChain` (`ws_relay.go:68`, `forwarder.go`).
- webssh / telnet / sftp / sshrun / dbquery / insights / AI all call
  `ResolveHops(node.ProxyChain)` + `BuildChain` (grep confirms).
- The chain infrastructure (`internal/dialer/chain.go`) supports direct/SOCKS5/bastion
  hops, validation, and produces a `proxy.ContextDialer` — exactly what guacd's RDP is
  tunnelled through today.

## Data/format consumed & produced by this layer
- Consumes: `StartSessionRequest{NodeID,Width,Height,Keyboard,Quality,Backend,
  ClientCaps}` (types.go:33). Produces `StartSessionResponse` — freerdp returns just
  `{SessionID, RemoteWidth, RemoteHeight, Backend}`; ironrdp additionally returns
  `{GatewayURL, Token, Destination, Username, Password, Domain}` (types.go:55).
- Worker stdio contract: 4-byte length-prefixed frames; start frame
  `{"type":"start","p":StartParams}`. `StartParams{Host,Port,Username,Password,Domain,
  Width,Height,Keyboard,Quality,RDP}` (types.go:270) — note: **no transport/proxy field
  exists in this struct**, so even if the manager wanted to forward a chain it has no
  wire field to carry it.

## Findings

### F1 (high) — freerdp worker bypasses the Wayfort proxy chain entirely
The desktop freerdp path dials the target **directly** (`client.go:318/321`), unlike
every other protocol which routes through `node.ProxyChain`. A node only reachable
through a bastion/SOCKS5 hop (the entire reason proxy chains exist) **cannot be reached
via WebRDP**, while the same node works over guacamole-RDP, SSH, tcpfwd, etc. This is a
real "完整支持RDP转发" gap, not a style nit.

Root cause is structural and three-layered:
1. `desktop.NewManager` (`cmd/wayfort/main.go:574`) is built with
   `Deps{Logger,Nodes,Creds,Asset,Sealer,Audit,Sessions}` — **no `Proxies` repo and no
   `*dialer.ChainBuilder`**. Compare guacamole's handler which receives the whole
   `*webssh.Gateway` (with `Chain()`/`ProxyRepo()`/`ResolveHops`/`BuildChain`), and the
   AI/firewall/docker managers which get `Chain: chain, Proxies: proxyRepo`. The desktop
   manager is structurally unable to build a chain.
2. `StartParams` (types.go:270) has no field to carry a SOCKS endpoint / dialer to the
   worker subprocess.
3. `client.applySettings` never sets FreeRDP's proxy settings.

Proposed fix (mirror the guacamole pattern, since the worker is a subprocess like
guacd):
- Add `Proxies *repo.ProxyRepo` and `Chain *dialer.ChainBuilder` to `desktop.Deps`
  and wire them from main.go (pass the existing `chain` + `proxyRepo`).
- In `StartSession` freerdp branch, resolve `node.ProxyChain` → hops → `ContextDialer`
  (reuse `dialer.ChainBuilder.Build`). If the chain is non-empty, start a per-session
  SOCKS5 listener (the existing `guacamole.Listener` in `socks_local.go` is generic —
  factor it into a shared package or instantiate it) bound to 127.0.0.1, backed by that
  dialer, targeting `node.Host:node.Port`.
- Add `SOCKSHost string` + `SOCKSPort int` to `StartParams`; pass the listener's
  127.0.0.1:port.
- In `client.applySettings`, when SOCKS is present set
  `FreeRDP_ProxyType = PROXY_TYPE_SOCKS`, `FreeRDP_ProxyHostname`, `FreeRDP_ProxyPort`
  (libfreerdp 3.x supports a built-in SOCKS5 proxy for the transport). libfreerdp then
  CONNECTs through our listener, which tunnels through the bastion chain.
- Tie the listener's lifetime to the session (close in `Manager.End`/session cleanup);
  attach `release()` from `BuildChain` to the session so bastion refcounts decrement.

### F2 (high) — ironrdp path also bypasses the proxy chain
`manager.go:253` builds `dst` as the raw `node.Host:node.Port` and the Devolutions
Gateway subprocess opens the backend TCP connection itself. There is no hook to route
that backend dial through Wayfort's bastion chain, so ironrdp has the same
direct-dial limitation as freerdp. Unlike freerdp, this is **not fixable with a local
SOCKS listener** unless Devolutions Gateway is told to use a SOCKS proxy for its `fwd`
connections (the generated config in `gateway_config.go` sets no proxy). If
"完整支持RDP转发" must include ironrdp through bastions, this needs either a gateway-side
proxy setting or routing the gateway's outbound through a SOCKS listener. At minimum
document that ironrdp is direct-dial-only.

### F3 (medium) — no field on the wire to carry proxy/transport config to the worker
Even after F1's manager-side wiring, `StartParams` (types.go:270) has no proxy field, so
the worker can't be told where the SOCKS listener is. The fix in F1 must extend this
struct (and the worker decode in `cmd/freerdp-worker/main.go:76`). Flagged separately
because it is the wire-contract change that gates F1.

### F4 (low / info) — docs stale: RDPGFX/H264 marked "Disabled" but enabled by default
`docs/rdp-backend-capabilities.md:10` lists "Graphics pipeline (RDPGFX) — Disabled" and
line 14 states graphics caps "must remain forced off in
cmd/freerdp-worker/rdp/client.go". The code now **enables them by default**:
`applySettings` sets `FreeRDP_SupportGraphicsPipeline`/`FreeRDP_GfxH264` true unless the
node opts out or the browser lacks WebCodecs (`client.go:522-536`). The doc is stale and
contradicts the code; update it (and there is no "proxy chain forwarding" row at all —
add one reflecting the F1/F2 gap).

## Things checked and found OK (not bugs)
- Auth/asset/approval gating on the desktop path is correct and consistent with the
  other protocols (manager.go:170-197).
- Credential handling: requires `CredentialPassword`, decrypts via sealer; same as
  guacamole's `DecodeCredential`. Reasonable V1 limitation.
- Fallback logic cannot infinite-loop: clipboard / safe-graphics / gfx-compat retries
  are all one-shot guarded flags (`clipboardFallbackTried`, `safeGraphicsFallbackTried`,
  `gfxCompatFallbackTried` — client.go:802/874/965/1022); auto-reconnect is bounded to
  `maxReconnectBurst=3` within a 10s window (`claimReconnectAttempt`, client.go:1119) and
  only fires after the first frame; NLA auto-retry fires at most once
  (`connectWithAutoNlaRetry`, client.go:1149). Each rebuild fully tears down the prior
  instance (`tearDownInstanceQuietly`) so there's no FD/handle leak across retries.
- Devolutions Gateway supervisor restart policy is bounded (backoff to 30s,
  gateway_proc.go:284) — no retry storm.
