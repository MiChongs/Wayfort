# JumpServer-Anonymous DB Studio Adapter Expansion

## What This Is

JumpServer-Anonymous is an existing Go and Next.js browser bastion platform for SSH, Telnet, SFTP, RDP/VNC, DB CLI, structured DB browsing, TCP forwarding, audit, approvals, and AI-assisted operations. This project stream focuses on evolving the structured DB Studio from a MySQL/PostgreSQL-specific implementation into a dynamic relational database adapter system, with Dameng support delivered end-to-end.

The immediate users are operators and administrators who need one browser-based database studio that works safely through JumpServer's existing credentials, proxy chains, approval gates, audit trail, and asset model.

## Core Value

Operators can use DB Studio against supported relational databases through one safe adapter layer, with Dameng working end-to-end without adding more per-dialect hardcoding.

## Requirements

### Validated

- [x] Browser bastion gateway supports node-based protocol access for SSH, Telnet, RDP, VNC, DB CLI, Redis, Mongo, and TCP-style targets - existing
- [x] Structured DB Studio endpoints and frontend exist for MySQL/PostgreSQL schema browsing, rows, SQL query/exec, row edits, process list, and export - existing
- [x] Frontend has a typed API layer and DB Studio UI that can be extended without replacing the whole page - existing
- [x] Backend already routes database connections through JumpServer credential lookup and proxy-chain dialing - existing
- [x] The codebase has RBAC, asset grants, approval gates, KMS-backed secret handling, audit logging, and session recording foundations - existing

### Active

- [ ] Add a unified DB adapter registry and capability model for relational DB Studio behavior.
- [ ] Move MySQL/PostgreSQL DB Studio behavior behind adapters without regressing current functionality.
- [ ] Add Dameng as a first-class relational database protocol and DB Studio adapter.
- [ ] Make row browsing, CRUD SQL, metadata, process controls, explain, and DDL access adapter/dialect-driven instead of handler heuristics.
- [ ] Make frontend DB Studio and node management capability-aware so new relational adapters do not require UI hardcoding beyond protocol registration.
- [ ] Preserve JumpServer security boundaries before expanding DB access: asset grants, approval gates, audit, and credential handling must remain explicit.
- [ ] Add focused tests and manual verification paths for adapter behavior, Dameng semantics, and existing MySQL/PostgreSQL compatibility.

### Out of Scope

- Full support for every domestic database in this milestone - the adapter system should make future additions easier, but Dameng is the concrete v1 target.
- Rewriting Redis/Mongo into structured DB Studio - they remain outside the relational adapter scope.
- A guaranteed production Dameng CLI container image - DB Studio support is required; terminal DB CLI support depends on client image availability and can be deferred.
- Replacing the whole frontend DB Studio UI - current UI should be extended through capabilities and protocol metadata.
- A complete SQL side-effect proof parser for every dialect - the milestone should harden obvious unsafe paths and route writes through approval, but exhaustive SQL security analysis can remain future work.

## Context

The codebase map lives in `.planning/codebase/` and should be read before planning or execution. The most relevant backend paths are `internal/dbquery`, `internal/api/db_handler.go`, `internal/model/node.go`, `internal/server/routes.go`, and `internal/protocols/dbcli`. The most relevant frontend paths are `web/src/lib/api/types.ts`, `web/src/lib/api/services.ts`, `web/src/components/db`, `web/src/components/workspace/protocolMeta.ts`, and `web/src/app/(app)/admin/nodes/page.tsx`.

Current DB Studio code is intentionally useful but not yet adapterized. It has explicit MySQL/PostgreSQL branches in schema, structure, CRUD, process, and connection code. The handler also contains row-browse SQL construction that tries to infer dialect from column metadata, which should move behind adapter/dialect APIs.

Dameng support needs different assumptions from PostgreSQL. Prior investigation identified common Go driver usage as `gitee.com/chunanyong/dm`, driver name `dm`, DSN shape like `dm://user:pass@host:5236?schema=...`, default port `5236`, and schema-oriented behavior. These details need verification against the actual driver during implementation.

The codebase concerns map flags DB Studio and DB CLI as security-sensitive because some node-scoped operational paths may load credentials without first enforcing asset grants. This must be addressed or explicitly verified before widening DB Studio to new database types.

## Constraints

- **Tech stack**: Backend is Go/Gin/GORM/PostgreSQL; frontend is Next.js/React/TypeScript. Use existing patterns rather than introducing new frameworks.
- **Security**: DB access must preserve asset grant checks, approval gates for writes, audit logging, and KMS-backed credential flow.
- **Compatibility**: Existing MySQL/PostgreSQL DB Studio behavior must keep working while it is moved behind adapters.
- **Database semantics**: Dameng is schema-oriented and should be its own adapter, not treated as PostgreSQL.
- **Frontend scope**: Prefer capability-driven UI switches over scattered protocol-specific conditionals.
- **Environment**: `gsd-sdk` and `firecrawl` are not available in PATH in this workspace; use local files and repository evidence.
- **Worktree safety**: Existing `web/next-env.d.ts` and `web/.env` changes are unrelated and must not be overwritten.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Refactor adapter architecture before adding Dameng-specific behavior | Avoid compounding hardcoded MySQL/PostgreSQL branches with another dialect | - Pending |
| Treat Dameng as an independent adapter | Dameng schema, identifier, metadata, and type behavior should not be assumed PostgreSQL-compatible | - Pending |
| Make frontend DB Studio capability-aware | New relational database support should not require broad UI rewrites | - Pending |
| Fix or verify node asset access before expanding DB Studio | New database support increases the blast radius of any existing node IDOR/RBAC gap | - Pending |
| Keep DB CLI Dameng support optional until a reliable client image/command is confirmed | Structured DB Studio is the target; CLI availability may depend on proprietary client distribution | - Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

After each phase transition:

1. Requirements invalidated? Move to Out of Scope with reason.
2. Requirements validated? Move to Validated with phase reference.
3. New requirements emerged? Add to Active.
4. Decisions to log? Add to Key Decisions.
5. "What This Is" still accurate? Update if drifted.

After each milestone:

1. Full review of all sections.
2. Core Value check: still the right priority?
3. Audit Out of Scope: reasons still valid?
4. Update Context with current state.

---
*Last updated: 2026-05-21 after initialization*
