# Unified Care Pathways S2b — Diagnostic Result Generations and Actions Design

**Status:** implementation design; Diagnostics pilot remains activation-gated

**Grounding revision:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
(`2026-07-21T13:19:50+05:30`)

**Intended branch:** `feat/care-pathways-s2b-diagnostic-result-actions`

**Migration reservation:** `589_diagnostic_result_generations_and_actions.sql`

**Separate reservation:** migration 590 for radiology/AP structured generation and amendment rails

**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

**Dependencies:** S2a release/sign-off safety; S1b-c2 owner claim/accepted transfer; S1b-c3
reconciliation evidence; the S1 projector/runtime spine

## 1. Outcome and clinical boundary

S2b implements the lab/shared-result portion of `diagnostics_order_to_action` without creating a second
workflow engine. It introduces immutable, signed diagnostic result generations and an append-only action
ledger; projects every human accountability stage into the existing `tasks`/SLA/pathway spine; and
implements the owner-approved D4 and D5 closure rules:

- a signed/final, explicitly normal generation may close automatically only after the authoritative
  release predicate is actually true, with an audited doctor reopen path that preserves the closure;
- an abnormal noncritical generation closes only after the named doctor reviews, countersigns and records
  `treated|repeated|referred|no_action` with a note; patient release never closes it; and
- a critical generation retains the existing named-clinician acknowledgement/escalation rail and also
  requires a doctor-signed action before the diagnostic pathway closes.

Every addendum/correction is a new immutable generation linked to its predecessor and is routed from its
new signed classification. The design explicitly prevents the current “every correction reopens a
critical window” behavior.

This slice adds no clinical timing, threshold, business-hours rule, escalation recipient, patient/
guardian visibility rule, external-provider communication method, break-glass authority, backfill scope
or retention period. It does not activate Diagnostics for a production tenant. It does not alter
Stroke/STEMI authority, build OBGyn-specific rails, or implement radiology/AP classification; migration
590 is reserved for that separate adapter work.

## 2. Verified baseline and missing domain evidence

### 2.1 The owner-approved closure contract is not represented

The normative program requires named-doctor review, countersignature and structured action for abnormal
noncritical results, and permits normal auto-closure only after release with an audited reopen
(`docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md:551-578,590-603,920-921`).

The live schemas have result/sign-off records and the critical acknowledgement rail, but no immutable
diagnostic generation, no orderer-disposition record, no D4 closure/reopen evidence and no doctor-signed
D5 action. Generic investigation `COMPLETED`/`verified_by` is technical provenance and may be written by
LAB_STAFF (`apps/backend/src/config/investigationConfig.js:72-90`;
`apps/backend/src/services/investigation/investigationService.js:759-760,867-947`); it is not the D5
countersignature.

Generic result submission classifies only a binary critical signal, emits `result_ready` for every other
case and materializes accountable work only for the critical branch
(`apps/backend/src/services/investigation/investigationService.js:909-990`). It cannot distinguish an
abnormal noncritical result from a normal one and has no D5 action concept.

### 2.2 Critical acknowledgement is real and remains authoritative

The existing results inbox binds critical-result tasks to `critical_result_ack`; its task carries
`sla_completion_semantics='acknowledgement'`
(`apps/backend/src/services/results/resultsInboxService.js:382-453,587-712`). The dedicated lab critical
command authoritatively joins alert, task, SLA and evidence; generic acknowledgement is constrained by
task semantics (`apps/backend/src/services/lab/labResultsService.js:2498-2609,2755-2819`;
`apps/backend/src/services/workflow/taskService.js:971-996,1105-1109`).

S2b does not replace that rail or treat acknowledgement as clinical action. A critical task may move to
in-progress and stop its acknowledgement clock, but the pathway remains open until the dedicated
doctor-action command records domain evidence.

### 2.3 Corrective routing currently overstates criticality

The lab correction path calculates `critical`, `withinThreshold` and `thresholdUnavailable`, but when a
predecessor exists it still invokes `ensureCriticalResultTaskOpen` with critical severity and a forced new
acknowledgement window for every correction
(`apps/backend/src/services/lab/labCriticalAlertService.js:492-525`). That behavior is wrong for a
critical result corrected to normal, an abnormal-noncritical correction, and an indeterminate result.

The S1b-b critical-generation work remains valuable and immutable. S2b routes a newly or still-critical
generation into it, but never reuses a critical SLA to represent ordinary doctor re-review.

### 2.4 Existing signing cannot be joined to an action transaction

`clinical_document_signatures` already stores a content hash, signer and audit reference
(`apps/backend/prisma/schema.prisma:15608-15630`). However:

- `SIGNABLE_DOCUMENTS` has no diagnostic action type
  (`apps/backend/src/services/clinical/documentIntegrityService.js:23-57`);
- document lookup uses the global client (`apps/backend/src/services/clinical/documentIntegrityService.js:75-98`);
  and
- `signDocument` opens its own tenant transaction
  (`apps/backend/src/services/clinical/documentIntegrityService.js:104-183`).

It therefore cannot currently guarantee that action, signature, task closure, pathway transition,
canonical evidence and outbox publication commit together.

### 2.5 Staff clients expose only generic acknowledgement

The investigation screen is effectively read-only at the result-review stage
(`apps/staff/lib/features/investigations/screens/investigations_screen.dart:1668-1874`). The clinical
inbox client and screen expose a generic acknowledge action
(`apps/staff/lib/core/services/clinical_inbox_api_service.dart:10-58,81-130`;
`apps/staff/lib/features/clinical_inbox/screens/clinical_inbox_screen.dart:104-127,203-226`). Although
the backend returns `sla_completion_semantics`
(`apps/backend/src/services/workflow/taskService.js:623-630`), the Flutter model discards it. A D5 task
would therefore invite the wrong action unless the staff semantics change.

### 2.6 The event spine needs a new registered generation

Lab sign-off and generic investigation completion do not currently publish source events to
`event_outbox`. `publishEvent` can participate in a caller transaction and propagates failures when one
is supplied (`apps/backend/src/services/events/eventOutboxService.js:34-107`). The current pathway
projector generation is an exact frozen six-event registration
(`apps/backend/src/services/events/pathwayProjectorRegistry.js:11-18,43-50`). Diagnostics events must
enter a new registered consumer generation/handoff; mutating generation 1 would violate replay
determinism.

### 2.7 Existing journey coverage stops before closure

The lab walk-in journey stops at pathologist sign-off even in its critical scenario
(`apps/backend/src/tests/journeys/lab-walk-in.journey.test.js:1-19,302-363`). It does not prove patient
release, normal closure/reopen, abnormal/critical doctor action or corrected-generation routing.

## 3. Domain model and invariants

Migration 589 adds three domain tables. They are clinical evidence, not a parallel workflow engine.
Mutable execution remains solely in `workflow_runs`, `workflow_steps`, `care_pathway_instances`, `tasks`
and `workflow_sla_instances`; source links use the existing polymorphic task fields and pathway episode
context, so `care_pathway_resource_links` is not reintroduced.

### 3.1 `diagnostic_result_generations`

One row represents the complete signed/current result episode version consumed by the pathway. Required
facts include:

- UUID `id`, `tenant_id`, `patient_uid` and optional canonical `encounter_id`;
- constrained `source_kind`, `source_table`, source episode type/key and positive source version;
- exact ordering-owner UID when one was named, plus the owner-source code;
- sign-off identity/time and the source sign-off/reference ID;
- `classification` constrained to `critical|abnormal|normal|indeterminate`;
- a JSON-object classification basis containing source facts, never free-text inference;
- a SHA-256 snapshot hash;
- nullable predecessor generation ID within the same tenant/patient/source episode; and
- immutable creation/canonical evidence references.

The unique identity is `(tenant_id, source_kind, source_episode_key, source_version)`. A second payload
for that identity must have the same hash or fail as corruption; it is never silently accepted as an
idempotent replay. Migration 589 constrains source kinds to the exact lab/shared-result adapters built in
S2b. Migration 590 must explicitly extend that constraint and register the radiology/AP producers and
projector handlers; a generic investigation type cannot bypass that boundary.

The adapter supplies the version identity from immutable source provenance: generic investigations use
their positive `result_version`; lab panels use the exact pathologist sign-off ID for that signed
generation. The latter need not be consecutive within an episode, but it must increase across the
validated predecessor chain. Timestamps are never version keys.

Generation rows are append-only. A correction inserts a higher version and predecessor link; it never
updates, deletes or reclassifies the old row.

The source transaction cannot know the asynchronously projected pathway instance. It therefore does not
leave a nullable pathway FK to be backfilled later. The projector creates `care_pathway_instances` with
the generation as its existing source resource; reverse lookup uses that indexed source identity.
Actions, which occur after projection, carry both generation and pathway IDs. This preserves immutable
generations without reintroducing a resource-link table.

### 3.2 `diagnostic_result_generation_items`

Each row freezes one analyte/source item used to classify the generation:

- generation/tenant/patient identity;
- fixed source table and source row/version reference;
- stable code/name and a bounded JSON value/unit/reference-range snapshot;
- normalized source flag, source critical fact and signed item classification;
- item snapshot SHA-256; and
- deterministic ordinal/source index.

The generation/item tenant and patient must match through composite foreign keys. Items are unique by
generation plus exact source identity and deterministic ordinal (needed when one investigation JSON row
contains several analytes), and are append-only. JSON fields must be objects of bounded shape; hashes
are lowercase 64-character hex. Result values never enter `event_outbox` payloads, task metadata or
notification text.

A generation is complete only when its item count and aggregate hash match the locked source episode.
The database/API rejects zero-item generations, partial panels and cross-patient/source mixtures.

### 3.3 `diagnostic_result_actions`

This append-only ledger records pathway-domain evidence, not mutable status. Action kinds are constrained
to:

- `normal_auto_closed`;
- `doctor_reopened`;
- `doctor_disposition`; and
- `generation_superseded`.

Rows carry tenant/patient/generation/pathway/task identity, the attested generation snapshot hash, actor
and role where applicable, a required idempotency key/request hash, occurrence time, predecessor
action/evidence links, canonical timeline and audit IDs, and optional typed downstream evidence.

For `doctor_disposition`, `disposition` is exactly
`treated|repeated|referred|no_action`, the clinical note is non-blank, and the actor is the server-derived
doctor. `treated`, `repeated` and `referred` carry a tenant/patient-validated typed downstream resource
when the selected action creates one; `no_action` always carries the doctor's explicit reason. The
system never infers an action from a later order, referral, encounter note or patient release.

For `doctor_reopened`, a non-blank reason and the exact prior `normal_auto_closed` action are required.
For `normal_auto_closed`, the linked generation must be explicitly normal and release eligibility must
be captured from the authoritative S2a decision. For `generation_superseded`, the new generation and
prior terminal/action evidence are linked; nothing is erased.

### 3.4 Database enforcement

Migration 589 follows the spine's Pattern-A tenant/RLS conventions and adds:

- composite tenant/patient/generation/action foreign keys;
- exact enum/check constraints and cross-field action checks;
- source-version, action-idempotency and one-auto-close-per-generation uniqueness;
- append-only update/delete blockers for all three tables;
- a deferred completeness trigger that rejects a zero-item/partial generation or an aggregate hash that
  does not match its immutable items;
- a partial unique signature constraint on `clinical_document_signatures` for one
  `diagnostic_result_action` signature per action; and
- a deferred constraint trigger that requires every `doctor_disposition` to have exactly one matching
  same-tenant, same-patient doctor signature by commit.

Migration 589 also blocks update/delete of a `clinical_document_signatures` row whose document type is
`diagnostic_result_action`. The transaction-aware signer preallocates its signature/canonical IDs and
inserts the already sealed signature with its audit reference, so it does not need an otherwise-allowed
post-signature mutation.

Database constraints cannot prove current clinical role, relationship or typed polymorphic source
ownership. The service proves those under lock, and reconciliation independently detects drift.

The migration performs no clinical backfill. Historical rows are not labeled normal from absent flags.
Backfill remains owner-gated; ambiguous history is reported as a reconciliation blocker.

## 4. Classification and generation creation

The S2a precedence is normative for every adapter:

1. any explicitly signed critical item makes the generation `critical`;
2. otherwise any explicitly signed abnormal item makes it `abnormal`;
3. `normal` requires every current signed item to be explicitly normal; and
4. missing, unsupported, contradictory, partial or untrusted facts make it `indeterminate`.

Free text, order priority, diagnosis codes and AI output never determine classification. Threshold
unavailable is not normal. The generation service locks the complete source episode, derives the source
version, snapshots all items, validates the ordering owner and writes generation/items, the canonical
pair and a minimal-PHI source event in the originating sign-off/completion transaction.

For allowlisted non-radiology/AP generic investigations, the authenticated submitter remains technical
recorder. A generation's signer records source verification, while the later action signature is the
independent doctor review required by D5. A result whose type maps to radiology/AP fails closed as a
registration/reconciliation blocker until migration 590 supplies structured signed classification.

An allowlisted generic source that lacks S2a's structured release facts may still create critical or
abnormal staff accountability from its signed generation. An explicitly normal generation from that
source remains release-unsupported and cannot auto-close under D4; it is an activation blocker, not an
excuse to infer patient visibility.

Orderless external sources, missing patient/tenant linkage, mixed episodes and a named but ineligible
ordering owner fail generation or become explicit reconciliation blockers; they do not silently fall
back to a role queue.

## 5. Ownership and task-first semantics

D10 governs diagnostics ownership:

- the recorded ordering doctor is the default named owner;
- an active, same-tenant, route-capable named owner is exclusive;
- responsibility changes only after an eligible covering doctor explicitly accepts the S1b-c2 audited
  transfer; and
- a role queue is permitted only when the source never named an individual, and an eligible current role
  holder must explicitly claim it before clinical completion.

A named but unavailable clinician is surfaced in the unowned/unreviewed-results queue as a routing
blocker. The system does not assign the same work to a role as an implicit fallback.

Task-first applies only to internal human accountability:

- abnormal/noncritical doctor review/action is one `domain_evidence` task;
- an indeterminate generation is one clinician-classification/review `domain_evidence` task;
- a corrected/addended generation is one new review/action task unless it is routed to the existing
  critical acknowledgement rail; and
- a discretionary reopen creates a new linked `domain_evidence` task.

Normal release waiting, automatic D4 closure, patient/guardian delivery and external-provider waiting are
not synthetic staff tasks.

Critical generations retain the existing acknowledgement-semantic critical task/SLA. Acknowledgement
stops that exact clock but does not close the task/pathway as clinical action. The dedicated doctor-action
command records the disposition and completes the remaining critical action obligation. It never reuses
generic task acknowledgement as domain evidence.

## 6. D4 normal closure and reopen

An initial normal generation takes no human task by default. It closes only when the S2a authoritative
predicate is true for the complete current generation:

- explicit early release can emit the release-eligible event after its transaction commits; and
- elapsed configured eligibility is found by a bounded, idempotent release sweep/reconciliation command.

The sweep adopts the already configured policy; this design specifies no cadence or new delay. Under a
tenant lock it re-evaluates current source state, records one `normal_auto_closed` action, appends the
canonical pathway transition and closes the pathway stage. Duplicate events/sweeps return the same
action. A hold or a source without structured release support blocks closure.

The current named owner or accepted covering doctor may reopen from the staff result detail with a
reason and idempotency key. One transaction records `doctor_reopened`, preserves and links the original
auto-closure, creates the new domain-evidence task, appends canonical evidence and publishes the event.
The subsequent doctor disposition, not the reopen click, closes that new obligation.

The effect of a new hold or patient-visibility reversal after auto-closure is not owner-approved. S2b
never deletes or silently reverses prior closure evidence; it reports the case as a reconciliation/
activation blocker until that policy is signed.

## 7. D5 and critical doctor-action command

The staff command requires `Idempotency-Key`, locks generation/pathway/current task/owner state, resolves
the current database actor, and proves that actor is the exact named owner, accepted covering doctor or
the claimant of a legitimately unnamed role queue. Generic ADMIN access is not clinical countersignature.
Any break-glass path remains unavailable until separately approved.

In one tenant transaction it:

1. validates classification, current generation and non-superseded action state;
2. validates the disposition, note and typed downstream evidence;
3. preallocates the action ID and writes its canonical timeline/audit pair;
4. inserts the immutable action;
5. signs that action through a transaction-aware document-integrity API;
6. compare-and-set completes the exact domain obligation/task and pathway step;
7. completes only an SLA whose registered semantics explicitly allow this domain evidence; and
8. publishes a minimal-PHI `diagnostic.result.action_recorded` event in the same transaction.

`clinical_document_signatures` is extended with a fixed `diagnostic_result_action` spec and
`signDocumentTx`; caller-supplied tables, document types and actors remain impossible. The diagnostic
path preallocates the signature/canonical IDs and inserts a fully sealed signature rather than updating
its audit reference later. The immutable action includes the exact generation snapshot hash, so the
signature attests the result generation being reviewed as well as the disposition. Any failure rolls
back action, signature, task/pathway transition, canonical evidence and outbox together.

Patient release, opening the patient chart, generic acknowledgement, a technical verifier field or an
unlinked clinical note never invokes this command and never closes D5/critical action.

## 8. Correction and addendum routing

Every accepted correction creates a new signed generation and atomically links the predecessor. The
projector compares signed classifications and routes as follows:

- **newly critical or still critical:** create/re-arm the exact existing critical generation/task/SLA;
  no completed acknowledgement window is reused;
- **abnormal noncritical:** create the D5 named-doctor domain-evidence task;
- **normal correction, including normalization of a prior critical result:** create a linked doctor
  re-review/action task without a critical SLA; and
- **indeterminate or threshold unavailable:** fail safe to clinician classification/review, never normal
  auto-close.

Any prior open task is transitioned through an explicit superseded/cancelled domain edge in the same
projection transaction; it is not deleted or blindly reopened. Prior acknowledgement, escalation,
closure, action and patient-release evidence remains queryable. A new generation gets a new idempotency
identity, task occurrence and pathway transition.

Corrected-result patient messages use the entire S2a release predicate. Their recipient, wording and
external-provider behavior remain governance-gated; no message is inferred merely from correction.

## 9. Event/projector integration

Registered source/domain event types include, at minimum:

- `diagnostic.result.generation_signed`;
- `diagnostic.result.release_became_eligible`;
- `diagnostic.result.generation_corrected`;
- `diagnostic.result.action_recorded`; and
- `diagnostic.result.reopened`.

Payloads contain tenant/source/generation/pathway IDs, source version, classification and trace/idempotency
references only. They contain no result value, interpretation, clinical note or patient name.

The producer publishes with the originating transaction. The pathway consumer is registered as a fresh
higher projector generation using the S1 handoff/fencing protocol; frozen generation 1 is never edited.
Replays are idempotent on source generation/action identity and cannot manufacture a new clinical
signature or second task occurrence.

The code-reviewed `diagnostics_order_to_action` definition uses registered handlers only.
`automation_rules` remains dormant under D2. `tasks` remains the inbox currency, and the existing
pathway/task/source fields carry all links; no resource-link companion table is added.

## 10. Staff and patient product semantics

The clinical inbox model must retain `sla_completion_semantics` and render actions by contract:

- acknowledgement-semantic critical work shows **Acknowledge critical result**, then retains the
  required doctor-action path;
- domain-evidence work shows **Review and record action**, never generic **Acknowledge**;
- correction tasks show old/new classification and generation linkage without exposing stale values as
  current; and
- unowned/routing-blocked work appears in a dedicated authorized staff queue and cannot be completed
  until a valid owner is established or an unnamed queue is claimed.

Staff result detail adds classification/provenance, current owner/accepted cover, release state, prior
generation evidence, a D4 reopen command, and the D5/critical disposition form. The form uses the exact
four-value enum, requires a note, validates downstream evidence and obtains an explicit electronic
attestation.

Patient screens continue to use S2a release authorization. “Discussed with your doctor”, patient
acknowledgement semantics and corrected-result messaging are not enabled until patient/guardian
visibility and notification policy is signed. Doctor action evidence remains available to authorized
staff regardless of whether that later patient-facing label is approved.

## 11. Reconciliation, metrics and activation

S1b-c3 receives versioned Diagnostics checks for:

- signed source episodes versus immutable generations/items/hashes;
- source version/predecessor continuity and unsupported classifications;
- outbox versus projector inbox/outcome and one pathway occurrence per generation;
- D4 auto-closure only after actual release eligibility;
- D5/critical terminal action versus exactly one signature, canonical pair and task/pathway state;
- task/SLA semantics and exact D10 ownership/accepted transfer;
- correction routing, superseded obligations and critical-window generation; and
- orderless/missing-owner/external-source blockers.

Repairs never invent clinical classifications, dispositions, signatures or ownership. Any repair run is
non-clean and requires a later clean observation.

Metrics are evidence-derived durations/counts only: order-to-collect/acquire, verification turnaround,
critical acknowledgement, unreviewed abnormal results, recollection/repeat, addendum acknowledgement,
patient-release success and order-to-recorded-action. No target, threshold or clock is introduced.

Diagnostics stays `off`/`shadow` until S2a/S2b, migration 590 radiology/AP coverage if included in scope,
owner routing, reconciliation and the standing governance policies have clean evidence. Shadow mode
records/proves projection without creating staff work or patient messages. A production `active` flip is
outside this implementation slice.

## 12. Required conformance and journeys

Required evidence includes:

1. migration 589 fresh-build, RLS, composite-FK, append-only, hash, uniqueness and deferred-signature
   conformance;
2. atomic generation/items/canonical/outbox creation for every supported lab/shared-result producer;
3. normal release auto-close and exact idempotent doctor reopen preserving original evidence;
4. abnormal and critical action commands with one valid signature, exact owner/cover authorization and
   atomic task/pathway closure;
5. generic acknowledgement rejected for domain-evidence work;
6. duplicate/concurrent source, projector, action and replay races producing one outcome;
7. the complete correction matrix: critical→critical, critical→normal, normal→critical,
   normal→abnormal, abnormal→normal, indeterminate and threshold unavailable;
8. no patient result/message before S2a release eligibility and no result values in events/tasks/logs;
9. routing blockers for named-unavailable and safe claim for genuinely unnamed queues; and
10. a new/extended `diagnostics-order-to-action.journey.test.js` covering initial normal closure/reopen,
    abnormal disposition, critical acknowledgement plus action, and corrected generations.

Spine atomicity/CAS/replay/tenancy/actor generics remain in the shared conformance suite. The Diagnostics
journey tests only pathway-specific behavior and must assert exact statuses; a 500 is never accepted as
an alternate result.
