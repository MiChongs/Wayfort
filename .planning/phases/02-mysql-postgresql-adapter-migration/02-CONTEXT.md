# Phase 2: MySQL/PostgreSQL Adapter Migration - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning
**Source:** Phase 1 summary, roadmap, requirements, codebase map, and targeted `internal/dbquery` inspection

<domain>
## Phase Boundary

Phase 2 moves existing MySQL and PostgreSQL DB Studio behavior behind the adapter system introduced in Phase 1. The goal is not to add Dameng yet. The goal is to preserve every existing MySQL/PostgreSQL user-visible flow while moving protocol-specific connection, metadata, process, DDL, explain, CRUD, row browsing, and export SQL behind adapter/dialect APIs.

This phase should leave the REST API shape stable and should avoid frontend changes unless implementation uncovers a backend contract regression that must be surfaced.
</domain>

<decisions>
## Implementation Decisions

### Adapter Ownership

- D-11: `dbquery.Service` remains responsible for access gates, node/credential loading, proxy-chain creation, pool lifecycle, timeouts, and audit-facing public method signatures.
- D-12: Adapters own driver connection construction after the service supplies host, port, username, password, requested database, proto options, and a chain-backed `DialContext` callback.
- D-13: Adapters own database/schema defaulting semantics. PostgreSQL keeps catalog-bound semantics and falls back to `postgres`; MySQL keeps schema/default-database semantics and can connect without a default schema.
- D-14: MySQL global dialer registration and cleanup must be hidden behind adapter-open cleanup so `service.go` no longer imports MySQL driver packages.
- D-15: Metadata, structure, process, explain, row, CRUD, and export SQL construction should be adapter-owned; service methods delegate to the pool adapter instead of switching on `pl.protocol`.

### Compatibility

- D-16: Preserve existing JSON DTOs: `SchemaInfo`, `DatabaseInfo`, `TableInfo`, `ColumnInfo`, `IndexInfo`, `ForeignKeyInfo`, `TableStats`, `ProcessInfo`, `QueryResult`, and `ExecResult`.
- D-17: Preserve table `kind` strings currently returned to the UI: `table`, `view`, `matview`, `sequence`, `foreign_table`, `function`, `procedure`, `aggregate`, and `window` where applicable.
- D-18: Keep the Phase 1 read-only SQL classifier in `internal/api/db_handler.go` for now. Per-dialect SQL parsing is v2 hardening unless Phase 2 needs a small adapter-owned explain/export builder.
- D-19: Do not introduce `sqlmock` or broad new test dependencies unless implementation proves the standard library cannot test the needed seams cheaply.

### Claude's Discretion

- Adapter interfaces may be grouped as direct `Adapter` methods or subinterfaces such as `Connector`, `Metadata`, `Structure`, `Process`, and `SQLBuilder` if that keeps files readable.
- Protocol-specific helper functions may keep names like `loadPostgresColumns` while they live in adapter-owned files and are reached through adapter methods.
- If moving every helper in one plan causes noisy diffs, prefer thin adapter methods that wrap existing helpers first, then relocate helpers only when useful.
</decisions>

<canonical_refs>
## Canonical References

Downstream agents must read these before planning or implementing.

### Project State

- `.planning/PROJECT.md` - overall goals, constraints, and current adapter expansion context.
- `.planning/REQUIREMENTS.md` - Phase 2 requirement IDs ADPT-03, ADPT-04, ADPT-05, MPG-01, MPG-02, MPG-03.
- `.planning/ROADMAP.md` - Phase 2 goal, success criteria, and plan list.
- `.planning/phases/01-db-studio-safety-and-adapter-contract/01-SUMMARY.md` - Phase 1 implementation state and residual risks.
- `.planning/codebase/ARCHITECTURE.md` - backend seams and routing shape.
- `.planning/codebase/TESTING.md` - verification commands and known test gaps.

### DB Studio Backend

- `internal/dbquery/adapter.go` - Phase 1 adapter, registry, capabilities, and dialect contract.
- `internal/dbquery/adapter_mysql.go` - current MySQL adapter/dialect implementation.
- `internal/dbquery/adapter_postgres.go` - current PostgreSQL adapter/dialect implementation.
- `internal/dbquery/service.go` - connection pools, access gate, credential loading, current connection switch.
- `internal/dbquery/schema.go` - database/schema, columns, and indexes protocol switches.
- `internal/dbquery/structure.go` - foreign key, stats, and DDL protocol switches.
- `internal/dbquery/processes.go` - process list/kill and export SQL protocol behavior.
- `internal/dbquery/crud.go` - row edit SQL builders and explain protocol switch.
- `internal/dbquery/rows.go` - Phase 1 row SQL service seam.
- `internal/api/db_handler.go` - DB Studio REST handler, export formatting, read/write gate, and audit logging.
</canonical_refs>

<specifics>
## Current Hotspots

- `internal/dbquery/service.go` still switches on `node.EffectiveProtocol()` to open PostgreSQL or MySQL connections and imports both driver packages.
- `internal/dbquery/schema.go` still switches for `ListDatabases`, `LoadSchema`, `LoadColumns`, and `LoadIndexes`.
- `internal/dbquery/structure.go` still switches for foreign keys, stats, and DDL.
- `internal/dbquery/processes.go` still switches for process list and process cancel, and export still uses the old `quoteIdent(pl.protocol)` helper.
- `internal/dbquery/crud.go` still switches in `Explain`, and stale `quoteIdent` / `placeholder` helpers remain after Phase 1.
- `internal/api/db_handler.go` still renders SQL export `INSERT` statements with PostgreSQL-style double-quoted identifiers.
</specifics>

<deferred>
## Deferred Ideas

- Dameng protocol, driver dependency, DSN verification, metadata, and UI wiring are Phase 3 and Phase 4.
- Replacing the SQL classifier with a full parser is v2 hardening unless a Phase 2 regression requires a targeted fix.
- Frontend capability consumption is Phase 4.
- DB CLI Dameng terminal behavior remains deferred until a reliable client image/command is confirmed.
</deferred>

---

*Phase: 02-mysql-postgresql-adapter-migration*
*Context gathered: 2026-05-21*
