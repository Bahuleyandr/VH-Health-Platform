# C5.2 paper back-entry and reconciliation workbench — design delta

- **Status:** Coordinator-cleared 2026-07-31; implementation remains held at
  the §2 gates
- **Scope:** Backend, Staff workbench, Admin workbench, and continuity
  documentation
- **Lane:** `feat/continuity-c5-2-reconciliation`
- **Baseline:** `github/main` at
  `505443c5847d3ea69791769c8e927566182c7ec6`
  (`2026-07-31T12:49:20+05:30`)
- **Build order:** AF (building) → C5.1 → C5.2
- **Migration reservation:** None. The build derives the next free number only
  after all prerequisites have landed.
- **Activation:** None. This delta neither activates continuity mode nor changes
  a production policy.
- **Merge instruction:** Push this design lane for coordination; do not merge
  it.

This delta makes the C5.2 back-entry path a retrospective, receipt-authorized
recording workflow. It does not turn paper records into delayed live commands.
The first build supports only the three owner-approved `paper_only_backfill`
action IDs, uses C5.1's receipt as the sole command-effect authority, reuses the
existing task, SLA, clinical-audit, and patient-merge engines, and blocks
incident closure until paper, device, interface, identity, and safety-critical
work are reconciled.

## 1. Binding authority and source order

The implementation must reconcile these sources in this order:

1. The current checkout and its database, service, route, audit, workflow, and
   UI contracts.
2. [The C5.2 plan](../superpowers/plans/2026-07-28-clinical-service-continuity.md)
   and the adjacent
   [continuity design](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md).
3. The countersigned values in the
   [C0.4 owner-decision dossier](c0-4-owner-decision-dossier.md).
4. The landed C5.1 delta and implementation, including every C5.1 §2 stop
   condition.
5. The landed C4.1 envelope, C4.2 registry, C6.1 late-effect fence, canonical
   clinical timeline, task/SLA engine, and clinical audit service.

If a proposed table, endpoint, action binding, role, migration number, retention
value, or owner classification conflicts with those live contracts, the build
stops. It must not resolve the conflict by silently broadening C5.2.

### 1.1 Handoff-label correction

The handoff describes a "C-D7 back-entry decision table." The live,
countersigned dossier does not contain such a C-D7 table:

- **C-D3** is the approved offline action classification and therefore governs
  which physical/final actions may receive paper-only back-entry.
- **C-D7** governs ordinary logout, forced revocation, unresolved offline rows,
  and the immutable per-row `needs_review` handoff attestation.

C5.2 binds both records under their actual identifiers. It must not relabel the
C-D3 action classification as C-D7 or omit C-D7's preservation and attestation
semantics.

## 2. Build-time stop conditions

C5.2 is last in this build queue. The implementation must not begin until the
coordinator verifies all of the following against the then-current
`github/main`:

1. **AF is complete.** The prerequisite facility-context/auth work is merged and
   exposes the server-owned facility context required by continuity routes.
2. **C5.1 is merged.** Its receipt schema, service, retention path, RLS,
   transaction contract, evidence model, and tests are present on `main`.
3. **Every C5.1 §2 stop condition still passes:**
   - C6.1-A's exact migration, event-time contract, late-effect seam, and
     five-projector parity are merged.
   - The facility-context build produces server-owned
     `req.continuityFacilityContext`.
   - The resolver derives tenant, facility, actor, device, session, grant,
     policy, and revocation state server-side. Client headers remain evidence,
     never authority.
   - The C4.1 envelope fields exactly match the coordinator-cleared contract.
   - C4.2 still contains exactly seventeen action IDs plus `unknown`, and only
     the two approved draft-store actions are electronic replay bindings.
   - The migration number is derived only after these predecessors land.
4. **C5.1 reflects the completed C-D10 decision.** Its implementation must
   enforce the signed 7-day acceptance window, 365-day full receipt, and
   2555-day compact tombstone. Any older design text that still calls those
   values owner input is stale and cannot be copied into C5.2.
5. **The C4.2 paper-only rows remain exact.** The three action IDs in §6.1 below
   are still `paper_only_backfill`; no generic replay binding has been added.
6. **The C6.1 read substrate is stable.** `event_consumer_offsets` and its
   tenant/facility/interface semantics are available for closure checks.
7. **Existing engines remain canonical.** `tasks`, `workflow_sla_instances`,
   `clinical_audit_events`, and `patient_merge_requests` have not been replaced
   by competing implementations.
8. **The owner records remain countersigned.** C-D3, C-D5, C-D6, C-D7, C-D8,
   and C-D10 must retain the values quoted in §3.
9. **C0.3 coverage is not inferred.** The hospital-area/platform owner matrix
   must either be signed or its blank state must remain a release blocker as
   described in §13.

Any failed condition returns the lane to design reconciliation. It is not a
waiver to create a second receipt, task, SLA, audit, merge, or interface-marker
engine.

## 3. Countersigned owner values carried into C5.2

The following policy text is binding. The implementation and its tests should
refer back to these dossier records rather than duplicating mutable policy in
application constants.

### 3.1 C-D3 — action classification

> The registry was approved as-is covering all eight surfaces.

> the design §5.4 conservative registry plus the C0.2 §6 proposed default-deny
> rows are the approved classification, covering all eight census surfaces
> (five physical/final actions, authoritative `/emr/notes` creates for every
> note category, vitals, note-draft autosave).

The full registry remains default-deny. C5.2 implements only the three exact
paper-backfill identifiers named in §6.1; it does not authorize every
physical/final action merely because the high-level decision discusses them.

### 3.2 C-D5 — downtime identity

> New or unidentifiable arrivals during downtime receive an explicit temporary
> identity drawn from the active C-D6 incident packet's reserved paper-item
> range; a permanent record is never created directly during downtime.
> Two-identifier bedside checks are required where the patient's condition
> allows; an unconscious or unaccompanied patient receives a physical wristband
> from the reserved range as the second identifier. A downtime temporary
> identity is merged into a permanent patient record only after service
> restoration under two-key approval: registration/HIM proposes the match and
> a clinical role — the treating doctor or the clinical safety lead —
> co-approves it. A duplicate permanent identity is never created silently, and
> an unknown identifier is never treated as verified.

### 3.3 C-D6 — incident authority and fallback ownership

> Two-key incident authority. One named operational incident commander declares
> and runs a downtime incident. The clinical safety lead independently
> co-attests closure. Both signatures are required before an incident can
> close, and an incident cannot close while owner-defined safety-critical items
> remain unresolved. Offline declaration uses pre-provisioned, one-use signed
> facility incident packets containing an unused incident UUID and a reserved
> paper-item range; identifiers printed before an outage are never described as
> bound to a newly generated incident. Duplicate commanders, split-brain
> declarations, lost or revoked ranges, and incident merge or alias must be
> handled without rewriting history. Roles are recorded now; names at
> countersignature.

Rows whose capture owner cannot be resolved use the stable fallback principal
defined by the dossier:

> Offline rows whose capture owner is unknown (deleted account, null legacy
> owner) are assigned to the clinical-safety-lead role as the fallback
> reconciliation principal. Stored as the stable role code
> `role:clinical_safety_lead`, supplied through the tenant-specific C0A
> configuration with no production default; the localized role label is
> displayed; no staff name is persisted; the named individual is resolved at
> reconciliation time. This is not a new backend RBAC role.

### 3.4 C-D7 — preservation and needs-review handoff

> BLOCK ordinary logout while the signed-in user has unresolved offline
> clinical rows; forced/server-pushed revocation PRESERVES rows encrypted and
> owner-bound (no wipe) for later reconciliation.

The countersigned addendum says:

> Pending and conflict rows always block ordinary sign-out. A needs_review row
> blocks sign-out until the signed-in user records a per-row attested handoff
> ('reviewed — transferred to paper / handed to the reconciliation owner'),
> storing the attestation actor UID and timestamp on the row. Attested rows stop
> counting toward the sign-out block but remain preserved, visible, undeletable,
> and undrainable; attestation is immutable once set. Forced/server revocation
> and idle timeout are unchanged by attestation and preserve all rows.

C5.2 imports that attestation as evidence when relevant. Import does not turn
the attestation into approval of the paper fact or reconciliation decision.

### 3.5 C-D8 — external recovery and late effects

> Data arriving late from any external interface after an outage never
> automatically fires a retrospective SLA-breach alarm, care-pathway
> transition, or patient notification. It lands as ordinary pending work in its
> existing domain surface — a late critical lab result appears in the
> critical-results inbox for human acknowledgement, never silently dropped and
> never auto-alerted as a fresh breach. Any interface that must deviate requires
> its own signed event-family policy under the design's late-arrival rules;
> absent that signed exception, suppression is the default.

> The engineering dependency order in the C6.1 integration recovery inventory
> section 4 is adopted as the approved operational baseline: quiesce external
> senders, stop synchronous clinical consumers, record queue counts and
> oldest-item timestamps then freeze durable outbound queues, stop schedulers,
> then databases and storage last; restart in reverse, restoring durable
> foundations and confirming time sync first, starting workers paused, applying
> the per-interface disposition before any backlog replay, resuming clinical
> ingress one interface at a time with count validation, and opening external
> senders last for reconciliation. The operator executes this order and records
> any per-incident deviation with its reason.

> Every external interface that carries a replayable stream receives a durable,
> per-tenant high-water mark and a duplicate key so post-outage replay is
> automatic and idempotent rather than manual. Interfaces that are stateless
> request/response and carry no replayable stream (for example OIDC/SAML
> identity, payment-link handoff, AI providers, read-only terminology) receive
> an explicit recorded 'not applicable — no replayable stream' disposition
> rather than a fabricated marker. No interface is left without a stated
> disposition. The exact per-interface build set is drawn from the C6.1
> inventory and delivered under the C6 integration-recovery slice; this
> decision authorizes building resume markers for all interfaces that can bear
> one.

> Dr Bahuleyan S, Medical Director & Accountable Owner, is the accountable owner
> for every interface's recovery decisions, signing as the single accountable
> owner across the interface-domain roles. Named per-interface delegates (for
> example laboratory, pharmacy, blood bank, identity) may be recorded later
> without invalidating this record.

These stop/restart rules, durable per-tenant high-water marks, duplicate keys,
and explicit not-applicable dispositions remain owned by C6.1. C5.2 consumes
their read state for reconciliation and closure; it does not write or redefine
them.

### 3.6 C-D10 — break-glass, retention, loss, and communications

> Electronic break-glass remains blocked offline in the initial rollout; the
> named-staff continuity pack access shipped in C3.3 is the only offline read
> path, and this posture is revisited only after first-activation evidence.
> Replay and receipt horizons: the server accepts a queued offline command for
> at most 7 days after capture; a first-applied replay receipt remains fully
> rearm-blocking for 365 days, reusing the operational-audit retention baseline;
> the compact deduplication tombstone that replaces it is retained for 2555
> days, reusing the platform's existing 7-year clinical evidence class. These
> values satisfy the rule that the tombstone horizon is never shorter than any
> interval in which the command can still be accepted. Device loss: on a report
> of a lost or stolen staff device, its grants and sessions are revoked
> immediately, a signed governed wipe order is issued and executes on the
> device's next contact, offline pack access dies at its signed expiry of at
> most 24 hours by design, and any unsynced captured work surfaces as
> needs_review to the C-D6 fallback reconciliation principal and is never
> silently discarded. Communications: each pre-provisioned C-D6 incident packet
> carries a printed phone-tree and role contact sheet, refreshed on the packet's
> print cycle; incident coordination falls back to telephony and messaging that
> do not depend on hospital infrastructure.

The paper ledger, receipt, attempt, incident, reconciliation, task, audit, and
clinical evidence retention classes must be mapped explicitly during build.
Receipt compaction must preserve the immutable paper identity, authorization
outcome, payload fingerprint, terminal outcome, and enough evidence to keep the
same paper item rearm-blocked for the full 2555-day tombstone horizon.

## 4. Workbench surface ruling

C5.2 uses **both Staff and Admin**, backed by one resource model and one set of
backend commands:

- **Staff is the clinical/ward surface.** Authorized staff record paper facts,
  review patient/encounter linkage, attach evidence, and complete assigned
  clinical reconciliation work.
- **Admin is the incident/HIM/interface surface.** Authorized operational
  commanders, HIM/Medical Records staff, interface owners, and governance users
  manage declarations, paper ranges, identity-match proposals, interface
  high-water-mark evidence, aggregate queues, and closure.

Neither frontend is an authority boundary. Every route resolves the principal,
tenant, facility, continuity role/capability, incident, and assignment on the
server. A user who can render a page but lacks the resource-specific backend
capability receives a denial.

The two frontends must share generated request/response contracts and canonical
status labels. They may present role-appropriate views, but they must not create
parallel incident, queue, decision, receipt, merge, task, or audit state.

## 5. Incident, packet, and paper-ledger model

The names below are design names, not migration reservations. The build may
adjust them to match landed conventions, but it must preserve the stated
invariants.

### 5.1 Current incident projection

`clinical_continuity_incidents` is the tenant/facility-scoped current
projection. It contains at least:

- immutable `id`, `tenant_id`, and `facility_id`;
- the packet/declaration lineage;
- current canonical/alias disposition;
- operational incident commander;
- lifecycle state and integer `version`;
- declared, restoration, reconciliation, and closed timestamps;
- closure predicate snapshot references, not copied clinical evidence;
- created/updated metadata.

Every state-changing command supplies `expected_version`. The service locks the
row and performs a compare-and-swap. A stale version returns a typed conflict
with the current projection and performs no partial write.

Each accepted state change updates the projection and appends the canonical
`clinical_audit_events` row in the same tenant transaction. Where a command
emits an integration event, its outbox row is also in that transaction.
Every declaration, mode or owner change, recovery milestone, and closure
attestation is represented by append-only structured clinical-audit evidence;
none exists only as the latest projection value.

### 5.2 Immutable declarations and packet use

`clinical_continuity_incident_declarations` preserves every signed declaration,
including:

- packet and unused incident UUID;
- tenant and facility binding;
- reserved paper-item range;
- packet key/version and signed canonical bytes or their governed evidence
  reference;
- signer/commander evidence and verification result;
- declared occurrence time and server-recorded time;
- imported-by principal and source device/session evidence;
- revocation, duplicate, and conflict dispositions.

Online declaration and offline declaration import use the same domain service.
The offline import verifies the packet signature, key version, facility,
one-use incident UUID, reserved range, expiry/revocation state, and caller
authorization. On success it inserts the immutable declaration, appends the
clinical audit row, and creates or compare-and-swap updates the tenant/facility
incident projection atomically. A failed verification or stale projection
writes no authoritative incident state; it may append only the separately
authorized security attempt evidence defined by the audit contract.

Packet use is one-use and facility-bound. Printed identifiers remain bound to
the pre-provisioned packet and UUID. The system must never claim that a
preprinted identifier was bound later to a newly generated incident.

### 5.3 Aliases, split brain, and lost ranges

`clinical_continuity_incident_aliases` is append-only. A governed alias/merge
decision links an observed incident to a canonical reconciliation roll-up but
does not update historical declaration, paper, receipt, fact, audit, task, or
timeline foreign keys.

Consequently:

- duplicate commanders and split-brain declarations remain separately
  inspectable;
- each paper receipt remains keyed to the incident printed on the paper item;
- a canonical incident view follows append-only alias edges for aggregate
  reconciliation;
- alias cycles, cross-tenant links, and cross-facility links are rejected;
- superseding an erroneous alias appends a corrective decision rather than
  rewriting or deleting the old one.

`clinical_continuity_paper_ranges` records packet allocation, first/last
identifier, status, loss/revocation reports, and immutable decision history.
Lost, revoked, or exhausted ranges are never reissued. A later-presented paper
identifier from such a range retains its external identity and is routed to
`needs_review`; it is not renumbered.

### 5.4 Paper items

`clinical_continuity_paper_items` is an immutable-identity ledger with a mutable
compare-and-swap projection. Its external identity is exactly:

`(tenant_id, facility_id, incident_id, paper_item_id)`

That tuple is unique and can never be changed, reassigned, or reused. It is
present in the receipt tombstone as well as the full receipt.

The ledger preserves:

- packet/range evidence;
- paper-item kind;
- original actor/role and physical occurrence time;
- back-entry actor and server-recorded time;
- independent reviewer/decision actors where required;
- patient, temporary identity, and encounter links;
- evidence references and hashes;
- canonical payload fingerprint;
- receipt/fact/timeline/audit links;
- current reconciliation disposition and optimistic-lock version.

A temporary identity consumes its own reserved paper identifier. A medication,
specimen, transfusion, or other clinical form consumes a separate paper
identifier and may link to that temporary identity. One identifier cannot
simultaneously represent the patient wristband and a clinical act.

## 6. One receipt authority and the C4.2 boundary

### 6.1 Initial automated action set

The first build exposes dedicated back-entry commands for only:

| Action ID | Retrospective fact |
|---|---|
| `mar.administration.backfill` | A medication administration that physically occurred during downtime |
| `lab.specimen_collection.backfill` | A specimen collection that physically occurred during downtime |
| `blood.transfusion_verification.backfill` | A transfusion verification that physically occurred during downtime |

These identifiers remain `paper_only_backfill`. C5.2 must not register them as
generic C4.2 electronic replay bindings. The existing C4.2 server registry
continues to expose only the two approved electronic draft-store bindings.

No generic `/replay` or arbitrary-action back-entry endpoint is permitted.
Admission, transfer, discharge, prescription, inpatient drug-chart, note,
vital, nursing-category, and unknown actions remain default-deny unless a later
countersigned delta adds an exact paper action and adapter. In particular,
transfer has no approved paper-backfill action ID in the live C0.2 inventory, so
C5.2 adds no transfer endpoint.

### 6.2 C5.1 receipt reuse

C5.2 uses C5.1's `clinical_continuity_replay_receipts` as the sole
command-effect authority. It must not create a paper-receipt table or any other
parallel deduplication authority.

The landed C5.1 schema may receive an additive paper-source extension:

- a source discriminator;
- nullable paper tuple columns constrained to be all-null or all-present;
- a partial unique index over the full paper tuple;
- the paper tuple in receipt-compaction/tombstone fields;
- paper-specific evidence links that do not weaken the electronic replay path.

C5.2 may derive an internal `client_event_id` for compatibility with the C5.1
service, but that value is opaque. It is not a second idempotency key and cannot
authorize an effect independently of the paper tuple.

The paper ledger's unique constraint protects inventory. It does not authorize
a clinical effect. Only an authorized C5.1 receipt claim can do that.

### 6.3 Claim and apply transaction

For a valid, resolvable paper command, one tenant transaction:

1. locks/claims the C5.1 receipt by the exact paper tuple;
2. rechecks incident, packet/range, caller, action, patient/temporary identity,
   encounter, review, and policy state;
3. invokes the dedicated retrospective fact adapter;
4. records C5.1 effect evidence;
5. appends the clinical timeline fact;
6. appends the canonical clinical audit event;
7. appends the outbox event;
8. updates the paper-item projection and linked reconciliation item; and
9. seals the receipt's terminal authorized outcome.

All nine operations commit or roll back together. No domain adapter may commit
before the receipt, audit, timeline, and outbox records are durable.

The canonical payload fingerprint binds at least:

- the complete paper tuple;
- the server-fixed action ID and schema version;
- original actor and role;
- physical occurrence time;
- patient or temporary-identity and encounter references;
- governed evidence hashes; and
- the normalized clinical payload.

The current back-entry actor, reviewer, and authorizer are separately
server-authorized and audited. They are not folded into the clinical fact
fingerprint, because changing the authorized operator must not make the same
paper fact look like a different physical act.

### 6.4 Duplicate and mismatch semantics

After current authorization is re-evaluated:

- an exact duplicate returns the prior authorized terminal outcome and its
  receipt/fact references;
- a same-tuple/different-fingerprint request never invokes an adapter, leaves
  the first authorized outcome unchanged, and creates or updates one owned
  `needs_review` reconciliation item;
- an ambiguous, invalid, or policy-blocked paper item creates/updates a
  reconciliation item without a terminal applied receipt;
- after a governed resolution, the same tuple may make its one authorized
  claim; the original invalid attempt evidence remains append-only;
- a failed, expired, revoked, cross-tenant, cross-facility, or unauthorized
  attempt never reserves an outcome that would suppress a later valid claim.

The C5.1 attempt/evidence model remains the source of truth for replay and
back-entry attempts. Paper mismatch metadata may enrich it, but C5.2 does not
create another attempt ledger.

### 6.5 Relationship to C4.2

C4.2 owns electronic offline action classification and its default-deny binding
registry. C5.2 owns a dedicated paper import boundary for the three approved
paper-only actions. Both use server-owned action schemas and authorization, but
the paper commands do not pass through a generic electronic replay binding.

This separation prevents a paper-only classification from accidentally making
the same physical command electronically queueable. An action absent from the
dedicated C5.2 command map is denied even if a caller fabricates its identifier.

## 7. Retrospective facts and the C6.1 late-effect fence

Back-entry records what already happened. It never performs, retries, or
re-triggers the physical act.

### 7.1 Dedicated fact adapters

Each approved action receives a transaction-capable retrospective adapter. An
adapter may record the historical clinical fact and reconcile the canonical
domain projection, but it must not call a live command handler that:

- administers, schedules, or re-administers a medicine;
- collects, labels, dispatches, or recollects a specimen;
- starts, verifies, releases, or restarts a transfusion;
- admits, discharges, transfers, or moves a patient;
- starts an SLA or care pathway from the historical occurrence time; or
- emits a fresh patient notification for the historical event.

If the current domain state conflicts with the paper fact, the adapter writes
no conflicting transition. The item becomes `needs_review`, preserving the
paper evidence and current electronic state.

The tests must include transfer as a negative invariant even though no transfer
endpoint is shipped: no supported or unsupported paper payload may reach a
live transfer handler.

### 7.2 Three clocks

Every retrospective fact distinguishes:

- `occurred_at`: when the physical act happened;
- `recorded_at`: when the server durably accepted the back-entry; and
- `reviewed_at`/`decided_at`: when an independent reconciliation decision
  occurred, if applicable.

The clinical timeline uses `occurred_at` for clinical chronology while clearly
displaying the late `recorded_at` provenance. Operational queue age, task SLA,
audit chronology, and notification suppression use `recorded_at`; they are
never backdated to make an historical act look like a newly missed SLA.

### 7.3 C6.1 seam

Every emitted retrospective event carries the landed C6.1 event-time contract
and the exact suppression disposition `late_pending_only`. The back-entry
service must propagate the landed database/session guard (including
`app.external_recovery_effect_disposition` where the C6.1 implementation
requires it) through the same transaction.

Absent a separately signed event-family exception, projectors, adapters,
outbox consumers, and post-commit hooks must suppress retrospective:

- SLA-breach alarms;
- care-pathway transitions; and
- patient notifications.

No such exception is authorized by this delta.

If a late fact needs human action, it appears as ordinary pending work in its
existing domain surface and/or as an owned C5.2 reconciliation item. A task SLA
may begin at `recorded_at` only when an existing owner-approved workflow SLA
policy applies.

## 8. Typed reconciliation queues on the existing task engine

`clinical_continuity_reconciliation_items` is the C5.2 domain record. Its exact
queue type is one of:

- `needs_review`;
- `identity`; or
- `interface`.

The item stores domain disposition, paper/device/interface evidence links,
patient/encounter linkage, safety-critical classification, immutable decision
history, current assignment task link, and optimistic-lock version. It does not
store a second assignment, SLA, escalation, comment, or approval engine.

Every actionable item uses the existing `tasks` resource model:

- `task_kind = 'review'`;
- `related_resource_type = 'clinical_continuity_reconciliation_item'`;
- `related_resource_id = <reconciliation item id>`;
- one open task per resource through the existing open-resource uniqueness
  contract; and
- task creation and transition through the canonical workflow task service.

### 8.1 Task-to-SLA behavior

If an owner-approved workflow SLA definition matches the queue type and
facility, task creation also creates the existing `workflow_sla_instances`
record and the immutable typed task-to-SLA link in the same transaction.

If no approved SLA duration exists, C5.2 does not invent one:

- `sla_completion_semantics = 'none'`;
- no due time is fabricated; and
- the item remains assigned and visible without an SLA clock.

An SLA clock starts at the task's server-recorded creation time, never at the
paper fact's `occurred_at`.

Closing, cancelling, or superseding a task applies the existing typed
completion semantics. Reopening creates a new task/SLA generation. It never
detaches, rewrites, or repoints the prior task/SLA pair.

Task comments are collaboration metadata. Every clinical or reconciliation
decision also appends a structured `clinical_audit_events` row in the same
transaction as the domain decision. A task comment alone is not clinical
evidence.

### 8.2 Ownership

Every unresolved item has both:

- a stable ownership role/principal; and
- a currently resolved named assignee where the tenant configuration and
  staffing permit it.

If the original owner is missing, C5.2 uses
`role:clinical_safety_lead` exactly as defined by C-D6. It does not persist a
staff name in the fallback principal and does not invent a default person.

## 9. Temporary identity and permanent merge

C5.2 reuses and hardens the existing `patient_merge_requests` /
`patientMergeService` workflow. It must not create another patient-merge or
two-key approval engine.

The build adds continuity provenance to the existing request where needed:

- tenant, facility, incident, packet, paper item, and temporary-identity
  references;
- requester/approver role evidence;
- source and target patient evidence;
- conflict/review disposition;
- execution and audit links; and
- immutable decision history.

The server enforces:

1. the temporary identity came from the active incident packet's reserved range;
2. no permanent patient is directly created by the downtime/C5.2 path;
3. service has been restored and the target permanent patient already exists;
4. a registration/HIM or Medical Records principal proposes the match;
5. a distinct treating doctor or the tenant-configured
   `role:clinical_safety_lead` co-approves it;
6. unknown identifiers remain unverified;
7. the merge executes only after both approvals and a fresh conflict check; and
8. the proposal, approval, execution, clinical audit, and continuity
   reconciliation links remain append-only.

The existing generic admin two-person approval is insufficient unless these
exact role and incident constraints are enforced server-side.

Before build, the coordinator must review the existing merge service's full
foreign-key/resource coverage for continuity-created data. If it cannot move or
alias every required patient-bound continuity fact without loss or ambiguity,
the build stops for a patient-merge design extension. It must not silently use
the current limited FK sweep or compensate with a second merge engine.

## 10. Closure predicate and two-key attestation

Incident closure is a server command, not a UI checkbox. It uses a stable,
serializable or equivalent locked snapshot and succeeds only if all of the
following are true:

1. Every reserved paper identifier is accounted for as unused, voided,
   lost/revoked, or used.
2. Every used paper identifier has exactly one governed disposition:
   - an applied C5.1 receipt and linked fact; or
   - an explicit, audited non-application/exclusion decision.
3. No paper mismatch or unresolved duplicate can produce a second effect.
4. Every temporary identity has a governed permanent-match, retained temporary
   disposition, or explicit unresolved status; no safety-critical identity item
   is unresolved.
5. Every in-scope device journal reports its required high-water mark and all
   unsynced/lost-device rows are reconciled or explicitly assigned.
6. Every in-scope external interface has a reconciled C6.1
   `event_consumer_offsets` high-water mark or its approved not-applicable
   disposition.
7. No owner-defined safety-critical reconciliation item or linked task remains
   unresolved.
8. All other unresolved items have a stable role and named owner, plus any
   required C-D7 handoff evidence.
9. The operational incident commander has attested the operational predicate.
10. The clinical safety lead, resolved independently and distinct from the
    commander, has co-attested the clinical predicate.

The closure service locks the incident projection, relevant paper/range and
reconciliation projections, linked open tasks, device-journal high-water-mark
state, and the C6.1 interface-offset rows. It re-evaluates the predicate in the
same transaction that appends the final independent attestation, appends the
clinical audit event, and compare-and-swap closes the incident.

C5.2 reads the C6.1 substrate. It never advances, resets, fabricates, or deletes
an interface high-water mark. A changed HWM, new paper item, reopened task, or
concurrent safety-critical item invalidates the closure snapshot and forces a
fresh review.

Closure does not delete, compact early, or rewrite the incident ledger. A later
corrective fact or alias is appended under a governed post-closure correction
path; the original closure evidence remains visible.

## 11. Database integrity, RLS, grants, and retention

Every new continuity table follows the full design §6.8 contract:

- UUID primary keys and immutable tenant/facility ownership;
- exact foreign keys with intentional `ON DELETE RESTRICT` for clinical and
  evidence links;
- database checks for enums, state transitions where feasible, timestamps,
  all-null/all-present key groups, actor separation, and paper-range bounds;
- partial unique indexes for live/open/current projections;
- append-only triggers for declarations, aliases, attestations, decisions,
  clinical audit, timeline, and receipt evidence;
- no mutable JSON blob as the sole source of a clinical or authorization fact;
- least-privilege grants by runtime role;
- no default public grants;
- tenant-pinned worker transactions; and
- explicit retention/purge behavior for each table and evidence class.

### 11.1 RLS choice

C5.2 chooses the **C3.1-restrictive pattern**, not permissive Pattern A as its
runtime protection:

- row-level security is enabled and forced;
- an explicit restrictive tenant-context policy is ANDed with any retained
  permissive tooling policy;
- absent, empty, malformed, default, bypass, or wrong tenant context matches no
  row;
- facility-scoped access is also checked where the resource is facility-bound;
- runtime application roles receive no table-owner or `BYPASSRLS` escape; and
- background workers pin tenant/facility context inside each transaction.

This is required because incident, paper, receipt, temporary-identity, and
reconciliation rows expose patient and facility existence even when their
payload is not selected. A tooling-compatible permissive policy may remain only
behind the restrictive explicit-context overlay already established by C3.1.

Cross-tenant and cross-facility identifier probes must be indistinguishable from
not-found responses at the external boundary and must never create a receipt,
paper projection, reconciliation item, task, or audit row in the victim scope.

### 11.2 Retention

The build must document the live retention class for:

- immutable incident declarations and aliases;
- paper range and item ledgers;
- temporary identities and merge evidence;
- C5.1 full receipts and compact tombstones;
- attempts and effect evidence;
- reconciliation decisions;
- tasks, SLA instances, comments, and approvals;
- clinical audit and timeline records; and
- readiness/drill evidence.

The minimum deduplication guarantee is the signed C-D10 sequence: accept for no
more than 7 days, retain the full rearm-blocking receipt for 365 days, then
retain the compact tombstone through 2555 days. Purge/compaction is concurrency
safe and cannot turn the same paper tuple into an eligible new command.

## 12. API and authorization shape

The final route names follow repository conventions, but the command boundary
must remain explicit:

- declare/import incident;
- record packet range loss/revocation;
- append incident alias/merge decision;
- register/inspect a paper item;
- record one of the three typed retrospective facts;
- submit/decide a reconciliation item;
- propose/approve/execute a temporary-identity match through the existing merge
  service;
- inspect device/interface reconciliation evidence; and
- attest/check/close an incident.

Every mutating request carries an idempotency identity where applicable and
`expected_version` for mutable projections. The server ignores client-supplied
tenant, facility, staff role, grant, session, device trust, receipt outcome,
queue ownership, SLA, safety-critical state, and closure eligibility as
authority. Those values are resolved or recomputed server-side.

Response envelopes use the landed C4.1 continuity contract. Errors are typed
enough for the Staff/Admin clients to distinguish authorization denial, stale
projection, exact duplicate, mismatch/needs-review, invalid packet/range,
unresolved identity, closure blocker, and retryable infrastructure failure
without parsing human text.

## 13. Gate and drill matrix

### 13.1 Hard review probes

The build and release evidence must include deterministic drills for:

- two valid declarations from duplicate operational commanders;
- split-brain incidents whose paper ranges were both used;
- a duplicate packet/incident import;
- a lost range later presented for back-entry;
- a revoked range later presented for back-entry;
- an incident alias and a later corrective alias without history rewrite;
- exact duplicate paper submission;
- same paper tuple with a different payload;
- concurrent duplicate submissions;
- cross-tenant and cross-facility tuple probes;
- a current-domain-state conflict;
- temporary identity match proposal and distinct clinical coapproval;
- unauthorized or same-person two-key attempts;
- late medication/specimen/transfusion facts that create no physical action,
  retrospective SLA, pathway transition, or patient notification;
- a transfer payload proving no live transfer handler is reachable;
- device journal high-water-mark lag;
- interface high-water-mark lag and changed HWM during closure;
- unresolved safety-critical work during closure;
- commander/safety-lead same-person closure attempt; and
- crash/retry at every receipt/fact/timeline/audit/outbox boundary.

The synthetic suite must prove transaction rollback leaves no partial
authoritative state and that retry reaches one terminal receipt/fact outcome.
The Gate admits zero duplicate or abandoned facts and zero mutable-history
gaps.

### 13.2 Hospital-area/platform exercise grid

The continuity Gate must exercise or explicitly classify every combination of
these eleven hospital areas and four platforms:

| Hospital area | Android | Windows / desktop | Browser / web | iOS |
|---|---|---|---|---|
| Ward | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Emergency department (ED) | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Outpatient department (OPD) | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Theatre / operating room | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| ICU / NICU / PICU | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Maternity | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Cath lab | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Dialysis | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Pharmacy | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Laboratory | Owner classification required | Owner classification required | Owner classification required | Owner classification required |
| Blood bank | Owner classification required | Owner classification required | Owner classification required | Owner classification required |

The current C0.3 matrix leaves include/manual-only/excluded cells unsigned.
Engineering must not invent those owner classifications.

The exercise inventory reconciles every issued, used, voided, lost, and unused
paper identifier before it evaluates closure.

For this technical first build, automated fact adapters exist only for:

- Ward medication administration backfill;
- Laboratory specimen-collection backfill; and
- Blood Bank transfusion-verification backfill.

That is an implementation boundary, not a claim that the corresponding
area/platform cells are owner-approved "included." The other eight areas, other
Ward facts, OPD, Pharmacy, and unsupported platform workflows are outside the
automated C5.2 v1 adapter set. They must not be mislabeled as owner-approved
"manual-only" or "excluded."

Before any Gate can be called complete, the signed C0.3 matrix must name every
included, manual-only, and excluded area/platform row. Release evidence must
list every owner-approved manual-only/excluded row explicitly rather than
hiding it in an aggregate count. Until then, the workbench may be built inert
for validation, but no coverage or activation claim is allowed.

### 13.3 Required receipts

The C5.2 Gate packet includes:

- baseline and prerequisite SHAs;
- migration/schema/RLS/grant/retention verification;
- route and server-authorization matrix;
- transaction fault-injection results;
- duplicate/mismatch/concurrency evidence;
- retrospective no-reperformance/no-retrigger evidence;
- C6.1 late-effect suppression evidence;
- task/SLA generation and audit linkage evidence;
- identity two-key and merge-coverage evidence;
- alias/split-brain/lost-range evidence;
- closure race and high-water-mark evidence;
- all eleven-area/four-platform classifications and exercise results;
- localization/accessibility results for Staff and Admin;
- rollback rehearsal; and
- the two-key signed operational/clinical readiness record required by the plan.

## 14. Expected build file ledger

This is a responsibility ledger, not a promise of exact filenames:

| Area | Expected change |
|---|---|
| Backend migrations | Incident/declaration/range/paper/reconciliation projections; additive C5.1 paper receipt extension; restrictive RLS; grants; append-only guards; retention wiring |
| Backend services | Incident CAS/import, paper receipt claim, retrospective adapters, reconciliation decisions, closure predicate, existing merge-service hardening |
| Backend routes/contracts | Typed Staff/Admin commands and response envelopes; server-owned authorization/context |
| Existing workflow | `tasks` and `workflow_sla_instances` integration; no new workflow engine |
| Existing audit/timeline | Same-transaction `clinical_audit_events` and canonical timeline facts |
| Existing C6.1 | Read-only high-water-mark consumption and late-effect seam reuse; no C6.1 marker writes |
| Staff | Clinical paper entry, patient/encounter review, evidence, and assigned reconciliation work |
| Admin | Incident, packet/range, HIM identity, interface, aggregate queue, and closure workbench |
| Tests | Unit, transaction integration, RLS/grant, concurrency, negative-effect, UI, drill, and Gate receipts |
| Docs | Operator runbook, API/data contract, retention mapping, drill matrix, and rollback procedure |

The build must first inventory the exact landed files and minimize the diff.
Unexpected ownership overlap with AF, C5.1, C6.1, or another occupied continuity
lane is a stop condition.

## 15. Rollback

Rollback disables new declaration, back-entry, reconciliation, identity-match,
and closure writes and removes the workbench entry points. It does not:

- delete or rewrite incident declarations, aliases, paper ledgers, receipts,
  tombstones, attempts, facts, timeline entries, audit events, tasks, SLA
  instances, merge decisions, or closure attestations;
- reopen C5.1 receipts;
- rewind C6.1 interface high-water marks;
- relabel paper-only actions as electronic replay actions; or
- activate a legacy generic command path.

If a code rollback leaves the new schema in place, older code receives no grants
to mutate it. A forward-compatible read/export path remains available for
authorized reconciliation and incident review.

## 16. Explicit non-goals

C5.2 does not:

- redefine or replace the C5.1 receipt/attempt/effect-evidence substrate;
- add C6.1 writes, reset interface offsets, or define new external-interface
  recovery policy;
- change the C4.2 action registry or make a paper-only action electronically
  replayable;
- change owner policy or fill blank C0.3 classifications;
- perform paper-form graphic design or design the graphic layout of wristbands,
  packets, phone trees, or contact sheets;
- create a second task, SLA, audit, clinical timeline, patient merge, approval,
  or notification engine;
- add a generic back-entry/replay endpoint;
- create a permanent patient directly from a downtime temporary identity;
- authorize offline electronic break-glass;
- deploy, activate, merge, or claim production readiness; or
- reserve a migration number before prerequisites land.

Coordinator acceptance of this delta authorizes only the later build queue
entry. Production activation remains a separate, two-key governed decision
after all continuity Gates and owner classifications are complete.

## 17. Coordinator clearance record

The coordinator approved this delta as written on 2026-07-31 and adopted the
§2 stop conditions verbatim as the build gate. This clearance changes the
design status only. It does not authorize implementation, reserve a migration,
activate continuity mode, merge, or deploy.

The coordinator expressly ratified:

1. the §1.1 correction that C-D3 governs action classification while C-D7
   governs unresolved-work preservation and the immutable `needs_review`
   handoff;
2. the two-surface Staff/Admin workbench with server-only authority and shared
   generated contracts;
3. the additive paper-source extension to C5.1 as the sole command-effect
   authority, with no paper-receipt table;
4. dedicated retrospective fact adapters behind the landed C6.1 late-effect
   seam and the `occurred_at` / `recorded_at` / `reviewed_at` three-clock
   contract;
5. typed reconciliation queues on the existing task engine, preserving the
   immutable task-to-SLA generation pairing; and
6. the closure predicate with independent operational-commander and clinical
   safety-lead attestation.

Live prerequisite receipt when this clearance was recorded:

- `github/main` is
  `1d602c0acef815b0e533f86b6ef304b8447a80e5`, merge of C4.1 PR
  [#667](https://github.com/Bahuleyandr/VH-Health-Platform/pull/667);
- the AF/facility-context worktree is actively building and remains unmerged;
  its remote branch still points to
  `f77d0ed208841054b2bb0376e29d12bcfdabe1fc`;
- the coordinator-cleared C5.1 design branch remains unmerged at
  `d387b1185f20c52f62e7940fa532211be50bdf6e`; and
- no open AF, C5.1, or C5.2 pull request exists at this snapshot.

PR #667 does not require a docs-lane rebase. The next permissible C5.2 action
is a fresh gate check after AF and C5.1 have landed. At build kickoff, fetch
and rebase onto current `github/main`, revalidate every §2 contract, derive the
migration number, and only then open the approved file ledger. Until those
conditions are true, this lane holds with no backend, migration, Prisma, Staff,
Admin, shared-contract, test, activation, or deployment work.
