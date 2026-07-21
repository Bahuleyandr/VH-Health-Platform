# Unified Care Pathways S2a — Result Release and Sign-off Safety Design

**Status:** implementation design; live safety correction with pathway activation held

**Grounding revision:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
(`2026-07-21T13:19:50+05:30`)

**Intended branch:** `feat/care-pathways-s2a-result-release-signoff-safety`

**Migration:** none. Migration 589 is reserved for S2b diagnostic generations/actions; migration 590 is
reserved separately for the radiology/AP generation rail.

**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

**Implementation dependency:** reuse S1b-c2's database-current actor resolver when it lands

**Activation dependencies:** S1b-c owner integrity and reconciliation evidence, then S2b

## 1. Outcome and safety boundary

S2a closes the patient-result release bypasses and untrusted-actor seams that must not be carried into
the Diagnostics pilot. It makes one existing, approved release predicate authoritative for every
patient-facing lab result representation; makes hold/early-release evidence atomic; removes
caller-supplied reviewer identity; and makes pathologist sign-off idempotent, state-aware,
episode-scoped and explicitly classified.

This slice does **not** implement D4/D5 closure, activate `diagnostics_order_to_action`, add a pathway
definition, create a clinical SLA, choose a new release delay, decide patient/guardian notification
policy, or backfill clinical meaning. It preserves the currently configured release predicate:

- a result is signed/final;
- it is not held; and
- it was explicitly released under existing authority or the configured release delay has elapsed.

The configured value is not a new clinical approval. S2a merely ensures that every patient read and
every “ready to view” message obeys the same predicate. Any patient-facing source without enough
structured state to prove that predicate fails closed for result content while retaining safe order
metadata.

S2a is deliberately migration-free. It uses the existing HTTP idempotency ledger, conditional writes,
transactions and canonical evidence. If implementation proves that an exact invariant cannot be made
safe without a database constraint, that constraint is added to S2b migration 589 and S2a remains a
dependency; no new migration number is taken.

## 2. Verified baseline defects

The following are repository facts at the grounding revision. File-and-symbol identity is normative;
line numbers are evidence anchors and may drift.

### 2.1 One correct predicate, several patient-visible bypasses

- `releaseVisibilitySql` requires no hold plus either explicit release or elapsed configured delay
  (`apps/backend/src/services/portal/portalAccessService.js:23-37`).
- The dedicated `/portal/lab-results` list and detail apply that predicate
  (`apps/backend/src/services/portal/patientPortalService.js:2028-2069`).
- `/portal/lab-orders` nevertheless selects `result_summary`, `conclusion`, `notes` and `file_key`
  without a result-field/release decision
  (`apps/backend/src/services/portal/patientPortalService.js:1900-1941`).
- `/portal/lab-orders/:id` exposes `results`, `structured_results`, `interpretation`, summary/conclusion
  and signed `lab_results` rows without the delay/hold predicate
  (`apps/backend/src/services/portal/patientPortalService.js:1944-1997`).
- `/portal/lab-orders/:id/pdf` checks patient ownership, then invokes the shared PDF generator without
  release authorization (`apps/backend/src/services/portal/patientPortalService.js:2000-2025`;
  `apps/backend/src/routes/portal/patientPortalRoutes.js:556-599`). The generator checks final/sign-off
  state, not patient release eligibility
  (`apps/backend/src/services/documents/clinicalPdfGenerator.js:359-375`).
- A PATIENT may also call the generic investigation detail endpoint. It returns the investigation row
  and removes only doctor contact fields, not unreleased result content
  (`apps/backend/src/routes/investigation/investigationRoutes.js:42-67`;
  `apps/backend/src/services/investigation/investigationService.js:331-375`;
  `apps/backend/src/config/rbacConfig.js:299-319`).

These are independent PHI disclosure paths. Fixing only the dedicated lab-result screen is therefore
insufficient.

### 2.2 Release writes and messages can disagree with visibility

- Hold/unhold and early-release mutate `lab_results`, then append audit through separate database calls;
  they do not commit or roll back as one operation
  (`apps/backend/src/services/portal/portalAccessService.js:42-122`).
- A verified lab sign-off immediately tells the patient that results are “ready to view” even when the
  configured delay has not elapsed or the row is held
  (`apps/backend/src/services/lab/labResultsService.js:2042-2071`).
- Generic investigation completion likewise queues a result-ready notification without evaluating a
  release predicate (`apps/backend/src/services/investigation/investigationService.js:909-919,995-1006`).

A notification is not authorization. It must never assert visibility that the subsequent patient read
will deny, nor reveal the existence or state of held content under an unresolved visibility policy.

### 2.3 Generic result submission trusts a body actor

- The controller forwards `reviewed_by` from the request body
  (`apps/backend/src/controllers/investigation/investigationController.js:341-364`).
- Validation proves only that it is a string
  (`apps/backend/src/validators/investigation/investigationValidators.js:62-68`).
- `addResults` writes that value to `verified_by` and uses it in canonical evidence
  (`apps/backend/src/services/investigation/investigationService.js:759-760,867-947`).
- LAB_STAFF is allowed to submit results (`apps/backend/src/config/investigationConfig.js:72-90`).

Therefore a result recorder can attribute verification to an arbitrary UID, and the current
`COMPLETED`/`verified_by` fields cannot be treated as the D5 doctor countersignature.

### 2.4 Lab sign-off lacks a closed command contract

- `abnormal_flag` is a free `VARCHAR(10)` whose comment lists `L/H/LL/HH/N/A/AA`, with no check
  constraint (`apps/backend/src/migrations/151_lab_results_and_alerts.sql:30-60`). Manual entry accepts
  the caller value unchanged (`apps/backend/src/services/lab/labResultsService.js:1504-1509,1639-1655`).
- Structured panels calculate `N/L/H/LL/HH` from reference ranges, but that does not make manual or
  external flags trustworthy (`apps/backend/src/services/lab/labPanelService.js:353-371`).
- `lab_pathologist_signoffs.decision` is also an unchecked string
  (`apps/backend/src/migrations/151_lab_results_and_alerts.sql:142-155`).
- The sign-off route has no required `Idempotency-Key`, although manual result entry does
  (`apps/backend/src/routes/lab/labRoutes.js:186-203,244-278`).
- `signOffResults` does not load current result status, inserts a fresh sign-off on every retry and
  re-stamps every selected row (`apps/backend/src/services/lab/labResultsService.js:1854-2032`).
- It proves only that selected rows share a patient. Rows from different investigations/orders may be
  signed in one batch (`apps/backend/src/services/lab/labResultsService.js:1920-1959`).
- The sign-off stores mutable result IDs, not an immutable value/classification snapshot
  (`apps/backend/src/migrations/151_lab_results_and_alerts.sql:143-155`). S2b, not S2a, supplies that
  durable generation model.

### 2.5 Existing coverage does not protect the bypasses

The current deep release suite proves only the dedicated `/portal/lab-results` surfaces
(`apps/backend/src/tests/portal-release.deep.test.js:115-176`). It does not exercise the patient order
list/detail/PDF, generic investigation detail, false-ready notifications, body-actor spoofing, duplicate
sign-off, cross-episode sign-off or concurrent sign-off races.

## 3. Authoritative patient-release contract

### 3.1 One decision service

`portalAccessService` owns one result-release decision API with both a parameterized SQL predicate and a
row evaluator derived from the same truth table. A caller cannot reconstruct the policy with
`status='final'`, `signed_off_at IS NOT NULL`, or any local approximation.

The decision has only these externally useful outcomes:

- `visible`: the existing predicate is currently true;
- `not_visible`: the predicate is false; or
- `unsupported_source`: the source lacks the structured release facts required to decide.

Patient routes map both non-visible outcomes to non-disclosing behavior. Order metadata may remain
visible, but result-bearing columns, attachments and derived summaries do not. Staff routes retain their
existing clinical access checks and are not made patient-visible by this work.

### 3.2 Every patient representation uses it

The shared decision is mandatory for:

1. `/portal/lab-results` list/detail;
2. `/portal/lab-orders` list result-bearing projections;
3. `/portal/lab-orders/:id` investigation fields and linked analytes;
4. `/portal/lab-orders/:id/pdf` before any binary is generated;
5. PATIENT access through generic investigation routes;
6. any proxy/guardian variant of those reads; and
7. any “ready”, “available”, corrected-result or download notification.

List routes keep only explicitly classified safe order logistics visible and return no result content,
unclassified clinical notes or result attachments until the result episode is eligible. Detail/PDF
routes return the repository's generic not-found/denied shape for unreleased content so callers cannot
use sequential IDs to distinguish held, delayed and absent results.

For a multi-analyte report, patient release is panel-safe: no PDF, result-bearing order detail or “ready”
message is produced until every current signed analyte included in that representation satisfies the
predicate. A caller may not select the released subset and accidentally imply that a partial panel is the
complete report.

### 3.3 Atomic hold and early release

Hold, unhold and explicit early release execute in one tenant transaction. The service locks the result,
authorizes the actor before any idempotent/existence return, performs a legal compare-and-set mutation,
and appends the required canonical timeline and audit pair in that transaction. A write without its
evidence, or evidence without its write, rolls back.

The existing authority and reason requirements remain unchanged. S2a adds no new role, override,
timing or patient policy. It records the server-derived actor and prior/current release facts; it never
accepts an actor UID from the body.

### 3.4 Notification contract

Result-ready notification fan-out occurs only after commit and only when the authoritative predicate was
true in the committed state. Explicit early release may therefore queue a ready message after its
transaction commits. A sign-off that remains delayed or held queues no ready message.

S2a does not invent a polling cadence for later delay eligibility. Until S2b's idempotent
release-eligibility action/sweep exists, absence of that later message is safer than a false-ready message.
Patient/guardian recipient rules, delivery meaning and corrected-result wording remain governance-gated.

## 4. Server-owned actor semantics

All result-write and sign-off commands derive actor UID, current role and tenant from authenticated
server context. `reviewed_by`, `verified_by`, `signed_off_by` and equivalent body actor fields are rejected
or ignored as compatibility assertions; they are never persisted as authority.

Generic investigation submission records the authenticated result recorder. Technical completion or
laboratory verification does **not** mean that a doctor reviewed, countersigned or chose a D5 action.
S2b creates separate immutable doctor-signature/action evidence. Existing fields may continue to carry
technical provenance, but no pathway handler, task closure, patient copy or metric may interpret them as
the D5 countersignature.

Authorization is resolved before an idempotent return and before PHI-bearing existence details, matching
the shipped clinical-inbox acknowledgement safety boundary. Internal callers must pass an explicit,
audited trusted-workflow context; they cannot synthesize a human reviewer.

## 5. Sign-off command contract

### 5.1 Idempotency and decisions

`POST /lab/pathologist/signoff` requires `Idempotency-Key`. The existing HTTP idempotency ledger binds
the key to tenant, route scope, authenticated signer and request-body hash. An exact replay returns the
original result; a reused key with a different actor, selected set or payload fails. A concurrent replay
creates one sign-off and one canonical evidence pair.

The service accepts only explicitly implemented commands:

- `verified` for initial sign-off; and
- `corrected` or `amended` for a new corrective generation.

Any other string fails closed. A rejection workflow, if clinically required, must be specified as its own
state transition rather than masquerading as a signed/final generation.

### 5.2 Legal states and compare-and-set

Initial `verified` sign-off locks every selected row and requires each to be unsigned and in the existing
preliminary state. The conditional update includes that state predicate; a stale or competing signer
receives a conflict and does not create a second sign-off.

A corrective command requires an already signed current generation plus the repository's explicit
correction/re-run provenance. Repeating a corrective label over an unchanged set is not a new generation.
The command must prove a predecessor and a changed source version/snapshot before it records a new
sign-off. S2a may preserve current correction storage, but it cannot create D4/D5 action evidence; S2b
makes generations immutable and links their predecessors.

Cancelled rows, unsigned correction targets, mixed initial/corrective states and partially stale batches
fail atomically. A retry never re-stamps `signed_off_at` or changes the original signer.

### 5.3 One source episode per sign-off

Every selected row must resolve to one source episode under lock:

1. use the exact `investigation_id` when present;
2. otherwise use one exact `booking_id`; and
3. reject unlinked rows, mixed fallback types, or more than one episode.

All rows must still share tenant and patient. A compatibility `patient_uid` or `booking_id` supplied by
the client is assertion-only and must exactly match the derived episode; it never selects authority.

### 5.4 Explicit signed classification

S2a derives one episode classification from the locked rows and records it in canonical sign-off evidence.
S2b persists the immutable item snapshot and classification in migration 589. The precedence is:

1. `critical` if any current signed item is explicitly critical;
2. `abnormal` if none is critical and any current signed item has an explicitly supported abnormal flag;
3. `normal` only when every current signed item is explicitly normal; and
4. `indeterminate` for missing, unsupported, contradictory or untrusted classification facts.

Absence of a critical flag is never evidence of normality. Free text, order priority, AI output and an
unknown `abnormal_flag` never upgrade an episode to normal. A panel is classified only after all current
items for that episode are final/signed; partial or uncertain panels remain `indeterminate` and cannot
take the D4 auto-close branch.

S2a validates newly written manual flags against the supported source vocabulary. It does not rewrite or
guess historical flags. An indeterminate episode remains available to staff under existing access rules
but is an activation/reconciliation blocker until a clinician establishes a signed generation under S2b.

## 6. API and staff semantics

Patient API responses do not expose `release_hold`, internal classification rationale, hidden-result
counts or other side channels. Safe order-state fields remain distinguishable from result content.

Staff sign-off responses add the derived episode key, normalized classification and idempotent receipt.
They label generic investigation completion as recorded/technically verified, not “doctor reviewed”.
No S2a screen offers D4 auto-close, D5 disposition or generic acknowledgement for a future
domain-evidence task; those belong to S2b.

## 7. Failure, coexistence and rollout rules

- Every patient-result path fails closed if release state cannot be resolved.
- Clinical sign-off and result storage remain authoritative even if an outward notification fails.
- S2a does not modify the existing critical-result alert/task/SLA acknowledgement rail.
- Stroke/STEMI remain untouched under D8. OBGyn consumes the shared rails later under D9.
- Radiology/AP structured classification and correction generations are not inferred here; migration 590
  remains separately reserved for them.
- All tenant pathway modes remain unchanged. Diagnostics cannot enter `active` from this slice.
- No historical patient notification, result classification or clinical backfill runs automatically.

## 8. Required tests and exit evidence

The implementation is incomplete until tests prove:

1. held/delayed lab content is absent from patient order list, order detail, PDF, dedicated result and
   generic investigation routes, including proxy/guardian variants;
2. an explicitly/elapsed eligible result appears consistently on every approved patient surface;
3. a multi-item panel cannot leak a partial unreleased report;
4. hold/unhold/early-release mutations and canonical timeline/audit evidence are atomic under injected
   failures;
5. sign-off and generic completion do not queue a false-ready notification;
6. a body `reviewed_by` cannot change persisted or canonical actor identity;
7. exact sign-off replay returns one receipt, changed-payload key reuse fails, and two concurrent signers
   cannot create two initial sign-offs;
8. mixed-patient, mixed-episode, unlinked, illegal-state and unsupported-decision batches fail without a
   partial stamp;
9. classification precedence covers critical, abnormal, all-normal, partial, contradictory and unknown
   flags; and
10. existing critical acknowledgement, staff result access and configured release behavior remain green.

Exit evidence includes focused unit/deep suites, portal security tests, investigation/lab tests, raw-SQL
parameter checks, PHI/tenant checks, OpenAPI/schema drift where touched, ESLint and the repository's
authoritative backend gate. Passing S2a is a live safety claim only; it is not Diagnostics activation
evidence.
