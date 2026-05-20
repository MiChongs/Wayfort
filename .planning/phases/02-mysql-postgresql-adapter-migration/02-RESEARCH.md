# Phase 2 Research: MySQL/PostgreSQL Adapter Migration

## Summary

Phase 1 created the adapter seam and safety gates, but most MySQL/PostgreSQL behavior still lives in service-level protocol switches. Phase 2 should migrate that behavior in three dependency-ordered passes: connection/dialect ownership, metadata/structure/process ownership, then remaining SQL builders and export formatting. The smallest safe approach is to keep public service methods stable and make them delegate to the pool's adapter.

## Findings

### Connection Construction

- `internal/dbquery/service.go` still owns the PostgreSQL/MySQL connection switch in `Service.build`.
- PostgreSQL uses `pgx.ParseConfig`, fills `Host`, `Port`, `User`, `Password`, `Database`, disables TLS, and provides a chain-backed `DialFunc`.
- MySQL registers a global go-sql-driver dialer name, builds a DSN using that dialer name and `parseTime=true&loc=Local&charset=utf8mb4`, then deregisters on failure/eviction.
- Pool eviction and close paths know about MySQL dialer names through `pool.dialerName`. Phase 2 should replace that with adapter-returned cleanup.
- Service should continue to load nodes, decrypt credentials, build proxy chains, and ping before returning a pool.

### Metadata And Structure

- `schema.go` has protocol switches for list databases, schema tree, columns, and indexes.
- `structure.go` has protocol switches for foreign keys, table stats, and DDL.
- PostgreSQL metadata uses `pg_database`, `pg_class`, `pg_namespace`, `pg_attribute`, `pg_index`, `pg_constraint`, and synthesized DDL.
- MySQL metadata uses `information_schema` and `SHOW CREATE TABLE`.
- UI compatibility depends on preserving `SchemaInfo` shape and `TableInfo.Kind` values.

### Processes, Explain, And Export

- `processes.go` switches for `ListProcesses` and `CancelProcess`.
- PostgreSQL cancel uses `SELECT pg_cancel_backend($1)`; MySQL uses `KILL QUERY <pid>`.
- `crud.go` switches for explain SQL: PostgreSQL `EXPLAIN` / `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)`, MySQL `EXPLAIN FORMAT=TREE` / `EXPLAIN ANALYZE FORMAT=TREE`.
- `processes.go` export query still uses old protocol-based `quoteIdent` rather than adapter dialect.
- `api/db_handler.go` SQL export row rendering quotes SQL identifiers with PostgreSQL double quotes, so MySQL SQL export is not adapter-owned yet.

### Tests

- Current Phase 1 tests cover adapter registry, capabilities, row SQL, SQL classifier, access gates, and DB CLI gate behavior.
- There is no existing `sqlmock` dependency. Prefer pure builder/helper tests and standard-library fakes where possible.
- `go test ./...` passed after Phase 1, making it the broad verification command for Phase 2.

## Recommended Phase 2 Outputs

- `02-01-PLAN.md`: Move connection and dialect defaulting behavior into MySQL/PostgreSQL adapters.
- `02-02-PLAN.md`: Move metadata, structure, process, and DDL service switches behind adapter methods.
- `02-03-PLAN.md`: Move row browsing, CRUD, explain, export SELECT, and SQL export rendering behind adapter SQL builders, then add regression tests.

## Validation Architecture

- Each plan should run `go test ./internal/dbquery ./internal/api` at minimum.
- Full phase verification should run `go test ./internal/api ./internal/dbquery ./internal/protocols/dbcli ./internal/approval` and `go test ./...`.
- Tests should assert SQL builder output exactly where behavior is pure.
- Tests should assert that service files no longer contain broad MySQL/PostgreSQL switches after the relevant migration plan.
- If an integration-style database test is not feasible without external MySQL/PostgreSQL instances, document manual verification paths rather than introducing brittle environment assumptions.
