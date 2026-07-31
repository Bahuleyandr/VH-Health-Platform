# C4 device and session facility context — design delta

**Status:** Step 1 design packet; awaiting coordinator clearance and owner
decision

**Authority:** clinical service continuity design §§5.4, 6.7, 6.8, and 7;
the committed C4.1 queue-envelope delta decision 3 at
`aa25b1a62d65b353c5dc397a00ddbefdeb8c0896`; and the C-D11
per-facility/cohort activation requirement

**Base re-derived at kickoff:**
`6be296f3a8741d8d653b8a18984fc0a1c8e43417`

**Base commit time:** `2026-07-31T06:54:02+05:30`

**Branch:** `feat/continuity-facility-context`

**Activation:** none

## 1. Outcome and recommendation

Use the combination model:

- facility-fixed ward/shared devices are operator-enrolled to one facility; and
- mobile/floating Staff sessions explicitly confirm one facility from a
  server-authorized set.

The recommendation is an engineering proposal, not a clinical or operational
decision. Proposed decision C-D14 in §7 leaves every owner value as
`OWNER INPUT`.

The binding is always server-issued, signed, finite, and revocable. A client
may request or confirm a facility, but that value is evidence only. Tenant,
department, host, care-team text, roster labels, ward screen state, and the
client-supplied C4 facility header are never facility authority.

Do not add a third device/facility mechanism. Converge the two named existing
mechanisms:

1. `user_devices` remains the device registry and becomes the current
   per-user/device facility-context projection; and
2. `clinical_continuity_edge_access_grants` plus its existing revocation ledger
   becomes the immutable authorization source for both its unchanged
   `edge_read` purpose and new, explicitly separated capture-context purposes.

`user_devices` is not sufficient authority by itself. It points to the exact
immutable grant and current context revision. The grant, revocation state,
authenticated Staff session, signed context envelope, and exact facility
policy must all agree.

This is documentation only. There is no backend, Prisma, migration, Staff,
Admin, shared-package, action-registry, edge-access, or activation change in
this step.

## 2. Re-derived repository facts and handoff corrections

### 2.1 Live baseline

`github/main` advanced during the Step 1 pass and was re-fetched and rebased at
`6be296f3a8741d8d653b8a18984fc0a1c8e43417`. The intervening files are the
C6.2 backup/warm-standby slice and do not overlap this delta. The referenced
C4.1 delta is not on that commit. Its committed form is on
`feat/continuity-c4-1-queue-envelope` at `aa25b1a62`; that worktree also has an
unrelated uncommitted edit and was not touched.

PR #660 / C4.2 remains open. Its committed head is
`14ff52099bc3e8fd776c8b03156ba3fe8fb08e2b`.

### 2.2 Existing device and facility state

| Surface | Verified state | Consequence |
|---|---|---|
| `user_devices` | Tenant-scoped by migration 336 with a GUC-reading default, `fk_user_devices_tenant`, and Pattern-A RLS; keyed uniquely by `(user_uid, device_id)`; no facility or user composite FK | It is the natural current device projection, but its uniqueness, explicit tenant handling, and RLS posture must be hardened before continuity use |
| `devices` | Legacy patient phone/FCM registration keyed by a globally unique `device_id`; no facility | It remains outside Staff continuity and must not gain another facility binding |
| `staff_devices` | Existing quick-login/PIN/biometric device state with `device_id`, trust expiry, and registration metadata; no facility | It must not gain an independent facility column or become a third authority. Its device identifier must resolve to the canonical `user_devices` installation identifier |
| Staff JWT | Carries actor, role, tenant when supplied, `jti`, and `deviceType`; ordinary password/PIN flows do not provide a trustworthy stable `device_id` claim | Facility enforcement cannot derive device or facility from the current JWT |
| `clinical_continuity_edge_access_grants` | Immutable tenant/facility/staff/device/certificate/location/policy grants with a monotonic access revision, finite validity, composite FKs, strict RLS, least-privilege grants, append-only renewal, and immutable revocation | This is the existing authorization and revocation ledger to extend; its edge-read contract must remain unchanged |
| `care_teams` | On the live baseline it has no `facility_id`; it is patient/episode scoped | The handoff statement that `care_teams.facility_id` exists is not true on this baseline |
| Staff roster/shift tables | Roster boards are department/date/shift scoped; assignments use loosely typed target IDs/labels; `staff_shift_assignments` has no facility | They are not a trustworthy Staff-to-facility authorization source |
| C2.2 readiness | Authenticated and tenant-resolved, returns tenant ID, evaluates tenant policy metadata, and deliberately returns no facility | It cannot currently provision or verify facility context |
| C3.3 Staff cache | Already models tenant/facility/staff/device session context, but the production source adapter is deliberately unavailable and returns no session | The client has a fail-closed seam ready to consume trustworthy context; it does not currently create that context |
| C4.1 | Requires provisioned/signed facility context and fails before persistence/network when it is absent | This delta fills that prerequisite without activating capture |
| C4.2 head | Reads `X-VH-Continuity-Facility-Id` and passes it to the policy loader; the current authenticated request has no independent facility binding | The future integration must replace header authority with a server-resolved context before C4.3 |

### 2.3 C-D11 status discrepancy

The live owner dossier still says C-D11 is open and leaves all C-D11 fields as
`OWNER INPUT`. This packet therefore does not describe C-D11 as countersigned.
The per-facility/cohort rule remains authoritative independently in design
§§6.7 and 7: absence means `off`, and one facility cannot activate another.
The coordinator must reconcile the dossier status before relying on any
C-D11 evidence-window, spacing, freshness, no-go, or rollback value.

## 3. Core model options

| Option | Consequences | Decision |
|---|---|---|
| A. Device enrollment | Correct for ward-fixed/shared tablets. Gives one stable facility pin and direct loss/revocation handling. Requires an enrollment/revocation workflow, an accountable operator, and a small Admin surface. It is wrong for clinicians who legitimately cover multiple facilities unless the device is re-enrolled. | Use for facility-fixed devices |
| B. Session selection | Correct for mobile/floating Staff. Supports cross-cover without reprovisioning the physical device. Requires an authoritative Staff/facility grant and an owner-defined reconfirmation/expiry rule. A client-supplied selection alone is never enough. | Use for mobile/floating sessions |
| C. Derived from Staff assignment | Avoids a new chooser but is not supported by the current repository. `care_teams` is patient scoped and has no facility; roster/shift assignments are not facility-FK-backed and can be sparse or label based. It also fails legitimate cross-cover. | Reject on the current baseline |
| D. Combination | Matches the physical reality of shared ward devices and mobile cross-cover. It has the most explicit operational UX, but keeps authority server-side and avoids unsafe inference. | **Recommended, pending C-D14** |

Only one facility context may be active for one authenticated Staff client
session at a time. Supporting two facilities in one shift means two explicit,
sequential contexts and a controlled switch; it never means one ambiguous
multi-facility capture context.

## 4. Converged authorization and projection model

### 4.1 Stable installation identity

The Staff client creates one random, opaque installation identifier in secure
storage before authentication. It is not a platform advertising ID, hostname,
phone number, user-entered label, FCM token, or `deviceType`.

The installation identifier locates a server record; it is not a credential.
Facility-context issuance and use also require proof of possession of the
device key or certificate pinned by the matching grant. A copied installation
ID alone cannot impersonate an enrolled device.

Every Staff authentication path sends it as evidence. The server resolves or
creates the exact tenant/user/device row, validates any existing registered
device credential, and issues the authenticated access session with the
server-accepted device ID. Password, PIN, quick-login, refresh, and Staff OIDC
must converge on the same rule. A client value that does not match the
server-side device/grant state fails closed.

`staff_devices` may continue to hold PIN, biometric, quick-login token, and
device-trust state. It does not hold facility. Build-time migration must
provide an exact tenant-aware link or resolution between its `device_id` and
`user_devices.device_id`; parallel identifiers are not accepted.

### 4.2 Extend the existing grant ledger, not its edge behavior

Add a closed grant-purpose discriminator to
`clinical_continuity_edge_access_grants`:

- `edge_read`: every existing row, constraint, exporter, verifier, mTLS
  authorization, access-revision floor, and log-receipt behavior;
- `capture_fixed_device`: an operator-approved device-to-facility enrollment;
  and
- `capture_staff_facility`: an operator-approved Staff/device/facility
  authorization from which an exact session context may be issued.

Existing rows are backfilled to `edge_read`. Every C3.2 query and export
explicitly filters `edge_read`; capture grants never enter an edge grant set,
advance an edge authorization floor, authorize a pack read, or satisfy an
edge-log receipt. Existing edge tests must prove byte-for-byte canonical export
and authorization behavior is unchanged.

Convergence is storage and lifecycle reuse, not permission equivalence.
`edge_read` authorizes an exact backend-independent, mTLS-protected,
location-scoped read. A capture grant authorizes only issuance of a
facility-context envelope; it does not authorize an edge read, queue capture,
replay, or clinical action. C4.2's exact action/policy checks remain separately
required.

The additive capture fields are purpose-checked. The build may choose exact
column names after rebase, but the database contract must express:

- subject kind (`device` or `staff_device`);
- exact tenant and facility;
- stable device ID;
- Staff UID when the purpose requires it;
- mandatory device credential/public-key or certificate binding;
- finite validity;
- immutable grant ID and monotonic capture revision;
- creating operator and creation time;
- pinned continuity policy ID/version; and
- one immutable revocation record per grant.

Existing edge-specific location, named-Staff, and client-certificate values
remain mandatory for `edge_read`. If shared columns must become physically
nullable to admit a device-subject capture row, closed purpose-dependent
`CHECK` constraints preserve every existing edge invariant.
`capture_fixed_device` requires no Staff subject but does require the creating
operator and device credential. `capture_staff_facility` requires the exact
Staff subject and device credential.

A deferred database constraint trigger, serialized by exact tenant/device
lock, permits at most one unrevoked, time-overlapping
`capture_fixed_device` facility enrollment for a device. This is required
because immutable revocation lives in a separate table and a partial index
cannot determine current revocation state. A `capture_staff_facility` grant is
exact to tenant, Staff UID, device, and facility. There is no tenant-wide,
department-wide, role-wide, or wildcard capture grant.

Grant renewal inserts a new row. Revocation inserts into the existing
revocation ledger. Existing immutable rows are never updated or deleted.

### 4.3 Extend `user_devices` as the current projection

`user_devices` stores no independent permission. Its continuity projection
contains only:

- exact tenant/user/device identity;
- selected grant ID, grant purpose, facility ID, and capture revision;
- active context ID and context revision;
- authenticated access-session `jti` hash;
- issue and expiry times; and
- last server validation time/state.

The exact projection points through composite foreign keys to the tenant,
facility, user, and grant. A fixed shared device may have multiple
per-user/device rows pointing to the same device-level fixed grant. A mobile
user/device row points to the exact Staff/facility grant selected for that
session.

The current projection can change, but each change and revocation is written
atomically with existing append-only identity/audit evidence. It is an
optimization and restart pointer. At every security boundary the server
rechecks the immutable grant and revocation ledger.

### 4.4 Signed facility-context envelope

The provisioning service returns a closed
`vhhealth_continuity_facility_context/v1` envelope signed through the existing
C3.1 canonicalization, Ed25519 key registry, and provisioned trust bundle. Do
not introduce another signing key, trust root, or canonicalization scheme.

The signed content contains only non-PHI authority:

- format and context ID;
- tenant ID and facility ID;
- grant ID, purpose, and capture revision;
- Staff UID and stable device ID when applicable;
- hash of the access-session `jti`;
- policy ID, version, checksum, signing key ID, and revocation epoch;
- issued-at, effective-from, and finite expires-at; and
- context revision.

Its expiry cannot exceed the grant, access session, or signed policy window.
The exact duration and reconfirmation rule are C-D14 owner inputs.

The facility-context envelope is not a REST bearer token and cannot be
accepted by `jwtMiddleware` as authentication. It proves the facility
authorization snapshot used at capture; the current JWT still proves the
current actor/session.

## 5. Establishment and lifecycle

### 5.1 Facility-fixed device

1. An authorized operator enrolls the exact stable device ID to one exact
   tenant/facility under a current signed policy.
2. The server inserts a `capture_fixed_device` grant and returns/provisions its
   signed facility-context material.
3. At Staff login the server verifies the device credential and active fixed
   grant, then issues the session context. The user does not choose another
   facility.
4. A facility change is a revocation plus a new grant, never an in-place
   facility edit.

The Admin work is a narrow enrollment/list/revoke surface, not an MDM product.
It does not inventory applications, enforce OS policy, remote-control the
device, or define clinical staffing.

### 5.2 Mobile/floating session

1. The Staff user authenticates with the stable device ID.
2. The client requests one facility as evidence.
3. The server accepts it only when an unrevoked, unexpired
   `capture_staff_facility` grant matches the authenticated tenant, Staff UID,
   device, and requested facility.
4. The server issues one signed session facility context and stores the current
   `user_devices` projection.
5. A facility switch repeats the confirmation and issuance flow.

The endpoint must not enumerate tenants or reveal whether an arbitrary
facility exists. Failure is a generic authorization result. Any owner-approved
facility chooser may show only facilities already authorized for that exact
Staff/device subject.

### 5.3 App restart and refresh

The active envelope is stored in secure storage under an opaque
tenant/user/device namespace. On restart the client verifies its signature,
audience, policy/key floors, expiry, Staff/device binding, and current
authenticated session before exposing it.

Access-token refresh rotates the `jti`; the backend must revalidate the grant
and reissue the facility context in the same logical refresh flow. The client
does not edit or resign the old context.

### 5.4 Controlled user switching

User switching clears the active decrypted facility context, facility-scoped
views, and in-memory authorization result. The next user establishes a new
authenticated session and receives their own context.

Encrypted C0A/C4.1 queue rows and their original signed context remain
owner-bound and are not deleted. The new user cannot display, lease, retry,
cancel, supersede, or reconcile the previous owner's rows.

### 5.5 Facility switching and pending work

A facility switch rotates `capture_session_id` before the first new capture.
Every existing row retains its original:

- tenant and facility;
- grant/context ID and revision;
- capture session;
- actor/device;
- action/policy claims; and
- command fingerprint.

No row is rewritten, moved to another partition, or sent under the new
facility. Drain remains partitioned by original tenant, owner, facility,
capture session, and action family.

To replay old work, the server verifies that the historical signed context was
valid at capture and that the current replay actor is now authorized for the
row's original facility. If the original grant was revoked, the current actor
cannot re-establish that facility, or the policy is incompatible, the row
becomes typed `needs_review` with an owner. It is never silently re-scoped.

### 5.6 Device loss

The governed device-loss path revokes every applicable capture grant for the
stable device and advances the capture revocation floor. Backend readiness,
new capture, replay, and context refresh then fail closed.

Remote wipe timing, offline revocation delay, local-unlock duration, and what
to do with an unrecovered device remain C-D10/C-D14 owner inputs. This packet
does not invent them. Existing unresolved queue work remains evidence; the
server does not delete it to make revocation appear complete.

## 6. Transport decision

| Candidate | Assessment |
|---|---|
| C2.2 readiness response | It is authenticated, tenant-resolved, and already used as a fail-closed compatibility check, but is frequently polled and deliberately low-information. It must not create or rotate a binding. A versioned response may echo a facility already derived from a verified context so the client can compare it. |
| Staff access JWT facility claim | Server-signed and convenient, but cached until refresh, coupled to every auth path, and too coarse for fast facility switch/revocation. A stale claim could remain usable for the access-token lifetime. Do not put facility authority in the access JWT. The JWT should carry only the server-accepted stable device ID and session `jti`. |
| Separate provisioning/confirmation call | Gives an explicit authenticated control-plane transaction, exact grant/revocation checks, independent context rotation, and a closed minimal response. This is the recommended issuer. |
| Signed C3.1 policy | The strongest offline action authority and exact facility audience, but it is intentionally slow-moving and cannot decide which of several facility policies a device/session may select. Use it as a mandatory cross-check and signing trust source, not as the device/session assignment itself. |

### 6.1 Recommended contracts

An authenticated Staff-only facility-context route:

- accepts the stable device ID and, for mobile mode, one requested facility ID
  as evidence;
- derives tenant and actor from authenticated middleware;
- verifies the exact grant, revocation state, current policy, and access
  session;
- returns the signed facility-context envelope and no PHI, facility name,
  tenant list, grant list, topology, or clinical value; and
- returns one generic denied state for absent, wrong-tenant, wrong-facility,
  wrong-device, revoked, expired, or unauthorized inputs.

C2.2 advances to a closed readiness contract v2 for C4-capable clients:

- the request supplies the signed facility-context envelope;
- the backend derives the facility through the same resolver;
- policy readiness is evaluated for that exact tenant/facility, not merely
  across the tenant;
- success echoes only `facilityId`, `contextId`, and `contextRevision`, values
  already inside the caller's verified envelope; and
- absent, invalid, revoked, or mismatched context returns a stable
  low-information not-ready state.

The v1 response is not extended with surprise keys because the current client
parser fails closed on unknown/malformed contract values. C4.3 requires v2;
non-C4 online callers may remain on v1 during additive rollout.

## 7. Proposed owner decision record

The coordinator should assign the final dossier number and route this record.
`C-D14` is proposed because C-D1 through C-D13 are already allocated.

### C-D14 — capture-side facility context operating model

> **Recommendation:** use a combination model. Operator-enroll ward-fixed and
> shared devices to one facility; require mobile/floating Staff to explicitly
> confirm one server-authorized facility per session. Issue a signed,
> revocable server context, permit only one active facility context per
> authenticated client session, rotate the capture session on a facility
> change, and never re-scope already captured work. Do not derive facility from
> tenant, department, care-team text, host, roster label, or screen state.

**Required sign-off roles:** clinical operations, nursing/workforce operations,
privacy, security/identity, hospital IT/device operations, product/UX, and
release.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Which device classes are facility-fixed | OWNER INPUT — engineering must not fill |
| Which Staff/device classes may select a facility per session | OWNER INPUT — engineering must not fill |
| Authoritative process and owner for granting Staff access to each facility | OWNER INPUT — engineering must not fill |
| Login/shift reconfirmation trigger and maximum context age | OWNER INPUT — engineering must not fill |
| Shared-tablet user-switch and handoff procedure | OWNER INPUT — engineering must not fill |
| Cross-cover procedure for two facilities in one shift | OWNER INPUT — engineering must not fill |
| Device enrollment, reprovisioning, and revocation roles | OWNER INPUT — engineering must not fill |
| Device-loss revocation, wipe, and offline-risk handling | OWNER INPUT — engineering must not fill |
| Facility-context grant, revocation, and audit retention | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

No implementation or activation may treat the recommendation as approved until
the required roles countersign the populated record. C-D10 remains authority
for the broader break-glass, device-loss, remote-wipe, and communications
policy; C-D14 must reference rather than contradict it.

## 8. Verification at every use

After PR #660 merges, facility-context resolution runs after JWT, tenant, and
Staff RBAC middleware but before C4.2 policy evaluation:

1. derive tenant, actor UID/role, access-session `jti`, and stable device ID
   from authenticated server state;
2. parse the closed context envelope and verify its canonical Ed25519
   signature against the provisioned trust/key floors;
3. load the exact grant and any revocation under explicit tenant context;
4. compare tenant, facility, grant purpose/revision, Staff, device,
   access-session hash, validity window, policy pin, and revocation epoch;
5. prove `(tenant_id, facility_id)` through the database composite FK;
6. set a server-owned `req.continuityFacilityContext` only after every check;
7. if `X-VH-Continuity-Facility-Id` is present, require it to equal the derived
   facility, but never use it to choose a policy;
8. pass only the derived facility to C4.2's active/historical policy loaders
   and identity checks; and
9. audit denied/review decisions with bounded identifiers and no PHI.

The resolver is required only on the facility-context issuer, readiness v2,
and C4-tagged action paths. Ordinary online requests without a C4 action ID
retain their existing behavior.

The C4.2 action ID, binding, handler, schema, role/capability, patient/resource,
current policy, and current actor checks remain server-owned. This delta adds
no action, route binding, registry entry, executable endpoint, or
shadow/enforce setting.

A modified client cannot select another facility by changing a header, body,
cached policy, host, department, or local secure-storage value. A valid signed
historical context is capture evidence only; replay still requires current
actor, device, tenant, facility, patient/resource, grant, and policy
authorization.

## 9. Migration and data-integrity contract for Step 2

### 9.1 Numbering and sequencing

Do not reserve a migration number in Step 1. Migration 601 is occupied and PR
#660 currently holds 602. C6.1 also requires a migration. At build kickoff,
after #660 merges and the branch is rebased on freshly fetched
`github/main`, re-list every migration and choose the next free number.

The SQL migration and regenerated `apps/backend/prisma/schema.prisma` commit
together. No hand-edited Prisma-only schema is accepted.

### 9.2 `user_devices` hardening

The build must:

- replace the global `(user_uid, device_id)` unique with tenant-aware
  `(tenant_id, user_uid, device_id)` uniqueness and update every `ON CONFLICT`;
- add `(tenant_id, user_uid) -> users(tenant_id, uid)`;
- add `(tenant_id, facility_id) -> facilities(tenant_id, id)` against
  `ux_facilities_tenant_id`;
- add the composite grant reference required by §4.3;
- reject a facility projection under the default tenant while preserving
  legacy non-continuity patient-device rows for explicit reconciliation;
- retain `ENABLE` and `FORCE ROW LEVEL SECURITY`;
- add the C3.1/601-style restrictive explicit-tenant policy so unset, empty,
  and `bypass` contexts cannot read or write continuity projections; and
- refactor every existing Firebase/device/admin reader and writer to explicit
  tenant scope before the restrictive policy is enabled.

No migration backfill may infer a facility from tenant, department, device
name, platform, IP, registered location, FCM token, care team, roster, or
default facility. Existing rows receive no facility context and remain
ineligible.

### 9.3 Grant-ledger extension

The existing edge tables keep tenant/facility-first composite keys,
same-tenant Staff/operator/policy FKs, immutable triggers, forced RLS,
restrictive explicit-context policies, and column-level least-privilege
grants.

Add capture-purpose checks, capture-specific tenant/device/Staff indexes, the
one-active-fixed-facility constraint, and purpose-isolated revision/export
queries. Capture grants must never satisfy an edge query; edge rows must never
authorize capture unless an owner-approved capture grant also exists.

No new facility, device, grant, revocation, session-binding, or assignment
table is introduced.

### 9.4 Retention and purge

Grant, revocation, context-transition, and denial evidence must cover at least
the maximum approved offline capture/replay window, client return/upgrade
window, reconciliation window, and legal/audit obligation. The exact horizon
is C-D14 owner input.

Until that value is countersigned, the build may retain immutable evidence but
must not activate capture or invent a purge duration. Purge, when approved,
must preserve any still-replayable command and its non-rearmable evidence.

### 9.5 Required database tests

Fresh-apply, re-run, schema-drift, and direct-SQL tests must prove:

- default-tenant, unset, empty, and `bypass` contexts fail closed;
- wrong-tenant facility, user, grant, policy, and operator references fail;
- a worker pinned to tenant A cannot read or mutate tenant B;
- global uniqueness does not block tenant B and cross-tenant collision does
  not resolve to tenant A;
- only one active fixed-device facility grant exists;
- capture rows cannot appear in edge exports or authorization;
- edge canonical exports and existing grant/revocation behavior are unchanged;
- grant/revocation immutability survives application-role and owner attempts;
- runtime roles have only the required columns/operations; and
- no facility is backfilled or inferred for legacy rows.

## 10. Expected Step 2 file ledger

Exact paths are revalidated after #660 merges. The expected ledger is:

### 10.1 Add

- `docs/continuity/c4-facility-context-design-delta.md` (this Step 1 record)
- `apps/backend/src/migrations/NNN_clinical_continuity_facility_context.sql`
- a backend facility-context service, controller, validator, and Staff-only
  route
- backend unit tests for grant selection, token issuance/verification,
  revocation, lifecycle, and C4.2 derived-facility integration
- backend deep tests for migration/RLS/FK/least-privilege/cross-tenant behavior
- shared Flutter facility-context model, secure store, verifier, and API client
- Staff tests for restart, refresh, fixed-device resolution, session
  confirmation, user switch, facility switch, and loss/revocation
- a narrow Admin enrollment/revocation surface and tests if C-D14 approves
  fixed-device enrollment

### 10.2 Modify

- `apps/backend/prisma/schema.prisma`
- Staff auth controllers/validators/services for stable device identity across
  password, PIN, quick-login, refresh, and OIDC
- `apps/backend/src/middleware/jwtMiddleware.js` to expose the server-issued
  stable device claim
- every `user_devices` reader/writer and `ON CONFLICT` call for explicit tenant
  scope and tenant-aware uniqueness
- C2.2 readiness service/controller/OpenAPI overlay and tests for closed v2
  facility-context verification
- C4.2 middleware/service after #660 merges so policy lookup consumes only the
  server-derived facility
- C3.2 grant service/migration tests only as required to purpose-isolate
  capture rows while proving edge behavior unchanged
- shared Flutter exports and C2.2 readiness parser/service for contract v2
- Staff `AuthService` and session lifecycle to create/persist the stable
  installation ID and active signed context
- the existing C3.3 source/session adapter seam to consume the verified
  context without enabling cache display or capture

No C4.1 queue implementation file is edited merely to store a facility in this
slice. C4.3 consumes the verified client context and connects it to the C4.1
envelope after both prerequisites have landed.

## 11. Verification gates after clearance

The Step 2 receipt must include:

- migration re-derivation and collision check after #660;
- backend lint, raw-parameter lint, Prisma validation, schema drift, OpenAPI
  checks, focused unit tests, and PostgreSQL deep tests;
- shared Flutter analyze, format, and focused tests;
- Staff analyze, format, and focused widget/service tests;
- forged, malformed, expired, superseded, revoked, wrong-key, wrong-policy,
  wrong-tenant, wrong-facility, wrong-user, wrong-device, wrong-session, and
  default-tenant context denials;
- fixed shared-device login by two authorized users without cross-user queue
  exposure;
- mobile facility confirmation, app restart, token refresh, controlled user
  switch, and explicit facility switch;
- pending C0A/C4.1 work retaining its original facility/context/fingerprint
  after a switch;
- old-facility replay requiring current authorization for that original
  facility or moving to typed `needs_review`;
- device-loss revocation blocking readiness, new capture, refresh, and replay;
- C2.2 v1/v2 compatibility and no-PHI/closed-response assertions;
- C4.2 client facility-header mismatch proving the header is evidence only;
- existing C3.2 edge export/authorization/log-receipt tests unchanged; and
- a full diff check proving no activation, policy publication, registry entry,
  or new capture action was added.

No Android/Windows device drill may be described as clinical activation.
Synthetic data only is used before owner clearance.

## 12. Sequencing and gates

1. coordinator reviews this delta and routes proposed C-D14;
2. C-D14 and the applicable open C-D10 values are countersigned;
3. PR #660 / C4.2 merges;
4. fetch `github/main`, rebase this lane, re-derive the migration number, and
   re-check C4.1/C4.2 file overlap;
5. build the backend plus client facility-context substrate inert;
6. prove every gate in §11; and
7. land before C4.3.

The build does not wait for C6.3's facility activation projection to be
designed, but capture remains impossible: absence of that later activation
record means `off`, and this slice publishes no active capture policy.

## 13. Explicit non-goals

This delta provides:

- no C4 capture activation or newly queueable action;
- no C4.2 action catalogue, executable binding, registry, or policy change;
- no C6.3 facility activation projection;
- no edge-read grant behavior, export, verifier, mTLS, log, or receipt change;
- no inference from tenant, default facility, department, care team, roster,
  host, screen, or client assertion;
- no clinical staffing, cross-cover, handoff, or ward-confirmation decision;
- no owner-input value;
- no MDM, remote-control, application-inventory, or OS-policy product;
- no Patient client change;
- no production policy/key/grant issuance;
- no deployment or activation;
- no merge; and
- no Step 2 implementation.

## 14. Coordinator clearance requested

Please approve, correct, or route these exact decisions:

1. the combination recommendation: fixed-device enrollment plus explicit
   mobile/session confirmation;
2. convergence on `user_devices` as current projection and the existing edge
   grant/revocation ledger as immutable authority, with no third mechanism;
3. purpose isolation that leaves every C3.2 edge-read behavior unchanged;
4. a separate signed provisioning call, a device-only access-JWT claim,
   C2.2 readiness v2 as verifier/echo, and the signed C3.1 policy as mandatory
   cross-check;
5. the exact queue rule that a facility switch never re-scopes captured work;
6. proposed C-D14 and its required sign-off roles;
7. the live-baseline corrections: no `care_teams.facility_id`, C-D11 still
   marked open, and C4.1 referenced from its committed branch rather than
   `main`; and
8. the Step 2 gates: countersigned owner inputs, #660 merged, fresh migration
   number, inert delivery before C4.3, and no merge from this lane.
