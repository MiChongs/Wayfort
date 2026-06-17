# Stack

Evidence is from the current repository snapshot. Items marked Unknown or Needs verification were not proven by checked files.

## Backend

- Language/runtime: Go module `github.com/michongs/wayfort`; `go.mod` declares Go `1.26.3`.
- Main gateway entrypoint: `cmd/wayfort/main.go`; HTTP routing is assembled through `internal/server/http.go` and `internal/server/routes.go`.
- Secondary executable: `cmd/freerdp-worker/` builds a FreeRDP worker binary; `Makefile` has `make build-worker` and OS-specific install targets.
- HTTP framework: Gin (`github.com/gin-gonic/gin`) with route groups under `/api/v1` in `internal/server/routes.go`.
- WebSocket implementation: `github.com/coder/websocket`; terminal-style and protocol WS endpoints live under `/api/v1/ws/...`.
- Persistence: PostgreSQL via GORM (`gorm.io/gorm`, `gorm.io/driver/postgres`) in `internal/repo/db.go`; `configs/config.example.yaml` and `deployments/docker-compose.yaml` use PostgreSQL.
- Cache/runtime state: Redis via `github.com/redis/go-redis/v9`, configured by `redis:` in `configs/config.example.yaml`.
- Logging/config: zap (`go.uber.org/zap`) and Viper (`github.com/spf13/viper`).
- Auth/security dependencies: JWT (`github.com/golang-jwt/jwt/v5`), OIDC (`github.com/coreos/go-oidc/v3`), OAuth2, WebAuthn/passkeys, TOTP, bcrypt, AES-GCM/envelope crypto, AWS/Azure/GCP/Vault KMS-related SDKs.
- Network/protocol dependencies: `golang.org/x/crypto/ssh`, `golang.org/x/net/proxy`, `github.com/pkg/sftp`, Docker SDK, pgx, MySQL driver, Mongo driver dependency, and Guacamole/RDP related internal packages.

## Frontend

- App root: `web/`.
- Framework/runtime: Next.js `^16.2.6`, React `^19.2.6`, TypeScript `^5.7.2` from `web/package.json`.
- Routing: Next App Router under `web/src/app`, with route groups `(auth)`, `(app)`, and `(workspace)`.
- UI stack: Tailwind CSS 4, Radix UI primitives, shadcn-style local wrappers under `web/src/components/ui`, `class-variance-authority`, `tailwind-merge`, `lucide-react`, `motion`, Sonner, and next-themes.
- Data/client state: TanStack Query, Zustand, React Hook Form, Zod, nuqs, i18next/react-i18next.
- Terminal/remote UI: xterm.js packages, `guacamole-common-js`, Devolutions IronRDP packages, Pixi/canvas helpers, asciinema player.
- API client: typed service wrappers in `web/src/lib/api/services.ts`, DTOs in `web/src/lib/api/types.ts`, and base client/proxy behavior in `web/src/lib/api/client.ts`.
- REST/SSE proxy: `web/src/app/api/proxy/[...path]/route.ts` forwards to `BACKEND_HTTP_URL` and defaults frontend calls to `/api/proxy/api/v1`.
- WebSocket clients connect directly to backend WS URLs; the Next proxy file explicitly notes it cannot proxy WS upgrades.

## Datastores And Runtime Services

- PostgreSQL is the primary application database in current code/config, despite older README text mentioning MySQL. Compose provides `postgres:16-alpine` on host port `5433`.
- Redis is required for cache/session/runtime coordination and is provided by `redis:7-alpine` in `deployments/docker-compose.yaml`.
- guacd is optional/legacy RDP/VNC infrastructure and compose provides `guacamole/guacd:1.5.5` on port `4822`.
- A test SSH target is provided by `linuxserver/openssh-server` in compose on host port `2222`.
- Session recordings are stored on disk under `storage.sessions_dir`, defaulting to `./var/sessions` in `configs/config.example.yaml`.
- Docker is used by anonymous sandbox support and DB CLI terminal containers.

## Build And Dev Commands

- Backend tests: `go test ./...` or `make test`.
- Backend gateway build: `make build`, which runs `bash scripts/build-gateway.sh`.
- FreeRDP worker build: `make build-worker`; OS-specific install scripts are exposed as `make install-worker-linux`, `make install-worker-darwin`, and `make install-worker-windows`.
- Frontend dev: from `web/`, `pnpm dev`.
- Frontend build: from `web/`, `pnpm build`; `prebuild` copies Guacamole assets.
- Frontend typecheck: from `web/`, `pnpm typecheck`.
- Frontend lint: from `web/`, `pnpm lint` is declared as `next lint`, but is deprecated/removed in Next 16 — prefer `pnpm typecheck` + `pnpm build`.
- Local dependencies: `docker compose -f deployments/docker-compose.yaml up` starts PostgreSQL, Redis, guacd, and a test SSH target; the app itself is intentionally run on the host per compose comments.

## Package And Artifact Notes

- Frontend package manager is pnpm (pinned via `packageManager` in `web/package.json`); `web/pnpm-lock.yaml` + `web/pnpm-workspace.yaml` are tracked and `package-lock.json` is gitignored. Use `corepack enable` then `pnpm install`.
- `web/scripts/copy-guacamole.mjs` runs on `postinstall` and `prebuild` to copy `guacamole-common.min.js` into `web/public/vendor/`.
- Generated/runtime artifacts include `web/.next/`, `web/tsconfig.tsbuildinfo`, `var/`, root binaries, and `bin/` outputs.
- Local config files such as `/config.yaml` and `/configs/config.yaml` are ignored and should not be treated as source of truth for documentation.
