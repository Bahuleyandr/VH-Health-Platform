# Unified Care Pathways S4 — OP + Inpatient Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-23-unified-care-pathways-s4-op-inpatient-design.md`  
**Baseline:** `2cf14b2329867fe8706b3316d407468768bd32ab`  
**Branch:** `feat/care-pathways-s4-op-inpatient`  
**Safety boundary:** build and verify only; no tenant activation, deployment, notification dispatch, or heuristic clinical backfill

## Phase 0 — Pin and prove the baseline

- [ ] Confirm the branch is based on the pinned merged S3 SHA and the worktree is clean.
- [ ] Confirm migration 595 remains next-free immediately before adding it.
- [ ] Add RED tests for migration objects, append-only behavior, tenant/patient resolvers, frozen registry membership, and mode behavior.
- [ ] Add RED journey cases for OP completion, D3 discharge ownership, and OP-to-IP lineage.

Gate: the new tests fail for the intended missing behavior, not from fixture or environment errors.

## Phase 1 — Migration 595 and typed lineage

- [ ] Add constrained resource/evidence types and `care_pathway_resource_references`.
- [ ] Add composite pathway/patient integrity, forced RLS, indexes, idempotency, and update/delete blockers.
- [ ] Add OP closure evidence, primary-physician assignment, pending-result handoff, post-discharge contact evidence, and durable OP-to-IP source linkage.
- [ ] Update Prisma schema without weakening migration-only checks/triggers.
- [ ] Implement the closed tenant/patient resource resolver and append-only reference service.
- [ ] Prove replay, correction/supersession, cross-tenant rejection, and no heuristic backfill.

Gate: fresh migration, schema-drift check, Prisma validation/generation, migration unit/deep tests.

## Phase 2 — Frozen pathway adapters

- [ ] Add OP and Inpatient v1 definition modules and checksum tests.
- [ ] Add registered domain-evidence handlers with no free expressions or numeric policy targets.
- [ ] Add OP and Inpatient source-event projectors and deterministic idempotency keys.
- [ ] Append workflow runtime registry v4 while preserving v1-v3 exactly.
- [ ] Append projector generation 4 while preserving generations 1-3 exactly.
- [ ] Append reconciliation registry v5 and OP/IP vertical checks.
- [ ] Add dry-run-first definition registration scripts requiring explicit owner sign-off.

Gate: definition compiler, frozen registry, replay, delivery, reconciliation, and conformance suites.

## Phase 3 — OP domain integration

- [ ] Add one tenant-scoped, row-locked appointment transition seam with an explicit graph.
- [ ] Route supported generic and dedicated lifecycle mutations through it.
- [ ] Emit status history, canonical timeline/audit, and outbox evidence atomically.
- [ ] Emit checked-in evidence from the authoritative check-in transaction.
- [ ] Record clinician disposition, safe next steps, follow-up link, closure basis, and accepted transfer.
- [ ] Add a typed unresolved-visit-work read model and active-mode completion guard.
- [ ] Keep shadow observational; no S4 task, notification, or terminal block in shadow.
- [ ] Preserve replacement reschedule and no-show recovery evidence.

Gate: appointment deep tests, OP journey, tenant/CAS/idempotency tests, route error propagation.

## Phase 4 — Inpatient domain integration

- [ ] Eliminate the weaker parallel quick-admit behavior by delegating or limiting it to bed assignment after canonical acceptance.
- [ ] Persist exact originating OP appointment and accepted cross-pathway handoff.
- [ ] Persist/validate the current named primary physician and accepted coverage changes.
- [ ] Build one typed, tenant-scoped pending-result collector covering Lab/Investigation, Radiology, and Anatomical Pathology.
- [ ] Persist discharge-time pending-result handoffs and signed-summary inclusion evidence.
- [ ] Change active-mode readiness from “pending blocks” to “missing handoff blocks”; keep off legacy behavior and shadow evidence-only.
- [ ] Correlate result availability to the discharge handoff and create a linked owner action without replacing the diagnostic owner.
- [ ] Require formal medication reconciliation and admission-scoped follow-up booking or audited exception in active mode.
- [ ] Add a transactional legacy/structured summary identity adapter.
- [ ] Mirror canonical admission/discharge events into the transactional outbox.
- [ ] Record policy-neutral post-discharge contacts and seven-day readmission linkage without inventing a timer.

Gate: admission/discharge deep tests, diagnostics correlation tests, full inpatient journey, OP-to-IP handoff journey.

## Phase 5 — Staff and patient product seams

- [ ] Add typed staff pathway work models and API service.
- [ ] Render unresolved OP work before appointment completion and re-check server state on completion.
- [ ] Render pending-result ownership and blockers in Discharge Hub and signed-summary review.
- [ ] Add relationship/blocking/named-owner fields to Command Board task items.
- [ ] Extend patient “What’s Next” with allowlisted safe next steps only.
- [ ] Add signed-summary pending-result rendering without widening clinical-note visibility.
- [ ] Add all required localisation keys and guards.
- [ ] Keep terminal/accountability mutations online-only.

Gate: focused Flutter model/widget tests, i18n guards, analyzer for touched packages.

## Phase 6 — Contracts, operations, and final verification

- [ ] Update backend OpenAPI and the shared mirrored specification.
- [ ] Update comprehensive test seed data without activating a real tenant pathway.
- [ ] Add registration/reconciliation operator commands to backend package scripts.
- [ ] Run focused backend tests after each phase.
- [ ] Run fresh PostgreSQL migrations, migration drift, Prisma validation/generation, OpenAPI validation, raw-parameter checks, lint, authoritative backend shards, smoke/FHIR gates, and focused Flutter tests/analyzers.
- [ ] Review the complete diff for PHI leakage, cross-tenant access, actor provenance, mode races, lock ordering, and accidental activation.
- [ ] Push the scoped branch, open one S4 pull request, and monitor all required checks. Do not deploy or activate.

Final gate: all authoritative checks are green, the worktree is clean after commit, no tenant setting is changed, and the pull request clearly lists any policy-dependent behavior that remains intentionally dormant.
