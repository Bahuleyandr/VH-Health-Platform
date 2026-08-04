# C5.2 paper back-entry correctness — design delta

**Status:** Step 1 design delta and Step-0 preflight only; implementation is
queued and not authorized

**Branch:** `feat/continuity-c52-correctness`

**Live authority re-fetched:** `github/main` at
`10c4a3a66a32d2aa5bf23041d2de3737e59365bd` on 2026-08-05

**Activation state:** C5.2 remains inert. The compile-time
`CLINICAL_CONTINUITY_C_D14_APPROVED = false` guard makes the reconciliation
surface return 503 before any facility can use it
(`apps/backend/src/config/downtimeConfig.js:39,70-85`;
`apps/backend/src/middleware/clinicalContinuityReconciliationMiddleware.js:10-18`).
These are pre-activation correctness defects, not a claim of live exposure.

**Merge instruction:** never merge this lane. This document authorizes no
implementation, migration, deployment, packet issue, webhook release, paper
reconciliation, or activation.

## 0. Step-0 preflight

### 0.1 Live verdict

| Check | Live result | Step-1 ruling |
|---|---|---|
| Baseline | Re-fetched `github/main` is `10c4a3a66a32d2aa5bf23041d2de3737e59365bd` | Design authority only |
| C5.2 exposure | The hardcoded C-D14 approval constant remains false and the reconciliation middleware returns 503 | Pre-activation defects; do not lift the guard in this train |
| Committed migration ceiling | `624_clinical_continuity_held_message_release.sql` | No new number is reserved |
| PR #737 | Open at `e2f39071dbdd4ec763b0cec2e80f6488a72b4d96`; it now owns `625_hl7_outbound_contiguity_ledger_version.sql` | Wait for its renumbered migration to land, then re-fetch |
| Packet BV predecessor | The refreshed activation tracker still marks Packet BV open for owner-audited activation commands, a completable clinician channel, and recovery observability; no BV implementation branch or PR is named in the repository | Wait for the coordinator to identify and clear the BV build; do not equate BV with another open PR |
| Policy-value remediation | PR #739, `fix/continuity-pin-countersigned-values`, remains open at `47f5500f84efb2663050a7971b344af110277b0d` and owns policy/configuration surfaces Part C must consume | Wait or obtain an explicit post-rebase non-overlap ruling; this is separate from Packet BV |
| Device-loss predecessor | Draft PR #741 is design-only at `c695b9d6ce6e559ff9dc150efa5ab8b5b766717c` and records a DDL/state-owner stop | This build remains behind the coordinator's device-loss gate and its eventual migration/Prisma ownership |
| Held-release composition | PR #733 is merged; migration 624 and the closed request schema admit I04, I05, and I19 only | I18 remains deliberately non-releaseable through that executor |
| Expiry precedent | PR #736 is merged; a printed artifact and its stored expiry use one instant, visibly say `NOT VALID AFTER`, and missing/unreadable expiry fails closed | Incident packets inherit this discipline, not an invented duration |
| Step-1 overlap | This branch adds one document only | Safe to commit without entering any occupied runtime lane |
| Build readiness | #737, Packet BV, device-loss, and the policy-value remediation are not all settled; packet issuer/custodian and packet validity values are not countersigned | **WAIT — no Step 2 implementation** |

The migration verdict for the later train is **non-zero but not allocatable**.
The webhook correction and incident-packet provisioning need additive DDL and
Prisma regeneration. The MAR correction is expected to need no DDL, but that
is a pre-write assertion, not permission to claim a number. At each build
kickoff the lane re-fetches `github/main`, verifies the named predecessors,
lists the committed and open migration owners, and derives the next free
number. This delta does not call the next numbers 626 or 627.

### 0.2 Step-2 stop conditions

No runtime edit begins until all of the following are recorded against the
then-current main SHA:

1. PR #737 has landed with its final migration number and Prisma shape.
2. The coordinator has identified Packet BV's implementation authority and
   confirmed that its activation-command, clinician-channel, observability,
   migration, Prisma, and shared-service ownership has landed. The tracker
   label is not permission to infer a branch or collapse BV into this train.
3. PR #739 or its superseding policy-value remediation has landed. Packet
   provisioning must consume the corrected signed-policy parser rather than
   race or copy its values.
4. The coordinator's device-loss predecessor has landed or supplied an explicit
   non-overlap ruling, including its final DDL, Prisma, signer, Admin, and
   OpenAPI ownership.
5. The migration ceiling and every open migration-owning PR have been
   re-inventoried. A number is derived only for the PR that is about to build.
6. C5.2 remains compile-time blocked. No change to
   `CLINICAL_CONTINUITY_C_D14_APPROVED`, no deployment flag, and no policy
   activation joins these correctness PRs.
7. C4.2 still contains exactly the three paper-only action IDs named in section
   2, with their complete action checksums, identity, witness, break-glass,
   conflict-owner, and quarantine-owner contracts unchanged.
8. Migration 620 still owns the I18 subscriber delivery shape and migration 624
   still excludes I18 from held-message release. Any newly landed I18 release
   mechanism returns this design to coordinator review.
9. The exact packet issuer capability, packet custodian capability, validity
   horizon, refresh lead/cycle, and authoritative phone-tree/contact-sheet
   source are countersigned or represented as required signed-policy fields
   with no production default. Missing values must make provisioning
   unavailable; engineering does not choose them.

### 0.3 Step-1 frozen ledger

Step 1 changes exactly:

1. `docs/continuity/c5-2-paper-back-entry-correctness-design-delta.md`.

There is no migration, Prisma regeneration, service, route, controller, OpenAPI
artifact, Staff/Admin UI, test, manifest, activation, deployment, push, PR, or
merge in Step 1.

## 1. Corrective outcome and authority order

All three corrections are required before the C5.2 gate can be considered for
enforcement:

1. paper MAR back-entry must use the same medication-administration mutation
   core and safety guards as the canonical MAR service;
2. a retrospective paper event must become a held subscriber webhook, with one
   typed disposition instead of unread suppression booleans; and
3. a controlled production issuer must be able to create the one-use signed
   incident packet that C-D6 makes the root of incident authority.

The binding authority order is:

1. the countersigned C-D3, C-D5, C-D6, C-D7, C-D8, and C-D10 records in
   [the owner dossier](c0-4-owner-decision-dossier.md);
2. continuity design §5.4, §5.6, and
   [§6.8 shared integrity rules](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md#68-shared-integrity-rules);
3. the landed C4.2 action catalogue and its full checksummed action contracts;
4. the landed C5.1 receipt/effect-evidence authority and C5.2 incident/paper
   workbench;
5. the landed C6.1 event-time/effect-disposition substrate and I18 delivery
   ledger;
6. the merged, deliberately I18-excluding held-message executor from PR #733;
   and
7. the merged `NOT VALID AFTER` artifact discipline from PR #736.

This delta narrows defects in the landed implementation. It creates no second
receipt, action catalogue, MAR ledger, outbox, webhook release path, incident
authority, task engine, audit engine, or signing bypass.

## 2. Part A — MAR back-entry and C4.2 paper-schema parity

### 2.1 Verified defect

`applyRetrospectiveProjectionTx` directly updates
`medication_administrations.status = 'administered'`
(`apps/backend/src/services/downtime/clinicalContinuityReconciliationService.js:1264-1281`).
That path accepts `scheduled`, `due`, or `pending`, writes no
`witness_uid`, and does not execute the canonical MAR sibling-dose guard.

The canonical `marService.recordAdministration` boundary independently
enforces:

- the scan-first/no-scan evidence rule;
- target existence and a closed state transition from `scheduled` or
  `held`;
- a sibling administered-dose check;
- the database unique-race mapping to
  `MAR_DUPLICATE_ADMINISTRATION`;
- explicit tenant scoping;
- witness persistence; and
- atomic canonical MAR timeline/audit recording
  (`apps/backend/src/services/clinical/marService.js:337-457`).

The C4.2 action catalogue also countersigns a witness posture for every paper
action. MAR and specimen collection are
`owner_defined_checker_required`; transfusion requires
`two_distinct_currently_authorized_verifiers`
(`apps/backend/src/config/clinicalContinuityActionCatalog.js:198-258`).
The current paper schemas are defined independently and MAR/specimen carry no
checker fields
(`apps/backend/src/validators/clinicalContinuityPaperSchemas.js:18-75`).

### 2.2 Ruling: one transaction-capable MAR mutation core

The build extracts a named transaction-capable medication-administration core
inside the MAR domain and makes both callers use it:

- the ordinary online `recordAdministration` wrapper keeps its current route,
  scan/no-scan policy, current-time behavior, response, logger, and canonical
  `mar.administered` event; and
- the C5.2 adapter passes its existing tenant/facility transaction, paper
  occurrence time, original actor, required checker evidence, and the fixed
  mode `retrospective_paper_back_entry`.

Calling the current public wrapper unchanged is rejected because it opens its
own tenant transaction, uses `NOW()`, and emits the live canonical MAR event.
That would either break the C5.1 nine-effect atomic transaction or duplicate
the C5.2 retrospective timeline/audit/outbox evidence. The shared core owns the
detail-row inspection and mutation only; each wrapper owns its correct
canonical effect.

The core must:

1. require an explicit transaction handle and tenant ID;
2. lock the exact tenant-scoped MAR row `FOR UPDATE`;
3. require patient identity equality and resolve the catalogue-required
   admission/encounter identity server-side from the MAR/admission graph;
4. accept only the canonical source states. C5.2 must not retain its broader
   `due`/`pending` allowance unless the MAR domain first makes those states
   canonical under a separately reviewed change;
5. run the sibling patient/medication/scheduled-slot duplicate check inside the
   same transaction;
6. retain the migration-327 unique constraint as the concurrency backstop and
   map SQLSTATE 23505 to `MAR_DUPLICATE_ADMINISTRATION`;
7. require and persist the checker/witness contract selected by the exact C4.2
   catalogue entry;
8. distinguish the paper mode from an online barcode scan. Paper evidence is a
   governed retrospective alternative, not a fabricated scan and not a
   caller-controlled generic override;
9. write the physical `occurred_at` as `administered_at` only in the closed
   paper mode; and
10. return the locked before/after projection so the C5.2 wrapper can create
    its one retrospective fact, timeline, audit, outbox, effect evidence, and
    terminal receipt.

No live medication administration, scan handler, scheduling action, CDS
override, or re-administration is invoked by paper back-entry.

### 2.3 Closed paper-to-catalogue assertion

The build adds an unconditional boot assertion and focused unit assertion for
the exact three-entry paper map. It compares each paper schema with
`CLINICAL_CONTINUITY_ACTIONS_BY_ID[actionId]`; it does not merely compare a
duplicated list of names.

| Action ID | C4.2 assertion | Paper-schema obligation |
|---|---|---|
| `mar.administration.backfill` | `paper_only_backfill`, physical action, no electronic binding, generic MAR replay denied, exact required identities, checker required, override-bearing electronic action blocked | Exact MAR/patient/admission/incident/paper identity; original actor; distinct checker UID and role; occurrence and evidence; checker evidence included in the receipt fingerprint |
| `lab.specimen_collection.backfill` | `paper_only_backfill`, physical action, no electronic binding, generic specimen replay denied, exact required identities, checker required | Exact investigation/specimen/patient/incident/paper identity; original collector; checker UID and role; occurrence and evidence; checker evidence included in the receipt fingerprint |
| `blood.transfusion_verification.backfill` | `paper_only_backfill`, physical action, no electronic binding, generic transfusion replay denied, two distinct currently authorized verifiers | Existing two verifier UIDs plus exact match booleans and unit identity; both verifiers distinct and currently authorized at reconciliation; full verifier contract in the receipt fingerprint |

For every entry the assertion also pins:

- action version and full action checksum;
- C-D3 approval evidence;
- capture-ready false and `actionSchema.id = 'none'` on the electronic C4.2
  boundary;
- required identity set;
- witness and break-glass posture;
- conflict and quarantine owner; and
- absence from executable C4.2 replay bindings.

The paper schema remains a dedicated C5.2 schema with its own ID, version, and
checksum. The assertion proves that this schema satisfies the countersigned
C4.2 paper contract; it must not populate C4.2's electronic
`actionSchema` field or make the action queueable. A missing entry, checksum
drift, weaker identity, weaker witness posture, changed owner, unexpected
binding, or extra paper action fails boot and the tests by action ID.

### 2.4 Atomic outcome and conflicts

The existing C5.1/C5.2 transaction order remains authoritative. The shared MAR
core runs only after receipt claim and authorization rechecks and before the
retrospective fact/effect evidence is sealed. Any MAR state, identity, sibling,
witness, unique-race, canonical-write, audit, outbox, or receipt failure rolls
the whole transaction back.

A current electronic-state conflict becomes the existing owned
`needs_review` outcome. It never broadens the source states, overwrites a
different administered dose, or makes a second receipt identity.

## 3. Part B — typed retrospective disposition to held I18 delivery

### 3.1 Verified defect

The paper transaction emits
`clinical_continuity.paper_fact.recorded` with three payload booleans:
`suppress_sla_breach_alarm`, `suppress_care_pathway_transition`, and
`suppress_patient_notification`
(`apps/backend/src/services/downtime/clinicalContinuityReconciliationService.js:1821-1842`).
No production reader consumes those keys.

`publishEvent` persists `recovery_effect_disposition` only as part of the
all-or-none recovery-inbox contract
(`apps/backend/src/services/events/eventOutboxService.js:137-184`).
Migration 603 requires the disposition, recovery inbox, and recovery
fingerprint together, and the composite foreign key points at
`pathway_projector_inbox`
(`apps/backend/src/migrations/603_external_interface_recovery.sql:683-717`).
A paper fact has no projector-inbox row, so its typed provenance columns are
currently null.

The event-outbox fan-out then inserts subscriber deliveries without selecting
or mapping the source disposition
(`apps/backend/src/services/events/eventOutboxService.js:305-359`).
Migration 620 defaults the resulting row to
`send_authority = 'live_authorized'` and `effect_disposition = 'live'`;
its recovery-shape check permits a held row only when an I18 recovery inbox and
owner evidence are already present
(`apps/backend/src/migrations/620_subscriber_webhook_recovery.sql:92-230`).
The drain correctly claims only `live_authorized` rows
(`apps/backend/src/services/integrations/webhookDeliveryService.js:343-380`);
the defect is that fan-out creates the paper delivery with that authority.

### 3.2 One typed source disposition

The build makes `event_outbox.recovery_effect_disposition` the single typed
reader contract for this retrospective event while preserving the fact that it
has no interface-recovery inbox.

The replacement branch in the event-outbox integrity contract is exact:

- `recovery_inbox_id IS NULL`;
- `recovery_fingerprint IS NULL`;
- `recovery_effect_disposition = 'late_pending_only'`;
- `occurred_at_source = 'explicit'`;
- `event_type = 'clinical_continuity.paper_fact.recorded'`; and
- `aggregate_type = 'clinical_continuity_retrospective_fact'`.

A deferred database integrity guard must also prove at commit that the source
belongs to the same tenant, names an existing C5.2 retrospective fact, and is
the outbox row referenced by the corresponding C5.1 effect evidence. This
prevents a raw caller from obtaining the provenance-less late branch merely by
copying the event-type string.

`publishEvent` receives a closed server-owned non-inbox disposition input. It
accepts only `late_pending_only` for the exact paper event shape. It does not
accept client authority, `signed_exception`, an arbitrary event type, or an
incomplete recovery-inbox tuple through this seam.

The three unread `suppress_*` payload fields are deleted. Downstream
projectors and fan-out read the typed disposition. There is one authority, so a
boolean cannot drift from the database value.

### 3.3 Held webhook fan-out

`completeClaimedEventFanout` selects the source
`recovery_effect_disposition` and maps it explicitly:

| Source outbox disposition | Delivery authority | Delivery disposition | Retry state |
|---|---|---|---|
| null or `normal` | `live_authorized` | `live` | current due behavior |
| `signed_exception` with its complete landed recovery provenance | current signed-policy behavior | current signed-policy behavior | current signed-policy behavior |
| `late_pending_only` | `held_owner_reconciliation` | `late_pending_only` | `next_retry_at = NULL`, no lease |

Migration 620's recovery-shape constraint is replaced with three explicit
shapes:

1. ordinary live delivery with no recovery evidence;
2. source-held retrospective delivery with no I18 inbox yet, exact event-outbox
   source, held authority, late disposition, no retry time, no lease, and no
   fabricated recovery owner/evidence; and
3. canonical I18 recovery delivery with the existing inbox/owner/evidence
   tuple.

A same-tenant database trigger proves that shape 2's source
`event_outbox.recovery_effect_disposition` is exactly
`late_pending_only`. Raw SQL cannot pair held authority with a live source or
live authority with a late source. Fan-out remains idempotent on
`(tenant_id, event_outbox_id, subscription_id)`.

### 3.4 Mandatory composition with I18 classification

The complete chain is binding:

> A C5.2 paper fact is retrospective, so its event-outbox row carries
> `late_pending_only`. Fan-out therefore creates every matching subscriber
> delivery with `send_authority = 'held_owner_reconciliation'`. Generic
> subscriber webhooks are the I18 family. Migration 620 requires per-subscription
> downstream-effect and acknowledgement classification before owner recovery.
> The merged PR #733 executor accepts only I04, I05, and I19
> (`apps/backend/src/validators/clinicalContinuityHeldReleaseSchemas.js:9,62-63`)
> and therefore refuses I18. Paper-fact subscriber deliveries remain held until
> the separately governed I18 blast-radius classification and release work is
> designed, approved, built, and activated.

This train does **not** add I18 to migration 624, reuse the I04/I05/I19 release
endpoint, call `externalWebhookRecoveryService` as a release shortcut, set
`live_authorized` after a timer, introduce a batch release, or create any new
webhook release route. Unclassified or classified-but-unreleased paper
deliveries remain held.

## 4. Part C — incident-packet provisioning and custody

### 4.1 Verified trust-root gap

Migration 606 defines `clinical_continuity_incident_packets` with a reserved
incident UUID, paper range, signing identity, hash/signature, validity window,
one-use status, and contact-sheet version
(`apps/backend/src/migrations/606_clinical_continuity_paper_reconciliation.sql:14-60`).
Its immutable trigger permits one transition from `unused` to
`used`, `revoked`, or `expired`
(`apps/backend/src/migrations/606_clinical_continuity_paper_reconciliation.sql:1133-1157`).

The declaration service locks and consumes that row, but it only compares the
presented hash/signature strings with the stored row
(`apps/backend/src/services/downtime/clinicalContinuityReconciliationService.js:326-493`).
No production service, controller, route, job, or CLI inserts the packet. The
only inserts at this baseline are migrations/tests. Consequently no
authoritative packet can exist, and C-D6 incident authority cannot be entered.
The refreshed activation tracker records this provisioning/verification gap as
Packet BW and separately keeps BW's paper-range-contiguity and alias-roll-up
defects open
(`docs/continuity/activation-readiness-tracker.md:111-113`). This delta fixes
the provisioning/verification member only; it must not be represented as
closing all of Packet BW or the C5 activation gate.

### 4.2 Who mints

The **server** mints the packet. The browser, Staff app, Admin app, incident
commander, and operator never choose or submit:

- packet ID;
- reserved incident UUID;
- paper-range prefix or bounds;
- validity timestamps;
- contact-sheet content/version;
- policy or key binding;
- canonical payload/hash;
- signature; or
- artifact hash.

A dedicated
`clinicalContinuityIncidentPacketProvisioningService` composes:

1. an explicit tenant/facility transaction;
2. the current active signed continuity policy;
3. a versioned, approved facility phone-tree/role-contact-sheet record;
4. an append-only range allocation;
5. RFC 8785 canonical payload construction;
6. an operator-injected Ed25519 signer using the existing continuity signer
   integration pattern, with the domain-separated purpose
   `vhhealth/continuity/incident-packet/v1`; and
7. a final table-owner-controlled issuance function that creates the complete
   `unused` packet and its audit/custody evidence atomically.

The human requester must have a new signed-policy capability such as
`continuity_incident_packet_issue`; the recipient must have a separate
`continuity_incident_packet_custody` capability. Existing ADMIN,
SUPER_ADMIN, incident-commander, or reconciliation roles do not acquire either
capability merely because they can declare or reconcile an incident.

**OPEN-QUESTION — packet authority:** the accountable owner must name the
initial issuer and custodian role/capability mappings. There is no production
default. Until the signed policy contains them, the provisioning route returns
a typed unavailable/forbidden result and inserts nothing. This is an
implementation-time provisioning input, not a reopening of the completed C0
owner dossier.

### 4.3 Required durable model

The final build may adjust names to landed conventions, but it must preserve
these state planes:

1. **Versioned contact sheet.** An append-only tenant/facility record contains
   the exact role contacts, independent phone/messaging channels, approval
   evidence, canonical checksum, effective window, and version. A packet pins
   its ID/version/checksum; a caller-supplied version string is not authority.
2. **Range allocation.** An append-only allocation/request record reserves a
   disjoint range and unused incident UUID before the external signing call.
   Database exclusion/uniqueness prevents overlap and reuse. A failed signing
   request becomes terminal `void`; its UUID and range are never recycled.
3. **Final packet trust root.** The existing packet row is extended or paired
   with immutable schema version, canonical payload, policy
   ID/version/checksum, signing public-key hash, contact-sheet FK/checksum,
   issuer, issued-at, artifact hash, and request identity. A final packet row
   exists only after local signature verification succeeds.
4. **Custody/delivery evidence.** Append-only events record generated,
   downloaded, printed, handed-over, received, replaced, revoked, expired, and
   destroyed outcomes with actor, time, artifact hash, copy identity/count, and
   reason. Mutable packet status remains only the one terminal projection.

The final trust-root insert is not granted directly to
`vhhealth_app` or `vhhealth_runtime`. Direct packet-table INSERT is revoked.
The narrowly granted issuance function requires explicit tenant/facility
context, a live allocation, exact idempotency identity, approved contact-sheet
binding, locally verified signature/key evidence, and an authorized issuer
audit record. It inserts no partial/draft packet.

### 4.4 Mint and issue sequence

One request is idempotent on a stable server command identity bound to tenant,
facility, approved contact-sheet version, signed-policy version, requested
packet purpose, and requester. The sequence is:

1. authenticate the requester and resolve tenant/facility from the signed
   facility context;
2. require the signed issuer capability and active policy;
3. load the exact approved contact-sheet version and owner-supplied validity
   and refresh rules;
4. in a serializable tenant/facility transaction, claim the idempotency
   identity, allocate a never-reused range plus reserved incident UUID, and
   append the allocation audit;
5. outside that transaction, construct canonical bytes, request the external
   Ed25519 signature, render the printable artifact, and verify both signature
   and artifact hash locally;
6. in a second serializable transaction, lock the allocation, recheck policy,
   key, contact sheet, requester, range, and validity, then invoke the guarded
   final issuance function;
7. append the issued audit and initial custody event; and
8. return the exact signed envelope plus an authenticated, no-store artifact
   retrieval reference.

If signing, rendering, local verification, or final recheck fails, no packet
row is inserted. The allocation becomes terminal void evidence and is never
reused. An exact retry returns the prior issued packet or prior terminal
failure; a different fingerprint under the same request identity is a conflict.

### 4.5 Printed and delivered artifact

Every page or physically inseparable cover must show:

- tenant/facility audience and facility-local timezone;
- packet ID and **USE ONCE** warning;
- reserved incident UUID;
- exact paper prefix and first/last number;
- packet schema, policy, contact-sheet, and signing key versions;
- generated/valid-from time;
- the exact signed **NOT VALID AFTER** time;
- the C-D10 phone tree and role contact sheet;
- artifact and canonical-payload SHA-256 values;
- a machine-readable signed envelope for later import; and
- the instruction that missing/unreadable validity or signature means the
  packet is unusable and no identifier may be invented.

The packet contains no patient data. Delivery is a controlled physical-custody
operation: the authorized custodian retrieves the exact hash-pinned artifact,
prints the controlled copy or copies permitted by the signed policy, records
handover/receipt, and stores it at the approved facility location. Email,
screenshots, an unsigned PDF, a copied range list, or a database row without
custody receipt is not a delivered packet.

**OPEN-QUESTION — contact authority:** no versioned phone-tree/contact-sheet
source or approver exists on the baseline. The owner must name that source,
approver, allowed contacts, physical custody locations, and allowed copy count.
The build may create the fail-closed versioned substrate, but it must not seed
real contacts or label an artifact delivered without this authority. This is a
Packet BW provisioning input, not a reopening of the completed C0 owner
dossier.

### 4.6 Use, verification, and one-use consumption

Declaration/import must no longer treat equality with a stored signature string
as sufficient. In the same transaction that consumes the packet it must:

1. lock the exact tenant/facility packet;
2. require `unused`, unrevoked, within `valid_from` and
   `valid_until`, and backed by delivered custody evidence;
3. reconstruct the canonical payload from immutable fields and compare its
   hash with both the stored and presented hash;
4. resolve the pinned current or historical trusted public key, reject revoked
   or wrong-purpose keys, and cryptographically verify Ed25519 signature bytes;
5. require exact policy, contact-sheet, reserved-incident, and range bindings;
6. insert the incident, declaration, in-use paper range, audit, and packet
   `unused -> used` transition atomically; and
7. preserve the existing exact-duplicate and split-brain behavior without
   rewriting history.

Concurrent use permits one consumer. An expired, revoked, replaced, wrong
tenant/facility, undelivered, hash-mismatched, key-mismatched, or already-used
packet creates no incident authority. A later-presented paper identifier from a
lost/revoked range remains evidence routed to `needs_review`; it is never
renumbered or silently accepted.

### 4.7 Expiry and refresh

PR #736 establishes the discipline this packet adopts
(`apps/backend/src/services/downtime/wardDowntimePackService.js:96-110,400-411`;
`docs/DOWNTIME_PROCEDURE.md:24-31`):

- one instant produces the signed `not_valid_after`, stored
  `valid_until`, rendered validity line, artifact metadata, and monitoring
  evidence;
- validity is half-open: usable only while
  `valid_from <= now < valid_until`;
- there is no grace period;
- missing, malformed, unreadable, or clock-uncertain validity is treated as
  expired;
- refresh never updates or extends an issued packet;
- a replacement has a new packet ID, reserved incident UUID, disjoint range,
  current contact-sheet version, new signature, and new custody receipt;
- after replacement custody is confirmed, the superseded unused packet moves
  to terminal `revoked` with a typed replacement reason; and
- an expired/revoked/void/used range and UUID are never reissued.

**OPEN-QUESTION — packet time policy:** C-D10 requires refresh on the packet's
print cycle but supplies no packet validity duration, proactive refresh lead,
or clock-uncertainty rule. Those exact values must come from countersigned
policy. The service has no numeric fallback, and missing values block mint and
refresh. This delta does not reuse the ward-pack duration or infer a value from
the seven-day replay window. These are Packet BW implementation values, not a
reopening of the completed C0 owner dossier.

If every packet is expired, revoked, used, or undelivered, C-D6 cannot be
entered through software. No direct SQL, newly generated incident UUID,
unsigned printout, expired-packet override, or generic break-glass path replaces
it.

## 5. Shared §6.8, RLS, raw-PostgreSQL, and API rails

### 5.1 Database integrity and RLS

Every added or altered continuity relation follows design §6.8:

- UUID primary identities and immutable tenant/facility ownership;
- exact same-tenant and same-facility foreign keys with intentional
  `ON DELETE RESTRICT/NO ACTION`;
- database checks for closed enums, all-null/all-present groups, time ordering,
  terminality, actor separation, and range bounds;
- exclusion or unique constraints for incident UUIDs, ranges, idempotency
  identities, packet artifacts, and source-held webhook deliveries;
- append-only triggers for allocation, signature, contact-sheet, custody,
  audit, and replacement evidence;
- no mutable JSON as the sole clinical, signature, custody, or authorization
  fact;
- ENABLE and FORCE RLS;
- the restrictive explicit tenant/facility-context pattern, where unset,
  empty, malformed, `bypass`, wrong-tenant, or wrong-facility context matches
  no row;
- least-privilege grants with no PUBLIC privilege and no table-owner/BYPASSRLS
  runtime escape;
- tenant/facility-pinned worker transactions; and
- explicit retention and non-reuse behavior.

Altering already-recorded migrations 603, 606, or 620 is prohibited. Later
migrations replace named constraints/triggers additively on upgraded and fresh
databases, and Prisma is regenerated from the fully migrated schema.

### 5.2 Mandatory raw-PostgreSQL negatives

The build receipts include direct PostgreSQL tests, not only mocked services:

- unset, empty, `bypass`, wrong-tenant, and wrong-facility RLS contexts;
- direct runtime INSERT into the incident-packet trust root;
- overlapping/reused range and incident UUID allocation;
- final issue without live allocation, trusted key, approved contact sheet,
  exact signature/hash, issuer audit, or validity;
- update of immutable signed/custody fields;
- second terminal packet transition and delete/truncate;
- declaration with used, revoked, expired, undelivered, wrong-key, wrong-hash,
  wrong-tenant, or wrong-facility packet;
- source-held webhook delivery backed by a live/null source disposition;
- live-authorized webhook delivery backed by
  `late_pending_only`;
- late outbox disposition without the matching C5.2 fact and C5.1 effect
  evidence;
- direct release/rearm of a held I18 delivery; and
- cross-tenant/cross-facility joins through guessed IDs.

Each negative asserts SQLSTATE/constraint identity and zero unauthorized side
effects.

### 5.3 Both OpenAPI mirrors are one artifact

Any PR that changes a paper request schema or adds packet provisioning/custody
routes changes the generator source and regenerates the canonical
`apps/backend/src/docs/openapi.json`. In that same commit it runs
`npm --prefix apps/backend run openapi:sync-core` and stages
`packages/vhhealth_core/swagger/openapi.json`.

The two files must be byte-identical. They are one generated contract artifact,
not two independently edited ledgers. From the repository root, required gates
are:

```text
npm --prefix apps/backend run openapi:generate
npm --prefix apps/backend run openapi:sync-core
npm --prefix apps/backend run openapi:check
npm --prefix apps/backend run openapi:check-core
```

With the backend dependencies installed, the canonical Spectral gates run from
`apps/backend`, matching the backend CI working directory:

```text
npx spectral lint src/docs/openapi.json
npm run openapi:lint-budget
```

No PR may contain only one mirror, hand-edit either generated file, or defer the
core mirror to a later PR.

## 6. Proposed PR train

The three corrections should not be collapsed into one review surface.

### PR A — paper action contract and MAR core

Expected responsibility:

- shared transaction-capable MAR mutation core and ordinary MAR wrapper;
- C5.2 MAR adapter;
- all three paper schemas and the unconditional C4.2 parity assertion;
- receipt-fingerprint/version changes required by checker evidence;
- paper request OpenAPI generator source plus both byte-identical mirrors; and
- unit, service, transaction, duplicate-race, witness, and catalog-drift tests.

Expected DDL/Prisma change: **zero**. Any discovered schema need stops PR A
before writing a migration and returns to the coordinator.

### PR B — retrospective outbox to held subscriber delivery

Expected responsibility:

- one freshly derived migration replacing the event-outbox and migration-620
  constraints/triggers;
- Prisma regeneration;
- C5.2 typed outbox disposition and deletion of unread `suppress_*` flags;
- event-outbox fan-out mapping;
- webhook-delivery source integrity;
- explicit I18 non-release composition tests; and
- fresh-DB, upgraded-DB, RLS, raw-PG, drain, no-network-send, and idempotent
  fan-out receipts.

PR B follows PR A because both touch the C5.2 paper service. It does not add or
change an API route, so it should not create OpenAPI churn.

### PR C — incident-packet provision, delivery, and refresh

Expected responsibility:

- one later freshly derived migration for allocation, contact-sheet,
  packet-trust, and custody evidence;
- Prisma regeneration;
- guarded provisioning service and table-owner issuance function;
- external-signer/local-verification adapter;
- cryptographic declaration verification;
- typed provisioning, list/artifact, custody, replacement, and revoke routes;
- minimal Admin/operator surface required to request and attest custody;
- OpenAPI generator source plus both byte-identical mirrors;
- printable artifact renderer and hash/validity tests; and
- issuer/custodian, two-phase failure, expiry, refresh, custody, RLS, raw-PG,
  concurrency, and declaration drills.

PR C follows PR B so migration, Prisma, C5.2 service, Admin, and OpenAPI
ownership is serial. Each PR re-fetches main and carries a frozen file ledger.
No proposed PR is merged, stacked onto an unlanded migration by guess, or used
as activation authority by this document.

## 7. Required build and Gate evidence

### 7.1 PR A

- exact three-action catalogue/schema assertion and unknown/extra-action denial;
- action checksum, identity, witness, break-glass, owner, and binding drift
  failures;
- MAR source-state parity with the canonical service;
- patient/admission/tenant mismatch, sibling duplicate, migration-327 race,
  missing/same-person checker, and current-state conflict;
- ordinary online MAR behavior unchanged;
- retrospective occurrence time preserved without a live scan or live
  canonical MAR double event;
- C5.1 receipt/fact/timeline/audit/outbox rollback fault injection; and
- both OpenAPI mirrors byte-identical.

### 7.2 PR B

- fresh apply, upgraded apply, migration rerun, Prisma validation, schema drift,
  RLS, grants, constraint names, and raw-PG negatives;
- zero, one, and multiple matching subscriptions;
- exact duplicate fan-out creates no duplicate delivery;
- paper fact creates a typed late outbox row and only held deliveries;
- held deliveries have no retry time/lease and are never claimed or sent;
- live and fully governed signed-exception events retain their intended
  behavior;
- all three `suppress_*` payload fields absent and no production reader
  expected;
- I18 classification values copied from the subscription without authorizing
  release;
- the PR #733 schema/service/migration still refuse I18; and
- no network call under the paper-fact test, including scheduler/drain runs.

### 7.3 PR C

- exact canonical bytes, SHA-256, Ed25519 signature, key purpose/version,
  policy, contact-sheet, range, and artifact binding;
- signer timeout/error/invalid signature and crash between both transactions;
- idempotent retry and same-key/different-fingerprint conflict;
- disjoint allocation under concurrency and permanent void/non-reuse;
- direct runtime DML denial plus all §5.2 raw-PG negatives;
- artifact generation and stored expiry use one instant;
- visible `NOT VALID AFTER` on every printable packet;
- missing/malformed/expired/clock-uncertain packet fails closed;
- controlled delivery/custody receipt, replacement-before-revocation, and
  contact-sheet refresh;
- cryptographic declaration verification, concurrent one-use, exact duplicate,
  split brain, lost/revoked/expired range, and no-history-rewrite;
- route authorization, PHI/security logging, no-store responses, SSRF/file
  safety where applicable, and typed error envelopes;
- both OpenAPI mirrors byte-identical; and
- no C-D14 gate, deployment flag, facility policy, packet, contact seed, or
  production activation changed by the build.

Every DDL PR also runs the canonical disposable-PostgreSQL suite, schema-drift
check, backend lint/raw-parameter lint, focused unit/deep tests, full backend
shards, and repository canonical CI. Pending CI is reported as pending, not
passing.

## 8. Rollback and non-goals

Rollback disables new packet provisioning/custody writes and restores the prior
paper/webhook code only if doing so cannot make a committed
`late_pending_only` delivery live. It never:

- deletes or rewrites packets, allocations, ranges, custody, declarations,
  paper facts, receipts, effect evidence, audit, timeline, outbox, or webhook
  delivery history;
- reuses a void, expired, revoked, used, or replaced UUID/range;
- changes a held I18 delivery to live authority;
- fabricates a missing packet or contact sheet;
- reopens a C5.1 receipt;
- broadens the C4.2 electronic binding set; or
- lifts C-D14, deploys, activates, or merges.

This delta does not define the missing owner values, design paper stationery,
authorize real phone numbers/contacts, choose physical custody locations,
classify any I18 subscription's blast radius, create an I18 release executor,
change MAR bedside policy, make paper actions electronically queueable, or
claim C5.2 production readiness.

Step 1 verdict remains **WAIT**. The committed design is the only authorized
output until the named predecessors and owner stop lines are cleared and the
coordinator supplies Step 2 GO against a newly re-fetched main SHA.
