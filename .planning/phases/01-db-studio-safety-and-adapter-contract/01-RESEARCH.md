# Phase 1 Research: DB Studio Safety And Adapter Contract

## Summary

Phase 1 should make two targeted changes before adding Dameng: enforce asset access for DB surfaces, and introduce a minimal adapter registry/capability contract. Targeted code research found DB Studio currently lacks an asset grant check before credential load and cached pool reuse. DB CLI has approval gating but also lacks asset grant enforcement. The existing insights/docker/firewall/desktop managers provide the access-check pattern to copy.

## Findings

### DB Studio Access Gate

- `internal/api/db_handler.go` has `DBHandler.gate`, but it only checks service presence, auth claims, and parses `:id`.
- `internal/dbquery/service.go` loads nodes and credentials in `Service.build` with no asset grant check.
- `Service.getOrOpen` reuses cached pools before any access re-check, which means an access grant revoked after pool creation could remain effective until pool eviction.
- Best central place for the DB Studio access gate is the beginning of `Service.getOrOpen`, before pool map lookup and before `build` can load credentials.

### DB CLI Access Gate

- `internal/protocols/dbcli/gateway.go` rejects anonymous users and disabled/non-DB nodes.
- DB CLI checks `approval.CheckEnforced` for asset access before credential loading, but approval enforcement is not the same as asset grants.
- Add `Asset *asset.Resolver` to `dbcli.Handler` and check `asset.ActionConnect` after parsing node/user and before approval or credential decode.

### Patterns To Reuse

- `internal/insights/manager.go`, `internal/docker/manager.go`, and `internal/firewall/manager.go` use central `gateAndLoad` style checks before credential lookup.
- `internal/desktop/manager.go` checks `asset.ActionConnect` before starting a desktop session.
- `internal/asset/grants.go` defines `asset.ActionConnect` and `Resolver.Check(ctx, userID, nodeID, action)`.

### Approval And Audit

- DB writes and row edits are intended to use `model.ApprovalBizSQLExec` through `DBHandler.checkSQLExec` or inline approval logic in `DBHandler.Exec`.
- DB SQL audit events are emitted through `DBHandler.logSQL` for query, exec, row edit, export, explain, rows, and kill paths.
- `internal/approval/enforcement.go` currently indicates `sql_exec` may not be enforced by the default node flag. Phase 1 should preserve existing behavior and tests, not silently claim stronger approval semantics than the enforcer provides.

### SQL Safety

- `internal/api/db_handler.go:isReadOnlySQL` accepts `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `DESCRIBE`, `DESC`, and `VALUES` by prefix.
- Obvious low-risk hardening targets are multi-statement inputs, writable CTE heads, `EXPLAIN ANALYZE`, nested `EXPLAIN` in `/db/explain`, `SELECT ... INTO OUTFILE/DUMPFILE`, PostgreSQL `SELECT INTO`, and known process-kill/side-effect function names.
- No DB Studio SQL classifier tests currently exist. Add tests around classifier behavior and handler gate outcomes if feasible.

### Adapter Contract

- Current dialect branches are spread across `internal/dbquery/service.go`, `schema.go`, `crud.go`, `processes.go`, `structure.go`, and `internal/api/db_handler.go`.
- Phase 1 should not migrate all behavior. It should add types for registry, adapter identity, capabilities, and dialect building, then move only the row browse SQL heuristic behind that seam.
- Preserve current `dbquery.Service` public method signatures so existing `DBHandler` calls continue to compile.

## Recommended Phase 1 Outputs

- `01-01-PLAN.md`: Add DB node access gates and SQL safety baseline.
- `01-02-PLAN.md`: Add adapter registry/capabilities and remove row browse dialect inference.

## Validation Architecture

- Unit tests should cover asset gate fail-closed behavior where mockable without heavy DB setup.
- SQL classifier tests should be table-driven and live near `internal/api/db_handler.go`.
- Adapter contract tests should verify default registry includes MySQL/PostgreSQL, capabilities are non-empty, and row SQL builders produce expected MySQL/PostgreSQL quoting.
- Full `go test ./...` is the broad verification command for Phase 1.
