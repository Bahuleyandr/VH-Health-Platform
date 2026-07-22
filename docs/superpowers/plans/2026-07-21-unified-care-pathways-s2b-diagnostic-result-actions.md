# Unified Care Pathways S2b Diagnostic Result Generations and Actions — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-21-unified-care-pathways-s2b-diagnostic-result-actions-design.md`

**Base:** `2acff17b662fa91e11ffa870e402e247c05db8a7`

**Intended branch:** `feat/care-pathways-s2b-diagnostic-result-actions`

**Migration:** `589_diagnostic_result_generations_and_actions.sql`

**Separate reservation:** migration 590 for radiology/AP structured generations/amendments

## Scope guard

Implement immutable lab/shared-result generations, D4 normal closure/reopen, D5 and critical
doctor-signed actions, corrected-generation routing, pathway projection, staff action semantics and
reconciliation. Reuse the existing care-pathway runtime, tasks, SLAs, critical acknowledgement,
canonical timeline/audit, document-integrity and outbox/projector rails.

Do not build another workflow/reminder engine, revive `automation_rules`, add
`care_pathway_resource_links`, infer radiology/AP criticality, change Stroke/STEMI, add OBGyn-specific
logic, choose clinical timings/recipients/visibility, backfill ambiguous history, flip a production
tenant to `active`, migrate a live database, deploy or notify an external party.

## Task 1 — Pin the domain contracts RED

Files:

- add migration/schema conformance tests for diagnostic generations/actions
- add focused diagnostic classification/action service suites
- extend task/pathway/projector replay and concurrency suites
- add staff clinical-inbox model/widget tests

Steps:

1. Pin generation completeness, aggregate hash, source version/predecessor and classification precedence.
2. Pin RLS, composite tenant/patient FKs, append-only blockers, idempotency and exactly-one-signature
   behavior.
3. Prove D4 cannot close before authoritative release and D5/critical cannot close from release or generic
   acknowledgement.
4. Pin exact-owner/accepted-cover authorization and unnamed-role claim behavior.
5. Pin all correction transitions, including critical normalization and threshold-unavailable failure.
6. Prove projector/replay/action races yield one generation, task occurrence, action and signature.

## Task 2 — Add migration 589 and Prisma parity

Files:

- add `apps/backend/src/migrations/589_diagnostic_result_generations_and_actions.sql`
- regenerate `apps/backend/prisma/schema.prisma`
- extend migration ledger, schema-drift, RLS and database conformance suites

Steps:

1. Re-derive the migration tail immediately before implementation and fail on a 589 collision.
2. Add `diagnostic_result_generations`, `diagnostic_result_generation_items` and
   `diagnostic_result_actions` with the design's checks, hashes, composite FKs, indexes and uniqueness.
3. Add Pattern-A forced RLS and append-only update/delete blockers.
4. Add fixed diagnostic-action signature uniqueness, update/delete protection and the deferred
   same-tenant/patient signature requirement.
5. Add no clinical seed, repair, backfill, timing, tenant-mode or production activation write.
6. Prove clean install and Prisma parity. Leave migration 590 unused by this slice.

## Task 3 — Make document signing transaction-aware

Files:

- modify `apps/backend/src/services/clinical/documentIntegrityService.js`
- extend document integrity unit/deep suites

Steps:

1. Register fixed `diagnostic_result_action` metadata; never accept a table or key type from input.
2. Refactor lookup/signing into a `signDocumentTx` path that uses the caller's tenant transaction.
3. Keep the existing public `signDocument` wrapper behavior for current document types.
4. Preallocate the diagnostic signature/canonical IDs, bind signer identity to server context, hash the
   immutable action and insert a fully sealed signature with canonical evidence in the same transaction.
5. Prove an injected signature/evidence failure rolls back the entire action command.

## Task 4 — Build the immutable generation command

Files:

- add `apps/backend/src/services/diagnostics/diagnosticResultGenerationService.js`
- add focused classification/snapshot helpers under `services/diagnostics/`
- modify `apps/backend/src/services/lab/labResultsService.js`
- modify `apps/backend/src/services/investigation/investigationService.js`
- update the event catalog and producer tests

Steps:

1. Lock and normalize a complete source episode after S2a legal sign-off/completion.
2. Resolve source version, exact ordering owner, patient/encounter and predecessor.
3. Derive `critical|abnormal|normal|indeterminate` only from signed structured facts.
4. Insert immutable generation/items with deterministic item and aggregate hashes.
5. Append the canonical pair and publish `generation_signed` or `generation_corrected` through the same
   tenant transaction; payloads contain no result values or notes.
6. Refuse generic investigation types that map to radiology/AP until migration 590 registers their
   structured producers; do not route around that reservation.
7. Make exact replay hash-stable and fail changed-payload reuse as corruption.
8. Refuse orderless/mixed/unlinked sources and named-owner fallback; surface reconciliation blockers.

## Task 5 — Register the Diagnostics pathway/projector generation

Files:

- add the code-reviewed `diagnostics_order_to_action` definition/handlers under
  `apps/backend/src/services/pathways/`
- modify `apps/backend/src/services/events/pathwayProjectorRegistry.js` through its generation handoff
  mechanism
- extend event catalog/projector inbox/runtime conformance suites

Steps:

1. Register the Diagnostics event types in a fresh higher consumer generation; do not mutate frozen
   generation 1.
2. In `shadow`, record deterministic outcomes/reconciliation evidence without staff tasks or patient
   messages.
3. In gated execution, start/link one pathway occurrence per diagnostic generation.
4. Route normal, abnormal, critical and indeterminate branches exactly as the design specifies.
5. Use existing task/source/pathway fields; add no resource-link table or automation-rule row.
6. Prove fixed-cutoff replay and live intake produce the same idempotent outcome.

## Task 6 — Implement D4 release closure and reopen

Files:

- add `apps/backend/src/services/diagnostics/diagnosticResultActionService.js`
- extend `apps/backend/src/services/portal/portalAccessService.js` with transaction-safe eligibility use
- add a bounded release-eligibility command/scheduler registration using existing scheduler conventions
- add staff API routes/OpenAPI for doctor reopen

Steps:

1. Re-evaluate S2a's complete-generation release predicate under lock; never copy its logic.
2. Record one idempotent `normal_auto_closed` action and canonical pathway transition only when true.
3. Consume explicit early-release events and detect later configured eligibility without choosing a new
   cadence or delay.
4. Add exact-owner/accepted-cover doctor reopen with reason, linked prior closure and a new
   domain-evidence task.
5. Preserve prior evidence and make post-closure hold/reversal an activation blocker pending policy.
6. Prove repeated events/sweeps/reopens cannot duplicate or erase evidence.

## Task 7 — Implement doctor-signed D5/critical action

Files:

- modify `apps/backend/src/services/diagnostics/diagnosticResultActionService.js`
- add clinical-inbox/result-action routes and OpenAPI schemas
- extend `apps/backend/src/services/workflow/taskService.js` only through its registered
  domain-evidence completion contract
- extend pathway executor/owner authorization integration

Steps:

1. Require idempotency, exact current generation and current D10 owner/accepted cover (or claimed
   genuinely unnamed queue).
2. Validate `treated|repeated|referred|no_action`, mandatory note/reason, the exact attested generation
   snapshot hash and typed downstream evidence.
3. In one tenant transaction write canonical evidence, immutable action, document signature, task/
   pathway transition and minimal-PHI outbox event.
4. Complete only a registered domain-evidence obligation. Preserve the existing critical
   acknowledgement-semantic SLA and require the subsequent action for pathway closure.
5. Reject generic ADMIN, body actor, generic task acknowledgement, patient release and unlinked notes as
   countersignature/action evidence.
6. Prove every injected failure rolls back all state and exact replay returns one receipt.

## Task 8 — Replace blind correction re-ack routing

Files:

- modify `apps/backend/src/services/lab/labCriticalAlertService.js`
- modify correction/sign-off adapters in `apps/backend/src/services/lab/labResultsService.js`
- extend critical-generation, task/SLA and diagnostic action suites

Steps:

1. Create/link the new immutable generation before deciding work.
2. Route newly/still-critical to a fresh existing critical acknowledgement generation.
3. Route abnormal noncritical to D5 action, normal correction to doctor re-review without a critical SLA,
   and indeterminate/threshold-unavailable to fail-safe clinician review.
4. Explicitly supersede prior open obligations while preserving acknowledgement/escalation/action/
   release evidence.
5. Prove no completed SLA is reused and no unsupported task-machine reopen edge is invoked.

## Task 9 — Add safe staff action semantics

Files:

- modify `apps/staff/lib/core/services/clinical_inbox_api_service.dart`
- modify `apps/staff/lib/features/clinical_inbox/screens/clinical_inbox_screen.dart`
- modify `apps/staff/lib/features/investigations/screens/investigations_screen.dart`
- add/extend staff API models, action form widgets and tests

Steps:

1. Parse and retain `sla_completion_semantics`, generation, classification, correction and ownership
   metadata.
2. Show critical acknowledgement only for acknowledgement-semantic work; keep its doctor-action step.
3. Show **Review and record action** for domain-evidence work and remove generic acknowledgement there.
4. Add the four-value disposition form, mandatory note, typed evidence and electronic attestation.
5. Add doctor reopen to eligible normal result detail and an authorized unowned/unreviewed-results queue.
6. Show named-owner routing blockers; never present a role fallback for a named unavailable doctor.
7. Add no patient “discussed”, acknowledgement or notification wording before policy approval.

## Task 10 — Add reconciliation and end-to-end journeys

Files:

- extend the S1b-c3 reconciliation registry/checks
- add `apps/backend/src/tests/journeys/diagnostics-order-to-action.journey.test.js`
- extend `apps/backend/src/tests/journeys/lab-walk-in.journey.test.js` only where shared setup is useful
- add failure-injection and replay fixtures

Steps:

1. Reconcile source/generation/items/hash, outbox/projector/pathway, owner/task/SLA and
   action/signature/canonical evidence.
2. Treat unsupported classifications, missing owners, orderless sources and policy-unknown release
   reversals as blockers; never auto-repair clinical meaning.
3. Cover normal release/auto-close/reopen/disposition, abnormal disposition, critical ack plus action and
   the full correction matrix.
4. Inject projector, outbox, notification and signature failures and assert exact states.
5. Record metrics from evidence without adding targets or clocks.

## Task 11 — Run the non-activation release gate

Run, in order:

1. migration 589 fresh PostgreSQL build and database/RLS/append-only/deferred-constraint conformance;
2. focused diagnostic generation/action/signature/owner/task/SLA/projector suites;
3. S2a portal release regression and critical-result deep suites;
4. Diagnostics and lab journeys plus concurrency/replay/failure injection;
5. raw-parameter, PHI, tenant, event-catalog, OpenAPI/core-sync, Prisma and schema-drift checks;
6. staff Flutter analyze/test for touched packages;
7. ESLint and the authoritative sharded backend gate;
8. the owner-approved clean-streak evidence set in a non-production evidence environment; if no streak
   policy is signed, report the observations without inventing a count.

Record exact revision, commands and outcomes. Keep all production Diagnostics modes unchanged. Passing
the slice proves the lab/shared result action loop is build-complete under the tested scope; it does not
approve radiology/AP migration 590, standing clinical policies, production activation or deployment.
