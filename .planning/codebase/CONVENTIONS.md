# Codebase Conventions

Evidence is from the current repository. Items marked Unknown or Needs verification were not proven by checked files.

## Project Shape

- Backend is Go module `github.com/michongs/jumpserver-anonymous` with entrypoints in `cmd/jumpserver/main.go` and `cmd/freerdp-worker/main.go`.
- Backend packages are grouped by feature under `internal/` (`internal/auth`, `internal/api`, `internal/repo`, `internal/model`, `internal/desktop`, `internal/protocols/*`) and shared packages under `pkg/` (`pkg/crypto`, `pkg/kms`, `pkg/log`).
- Frontend is a Next.js app under `web/`, using App Router route groups in `web/src/app/(app)`, `web/src/app/(auth)`, and `web/src/app/(workspace)`.
- Frontend shared UI and helpers live under `web/src/components`, `web/src/lib`, `web/src/i18n`, and `web/src/types`.

## Coding Style

- Go code follows standard `gofmt` style; README badges explicitly call out `gofmt` (`README.md`).
- Go errors are generally wrapped at boundaries with context using `fmt.Errorf("...: %w", err)`, e.g. startup wiring in `cmd/jumpserver/main.go` and DB open in `internal/repo/db.go`.
- Go packages use short, feature-oriented names and constructors like `NewUserRepo`, `NewEngine`, `NewManager`, `NewService` (`internal/repo/user_repo.go`, `internal/server/http.go`, `internal/desktop/bootstrap_test.go`).
- TypeScript uses 2-space indentation, double quotes, no semicolons, and `@/*` path imports configured in `web/tsconfig.json`.
- Frontend files commonly use named service objects and named components; page files default-export route components (`web/src/app/(auth)/login/page.tsx`, `web/src/lib/api/services.ts`).

## Naming

- Backend models are singular Go structs with explicit `TableName()` where needed, e.g. `User` maps to `users` in `internal/model/user.go`.
- Repository types use `<Domain>Repo` and methods accept `context.Context`, e.g. `UserRepo.FindByUsername(ctx, username)` in `internal/repo/user_repo.go`.
- API handler types use `<Domain>Handler`, mounted from `internal/server/routes.go`.
- JSON fields use snake_case in Go tags and frontend request bodies, e.g. `display_name`, `challenge_token`, `department_id` (`internal/model/user.go`, `web/src/lib/api/services.ts`).
- Frontend React Query keys are compact arrays by resource/scope, e.g. `["auth", "providers"]`, `["admin", "nodes"]`, `["node", nodeId]` (`web/src/app/(auth)/login/page.tsx`, `web/src/app/(app)/admin/nodes/page.tsx`, `web/src/app/(app)/nodes/[id]/ssh/page.tsx`).

## API Patterns

- Backend routes are mounted under `/api/v1` via Gin in `internal/server/routes.go`; public auth endpoints are grouped under `/auth`, then authenticated/admin/ops groups add middleware and permission checks.
- Auth uses `auth.MiddlewareWith` plus permission gates from `auth.RequirePermission`, with constants like `auth.PermUserManage` (`internal/server/routes.go`).
- Handlers return JSON using `gin.H`, commonly `{"error": ...}` on failures and resource-shaped responses on success (`internal/api/auth_handler.go`).
- Disabled or unavailable subsystems often keep routes registered and return structured 503 stubs instead of 404, e.g. firewall, insights, and desktop helpers in `internal/server/routes.go`.
- Frontend REST calls go through `web/src/lib/api/client.ts`, which targets `NEXT_PUBLIC_API_BASE` or `/api/proxy/api/v1`, attaches bearer tokens, redirects on 401, and throws structured `ApiError`.
- Next.js proxies REST/SSE through `web/src/app/api/proxy/[...path]/route.ts` to `BACKEND_HTTP_URL`; WebSocket endpoints are not proxied there and use direct backend WS URLs per the file comments.

## Frontend Component Patterns

- Client-side interactive routes/components start with `"use client"` (`web/src/app/(auth)/login/page.tsx`, `web/src/components/providers.tsx`).
- UI primitives are shadcn/Radix-style wrappers under `web/src/components/ui`, using `class-variance-authority`, `Slot`, and `cn()` for class merging (`web/src/components/ui/button.tsx`, `web/src/lib/utils.ts`).
- Global providers are centralized in `web/src/components/providers.tsx`: i18next side-effect init, React Query, next-themes, tooltip provider, Sonner toaster, and confirm dialog host.
- Forms use `react-hook-form` plus Zod when validation is needed, as in `web/src/app/(auth)/login/page.tsx`.
- Data fetching uses TanStack Query and typed service wrappers in `web/src/lib/api/services.ts`.
- Larger forms prefer Sheet-based layouts in existing admin UI comments, e.g. `CreateNodeSheet` in `web/src/app/(app)/admin/nodes/page.tsx`; however some raw browser APIs still exist (`confirm` in the same file), so treat this as an observed preference, not a fully enforced rule.

## Backend Service Patterns

- Startup wiring is explicit dependency assembly in `cmd/jumpserver/main.go`: load config, initialize logger, DB, migrations, secrets, cache, repos, services, then mount routes.
- Long-running server behavior uses contexts and graceful shutdown (`signal.NotifyContext` in `cmd/jumpserver/main.go`, `Serve(ctx, ...)` in `internal/server/http.go`).
- DB access uses GORM with `WithContext(ctx)` in repositories (`internal/repo/user_repo.go`).
- Missing rows are often normalized to `(nil, nil)` in repo lookup methods, e.g. `FindByUsername`, `FindByID` (`internal/repo/user_repo.go`).
- Logging uses zap (`pkg/log`, `internal/server/http.go`, `cmd/jumpserver/main.go`). HTTP access logs classify health probes as debug, 5xx as error, 4xx as warn.
- Security-sensitive services use envelope/KMS abstractions under `internal/secrets` and `pkg/kms`; bootstrap and legacy migration behavior is wired in `cmd/jumpserver/main.go`.

## Error Handling

- Backend HTTP handlers usually respond immediately and return after `c.JSON(...)` on validation/auth/business errors (`internal/api/auth_handler.go`).
- Backend startup/service errors are wrapped and propagated upward; `main()` logs fatal only at the top (`cmd/jumpserver/main.go`).
- Frontend `api()` extracts backend `error` fields into `ApiError.message`, clears tokens and redirects to `/login` on 401, and returns text for non-JSON success bodies (`web/src/lib/api/client.ts`).
- Frontend pages generally display mutation/query failures via Sonner toasts (`web/src/app/(auth)/login/page.tsx`, `web/src/app/(app)/admin/nodes/page.tsx`).

## Config And Env

- Backend config is loaded by Viper from an explicit `-config` path or `./configs/config.yaml` / `./config.yaml`; environment variables prefixed with `JUMPSERVER_` override file values, with dots mapped to underscores (`internal/config/config.go`).
- Example backend config is `configs/config.example.yaml`; private runtime config is ignored as `/configs/config.yaml` and `/config.yaml` in `.gitignore`.
- Required backend config includes `auth.jwt_secret` length >= 16 and non-empty `db.dsn` (`internal/config/config.go`).
- Backend DB config is PostgreSQL-oriented in code and example config (`internal/repo/db.go`, `configs/config.example.yaml`), despite older README table text mentioning MySQL.
- Frontend environment variables observed: `NEXT_PUBLIC_API_BASE`, `BACKEND_HTTP_URL`, and comments referencing `NEXT_PUBLIC_BACKEND_WS_URL` (`web/src/lib/api/client.ts`, `web/src/app/api/proxy/[...path]/route.ts`).
- Do not commit secrets: `.gitignore` excludes local configs, `var/`, deployment var data, and root binaries.

## Migrations

- Schema migration is GORM `AutoMigrate` in `internal/repo/db.go`, invoked at startup by `cmd/jumpserver/main.go`.
- There is no standalone `migrations/` directory in the checked tree. Unknown whether production deployments require out-of-band migration controls.
- `AutoMigrate` currently covers core models, RBAC/org/asset models, MFA/passkey/auth audit, AI assistant models, KMS/envelope tables, and approval service tables (`internal/repo/db.go`).
- GORM is configured with `DisableForeignKeyConstraintWhenMigrating: true` and a silenced migration logger (`internal/repo/db.go`).

## Generated Files

- Next.js and TypeScript generated/build artifacts are present locally (`web/.next/`, `web/tsconfig.tsbuildinfo`) but should be treated as generated outputs, not source.
- `web/next-env.d.ts` is referenced by `web/tsconfig.json` and is a Next.js generated file; do not edit unless intentionally updating Next.js typing setup.
- `web/scripts/copy-guacamole.mjs` copies `guacamole-common.min.js` from `node_modules` into `web/public/vendor/` during `postinstall` and `prebuild`.
- Protocol schemas live in `proto/desktop/v1`; `buf.gen.yaml` says generated Go/TS bindings are planned for `internal/desktop/protov1` and `web/src/lib/desktop/gen`, but current M1 code hand-writes equivalents (`proto/desktop/v1/buf.gen.yaml`, `proto/desktop/v1/control.proto`).
- Worker/gateway binaries under root or `bin/` are ignored/generated runtime artifacts (`.gitignore`, `Makefile`, `scripts/README.md`).
