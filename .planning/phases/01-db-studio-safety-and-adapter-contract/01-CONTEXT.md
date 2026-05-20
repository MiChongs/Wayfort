# Phase 1: DB Studio Safety And Adapter Contract - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning
**Source:** Brownfield codebase map plus targeted Phase 1 research

<domain>
## Phase Boundary

Phase 1 establishes a safe foundation for the DB Studio adapter expansion. It must add a node asset-access gate before DB Studio and DB CLI credential/session access, harden obvious SQL read/write classification bypasses, and introduce the minimal relational adapter registry/capability contract required for later MySQL/PostgreSQL migration and Dameng support.

This phase should not add Dameng yet and should not complete the full MySQL/PostgreSQL adapter migration. It creates seams and safety checks while preserving current behavior.
</domain>

<decisions>
## Implementation Decisions

### Safety

- D-01: DB Studio access must be gated centrally before pool reuse and before credential loading, so revoked access cannot keep using cached pools.
- D-02: DB CLI must check `asset.Resolver.Check(ctx, userID, nodeID, asset.ActionConnect)` before approval checks and credential decode.
- D-03: If an asset resolver is unexpectedly nil in DB Studio or DB CLI, fail closed with a clear error instead of silently allowing access.
- D-04: Preserve existing approval and audit call sites for DB write operations; safety hardening must not remove `checkSQLExec`, `Approval.CheckEnforced`, or `logSQL` usage.
- D-05: SQL read-only classification should reject obvious multi-statement, writable CTE, `EXPLAIN ANALYZE`, and `SELECT INTO OUTFILE/DUMPFILE`/PostgreSQL `SELECT INTO` bypasses without trying to become a complete SQL parser.

### Adapter Contract

- D-06: Phase 1 introduces adapter identity, registry, capabilities, and dialect contract types under `internal/dbquery`, but leaves full metadata/process migration to Phase 2.
- D-07: The adapter registry is keyed by `model.NodeProtocol` and must register MySQL and PostgreSQL by default.
- D-08: Capabilities must be concrete enough for future frontend use, even if Phase 1 only consumes them internally.
- D-09: Remove the row-browse dialect inference in `DBHandler.buildRowsSQL` by adding a service/dialect-backed row SQL builder.
- D-10: Keep current public DB Studio response DTOs and REST method signatures stable.

### Claude's Discretion

- The exact error strings can be adjusted if tests assert the same semantic behavior.
- The adapter contract can be split across `adapter.go`, `registry.go`, and protocol-specific files if that keeps files readable.
</decisions>

<canonical_refs>
## Canonical References

Downstream agents must read these before planning or implementing.

### Project State

- `.planning/PROJECT.md` - overall project goals, constraints, and decisions.
- `.planning/REQUIREMENTS.md` - v1 requirements and Phase 1 requirement IDs.
- `.planning/ROADMAP.md` - Phase 1 goal, success criteria, and planned plan list.
- `.planning/codebase/CONCERNS.md` - security risks motivating the Phase 1 safety gate.

### DB Studio Backend

- `internal/api/db_handler.go` - DB Studio REST handler, query/exec gates, row browse SQL heuristic, and audit logging.
- `internal/dbquery/service.go` - connection pool, credential loading, protocol checks, MySQL/PostgreSQL connection construction.
- `internal/dbquery/schema.go` - current metadata API and MySQL/PostgreSQL schema switches.
- `internal/dbquery/crud.go` - current row edit SQL builders, quoting, placeholders, and explain handling.
- `internal/dbquery/processes.go` - process list/kill and export SQL behavior.
- `internal/dbquery/structure.go` - foreign key, stats, and DDL behavior.

### Access Patterns

- `internal/asset/grants.go` - `asset.Resolver.Check` and `asset.ActionConnect`.
- `internal/insights/manager.go` - central `gateAndLoad` pattern using asset checks before credential lookup.
- `internal/docker/manager.go` - another asset check before credential lookup pattern.
- `internal/firewall/manager.go` - another asset check before credential lookup pattern.
- `internal/desktop/manager.go` - asset check before desktop session setup.
- `internal/protocols/dbcli/gateway.go` - DB CLI session gateway and approval check location.
- `cmd/jumpserver/main.go` - `assetResolver` construction and DB Studio/DB CLI wiring.
</canonical_refs>

<specifics>
## Specific Ideas

- Add `asset *asset.Resolver` or equivalent to `dbquery.Service` and enforce access inside `getOrOpen` before pool lookup.
- Add `Asset *asset.Resolver` to `dbcli.Handler` and wire it in `cmd/jumpserver/main.go`.
- Add SQL classifier helper functions in `internal/api/db_handler.go` or a new `internal/api/db_sql_safety.go` if the logic grows.
- Add `internal/dbquery/adapter.go`, `internal/dbquery/adapter_mysql.go`, and `internal/dbquery/adapter_postgres.go` for Phase 1 contract and default registry.
- Add `Service.BuildRowsSQL(ctx, nodeID, userID, database, schema, table, orderBy, orderDir string, limit, offset int) (string, error)` so `DBHandler.Rows` no longer guesses dialect from column type strings.
</specifics>

<deferred>
## Deferred Ideas

- Dameng protocol and driver integration are Phase 3.
- Full MySQL/PostgreSQL metadata/process/DDL migration behind adapters is Phase 2.
- Frontend capability consumption is Phase 4.
- Exhaustive SQL parser integration is v2 hardening unless Phase 1 implementation finds a very low-risk existing parser already available.
</deferred>

---

*Phase: 01-db-studio-safety-and-adapter-contract*
*Context gathered: 2026-05-21*
