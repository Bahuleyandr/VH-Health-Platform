# Unified Care Pathways S1b-a Dormant Runtime Correctness Kernel — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-18-unified-care-pathways-s1b-a-dormant-runtime-correctness-kernel-design.md`

**Base:** `28470875658ededcde79bdd757ba0dbf5c3777de`

**Branch:** `feat/care-pathways-s1b-runtime-core`
**Migration:** `579_workflow_runtime_hardening.sql`

## Guardrails

1. `automation_rules` remains dormant; do not add a consumer.
2. Add no workflow definitions, seeds, projector handlers, clinical tasks, notifications or patient UI.
3. Default new definitions and all malformed/missing pathway settings to off/inactive.
4. Keep Stroke/STEMI and OBGyn domain code untouched.
5. Preserve clinical-inbox acknowledgement authorization and transactional SLA/comment semantics.
6. Use raw SQL migration plus Prisma schema in the same change.
7. Use a real migrated scratch database for rollback/concurrency/tenancy proof.
8. No deployment.

## Task 1 — Pin RED tests and the definition contract

Files:

- add `apps/backend/src/services/workflow/workflowDefinitionContract.js`
- add `apps/backend/src/tests/unit/workflowDefinitionContract.test.js`
- modify `apps/backend/src/tests/unit/taskService.test.js`

Steps:

1. Add failing tests for non-array/empty/malformed steps, duplicate keys, unsupported kinds, invalid
   metadata/role/timestamp shape and unregistered executable identifiers.
2. Add failing tests proving new definitions cannot be active and start rejects inactive/malformed rows.
3. Implement the pure validator with immutable registries and normalized canonical steps.
4. Run the focused unit tests and retain the RED-to-GREEN evidence in the PR description.

## Task 2 — Migration 579 and Prisma parity

Files:

- add `apps/backend/src/migrations/579_workflow_runtime_hardening.sql`
- modify `apps/backend/prisma/schema.prisma`
- modify `apps/backend/src/tests/unit/tasksWorkflowMigration.test.js`
- add or modify the migration/PHI/RLS schema registries only if their gates require it

Steps:

1. Re-derive the numeric migration tail and confirm 579 is still free immediately before writing.
2. Add a fail-closed preflight for cross-tenant definition/run/step/task/approval links.
3. Add tenant/id unique keys and composite foreign keys with preserved delete behavior.
4. Change the database default for new `workflow_definitions.is_active` rows to false without updating
   existing data.
5. Mirror constraints/defaults in Prisma.
6. Extend static migration tests, then migrate a scratch database.
7. Run Prisma validate, generate and schema-drift checks.

Migration 579 proves tenant ownership only. Same-run graph coherence for optional task/run/step and
approval/run/task link combinations remains a mandatory S1b-b preflight, database/service invariant
and conformance test before any executor or materialiser can activate.

## Task 3 — Atomic run start

Files:

- modify `apps/backend/src/services/workflow/taskService.js`
- add `apps/backend/src/tests/workflow-runtime-conformance.deep.test.js`

Steps:

1. Move definition lookup, validation, run insert and full step materialisation into one `setTenantTx`.
2. Require active definition and reject every malformed/duplicate step before the first insert.
3. Remove duplicate-error swallowing.
4. Add real-database tests for inactive/malformed definitions and induced mid-materialisation rollback.

## Task 4 — Compare-and-set state transitions

Files:

- modify `apps/backend/src/services/workflow/taskService.js`
- modify `apps/backend/src/tests/unit/taskService.test.js`
- extend `apps/backend/src/tests/workflow-runtime-conformance.deep.test.js`

Steps:

1. Add explicit workflow-run and workflow-step legal transition maps.
2. Change run, step and task mutations to tenant-qualified expected-status CAS updates.
3. Make standalone terminal task transition + existing linked-SLA completion one `setTenantTx`
   operation; preserve supplied-transaction callers and fail strictly on the SLA write.
4. On a zero-row update, distinguish not-found from a lost race/illegal transition without exposing
   cross-tenant state.
5. Put approval decision in `setTenantTx`, select `FOR UPDATE`, enforce pending state and required role,
   and serialize quorum/rejection.
6. Deny approval kinds owned by dedicated domain services on generic create and decide; keep
   `credential_privilege_grant` exclusively in credentialing's atomic two-person flow, and reject a
   database-expired pending approval before mutation.
7. Prove terminal immutability and exactly-one-winner transition races; prove serialized approval
   contributions and exactly one winner for conflicting terminal approval decisions.

## Task 5 — Server-derived actors

Files:

- modify `apps/backend/src/routes/admin/tasksWorkflowRoutes.js`
- modify `apps/backend/src/services/workflow/taskService.js`
- modify route/service unit tests and raw-parameter fixtures as required

Steps:

1. Remove task `created_by` body precedence.
2. Remove approval `approver_uid` body fallback.
3. Pass authenticated `actorUid` into task/run/step ADMIN-route transitions and authenticated roles
   into approval decisions.
4. Require a valid server actor for run/step/approval user mutations. Preserve the existing trusted
   in-process task-transition path used by escalation, cold-chain and results-inbox services until
   S1b-b can persist explicit registered-system provenance.
5. Prove spoofed body actors are ignored and missing actors fail before mutation.
6. Run raw-parameter and OpenAPI checks if the route contract changes.

## Task 6 — Read-only default-off pathway mode

Files:

- add `apps/backend/src/services/pathways/pathwayMode.js`
- add `apps/backend/src/tests/unit/pathwayMode.test.js`

Steps:

1. Define the canonical six keys and `off|shadow|active` modes.
2. Resolve only the nested tenant setting and require tenant context.
3. Fail closed to off for missing/malformed/unknown/lookup-error cases.
4. Add no environment override and no state-mutating consumer.
5. Test explicit off/shadow/active, cache-backed tenant reads, invalid keys and lookup failures.

## Task 7 — Program docs and regression gates

Files:

- modify `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`
- add the S1b-a design and this plan

Steps:

1. Record D2, D8 and D9 as owner-approved on 2026-07-18.
2. Document S1b-a as a dormant kernel, not pathway activation.
3. Run focused unit and real-database conformance suites.
4. Re-run the three clinical-inbox acknowledgement suites.
5. Run touched-file lint, Prisma gates, schema drift, raw-params and `git diff --check`.
6. Run the proportional backend gate defined by repository instructions.
7. Obtain independent integration and security reviews before publishing.

## Task 8 — Publish without deployment

1. Confirm the worktree contains only S1b-a changes.
2. Commit intentionally and push the feature branch.
3. Open one GitHub PR with grounding SHA, owner decisions, explicit non-activation boundary, RED-to-GREEN
   evidence, database evidence and deferred live-pipeline work.
4. Wait for authoritative hosted checks and address actionable failures.
5. Merge only with all required checks green and no unresolved P0/P1/P2 review finding.
6. Sync Forgejo only through the repository's established post-merge flow; do not deploy.
