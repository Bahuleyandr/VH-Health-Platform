# C6.1 durable resume markers and duplicate keys — backend design delta

**Status:** Step 1 design delta; implementation is not cleared
**Scope:** `apps/backend`, its migration, regenerated
`apps/backend/prisma/schema.prisma`, and backend tests only
**Branch:** `feat/continuity-c6-1-resume-markers`
**Baseline:** re-fetched `github/main` and `origin/main` at
`1f5c94e36623c6c392f55f85f43e03eec480f57f`
(`2026-07-31T01:50:26+05:30`)
**Sequencing gate:** C4.2 PR
[#660](https://github.com/Bahuleyandr/VH-Health-Platform/pull/660) is still an
open draft at `d02785b95784feac14f9e93a366b1a25959b0268`; it owns migration
`602_clinical_continuity_action_registry.sql` and regenerates
`prisma/schema.prisma`. C6.1 does not build, reserve a migration number, or
regenerate Prisma until #660 is merged and this delta is cleared.
**Release state:** inert, workers paused, no interface activation
**Merge state:** never merge from this lane

## 1. Outcome and binding authority

C6.1 will extend the existing `event_consumer_offsets` and
`pathway_projector_inbox` pair into the one canonical durable stream substrate.
It will not add a sixth parallel cursor, replay-guard, or work-ledger
mechanism.

The canonical pair will provide:

- one durable high-water mark per tenant, interface family, direction, and
  source partition;
- one durable source item identity, command fingerprint, lease, and terminal
  outcome per replayable item;
- gap detection and source-retention checks before work is claimed;
- atomic cursor advance with the authoritative domain result or accepted
  downstream acknowledgement;
- exact-duplicate return without effects and fingerprint-mismatch refusal;
- a persisted late-arrival disposition enforced before SLA, pathway, or
  notification effects; and
- explicit, recorded `not applicable — no replayable stream` dispositions for
  interfaces that do not carry a stream.

The binding authority is:

- continuity plan section 9, C6.1, plus the plan section 1 execution and shared
  integrity rules;
- continuity design section 5.6 late-arrival and projector rules and section
  6.8 shared integrity rules;
- all 30 families, stop/restart order, and ranked gaps in
  `docs/continuity/c6-1-integration-recovery-inventory.md`; and
- countersigned C-D8 parts 1 through 4 in
  `docs/continuity/c0-4-owner-decision-dossier.md`.

C-D8 is not reopened. In particular:

1. late data defaults to ordinary pending work and never automatically creates
   a retrospective SLA alarm, care-pathway transition, or patient
   notification;
2. workers start paused and the signed disposition is applied before backlog
   release;
3. every replayable stream receives a durable per-tenant mark and duplicate
   key; and
4. Dr Bahuleyan S remains the accountable owner for interface recovery
   decisions, with delegates optionally recorded later.

## 2. Existing-mechanism ruling

| Existing mechanism | Ruling | Reason |
|---|---|---|
| `interop_replay_guard` (migration 321) | Leave in place as a pre-tenant transport-security fence; never treat it as the C-D8 duplicate ledger or cursor. | It rejects a still-fresh signed request across replicas, contains no PHI, is deliberately pre-tenant, and expires with the signature window. Adding an untrusted tenant assertion to this authentication-stage key would weaken the trust boundary. After authentication and authoritative tenant resolution, every replayable request must also enter the tenant-scoped canonical inbox. |
| `lab_result_ingest_commands` (migration 582) | Leave the lab manual/panel table and service in place; carry its claim/fingerprint/non-rearmable-outcome invariants into the canonical inbox. Add an optional, same-tenant canonical-inbox link only when a lab adapter is migrated. | It is the strongest transaction-coupled command-effect model, but it is actor- and lab-scope-specific and is not an external-stream cursor. Widening its name, status checks, result-array shape, and lab foreign keys to unrelated interfaces would turn a safe domain ledger into a polymorphic catch-all. |
| `event_consumer_offsets` (migration 578) | Extend as the canonical registry and high-water-mark store. | It is the only general cursor lifecycle with generations, cutoff, backfill, and retirement. New external-interface rows become tenant-scoped; existing global pathway-registry rows remain a narrowly documented control-plane row type. |
| `pathway_projector_inbox` (migration 578) | Extend as the canonical tenant-scoped item ledger and duplicate-key store. | It already has commit-coupled intake, per-tenant identity, leases, retries, dead state, and exact once-per-consumer event identity. External rows add source identity/fingerprint and cursor binding without copying domain payloads. |
| `clinical_continuity_edge_access_grants` and its shared revision sequence (migration 601) | Leave in place. Reuse its monotonic-revision, append-only, composite-FK, explicit-context RLS, and column-grant patterns, not its table. | An access revision is a signed facility access projection, not an external message acknowledgement or replay cursor. Its global sequence is safe because exported state and uniqueness are evaluated per tenant and facility; co-opting grant rows as interface offsets would corrupt the access evidence model. |

Interface-specific domain queues remain the authoritative payload stores. The
canonical inbox holds source identity, fingerprint, timestamps, disposition,
and a constrained link; it never creates another PHI payload copy. Each adapter
adds a same-tenant and, where applicable, same-facility foreign key from its
domain row to the canonical inbox. Application-only polymorphic
`resource_type/resource_id` references are not accepted.

### 2.1 Why the two currently untenanted stores are different

`interop_replay_guard` is intentionally exempt from tenant scope only for the
pre-authentication HMAC freshness check. The exemption ends as soon as the
tenant is authoritatively resolved. A request that carries replayable domain
work then requires a second, durable canonical claim keyed by tenant, source,
duplicate identity, and fingerprint. Expiry or sweeping of
`interop_replay_guard` can never re-arm that domain work.

Current `event_consumer_offsets` rows are global because one pathway consumer
generation is registered against the repository-wide monotonic
`event_outbox.id` sequence; the database trigger then fans each event into a
tenant-scoped inbox row. Making that registry lifecycle independently
tenant-generated would create generation skew and duplicate trigger fan-out.
Those existing rows therefore remain `pathway_registry` control-plane rows.

That exemption does not apply to C6.1 rows. Every
`external_interface` offset row has non-null tenant scope, and a runtime worker
cannot read or mutate a global registry row through normal table privileges.
The existing pathway registration service moves behind narrow
`SECURITY DEFINER` functions that can act only on `pathway_registry` rows.
External-interface workers always use an explicitly pinned tenant transaction.

## 3. Canonical substrate delta

The first cleared build extends the two existing tables. It does not rename
them and does not add a replacement table.

### 3.1 `event_consumer_offsets`

The table gains a surrogate `offset_id` and a checked `scope_kind`:

- `pathway_registry` for the existing global event-outbox consumer lifecycle;
- `external_interface` for C6.1 tenant-scoped cursors.

Existing pathway columns remain populated only for `pathway_registry` rows.
External rows carry:

- non-null `tenant_id`;
- nullable `facility_id`, required by the interface catalog when the source is
  facility-bound;
- `interface_family`, `direction`, `source_partition`, `consumer_key`, and
  `generation`;
- `cursor_kind`;
- `high_water_position` plus `high_water_token`;
- `retained_from_position` plus `retained_from_token`;
- `resume_cutoff_position` plus `resume_cutoff_token`;
- `recovery_state`;
- `reconciliation_reason`;
- signed policy/version binding; and
- retention-policy binding and `retention_until` without an engineering
  default.

The position is an adapter-normalized monotonic ordinal. The token is the exact
source/provider value used for round-trip reconciliation. A source that has
only an opaque predecessor token may advance when the item's predecessor token
matches the current high-water token. A source with neither a monotonic
position nor a predecessor token is not automatically replayable and remains
held for owner-directed reconciliation.

The old primary key becomes a partial uniqueness contract for
`pathway_registry`. External live generations are unique by
`(tenant_id, interface_family, direction, source_partition, generation)`, and
only one generation per such partition may be live.

`recovery_state` is one of:

- `paused`;
- `ready`;
- `replaying`;
- `reconciliation_required_missing_marker`;
- `reconciliation_required_retention_gap`;
- `reconciliation_required_source_gap`; or
- `retired`.

There is no state or code path named `start_from_now` or `replay_all`.

### 3.2 `pathway_projector_inbox`

The table gains a surrogate `inbox_id` and the same checked `scope_kind`.
Existing pathway rows preserve their current
`(tenant_id, consumer_key, generation, event_id)` uniqueness and behavior.
External rows carry:

- non-null `tenant_id` and the catalog-required `facility_id`;
- a same-tenant `offset_id`;
- `interface_family`, `direction`, `source_partition`, and generation;
- `source_position`, `source_token`, and `predecessor_token`;
- `duplicate_key` and canonical `command_fingerprint`;
- validated `occurred_at`, server `received_at`, and `recorded_at`;
- `arrival_class` of `live`, `recovery_backlog`, or `unknown`;
- `effect_disposition` of `normal`, `late_pending_only`, or
  `signed_exception`;
- lease, attempt, retry, terminal status, and typed outcome code; and
- signed policy/version and retention bindings.

The external duplicate identity is unique by
`(tenant_id, interface_family, direction, source_partition, duplicate_key)`.
The source position is independently unique within the live generation. An
exact duplicate with the same fingerprint returns the stored typed outcome and
does not execute an adapter. Reuse of the duplicate key or source position with
a different fingerprint fails closed to reconciliation. Identity,
fingerprint, source position, timestamps, disposition, and terminal outcomes
are immutable.

The inbox does not store the raw HL7, ASTM, FHIR, sensor, notification, or
provider payload. The domain queue/receipt keeps that payload, and its adapter
PR adds a composite foreign key to `inbox_id`. The inbox stores only a SHA-256
fingerprint and non-PHI source identity needed for duplicate and cursor proof.

### 3.3 Cursor advance

The worker locks one tenant offset row, then the next contiguous inbox row.
Within one tenant transaction it:

1. verifies the signed catalog disposition and current generation;
2. verifies marker, predecessor, source-retention, duplicate, and fingerprint
   state;
3. resolves the late-arrival effect disposition;
4. executes the domain adapter or records the exact duplicate outcome;
5. writes the permitted domain fact and required pending-work evidence;
6. writes canonical audit/outbox evidence under the enforced effect
   disposition;
7. terminally records the inbox item; and
8. advances the offset to that exact source position/token.

Any failure rolls back the domain result, inbox terminal state, and cursor
advance together. Later rows never pass an unresolved predecessor. Outbound
streams advance only after the interface-specific positive acknowledgement,
not merely after a network write. Where the current adapter accepts an
insufficient acknowledgement, such as I04 accepting any HTTP 2xx without an
HL7 ACK, its backlog stays paused until the adapter PR defines and tests the
acknowledgement.

## 4. Restart and reconciliation semantics

Workers always start paused. At restart, the operator follows C-D8 section 2,
records queue counts and oldest timestamps, and opens one tenant/interface
partition at a time.

### 4.1 Normal resume

For a complete marker within source retention:

1. compare the sender/provider/local-queue outstanding range with the stored
   high-water position and token;
2. set the recorded recovery cutoff to the final item that existed at the
   frozen restart boundary;
3. claim only the exact successor whose predecessor matches the marker;
4. land every item at or before that cutoff with `arrival_class =
   recovery_backlog`;
5. validate source and local counts after each contiguous advance; and
6. change the row from `replaying` to `ready` only when the recorded backlog
   boundary is reconciled.

Opening the external sender does not alter the marker. New live traffic begins
only after backlog reconciliation and retains the same duplicate-key contract.

### 4.2 Marker missing

An absent offset row, absent high-water value, or missing signed disposition
sets `reconciliation_required_missing_marker`. The worker does not create a
cursor at the current source head and does not assume zero. The accountable
owner or recorded delegate supplies an evidence-backed initial position/token
in a new generation after comparing sender and local records. The prior
absence and the decision are append-audited.

### 4.3 Marker older than retained data

If the source's first retained position is newer than the marker's successor,
the row becomes `reconciliation_required_retention_gap`. No item is applied and
the marker is not advanced. The operator records the missing range, local
domain evidence, sender evidence, and owner decision. A reconciled baseline is
created only as a new generation. Neither `start from now` nor `replay all` is
an inferred fallback.

### 4.4 Source gap, unordered data, or ambiguous acknowledgement

A predecessor mismatch, non-contiguous position, or ambiguous downstream
acceptance pauses only that tenant/interface partition. Later items may remain
durably present but are not executed. Unordered protocols must define an
adapter-owned ordering partition and predecessor contract before activation.
A protocol message ID that is unique but not ordered is a duplicate key, not a
high-water mark.

## 5. Late-data enforcement seam

The code seam is
`externalInterfaceRecoveryService.processNextItemTx()`. No external recovery
adapter is callable by a scheduler or route without entering this seam. It
loads the signed disposition, locks the tenant offset/inbox rows, classifies
arrival, and sets transaction-local
`app.external_recovery_effect_disposition`.

`recovery_backlog` defaults to `late_pending_only`. `unknown` is held for
reconciliation and never defaults to live. Only an event-family policy signed
under C-D8 can produce `signed_exception`; no such exception is invented by
this delta.

This is enforced at four layers:

1. **Database effect guard.** A migration-owned
   `assert_external_recovery_effect_allowed()` trigger rejects creation or
   retrospective activation of `workflow_sla_instances`,
   `care_pathway_transition_events`, and `notification_outbox` rows while the
   transaction disposition is `late_pending_only`. The runtime roles cannot
   execute, alter, or bypass the guard function.
2. **Domain adapter capability.** The seam mints a private capability carrying
   the locked inbox identity and effect disposition. Adapter entry points
   require it. Late adapters may persist the source fact and an existing-domain
   pending-review item, but they cannot call live-effect methods. Recovery
   adapters are statically forbidden from importing provider send functions.
3. **Outbox/projector fence.** Replay-origin `event_outbox` rows require a
   same-tenant inbox reference, validated `occurred_at`, and persisted effect
   disposition. `pathwayProjectorService.processClaimedInboxRow()` reads those
   columns. For `late_pending_only`, it records a typed ignored outcome without
   invoking a pathway handler, and it refuses to do so unless the adapter
   transaction recorded the required pending-work evidence.
4. **Post-commit fence.** The seam emits no post-commit notification command
   for `late_pending_only`. Existing lab, vitals, cold-chain, and notification
   adapters are refactored so post-commit provider delivery is returned as an
   intent to this seam rather than called directly.

A late critical lab result therefore persists the result and the existing
critical-results pending item for human acknowledgement, but the database
blocks a new retrospective SLA clock, the projector does not transition the
pathway, and no notification row or provider intent is produced. A late
cold-chain reading persists as evidence and pending review without opening or
closing current excursion state. A late vital persists as an observation and
pending review without retrospective NEWS2 escalation, triage mutation, or
notification.

### 5.1 Event-time normalization

The current projector seam passes only `event_outbox.created_at`. Diagnostic,
referral, OP, emergency, and the main inpatient path use that receipt time as
domain occurrence time. The inpatient diagnostic-resource-link branch is the
only partial exception: it reads `payload.occurred_at`, while the same
projector's main transition path still uses `created_at`. Thus four projectors
have no occurrence-time path at all, and all five read `created_at` somewhere.
The live anchors are
`apps/backend/src/services/events/pathwayProjectorService.js:475,526`,
`apps/backend/src/services/pathways/diagnosticPathwayProjector.js:163`,
`apps/backend/src/services/pathways/referralPathwayProjector.js:137`,
`apps/backend/src/services/pathways/opPathwayProjector.js:455`,
`apps/backend/src/services/pathways/inpatientPathwayProjector.js:71,390`, and
`apps/backend/src/services/pathways/emergencyPathwayProjector.js:216`.

The first build adds a typed `event_outbox.occurred_at` contract and treats
`created_at` as server `recorded_at`. Historical rows are backfilled from
`created_at` only to preserve historical behavior; they are marked as legacy
receipt-time provenance. Every replay-origin row must provide a validated
source occurrence time and canonical inbox reference or the insert fails.
`pathwayProjectorService` passes `occurred_at`, and all five projectors stop
reading `created_at` as domain time. A late-pending event is fenced before any
projector handler regardless of its timestamp.

## 6. All-interface disposition table

`HWM required` means the adapter must bind to the canonical per-tenant offset
and inbox before it can replay. If the named source position is not available
from the current external contract, activation is blocked; a local receipt
timestamp or message ID is not substituted. All replayable rows inherit
`late_pending_only` unless a separately signed event-family exception exists.

| ID | Recorded disposition | Canonical partition and duplicate key | High-water mark and restart binding | Late handling / implementation slice |
|---|---|---|---|---|
| I01 | HWM required — inbound LIS ORU stream | Per tenant and `trusted_sender_identity`; duplicate `(tenant, sender, MSH-10)` plus raw-message SHA-256, preserving `lab_oru_ingest_messages` | LIS-provided monotonic sequence/token; absent source sequence holds the sender for owner reconciliation | Result plus critical-results pending item only; no SLA/pathway/notification. C6.1-C |
| I02 | HWM required — inbound ASTM stream | Per tenant and analyzer/sender; existing canonical ASTM fingerprint `(tenant, analyzer channel, protocol, astm_message_sha256)` | Analyzer/LIS monotonic sequence/token; no ingestion timestamp fallback | Result plus pending critical review only. C6.1-C |
| I03 | HWM required — inbound HL7 ADT/ORM stream | Per tenant, signing client, and message family; `(tenant, client, message type/trigger, MSH-10)` plus payload SHA-256. `interop_replay_guard` remains only the HMAC freshness fence | Sender sequence/token negotiated per ADT/ORM partition; absent sequence holds replay | Pending admission/order reconciliation; no downstream live effect. C6.1-E |
| I04 | HWM required — outbound HL7 stream | Per tenant/subscription; source-event/subscription/message type duplicate key plus payload SHA-256; MSH-10 remains downstream identity | Contiguous local queue/source-event position plus positive parsed HL7 ACK. HTTP 2xx alone cannot advance | Hold late outbound clinical messages until downstream reconciliation; no automatic release. C6.1-E |
| I05 | HWM required — generic engine streams | Per tenant/channel/direction/target; declared protocol identity plus payload SHA-256 | Channel-specific source position/predecessor. Stored `replay_requested` work stays frozen until actual backend delivery and dispatch use the seam | Target-domain pending-only policy; one adapter per declared protocol. C6.1-E and later protocol PRs |
| I06 | Mixed: HWM required for inbound study-link events; `not applicable — no replayable stream` for worklist and metadata reads | Per tenant/PACS endpoint; `(study_instance_uid, order_id)` plus payload SHA-256 | PACS change sequence/token. If the PACS contract cannot supply one, study-link replay is owner-reconciled; reads have no cursor | Late link becomes imaging pending review; reads retry synchronously. C6.1-E |
| I07 | `not applicable — no repository-implemented external connector` | No fabricated key; internal pharmacy REST/database workflow is outside C-D8 external-interface replay | No marker | Any later connector requires a new signed disposition before enablement |
| I08 | `not applicable — no repository-implemented external connector` | No fabricated key; internal blood-bank workflow is outside this interface family and cold chain is I10 | No marker | Any later connector requires a new signed disposition before enablement |
| I09 | HWM required — gateway MLLP spool stream | Per tenant/gateway source/device; `(tenant, device/source, MSH-10)` plus canonical message SHA-256 | Durable gateway spool sequence and predecessor token reconciled to the backend offset. Backend refuses unsequenced recovery traffic | Observation plus pending review only; no NEWS2 escalation, triage mutation, pathway, SLA, or notification. C6.1-B backend; gateway change is separately cleared |
| I10 | HWM required — cold-chain sensor stream | Per tenant/facility/unit/sensor; source reading ID plus canonical reading fingerprint | Sensor/gateway monotonic reading sequence and predecessor; absent marker/sequence blocks replay | Persist reading evidence and pending review; do not open/close excursion, create SLA, or notify. **C6.1-A, the only first-PR interface** |
| I11 | `not applicable — no replayable stream` | OIDC state/nonce/PKCE/code remain bounded authentication controls, not C-D8 duplicate keys | Browser/token request-response flow has no marker | Failed/in-flight login restarts; any later clinical action is freshly authorized |
| I12 | `not applicable — no replayable stream` | Existing provider/kind/request/assertion replay keys remain authentication controls | Browser/assertion flow has no marker | New login after failure; queued clinical work is separately re-authorized |
| I13 | HWM required — SCIM provisioning change stream | Per tenant/provider; provider event/version/request key plus method/path/body SHA-256 | Provider change sequence/version. Without one, list/diff reconciliation is owner-directed and no push replay runs | Late enable/update/deactivate/delete becomes identity pending review; no automatic access mutation. C6.1-F |
| I14 | `not applicable — no replayable stream` | Firebase UID/token and App Check token are authentication/attestation identities | Verification and revocation are synchronous provider calls with no marker | Client retries authentication; later clinical work is re-authorized |
| I15 | Mixed: HWM required for FHIR writes; `not applicable — no replayable stream` for SMART browser OAuth | Per tenant/FHIR client/resource partition; client event ID or conditional-create identity plus canonical resource SHA-256 | Client/source sequence or predecessor token for writes. Pagination offsets are not a durable write cursor | Late Observation persists plus pending review only; no NEWS2, triage, alert fan-out, SLA, pathway, or notification. C6.1-B |
| I16 | HWM required — ABDM callbacks, data requests, and outbound transfer work | Per tenant/environment/direction/request kind; ABDM request/correlation/transaction ID plus canonical payload SHA-256. Short-TTL HMAC guard stays pre-auth only | Provider transaction sequence/token for callbacks and local durable sequence for accepted outbound work; stranded `PROCESSING` work is claimed through the inbox | Late consent/export changes become pending privacy/ABDM review; no automatic collection/push. C6.1-F |
| I17 | HWM required — notification delivery stream | Per tenant/channel; `(source event, recipient, channel, template/version)` plus rendered-intent SHA-256 | Contiguous `notification_outbox.id` per channel partition; advances on defined provider acceptance, not device receipt | Late rows are held/suppressed. No patient/staff delivery without a signed event-family exception. C6.1-D |
| I18 | HWM required — outbound subscriber webhook stream | Per tenant/subscription; existing `(event_outbox_id, subscription_id)` plus payload SHA-256; ad hoc enqueue must supply equivalent source identity | Contiguous source `event_outbox.id` per subscription and positive HTTP acknowledgement; uncertain acceptance does not advance | Hold late delivery until subscriber reconciliation and signed release. C6.1-G |
| I19 | HWM required — NHCX outbound and callback streams | Per tenant/environment/direction/endpoint; existing API-call identity outbound; correlation/workflow/call ID plus payload SHA-256 inbound | Local `nhcx_messages.id` outbound; provider sequence/token inbound. Short HMAC TTL is not the cursor | Late finance/authorization state becomes pending review; payment notice remains manual. C6.1-F |
| I20 | `not applicable — no replayable stream` | Existing stable `vh-prior-auth-{priorAuth.id}` request key remains the synchronous retry identity | No local queue or delayed callback, so no marker | Caller/operator retries request-response work; no automatic late state |
| I21 | `not applicable — no replayable stream` | Durable local teleconsult/session/room identity remains domain state | Real-time media has no replay cursor | Reconnect or reissue token; provider state cannot transition a pathway |
| I22 | `not applicable — no replayable stream` | Read-only WHO ICD lookup | No marker | Synchronous retry/fallback; stale terminology cannot authorize queued work |
| I23 | HWM required — ClinicalTrials.gov catalog stream | Per tenant/catalog query; NCT ID plus source version/update timestamp | Exact provider page/revision token and predecessor. An expired token requires owner-directed reconciliation; never an inferred full sync | Late catalog rows remain catalog pending review; no recruitment notification/pathway effect. C6.1-G |
| I24 | `not applicable — no replayable stream` | Synchronous LLM, embedding, STT, and chatbot request identities remain invoking-domain concerns | No provider callback or delayed stream marker | In-flight work fails/retries; output requires fresh domain/human authorization |
| I25 | HWM required — SIEM export stream | Per tenant/source/target; existing `(tenant, source_name, source_id)` event identity and attempt identity | Existing audit-log ID cursor migrates into canonical offsets after parity; old rows are retained as evidence, not run in parallel | Late export remains held until the event-family release is cleared; no clinical effects. C6.1-G |
| I26 | `not applicable — no application-owned replayable stream` for Sentry/Crashlytics SDK sends, Prometheus pull, and current fire-and-forget webhooks | Provider SDK identity, scrape identity, and in-memory debounce are not fabricated into C-D8 keys | No application marker. Adding a durable alert stream changes this disposition before enablement | Restart loss/reset remains explicit; observability cannot authorize clinical resume by itself |
| I27 | `not applicable — no replayable stream` | Object key/digest and scan request are synchronous operation identities, not stream keys | No marker | Caller reconciles provider success/local failure before releasing content |
| I28 | `not applicable — no replayable stream` | Synchronous CDS Hooks invocation | No marker | EHR retries and receives a fresh evaluation; cards do not transition local pathways |
| I29 | `not applicable — no replayable stream` | Signed read-only Metabase embed | No marker | Regenerate embed and verify source freshness; display cannot authorize an action |
| I30 | `not applicable — no replayable stream and no gateway callback on this baseline` | Durable link token/transaction reference and authenticated manual mark-paid key remain domain controls | No marker; direct distribution is a manual best-effort action | Late resend is not automatic and remains suppressed unless explicitly approved |

The runtime catalog contains exactly I01 through I30 and rejects duplicate,
missing, or unknown IDs. Mixed families require their subpath disposition to
be selected explicitly; they cannot inherit the more permissive subpath.

## 7. Section 6.8 integrity, security, and retention contract

Every new external offset/inbox row:

- has a non-null tenant and rejects the default tenant sentinel;
- has a composite tenant/facility foreign key when its catalog entry is
  facility-bound;
- references its tenant-scoped offset through a same-tenant composite foreign
  key;
- has tenant-aware primary/unique/index definitions;
- applies both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`;
- adds the C3.1-style restrictive explicit-context policy so null, empty, and
  `bypass` tenant settings match no C6.1 row;
- is accessed by background workers only through `setTenantTx`;
- denies normal runtime table `UPDATE`, `DELETE`, and `TRUNCATE`;
- exposes narrow migration-owned functions or exact column grants for claim,
  completion, and cursor advance;
- is append-audited for generation initialization, retirement, and
  reconciliation decisions; and
- is retained under a signed retention-policy version with no hard-coded
  duration.

No cursor/inbox/domain link is deleted while the source item can still replay,
while its duplicate key protects a retained source range, or while a
reconciliation decision is open. This delta does not invent a retention value.
If the signed retention binding is absent, compaction and deletion are denied.

The global `pathway_registry` row type has no tenant data and is reachable only
through its constrained control-plane functions. Those functions reject
`external_interface` rows. Conversely, tenant workers cannot select global
rows or use the migration-owner bypass.

## 8. Blast-radius order and PR split

The build remains blocked until #660 is merged and the coordinator clears this
delta. At each kickoff, main is re-fetched, the prerequisite SHA and PR state
are reverified, and the next free migration number is derived. No number is
reserved here.

The reviewable delivery order is:

1. **C6.1-A — canonical substrate, enforcement seam, and I10 cold chain.**
   This is the first PR and I10 is its only interface adapter. It lands inert,
   requires synthetic source sequence/predecessor evidence, normalizes outbox
   occurrence time, and proves pending-only late handling.
2. **C6.1-B — I15 FHIR Observation and I09 backend device-vitals.** These share
   the vitals/NEWS2/triage safety boundary. The backend refuses recovery
   traffic until a separately cleared gateway/client change supplies source
   sequence and duplicate identity.
3. **C6.1-C — I01 ORU and I02 ASTM.** Adapt the existing durable laboratory
   inboxes without replacing them; prove late critical results remain pending
   and never start retrospective SLA/pathway/notification effects.
4. **C6.1-D — I17 notifications only.** Provider acknowledgement, uncertain
   delivery, enqueue uniqueness, concurrency, ordering, and late suppression
   remain isolated for review.
5. **C6.1-E — I03/I04/I05/I06 interoperability.** Land one protocol/channel
   adapter at a time behind the same PR series if the combined diff ceases to
   be reviewable.
6. **C6.1-F — I13/I16/I19 identity, ABDM, and NHCX streams.** These are
   partitioned by provider and direction and do not share clinical release
   authority.
7. **C6.1-G — I18/I23/I25 webhooks, trial catalog, and SIEM.** Migrate the
   existing SIEM cursor only after parity; never delete old evidence in the
   migration PR.

The all-30 catalog and this disposition table do not activate all 30
interfaces. An adapter remains paused until its own PR, tests, owner evidence,
and outage/recovery drill are cleared.

## 9. C6.1-A exact file ledger

This is the proposed first-PR ledger after rebasing onto the merge of #660.
Coordinator clearance is required before any of these runtime files are
changed.

### Add

- `apps/backend/src/migrations/<next-free>_external_interface_recovery.sql`
- `apps/backend/src/config/externalInterfaceRecoveryCatalog.js`
- `apps/backend/src/services/integrations/externalInterfaceRecoveryService.js`
- `apps/backend/src/services/integrations/externalRecoveryEffectGate.js`
- `apps/backend/src/tests/deep/externalInterfaceRecoveryMigration.deep.test.js`
- `apps/backend/src/tests/external-interface-recovery.deep.test.js`
- `apps/backend/src/tests/external-recovery-late-effects.deep.test.js`
- `apps/backend/src/tests/unit/externalInterfaceRecoveryCatalog.test.js`
- `apps/backend/src/tests/unit/externalRecoveryEffectGate.test.js`

### Modify

- `apps/backend/prisma/schema.prisma`
- `apps/backend/src/services/events/eventOutboxService.js`
- `apps/backend/src/services/events/pathwayProjectorService.js`
- `apps/backend/src/services/pathways/diagnosticPathwayProjector.js`
- `apps/backend/src/services/pathways/referralPathwayProjector.js`
- `apps/backend/src/services/pathways/opPathwayProjector.js`
- `apps/backend/src/services/pathways/inpatientPathwayProjector.js`
- `apps/backend/src/services/pathways/emergencyPathwayProjector.js`
- `apps/backend/src/services/devices/coldChainService.js`
- `apps/backend/src/utils/notifications/notificationOutbox.js`
- `apps/backend/src/tests/pathway-event-delivery.deep.test.js`
- `apps/backend/src/tests/pathway-projector-replay.deep.test.js`
- `apps/backend/src/tests/cold-chain-ack-atomicity.deep.test.js`
- `apps/backend/src/tests/unit/coldChainService.test.js`
- `apps/backend/src/tests/unit/notificationOutboxQueue.test.js`

No route, controller, OpenAPI, scheduler-enable, environment-secret,
Kubernetes, device-gateway, admin, patient, Staff, or infrastructure file is
in C6.1-A. The worker service is callable only from tests until a separately
cleared scheduling/activation PR.

## 10. Test and evidence matrix

All fixtures are synthetic.

### 10.1 Canonical substrate

- exactly I01 through I30 in the catalog, with no missing, duplicate, or
  unknown family;
- mixed-subpath selection cannot fall through to another disposition;
- current pathway registry registration/backfill/generation behavior remains
  unchanged;
- global pathway rows are unavailable to runtime tenant workers except through
  constrained functions;
- external rows reject null/default tenant, wrong tenant, wrong facility, and
  cross-tenant offset/inbox/domain links;
- `ENABLE` plus `FORCE` RLS and restrictive explicit-context policies;
- direct SQL with absent, empty, `bypass`, wrong, and correct pinned tenant;
- exact runtime role grants and denied update/delete/truncate/function bypass;
- one live generation per tenant/interface/direction/partition;
- exact duplicate returns the terminal outcome with no adapter call;
- duplicate-key, source-position, or predecessor reuse with fingerprint
  mismatch fails closed;
- concurrent claims, lease expiry, retry, terminal outcome, and stale-worker
  fencing;
- cursor/domain/inbox atomic rollback;
- later positions cannot pass a gap;
- missing marker, old marker beyond source retention, and ambiguous
  acknowledgement enter the exact reconciliation-required state;
- no code path infers zero, current head, `start from now`, or `replay all`;
- retirement and new-generation initialization preserve prior evidence; and
- retention/compaction fails closed without a signed policy binding.

### 10.2 Event time and late effects

- replay-origin outbox rows reject missing inbox identity, occurrence time,
  fingerprint, or disposition;
- historical outbox rows preserve receipt-time behavior with explicit legacy
  provenance;
- all five projectors receive `occurred_at` and no longer use `created_at` as
  domain time;
- `late_pending_only` prevents pathway handler invocation;
- database guards reject retrospective SLA, pathway-transition, and
  notification rows from the late transaction;
- direct provider imports from recovery adapters fail the static boundary
  check;
- a missing pending-work reference prevents terminal handling rather than
  dropping the late fact; and
- a separately signed exception is required to exercise any non-default late
  effect.

### 10.3 I10 first adapter

- stable source reading ID, monotonic position, predecessor, and canonical
  fingerprint validation;
- exact retry creates one reading and returns the same typed outcome;
- conflicting retry and out-of-order/gapped reading fail closed;
- worker restart resumes at the exact next position;
- missing/expired marker freezes the partition;
- late in-range and out-of-range readings persist evidence and required
  pending review;
- late readings do not open, update, or close an excursion;
- no late SLA, pathway transition, notification, or direct provider call;
- live behavior remains unchanged while the worker is paused/default-OFF; and
- tenant, facility, unit, and device cross-scope attempts fail at the database.

### 10.4 Gates after clearance

The build PR retains receipts for:

- backend formatting and `npm run lint`;
- focused unit and deep suites above;
- full backend Jest shards;
- migration fresh-apply and re-run proof;
- `npx prisma db pull --schema=prisma/schema.prisma`;
- `npm run check:schema-drift`;
- backend Swagger/OpenAPI checks even though no route change is planned;
- secret, dependency, Semgrep, and CodeQL checks;
- exact changed-path ledger; and
- rollback rehearsal with workers paused and all cursor/inbox evidence
  preserved.

## 11. Rollback

Rollback disables the C6.1 worker and adapter catalog entry. It does not delete
or rewind an offset, inbox item, duplicate key, source receipt, pending-work
item, audit row, or reconciliation decision. Existing pathway consumer
behavior remains available through the compatibility row type. A later
contract migration may stop new writes only after parity; it may not drop
retained evidence in the rollback PR.

## 12. Explicit non-goals and clearance conditions

This delta and its first build provide:

- no C5.1 replay receipt;
- no C5.2 reconciliation workbench;
- no live interface reconfiguration;
- no scheduler or interface activation;
- no deployment, DNS, secret, provider, cluster, or production change;
- no new clinical threshold, SLA duration, notification timing, replay window,
  or retention duration;
- no replacement of domain payload queues;
- no automatic full replay or start-at-current behavior;
- no device-gateway/client change in this backend lane; and
- no merge.

Coordinator clearance must confirm:

1. the canonical-pair ruling and the two explicit untenanted exemptions;
2. the all-30 disposition table;
3. the missing-marker and source-retention reconciliation states;
4. the database-backed late-effect seam and normalized projector occurrence
   time;
5. the C3.1-style RLS, facility integrity, grants, retention binding, and
   cross-tenant tests;
6. C6.1-A as substrate plus I10 only; and
7. rebase, migration-number derivation, and Prisma regeneration only after
   #660 merges.
