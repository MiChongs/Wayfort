# Architecture

Evidence is from the repository as of this workspace snapshot. If a runtime behavior is not visible in code/config, it is marked Unknown or Needs verification.

## High-Level Shape

- Backend is a Go service using Gin, GORM, Redis, zap logging, and an `errgroup` runtime. Main wiring is in `cmd/wayfort/main.go`; HTTP engine and route registration are in `internal/server/http.go` and `internal/server/routes.go`.
- Frontend is a Next.js 16 / React 19 app under `web/`, with App Router routes in `web/src/app`, shadcn/Radix-style UI components in `web/src/components`, and API/WS clients in `web/src/lib`.
- The frontend uses a Next.js API reverse proxy for REST/SSE at `web/src/app/api/proxy/[...path]/route.ts`. WebSockets are not proxied by Next; browser WS clients connect directly to the Go backend using `NEXT_PUBLIC_BACKEND_WS_URL`.
- The backend is a multi-protocol bastion gateway for SSH, Telnet, SFTP, RDP/VNC, DB CLI, structured DB browsing, TCP port forwarding, firewall/docker panels, approvals, AI assistant, and anonymous sandbox sessions.

## Request Flow

- Browser REST calls use `web/src/lib/api/client.ts`, defaulting to `NEXT_PUBLIC_API_BASE || /api/proxy/api/v1`.
- Next.js proxy `/api/proxy/:path*` forwards to `BACKEND_HTTP_URL || http://127.0.0.1:8080`, strips hop-by-hop headers, forwards request body, preserves response body, and sets forwarding headers in `web/src/app/api/proxy/[...path]/route.ts`.
- Backend routes are mounted under `/api/v1` by `internal/server/routes.go`; health/root endpoints are mounted directly in `internal/server/http.go` as `/healthz` and `/`.
- WebSSH/Telnet/DB CLI clients use `web/src/lib/ws/webssh-client.ts` and connect to `${NEXT_PUBLIC_BACKEND_WS_URL}/api/v1/ws/...` with token query params and `webssh.v1` subprotocol.
- Guacamole RDP/VNC client code is in `web/src/lib/ws/guacamole-client.ts`; it injects `/vendor/guacamole-common.min.js` and connects to backend `/api/v1/ws/rdp/:node_id` or `/api/v1/ws/vnc/:node_id` when enabled.
- Newer desktop/RDP flow is exposed by REST `/api/v1/desktop/sessions` and WS `/api/v1/ws/v2/desktop/:session_id` in `internal/server/routes.go`; frontend desktop code lives under `web/src/lib/desktop` and `web/src/components/desktop`.

## Backend Runtime Components

- Startup flow in `cmd/wayfort/main.go` loads config, opens PostgreSQL, auto-migrates models, bootstraps secrets/KMS, Redis, repositories, auth providers, MFA/passkey/OIDC helpers, SSH pool/dialer chain, audit writer, anonymous Docker service, protocol handlers, approval service, insights, desktop manager, firewall/docker managers, AI subsystem, and Gin routes.
- Long-running goroutines are started via `errgroup` in `cmd/wayfort/main.go`: audit writer, SSH pool watchdog/runtime, anonymous janitor, TCP port-forward manager, mailer worker, AI janitor, HTTP server, approval reconciler, desktop worker bootstrap, and optional Devolutions Gateway ensure loop.
- HTTP server shutdown is context-driven with `http.Server.Shutdown` in `internal/server/http.go`; `WriteTimeout` is set to `0` to avoid killing long-lived WS traffic.
- `cmd/freerdp-worker/` is a separate worker executable for FreeRDP-backed desktop sessions; `freerdp-worker.exe` and `bin/freerdp-worker` are present in the workspace.

## Persistence And State

- Primary relational store is PostgreSQL via GORM. `internal/repo/db.go` uses `gorm.io/driver/postgres`; `configs/config.example.yaml` shows a PostgreSQL DSN.
- `internal/repo/db.go` auto-migrates users, credentials, proxies, nodes, sessions, audit logs, port forwards, org/RBAC tables, asset groups/tags/grants, MFA/passkeys/OIDC, AI tables, KMS/secret envelope tables, and approval tables.
- Redis is used by `internal/cache/redis.go` for active WebSSH session sets, anonymous container TTL keys, port-forward TTL keys, and as a dependency for auth/RBAC/cache-oriented services in `cmd/wayfort/main.go`.
- Session recordings are stored on disk under `storage.sessions_dir`, defaulting to `./var/sessions` in `configs/config.example.yaml`; current workspace contains `.cast` files under `var/sessions/...`.
- Secret storage uses envelope encryption bootstrapped in `cmd/wayfort/main.go` through `internal/secrets` and KMS provider rows; legacy fixed AES-GCM key fallback exists only when `crypto.master_key_hex` is configured.
- Approval ledger may optionally archive to S3-compatible storage with Object Lock settings via `approval.archive` config in `internal/config/config.go` and `internal/approval/archiver_s3.go`.

## API And Routing Shape

- Public/auth routes include `/api/v1/auth/login`, MFA login variants, passkey login, refresh, anonymous token issuance, provider listing, and OIDC login/callback in `internal/server/routes.go`.
- Authenticated self-service routes live under `/api/v1/me` for profile, password, MFA, passkeys, favorites, recent nodes, login history, and visible nodes.
- Admin/resource routes include users, roles, permissions, departments, groups, nodes, proxies, credentials, asset groups, tags, grants, OIDC clients, and KMS setup.
- Operational routes include sessions/recordings, SFTP file operations, node insights, firewall/docker controls, desktop sessions/stats/bootstrap, approvals, WebSSH/Telnet/RDP/VNC/DBCLI/TCP WebSockets, structured DB browser endpoints, and port forwards.
- AI routes live under `/api/v1/ai` when `rt.AI.Enabled` is true: providers, agents, tools, conversations, SSE message/stream, and tool invocation approve/reject endpoints.
- Route registration uses explicit handler structs collected in `server.Routes`; several optional subsystems use 503 stubs instead of missing routes, documented in `internal/server/routes.go`.

## Auth And Authorization Boundaries

- JWT parsing and middleware live in `internal/auth/middleware.go`. Tokens are accepted from `Authorization: Bearer`, `?token=`, or `Sec-WebSocket-Protocol` entries prefixed with `bearer.`.
- Token revocation is checked with Redis-backed `auth.Blocklist` when wired. Non-active auth-step tokens are rejected unless middleware is configured to allow challenges.
- Permission checks use `auth.RequirePermission` with `auth.Resolver`, which aggregates role permissions and caches them in-process plus Redis in `internal/auth/rbac.go`.
- `auth.RejectAnonymous()` blocks anonymous tokens from operational routes while `/api/v1/ws/ssh/anonymous` is mounted separately and allows anonymous authenticated tokens.
- Asset-level access is separate from global RBAC. `cmd/wayfort/main.go` wires `asset.NewResolver(...)` into `MeHandler`, SFTP/insights/firewall/docker/desktop/AI-related dependencies, and handlers that need node visibility checks.
- Approval is a cross-cutting enforcement seam. `cmd/wayfort/main.go` wires `approvalSvc` into WebSSH, SFTP, Guacamole, DBCLI, structured DB, TCP forwarding, desktop, and secret decrypt gating for credential use.
- Frontend auth guard is client-side in `web/src/app/(app)/layout.tsx`, using localStorage-backed token helpers in `web/src/lib/auth/tokens.ts`. This is not a backend security boundary.

## Frontend Architecture

- Root layout `web/src/app/layout.tsx` mounts global providers from `web/src/components/providers.tsx`: i18n side effect, React Query, next-themes, tooltip provider, toaster, confirm dialog host, and React Query devtools.
- Route groups separate shells: `(auth)` for login/MFA/OIDC, `(app)` for authenticated dashboard/admin/resources/sessions/nodes/AI, and `(workspace)` for workspace UI.
- Shared typed service wrappers are centralized in `web/src/lib/api/services.ts`; type definitions are in `web/src/lib/api/types.ts`.
- Terminal UI and protocol clients are split between `web/src/components/terminal`, `web/src/lib/terminal`, and `web/src/lib/ws/webssh-client.ts`.
- RDP/VNC paths are split between legacy Guacamole components/code (`web/src/components/guacamole`, `web/src/lib/ws/guacamole-client.ts`) and newer desktop/ironrdp code (`web/src/components/desktop`, `web/src/lib/desktop`, `web/src/components/rdp`, `web/src/lib/rdp`).
- i18n configuration and locale files are in `web/src/i18n/config.ts`, `web/src/i18n/locales/en.json`, and `web/src/i18n/locales/zh.json`.

## Major Seams For Future Work

- Backend route seam: add HTTP/WS surfaces through `server.Routes` in `internal/server/routes.go`, then wire concrete handlers in `cmd/wayfort/main.go`.
- Persistence seam: new durable entities should be added to `internal/model`, repository methods under `internal/repo`, and `repo.AutoMigrate` in `internal/repo/db.go`.
- Secret/credential seam: user-initiated credential decrypts should go through the `secretsBoot.Service.SetDecryptGate` path in `cmd/wayfort/main.go`; avoid bypassing the KMS/envelope vaults.
- Protocol seam: SSH/Telnet core uses `internal/webssh`; optional protocols are under `internal/protocols`; desktop/RDP v2 is under `internal/desktop` plus `cmd/freerdp-worker`.
- Frontend REST seam: add typed wrappers in `web/src/lib/api/services.ts` and consume via React Query from route/page components.
- Frontend WS seam: add or extend clients under `web/src/lib/ws` or `web/src/lib/desktop`; do not expect Next.js route handlers to proxy WS upgrades.
- Approval seam: high-risk operations should call the approval service or existing handler-level approval gates; exact policy semantics need verification in `internal/approval` for each business type.

## Unknowns / Needs Verification

- Production deployment topology is not fully determined from code alone. `deployments/docker-compose.yaml`, `deployments/Dockerfile`, `web/Dockerfile`, and config files exist, but actual deployed reverse proxy/TLS/process supervision are Unknown.
- Whether the checked-in binaries (`wayfort.exe`, `freerdp-worker.exe`, `bin/freerdp-worker`) match current source is Unknown.
- Exact frontend route coverage versus backend route coverage needs verification with a running app; code indicates many screens, but runtime feature flags may disable subsystems.
