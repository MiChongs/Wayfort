# Roadmap: Wayfort DB Studio Adapter Expansion

## Overview

This roadmap starts by closing the highest-risk DB access gaps and defining the adapter contract, then migrates existing MySQL/PostgreSQL behavior behind adapters, adds Dameng backend support, and finishes by making the frontend capability-aware with verification across all supported relational DB Studio flows.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): planned milestone work.
- Decimal phases (2.1, 2.2): urgent insertions if needed.

- [x] **Phase 1: DB Studio Safety And Adapter Contract** - Establish safe access gates and the core relational adapter interface/capability model.
- [ ] **Phase 2: MySQL/PostgreSQL Adapter Migration** - Move existing DB Studio behavior behind adapters without regressions.
- [ ] **Phase 3: Dameng Backend Adapter** - Add Dameng protocol, connector, dialect, metadata, query, and capability behavior.
- [ ] **Phase 4: Capability-Aware Frontend And Verification** - Wire Dameng through the UI and verify MySQL/PostgreSQL/Dameng behavior.

## Phase Details

### Phase 1: DB Studio Safety And Adapter Contract

**Goal**: DB Studio has an explicit safety baseline and a stable adapter contract before new database support is added.

**Depends on**: Nothing (first phase)

**Requirements**: SEC-01, SEC-02, SEC-03, ADPT-01, ADPT-02

**UI hint**: no

**Success Criteria** (what must be TRUE):

1. DB Studio and DB CLI credential/session paths enforce or clearly share a node asset-access gate before opening database connections.
2. DB write operations still pass through approval and audit paths after safety refactoring.
3. Obvious write, multi-statement, or unsafe read-only bypasses are rejected or routed to the write/approval path.
4. A relational adapter registry exists and can return protocol-specific capabilities.
5. Existing MySQL/PostgreSQL behavior remains callable while the new contract is introduced.

**Plans**: 2 plans

**Wave 1**

Plans:

- [x] 01-01: Add DB node access gate and SQL safety baseline.

**Wave 2 (blocked on Wave 1 completion)**

- [x] 01-02: Define adapter registry, capability model, and service integration seam.

Cross-cutting constraints:

- Preserve existing MySQL/PostgreSQL DB Studio behavior while adding seams.
- Fail closed for missing DB asset-access resolver dependencies.
- Do not add Dameng protocol or driver dependency in Phase 1.

### Phase 2: MySQL/PostgreSQL Adapter Migration

**Goal**: Existing MySQL and PostgreSQL DB Studio behavior runs through the adapter system with no user-visible regression.

**Depends on**: Phase 1

**Requirements**: ADPT-03, ADPT-04, ADPT-05, MPG-01, MPG-02, MPG-03

**UI hint**: no

**Success Criteria** (what must be TRUE):

1. MySQL connections, schema browsing, row browsing, query/exec, row edits, process list, kill, explain, and export still work through the adapter path.
2. PostgreSQL connections, schema browsing, row browsing, query/exec, row edits, process list, kill, explain, and export still work through the adapter path.
3. Dialect-specific SQL builders own quoting, placeholders, pagination, ordering, and CRUD SQL.
4. Metadata, structure, process, and handler code no longer depend on broad MySQL/PostgreSQL switch statements outside adapter registration.
5. Focused Go tests cover migrated builders and compatibility behavior.

**Plans**: 3 plans

Plans:

- [ ] 02-01: Move connection and dialect behavior into MySQL/PostgreSQL adapters.
- [ ] 02-02: Move metadata, structure, process, and DDL behavior into adapters.
- [ ] 02-03: Move row browsing/CRUD/explain/export SQL construction behind adapter APIs and add regression tests.

### Phase 3: Dameng Backend Adapter

**Goal**: Dameng is a first-class backend relational DB Studio adapter reachable through Wayfort proxy chains.

**Depends on**: Phase 2

**Requirements**: DM-01, DM-02, DM-03, DM-04, DM-05

**UI hint**: no

**Success Criteria** (what must be TRUE):

1. Backend node protocol definitions and relational adapter registry include Dameng with default port 5236.
2. Dameng connections use a verified Go driver and adapter-owned DSN/connection construction through the existing proxy-chain path.
3. Dameng schema/table/view/column/index/foreign-key/stat/DDL metadata works where supported, with unsupported features capability-disabled.
4. Dameng row browsing, query, explain, CRUD, and export use Dameng-aware identifier quoting, placeholders, pagination, and type normalization.
5. Dameng process list/kill is implemented when safely available or disabled through capabilities with clear errors.

**Plans**: 3 plans

Plans:

- [ ] 03-01: Register Dameng protocol and connector with verified driver behavior.
- [ ] 03-02: Implement Dameng metadata, structure, stats, DDL, and process capabilities.
- [ ] 03-03: Implement Dameng dialect query, row browsing, CRUD, explain, export, type normalization, and tests.

### Phase 4: Capability-Aware Frontend And Verification

**Goal**: The frontend exposes Dameng and adapter capabilities cleanly, and the milestone is verified across existing and new relational protocols.

**Depends on**: Phase 3

**Requirements**: UI-01, UI-02, UI-03, UI-04, TEST-01, TEST-02, TEST-03

**UI hint**: yes

**Success Criteria** (what must be TRUE):

1. Admin node creation/editing can select Dameng, default to port 5236, and show useful protocol option guidance.
2. Workspace and node action metadata treat Dameng as DB Studio-capable.
3. DB Studio reads backend capabilities and hides or disables unsupported actions without scattered per-database branches.
4. API types and service wrappers consistently represent Dameng protocol values and adapter capabilities.
5. Automated tests and manual verification document MySQL, PostgreSQL, and Dameng DB Studio flows.

**Plans**: 3 plans

Plans:

- [ ] 04-01: Add Dameng protocol metadata to frontend types, node forms, and workspace actions.
- [ ] 04-02: Make DB Studio UI capability-aware and remove avoidable hardcoded protocol UI checks.
- [ ] 04-03: Run regression verification, write manual test checklist, and fix issues found.

## Progress

**Execution Order:**

Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. DB Studio Safety And Adapter Contract | 2/2 | Complete (uncommitted) | 2026-05-21 |
| 2. MySQL/PostgreSQL Adapter Migration | 0/3 | Planned | - |
| 3. Dameng Backend Adapter | 0/3 | Not started | - |
| 4. Capability-Aware Frontend And Verification | 0/3 | Not started | - |
