# C5.2 owner-directed held-message release executor — design delta

**Status:** design only; build queue held behind C6.1-G

**Step-1 branch:** `feat/continuity-held-release-executor`

**Live authority re-fetched:** `github/main` at
`3273e30f3ea527270dc22af99317acf1706f0fef` on 2026-08-04

**Activation state:** inert; no release, dispatch, deployment, or production
authority is granted by this delta

## 0. Step-0 coordinator preflight

### 0.1 Verdict

| Check | Live result | Step-1 ruling |
|---|---|---|
| Base | `github/main` re-fetched at `3273e30f3ea527270dc22af99317acf1706f0fef` | Design authority only |
| Committed migration ceiling | `619_nhcx_message_recovery.sql` | DDL is required, but no number is reserved |
| C6.1-G migration owner | The active local `feat/continuity-c6-1g-i18-webhooks` lane is based on the same main SHA and has an uncommitted `620_subscriber_webhook_recovery.sql` | Build must wait for G and derive a fresh number from re-fetched main at build kickoff |
| GitHub PR overlap | `gh pr list --state open` returned zero open pull requests | No open-PR collision exists today; G is still a live local ownership collision |
| Step-1 file overlap | This branch adds only this document | No collision with G for the delta commit |
| Build overlap | G currently owns Prisma, comprehensive seed, the external-interface catalog, generic recovery service, event-outbox/webhook routes and services, and recovery tests | Re-fetch and re-inventory after G; shared-file editing before then is forbidden |
| Live interim procedure | `docs/continuity/c6-1-i05-held-message-operator-procedure.md` is hold-only and explicitly forbids replay batches, `dispatch-now`, migration reruns, direct SQL, and status-only release | There is no currently authorized release path; the built executor replaces the wait-only rule, not an authorized SQL mechanism |
| Build readiness | C5.1, C5.2, I04, I05, and I19 authority is present; G/I18 is not landed | **WAIT — queue build only after C6.1-G coordinator clearance** |

The build DDL verdict is **required but not yet allocatable**. The later build
must alter the C5.1 receipt/effect-evidence shape, extend the C5.2 interface
item model, add receipt-aware source-table guards, and regenerate Prisma. At
build kickoff it must re-fetch `github/main`, prove G is landed, list the live
migration ceiling, and derive the next free migration number. This document
does not call that number 621, reserve it, or authorize a migration file.

The currently observed G worktree changes are:

- `apps/backend/prisma/schema.prisma`;
- `apps/backend/scripts/seed-comprehensive-test-data.mjs`;
- `apps/backend/src/config/externalInterfaceRecoveryCatalog.js`;
- `apps/backend/src/migrations/620_subscriber_webhook_recovery.sql`;
- `apps/backend/src/routes/admin/integrationRoutes.js`;
- `apps/backend/src/services/events/eventOutboxService.js`;
- `apps/backend/src/services/integrations/externalInterfaceRecoveryService.js`;
- `apps/backend/src/services/integrations/externalWebhookRecoveryService.js`;
- `apps/backend/src/services/integrations/webhookDeliveryService.js`;
- `apps/backend/src/services/integrations/webhookSubscriptionService.js`; and
- `apps/backend/src/tests/deep/subscriberWebhookRecoveryMigration.deep.test.js`;
- `apps/backend/src/tests/event-outbox-recovery-migration.deep.test.js`;
- `apps/backend/src/tests/reliability-metrics.deep.test.js`;
- `apps/backend/src/tests/unit/externalInterfaceRecoveryCatalog.test.js`;
- `apps/backend/src/tests/unit/externalWebhookRecoveryService.test.js`;
- `apps/backend/src/tests/unit/webhookDeliveryService.test.js`; and
- `apps/backend/src/tests/webhook-delivery-recovery.deep.test.js`.

The held-release build is expected to overlap at least Prisma, comprehensive
seed, the external-interface catalog, and the generic recovery service. That
overlap is a sequencing dependency, not permission to edit G's worktree.

### 0.2 Step-1 frozen ledger

This design step changes exactly:

1. `docs/continuity/c5-2-held-message-release-executor-design-delta.md`.

There is no migration, Prisma regeneration, backend route, generated OpenAPI,
Admin/Staff code, test, manifest, activation, deployment, or merge in Step 1.

## 1. Outcome and binding authority

The release executor is one additional **C5.2 reconciliation command** on the
existing Staff/Admin workbench. Its one command effect is authorized and
deduplicated by the **C5.1 receipt substrate**. It is not an interface-engine
redrive command, a recovery-inbox replay command, a scheduler, a status editor,
or a second release ledger.

Authority order for this slice is:

1. the countersigned C-D6 incident and fallback-owner law;
2. the countersigned C-D8 late-data law;
3. C5.1 migration 605 and its receipt, attempt, and effect-evidence model;
4. C5.2 migration 606 and its one workbench, typed `interface` queue, task,
   audit, role, facility-context, and incident model;
5. I04 migrations 603/610 and the independent transport, parsed MSA
   acknowledgement, send-authority, and cursor state planes;
6. I05 migrations 603/611-615 and the five closed protocol adapters;
7. I19 migration 619 and its immutable `recovery_pending` evidence;
8. the current
   `docs/continuity/c6-1-i05-held-message-operator-procedure.md`; and
9. C6.1-G only after its code and migration have landed on main.

Where an older helper or procedure conflicts with this order, it is narrowed or
retired. In particular, `authorizeOwnerRetryTx` currently resets I04 transport
and acknowledgement state and can reopen a cursor while authorizing a retry.
That combined behavior cannot be the release executor. The build must make the
C5.2 command the sole release caller and remove the `authorize_send` mutation
from the C6.1 recovery-adapter command map. Owner-supplied MSA reconciliation
remains separate.

## 2. One mechanism ruling

The server-fixed command ID is:

`clinical_continuity.interface_held_message.release`

Its binding is:

`clinical_continuity.interface_held_message.release/v1`

This ID belongs only to C5.2's closed server command map. It is not added to the
C4.2 electronic offline-action registry and is never accepted by a generic
`/replay`, redrive, dispatch-now, or arbitrary-action endpoint.

Version 1 is deliberately **per-message only**. There is no batch release
endpoint. A later explicitly enumerated batch would need a new delta defining
whole-list fingerprinting, lock order, all-or-nothing behavior, and response
replay. A predicate such as family, status, age, channel, subscription, or
tenant can never be release authority.

The C5.2 item and task are the work queue. The C5.1 receipt is the sole command
effect authority. The source message remains the delivery state. Append-only
C5.1 effect evidence records what changed. None of those roles is duplicated.

## 3. C5.2 interface-item binding

### 3.1 Why an explicit binding is required

I04, I05, and I19 recovery inboxes are tenant-scoped, while the C5.2 workbench
is facility- and incident-scoped. The executor must not silently guess which
facility or incident owns a tenant-wide held message. It also must not make a
GET request create queue state.

An authorized incident/interface operator therefore binds one exact held
message to one existing `clinical_continuity_incident_interfaces` requirement.
The bind command creates or returns one C5.2
`clinical_continuity_reconciliation_items` row with:

- `queue_type = 'interface'`;
- `interface_item_kind = 'held_message_release'`;
- the exact incident-interface requirement;
- the server-resolved `interface_owner_principal`;
- one existing task through the canonical task service;
- no invented SLA when no approved interface SLA exists;
- exactly one typed I04, I05, or I19 source foreign key;
- the immutable recovery-inbox, partition, source-position/token, duplicate,
  payload, protocol/cycle, and current authority-state fingerprint;
- the server-derived hold safety class; and
- an open disposition until released, excluded, or superseded.

The binding request identifies one message. It does not accept a SQL predicate,
query filter, tenant, facility, owner, assignee, safety class, next authority
state, receipt result, or release outcome from the client. Tenant, facility,
incident, source state, owner, task, and classification are resolved and
checked server-side.

### 3.2 Source and incident coherence

The bind transaction requires all of the following:

1. an explicit signed C5.2 facility context and active incident;
2. a same-tenant, same-family incident-interface requirement whose offset and
   source partition match the message's canonical recovery inbox;
3. the exact held source state described in section 7;
4. immutable retained payload/hash and recovery provenance;
5. no existing C5.2 held-message item or applied release receipt for the source;
6. an implemented family/adapter row in the server catalog; and
7. no I18, inbound NHCX, payment-notice, acknowledged I04, delivered I05, or
   otherwise terminal/non-releaseable source.

An exact duplicate binding returns the existing item and task. A changed
incident, requirement, family, source identity, state fingerprint, or safety
classification fails closed and appends an attempt/audit record; it never
repoints the existing item.

## 4. Command identity, fingerprint, and receipt

### 4.1 One effect identity

The server derives one stable effect identity from:

- tenant and C5.2 facility;
- incident and incident-interface requirement;
- C5.2 reconciliation item;
- interface family;
- the family-specific immutable message key;
- the server-fixed action/binding/schema versions; and
- the original source recovery-inbox identity.

The raw client `Idempotency-Key` is auxiliary request identity. It cannot create
a second effect identity for the same held message. The database has one partial
unique source tuple for `source_kind = 'held_message_release'` so a second
receipt cannot authorize the same message.

### 4.2 Canonical command fingerprint

The RFC-8785-compatible canonical SHA-256 fingerprint binds:

- the effect identity above;
- original releaser UID and current normalized role;
- typed `release_reason_code` and normalized required reason detail;
- exact item and incident-interface expected versions;
- exact source identity and immutable payload/ciphertext hash;
- exact prior authority-state object and its SHA-256;
- the only permitted next authority-state object and its SHA-256;
- protocol and adapter version for I05;
- endpoint, cycle, environment, and HCX API-call identity for I19;
- the server-derived `routine_operational` or `safety_critical` class; and
- for safety-critical work, the exact distinct-person release-attestation
  decision ID and its command fingerprint.

Request ID, response timing, database transaction ID, retrying caller, task
comment text, and later dispatcher/ACK/cursor state are excluded. The original
releaser remains in the fingerprint; a different user attempting to reuse the
same message effect identity is drift, not an exact duplicate.

### 4.3 Typed release reasons

Version 1 accepts exactly these reason codes:

- `downstream_readiness_confirmed`;
- `transport_configuration_corrected`;
- `duplicate_delivery_risk_reviewed`;
- `acknowledgement_uncertainty_reviewed`; and
- `owner_recovery_evidence_reconciled`.

Every code requires normalized, non-control-character detail of 10-500
characters. There is no `other`, free-form-only, or client-defined code. I04
accepts acknowledgement uncertainty, duplicate-risk review, and downstream
readiness. I05 accepts downstream readiness, transport/configuration repair,
duplicate-risk review, and owner evidence reconciliation. I19 accepts the I05
set but never acknowledgement uncertainty. A code outside the family allowlist
is fingerprint drift and fails before receipt claim.

### 4.4 Duplicate and drift behavior

Current authorization is re-evaluated before any receipt outcome is disclosed.
Then:

- the same source tuple and same fingerprint returns the immutable prior
  terminal outcome, receipt ID, effect-evidence ID, audit ID, and prior/next
  authority snapshots without another write or network send;
- the same source tuple with a different actor, reason, source state,
  attestation, item version, or next state records a C5.1 mismatch attempt and
  fails closed;
- a lost response can be recovered by the original currently authorized
  releaser without re-running the effect;
- an expired, revoked, denied, wrong-tenant, wrong-facility, or invalid attempt
  cannot reserve the source tuple; and
- receipt retention/compaction preserves the source tuple and fingerprint long
  enough that the message can never become a new command after detail expiry.

## 5. One atomic effect transaction

For an authorized, exact release, one serializable tenant/facility transaction
uses the lock order below:

1. incident and incident-interface requirement;
2. C5.2 reconciliation item and its open task;
3. safety attestation, when required;
4. C5.1 receipt identity;
5. the family-specific source message; and
6. the family-specific delivery ordering row needed only for validation, never
   for mutation by this command.

After locking, the transaction:

1. re-resolves the current principal, role, assignment, tenant, facility,
   incident, family adapter, and policy;
2. recomputes the source and command fingerprints;
3. claims `clinical_continuity_replay_receipts` with
   `source_kind = 'held_message_release'`;
4. revalidates the exact prior state and absence of an active delivery claim;
5. inserts the held-release shape into C5.1
   `clinical_continuity_replay_effect_evidence`;
6. appends one structured clinical/continuity audit event;
7. compare-and-swaps only the family-specific delivery-authority fields listed
   in section 7;
8. transitions the existing reconciliation task/item to resolved with immutable
   decision history; and
9. finalizes the C5.1 receipt as
   `held_message_send_authority_rearmed`.

All nine operations commit or roll back together. No post-commit network call,
dispatcher invocation, cursor write, parsed ACK write, payment action, domain
adapter, notification, SLA action, pathway transition, or canonical clinical
timeline event belongs in this transaction.

The generic C5.1 finalizer alone is not sufficient authority. The migration must
add one receipt-aware database release function/guard that accepts only a
same-transaction claimed held-release receipt, its exact effect evidence, and
the current source state. Direct source-table DML cannot emulate that proof.

## 6. Receipt and evidence DDL shape

The build must extend, not replace, C5.1 and C5.2.

### 6.1 `clinical_continuity_replay_receipts`

The additive held-release shape includes:

- `source_kind = 'held_message_release'`;
- nullable patient identity for this non-patient-specific command, with the
  existing electronic and paper source shapes kept strict and unchanged;
- non-null C5.2 incident and reconciliation-item references;
- `subject_kind = 'interface_held_message'` and a canonical subject key;
- `interface_family IN ('I04', 'I05', 'I19')`;
- the C5.2 held-release action/binding/schema identity;
- the signed facility-context device/session and current C5.2 policy pins; and
- a unique held-message source tuple independent of a client key.

Dropping patient-column `NOT NULL` constraints is allowed only together with a
replacement three-source XOR check proving electronic and paper receipts retain
their current patient requirements while held-release receipts use the typed
resource subject. No unrelated receipt source becomes nullable.

### 6.2 `clinical_continuity_reconciliation_items`

The existing table receives typed columns and exact foreign keys for:

- `incident_interface_id`;
- `interface_item_kind`;
- `interface_family`;
- one of `hl7_outbound_message_id`, `interop_message_id`, or
  `nhcx_message_id`;
- immutable `hold_reason_code` and
  `hold_safety_class IN ('routine_operational', 'safety_critical',
  'unclassified')`;
- immutable source-state snapshot/hash; and
- terminal receipt/effect references after release.

Exactly one family-specific message key must be present for a held-message
item. `unclassified` items remain visible but cannot be attested or released.
One source message can have only one held-message item across all incidents.

### 6.3 `clinical_continuity_reconciliation_decisions`

The existing append-only decision model gains a `release_attestation` decision
shape with:

- the exact held-release command fingerprint;
- source-state fingerprint;
- typed reason and safety class;
- attesting actor/role and server time; and
- the item version produced by the attestation.

This is not a new approval engine. It is one new typed C5.2 decision on the
existing item. The eventual C5.1 effect evidence references it. A decision is
never updated to “consumed”; the unique effect reference proves whether it was
used.

### 6.4 `clinical_continuity_replay_effect_evidence`

The append-only C5.1 evidence table gains the
`held_message_send_authority_rearmed` shape with:

- C5.2 reconciliation item and optional safety-attestation decision;
- family and exact family-specific source foreign key;
- original releaser UID/role;
- typed reason code and required bounded detail;
- exact prior and next authority-state canonical objects plus their hashes;
- source-state and command fingerprints;
- release server time;
- the same-transaction audit event ID; and
- `network_send_performed = false`.

For this outcome, timeline, SLA, notification outbox, retrospective event
outbox, and ordinary event-outbox references must all be null. This evidence is
the C5.1 effect record; no `held_message_release_receipts` or parallel command
table may be created.

### 6.5 Family source rows

Each of the three releaseable source tables receives one nullable
`owner_release_client_event_id`-style composite foreign key to the C5.1 effect
evidence. The exact name follows the surrounding table idiom at build time. It
is null while held, becomes non-null in the same compare-and-swap as the
authority transition, and is immutable thereafter. The source trigger requires
that referenced effect to match tenant, family, message key, prior/next state,
and current transaction.

This back-reference is evidence and a guard input, not a second receipt. It
also lets dispatch selectors prove release without trusting owner strings or a
status alone.

## 7. Closed per-family semantics

| Family | Releaseable prior state | Atomic next state | State explicitly unchanged | Additional refusal rules |
|---|---|---|---|---|
| I04 outbound HL7 | Exact recovery-bound `ledger_version = 1` message; `status = 'reconciliation_required'`; `send_authority = 'held_owner_reconciliation'`; no active claim; no correlated MSA `AA` | `status = 'queued'`; `send_authority = 'authorized'`; `next_attempt_at = release time`; owner release UID/reason/time and C5.1 effect reference set | Transport attempts/results, parsed MSA state, payload/control ID, acknowledgement rows, delivery cursor, blocked/inflight cursor IDs, prior error evidence, attempt count, and `sent_at` | Release does not make the cursor ready, skip earlier unacknowledged rows, or mark sent. Existing ACK-led ordering can still prevent a dispatcher claim. Legacy `ledger_version = 0` rows remain held/not-yet because they lack the v1 correlation contract |
| I05 interface engine | Outbound or bidirectional-outbound recovery row; implemented `hl7v2`, `csv`, `json`, `fhir_json`, or `other` adapter; `recovery_ledger_version = 1`; `status = 'quarantined'`; `arrival_class = 'recovery_backlog'`; `effect_disposition = 'late_pending_only'`; `send_authority = 'held'`; owner reconciliation required; no delivery claim | `status = 'queued'`; `send_authority = 'owner_authorized'`; `owner_reconciliation_required = false`; C5.1 effect reference set | Ciphertext, payload hash/bytes, protocol/adapter/version, source position/tokens, duplicate key, recovery inbox, late disposition, earlier attempts/receipts, and last-error evidence | Inbound messages, missing/unregistered adapters, byte-parity drift, active claims, delivered/replayed rows, or a changed channel version are refused |
| I19 NHCX outbound | Outbound non-payment recovery row; `status = 'recovery_pending'`; immutable recovery evidence; `recovery_disposition = 'manual_redrive_requested'`; retained ciphertext/hash; no concurrent claim | `status = 'pending'`; `next_retry_at = release time`; C5.1 effect reference set | Attempt count, payload ciphertext/hash, HCX API/correlation/workflow identity, endpoint/cycle/environment, recovery owner/evidence/prior status, finance/authorization state, and payment-review state | `payment_notice`, inbound callbacks, `investigate`, `cancel_requested`, missing ciphertext, profile drift, or unconfigured/disabled runtime is refused; payment notices remain manual only |
| I18 subscriber webhooks | **NOT YET** | No state exists in this command schema | All G state | No binding, enum, endpoint behavior, receipt, adapter, or dispatcher branch is allowed until G lands and the subscription's owner-approved `downstream_effect_classification` is neither absent nor `unclassified`; a later delta must define how each classification maps to release safety and late effects |

### 7.1 I04 three-state law

Release changes message-level send authority and the queue eligibility status
needed to represent that authority. It does not rewrite transport evidence,
parsed MSA acknowledgement, or the subscription cursor. The existing dispatcher
must still require its current cursor-ready and prior-message ACK predicates.
Therefore “released” means eligible at the message-authority plane, not “will
send immediately” and never “sent”.

The current `authorizeOwnerRetryTx` reset of `transport_state`,
`acknowledgement_state`, and cursor state is removed from the release path.
`recordOwnerAcknowledgementTx` remains a separate owner-evidence operation and
cannot grant send authority.

Migration-610 legacy rows with `ledger_version = 0` remain visible for owner
reconciliation but cannot be released by v1. The executor must not promote
their ledger version, fabricate a control ID, or infer correlation evidence.
Making them sendable requires its own evidence-upgrade delta.

### 7.2 I05 dispatcher exception

The live I05 selector remains unchanged for
`arrival_class = 'live'`, `effect_disposition = 'live'`, and
`send_authority = 'live_authorized'`.

One additional disjoint selector branch may claim recovery work only when all
of these are true:

- the row has the I05 recovery state and `owner_authorized` authority above;
- an applied C5.1 held-release receipt/effect exists for that exact row and
  current source-state fingerprint;
- the item/task/incident decision remains valid;
- the adapter is one of the five implemented protocol adapters; and
- there is no existing delivery claim.

The migration replaces the blanket 611 rejection with this receipt-proven
positive exception and retains the rejection for every other late row. That is
not a weakened guard: the new allowed set is “same row plus applied receipt”,
not a status or owner-string check.

### 7.3 I19 dispatch exception

The release command does not call `redriveNHCXMessage`, because that helper
rebuilds payload material and resets attempt state. It performs only the closed
`recovery_pending` to `pending` eligibility transition above. The dispatcher
may claim that row later through its ordinary network path, but a
recovery-provenance row is selectable only when its applied C5.1 release effect
exists. Live NHCX rows retain their existing selector.

## 8. Who may bind, attest, and release

Every route first applies the existing C5.2 authentication, explicit
tenant/facility context, route-role envelope, and resource-level authorization.
Frontend visibility is never authority.

### 8.1 Bind and list

- C5.2 aggregate Admin roles may list facility incident/interface work under
  the existing workbench rules. The current set is `SUPER_ADMIN`, `ADMIN`,
  `CMO`, `MEDICAL_SUPERINTENDENT`, and `QUALITY_OFFICER`; those are incident and
  governance roles, not release authority.
- An incident administrator may bind one exact source message to the existing
  incident-interface requirement but cannot release merely because the actor is
  `ADMIN`, `SUPER_ADMIN`, `CMO`, `MEDICAL_SUPERINTENDENT`, or
  `QUALITY_OFFICER`.
- Staff sees only items permitted by the existing assigned/original-actor
  workbench projection.
- The server resolves `interface_owner_principal`, task owner, and named
  assignee. Client-supplied owner or role fields are ignored/denied.

C5.2 section 4 makes Admin the incident/HIM/interface surface and Staff the
assigned clinical/ward surface; this delta preserves that presentation split.
For act authorization, version 1 accepts only a configured
`interface_owner_principal` of `role:<normalized platform role>`, or the exact
C-D6 `fallback_principal = 'role:clinical_safety_lead'`. For an ordinary role
principal, the actor's fresh authenticated role must exactly match it. For the
fallback principal, the actor UID must instead equal the currently configured
`clinical_safety_lead_uid`. In both cases, the item must have a fresh named
assignee with the same actor UID. The existing examples use `role:it_admin`;
the build must not turn `IT_ADMIN` into a global aggregate-view role. It adds
resource-scoped list/act admission for the matching configured interface
principal and otherwise retains the closed workbench role envelope. An absent,
malformed, stale, or role-mismatched owner configuration leaves the item visible
to incident governance but not releaseable. A routine fallback-owned item may
use its named clinical safety lead; a safety-critical fallback-owned item stays
blocked because that person cannot also provide the distinct attestation, until
a distinct configured interface owner and named assignee are established.

### 8.2 Routine release

A routine item requires one currently active, currently authorized releaser
who satisfies the configured C5.2 `interface_owner_principal` and the named
assignment/resource check. The server reloads the user and role inside the
effect transaction. An append-only receipt, effect record, item decision, task
transition, and audit record are mandatory.

Single-key routine release is justified because it restores an operational
delivery permission; it is not itself a clinical fact, ACK, payment decision,
pathway transition, or incident closure. Requiring an unrelated clinical
signature for every repaired transport hold would create a second operational
bottleneck without adding evidence to a nonclinical command.

### 8.3 Safety-critical release

Safety-critical work uses C-D6's split-authority template:

1. the item's current named assignee, who must also satisfy the configured
   interface-owner principal, is pinned as the intended releaser;
2. the tenant-configured `clinical_safety_lead_uid` attests the exact planned
   release fingerprint through the existing C5.2 decision model; and
3. that same named interface owner performs release after the attestation, with the two
   actors required to be distinct.

The clinical safety lead cannot self-release by virtue of attesting, and an
interface owner cannot self-attest. A reason, source-state, item-version,
adapter, or next-state change invalidates the attestation.

Version 1 classifies the currently known holds fail-closed:

- I04 acknowledgement/legacy-delivery uncertainty is safety-critical;
- I05 recovery-backlog delivery is safety-critical because protocol alone
  cannot prove the downstream system is nonclinical; and
- I19 non-payment outbound recovery is routine operational/financial work.

An unrecognized hold is `unclassified` and cannot release. A later owner-signed
channel classification may narrow a specific I05 target to routine, but this
delta does not infer that from message text, protocol, destination name, AI, or
operator choice.

## 9. Workbench routes and OpenAPI

All endpoints stay under the existing C5.2 router and use the same generated
contracts for Admin and Staff.

### 9.1 Exact endpoint set

| Purpose | Method and path | Contract |
|---|---|---|
| List | `GET /api/v1/downtime/reconciliation/workbench?incident_id={uuid}&queue_type=interface&interface_item_kind=held_message_release` | Extends the existing response with typed held-message item, source-safe evidence, current capability booleans, prior receipt outcome, and no raw ciphertext/payload |
| Bind one message | `POST /api/v1/downtime/reconciliation/incidents/{incidentId}/interface-held-messages` | Body identifies one `incident_interface_id`, family, message ID, expected incident-interface version, and expected source-state fingerprint; returns the existing/new C5.2 item and task; performs no release |
| Safety attestation | `POST /api/v1/downtime/reconciliation/reconciliation-items/{itemId}/held-message-release/attestations` | Body contains item expected version, typed release reason/detail, and expected source-state fingerprint; returns the append-only decision and command fingerprint; performs no release |
| Release one message | `POST /api/v1/downtime/reconciliation/reconciliation-items/{itemId}/held-message-release` | Body contains item expected version, typed reason/detail, expected source-state fingerprint, and safety attestation ID when required; claims/finalizes C5.1 and returns applied or exact-duplicate outcome |

There is no direct family/message release URL. The release act endpoint resolves
the exact source only through the C5.2 item, preventing a caller from swapping a
message ID after review.

### 9.2 Operation-overlay descriptions

The existing
`apps/backend/scripts/openapi/schemas/clinicalContinuityReconciliation.mjs`
module receives request/response schemas and descriptions equivalent to:

- **Workbench list:** “Returns the facility-scoped C5.2 workbench, including
  typed interface held-message items. Visibility does not grant release
  authority, payload/ciphertext is not returned, and I18 remains excluded.”
- **Bind:** “Binds one exact held I04, I05, or non-payment outbound I19 message
  to an existing incident-interface requirement and creates or returns its C5.2
  interface item/task. It performs no release, dispatch, ACK, cursor, payment,
  pathway, SLA, or notification effect.”
- **Attest:** “The configured clinical safety lead co-attests one exact
  safety-critical held-release fingerprint. It performs no authority flip or
  dispatch, and the attester must differ from the interface releaser.”
- **Release:** “The current configured interface owner releases one exact
  bound held message by claiming/finalizing the C5.1 receipt and atomically
  recording exact prior/next authority. Exact duplicates return the prior
  outcome; drift fails closed; no network send, ACK, cursor, payment, pathway,
  SLA, or notification effect occurs in the command.”

This follows the C6.1-F operation-description overlay precedent. There are
**zero OpenAPI module/manifest additions**: no new file under
`scripts/openapi/schemas`, no new import or domain entry in
`generate-openapi.mjs`, and no new tag. The existing C5.2 schema module is
extended, then the backend spec and shared-core mirror are regenerated and
proved byte-identical.

## 10. Admin and Staff wiring

No new navigation area, dashboard, queue engine, or interface-engine workbench
is created.

- **Admin:** the existing Continuity Reconciliation page adds an `Interface`
  filter/card group, exact-source binding form, safe evidence detail, routine
  release action, safety-attestation state, and receipt outcome. It uses the
  existing Admin C5.2 API module and proxy allowlist family.
- **Staff:** the existing Paper Reconciliation Workbench screen renders
  assigned `interface` items, safe evidence, safety-attestation action for the
  configured clinical safety lead, and release only when server capabilities
  permit it. It uses the existing shared-core reconciliation client.
- **Both:** labels, reason enums, capabilities, exact-duplicate outcomes, stale
  state, safety state, and typed errors come from the same OpenAPI/core contract.
  Neither client decides owner role, safety class, family eligibility, prior or
  next authority, or whether two-key applies.

The response exposes explicit booleans such as `can_bind`, `can_attest_release`,
and `can_release` only as server-computed presentation aids. The command repeats
all authorization and state checks; a stale `true` is not authority.

## 11. C-D8 late-effect fence

Release is explicit permission to let an already-retained outbound message
enter its normal delivery claimant. It is not permission to reinterpret the
message as newly occurred clinical data.

The immutable recovery `occurred_at`, arrival class, and
`effect_disposition = 'late_pending_only'` survive release. The release command
and every later dispatcher/adapter branch must prove:

- no retrospective SLA creation, breach, restart, or completion;
- no care-pathway start, transition, task materialization, or timer reset;
- no patient/staff notification or notification-outbox rearm;
- no canonical clinical timeline event for the release itself;
- no domain backfill or “current time” substitution for the original event;
- no cursor advance except I04's separately parsed/correlated MSA `AA` law;
- no ACK success inferred from transport success; and
- no NHCX payment approval, settlement, or notice processing.

If an external receiver later produces an ordinary response, only the family's
existing acknowledgement/receipt contract may record it. Release never
pre-authorizes downstream clinical or financial effects.

## 12. Section 6.8 integrity, RLS, grants, and retention

Every new column, index, function, constraint, and evidence shape follows the
full §6.8 contract:

- exact tenant/facility/item/incident-interface/source foreign keys, with
  intentional `ON DELETE RESTRICT`/`NO ACTION`;
- strict family XOR, source-kind XOR, state enum, timestamp, actor separation,
  receipt outcome, and authority-transition checks;
- immutable source binding, source-state fingerprint, decision, receipt
  identity, and effect evidence;
- C3.1-restrictive explicit tenant/facility RLS for C5.2 rows and restrictive
  explicit tenant RLS for tenant-scoped source evidence;
- absent, empty, malformed, `bypass`, wrong-tenant, or wrong-facility context
  matches no release row;
- no default/public table or function grants;
- runtime roles have no direct insert/update/delete/truncate grant on receipts,
  release effect evidence, release decisions, or held-message authority fields;
- one narrowly validated SECURITY DEFINER command function, fixed search path,
  explicit same-transaction receipt claim, and no caller-controlled SQL;
- append-only attempt/audit evidence for duplicate, mismatch, denial, stale,
  and infrastructure failure outcomes;
- no JSON object is the sole authorization fact: typed family/source/actor/
  reason/prior/next columns and hashes carry the authority, while canonical
  objects retain exact evidence;
- full C5.1 365-day detailed receipt/effect retention and 2555-day source-tuple
  tombstone minimum; and
- concurrency-safe compaction that cannot make a released source eligible for
  a new receipt.

The source-table 603/610/611/619 guards remain fail-closed. Where a blanket
guard must admit release, it does so only after proving the exact applied C5.1
effect in the same transaction. Owner UID/reason strings, a C5.2 decision by
itself, a queued/pending status, or an application-role session can never
satisfy the guard.

## 13. Mandatory tests and full-suite bar

### 13.1 Receipt and transaction tests

- exact duplicate returns the prior applied outcome without source, task,
  audit, attempt, or network duplication;
- same source with actor, reason, item version, state, payload hash, adapter,
  attestation, or next-state drift fails closed;
- receipt, effect evidence, source flip, task/item decision, and audit each roll
  back when any later step fails;
- two concurrent exact releases converge on one applied outcome;
- exact/mismatch lookup rechecks current authorization before disclosure;
- configured interface-principal matching admits only the fresh named assignee;
  a broad Admin role, a matching role without assignment, assignment without
  the configured role, or hard-coded `IT_ADMIN` aggregate access is denied;
- patient-null held receipts do not weaken electronic or paper receipt shapes;
- full retention/tombstone identity includes the family/source tuple; and
- generic C5.1 replay/paper claim/finalize functions cannot claim or finalize a
  held-release effect outside the dedicated contract.

### 13.2 Raw PostgreSQL negatives

The deep suite uses disposable PostgreSQL, creates/sets the privileged runtime
roles used by production, and proves at minimum:

- `vhhealth_app`/`vhhealth_runtime` cannot directly flip I04
  `held_owner_reconciliation` to `authorized`/`queued` with fabricated owner
  fields;
- they cannot directly flip I05 `held`/`quarantined` to
  `owner_authorized`/`queued` or clear `owner_reconciliation_required`;
- they cannot directly flip I19 `recovery_pending` to `pending`;
- a forged C5.1 receipt, effect row, audit link, C5.2 item/decision, or generic
  receipt finalization cannot satisfy the source guard;
- calling the dedicated database command without its same-transaction claimed
  receipt, exact source state, current item/task, and required distinct
  attestation fails;
- absent, empty, bypass, malformed, cross-tenant, cross-facility, wrong-family,
  wrong-message, wrong-incident-interface, or stale context fails;
- source/key/payload/protocol/recovery evidence and applied release evidence
  remain append-only and undeletable;
- an active claim, positive I04 ACK, delivered/replayed I05 row, inbound NHCX,
  NHCX payment notice, non-redrive NHCX disposition, and every I18 row fail; and
- direct SQL remains denied after an applied release; there is no second flip or
  state rewind.

### 13.3 Family and late-effect tests

- I04 changes only queue/send-authority/release evidence and leaves transport,
  MSA ACK, cursor, earlier-message ordering, attempts, and `sent_at` unchanged;
- the released I04 row is not claimable until the independent cursor/ACK
  predicates are satisfied;
- each I05 protocol (`hl7v2`, `csv`, `json`, `fhir_json`, `other`) proves exact
  adapter and byte parity, owner-authorized claim, and no broad late selector;
- every non-released late I05 row remains undispatchable;
- I19 keeps exact ciphertext/hash/attempt and finance state, excludes payment
  notices, and is only later claimed by the normal dispatcher;
- I18 is absent from request enums, source binding, service dispatch, UI action,
  and generated OpenAPI;
- release and later dispatch never create/rearm retrospective SLA, pathway,
  timeline, or notification effects; and
- failover/lost-response/retry tests preserve one outcome and one send-authority
  grant.

### 13.4 Build-wide gates

Focused tests are not completion. The build receipt must include:

1. a fresh zero-database migration through the then-current slot, migration
   rerun, runner smoke, schema validation, Prisma regeneration, and zero schema
   drift;
2. comprehensive seed and declared-empty-table policy with zero unexpected
   empties/failures;
3. C5.1, C5.2, I04, all I05 adapters, I19, external-interface catalog, task/SLA,
   audit, raw-PG, RLS/grant, and migration deep suites;
4. generated OpenAPI live-route parity, backend/core byte parity, stock Spectral
   zero errors, baseline zero additions, and real operation descriptions;
5. full backend lint/security/static gates and the complete backend Jest
   inventory on fresh PostgreSQL, not only focused suites;
6. full Admin lint, type-check, Jest, and production build;
7. shared-core format/analyze/tests plus Staff format/analyze/tests, focused
   workbench widgets, and all localization guards; and
8. patch/ledger hygiene proving no I18 release, scheduler, deployment,
   manifest, secret, credential, provider activation, or production overlay.

## 14. Expected Step-2 responsibility ledger

This is a planning ledger only. It must be re-derived after G rather than
treated as a frozen file list.

| Area | Expected build responsibility |
|---|---|
| Migration/Prisma | Additive C5.1/C5.2 receipt/item/effect/decision shapes; receipt-aware I04/I05/I19 guards; Prisma regeneration |
| C5.2 backend | Existing reconciliation validator, middleware/context, service, controller, routes, task/audit integration, typed errors |
| C5.1 backend | Existing receipt service, duplicate/mismatch attempts, terminal outcome replay, held-source identity/retention |
| I04 | Replace combined owner retry release with receipt-backed authority-only command; preserve separate MSA reconciliation and ACK/cursor law |
| I05 | Add per-protocol owner-authorized selector/claim branch with exact receipt proof; keep live branch unchanged |
| I19 | Add receipt-proven `recovery_pending` eligibility transition; keep payment manual and ordinary live dispatch unchanged |
| Catalog/seed | Register release capability for I04/I05/I19 only; keep I18 not-yet; add no active/production seed |
| OpenAPI/core | Extend existing C5.2 schema/operation overlays; regenerate backend/core mirrors; no module/manifest/tag addition |
| Admin | Extend the existing continuity reconciliation page/API/tests only |
| Staff/shared Dart | Extend the existing reconciliation workbench/client/models/localization/tests only |
| Tests/docs | Full matrix in section 13; retire/narrow the interim operator procedure; update build runbook and activation tracker as inert |

Unexpected overlap after G, a new migration owner, a changed C5.1 receipt
contract, a new family state, an I18 release request, or a missing full-suite
environment is a coordinator stop condition.

## 15. Interim operator procedure retirement

When the executor is built, validated, and separately activated,
`docs/continuity/c6-1-i05-held-message-operator-procedure.md` is narrowed as
follows. The live document is already a hold-only procedure that forbids direct
SQL; it is not an authorized manual release mechanism.

**Retired:**

- its blanket instruction to retain an otherwise eligible message after an
  owner decision merely because the typed executor does not yet exist;
- its old future-slice migration-range and sequencing statement; and
- any operator inference that an accepted C5.2 decision alone is send authority.

**Survives:**

- inspect the exact message, payload-hash/ciphertext evidence, attempts,
  acknowledgements, receipts, channel/subscription/runtime, and recovery inbox;
- treat held/quarantined/recovery-pending and owner-reconciliation-required as
  do-not-send until the typed receipt outcome exists;
- record/link the C5.2 incident-interface requirement and owner task;
- keep replay, dispatch-now, migration reruns, and direct SQL out of the release
  path;
- preserve owner reasons and all prior evidence; and
- if the workbench or receipt executor is unavailable, leave the message held
  and escalate. There is no SQL fallback.

The revised procedure also states affirmatively that manual SQL, a status-only
or send-authority-only update, migration rerun, replay batch, `dispatch-now`,
redrive, or broad dispatch is never a release. Held authority may change only
through the C5.2 act endpoint with its applied C5.1 receipt.

The build updates the operator document to say this explicitly. The design
commit does not alter the live interim procedure.

## 16. Rollback

Code rollback disables bind, attest, and release commands and hides their
controls. It leaves the additive schema in place and preserves every item,
decision, receipt, effect, audit row, task, source transition, attempt, ACK,
cursor, and recovery record.

Rollback never:

- revokes a release already consumed by a dispatcher;
- rewinds a message to held/quarantined/recovery-pending;
- deletes or rewrites a C5.1 receipt/effect/tombstone;
- resets ACK, transport, cursor, attempts, or NHCX state;
- releases a message through an older helper; or
- activates I18 or any automatic mechanism.

If a released but not yet claimed message must be stopped, that is a new
owner-directed revoke/cancel command with its own receipt and family semantics.
It is not hidden inside rollback and is outside this slice.

## 17. Explicit non-goals and coordinator gate

This slice does not add:

- automatic, scheduled, startup, migration-time, or retry-ladder release;
- predicate-bulk or version-1 batch release;
- I18 binding, attestation, release, receipt, dispatcher, or UI action;
- guard bypass or general weakening;
- parsed ACK, cursor, transport-result, pathway, SLA, timeline, notification,
  payment, settlement, or retrospective domain authority;
- a second receipt, queue, task, audit, approval, redrive, or release engine;
- a new Admin/Staff navigation area;
- a new OpenAPI module, manifest/domain entry, or tag;
- provider credentials, live endpoints, subscriber/NHCX classification,
  facility policy, clinical sign-off, deployment, activation, or production
  readiness; or
- a migration reservation before C6.1-G lands.

Coordinator acceptance of this Step-1 delta means only: queue the Step-2 build
after C6.1-G, re-fetch main, derive the fresh migration slot, freeze the exact
post-G ledger, and implement the receipt-backed C5.2 exception described here.
It does not authorize merge, deployment, release execution, or activation.
