# C4 facility-context Admin surface — design delta

**Status:** Step 1 design delta; no portal implementation or activation in this
commit<br>
**Branch:** `feat/continuity-facility-admin-surface`<br>
**Live baseline:** `github/main` at
`2021bb1df361ae5d0c4f6f268b8a91bd1b270c70` (2026-08-01 11:50:02 +05:30)<br>
**Landed prerequisite:** PR #672 merge
`0fe48bb82ee9fe430a54e6b974516e7eaf95c1ce` is an ancestor of the live
baseline<br>
**Scope:** `apps/admin/**` and continuity documentation only<br>
**Hard boundary:** no backend, OpenAPI, Staff, policy, activation, deployment,
or C-D14 value change; this lane never merges

**Authority:** [countersigned C-D14](c0-4-owner-decision-dossier.md#c-d14--capture-side-facility-context-operating-model),
[countersigned C-D10](c0-4-owner-decision-dossier.md#c-d10--break-glass-retention-device-loss-and-communications),
[facility establishment and lifecycle](c4-facility-context-design-delta.md#5-establishment-and-lifecycle),
[C4 activation gates](activation-readiness-tracker.md#c4-capture-activation),
[landed Admin routes](../../apps/backend/src/routes/admin/deviceRegistryRoutes.js),
[landed service validation](../../apps/backend/src/services/downtime/clinicalContinuityFacilityContextService.js),
and the [generated OpenAPI contract](../../apps/backend/src/docs/openapi.json)

## 1. Outcome and authority

The build slice will replace the stale, inert continuity placeholder in the
general Devices page with a dedicated Admin control-plane surface for the
facility-context duties that the landed backend can actually perform. It will
not describe an absent backend operation as available or complete.

The controlling countersigned C-D14 decision is:

> “The combination model is adopted: facility-fixed devices are enrolled;
> mobile staff sessions confirm a facility; IT/security is the single granting
> and device-lifecycle authority.”

The same record requires fixed/shared devices to be enrolled to exactly one
facility, moving a fixed device to require re-enrollment, mobile/floating Staff
to reconfirm at login and at least every 12 hours, pending work to retain its
capture facility, and grant/audit evidence to use the 365-day operational-audit
retention baseline. Device loss is governed by C-D10.

The activation tracker makes execution of those duties an open OPERATOR gate.
This surface gives that gate a portal home, but it does not satisfy the gate by
existing. Activation still depends on all other C4 gates, including the frozen
compile-time approval constant, signed policy, Staff resolver, rollout cohort,
and owner-approved access mapping.

### 1.1 Parallel-safety declaration

This lane has zero file overlap with AR (C5.2), C6.1-B/C/D, or the gateway
build. Those lanes touch no `apps/admin` files. The Step 2 ledger remains
limited to `apps/admin/**` plus this document. No backend file is edited even
where this delta identifies a missing server capability.

The Admin convention is binding: all facility-context calls live in a
hand-written typed client under `apps/admin/src/lib/api/`. Page and component
code never calls `fetch`, `apiFetch`, `getJSON`, `postJSON`, or
`fetchAdminAPI` directly.

## 2. Re-derived live state

### 2.1 The existing Devices page is not this control plane

`apps/admin/src/app/(with-auth)/dashboard/devices/page.tsx` currently combines:

- the application/FCM push-token registry;
- the general clinical-device integration registry; and
- a disabled `ContinuityEnrollmentLocked` placeholder that calls no
  facility-context route and incorrectly says C-D14 is still open.

The FCM device ID, clinical-device `device_code`, IP allowlist, and integration
credential are not the C-D14 stable Staff installation ID or Ed25519 device
proof. The new surface must not copy, prefill, join, or infer continuity device
identity from either existing registry.

The build removes the continuity placeholder/tab from that page. It does not
change either existing registry's behavior. Facility context gets a separate
navigation item and route:

`/dashboard/continuity-facility-context`

### 2.2 The backend is intentionally inert

`CLINICAL_CONTINUITY_C_D14_APPROVED` is compiled as `false` in
`apps/backend/src/config/downtimeConfig.js`. Therefore:

- all three Admin grant/enrollment routes stop before service validation with
  HTTP 503 and code `CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE`; and
- a validation-valid Staff confirmation request stops with HTTP 503 and code
  `CONTINUITY_FACILITY_CONTEXT_UNAVAILABLE` (malformed confirmation input is
  rejected by its route validator before that controller gate).

Deployment flags cannot override the compile-time constant. A browser flag is
also not an authorization or activation boundary. The UI therefore uses the
server response as its availability authority and never turns a disabled
control into an enabled one locally.

The activation tracker is stale in one narrow respect: its C4 policy-delivery
row still calls PR #672 a draft, while live `github/main` contains its merge at
`0fe48bb82`. This delta records the live merge without editing the tracker or
claiming that policy delivery activates facility context.

### 2.3 Landed HTTP contract

The current generated OpenAPI document present after PR #672 registers all four
paths. The three Admin operations reference only the generic `Success` schema,
declare no request body or typed response data, and declare 200 for enrollment
even though the route returns 201. Consequently `ApiBody` is `never` and
`ApiData` is only an unstructured object for these operations. Step 2 must
hand-type the exact route/service contract below; it must not invent fields
that the OpenAPI document does not prove.

All success and error envelopes carry the server `requestId` when request
middleware supplied one. Existing Admin helpers unwrap `.data` and discard the
success envelope's `requestId`, so the domain client must use an
envelope-preserving helper while retaining the existing cookie proxy and
single-flight 401 refresh behavior.

| Operation | Exact request | Exact success data | Current typed absence |
| --- | --- | --- | --- |
| `GET /api/v1/admin/devices/continuity-facility-context/grants` | Optional query `facility_id`, a positive integer. No staff/device/status/paging filter exists. | HTTP 200 `{ grants }`; each row contains exact grant, subject, device, policy, validity, creator, capture revision, and nullable joined revocation fields. | HTTP 503 `CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE`. |
| `POST /api/v1/admin/devices/continuity-facility-context/enroll` | Snake-case body: `facility_id`, `grant_purpose`, optional `staff_uid`, `device_id`, `device_public_key_base64`, `valid_from`, `valid_until`. | HTTP 201 `{ grant }` with the inserted row. | HTTP 503 `CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE`. |
| `POST /api/v1/admin/devices/continuity-facility-context/revoke` | Snake-case body: `facility_id`, `grant_id`, `reason`. Actor comes from the Admin session. | HTTP 200 `{ revocation }` with the appended revocation row. | HTTP 503 `CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE`. |
| `POST /api/v1/downtime/facility-context` | Staff-only camel-case body: `facilityId`, exact `deviceProof` with `nonce`, `signedAt`, `signature`; actor, tenant, stable device, session JTI, and expiry come from auth. | HTTP 200 `{ facilityContext }` when activated and authorized. The Admin portal never calls this route. | HTTP 503 `CONTINUITY_FACILITY_CONTEXT_UNAVAILABLE`. |

The Admin routes do not attach an express-validator chain. Their closed
validation is performed by the facility-context service:

- `grant_purpose` is exactly `capture_fixed_device` or
  `capture_staff_facility`;
- a fixed-device grant forbids `staff_uid` and stores subject kind `device`;
- a staff grant requires a UUID `staff_uid` and stores subject kind
  `staff_device`;
- `device_id`, actor IDs, tenant IDs, and grant IDs are UUIDs;
- the device key is exactly a canonical base64-encoded 32-byte Ed25519 public
  key;
- timestamps must parse as UTC and `valid_until` must be after `valid_from`;
- the interval must fit the current signed policy; and
- a fixed device cannot have overlapping unrevoked grants, including grants
  for different facilities.

Revocation requires an exact tenant/facility/grant match and a non-empty reason
of at most 500 characters with no control characters. It appends one
revocation; it does not edit the grant.

### 2.4 What the wire contract does not provide

The portal must preserve these absences instead of filling them with client
inference:

1. There is no standalone Staff-to-facility authorization-set resource. The
   landed `capture_staff_facility` grant is scoped to exact
   `staff_uid + device_id + facility_id`, not merely Staff and facility.
2. There is no Admin endpoint that discovers or attests a Staff installation
   ID or retrieves its Ed25519 public key. Enrollment inputs must arrive in an
   approved provisioning bundle outside this surface; before server acceptance
   they remain operator-supplied, not backend-proven identity.
3. There is no continuity device-loss command that revokes every grant/session,
   issues the C-D10 governed wipe order, and routes unsynced work to
   `needs_review` atomically or as an orchestrated server workflow.
4. The Admin list and revoke routes are restricted to the two capture purposes;
   they do not enumerate or revoke C3 `edge_read` grants required by the full
   C-D10 device-loss response.
5. There is no wipe-order endpoint on the landed Admin contract.
6. There is no Admin endpoint to enumerate or transition unresolved work to
   `needs_review`.
7. There is no bulk-revoke operation. This is retained as a safety property,
   not emulated with an opaque client loop.
8. The grant list has only an optional facility filter and no pagination,
   Staff/device search, event cursor, or server evidence export.
9. Historic grant/revocation rows do not persist the HTTP request ID. The row
   UUID and capture revision are durable ledger references; the response
   `requestId` is a request-correlation receipt for the current call.
10. The grant-list response also omits the historic revoker UID even though the
   immediate revocation response returns `revoked_by`.
11. The route has no dedicated IT/security capability. Its effective outer
   backend gate is currently `ADMIN` or `SUPER_ADMIN`.

Any server-side closure of these gaps requires separately cleared
backend/product work. This lane only presents the exact landed behavior and
keeps the missing steps visibly incomplete.

## 3. Surface map

The dedicated page is a thin tab orchestrator following the Admin god-page
rule. It owns only tab state and routing. Each flow lives in a focused
component.

### 3.1 Status and authority

The first panel shows:

- the C-D14 IT/security authority statement and the 12-hour confirmation
  cadence;
- the current server state: `checking`, `not yet activated`, `denied`, or
  `service unavailable`;
- the retrieval request ID when present;
- explicit labels that portal visibility, code merge, and deployment are not
  clinical activation; and
- the role-mapping open question from §8.

It does not show an “enable” control.

### 3.2 Staff/device facility grants

This view filters only server rows whose `grant_purpose` is exactly
`capture_staff_facility`. It calls them **Staff/device facility grants**, not a
Staff-level authorization set. Each row shows the exact server values:

- Staff UID;
- stable device UUID;
- facility ID;
- grant UUID and capture revision;
- device credential SHA-256;
- policy UUID and version;
- validity window;
- creator UID and creation timestamp; and
- revocation UUID/revision, time, and reason when present. The list contract
  does not return the revoker UID; the UI must show that field as unavailable,
  not infer it.

The future create flow accepts the exact Staff UID, stable device UUID,
provisioned public key, facility ID, and validity window. It does not derive a
facility from department/roster and does not derive device identity from FCM,
browser, host, or clinical-device records.

When the grant endpoint eventually reports available, Staff choices come from
the existing authenticated Staff directory and facilities come from
`GET /api/v1/admin/facilities?status=active`. Friendly names are selection
labels only; the confirmation and POST use the exact returned Staff UID and
facility ID. Neither lookup supplies the stable device UUID or public key.

While the server returns the typed 503, the create control is absent, not a
disabled form populated with imaginary facilities or staff. The state explains
that capture-purpose grant issuance is not yet activated and includes the
server request ID.

### 3.3 Fixed-device enrollment and lifecycle

This view filters only `capture_fixed_device` rows. It supports the following
future flows without changing their backend meaning:

- **First enrollment:** submit one exact facility, stable device UUID,
  provisioned Ed25519 public key, and validity window.
- **Re-enrollment/re-provisioning:** revoke the old grant, retain its receipt,
  then require a second explicit confirmation before submitting a new grant.
- **Facility move:** the same revoke-then-enroll sequence; never edit or
  re-label the old row.
- **Revocation:** append one reasoned revocation for one exact grant.

Re-provisioning is not atomic in the landed contract. If the second enrollment
fails, the UI reports “old grant revoked; replacement not enrolled” and keeps
both request receipts visible. It never rolls back or conceals the safe
revoked state.

### 3.4 Device-loss execution

The device-loss view binds directly to the countersigned C-D10 flow:

1. select or paste one exact stable device UUID;
2. enumerate every returned active capture grant for that device;
3. require explicit selection and confirmation of each displayed grant;
4. revoke one grant per server call, preserving each response and row
   reference;
5. require revocation of any C3 `edge_read` grant for the device;
6. require session revocation;
7. require a signed governed wipe order;
8. require offline pack access to die at its signed expiry of at most 24 hours;
   and
9. require unsynced work to surface as `needs_review` to the C-D6 fallback
   reconciliation principal.

Only steps 1–4 have a landed Admin contract. Steps 5–9 render as
**server capability unavailable**, with no completion checkbox or success
state. The page must say “device-loss execution incomplete” until all governed
steps have authoritative receipts. It must not tell an operator to assume that
grant revocation revoked sessions, issued a wipe order, deleted local work, or
routed reconciliation.

Step 2 links
[the device-loss operator runbook](c4-device-loss-operator-runbook.md) for the
session, C3 `edge_read`, signed-wipe, offline-risk, and `needs_review` duties.
Those duties are completed and evidenced in their owning controls; the portal
does not manufacture a completion state for them.

There is no “revoke all” button. Multiple grants are displayed as an explicit
enumeration and confirmed one at a time. A failed or unavailable call stops the
sequence and leaves the remaining grants visibly pending.

### 3.5 Grant-ledger evidence

The evidence view uses the landed `GET .../grants` response only. The database
blocks UPDATE/DELETE on both grant and revocation tables; renewal is a new grant
and revocation is a new row.

The UI may flatten each returned grant plus its optional joined revocation into
separate visual events, but it preserves every server value verbatim and sorts
revision strings with integer-safe comparison. It never rewrites timestamps,
creates synthetic event IDs, or calls a client export “server-signed
evidence.”

The view exposes:

- grant and revocation UUIDs;
- capture revisions;
- exact subject/device/facility/purpose;
- policy and validity evidence;
- creator UID and timestamps;
- revocation reason; and
- the request ID for the current ledger retrieval.

The historic revoker UID is not available from this GET contract. Only the
immediate revoke receipt returns `revoked_by`, so the evidence view states that
limitation rather than backfilling an actor from the current session.

The unpaginated landed endpoint limits this to an on-screen evidence view in
Step 2. A complete server export/cursor is a backend follow-up, not a client
claim.

## 4. Inert-state contract

The page state is driven by the first grant-list call:

| Server result | Portal state | Allowed UI |
| --- | --- | --- |
| HTTP 503 + `CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE` | **Not yet activated** | Authority, reason, request ID, and contract limits only. No form and no mutation. |
| HTTP 403 | **Denied** | Denial explanation and request ID only. No data or mutation. |
| Network failure or other 5xx/code | **Service unavailable** | Retry plus safe generic message and request ID if present. No data or mutation. |
| Future successful 200 | **Available from server** | Exact grant/evidence views and explicitly confirmed mutations, subject to the future server-enforced IT/security capability. |

The fourth row defines forward-compatible behavior; Step 2 tests do not mock
it while the production compile-time gate is false. No frontend fixture,
storybook story, Jest handler, Playwright route override, or local fallback may
return a successful facility-context grant/enrollment response.

Every mutation response, including typed absence or denial, gets a persistent
receipt panel rather than a toast alone. The panel shows:

- HTTP outcome and server message;
- response `requestId`;
- for future success, grant/revocation UUID and capture revision; and
- the exact next safe state, including incomplete re-provisioning or remaining
  device-loss grants.

## 5. Consequential-action safety

### 5.1 Enrollment confirmation

Before a future enrollment POST, the confirmation panel repeats the exact:

- purpose (`capture_fixed_device` or `capture_staff_facility`);
- Staff UID when applicable;
- stable device UUID;
- facility ID;
- validity timestamps; and
- operator-supplied public key, clearly labelled unverified until accepted by
  the server.

The operator must type the full stable device UUID to confirm. The button is
single-flight and cannot be resubmitted while pending. Success is shown only
from the server's 201 response.

### 5.2 Revocation confirmation

Before a future revocation POST, the destructive confirmation repeats the
grant UUID, purpose, Staff UID if any, stable device UUID, facility ID, and
validity. It requires:

- a non-empty reason conforming to the server's 500-character/control-character
  rule; and
- typing the full grant UUID.

The client never treats an already-revoked or wrong-facility denial as success.
No optimistic removal occurs; the ledger is re-read after the receipt is
shown.

### 5.3 Exact identity presentation

The portal displays stable device UUID and credential hash only from the
facility-context response. Before first enrollment it displays the provisioning
bundle's values as operator-supplied input, never “registered,” “verified,” or
“backend-proven.” Friendly names may be added only if a future backend contract
returns an authoritative mapping; they are not inferred in this lane.

## 6. Typed Admin client decision

Step 2 adds `apps/admin/src/lib/api/continuityFacilityContext.ts` with closed
types for:

- the two grant purposes;
- enroll and revoke bodies;
- exact grant and revocation rows;
- envelope-preserved success/error receipts; and
- a parser for `CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE`, 403 denial, and
  unknown/unavailable results.

The client imports an envelope-preserving request helper from
`apps/admin/src/lib/api/core.ts`. The helper uses the existing same-origin
proxy, httpOnly cookie, and one-retry single-flight refresh path. It must not
read a browser token or expose the backend API key.

The OpenAPI path constants remain literal strings so path drift is caught, but
`ApiBody`/`ApiData` are not used for data shapes until the backend spec provides
the real 201/body schemas. No OpenAPI change belongs to this ledger.

## 7. Step 2 file ledger

Expected additions:

- `apps/admin/src/lib/api/continuityFacilityContext.ts`
- `apps/admin/src/app/(with-auth)/dashboard/continuity-facility-context/page.tsx`
- `apps/admin/src/app/(with-auth)/dashboard/continuity-facility-context/components/StatusPanel.tsx`
- `apps/admin/src/app/(with-auth)/dashboard/continuity-facility-context/components/StaffDeviceGrantsPanel.tsx`
- `apps/admin/src/app/(with-auth)/dashboard/continuity-facility-context/components/FixedDevicePanel.tsx`
- `apps/admin/src/app/(with-auth)/dashboard/continuity-facility-context/components/DeviceLossPanel.tsx`
- `apps/admin/src/app/(with-auth)/dashboard/continuity-facility-context/components/EvidencePanel.tsx`
- focused Admin Jest tests under
  `apps/admin/src/__tests__/dashboard/continuity-facility-context/`

Expected modifications:

- `apps/admin/src/lib/api/core.ts` for an envelope-preserving helper without
  changing existing unwrapped callers;
- `apps/admin/src/lib/api/index.ts` for the typed domain export;
- `apps/admin/src/app/(with-auth)/dashboard/layout.tsx` for the separate Admin
  navigation entry; and
- `apps/admin/src/lib/routePolicy.ts` for the default-deny `SUPER_ADMIN` route
  gate;
- `apps/admin/src/app/(with-auth)/dashboard/devices/page.tsx` only to remove the
  stale continuity placeholder/tab while preserving FCM and clinical-device
  behavior.

Step 2 also adds
`docs/continuity/c4-device-loss-operator-runbook.md` and may update this delta
to record the implementation clearance without changing C-D14 or C-D10 values.

No other file is pre-authorized. Step 2 revalidates this ledger against the
then-current `github/main` before editing.

## 8. Role mapping — open owner question

### 8.1 Verified mismatch

The current backend mount admits the `platform_admin` group, which is
`ADMIN` and `SUPER_ADMIN`. The route-local `canManage` helper mentions
integration admins, but the outer `/api/v1/admin` gate prevents technical-only
roles from reaching it. The portal similarly treats only `ADMIN` and
`SUPER_ADMIN` as Admin navigation roles. These labels do not prove that the
account holder belongs to the C-D14 IT/security authority.

Client visibility cannot repair that authorization mismatch because direct API
calls would retain the broader backend permission.

### 8.2 Technical recommendation, not an organizational decision

Create a follow-up backend slice with explicit server capabilities such as:

- `continuity:facility-context:view` for status and ledger evidence; and
- `continuity:facility-context:manage` for enroll/re-enroll/revoke.

The capabilities should be deny-by-default and assigned only to the named
accounts/roles that the accountable owner confirms are IT/security operators.
Portal visibility and buttons then mirror the server result. Whether
`SUPER_ADMIN`, ordinary `ADMIN`, technical-admin roles, or named exceptions
receive either capability is owner input. That backend slice is outside this
ledger and is an activation prerequisite.

The Step 2 implementation clearance selects the strictest existing portal role:
both middleware and navigation limit this page to `SUPER_ADMIN`. This is a
temporary technical restriction, not an organizational decision or proof that
every `SUPER_ADMIN` is a C-D14 IT/security operator. Loosening visibility or
execution later requires the owner mapping plus the separate deny-by-default
backend capability slice.

### 8.3 Draft dossier-format owner sub-question

**Provisional title:** C-D14 administrative identity and capability mapping<br>
**Status:** OWNER INPUT; coordinator assigns the final dossier identifier<br>
**Required sign-off roles:** security/identity, hospital IT/device operations,
privacy, operations, product/UX, release, and the accountable owner

> **Recommendation:** authorize facility-context viewing and execution through
> separate server-enforced capabilities assigned to named IT/security
> operators. Do not infer C-D14 authority from `ADMIN`, `SUPER_ADMIN`, ward
> roster, department, or portal visibility.

| Owner-input field | Value |
| --- | --- |
| Decision | OWNER INPUT — engineering must not fill |
| Which named roles/accounts may view grant and revocation evidence | OWNER INPUT — engineering must not fill |
| Which named roles/accounts may enroll, re-enroll, re-provision, and revoke | OWNER INPUT — engineering must not fill |
| Whether `SUPER_ADMIN` receives either capability automatically or only by explicit assignment | OWNER INPUT — engineering must not fill |
| Whether ordinary `ADMIN` may view evidence without executing lifecycle actions | OWNER INPUT — engineering must not fill |
| Whether technical roles (`IT`, `IT_STAFF`, `IT_ADMIN`, `SYSTEM_ADMIN`, `INTEGRATION_ADMIN`) enter the Admin control plane and under which capability | OWNER INPUT — engineering must not fill |
| Emergency/break-glass access, step-up, expiry, and review requirements | OWNER INPUT — engineering must not fill; must remain consistent with C-D10 |
| Owner names and roles | OWNER INPUT |
| Decision date | OWNER INPUT |
| Approval or signature references | OWNER INPUT |

## 9. Verification plan for Step 2

### 9.1 Mandatory typed-absence tests

Jest/component tests use production-realistic error envelopes only:

- known 503 renders **Not yet activated**, the backend code, and request ID;
- 403 renders **Denied** and no grant data or mutation controls;
- unknown/network failure renders **Service unavailable** and retry only;
- opening the page under typed absence sends no enrollment/revocation request;
- the staff, fixed-device, device-loss, and evidence panels cannot manufacture
  rows from FCM or clinical-device data;
- no successful facility-context response fixture exists; and
- navigation and the stale Devices placeholder removal do not change existing
  FCM/clinical-device tests.

The client parser is tested against the actual response-helper shape:

```json
{
  "success": false,
  "message": "Clinical continuity facility enrollment is unavailable",
  "requestId": "<server request id>",
  "code": "CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE"
}
```

### 9.2 Build receipts

The Step 2 commit is not ready to push until all of these run from
`apps/admin` and their output is recorded:

- `npm run lint`
- `npm run type-check`
- `npm test -- --runInBand`
- `npm run build`
- the focused authenticated Playwright journey against the real disabled
  backend, following the portal's existing setup/storage-state convention
- `git diff --check`
- a three-dot intent diff proving only `apps/admin/**` and the approved
  continuity docs changed

No mocked backend success, deployment, facility activation, policy publication,
grant issuance, wipe execution, or clinical device drill counts as a receipt.

## 10. Explicit non-goals and Step 2 stop conditions

This lane provides no:

- backend route, validator, service, migration, RBAC, capability, or OpenAPI
  change;
- standalone Staff-to-facility authority model;
- Staff application or confirmation-flow change;
- C-D14 or C-D10 value edit;
- activation flag/constant change;
- capture-purpose grant, policy, key, or facility activation issuance;
- bulk revoke;
- MDM, remote-control, application inventory, or OS policy;
- wipe-order or `needs_review` implementation;
- deployment;
- merge.

Step 2 must stop and return to design if the live contract changes, the
dedicated capability decision is made in a conflicting form, another lane
enters `apps/admin`, or completing a requested flow would require any backend
or Staff edit.
