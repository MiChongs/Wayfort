# Integrations

Evidence is from the current repository snapshot. Items marked Unknown or Needs verification were not proven by checked files.

## Protocol Access Integrations

- SSH: Node protocol `ssh` is defined in `internal/model/node.go`; SSH session handling lives under `internal/webssh`, `internal/ssh`, and `internal/sshpool` using `golang.org/x/crypto/ssh`.
- Telnet: Node protocol `telnet` is defined in `internal/model/node.go`; Telnet WS routing is mounted in `internal/server/routes.go`, with backend support under `internal/protocols/telnet` and WebSSH gateway adapters.
- SFTP: REST file operations are mounted under `/api/v1/nodes/:id/sftp/...` in `internal/server/routes.go`; implementation lives under `internal/sftp` and uses `github.com/pkg/sftp`.
- RDP/VNC via Guacamole: legacy WS routes `/ws/rdp/:node_id` and `/ws/vnc/:node_id` are mounted when `rt.Guacamole` is wired; backend code is under `internal/protocols/guacamole`, frontend client code under `web/src/lib/ws/guacamole-client.ts`, and compose provides `guacamole/guacd:1.5.5`.
- RDP/desktop v2: REST `/desktop/sessions` and WS `/ws/v2/desktop/:session_id` are mounted in `internal/server/routes.go`; backend code is under `internal/desktop`, worker code under `cmd/freerdp-worker`, and frontend code under `web/src/lib/desktop`, `web/src/components/desktop`, and `web/src/components/rdp`.
- TCP forwarding: routes `/portforward` and `/ws/tcp/:node_id` are mounted in `internal/server/routes.go`; implementation lives under `internal/protocols/tcpfwd` and defaults are configured in `protocols.tcpfwd`.
- Proxy chains: `internal/dialer` and `internal/webssh` build direct, SOCKS5, and SSH bastion chains from node/proxy configuration.

## Database Integrations

- Application database: PostgreSQL via GORM and pgx. `configs/config.example.yaml` documents a PostgreSQL DSN; `deployments/docker-compose.yaml` uses `postgres:16-alpine`.
- Structured DB browser: backend package `internal/dbquery` talks directly to relational targets through `database/sql` over the gateway dialer chain. Current code supports MySQL and PostgreSQL only.
- DB browser API: `internal/api/db_handler.go` exposes ping, database/schema/columns/indexes, foreign keys, stats, DDL, rows, export, query, exec, explain, row edits, processes, and kill endpoints mounted in `internal/server/routes.go`.
- DB browser frontend: `web/src/components/db/*`, `web/src/lib/api/services.ts`, and `web/src/lib/api/types.ts` provide the DB Studio UI/client surface.
- DB CLI terminal: `internal/protocols/dbcli` launches Docker containers for `mysql`, `psql`, `redis-cli`, and `mongosh`; default images are configured in `configs/config.example.yaml` under `protocols.dbcli.images`.
- Node DB protocols today: `mysql`, `postgres`, `redis`, and `mongo` are enumerated in `internal/model/node.go`; `dameng` is not yet defined.

## Auth And Identity Integrations

- Local auth/JWT: `internal/auth` issues and validates JWTs; `internal/auth/middleware.go` accepts bearer headers, token query params, and WS subprotocol bearer tokens.
- OIDC: `internal/server/routes.go` mounts `/auth/oidc/:provider/login` and `/auth/oidc/:provider/callback`, and admin OIDC client routes when the handler is wired. Dependencies include `github.com/coreos/go-oidc/v3` and OAuth2.
- MFA: TOTP, email OTP, and recovery-code flows are routed under `/auth` and `/me/mfa`; config lives under `auth.mfa`.
- Passkeys/WebAuthn: passkey login and self-service routes are mounted in `internal/server/routes.go`; config lives under `auth.passkey` and implementation under `internal/passkey`.
- RBAC and asset grants: global permission checks use `auth.RequirePermission`; asset visibility/grants use `internal/asset` where wired.
- Anonymous auth/session mode: `/auth/anonymous` issues anonymous access and `/ws/ssh/anonymous` allows anonymous SSH to sandbox sessions.

## Secrets, KMS, And Crypto Integrations

- Secret vaulting: `internal/secrets` and `pkg/crypto` provide envelope/legacy credential encryption used by credentials, OIDC/MFA/AI secrets, and protocol session setup.
- KMS providers: `go.mod` includes AWS KMS, Azure Key Vault, Google KMS, and HashiCorp Vault/OpenBao Transit dependencies; `configs/config.example.yaml` says provider configuration is stored in database tables, not YAML.
- KMS setup API: admin setup routes under `/api/v1/setup/kms` are mounted in `internal/server/routes.go`.
- Approval ledger/archive: approval code supports signed ledger behavior and optional S3-compatible archive settings in config; dependencies include AWS S3 SDK.

## AI Integrations

- AI subsystem: `internal/ai` is wired under `/api/v1/ai` when enabled and includes providers, agents, tools, conversations, SSE streaming, and invocation approval/reject endpoints.
- Provider SDKs: `go.mod` includes OpenAI, Anthropic, Google GenAI, and related dependencies; config mentions compatible gateways such as NewAPI/DeepSeek-like endpoints in README/config comments.
- AI tools bridge to operations such as SSH exec, SFTP, sessions, port forwarding, and sub-agent behavior; exact tool permissions should be verified under `internal/ai/tools` and `internal/ai/runner`.

## Notifications And External Services

- SMTP/email: `configs/config.example.yaml` defines `notify.smtp` and worker retry/channel settings; implementation lives under `internal/notify`.
- Login anomaly notification: `internal/anomaly` is wired from startup and config has `auth.anomaly.notify_email`.
- Docker daemon: `internal/anonymous` and `internal/protocols/dbcli` rely on Docker; compose/deployment setup must provide Docker access to the gateway process.
- Devolutions Gateway/IronRDP: frontend depends on `@devolutions/iron-remote-desktop*`; backend desktop config includes Devolutions Gateway settings in `internal/config/config.go` and desktop manager code.

## Frontend Runtime Integrations

- REST/SSE bridge: frontend calls go through `web/src/lib/api/client.ts` to `/api/proxy/api/v1` unless `NEXT_PUBLIC_API_BASE` is set.
- Backend HTTP target: Next proxy forwards to `BACKEND_HTTP_URL || http://127.0.0.1:8080` in `web/src/app/api/proxy/[...path]/route.ts`.
- Backend WS target: terminal/desktop/Guacamole clients need `NEXT_PUBLIC_BACKEND_WS_URL` or equivalent direct backend WS URL; Next route handlers do not proxy WS upgrades.
- i18n: frontend uses i18next with `web/src/i18n/locales/en.json` and `web/src/i18n/locales/zh.json`.
- Guacamole browser bundle: `web/scripts/copy-guacamole.mjs` vendors `guacamole-common.min.js` from `node_modules` to `web/public/vendor` during install/build.

## Operational Dependencies And Defaults

- `deployments/docker-compose.yaml` starts PostgreSQL, Redis, guacd, and a test SSH target, but intentionally does not run the app container for local development.
- Backend config defaults are documented in `configs/config.example.yaml`; Viper also supports `WAYFORT_` environment overrides.
- Session recording storage is filesystem-backed by default; guacd can mount the same sessions volume for `.guac` recordings.
- Production reverse proxy/TLS/origin policy is Unknown from the repository alone and should be documented before hardening WS or token-query flows.
