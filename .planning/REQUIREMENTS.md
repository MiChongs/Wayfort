# Requirements: Wayfort DB Studio Adapter Expansion

**Defined:** 2026-05-21
**Core Value:** Operators can use DB Studio against supported relational databases through one safe adapter layer, with Dameng working end-to-end without adding more per-dialect hardcoding.

## v1 Requirements

### Security

- [x] **SEC-01**: DB Studio and DB CLI credential access checks node asset grants before opening a database connection or session.
- [x] **SEC-02**: DB Studio write operations still route through the existing approval/audit path after adapter refactoring.
- [x] **SEC-03**: Read-only SQL handling is hardened enough that obvious write or multi-statement paths cannot bypass the write/approval endpoint.

### Adapter Core

- [x] **ADPT-01**: Backend has a relational DB adapter registry keyed by `model.NodeProtocol` or equivalent protocol identifier.
- [x] **ADPT-02**: Each adapter exposes capabilities such as schemas, row edits, explain, process list, kill, DDL, export, and database/schema selection semantics.
- [ ] **ADPT-03**: Connector behavior is adapter-owned and supports Wayfort proxy-chain dialing, credential handling, default port behavior, and database/schema options.
- [ ] **ADPT-04**: Dialect behavior is adapter-owned for identifier quoting, placeholders, pagination, order clauses, DDL, explain, and row CRUD SQL.
- [ ] **ADPT-05**: Metadata behavior is adapter-owned for database/schema lists, tables/views, columns, indexes, foreign keys, table stats, and process information.

### MySQL/PostgreSQL Compatibility

- [ ] **MPG-01**: Existing MySQL DB Studio flows continue to work through the adapter registry.
- [ ] **MPG-02**: Existing PostgreSQL DB Studio flows continue to work through the adapter registry.
- [ ] **MPG-03**: Hardcoded MySQL/PostgreSQL switch statements in DB Studio service, metadata, structure, CRUD, process, and handler SQL code are removed or reduced to adapter registration only.

### Dameng Support

- [ ] **DM-01**: Dameng is represented as a first-class node protocol with default port `5236` in backend and frontend protocol metadata.
- [ ] **DM-02**: Dameng DB Studio connections open through Wayfort's proxy chain using a verified Go driver and adapter-owned DSN/connection construction.
- [ ] **DM-03**: Dameng metadata browsing supports schemas, tables/views, columns, indexes, foreign keys where available, table stats where available, and DDL where available.
- [ ] **DM-04**: Dameng row browsing, SQL query, explain, row insert/update/delete, and export use Dameng-aware quoting, placeholders, pagination, and type normalization.
- [ ] **DM-05**: Dameng process listing and kill behavior is implemented when safely available, or capability-disabled with clear frontend behavior when unavailable.

### Frontend

- [ ] **UI-01**: Admin node creation/editing supports selecting Dameng with correct default port and protocol option guidance.
- [ ] **UI-02**: Workspace and node action metadata recognize Dameng as a DB Studio-capable relational protocol.
- [ ] **UI-03**: DB Studio reads backend capabilities and hides or disables unsupported adapter features without hardcoded per-database UI branches.
- [ ] **UI-04**: Frontend API types and service wrappers represent adapter capabilities and Dameng protocol values consistently.

### Verification

- [ ] **TEST-01**: Unit tests cover adapter registry lookup, dialect SQL builders, read/write gate behavior, and MySQL/PostgreSQL compatibility paths.
- [ ] **TEST-02**: Dameng behavior has focused tests using fakes or query-builder assertions where a real Dameng instance is unavailable.
- [ ] **TEST-03**: Manual verification steps document how to test MySQL, PostgreSQL, and Dameng DB Studio flows through the UI.

## v2 Requirements

### Additional Databases

- **DBV2-01**: Add PostgreSQL-like adapters for openGauss, Kingbase, HighGo, Vastbase, or GaussDB after the adapter system is proven.
- **DBV2-02**: Add MySQL-like adapters for OceanBase or TiDB after the adapter system is proven.
- **DBV2-03**: Add first-class DB CLI Dameng terminal support when a reliable client image and licensing/distribution path is confirmed.

### Deeper Hardening

- **SEC2-01**: Replace prefix-based SQL classification with a stronger parser or conservative policy per dialect.
- **SEC2-02**: Replace token-query downloads with short-lived single-use download tickets.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Redis/Mongo structured DB Studio rewrite | Current work is relational adapter support only. |
| Full SQL parser for every dialect | Important, but not required to deliver safe Dameng support if obvious bypasses are blocked and writes route through approval. |
| Replacing the entire DB Studio frontend | Capability-driven extension is lower risk and preserves current UI. |
| Production Dameng CLI image guarantee | Dameng DB Studio is required; CLI depends on external client availability. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | Phase 1 | Complete (uncommitted) |
| SEC-02 | Phase 1 | Complete (uncommitted) |
| SEC-03 | Phase 1 | Complete (uncommitted) |
| ADPT-01 | Phase 1 | Complete (uncommitted) |
| ADPT-02 | Phase 1 | Complete (uncommitted) |
| ADPT-03 | Phase 2 | Pending |
| ADPT-04 | Phase 2 | Pending |
| ADPT-05 | Phase 2 | Pending |
| MPG-01 | Phase 2 | Pending |
| MPG-02 | Phase 2 | Pending |
| MPG-03 | Phase 2 | Pending |
| DM-01 | Phase 3 | Pending |
| DM-02 | Phase 3 | Pending |
| DM-03 | Phase 3 | Pending |
| DM-04 | Phase 3 | Pending |
| DM-05 | Phase 3 | Pending |
| UI-01 | Phase 4 | Pending |
| UI-02 | Phase 4 | Pending |
| UI-03 | Phase 4 | Pending |
| UI-04 | Phase 4 | Pending |
| TEST-01 | Phase 4 | Pending |
| TEST-02 | Phase 4 | Pending |
| TEST-03 | Phase 4 | Pending |

**Coverage:**

- v1 requirements: 23 total
- Mapped to phases: 23
- Unmapped: 0

---
*Requirements defined: 2026-05-21*
*Last updated: 2026-05-21 after initialization*
