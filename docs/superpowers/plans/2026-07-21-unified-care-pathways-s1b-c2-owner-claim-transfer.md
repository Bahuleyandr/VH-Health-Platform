# Unified Care Pathways S1b-c2 Owner Claim and Accepted Transfer — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-21-unified-care-pathways-s1b-c2-owner-claim-transfer-design.md`
**Base:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
**Branch:** `feat/care-pathways-s1b-c2-owner-acceptance`
**Migration:** `586_care_pathway_owner_acceptance.sql`

## Scope guard

Implement only database-current actor validation, generic/typed role-task claim, whole-runtime pathway
claim, current-owner transfer request/cancel, and exact-recipient read/accept/decline. Keep all pathway tenant modes
unchanged, keep production active execution unavailable, add no clinical time/recipient/visibility policy,
and do not touch Stroke/STEMI or frozen migrations 580-585.

## Task 1 — Pin RED authorization and concurrency tests

Files:

- extend `apps/backend/src/tests/unit/workflowHumanOwnerService.test.js`
- extend `apps/backend/src/tests/unit/taskService.test.js`
- extend clinical-inbox route/authorization suites
- extend pathway executor, patient-access and deep conformance suites

Steps:

1. Prove stale JWT role can currently list and role-ack a task.
2. Add RED tests for current-user validation, generic role claim, linked-SLA atomicity and claim races.
3. Add RED tests for whole-runtime pathway claim and exact accepted transfer.
4. Require precise typed errors and prove unauthorized probes do not receive task/patient details.

## Task 2 — Add migration 586 and Prisma parity

Files:

- add `apps/backend/src/migrations/586_care_pathway_owner_acceptance.sql`
- regenerate `apps/backend/prisma/schema.prisma`
- extend migration/schema conformance tests and seed overrides only if required

Steps:

1. Preflight the patient-access audit constraint and covering-handoff rows.
2. Add accepted-recipient evidence, exact FK/check/index contracts and audit source.
3. Add no repair, seed, mode change or clinical data backfill.
4. Prove migration ordering, Pattern-A tenancy compatibility and frozen 580-585 hashes.

## Task 3 — Centralize database-current actor validation

Files:

- modify `apps/backend/src/services/workflow/workflowHumanOwnerService.js`
- modify `apps/backend/src/services/workflow/taskService.js`

Steps:

1. Export a transaction-only same-tenant current actor resolver.
2. Require active/non-deleted state and exact agreement between current database role and authenticated
   context.
3. Use it for inbox listing, every direct acknowledgement mode, cold-chain acknowledgement/corrective
   action, and direct laboratory critical-alert acknowledgement before any PHI read or idempotent return.
4. Keep existing exact break-glass and trusted cold-chain authority, but bind their actor role to current
   database state.

## Task 4 — Add generic/typed task claim

Files:

- modify `apps/backend/src/services/workflow/taskService.js`
- modify `apps/backend/src/routes/clinicalInboxRoutes.js`
- update clinical-inbox OpenAPI and tests

Steps:

1. Add transaction-only task claim with role/current-actor/task/SLA locks and conditional writes.
2. Reject pathway-linked tasks so the generic operation cannot violate whole-runtime ownership.
3. Add idempotency receipt and state-change comment.
4. Make role acknowledgement name the current role holder atomically before acknowledgement.
5. Add `POST /tasks/:id/claim`; preserve the intentionally narrow inbox surface.

## Task 5 — Add executor-owned pathway claim

Files:

- modify `apps/backend/src/services/pathways/pathwayRuntimePersistence.js`
- modify `apps/backend/src/services/pathways/pathwayExecutorService.js`
- modify `apps/backend/src/routes/carePathwayRoutes.js`
- update care-pathway OpenAPI and tests

Steps:

1. Normalize and namespace claim input/fingerprint/idempotency.
2. Lock runtime, resolve exact current queue and revalidate the claimant from the database.
3. CAS instance, every actionable task and each incomplete SLA to one UID-only owner.
4. Append canonical immutable claim evidence in the same transaction.
5. Prove replay and race behavior without exposing another winner's PHI.

## Task 6 — Add request-and-decision transfer protocol

Files:

- add or extend a pathway ownership service under `apps/backend/src/services/pathways/`
- modify pathway persistence/executor/routes
- modify `apps/backend/src/services/security/accessPolicyRegistry.js`
- modify `apps/backend/src/services/security/accessDecisionService.js`
- update OpenAPI and tests

Steps:

1. Current owner creates one exact-recipient covering handoff with reason, linked UID-only review task and
   immutable request evidence; ownership remains unchanged.
2. Add exact current transfer-recipient read/decline relationships, the role-queue claim relationship,
   and their distinct audit sources.
3. Add a minimal exact-recipient GET surface for the reason and lifecycle state.
4. Exact recipient accepts; atomically CAS owner/live task/incomplete SLA/handoff/task completion and
   immutable evidence, retaining completed SLA owner history.
5. Exact recipient can decline with a reason; exact sender can cancel with a reason. Both settle the
   review task and append terminal evidence without changing the owner.
6. Prove no admin/role/system/break-glass implicit transfer, no automatic fallback/expiry, request replay
   survives target deactivation, and only acceptance is tied to the unchanged current step.

## Task 7 — Validate and publish the bounded slice

Run focused unit/deep suites first, then backend lint, raw-params, Prisma generation/check, OpenAPI check,
all backend test shards and relevant smokes/security checks. Perform final schema, authorization and
concurrency reviews on the complete diff. Commit and push one branch, open one PR, wait for required
GitHub checks, merge with a guarded head SHA while deployment is disabled, verify zero deployment run,
restore the workflow and resync local `main`. Do not sync Forgejo or deploy.
