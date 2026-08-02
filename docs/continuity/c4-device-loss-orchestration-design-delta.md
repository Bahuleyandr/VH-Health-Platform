# C4 unified device-loss orchestration design delta

**Status:** Step 1 design delta and Step-0 stop report. Backend implementation
is **NO-GO** from the verified baseline because the assumed signed wipe-order
lifecycle does not exist and the required durable operation/order state is not
represented by an existing domain table. This document does not authorize a
migration, client work, activation, deployment, or merge.

**Repository baseline:** `31f2365ef80821f37c418e900fce15b0c4ae5f6b`

**Baseline commit time:** `2026-08-02T15:19:41+05:30`

**Branch:** `feat/continuity-device-loss-orchestration`

**Scope inspected:** `apps/backend`, the generated OpenAPI pipeline,
`apps/admin` as the named consumer, the Staff C3.3 cache implementation, and
the controlling continuity records. No runtime source, OpenAPI, Prisma, Admin,
Staff, activation, or deployment file is changed by this Step 1 lane.

## 1. Outcome first

The requested zero-DDL composition cannot be built truthfully from `main`.
C3.3 provides only an idempotent local cache-wipe primitive. It does not mint,
sign, persist, deliver, authenticate, consume, or receipt a wipe order, and no
Staff or backend caller invokes that primitive. The existing forced-session
revocation listener preserves offline rows and signs out; it does not inspect
or execute a wipe command. The runbook accurately calls the order lifecycle an
external control, not a landed repository capability.

The backend also has no durable device-loss operation that can bind one
idempotency identity to all step outcomes, retain a pending signed order until
next contact, link delivery/execution receipts, or arm future replays from the
lost device for C-D6 `needs_review` routing. Reusing a generic audit JSON field
as the authoritative command queue would invent an unconstrained workflow in
an evidence sink and is rejected by this delta.

Therefore:

- **DDL/Prisma verdict:** **NON-ZERO / STOP**. A purpose-built durable
  operation/order lifecycle, with append-only step events or equivalent
  constrained evidence, requires a migration and Prisma regeneration unless
  the coordinator supplies a separately reviewed external device-management
  system as the authoritative order store and receipt source.
- **Client/external-control verdict:** **STOP**. A next-contact consumer is
  absent from the repository. The `no client changes` non-goal is compatible
  only if an already deployed external device-management control is named,
  contracted, and proved; none is configured or callable on this baseline.
- **Build-queue verdict:** do not queue backend, OpenAPI, or Admin
  implementation from this document. The coordinator must first rule on the
  state owner, the next-contact consumer, and the migration conflict described
  in Section 3.

This is an implementation stop, not a change to C-D10, C-D14, or C-D15.

## 2. Controlling authority and verified live delta

### 2.1 Countersigned policy remains unchanged

The binding policy is complete and internally consistent:

- C-D10 requires immediate grant and session revocation, a signed governed
  wipe order that executes at next contact, no more than 24 hours of residual
  offline-pack access, and preservation of unsynced captured work as
  `needs_review` for the C-D6 fallback reconciliation principal
  (`docs/continuity/c0-4-owner-decision-dossier.md:210-230`).
- C-D6 fixes the fallback principal as tenant-configured
  `role:clinical_safety_lead`, resolved to a named person at reconciliation
  time and never defaulted in production
  (`docs/continuity/c0-4-owner-decision-dossier.md:134-143`).
- C-D7 forbids silent deletion and keeps forced/server revocation
  preservation semantics intact
  (`docs/continuity/c0-4-owner-decision-dossier.md:145-171`).
- C-D14 assigns device lifecycle duties to IT/security and temporarily maps
  the Admin surface to `SUPER_ADMIN` only
  (`docs/continuity/c0-4-owner-decision-dossier.md:305-338`).
- C-D15 requires the live deprovisioning enumeration and preserves named
  break-glass accounts from automatic identity deprovisioning
  (`docs/continuity/c0-4-owner-decision-dossier.md:340-356`).

This delta changes none of those values.

### 2.2 Existing backend actions that are reusable

| Duty | Verified reusable code | Exact boundary |
| --- | --- | --- |
| Capture-grant revocation | `revokeClinicalContinuityFacilityGrant` in `apps/backend/src/services/downtime/clinicalContinuityFacilityContextService.js:601-669` | Appends a capture-purpose revocation inside a tenant transaction. It rejects an already-revoked row, so the orchestration must enumerate only active rows before invoking it. |
| C3 `edge_read` revocation | `revokeContinuityEdgeGrant` in `apps/backend/src/services/downtime/continuityEdgeAccessService.js:349-428` | Appends the existing immutable revocation and returns the same row only when actor and reason match. It already has service-level idempotent replay semantics. |
| User/staff session, PIN, biometric, and staff-device shut-off | `deactivateIdentity` in `apps/backend/src/services/auth/scimProvisioningService.js:501-540` | This private helper deletes `user_active_sessions` and `staff_auth_sessions`, clears PINs, disables biometrics, disables staff devices, and calls the shared token revoker. It returns `excluded_break_glass` without mutation for a named break-glass account. The helper must be extracted/exported and reused; its SQL must not be copied into a new service. |
| Token revoke-all request | `revokeAllUserTokens` in `apps/backend/src/utils/tokenBlacklist.js:118-142` | Tries Redis, swallows Redis failure, schedules the DB marker with `setImmediate`, swallows DB failure, and returns no durable receipt. It can be invoked, but its current return value cannot prove completion. The shared service needs evidence-bearing completion semantics before a device-loss response may label this step `completed`. |
| Canonical signing seam | the injected continuity signer and canonical Ed25519 envelope construction in `apps/backend/src/services/downtime/clinicalContinuityFacilityContextService.js:182-205` and `:393-427` | This can sign canonical content under the active continuity key. It is not a wipe-order issuer and provides no storage, delivery, consumer, or receipt lifecycle. |
| Replay device identity | the canonical replay envelope carries and verifies `device_id` in `apps/backend/src/validators/clinicalContinuityReplayEnvelope.js:14-49` and `:291-308` | A future backend guard can recognize work arriving from a lost device without changing the replay envelope. No landed guard currently consults a device-loss operation. |
| Reconciliation ownership | `loadConfigTx` and the reconciliation assignment path in `apps/backend/src/services/downtime/clinicalContinuityReconciliationService.js:199-310` | Missing configuration already fails closed with `CONTINUITY_RECONCILIATION_CONFIG_REQUIRED`. The insertion helper is private and is row/incident oriented, not a standing lost-device routing order. |
| Lost-device high-water evidence | `recordClinicalContinuityDeviceOffset` in `apps/backend/src/services/downtime/clinicalContinuityReconciliationService.js:2254-2375` | Requires a facility, declared continuity incident, required high-water mark, and version. It can record `lost_assigned`, but cannot represent a general security incident or unknown unsynced rows by itself. |
| Append-only audit evidence | `recordClinicalAuditEvent` in `apps/backend/src/services/clinical/canonicalClinicalPlatformService.js:489-559` | Provides a hash-chain-capable, idempotent append-only evidence sink. It is suitable for evidence after a domain action, not as an unconstrained pending-command/order projection. |

Every implementation must call or minimally refactor these exact services. A
new orchestration service must not reproduce their SQL or policy decisions.

### 2.3 The assumed wipe-order machinery is absent

C3.3 explicitly says that its slice exposes a governed wipe primitive but does
not define or activate a remote-wipe policy
(`docs/continuity/c3-3-staff-cache-design-delta.md:64-66`). Its device-loss
section says the owning device-management path must already authenticate the
command and that C3.3 does not define delivery
(`docs/continuity/c3-3-staff-cache-design-delta.md:351-362`).

The code matches that narrower claim:

- `ClinicalContinuityCache.wipeFacility` and `.wipeDevice` delete the verified
  cache, keys, and rollback witnesses and verify absence
  (`packages/vhhealth_core/lib/services/clinical_continuity_cache.dart:529-598`).
- `StaffContinuityRepository.governedWipeFacility` and
  `.governedWipeDevice` merely delegate to those primitives
  (`apps/staff/lib/features/clinical_continuity/services/staff_continuity_repository.dart:303-314`).
- There are no production callers of either governed wipe method.
- The Staff session-revocation listener consumes only `session:revoked`, runs
  the preservation-oriented forced logout, and ignores the event payload
  (`apps/staff/lib/core/widgets/session_revocation_listener.dart:3-6` and
  `:62-93`).
- No backend service, route, configuration, migration, Prisma model, or OpenAPI
  operation contains a wipe-order lifecycle.

The existing operator runbook is therefore accurate: signed-order issuance,
delivery, execution, and receipts live “elsewhere,” and no landed
facility-context endpoint performs them
(`docs/continuity/c4-device-loss-operator-runbook.md:85-104`).

## 3. Step-0 DDL and overlap verdict

### 3.1 Why this is not a zero-DDL composition

The immediate grant and relational session/device mutations can compose
existing services. The operation as a whole cannot converge without durable
state for at least these identities and facts:

1. one tenant-scoped operation ID bound to the HTTP idempotency key, request
   hash, exact stable device UUID, incident reference, reason, actor, and
   affected Staff subjects;
2. one immutable canonical wipe order ID, content hash, signing key ID,
   signature, issue time, and issuance result;
3. append-only delivery, execution, failure, and retry evidence, including
   which device credential authenticated the receipt;
4. the standing `needs_review` routing instruction that is consulted when a
   previously unknown unsynced envelope later arrives from that device; and
5. per-step attempt/result evidence that supports a new idempotency key
   converging on the already-open operation rather than issuing a second order.

No existing domain row has that shape. In particular:

- `staff_devices` contains active/PIN/biometric fields but no order or receipt
  lifecycle (`apps/backend/prisma/schema.prisma:9217-9241`);
- `user_devices` contains the current facility-context projection but no
  device-loss/order lifecycle (`apps/backend/prisma/schema.prisma:10929-10967`);
- capture/edge revocations are grant-specific and cannot represent a device
  operation, signed order, or execution receipt
  (`apps/backend/prisma/schema.prisma:25423-25495`);
- reconciliation device offsets require a declared continuity incident and a
  known high-water requirement; a general loss report supplies neither; and
- `clinical_audit_events` has useful evidence fields and a unique idempotency
  key, but JSON metadata has no device/order FKs, lifecycle constraints,
  delivery/execution uniqueness, or authoritative current-state projection.

Treating `clinical_audit_events` as both evidence and a command queue would
silently turn a generic retained sink into the device-control source of truth.
That is a new architecture, not composition of existing actions. This delta
does not authorize it.

The minimum acceptable next design is a purpose-built, tenant-scoped durable
operation/order projection plus append-only step/receipt evidence, or a proved
external device-management system that owns the same state and exposes signed
request/receipt contracts. The former is DDL plus Prisma; the latter is a new
external integration and remains outside the stated evidence on `main`.

### 3.2 Live open-PR overlap

At the final baseline fetch, GitHub had one open PR. PRs #691 and #692 merged
while this delta was being written, so the lane was fast-forwarded and the code
anchors were re-derived against their merge commits before this report was
committed.

| Lane | Live files | Overlap verdict |
| --- | --- | --- |
| Merged PR #691, `fix/dart2js-int64-governance-ceiling` | `packages/vhhealth_core` continuity verification/cache tests and implementation, now included in this baseline | No file overlap with this design document. A later client-consumer change would enter the same package but now starts after #691. |
| Merged PR #692, `docs/backend-rls-autowrap-contract` | `apps/backend/CLAUDE.md`, `docs/SYSTEM-ARCHITECTURE.md`, now included in this baseline | No file overlap with this design document. A later backend build must inherit the corrected RLS contract rather than the stale claim now removed on this baseline. |
| PR #693, `fix/lab-notification-third-result-cleanup` | `apps/backend/src/tests/lab-result-ready-notification.test.js` | No file or domain overlap. |

Sol’s live `feat/continuity-c6-1d-notification-recovery` worktree is based at
`31f2365ef80821f37c418e900fce15b0c4ae5f6b` and has uncommitted notification
delivery/recovery work. It currently adds
`apps/backend/src/migrations/609_notification_delivery_recovery.sql` and
modifies `apps/backend/prisma/schema.prisma`, plus notification-specific
services, utilities, tests, seed data, scheduler, and the external-interface
recovery catalog.

The runtime domains are disjoint, but the present device-loss verdict is not
zero-DDL: both lanes would own migration slot `609` and Prisma regeneration.
They therefore **must not build in parallel under the zero-DDL exception**.
The coordinator must let C6.1-D settle and then allocate the next migration, or
must supply a reviewed zero-DDL/external state owner before this lane resumes.

## 4. Target endpoint contract, contingent on clearing the stop

This section fixes the intended backend boundary so the missing state and
consumer cannot be bypassed by a smaller, misleading implementation.

### 4.1 Route and authorization

The single operator action is:

```text
POST /api/v1/admin/devices/continuity-device-loss
Idempotency-Key: <required 1..200 character key>
```

The route lives under the existing Admin device router but carries an explicit
`requireRole('SUPER_ADMIN')` gate in addition to the Admin parent middleware.
The broader `requireManage` helper used by existing device routes is not
sufficient because it admits roles beyond the countersigned C-D14 portal
mapping (`apps/backend/src/routes/admin/deviceRegistryRoutes.js:29-36`).

The existing required idempotency middleware must be mounted with a dedicated
scope such as `continuity-device-loss`; missing or malformed keys fail before
the service runs. Its same-key/same-body replay, in-flight rejection, and
same-key/different-body rejection remain authoritative.

### 4.2 Request

```json
{
  "stable_device_id": "uuid",
  "affected_staff_uids": ["uuid"],
  "incident_reference": "security/continuity incident reference",
  "reason": "loss or theft reason"
}
```

Rules:

- `stable_device_id` is the exact server-proved UUID. FCM tokens, browser IDs,
  hostnames, friendly names, and clinical `device_registry` rows are forbidden
  aliases.
- `affected_staff_uids` is explicit because C-D15 revocation is identity-wide,
  while one shared device may have more than one Staff subject. The server
  proves every supplied UID belongs to the tenant and has authoritative device
  association or grant evidence. Ambiguous, missing, or contradictory subject
  scope fails closed before mutation.
- An empty subject array is permitted only for a proved fixed-device grant with
  no Staff identity. The identity-revocation step then reports `not_applicable`.
- `incident_reference` binds every step and receipt. It is not silently cast to
  a C5.2 continuity incident UUID.
- `reason` is immutable evidence and uses the existing 1..500 printable
  character rule.

### 4.3 Typed response

The response never collapses the action to a boolean. It returns one immutable
operation identity and ordered step evidence:

```json
{
  "operation_id": "uuid",
  "state": "immediate_steps_complete|incomplete_retryable|awaiting_device_contact|executed",
  "stable_device_id": "uuid",
  "incident_reference": "string",
  "idempotent_replay": false,
  "subjects": [
    {
      "staff_uid": "uuid",
      "break_glass": false,
      "identity_revocation": "completed|excluded_break_glass|retryable_failed"
    }
  ],
  "steps": [
    {
      "name": "capture_grants|edge_read_grants|identity_access|tokens|wipe_order|needs_review_routing|offline_pack_risk",
      "state": "completed|not_applicable|excluded|retryable_failed|awaiting_contact",
      "attempt": 1,
      "evidence_ids": ["string"],
      "error_code": null
    }
  ],
  "wipe_order": {
    "order_id": "uuid",
    "content_hash": "sha256",
    "key_id": "string",
    "signature": "base64",
    "delivery_state": "awaiting_contact|delivered|executed"
  },
  "request_id": "string"
}
```

HTTP `202` is correct when immediate revocation/routing steps succeeded and the
signed order is durably awaiting next contact. HTTP `200` is used for a replay
that returns an already converged operation snapshot or when execution is
already receipted. A failed required immediate step returns the typed operation
with `incomplete_retryable`; it never reports overall success merely because
some revocations committed.

### 4.4 Typed absence

The contract reserves HTTP `503` plus
`CONTINUITY_DEVICE_LOSS_ORCHESTRATION_NOT_ACTIVATED` when the tenant cannot
use the capability. The response includes no operation or mutation evidence.

The predicate cannot be implemented truthfully on this baseline. The existing
facility enrollment gate is a global compile-time/environment gate and still
hard-codes C-D14 approval false
(`apps/backend/src/config/downtimeConfig.js:28-39` and `:68-89`); it is not a
tenant activation projection. The activation tracker separately records that
the tenant/facility/cohort `off|shadow|active` projection is absent
(`docs/continuity/activation-readiness-tracker.md:73`).

The coordinator must choose one of these before build:

1. bind typed absence to the future authoritative tenant activation projection;
2. define this endpoint as activation-independent security containment and use
   typed absence only for missing orchestration state/signer/reconciliation
   capability; or
3. supply another existing tenant-scoped activation authority.

This delta recommends option 2 because lost-device containment should not leave
access live merely because continuity clinical activation is off. That policy
interpretation still requires coordinator/owner confirmation; engineering will
not encode it by guessing.

## 5. Ordered execution and partial-failure semantics

Once the missing state and consumer are authorized, the service follows the
backend Phase 0/1/1.5/2 doctrine.

### Phase 0 — preflight, no mutation

1. validate `SUPER_ADMIN`, tenant, request hash, exact device UUID, incident
   reference, reason, and required HTTP idempotency claim;
2. acquire/load the durable operation identity and reject same-operation scope
   conflicts;
3. enumerate all active capture and `edge_read` grants for the exact tenant and
   device across facilities;
4. prove each supplied Staff subject and read
   `users.is_break_glass_account` under tenant scope;
5. load the C-D6 reconciliation configuration for every affected facility and
   prove `fallback_principal` is configured with no default;
6. prove the continuity signer/current key and next-contact order consumer are
   available; and
7. snapshot signed offline-pack expiry/residual risk without shortening or
   rewriting any pack.

Any failure here produces typed absence, denial, or conflict and performs no
revocation.

### Phase 1 — one serializable database transaction

The following database mutations are atomic together:

1. create or lock the durable device-loss operation;
2. append all active capture-purpose revocations through
   `revokeClinicalContinuityFacilityGrant` using a shared transaction runner;
3. append all active `edge_read` revocations through
   `revokeContinuityEdgeGrant` using the same transaction runner;
4. invoke the extracted C-D15 identity-deactivation helper for every
   non-break-glass subject, so user/staff sessions, PINs, biometrics, and staff
   device state use the exact live implementation;
5. append the pending C-D6 routing instruction for the exact device and
   fallback principal; and
6. append required operation/step evidence in the single device-loss ledger and
   the existing tamper-evident clinical audit sink.

No best-effort call is swallowed inside this transaction. A relational failure
rolls back every Phase 1 mutation and leaves the prior operation state
retryable.

### Phase 1.5 — post-commit best effort with mandatory evidence

Token revoke-all and external signing/delivery cannot share the Postgres
transaction:

- The shared token revoker is invoked per non-break-glass subject. Until it can
  return an acknowledgement from Redis or the durable DB marker, the step is
  `retryable_failed` or `requested_unverified`, never `completed`.
- The canonical wipe content uses the durable operation/order ID and is signed
  through the existing continuity signer. The signed envelope is appended to
  the durable order lifecycle before delivery is attempted.
- The next-contact device-management channel accepts the order and returns its
  own immutable receipt. Transport failure is recorded and retried; it never
  rolls back immediate access shut-off.

A request can therefore return `incomplete_retryable` after Phase 1 committed.
Re-invocation skips already evidenced relational revocations, retries only
unacknowledged steps, and never mints a second order for the same operation.

### Phase 2 — next contact and later reconciliation

On authenticated next contact, the device-management consumer:

1. verifies tenant/device audience, order ID, content hash, Ed25519 signature,
   key state, and anti-rollback/order replay rules;
2. executes the existing C3.3 device-wide governed wipe primitive;
3. verifies local absence before acknowledging;
4. appends delivery/execution evidence; and
5. ensures any replay envelope from the device is forced to `needs_review` and
   assigned to the configured C-D6 fallback principal, never silently deleted.

The endpoint's re-invocation reads these receipts and converges its snapshot.
No Phase 2 failure restores revoked access.

The repository has no implementation of Phase 2 today. That is why the build
is stopped rather than reporting a backend-only order as C-D10 completion.

## 6. Break-glass preservation

Break-glass evaluation is per affected Staff UID and uses the existing
`users.is_break_glass_account` truth consumed by the C-D15 helper.

For a named break-glass account:

- the identity-wide C-D15 step returns `excluded_break_glass` and does not
  delete user/staff sessions, revoke all user tokens, clear account PINs,
  disable account biometrics, or disable every staff device;
- the exclusion is explicit in the operation and audit evidence; and
- device-scoped capture/edge grants and the lost-device wipe order still apply
  to the proved lost device, because they are C-D10 device containment and do
  not deactivate the named break-glass identity on other devices.

This preserves C-D15's exact automatic-deprovisioning exclusion without turning
a lost device into an unrevocable device credential. If owners intend the
exclusion to suppress even device-scoped containment, they must countersign an
addendum; engineering must not infer that broader exception.

## 7. What the runbook absorbs and retains

After a complete implementation lands, the endpoint absorbs:

- manual capture-grant enumeration and one-at-a-time revocation;
- the separate C3 `edge_read` revocation control;
- separate identity/session/token/PIN/biometric/device shut-off calls;
- wipe-order mint/sign/queue;
- creation of the standing lost-device `needs_review` routing instruction; and
- manual assembly of per-step IDs into a completion ledger.

The runbook remains required for:

- proving the exact stable device UUID and affected Staff subjects;
- recording reporter, circumstances, last-known contact, physical custody,
  police/security references where applicable, and the incident reference;
- assessing and recording the signed offline-pack residual-risk window;
- monitoring order delivery and local wipe execution after next contact;
- physical recovery, quarantine, forensics, re-provisioning, and return-to-use;
- verifying that unsynced items appeared in the reconciliation workbench under
  the C-D6 owner; and
- incident escalation and accountable closure when any step stays incomplete.

The runbook shrinks from multi-control execution to evidence verification and
physical-device handling. It never vanishes, and an awaiting-contact order is
not a completed physical wipe.

## 8. OpenAPI and Admin consumer delta

### 8.1 OpenAPI

The later build must add a dedicated generated-schema overlay, register it in
`apps/backend/scripts/generate-openapi.mjs`, and type:

- the required `Idempotency-Key` header;
- the exact request and per-step response enums;
- `200`, `202`, `400`, `403`, `409`, `422`, and typed `503` responses;
- break-glass exclusion evidence;
- signed order content/hash/key/signature and delivery/execution states; and
- the absence rule without describing it as successful empty data.

The generated `apps/backend/src/docs/openapi.json` must be committed. The build
gate is `npm --prefix apps/backend run openapi:check`, followed by the backend
OpenAPI core/spectral gates used by canonical CI. Step 1 changes none of these
files because the route is not build-authorized.

### 8.2 One Admin-surface wiring change is viable after the backend clears

The existing `DeviceLossPanel` already has the exact stable-device UUID input,
the partial-flow warning, the runbook link, and a per-step evidence checklist
(`apps/admin/src/app/(with-auth)/dashboard/continuity-facility-context/components/DeviceLossPanel.tsx:40-103`).
It can adopt the endpoint without navigation, information-architecture, or
visual redesign:

- replace per-grant revoke callbacks with one typed orchestration mutation;
- add incident reference, affected Staff UID list, reason, and required typed
  confirmation;
- render the returned ordered step evidence and keep the runbook link; and
- refresh the existing grant ledger after the mutation.

This is declared as **one Admin wiring slice**, not part of Step 1 and not a
claim that only one source file will change. The typed API client and focused
tests necessarily move with the panel. No broader Admin redesign is justified.

## 9. Non-goals and stop gates

Non-goals remain:

- no C-D value, break-glass policy, fallback-principal policy, retention value,
  or offline-pack expiry change;
- no activation or default-on flag;
- no wipe primitive/mechanism rewrite;
- no patient or unrelated clinical client change;
- no MDM product, OS remote-control surface, application inventory, or device
  forensics system;
- no deployment; and
- never merge this lane.

The following evidence is required before a build queue may reopen:

1. coordinator ruling on DDL versus a named external authoritative order store;
2. coordinator/owner ruling on the next-contact consumer compatible with the
   `no client changes` boundary;
3. resolution of the tenant typed-absence predicate;
4. auth-owner approval for evidence-bearing `revokeAllUserTokens` completion;
5. C6.1-D migration/Prisma lane completion or explicit sequencing; and
6. a revised delta proving the final operation/order schema, receipt
   authentication, replay-to-`needs_review` seam, retention, RLS, and
   idempotent convergence.

Until all six are present, the Admin surface must continue to say that
device-loss execution is incomplete and must retain its runbook link.
