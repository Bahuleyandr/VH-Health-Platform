# Unified Care Pathways S2a Result Release and Sign-off Safety — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-21-unified-care-pathways-s2a-result-release-signoff-safety-design.md`

**Base:** `2acff17b662fa91e11ffa870e402e247c05db8a7`

**Intended branch:** `feat/care-pathways-s2a-result-release-signoff-safety`

**Migration:** none; preserve 589 for S2b and 590 for the radiology/AP generation rail

## Scope guard

Close only the live patient-release bypasses, false-ready notifications, body-actor spoof and unsafe lab
sign-off command semantics defined in the design. Reuse the existing configured release predicate and
HTTP idempotency substrate. Do not implement D4/D5 closure, add a pathway definition, change a clinical
timing or recipient, infer historical classifications, touch Stroke/STEMI, add radiology/AP criticality,
flip a tenant mode, migrate a live database, deploy or notify an external party.

If a required invariant cannot be made safe without schema support, stop that part and place its exact
constraint in S2b migration 589. Do not allocate another migration.

## Task 1 — Pin the disclosure and actor failures RED

Files:

- extend `apps/backend/src/tests/portal-release.deep.test.js`
- extend patient-portal lab-order and PDF route suites
- extend generic investigation route/service suites
- extend lab sign-off deep/unit suites

Steps:

1. Prove held and delayed result text currently leaks from patient lab-order list/detail/PDF and generic
   investigation detail while `/portal/lab-results` denies it.
2. Prove sign-off and generic completion can currently queue a ready message while the release predicate
   is false.
3. Prove body `reviewed_by` currently becomes persisted/canonical actor identity.
4. Prove exact and concurrent sign-off retries currently create more than one sign-off/stamp.
5. Add RED matrices for cross-episode batches, stale state, illegal decisions and critical/abnormal/
   normal/indeterminate classification.

## Task 2 — Centralize the patient-release decision

Files:

- modify `apps/backend/src/services/portal/portalAccessService.js`
- modify `apps/backend/src/services/portal/patientPortalService.js`
- modify `apps/backend/src/routes/portal/patientPortalRoutes.js` as required
- modify `apps/backend/src/services/investigation/investigationService.js`
- modify `apps/backend/src/routes/investigation/investigationRoutes.js` as required
- modify `apps/backend/src/services/documents/clinicalPdfGenerator.js` or add a pre-authorized patient
  wrapper without weakening staff generation

Steps:

1. Add one parameterized SQL and row-level release decision derived from the same truth table.
2. Separate safe order logistics from result-bearing fields in list/detail responses.
3. Apply the decision to linked analytes and require whole-current-panel eligibility.
4. Authorize patient PDF generation before any document query or bytes are produced.
5. Make PATIENT generic-investigation reads use the same result-content gate; unsupported sources fail
   closed without losing safe order metadata.
6. Return non-disclosing not-found/denied shapes and test sequential-ID probes.

## Task 3 — Make release mutations and evidence atomic

Files:

- modify `apps/backend/src/services/portal/portalAccessService.js`
- extend canonical clinical platform and portal release tests only where necessary

Steps:

1. Refactor hold, unhold and explicit early release to accept/use a tenant transaction.
2. Lock the result, authorize the server actor, apply legal compare-and-set state and write the canonical
   timeline/audit pair in the same transaction.
3. Bind any idempotency receipt to actor, tenant, operation and request hash before returning an existing
   result.
4. Inject failures at the mutation/evidence boundaries and prove all-or-nothing behavior.

## Task 4 — Stop false-ready notifications

Files:

- modify `apps/backend/src/services/lab/labResultsService.js`
- modify `apps/backend/src/services/investigation/investigationService.js`
- extend notification-outbox and portal release tests

Steps:

1. Remove result-ready fan-out from sign-off/generic completion when visibility is not proven.
2. Permit post-commit ready fan-out only from a committed state for which the centralized predicate is
   true, including explicit early release.
3. Apply whole-panel eligibility and do not leak held item counts or classification in the message.
4. Do not add a delay sweep or recipient/wording policy in S2a; cover later eligibility in S2b.

## Task 5 — Remove caller-controlled reviewer identity

Files:

- modify `apps/backend/src/controllers/investigation/investigationController.js`
- modify `apps/backend/src/validators/investigation/investigationValidators.js`
- modify `apps/backend/src/services/investigation/investigationService.js`
- update OpenAPI contracts and investigation tests

Steps:

1. Remove `reviewed_by` as authority; reject or ignore it only as a documented compatibility assertion.
2. Reuse S1b-c2's database-current actor resolver; derive tenant, actor UID and current role before any
   idempotent or existence return.
3. Persist/canonically record the actual result recorder and label generic completion as technical
   completion, never D5 doctor review/countersignature.
4. Require an explicit trusted-workflow context for internal callers and audit that authority.

## Task 6 — Harden pathologist sign-off without a migration

Files:

- modify `apps/backend/src/routes/lab/labRoutes.js`
- modify `apps/backend/src/services/lab/labResultsService.js`
- extend HTTP idempotency, lab result and sign-off suites

Steps:

1. Require `Idempotency-Key` with a sign-off-specific scope and bind it to server signer plus request hash.
2. Normalize/deduplicate selected IDs and reject unsupported decisions before loading PHI.
3. Under one tenant transaction, lock rows and derive exactly one patient/source episode.
4. Enforce initial versus corrective legal states and use compare-and-set updates so retries cannot
   re-stamp or re-sign.
5. Derive `critical|abnormal|normal|indeterminate` from the complete locked set using the design
   precedence; validate newly entered flags and leave ambiguous history untouched.
6. Include episode/classification/hash evidence in the idempotent canonical sign-off event. Leave the
   immutable snapshot tables to S2b migration 589.
7. Preserve the existing atomic critical alert/task/SLA generation and authoritative acknowledgement.

## Task 7 — Align contracts and staff wording

Files:

- update affected backend OpenAPI schemas and examples
- update affected staff/patient Flutter models only if response shaping requires it
- update API contract tests

Steps:

1. Remove body actor fields as authority from documented request schemas.
2. Distinguish safe order metadata, released result content and staff-only technical provenance.
3. Return the derived episode classification/receipt to staff sign-off callers without exposing internal
   release facts to patients.
4. Do not add D4/D5 actions, domain-evidence acknowledgement or new patient wording in this slice.

## Task 8 — Run the safety gate

Run, in order:

1. focused portal release, lab sign-off, investigation, PDF and notification suites;
2. focused concurrency/idempotency and failure-injection suites;
3. raw-parameter, PHI, tenant/RLS and OpenAPI/core-sync checks;
4. Prisma/schema-drift checks to prove no migration/schema change occurred;
5. ESLint and the authoritative sharded backend gate.

Record the exact revision and every command/result. Keep every pathway mode unchanged and report S2a as
a live safety correction only. Diagnostics remains activation-blocked until S2b, owner-routing,
reconciliation and the standing governance policies have their own evidence.
