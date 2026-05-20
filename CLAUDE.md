# Project Guidance

Read `.planning/STATE.md` and `.planning/PROJECT.md` before starting GSD-managed work in this repository.

## Current Focus

- Project: JumpServer-Anonymous DB Studio Adapter Expansion
- Next phase: Phase 1, DB Studio Safety And Adapter Contract
- Core goal: move structured DB Studio to a safe relational adapter system and add Dameng support without more hardcoded dialect branching.

## Important Context

- Codebase map: `.planning/codebase/`
- Requirements: `.planning/REQUIREMENTS.md`
- Roadmap: `.planning/ROADMAP.md`
- Existing unrelated worktree changes may include `web/next-env.d.ts` and `web/.env`; do not overwrite them unless explicitly asked.

## Expected Workflow

- Use `/gsd-plan-phase 1` or equivalent planning before implementation.
- Verify work before claiming completion.
- Preserve existing MySQL/PostgreSQL DB Studio behavior while introducing adapter boundaries.
- Treat Dameng as an independent adapter with verified driver behavior.
