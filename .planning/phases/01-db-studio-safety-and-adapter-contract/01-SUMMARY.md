# Phase 1 Summary: DB Studio Safety And Adapter Contract

**Completed:** 2026-05-21
**Status:** Implemented and verified locally; changes are not committed.

## What Changed

- Added a DB Studio asset-access gate in `dbquery.Service.getOrOpen` before cached pool reuse and before credential lookup.
- Added a DB CLI asset-access gate before approval checks and credential decode.
- Hardened DB Studio read-only SQL classification against obvious write bypasses:
  - multi-statement inputs
  - writable CTEs
  - `WITH ... SELECT INTO ...`
  - `EXPLAIN ANALYZE` through read-only query classification
  - MySQL `INTO OUTFILE` / `INTO DUMPFILE`
  - PostgreSQL process-control functions in read paths
  - MySQL executable comments such as `/*! INTO OUTFILE ... */`
- Introduced the relational adapter contract in `internal/dbquery`:
  - `Adapter`
  - `Dialect`
  - `Capabilities`
  - `Registry`
  - MySQL and PostgreSQL default adapters
- Moved row-browse SQL construction out of `DBHandler` dialect inference into `dbquery.Service.BuildRowsSQL` and adapter dialects.

## Tests Added

- `internal/api/db_handler_test.go` covers SQL classifier safe/unsafe cases.
- `internal/dbquery/service_test.go` covers DB Studio access fail-closed and cached-pool denial behavior.
- `internal/protocols/dbcli/gateway_test.go` covers DB CLI asset access helper behavior.
- `internal/dbquery/adapter_test.go` covers default registry, capabilities, dialect quoting, placeholders, and row SQL builders.

## Verification

- `go test ./internal/api ./internal/dbquery ./internal/protocols/dbcli ./internal/approval` passed.
- `go test ./...` passed.
- Independent code review found SQL classifier bypasses in MySQL executable comments and `WITH ... SELECT INTO`; both were fixed and re-verified.
- Final narrow SQL classifier review reported no HIGH/MEDIUM findings.

## Residual Risks

- SQL classification remains heuristic. Side-effecting functions beyond the explicit blocklist may still need a stronger parser or per-dialect policy in a future hardening phase.
- `SELECT ... FOR UPDATE` remains allowed and may acquire locks.
- PostgreSQL dollar-quoted strings are not parsed, so some safe queries may be conservatively rejected.
- Schema/process/export/explain internals still contain protocol switches; Phase 2 migrates those behind adapters.
