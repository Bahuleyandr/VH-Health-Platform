# C5.1 replay receipts and domain-route conformance — backend design delta

**Status:** coordinator-cleared 2026-07-31; Step 2 remains held at the section
2 gates and is not authorized<br>
**Scope:** `apps/backend`, one re-derived migration, regenerated
`apps/backend/prisma/schema.prisma`, backend tests, and this record only<br>
**Branch:** `feat/continuity-c5-1-replay-receipts`<br>
**Baseline:** re-fetched `github/main` and `origin/main` at
`48509b1a8e5ff011905c01ef7370a85bf2fa7a0d`
(`2026-07-31T07:42:04+05:30`)<br>
**Merged prerequisite:** C4.2 PR
[#660](https://github.com/Bahuleyandr/VH-Health-Platform/pull/660), merge
`64739bde040075018f52dfddb0b889b9337cd1a5`, migration
`602_clinical_continuity_action_registry.sql`<br>
**Build order:** coordinator queue `AF -> C5.1`; C6.1-A is merged and the
default-off facility-context build remains the immediate predecessor<br>
**Migration:** not reserved; re-list and derive the next free number only at
the cleared build kickoff<br>
**Activation:** none<br>
**Merge state:** never merge from this lane

## 1. Outcome and binding boundary

C5.1 adds the server-side immutable command-effect guard for an approved
clinical-continuity command. It joins an online first attempt, an ambiguous or
lost response, and every later queue retry through one pre-persisted
`(tenant_id, client_event_id)` identity. An exact duplicate returns the
authorized original typed outcome without another domain effect. A conflicting
command, expired command, policy conflict, concurrency conflict, or
unauthorized replay fails closed.

The first build supports exactly the two executable C4.2 actions already on
main:

| Action ID | Existing authoritative binding | C5.1 effect |
|---|---|---|
| `emr.nursing_note.draft.store` | `emr.note_draft.store/v1`, `PUT /api/v1/emr/notes/draft`, nursing draft schema | Private draft storage only |
| `emr.op_note.draft.store` | `emr.note_draft.store/v1`, `PUT /api/v1/emr/notes/draft`, OP draft schema | Private draft storage only |

Both use the same named route handler and binding ID with disjoint schemas.
The other 15 catalogue actions and `unknown` remain non-executable. C5.1 does
not add an action, route, method, URL, handler, schema, binding, policy,
compatibility rule, or activation record.

The current draft contract remains load-bearing: a stored unsigned draft is
the composing clinician's private scratchpad. It creates no patient-visible
`clinical_timeline_events`, no `clinical_audit_events`, no
`workflow_sla_instances`, no notification, no `event_outbox` row, no task
settlement, and no care-pathway transition. The receipt proves storage only.
Finalization remains a separate, freshly authorized online user action through
the existing note-create/sign path.

## 2. Sequencing and build-time stop conditions

The Step 2 build starts only after all of these checks pass against freshly
fetched `github/main`:

1. C6.1-A is merged and its migration, event-time contract, database-backed
   late-effect seam, and five-projector parity proof match the cleared
   `feat/continuity-c6-1-resume-markers` delta.
2. The facility-context build is merged and produces the server-owned
   `req.continuityFacilityContext` described by
   `docs/continuity/c4-facility-context-design-delta.md`.
3. The facility resolver still derives tenant, facility, actor, stable device,
   access-session, grant, policy, and revocation state from authenticated
   server state. A client header remains evidence only.
4. The C4.1 landed envelope contains exactly the fields and invariants in the
   cleared `feat/continuity-c4-1-queue-envelope` delta. Any renamed, omitted,
   newly inferred, or differently canonicalized field stops the build.
5. C4.2 still has exactly 17 approved action IDs, `unknown`, and exactly the
   two executable bindings above. Any binding-registry, handler, schema,
   policy-evaluator, or route-order drift stops the build.
6. The next migration number is derived after both prerequisite migrations
   land. No number in this document is a reservation.

C6.1 owns the database-backed late-effect fence and every projector edit.
C5.1 consumes the landed seam; it does not restate, fork, or modify it. If the
landed C6.1 shape differs from its cleared delta, this lane stops and surfaces
the divergence instead of adapting silently.

## 3. One binding registry, including transaction capability

The signed registry continues to carry only
`replayEndpoint.bindingId`. It never carries a method, URL, handler, or caller
selected execution target.

C5.1 extends the existing
`clinicalContinuityActionBindingRegistry.js` registration record; it does not
add a replay dispatcher, binding map, route table, or switch statement.
`registerClinicalContinuityActionRoute()` gains one server-owned
`transactionalHandler` reference and an exact effect contract for each mounted
action. The existing unconditional boot assertion additionally proves:

- the action ID and signed binding ID still match;
- method, full route, named Express handler, and schema object references
  still match;
- the transactional handler is the expected exact function reference;
- the handler declares that it accepts the caller-supplied tenant transaction;
- its effect contract is `private_draft_storage_only`; and
- no default-deny action has a transactional handler.

The C5.1 coordinator calls
`resolveClinicalContinuityActionBinding()` and executes the transactional
handler returned by that same registration. A missing transaction handler or
an effect-contract mismatch makes the action non-replayable at boot and at
request time. This is the plan's rule that a domain handler unable to use the
caller's transaction is ineligible.

The ordinary online route keeps its existing named controller. The controller
uses the C5.1 coordinator only for a fully validated continuity request;
untagged ordinary online draft saves keep the current route behavior.

## 4. Closed command identity and canonical comparison

### 4.1 No new semantic envelope field

The server consumes the C4.1 immutable envelope as landed. It does not infer a
missing tenant, facility, actor, patient, occurrence time, policy, schema,
ordering identity, base revision, or payload value.

The closed normalized input contains the existing C4.1 fields:

- command and transport identity: `client_event_id`, `idempotency_key`,
  `action_id`, client `command_fingerprint`, and `payload_hash`;
- client/schema authority: `app_version`, `envelope_schema_version`,
  `queue_schema_version`, `action_version`, `action_checksum`,
  `action_schema_id`, `action_schema_version`, `action_schema_checksum`,
  `policy_id`, `policy_version`, `policy_checksum`,
  `policy_signing_key_id`, `policy_effective_from`,
  `policy_effective_until`, `policy_supersedes_id`,
  `policy_revocation_epoch`, `registry_version`, `registry_checksum`, and
  `minimum_app_version`;
- capture identity: `tenant_id`, `facility_id`, `unit_id`, `device_id`,
  `device_posture`, `capture_session_id`, optional signed `incident_id`,
  `capture_actor_uuid`, and `capture_role`;
- target identity: `patient_reference`, `encounter_id`, `appointment_id`, and
  `admission_id`;
- time and source evidence: `occurred_at`, `captured_at`, `queued_at`,
  `clock_evidence`, `cached_sources`, `source_cache_version`, and
  `expires_at`;
- concurrency and causal order: `base_revision`, `base_etag`,
  `ordering_key`, `ordering_key_digest`, `sequence`,
  `predecessor_client_event_id`, `supersession_generation`, and
  `human_review_required`; and
- the canonical route payload, validated by the C4.2 schema.

Explicit null stays explicit null where the action contract permits absence.
A missing required field, default tenant, malformed UUID/version/checksum,
untrusted clock, expired command, missing base revision, or inconsistent
identity is a typed fail-closed result before any domain mutation.

`received_at`, authoritative `recorded_at`, current replay actor, current
replay role/capability, and server binding are server facts. They are not
fabricated into the capture envelope.

### 4.2 Two checked fingerprints, one server effect identity

The server first recomputes the existing C4.1 client command fingerprint from
the exact landed C4.1 projection using RFC 8785 JCS and SHA-256. It separately
recomputes `payload_hash` from the route body. Neither supplied digest is
trusted without equality to the recomputed value.

The immutable receipt fingerprint is a second server-computed RFC 8785
JCS/SHA-256 value. It covers:

- the verified client command fingerprint and canonical payload hash;
- action ID;
- the server-resolved binding ID, HTTP method, schema ID, schema version, and
  schema checksum;
- stable capture actor and role;
- tenant, facility, unit, device, and device posture;
- patient, encounter, appointment, and admission targets;
- capture session and optional signed incident;
- occurrence, capture, queue, expiry, clock, and cached-source evidence;
- action, policy, registry, app, envelope, and schema authority;
- base revision/ETag; and
- raw ordering identity, its C4.1 opaque ordering digest, sequence,
  predecessor, supersession generation, and human-review requirement.

The method and binding are server-derived. They are not added to the client
envelope and cannot be selected by a caller.

As required by C4.1, `client_event_id`, `idempotency_key`, current replay
actor, retry/lease state, `received_at`, and `recorded_at` are excluded from the
semantic fingerprint. The receipt stores the first two separately and an exact
duplicate must match both as well as the server receipt fingerprint. Reuse of a
client event with a different idempotency key is
`CONTINUITY_REPLAY_IDEMPOTENCY_IDENTITY_MISMATCH`, not a duplicate success.

The conformance suite mutates every bound field above one at a time while
holding `(tenant_id, client_event_id)` constant. Every mutation returns the
same low-information typed `needs_review` shape and creates no effect.

### 4.3 Lost-response join

C4.1's pre-attempt invariant is the client half of the join:

1. before the first online socket attempt, the client commits one
   `client_event_id`, idempotency key, action ID, payload hash, and command
   fingerprint;
2. the online attempt uses that persisted identity;
3. timeout, connection loss, process death, or a lost HTTP response does not
   mint another identity; and
4. the queue later sends the same persisted event, key, action, fingerprint,
   and payload.

The server half is exact:

1. the first successful request commits the receipt and draft effect together;
2. response delivery and generic-idempotency finalization happen only after
   that commit;
3. a later queue request performs current authorization, then looks up
   `(tenant_id, client_event_id)` before the generic response cache can
   re-execute or replay a response;
4. equal idempotency key and receipt fingerprint return the original typed
   outcome with no draft write; and
5. any inequality becomes owned `needs_review`.

A generic idempotency row may be absent, in-flight, expired, deleted, or
re-armed after 24 hours. None of those states can re-arm a committed clinical
receipt.

## 5. Current authorization before receipt visibility

Receipt lookup is not an existence oracle. No request can learn whether a
receipt exists until current authorization succeeds.

### 5.1 Phase-0 authorization

Before any receipt query, the route:

1. authenticates the current Staff JWT and tenant;
2. resolves the current server-owned facility context and verifies its grant,
   device, access-session, policy, expiry, and revocation state;
3. resolves the action through the one C4.2 binding registry;
4. runs the current and exact historical C4.2 policy checks;
5. derives current role and replay capability from the server role graph;
6. validates the incoming patient/resource target and current patient
   visibility through the existing access-decision path;
7. validates the action schema, occurrence/clock evidence, source freshness,
   expiry, and optimistic-concurrency shape; and
8. validates capture-actor versus current-replay-actor rules.

Failure returns a generic authorization or owned-review response. It does not
say whether an event ID, fingerprint, patient, facility, or receipt exists.

After tenant-scoped receipt retrieval, the service re-authorizes the current
actor against the receipt's actual action, facility, patient, and resource
before returning a duplicate, mismatch, original outcome, or tombstone
outcome. An incoming body naming an authorized patient cannot be used to probe
a receipt belonging to another patient.

The first-apply transaction rechecks the load-bearing facility grant, policy,
patient/resource access, and replay capability under the caller-supplied
tenant transaction immediately before the receipt claim. Phase-0 authorization
is not used as a stale write capability.

### 5.2 Capture actor and replay actor

The receipt binds the stable `capture_actor_uuid` and capture-role snapshot.
Every request separately appends the current replay actor UID, role,
capability result, facility context, request ID, decision, and reason to the
attempt ledger. A replay never rewrites or substitutes the capture actor.

Same-actor replay is the only automatically applicable actor shape in this
first build.

C0A's attested handoff remains exactly what its approved record says:
`handoff_attested_by` plus `handoff_attested_at`, recorded once by the current
owner on a `needs_review` row. It is immutable, preserves the row, stops an
ordinary logout block, and does **not** resolve, retry, or make the row
drainable.

The current C4.1 envelope does not contain a server-verifiable handoff artifact
binding the event, original actor, recipient/reconciliation principal,
tenant/facility, attestation time, and device/grant signature. The local C0A
columns cannot be promoted into server authority by trusting client input.
Until the coordinator clears such an artifact or a server-side handoff record,
a different current actor receives
`CONTINUITY_REPLAY_HANDOFF_SERVER_PROOF_REQUIRED` and the command remains
`needs_review`. C5.1 does not widen the approved C0A attestation semantics and
does not build the C5.2 workbench.

## 6. Receipt, evidence, and attempt model

Names below are build proposals, not reserved migrations.

### 6.1 `clinical_continuity_replay_receipts`

This is the compact, immutable command-effect guard. It contains no canonical
payload and no cached full HTTP response.

Required columns and constraints include:

- tenant-first primary identity and a non-null
  `UNIQUE (tenant_id, client_event_id)`;
- non-null tenant, facility, client event, original idempotency key, action ID,
  binding ID, method, schema identity, client command fingerprint, server
  receipt fingerprint, and payload hash;
- capture actor/role, patient and applicable appointment/encounter/admission,
  capture session, optional incident, occurrence/capture/queue/expiry times,
  source/clock evidence hashes, concurrency values, and ordering identity;
- action, policy, registry, app, envelope, and schema version/checksum
  bindings;
- server `received_at`, authoritative `recorded_at`, terminal disposition, and
  typed outcome code;
- signed retention-policy identity plus detailed-evidence, replay-eligibility,
  and tombstone horizons when owner-approved; and
- a claim transaction identity used only to prove that provisional claim to
  terminal finalization occurs inside the same database transaction.

Only `applied` and `needs_review` are committed terminal dispositions. A
provisional `claimed` row is never externally visible and may never commit.
`already_applied` is a typed response derived from an immutable applied guard
whose detailed evidence has been compacted; it is not a re-armed state.

The database mutation guard permits exactly one
`claimed -> applied|needs_review` finalization when the stored claim
transaction is the current transaction. Every later update and every ordinary
delete is rejected. A failed transaction rolls back the provisional row.

The claim uses `INSERT ... ON CONFLICT DO NOTHING RETURNING`, not a swallowed
unique violation. A concurrent loser waits for the winner, then follows the
authorized duplicate comparison path without placing the transaction into
PostgreSQL's aborted state.

### 6.2 `clinical_continuity_replay_effect_evidence`

Detailed typed outcome and direct effect references live in a one-to-one
immutable child so they can be compacted without rewriting the command guard.
For this two-action slice it has:

- same-tenant receipt reference;
- a direct same-tenant `note_draft_id` foreign key;
- the original typed `draft_stored` outcome fields needed to reconstruct the
  response, excluding note content; and
- nullable direct canonical timeline, clinical audit, SLA, and outbox
  reference columns constrained to null for
  `private_draft_storage_only`.

There is no application-only `resource_type/resource_id` polymorphic pointer.
When a later action is approved, its slice adds the exact composite foreign
key or dedicated effect-reference table needed for that domain. It does not
put an unchecked identifier in this table.

Deleting detailed evidence is a privileged, policy-bound compaction action.
It does not delete or alter the receipt guard. After compaction an exact
authorized duplicate returns typed `already_applied` with no historical
response or domain-content promise.

### 6.3 `clinical_continuity_replay_attempts`

Every lease, retry, duplicate lookup, actor decision, fingerprint mismatch,
transaction failure, compaction decision, tombstone return, and manual-review
decision is an append-only row. It records:

- tenant, event ID, and optional same-tenant receipt reference;
- current replay actor and role;
- facility-context identity/revision and request ID;
- attempt/decision time, attempt class, typed reason, and result;
- the original idempotency-key hash, never payload or full response; and
- server-verifiable handoff evidence only when a future cleared contract
  supplies it.

The table has no update or delete path. An applied first attempt writes its
attempt row inside the same Phase-1 transaction. If Phase 1 rolls back, a
separate post-rollback tenant transaction appends the failure attempt; failure
of that append is surfaced and logged but cannot convert the rolled-back
command into `applied`.

Unauthorized receipt probes write a bounded security decision without a
receipt link or patient/action detail that would create another oracle.

## 7. Section 6.8 integrity, RLS, privilege, and retention

### 7.1 Database integrity

Every new table:

- has non-null tenant scope and rejects
  `00000000-0000-4000-8000-000000000001`;
- uses tenant-prefixed primary, unique, and lookup indexes;
- references `(tenant_id, facility_id)` through
  `facilities (tenant_id, id)` and `ux_facilities_tenant_id`;
- references capture/replay actors and patients through same-tenant composite
  user anchors;
- references appointments, encounters, admissions, receipts, and note drafts
  through same-tenant composite anchors;
- adds any server-derived integer patient key needed only to enforce an
  appointment-to-patient composite foreign key; that derived key is not a new
  client-envelope field or fingerprint input;
- rejects a target-column shape inconsistent with the registered action; and
- proves direct SQL cannot create a cross-tenant, cross-facility, default
  tenant, dangling, or mismatched reference.

Application validation alone is not accepted as relationship integrity.

`note_drafts` gains a tenant/id unique anchor and the revision needed by the
CAS contract. It does not gain a second payload copy or canonical-event
coupling.

### 7.2 C3.1-restrictive RLS, not permissive Pattern A

The receipt, effect-evidence, and attempt tables use `ENABLE ROW LEVEL
SECURITY`, `FORCE ROW LEVEL SECURITY`, and the C3.1-style restrictive
explicit-context policy. Unset, empty, `bypass`, wrong-tenant, and default
tenant contexts match no row.

This is deliberately stricter than Pattern A. Receipt existence, event IDs,
actors, facilities, patient targets, and effect references are a clinical
existence oracle, and C5.1 has no valid cross-tenant runtime reader. A
super-admin-style `bypass` GUC must not expose them. Background reconciliation
and compaction operate one explicitly pinned tenant at a time through
`setTenantTx`.

Runtime application roles receive no direct `UPDATE`, `DELETE`, or `TRUNCATE`.
They receive only the minimum `SELECT`/`INSERT` columns or narrowly scoped,
migration-owned functions needed to:

- claim and finalize a receipt in the current tenant transaction;
- resolve an authorized duplicate after application-layer authorization;
- append an attempt;
- insert effect evidence; and
- compact evidence only under an approved signed retention binding.

Functions pin `search_path`, validate the exact tenant GUC, reject `bypass`,
and are revoked from `PUBLIC`. Migration roles retain schema-management
authority. Runtime-role and migration-owner direct-SQL tests are separate so
RLS, grants, and hard database constraints are each proven.

### 7.3 C-D10 alignment and no invented duration

The countersigned C-D10 partial record supplies only continuity-pack and edge
access-log retention. It does **not** supply receipt/tombstone,
replay-attempt, server replay-eligibility, client-return, or reconciliation
horizons. Those values remain owner input.

Therefore:

- the build contains no production default duration;
- a previously unseen command after its signed C4.1 `expires_at` fails closed
  to `needs_review`;
- no receipt, tombstone, effect evidence, or attempt is deleted while the
  command can still be accepted, while reconciliation is open, or while a
  legal/audit hold applies;
- detailed-effect compaction and tombstone deletion require a signed
  retention-policy binding whose horizons cover maximum offline age, app
  upgrade/return, paper reconciliation, audit/legal obligations, and every
  server replay-eligibility window;
- the tombstone horizon cannot be shorter than automatic replay eligibility;
  and
- absent that signed binding, compaction and deletion fail closed and evidence
  is retained.

Synthetic tests may inject short policy horizons. They are proof fixtures, not
production values or owner decisions.

## 8. One transaction and the backend phase doctrine

### 8.1 Phase 0 — preflight, no effect and no receipt disclosure

Phase 0 performs request parsing, canonicalization, schema validation, binding
resolution, current/historical policy evaluation, facility/grant
verification, patient/resource visibility, actor/capability checks, clock and
expiry validation, handoff validation, and optimistic-concurrency shape
validation.

These are preflight reads. They may use tenant-scoped read transactions but
create no receipt or domain effect. No external, slow, notification, logging,
or best-effort operation runs in the effect transaction.

After authorization, an existing receipt is handled in a short tenant
transaction that rechecks authorization against the receipt target, appends
the duplicate/mismatch attempt, and returns the typed result. It performs no
domain write.

### 8.2 Generic-idempotency claim — auxiliary, not clinical authority

For a new event, C5.1 mounts the existing `requireIdempotencyKey` middleware on
the draft route after current authorization and receipt precheck. The current
route does not mount that middleware; C5.1 adds it rather than creating a
second generic-key implementation. It is conditionally required and
fail-closed for a continuity-tagged request while remaining optional for an
ordinary untagged online draft save.

Its existing `(tenant, user, key, path)` body-hash claim supplies an additional
route-level concurrency guard. It does not claim or finalize the clinical
receipt and never authorizes `applied`.

The middleware gains a continuity-aware replay hook:

- a committed C5.1 receipt has already been resolved before the generic cache;
- generic `in_flight` with no receipt returns retryable/in-flight, not applied;
- generic `replay` with no committed matching receipt is an orphaned cached
  response and becomes `CONTINUITY_REPLAY_RECEIPT_MISSING_NEEDS_REVIEW`;
- generic payload mismatch remains an error;
- generic store unavailability remains fail-closed for a new continuity
  command; and
- the 24-hour reclaim path may proceed only as far as C5.1 receipt precheck,
  which prevents another effect.

The generic table is neither removed nor weakened, but its expiring cached
response cannot override the immutable clinical command guard.

### 8.3 Phase 1 — one tenant effect transaction

The coordinator opens one `setTenantTx(..., { isolationLevel:
'Serializable' })` transaction and performs, in order:

1. recheck current facility/grant, policy, patient/resource visibility, replay
   capability, and action binding;
2. claim the provisional receipt;
3. compare an existing concurrent receipt or continue as the new owner;
4. call the exact transactional domain handler returned by the existing
   binding registry;
5. enforce the note-draft optimistic-concurrency predicate;
6. insert the direct effect-evidence row;
7. append the current replay-actor attempt/audit row;
8. assert the action effect contract — one draft effect and zero canonical
   timeline, clinical audit, SLA, notification, outbox, task-settlement, and
   pathway-transition effects; and
9. finalize the receipt with the typed outcome.

Every `tx.*` call is required to succeed. There is no swallowed error and no
best-effort call. Failure of receipt claim/finalization, domain mutation,
effect evidence, replay-actor audit, or effect-contract assertion rolls the
entire transaction back. A serialization retry starts a new tenant
transaction with the same persisted command identity; it does not mint a new
event or key.

For a future authoritative action, steps 6 and 8 require its exact domain,
canonical timeline/audit, SLA, and outbox references. A missing required
reference or an unexpected forbidden reference aborts the transaction.

### 8.4 Phase 1.5 — post-commit auxiliary work

Only after Phase 1 commits may the route:

- serialize the response;
- let the existing generic middleware finalize its response cache;
- emit metrics or bounded operational logs; and
- schedule any permitted post-commit work.

Generic-cache finalization failure cannot downgrade or re-arm a committed
receipt. Conversely, transport `2xx` or `202`, generic cache state, a client
`applied` flag, or a response body without the matching committed receipt can
never upgrade a command to applied.

If Phase 1 rolls back, the service appends the failure attempt in a separate
tenant transaction. That append contains no domain write and cannot conceal
the original failure.

### 8.5 Phase 2

The two draft-store actions have no slow/external Phase-2 work. Adding an LLM,
PDF, provider call, notification send, or other external operation to the
transactional handler fails the binding/conformance gate.

## 9. Note-draft transaction adapter and concurrency

The existing `clinicalNoteDraftService.upsertNoteDraft()` opens its own tenant
transaction, so it cannot be used unchanged by C5.1.

The service is split without duplicating business rules:

- validation/canonicalization remains one shared function;
- `upsertNoteDraftTx(tx, input)` requires a branded tenant transaction and
  never opens another transaction;
- the ordinary online wrapper continues to call `setTenantTx` and delegates
  to the same `upsertNoteDraftTx`; and
- the binding registry records that exact transactional function.

`note_drafts` gains a monotonic `revision`:

- existing rows backfill to revision 1;
- a new logical draft uses `base_revision = 0` and inserts only when no context
  row exists;
- an existing draft updates only when its stored revision equals the captured
  `base_revision`, then increments once;
- a missing row for a positive base revision, an existing row for base 0, or a
  revision mismatch becomes owned
  `CONTINUITY_REPLAY_CONCURRENCY_NEEDS_REVIEW`; and
- ordinary online saves also increment and return the revision so the server
  has one concurrency language.

The receipt is not a substitute for this CAS. The receipt prevents one command
from applying twice; the revision prevents two different commands based on the
same stale draft state from overwriting one another.

Draft coalescing/finalization races remain client-led causal evidence:

- only never-attempted draft generations may be superseded/cancelled in C4.1;
- an attempted or ambiguous predecessor is preserved;
- the server requires predecessor/generation identity in the fingerprint;
- a predecessor not terminally compatible becomes `needs_review`; and
- a concurrent online finalize or later draft revision makes the replay CAS
  fail rather than recreating or overwriting a finalized clinical note.

Legacy untagged online calls never become continuity commands. Missing
continuity metadata cannot turn a legacy request into an applied receipt, and
legacy/physical-action rows remain non-executable.

## 10. Occurrence time and the C6.1 ownership boundary

For the two current draft actions, the signed action catalogue says capture
time is the occurrence-time contract. C5.1 validates `occurred_at` separately
from server `recorded_at`, binds both in the receipt, and preserves them in
attempt evidence. It never substitutes arrival time for occurrence time.

Draft storage emits no outbox row and invokes no projector. The real-route
conformance tests prove zero rows in:

- `clinical_timeline_events`;
- `clinical_audit_events`;
- `workflow_sla_instances`;
- `notification_outbox`;
- `event_outbox`;
- `care_pathway_transition_events`; and
- applicable task/pathway projections.

C6.1-A exclusively owns:

- `event_outbox.occurred_at` and its provenance contract;
- the database-backed `late_pending_only` effect guard;
- replay-origin outbox requirements;
- `pathwayProjectorService` changes; and
- normalization of diagnostic, referral, OP, inpatient, and emergency
  projectors.

C5.1 edits none of those files. A later authoritative replay action must call
the exact landed C6.1 seam and persist its signed late disposition before
finalizing a receipt. If that API or database shape is not the one cleared in
the C6.1 delta, onboarding stops for coordinator review.

## 11. Reusable real-route conformance suite

One suite factory is parameterized by the approved binding:

`runClinicalContinuityReplayConformance({ actionId, schema, bodyFactory,
expectedEffectContract })`.

The first build instantiates it twice, once for
`emr.nursing_note.draft.store` and once for
`emr.op_note.draft.store`. Each case sends authenticated HTTP requests through
the real Express app, real middleware order, real binding registry, real
controller, real transactional note-draft handler, and a migrated scratch
PostgreSQL database. Route or handler mocks are prohibited.

Fault injection uses scratch-database constraints/triggers and deterministic
post-commit transport hooks. It does not replace the real route or domain
service with a mock.

### 11.1 Gate matrix

| Plan gate | Required proof for each real route |
|---|---|
| Atomicity | Receipt-claim/finalize failure, note-draft failure, effect-evidence failure, and replay-audit failure each leave zero partial domain/receipt/effect rows. Forbidden canonical/SLA/outbox triggers observe zero calls. |
| Actor | Same capture/replay actor applies; revoked, wrong-role, missing-capability, wrong-device, and different-actor-without-server-proof requests fail before receipt disclosure. Capture actor remains immutable and replay actor is appended separately. |
| Tenancy and facility | Default, unset, empty, `bypass`, wrong tenant, wrong facility, cross-tenant patient, cross-tenant receipt, and worker cross-tenant access fail at both service and database layers. |
| Occurrence/recorded time | Valid capture occurrence is retained, server recorded time is distinct, invalid/uncertain/expired time fails closed, and drafts create no event-time-bearing canonical/outbox effect. |
| Idempotency and replay | Exact event/key/fingerprint retry returns the original typed outcome; same event with a different key or any fingerprint input mismatch becomes `needs_review`; no second draft revision is written. |
| Lost response | A real route commits, the transport response is dropped before generic-cache finalization, and the same pre-persisted queued command returns the committed receipt with one draft effect. |
| Policy supersession | Exact current policy applies; an explicitly compatible historical policy applies; revoked, compromised, absent-compatibility, review-only, and mismatched authority become owned review with no effect. |
| Concurrency | Concurrent identical requests produce one effect; concurrent different keys with one event cannot escape the receipt unique constraint; two different events on one stale draft revision cannot overwrite each other. |
| Binding | Method/action/schema/handler/transactional-handler drift fails boot; default-deny actions have no executable transaction binding. |
| Canonical/audit/SLA/outbox | The draft contract creates zero patient-visible canonical, clinical-audit, SLA, notification, outbox, task-settlement, or pathway rows while its required private replay audit commits with the receipt. |
| Draft non-advancement | Store, duplicate, late, superseded, finalize-race, and legacy-return cases never create or settle clinical completion evidence. |
| UCP projection behavior | All five projector inputs and pathway state remain byte-identical because no draft outbox event exists; C6.1 parity suites remain unchanged. |

### 11.2 Mandatory additional cases

The suite additionally proves:

- a committed online command with a lost response is not repeated when the
  same pre-persisted command later enters the queue;
- receipt, draft, private replay audit, and effect evidence roll back as one
  unit;
- no duplicate logical effect can escape through a new response, receipt,
  generic-idempotency row, or outbox row ID;
- `202`, malformed `2xx`, success without the exact committed typed receipt,
  and a receipt with the wrong event/fingerprint remain unresolved;
- exact duplicates after detailed-evidence compaction return authorized typed
  `already_applied` without a historical response;
- a previously unseen command after `expires_at` becomes `needs_review` and
  cannot execute;
- late draft storage never starts/settles an SLA, transitions a pathway, or
  notifies;
- draft coalesce/finalize races cannot create an authoritative note; and
- legacy clients and preserved physical-action rows cannot enter the receipt
  coordinator.

Every plan-listed bound field has a named one-field fingerprint-mismatch test.
The test table is generated from the canonical projection's closed key list so
adding a key without a mismatch case fails the suite.

## 12. Lifecycle, compaction, and rollback

The first applied result is non-rearmable:

1. while detailed effect evidence exists, an exact authorized duplicate
   returns the original minimal typed outcome;
2. after the owner-approved detailed-evidence horizon, a privileged
   tenant-pinned compactor removes only the evidence child and append-records
   the decision;
3. the immutable core receipt then serves as the compact tombstone and exact
   duplicates return `already_applied`;
4. a previously unseen command beyond signed replay eligibility returns
   `needs_review`; and
5. tombstone deletion is permitted only after the separately approved
   deduplication horizon, command expiry, closed reconciliation, and every
   audit/legal hold.

Until C-D10 supplies the missing values, steps 2 and 5 are disabled and
evidence is retained.

Rollback disables the C5.1 coordinator and automated drain for these actions.
It does not:

- drop or rewrite receipts;
- delete detailed evidence or attempts;
- roll back a draft revision;
- re-arm the generic idempotency cache as clinical authority;
- restore an unsafe legacy/physical-action replay path; or
- alter C4.2, C6.1, or facility-context evidence.

Unresolved work returns to manual governed reconciliation. No queue or receipt
is cleared to make status appear healthy.

## 13. Expected Step 2 file ledger

Exact paths are revalidated after both queued prerequisites merge. Any added or
substituted path requires a revised delta.

### 13.1 Add

- `apps/backend/src/migrations/<next-free>_clinical_continuity_replay_receipts.sql`
- `apps/backend/src/middleware/clinicalContinuityReplayMiddleware.js`
- `apps/backend/src/services/downtime/clinicalContinuityReplayReceiptService.js`
- `apps/backend/src/validators/clinicalContinuityReplayEnvelope.js`
- `apps/backend/src/tests/deep/clinicalContinuityReplayReceiptMigration.deep.test.js`
- `apps/backend/src/tests/clinical-continuity-replay-conformance.deep.test.js`
- `apps/backend/src/tests/helpers/clinicalContinuityReplayConformance.js`
- `apps/backend/src/tests/unit/clinicalContinuityReplayEnvelope.test.js`
- `apps/backend/src/tests/unit/clinicalContinuityReplayReceiptService.test.js`
- this design record

### 13.2 Modify

- `apps/backend/prisma/schema.prisma`
- `apps/backend/src/config/downtimeConfig.js`
- `apps/backend/src/controllers/emr/clinicalNoteDraftController.js`
- `apps/backend/src/middleware/idempotencyMiddleware.js`
- `apps/backend/src/middleware/clinicalContinuityActionPolicyMiddleware.js`
- `apps/backend/src/routes/emr/clinicalNotesRoutes.js`
- `apps/backend/src/services/downtime/clinicalContinuityActionBindingRegistry.js`
- `apps/backend/src/services/downtime/clinicalContinuityActionRegistryService.js`
- `apps/backend/src/services/emr/clinicalNoteDraftService.js`
- focused existing unit/deep tests for the files above
- `apps/backend/src/utils/validateEnv.js`

The build re-runs OpenAPI generation/checks. If the normalized C5.1 transport
contract requires a source or generated OpenAPI path, that exact path is added
to a coordinator-approved ledger revision before editing.

There is no Staff, Patient, Admin, shared Dart, infrastructure, deployment,
policy-registry catalogue, C6.1 service, event-outbox, pathway-projector,
reconciliation-workbench, or activation file in the ledger.

## 14. Standard build receipts after clearance

Step 2 retains command logs under
`D:\Dev\_codex\artifacts\logs\<date>\c5-1-replay-receipts\` and records:

- refreshed prerequisite SHAs, PR/merge states, worktree collision check, and
  the re-derived migration number;
- migration fresh-apply, re-run, rollback-preservation, constraint, trigger,
  RLS, grant, and direct-SQL negative proofs;
- `npx prisma db pull --schema=prisma/schema.prisma` and schema-drift proof;
- backend format, `npm run lint`, raw-parameter lint, and focused unit/deep
  suites;
- both real-route conformance instantiations and every gate in section 11;
- full backend Jest shards;
- OpenAPI/Swagger checks;
- dependency, secret, Semgrep, and CodeQL checks applicable to the diff;
- C4.2 binding and policy non-regression;
- C6.1 occurrence/projector parity suites unchanged;
- `git diff --check`;
- exact `git diff --name-status github/main...HEAD`; and
- a three-dot intent receipt containing only this approved backend ledger and
  no activation.

The build may commit, push, and open its review surface only under the
coordinator's later instruction. This lane never merges and never deploys.

## 15. Explicit non-goals

C5.1 provides:

- no client change or C4.1 implementation;
- no new offline-eligible action;
- no registry catalogue, signed-policy, compatibility, method, URL, handler,
  or schema change;
- no executable binding for vitals, I/O, authoritative notes, prescription,
  CPOE, MAR, specimen, transfusion, or any physical/final action;
- no C5.2 paper back-entry, incident ledger, reconciliation workbench, or
  handoff-authoring UI;
- no projector or C6.1 late-effect implementation;
- no facility activation or capture-purpose grant issuance;
- no owner retention value, replay window, clinical threshold, SLA rule,
  notification timing, or late-arrival exception;
- no production policy/key/receipt generation;
- no deployment;
- no merge.

## 16. Coordinator decisions required before Step 2

Please approve or correct:

1. the one existing binding registry extended with an exact transactional
   handler, with no parallel replay map;
2. the two-fingerprint model: exact C4.1 client fingerprint verification plus
   a server receipt fingerprint that adds the server-owned binding/method;
3. exact duplicate identity requiring tenant, client event, original
   idempotency key, and server receipt fingerprint;
4. same-actor-only automatic replay until a server-verifiable, C0A-compatible
   handoff artifact or record is separately cleared;
5. the compact immutable receipt plus separately compactable direct effect
   evidence and append-only attempt ledger;
6. C3.1-restrictive RLS, no runtime `bypass`, per-tenant workers, and
   least-privilege functions;
7. Phase 0 authorization, auxiliary generic-idempotency claim, one Phase-1
   effect transaction, Phase 1.5 response/cache work, and no Phase 2;
8. note-draft revision CAS with base revision 0 for insert-only capture;
9. draft storage's required private replay audit and forbidden
   canonical/SLA/outbox/pathway effects;
10. the reusable suite running twice through the real route and handler;
11. the exact Step 2 file ledger and C6.1 no-edit boundary; and
12. the default-fail-closed retention posture until C-D10 supplies receipt,
    attempt, replay-eligibility, reconciliation, and tombstone horizons.

Two integration contracts require explicit coordinator ownership rather than
invention in this backend lane:

- C4.1 contains every semantic field used above, but its cleared HTTP
  projection currently names only the C4.2 authority headers and standard
  `Idempotency-Key`. The coordinator must assign and approve the closed
  transport mapping for the remaining C5.1 fields; C5.1 will consume that
  normalized contract without editing a client.
- C4.1/C0A do not currently carry a server-verifiable different-actor handoff
  artifact. Until one is cleared, different-actor replay remains typed
  `needs_review` and cannot reveal or apply a receipt.

Until these decisions and the queued prerequisite builds are cleared, this
branch remains design-only.

## 17. Coordinator clearance record

The coordinator approved this delta as written on 2026-07-31 and adopted the
section 2 stop conditions verbatim as the build gate. This clearance changes
the design status only. It does not authorize Step 2, reserve a migration,
activate capture, merge, or deploy.

The coordinator ratified these fail-closed postures:

1. no receipt/effect-evidence compaction or tombstone/attempt deletion until
   the C-D10 receipt and tombstone horizons are countersigned; engineering
   supplies no interim value;
2. different-actor replay remains refused until a server-verifiable handoff
   contract exists; local C0A attestation is not promoted into server
   authority; and
3. the build remains blocked until the landed C4.1 envelope matches the
   cleared delta field-for-field and the closed C5.1 wire mapping is approved.

Live prerequisite receipt when this clearance was recorded:

- `github/main` is
  `e5aa113cb4895deb763800e6309ea64fd492cb3b`, merge of C6.1-A PR
  [#664](https://github.com/Bahuleyandr/VH-Health-Platform/pull/664);
- C6.1-A landed `603_external_interface_recovery.sql`;
- `github/feat/continuity-facility-context` remains at its design/clearance
  commit `f77d0ed208841054b2bb0376e29d12bcfdabe1fc`; and
- `github/feat/continuity-c4-1-queue-envelope` remains at its cleared design
  commit `aa25b1a62d65b353c5dc397a00ddbefdeb8c0896`.

The next permissible action is another live gate check after the
facility-context build and the landed C4.1 envelope exist. Until then, this
lane holds with no backend, migration, Prisma, test, or activation work.
