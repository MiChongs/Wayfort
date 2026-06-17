# Codebase Concerns

Repository snapshot: Go/Gin backend under `internal/`, Next.js frontend under `web/`. Findings below are based only on inspected files; unknowns are marked explicitly.

## Security Risks

- High: Multiple operational endpoints appear to rely on `ops := authed.Group("")` plus `auth.RejectAnonymous()` in `internal/server/routes.go:246-392`, but several handlers do not enforce `asset.Resolver.Check` for the requested node. This is an IDOR/RBAC risk for any authenticated non-anonymous user who can guess `node_id`.
- High: WebSocket upgrades allow all origins via `webssh.AcceptWS` with `OriginPatterns: []string{"*"}` in `internal/webssh/exposed.go:19-28`. Because tokens are accepted through query strings and `Sec-WebSocket-Protocol`, this needs CSRF/cross-origin review for browser-based attacks.
- Medium: Frontend stores access and refresh tokens in `localStorage` (`web/src/lib/auth/tokens.ts:1-35`), increasing impact of XSS. Backend also accepts `?token=` (`internal/auth/middleware.go:120-128`), and frontend deliberately appends tokens to URLs for downloads (`web/src/lib/api/client.ts:89-99`). Tokens may leak via logs, browser history, referers, or copied links.
- Medium: Next proxy forwards most client headers to backend and appends forwarded IP/host headers (`web/src/app/api/proxy/[...path]/route.ts:40-56`). Trust boundaries for `X-Forwarded-*` need verification, especially because backend uses `c.ClientIP()` in audit paths.
- Medium: RDP/Guacamole defaults to `IgnoreCert: true` unless overridden (`internal/protocols/guacamole/gateway.go:219-241`). Pragmatic for self-signed hosts, but it permits MITM on RDP/VNC transport where applicable.

## Auth And RBAC Bypass Risks

- High: SSH WebSocket loads any node by ID and only blocks anonymous/disabled nodes plus approval when configured; no asset grant check is visible in `internal/webssh/gateway.go:105-151` before credential lookup/dial in `internal/webssh/gateway.go:201-229`.
- High: SFTP handlers call `Connector.Open(nodeID)` without user/action context; `internal/sftp/client.go:28-72` loads node credentials and connects without asset checks. Handler approval gates in `internal/sftp/handler.go` are not equivalent to grants and some read endpoints (`List`, `Stat`, `ReadText`) have no approval check.
- High: DB browser endpoints call `DBHandler.gate` which only validates service, claims, and node ID (`internal/api/db_handler.go:35-50`). `dbquery.Service.build` then loads node credentials by ID (`internal/dbquery/service.go:305-345`) without visible asset grant checks. This affects schema, rows, export, query, exec, row edits, process list, and kill routes registered in `internal/server/routes.go:362-383`.
- High: DB CLI and Guacamole handlers enforce approval when configured but do not visibly check asset grants before credential decode/session start (`internal/protocols/dbcli/gateway.go:30-90`, `internal/protocols/guacamole/gateway.go:51-117`).
- Medium: Port forward creation requires `portforward:manage` at route level (`internal/server/routes.go:388-391`) and approval if configured, but `internal/protocols/tcpfwd/handler.go:31-80` does not visibly check asset grants for the target node.
- Positive contrast: Desktop v2 does enforce `m.asset.Check(..., asset.ActionConnect)` before starting sessions (`internal/desktop/manager.go:169-178`). Insights, firewall, and docker managers also show asset checks (`internal/insights/manager.go:120-147`, `internal/docker/manager.go:272-296`, `internal/firewall/manager.go` referenced by `internal/api/firewall_handler.go:38-76`). Use these as patterns.

## Secret And Config Risks

- Config can provide sensitive values through YAML or `WAYFORT_` env overrides (`internal/config/config.go:366-395`), including `auth.jwt_secret`, DB DSN, Redis password, SMTP password, KMS archive keys, and legacy `crypto.master_key_hex` (`internal/config/config.go:238-324`). Secret storage policy and deployment examples need verification.
- JWT signing uses HS256 with a minimum secret length of 16 bytes (`internal/auth/jwt.go:111-123`, `internal/config/config.go:523-526`). Consider stronger entropy requirements and rotation guidance.
- KMS/envelope encryption design exists (`internal/secrets/service.go:1-33`), but plaintext credentials are still converted to strings for DB/RDP/DBCLI use (`internal/dbquery/service.go:341-349`, `internal/desktop/manager.go:238-270`, `internal/protocols/dbcli/gateway.go:141-156`). Memory lifetime after string conversion is not wiped. Needs verification for threat model.
- Devolutions Gateway mints short-lived RDP JWTs and returns gateway token plus destination, username, and password to the browser for `ironrdp` (`internal/desktop/manager.go:238-270`). This may be intended, but it exposes target credentials client-side.

## Database Query Risks

- Read-only SQL classification is prefix-based and explicitly accepts `WITH` as read-only even though comments note writes inside CTEs are possible (`internal/api/db_handler.go:785-824`). This can bypass `/db/exec` approval for databases that allow writable CTEs or side-effect functions.
- `Exec` only uses approval enforcement if `h.Approval != nil` (`internal/api/db_handler.go:626-651`). If approval is disabled or not wired, authenticated users may execute writes on any reachable DB node unless separate asset checks are added.
- DB export streams whole table contents by default with optional `limit` (`internal/api/db_handler.go:401-459`). Route uses token-query download flow from frontend (`web/src/components/db/browse-tab.tsx:34-37` seen via grep), creating both data-exfiltration and token-leak risk.
- Row browse validates `order_by` against loaded columns before quoting (`internal/api/db_handler.go:702-747`) and row edits quote identifiers/parameterize values (`internal/dbquery/crud.go:161-230`), which is good. Schema/table names still rely on remote metadata calls succeeding and should be reviewed per dialect.

## Route Exposure

- Public unauthenticated routes include login, refresh, anonymous token issuance, providers, and OIDC login/callback (`internal/server/routes.go:124-137`). Anonymous SSH is mounted separately with normal middleware but allows anonymous tokens (`internal/server/routes.go:428-431`).
- `/healthz` and `/` are public (`internal/server/http.go:25-40`). Root discloses service, version, commit, and route hints.
- Next.js proxy exposes all HTTP methods for arbitrary `/api/proxy/...` backend paths (`web/src/app/api/proxy/[...path]/route.ts:59-85`). Backend auth remains primary control; proxy path allowlisting is absent.
- Admin/API route comments sometimes state row-level filtering inside handlers, especially approvals (`internal/server/routes.go:315-347`). Needs handler-specific verification before relying on comments.

## WebSocket, Proxy, And Tunnel Concerns

- WebSockets are direct to backend according to frontend comments (`web/src/app/api/proxy/[...path]/route.ts:6-8`), so reverse proxy/TLS/CORS policy must be configured outside Next.
- TCP forwarding defaults enabled on loopback ports 40000-49999 with max 8 per user (`internal/config/config.go:514-518`). Authorization currently appears permission-based plus approval, not asset-grant-based (`internal/protocols/tcpfwd/handler.go:31-80`).
- Guacamole creates per-session SOCKS listeners for node access (`internal/protocols/guacamole/gateway.go:162-186`). Default bind host is `127.0.0.1`, but config permits `socks_listen_host` (`internal/config/config.go:189-197`); non-loopback values should be treated as sensitive.
- Desktop WS binds session ownership on `Take(sessionID)` and `sess.UserID == claims.UserID` (`internal/desktop/ws_handler.go:44-57`), which is good. Need verification that `Take` prevents reuse/races and that abandoned sessions are cleaned up.

## Operational Risks

- HTTP server sets `WriteTimeout: 0` to preserve WS long polls (`internal/server/http.go:86-93`). This is operationally necessary for long-lived sockets but increases exposure to slow clients unless front proxy limits are configured.
- Audit writer channels are bounded; DB SQL audit truncates at 2048 bytes (`internal/api/db_handler.go:750-775`). Unknown whether audit backpressure drops events or blocks critical paths.
- DB query pools are per `(nodeID,userID,database)` with 10-minute idle eviction and max 4 open conns (`internal/dbquery/service.go:252-293`, `internal/dbquery/service.go:427-459`). There is no visible global cap across databases/users beyond map growth and eviction.
- Anonymous containers default to `alpine:latest`, network `none`, 10-minute TTL, and resource limits (`internal/config/config.go:338-347`, `internal/config/config.go:442-448`). Sandbox implementation needs separate verification.

## Immediate Follow-ups

- Add a central node-access gate and apply it before credential lookup/dial for SSH, Telnet, SFTP, DB browser, DBCLI, Guacamole, and TCP forwarding. Prefer the existing `asset.Resolver.Check` pattern used by desktop/insights/docker/firewall.
- Replace or harden prefix-based SQL read-only detection. At minimum, reject writable CTEs, multi-statements, `SELECT` side-effect functions where possible, and require approval for `EXPLAIN ANALYZE`.
- Stop accepting long-lived access tokens in query strings where possible; use short-lived single-use download tickets or cookie-based delivery with CSRF controls.
- Restrict WebSocket origins and document required reverse-proxy/TLS settings for direct WS endpoints.
- Review secrets in browser flows, especially `ironrdp` returning the target password, and decide whether this is acceptable for the product threat model.
- Verify approval handler row-level filtering, audit durability/drop behavior, and anonymous container cleanup in their implementation files.
