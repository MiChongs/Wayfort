# Structure

This map is evidence-based from the current repository tree. Paths marked Unknown or Needs verification indicate intent not fully proven by code inspection alone.

## Top-Level Directories And Files

- `cmd/` contains Go executables: `cmd/wayfort/main.go` for the main gateway and `cmd/freerdp-worker/` for the FreeRDP desktop worker.
- `internal/` contains backend application packages. Most business logic and HTTP/WS handlers live here.
- `pkg/` contains shared lower-level Go packages: `pkg/crypto`, `pkg/kms`, and `pkg/log`.
- `web/` contains the Next.js frontend app, package manifests, static/public assets, scripts, and frontend source under `web/src`.
- `configs/` contains `config.example.yaml`, the main documented backend config template.
- `config.yaml` is a local/root config file. Contents were not inspected for this documentation.
- `deployments/` contains deployment artifacts including `Dockerfile`, `docker-compose.yaml`, and a `var/` directory.
- `scripts/` contains operational/install scripts, including scripts referenced by desktop/Devolutions Gateway startup code in `cmd/wayfort/main.go`.
- `proto/desktop/` contains protocol definitions or generated assets for the desktop subsystem. Exact contents need verification.
- `docs/` contains project documentation. Exact contents need verification.
- `var/sessions/` contains runtime session recording artifacts (`.cast` files observed).
- `bin/`, `wayfort.exe`, and `freerdp-worker.exe` are built/runtime binaries. Whether they are current is Unknown.
- `.planning/codebase/` contains these generated implementation-agent notes.

## Backend Entry And Server

- `cmd/wayfort/main.go` is the composition root: config load, DB/Redis setup, repo construction, service wiring, route mounting, background goroutines, and graceful shutdown orchestration.
- `internal/server/http.go` builds the Gin engine, request ID middleware, zap request logging, root JSON response, health check, and `http.Server` lifecycle.
- `internal/server/routes.go` defines `server.Routes`, mounts `/api/v1` resources, auth middleware, permission gates, optional subsystem stubs, and all REST/WS route shapes.

## Backend Config, Persistence, And Cache

- `internal/config/config.go` defines the typed backend config model for server, DB, Redis, auth, crypto, storage, SSH pool, anonymous mode, recorder, audit, protocols, notify, AI, insights, desktop, and approval archive.
- `configs/config.example.yaml` documents concrete config keys and defaults, including PostgreSQL DSN, Redis, JWT, KMS/envelope encryption, sessions directory, protocol toggles, and desktop worker settings.
- `internal/repo/db.go` opens PostgreSQL with GORM and performs `AutoMigrate` for backend models.
- `internal/repo/*.go` contains repository wrappers for users, roles, nodes, credentials, sessions, audit, port forwards, org assets, KMS/secret rows, OIDC, MFA/passkey, and approvals.
- `internal/model/*.go` contains GORM models for core entities such as users, nodes, credentials, proxies, sessions, audit logs, RBAC/org structures, assets/grants, MFA, OIDC, WebAuthn, secrets, and approvals.
- `internal/cache/redis.go` wraps Redis for active sessions, anonymous container tracking, and port-forward tracking; Redis clients are also passed into auth/RBAC/MFA/passkey/AI code from `cmd/wayfort/main.go`.

## Backend Auth, Access, And Security

- `internal/auth/` contains JWT issuing/parsing, Gin middleware, blocklist, local/OIDC providers, password hashing, rate/lockout helpers, permission catalog, and RBAC resolver.
- `internal/mfa/` handles TOTP, email OTP, and recovery codes. It is wired from `cmd/wayfort/main.go`.
- `internal/passkey/` handles WebAuthn/passkey support. It is optional based on config.
- `internal/secrets/` handles KMS-backed envelope encryption bootstrap and vault adapters. It feeds credential/OIDC/MFA/AI secret storage.
- `pkg/crypto/` contains cryptographic vault/sealer primitives used by legacy and envelope-backed secret flows.
- `pkg/kms/` contains KMS provider abstractions used by secret bootstrap and approval ledger signing.
- `internal/approval/` contains approval workflow, policy, enforcement, reconciler, ledger/signing, notification, and optional S3 archiver components.
- `internal/asset/` resolves asset/node visibility and grants; it is wired into self-service node lists and node-scoped subsystems.

## Backend Protocol And Runtime Packages

- `internal/webssh/` contains the WebSocket gateway, protocol frames, SSH backend, Telnet gateway adapter, session handling, and exposed helpers used by other protocol handlers.
- `internal/ssh/` contains SSH credential resolution, host key handling, and connection helpers.
- `internal/sshpool/` manages reusable bastion SSH clients and pool runtime.
- `internal/dialer/` builds proxy/dial chains for direct, SOCKS5, and bastion-style paths.
- `internal/sftp/` exposes REST-style SFTP operations backed by the same node/credential/proxy/dialer stack.
- `internal/protocols/telnet/` contains Telnet backend support.
- `internal/protocols/guacamole/` bridges RDP/VNC through guacd when enabled.
- `internal/protocols/dbcli/` launches database CLI containers for terminal-style DB access when enabled.
- `internal/protocols/tcpfwd/` manages local TCP listeners and WS binary relay for temporary port forwarding.
- `internal/desktop/` contains the newer desktop/RDP subsystem: control handler, WS handler, manager, session state, framed protocol, FreeRDP worker abstraction, dummy worker, Devolutions Gateway config/process/JWT support, and tests.
- `cmd/freerdp-worker/rdp/` contains the worker-side RDP client implementation and cgo/stub files.
- `internal/dbquery/` backs the structured DB browser endpoints for schema, rows, query, exec, explain, process list, and kill operations.
- `internal/anonymous/` launches and cleans up anonymous Docker sandboxes.
- `internal/docker/` and `internal/firewall/` run node-management commands over SSH for workspace panels.
- `internal/insights/` collects node system/process/network telemetry over SSH.
- `internal/sshrun/` provides shared SSH command execution dependencies for node-management packages.

## Backend Product Areas

- `internal/api/` contains Gin HTTP handlers for auth, users, roles, org/group/department, assets, credentials, proxies, nodes, sessions, SFTP-adjacent resources, OIDC clients, KMS setup, approvals, DB browser, firewall, and Docker panels.
- `internal/ai/` contains AI assistant composition plus subpackages `bridge`, `handler`, `model`, `provider`, `repo`, `runner`, and `tools`.
- `internal/audit/` contains asynchronous audit writing and recording support.
- `internal/anomaly/` handles anomalous login detection as wired by `cmd/wayfort/main.go`.
- `internal/notify/` contains SMTP/mail worker support.

## Frontend App Structure

- `web/package.json` defines Next.js scripts (`dev`, `build`, `start`, `typecheck`) and dependencies including React 19, Next 16, TanStack Query, Radix UI, xterm, Guacamole, Devolutions IronRDP, Zustand, i18next, and shadcn-adjacent utilities.
- `web/src/app/layout.tsx` is the root layout and mounts `web/src/components/providers.tsx`.
- `web/src/app/page.tsx` redirects `/` to `/dashboard`.
- `web/src/app/api/proxy/[...path]/route.ts` is the REST/SSE reverse proxy to the Go backend.
- `web/src/app/(auth)/` contains auth shell and routes for login, MFA, and OIDC callback.
- `web/src/app/(app)/` contains authenticated UI routes: dashboard, admin, AI, approvals, me, nodes, port-forwards, and sessions.
- `web/src/app/(workspace)/workspace/` contains the workspace route and shell.
- Important page routes include node SSH/Telnet/SFTP/RDP/VNC/DBCLI/DB/RDP-next screens under `web/src/app/(app)/nodes/[id]/`, session listing/detail, admin users/roles/nodes/proxies/credentials/assets/OIDC/audit/AI pages, approvals, and profile/security pages.

## Frontend Components And Libraries

- `web/src/components/providers.tsx` sets up i18n, React Query, theme provider, tooltips, toaster, confirm dialog, and devtools.
- `web/src/components/ui/` contains reusable UI primitives/components.
- `web/src/components/app-shell/` contains authenticated shell navigation/topbar pieces.
- `web/src/components/auth/`, `admin/`, `ai/`, `common/`, `db/`, `desktop/`, `guacamole/`, `insights/`, `rdp/`, `sftp/`, `terminal/`, and `workspace/` map to product UI areas.
- `web/src/lib/api/client.ts` is the base REST client, token injection layer, error handling layer, upload helper, and token-query URL builder.
- `web/src/lib/api/services.ts` contains typed service wrappers for backend resources.
- `web/src/lib/api/types.ts` contains frontend API types.
- `web/src/lib/auth/tokens.ts` stores access/refresh tokens in localStorage and parses JWT claims for client-side guards.
- `web/src/lib/ws/webssh-client.ts` handles terminal-style WebSocket sessions.
- `web/src/lib/ws/guacamole-client.ts` handles legacy Guacamole RDP/VNC sessions.
- `web/src/lib/desktop/` contains the newer desktop frame/control/render/ironrdp client pieces.
- `web/src/lib/ai/`, `web/src/lib/rdp/`, `web/src/lib/sse/`, `web/src/lib/terminal/`, and `web/src/lib/hooks/` provide feature-specific frontend helpers.
- `web/src/i18n/` contains i18next config and `en`/`zh` locale files.
- `web/public/` contains static assets, including the vendored Guacamole JS referenced by `web/src/lib/ws/guacamole-client.ts` if present. Exact file presence needs verification.

## Generated, Runtime, And Dependency Areas

- `web/node_modules/`, `web/.next/`, `web/tsconfig.tsbuildinfo`, and lockfiles are dependency/build artifacts or package manager state.
- `web/.env` and `web/next-env.d.ts` exist but should not be edited for this task.
- `.omc/`, `web/.omc/`, `.claude/`, `.idea/`, `.git/`, and `.worktrees/` are tooling/editor/VCS state, not application source.

## Common Change Locations

- Add a backend API endpoint: update `internal/server/routes.go`, implement/extend a handler in `internal/api`, wire dependencies in `cmd/wayfort/main.go`, and add models/repos if persistence is needed.
- Add durable backend state: add `internal/model` type, `internal/repo` methods, and `repo.AutoMigrate` entry in `internal/repo/db.go`.
- Add a frontend REST feature: add/extend types and service functions in `web/src/lib/api`, then build UI under the relevant `web/src/app` route and `web/src/components` product folder.
- Add terminal/WebSocket behavior: coordinate backend protocol handling in `internal/webssh` or `internal/protocols/*` with frontend clients in `web/src/lib/ws` and terminal components.
- Add desktop/RDP behavior: check `internal/desktop`, `cmd/freerdp-worker`, `web/src/lib/desktop`, `web/src/components/desktop`, and `web/src/app/(app)/nodes/[id]/rdp-next`.
