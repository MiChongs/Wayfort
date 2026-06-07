# Testing And Verification

Evidence is from the current repository. Items marked Unknown or Needs verification were not proven by checked files.

## Test Frameworks

- Backend tests use Go's standard `testing` package. Existing tests are `*_test.go` files under `internal/**`.
- Some backend tests use in-memory SQLite via GORM for hermetic service tests, e.g. `internal/secrets/service_test.go`; deployment DB code is PostgreSQL-oriented (`internal/repo/db.go`).
- Tests may use local TCP listeners and real networking on loopback, e.g. `internal/protocols/tcpfwd/forwarder_test.go`.
- Frontend test framework: Unknown. No `*.test.ts(x)` or `*.spec.ts(x)` files were found under `web/`, and `web/package.json` has no test script.

## Existing Tests

- Approval workflow and ledger behavior: `internal/approval/workflow_test.go`, `internal/approval/ledger_test.go`, `internal/approval/enforcement_test.go`, `internal/approval/policy_test.go`.
- Auth/JWT/MFA: `internal/auth/jwt_test.go`, `internal/mfa/totp_test.go`.
- Secrets/KMS envelope behavior: `internal/secrets/service_test.go`.
- Protocol and networking behavior: `internal/protocols/tcpfwd/forwarder_test.go`, `internal/protocols/guacamole/*_test.go`, `internal/protocols/telnet/backend_test.go`.
- Desktop/RDP bootstrap/options: `internal/desktop/bootstrap_test.go`, `internal/desktop/rdp_options_test.go`.
- Operational parsers/tools: `internal/firewall/parser_test.go`, `internal/docker/parser_test.go`, `internal/insights/parsers_test.go`, `internal/ai/tools/*_test.go`, `internal/ai/provider/openai_test.go`.

## Commands

- Backend unit tests: `go test ./...` or `make test` (`Makefile`).
- Backend gateway build: `make build`, which runs `bash scripts/build-gateway.sh` (`Makefile`, `scripts/README.md`).
- FreeRDP worker build: `make build-worker` or OS-specific scripts under `scripts/` (`Makefile`, `scripts/README.md`). This can require libfreerdp/CGo dependencies.
- Frontend dev server: from `web/`, `pnpm dev` (`web/package.json`).
- Frontend build: from `web/`, `pnpm build`; this runs `prebuild` first to copy Guacamole assets (`web/package.json`, `web/scripts/copy-guacamole.mjs`).
- Frontend typecheck: from `web/`, `pnpm typecheck` (`web/package.json`).
- Frontend lint: from `web/`, `pnpm lint` is declared as `next lint`, but `next lint` is deprecated/removed in Next 16 — typecheck + build are the effective gates.
- Package manager: pnpm (pinned via `packageManager` in `web/package.json`). `web/pnpm-lock.yaml` + `web/pnpm-workspace.yaml` are tracked; `package-lock.json` is gitignored. First run: `corepack enable` then `pnpm install --frozen-lockfile`.

## Manual Verification Paths

- Health/root smoke: start the backend and check `GET /healthz` and `GET /`; both are defined in `internal/server/http.go`.
- Auth flow: frontend login page calls `/auth/login`, optional MFA/passkey endpoints, then redirects to `/dashboard` (`web/src/app/(auth)/login/page.tsx`, `internal/api/auth_handler.go`).
- REST proxy path: browser calls `/api/proxy/api/v1/...`, Next.js forwards to `BACKEND_HTTP_URL` (`web/src/lib/api/client.ts`, `web/src/app/api/proxy/[...path]/route.ts`).
- Admin node CRUD path: `/admin/nodes` uses `nodeService`, `credentialService`, and `proxyService`, with backend routes mounted in `internal/server/routes.go` (`web/src/app/(app)/admin/nodes/page.tsx`).
- SSH node page: `/nodes/[id]/ssh` loads node metadata and renders `WebSSHTerminal` plus `InsightsPanel`, using responsive tabs/panels (`web/src/app/(app)/nodes/[id]/ssh/page.tsx`).
- Session recording/SFTP asset URLs need token query support because some consumers cannot attach headers (`web/src/lib/api/client.ts`).
- Desktop/RDP-next path depends on desktop config and worker/gateway availability; build/install details are in `scripts/README.md` and config defaults in `configs/config.example.yaml`.

## Gaps And Risks

- No frontend unit/component/e2e test setup was found. UI behavior currently appears to rely on typecheck/build and manual verification.
- No root CI workflow files were found in the inspected files. Unknown whether external CI exists outside this checkout.
- No standalone migration test or migration directory was found; schema evolution relies on startup `AutoMigrate` (`internal/repo/db.go`).
- `go test ./...` may include packages with external/runtime assumptions; the checked tests include loopback networking and SQLite, while worker builds can require system libraries.
- README still references some older technology claims such as MySQL in the stack table, while current DB code and example config use PostgreSQL. Treat README architecture text as partly stale unless confirmed in code.
- `pnpm lint` (`next lint`) is deprecated/removed in Next 16; rely on `pnpm typecheck` + `pnpm build` as the frontend gates until a flat ESLint config is added.

## Suggested Verification For Changes

- Backend-only logic: run `go test ./...`; for gateway startup or schema-touching changes, also run `make build` if shell tooling is available.
- Frontend-only logic: from `web/`, run `pnpm typecheck` and `pnpm build` (the effective gates; `next lint` is gone in Next 16).
- API contract changes: update both backend route/handler code under `internal/api` or `internal/server/routes.go` and frontend types/services in `web/src/lib/api/types.ts` / `web/src/lib/api/services.ts`, then manually exercise through `/api/proxy/api/v1/...`.
- Desktop/RDP changes: run relevant Go tests under `internal/desktop`, then verify worker/gateway build/install path with `scripts/README.md` commands when touching worker integration.
