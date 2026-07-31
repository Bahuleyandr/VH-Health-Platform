# Signed continuity-policy delivery adapter — design delta

**Status:** Step 2 implemented and locally verified from `5f96f39fe`; draft
publication remains held for the mandatory post-C5.1 rebase and combined-file
focused-suite receipt

**Branch:** `feat/continuity-policy-delivery`

**Pinned Step 1 base:** `github/main` at
`1d602c0acef815b0e533f86b6ef304b8447a80e5`

**Pinned Step 2 base:** `github/main` at
`888de6c06605b3ec22f0bbdc35c0bea966b8c4e6` (landed C4.3
`4b79df3759c5b41c03dae70f53bfb3ed0d4a382c`)

**Scope:** `apps/backend`, `packages/vhhealth_core`, `apps/staff`, OpenAPI,
tests, and this record

**Activation:** none

**Migration DDL:** zero

**Prisma regeneration:** zero

## 0. Coordinator clearance and build hold

The coordinator approved this delta on 2026-07-31. The following decisions are
ratified as written:

- the closed `format` / `policyId` / `payload` / `signature` wire envelope;
- the exact reconstructed C3.1/C4.2 signing payload, with unknown, duplicate,
  and non-canonical fields rejected;
- `policyId` as an unsigned carrier/replay pin, with any requirement to sign the
  current UUID treated as an upstream C4.2 revision and a stop condition;
- explicit pack-composition v2 because pack v1 is closed;
- the checksum-plus-full-representation ETag;
- typed absence states and the rejected-source inventory; and
- deferral of a readiness checksum echo to AF's readiness v2 ownership.

Clearance adds four merge-blocking conditions:

1. Step 2 starts only after AF PR #668 merges and the coordinator supplies the
   post-merge SHA as explicit GO. This lane then rebases onto that SHA and
   re-runs all of section 2 against C5.1's current or landed implementation.
   Zero overlap permits parallel build; any overlap queues this lane.
2. Pack-composition compatibility is proved in both directions with real
   fixtures. An unupgraded client receives v2 through its existing pack-invalid
   path without a crash or partial acceptance. A v2-capable client rejects a v1
   pack containing masquerading policy-delivery fields. Pack-composition
   version joins the persisted anti-rollback witness.
3. The byte proof runs through the real authenticated middleware stack,
   including compression, content type, and transfer encoding. A service-level
   return-value unit test is insufficient.
4. Zero DDL and zero Prisma regeneration become pre-write build assertions. If
   implementation discovery indicates either is required, the build stops and
   surfaces that conflict before any schema or runtime file is written.

At the historical clearance re-check, `github/main` remained
`1d602c0acef815b0e533f86b6ef304b8447a80e5`; AF PR #668 remains open and draft
at `3464b349cdfc294e4440973123e4067305bb2d46`; and no Step 2 GO SHA has been
supplied. The coordinator later supplied the landed AF and C4.3 SHAs and
explicitly authorized Step 2; this paragraph records the earlier hold rather
than current branch state.

## 1. Purpose and authority

C4.3 defines `StaffActionPolicySource` as an exact-byte boundary for the signed
C4.2 policy envelope, but deliberately leaves its production implementation
unavailable. This slice supplies that missing delivery path without creating a
second policy, trust store, verifier, cache, edge gateway, action catalogue, or
activation mechanism.

The authority order for this design is:

1. the live checkout pinned above;
2. the landed C3.1, C3.2b, C3.3, C4.1, and C4.2 contracts;
3. the committed C4.3 design on
   `github/feat/continuity-c4-3-staff-enforcement` at
   `74cd8074e5c0a45cb778abb940fded74f16db8dd`;
4. the committed AF facility-context implementation on
   `github/feat/continuity-facility-context` at
   `3464b349cdfc294e4440973123e4067305bb2d46` (draft PR #668);
5. the committed C5.1 design on
   `github/feat/continuity-c5-1-replay-receipts` at
   `d387b1185f20c52f62e7940fa532211be50bdf6e`; and
6. the countersigned C-D records in
   [`c0-4-owner-decision-dossier.md`](c0-4-owner-decision-dossier.md).

The C4.3 and C5.1 references are committed design authority, not landed runtime
authority. AF is a committed implementation on a draft PR, also not landed
runtime authority. Step 2 must re-fetch `github/main` and revalidate their merge
state and exact paths before editing code.

## 2. Step-0 preflight and stop conditions

### 2.1 Database and generated schema

The existing `clinical_continuity_policy_versions` row already stores every
value needed for delivery:

- the immutable JSON policy document;
- its lower-case SHA-256 checksum;
- canonicalization and signature algorithm;
- the policy signing key identity and public-key hash;
- the 64-byte Ed25519 signature;
- tenant, facility, version, effective-window, supersession, and revocation
  fields; and
- the C4.2 action-registry version and checksum fields.

The database does not store a canonical-byte blob. That does not justify a new
column. The existing RFC 8785 JCS implementation deterministically reconstructs
the signing payload, and successful Ed25519 verification proves those
reconstructed payload bytes are the bytes covered by the stored signature.

Therefore:

- migration DDL expectation is **zero**;
- Prisma model change expectation is **zero**;
- Prisma client regeneration caused by this slice is **zero**; and
- discovering a need for a byte column, new table, trigger, RLS policy, grant,
  or migration is a stop condition requiring a revised delta.

Step 2 still runs Prisma validation and schema-drift checks as unchanged
evidence. It does not run `prisma db pull` to manufacture a schema change.

After the post-AF rebase and before the first runtime edit, Step 2 records:

```text
git diff --exit-code <post-AF-base> -- apps/backend/prisma/schema.prisma
git diff --name-only <post-AF-base> -- apps/backend/src/migrations
```

Both must be empty at kickoff and remain empty in the final three-dot intent
diff. If code discovery suggests adding or regenerating either surface, work
stops before writing that change and returns to the coordinator.

### 2.2 C5.1 route and middleware overlap

C5.1's declared Step 2 ledger owns:

- `clinicalContinuityReplayMiddleware.js`;
- `clinicalContinuityReplayReceiptService.js`;
- `clinicalContinuityReplayEnvelope.js`;
- `clinicalNoteDraftController.js`;
- `idempotencyMiddleware.js`;
- `clinicalContinuityActionPolicyMiddleware.js`;
- `clinicalNotesRoutes.js`;
- the action binding/registry services;
- `clinicalNoteDraftService.js`;
- `downtimeConfig.js`;
- `validateEnv.js`; and
- its migration, Prisma, and replay tests.

This delivery lane owns a separate authenticated GET router, controller,
validator, and service. It does not edit any C5.1 path above. The global C4.2
action-policy middleware remains inert for this GET because the delivery client
does not send a continuity action header. The delivery route is not an
executable action binding and never enters replay or generic idempotency.

The expected C5.1 file overlap is **zero**, except for the coordinator-declared
shared `clinicalContinuityPolicyService.js` contact point. This lane's change to
that service is limited to the additive serving/read representation. Whichever
lane lands second rebases onto the merged service and reruns its focused suites
against the combined file; a non-additive collision is surfaced to the
coordinator rather than resolved locally. Step 2 must prove the remaining
zero-overlap claim with:

```text
git diff --name-only github/main...github/feat/continuity-c5-1-replay-receipts
git diff --name-only github/main...HEAD
```

Any common code path is a stop condition. Documentation-only overlap under
`docs/continuity` is not runtime overlap. C5.1's current delta says any OpenAPI
source or generated path requires a ledger revision. If that revision adds a
path in this lane's OpenAPI ledger, parallel build permission ends until one
lane lands and the other rebases.

### 2.3 Other occupied continuity lanes

AF and C4.3 are sequential prerequisites, not parallel edit lanes:

- AF must land the server-owned facility context and readiness v2 contract
  before the production route is wired.
- C4.3 must land the shared policy trust/verifier/cache and
  `StaffActionPolicySource` seam before this adapter implements that seam.

This lane may then modify those landed seams additively. It must not implement
AF or C4.3 inside this branch.

At the Step 1 re-fetch, AF draft PR #668 owns four paths this lane expects to
modify after AF lands:

- `apps/backend/src/docs/openapi.json`;
- `packages/vhhealth_core/lib/services/http_client.dart`;
- `packages/vhhealth_core/lib/vhhealth_core.dart`; and
- `packages/vhhealth_core/swagger/openapi.json`.

AF also owns the facility-context service/header contract and readiness v2 that
this lane consumes without editing. Those known same-file paths make a parallel
AF build unsafe even though the changes are semantically different. This lane
waits for AF to merge, rebases, and then applies its additive edits to the
landed files. It does not ask Git to resolve two live continuity lanes.

C5.2 remains held behind AF and C5.1 and owns reconciliation, paper back-entry,
incident, identity-match, and closure behavior. This lane touches none of those
surfaces. Unexpected overlap with an occupied AF, C4.3, C5.1, C5.2, C6.1, or
deployment worktree is a stop condition.

### 2.4 Readiness compatibility stop condition

The live C2.2 readiness v1 contract advertises policy schema version 1 and the
shared client parser requires exactly version 1. A schema-v3 action policy would
therefore make current readiness report policy incompatibility and prevent the
C3.3 stable-readiness refresh path from running.

AF draft PR #668 adds `POST /api/v1/health/client-readiness/v2`, verifies the
signed facility context, and reports schema version 3 plus the exact facility.
This lane does not race that ownership or treat an unmerged branch as runtime
authority. Step 2 wiring is blocked until the landed readiness contract:

- resolves the server-owned facility context;
- recognizes policy schema v3 and the supported pack schemas;
- preserves authenticated trusted-clock input; and
- provides the stable public/internal route posture needed by the delivery
  source.

After AF merges, the backend delivery route may be built while activation
remains inert, but Staff must remain on the unavailable source until every
readiness gate above passes.

### 2.5 Owner-decision activation boundary

C-D11 (activation cohort and evidence) and C-D12 (patient portal behavior)
remain open in the live dossier. C-D11 is an activation stop condition for this
Staff delivery path. C-D12 is outside this Staff-only lane and cannot be
inferred here. Building and verifying the adapter grants no rollout,
facility-enablement, capture, deployment, or patient-portal authority.

## 3. One byte-exact signed envelope

### 3.1 Wire format

The route returns one closed JSON object:

```json
{
  "format": "vhhealth_clinical_continuity_policy_delivery/v1",
  "policyId": "the immutable policy-row UUID",
  "payload": {
    "...": "the exact buildClinicalContinuityPolicySigningPayload result"
  },
  "signature": "base64-encoded 64-byte Ed25519 signature"
}
```

The exact top-level keys are `format`, `policyId`, `payload`, and `signature`.
Unknown, missing, duplicate, or non-canonical fields are rejected.

`payload` is the existing C3.1/C4.2 signing payload reconstructed by
`buildClinicalContinuityPolicySigningPayload`. The Ed25519 signature verifies
over the RFC 8785 JCS UTF-8 bytes of `payload`; this slice does not re-sign,
wrap-sign, or define a second signature. `format` is an outer transport
discriminator. It is not authority: a verifier requires its exact value and
then independently verifies the signed payload.

The landed signing payload does not contain the current row UUID. This delta
does not falsely describe `policyId` as policy-key-signed and does not add a
second signature. `policyId` is a replay/history pin bound by the authenticated
carrier:

- the API-key/JWT/facility-authorized TLS route binds it online;
- the outer signed pack content binds it on the edge;
- C3.3 authenticated encryption binds it in cache; and
- the backend compares it to the exact immutable row at replay.

`policyId` is never evaluated to grant an action. Every permission-bearing
field remains inside the policy-key-signed payload. A substituted UUID can only
fail exact server matching and move work to denial/review; it cannot widen
authorization. If policy-key signing of the current UUID is required, C4.2 must
revise and version its signing payload and issue newly approved signatures
before this build; that is an upstream stop condition, not something this
transport lane hides.

The complete response body is the RFC 8785 JCS UTF-8 serialization of the
closed outer object. The server sends a `Buffer`; it does not pass the success
body through `responseHelper`, `JSON.stringify`, a generated model, or any
middleware that can wrap or reserialize it. Staff consumes `bodyBytes` and
passes those same bytes to C4.3. Transport code must never pass a parsed or
pre-verified object to `StaffActionPolicySource`.

The canonical delivery envelope is limited to 256 KiB before base64 encoding.
The pack's existing 2 MiB canonical-content ceiling still applies after the
base64 field is added. Oversize policy delivery aborts route delivery and the
whole pack publication; it never produces a partial pack set.

The media type is:

```text
application/vnd.vhhealth.clinical-continuity-policy+json
```

The OpenAPI description states that the representation is canonical RFC 8785
JCS UTF-8 even though the structured suffix remains `+json`.

### 3.2 Stored-checksum and served-byte proof

The existing `policy_checksum` is intentionally:

```text
sha256(JCS(payload.policyDocument))
```

It is not the hash of the outer delivery envelope. Claiming that the entire
response body hashes to `policy_checksum` would contradict the landed C3.1
contract because the body also contains signed audience, version, effective
window, key, revocation, registry, and signature fields.

Step 2 proves both byte properties separately:

1. Strictly parse the exact served body, extract `payload.policyDocument`,
   canonicalize that value, and prove its UTF-8 SHA-256 equals the immutable
   stored `policy_checksum`.
2. Canonicalize the served `payload`, prove byte parity with the server's
   signing bytes, and verify the stored Ed25519 signature with the stored,
   registry-validated policy public key.
3. Recanonicalize the full parsed envelope and prove it is byte-for-byte equal
   to the response body.
4. Hash the full response representation independently and publish that value
   as `Content-Digest`.

This proof is merge-blocking and runs through the real Express application,
not by invoking the service or controller directly. The test provisions an
existing policy row, authenticates with a valid API key, Staff JWT, tenant/RLS
context, RBAC role, and AF facility-context header, and requests the mounted
route twice:

- with `Accept-Encoding: identity`, it captures the raw response bytes and
  proves canonical envelope equality plus the stored inner policy checksum;
- with `Accept-Encoding: gzip`, it captures the actual compressed wire bytes,
  verifies `Content-Encoding`, decompresses them according to the response
  header, and proves the recovered representation is byte-identical to the
  identity response.

Both requests assert the exact vendor content type, UTF-8 interpretation,
`Content-Length`/transfer behavior produced by the real stack,
checksum-plus-representation ETag, and `Content-Digest`. The strict parser then
hashes `JCS(payload.policyDocument)` from those served bytes and compares it to
the row's stored `policy_checksum`. A direct service-return unit test remains
useful but cannot satisfy this gate.

The response uses RFC 9530 form:

```text
Content-Digest: sha-256=:<base64 digest of the exact response body>:
```

The client checks `Content-Digest` before parsing when it is present. It remains
transport evidence, not signing authority.

### 3.3 ETag and conditional GET

The policy checksum alone cannot be a correct strong entity tag. A later policy
version can legitimately retain the same policy document while changing its
effective window, key, revocation state, row UUID, or signature. Returning
`304` for that changed representation would be unsafe.

The strong entity tag is therefore based on both the stored lower-case policy
checksum and the exact full-envelope digest:

```text
ETag: "pc-<64-lower-hex-policy-checksum>.rep-<64-lower-hex-envelope-sha256>"
```

This keeps the policy checksum explicit for diagnostics while giving HTTP a
representation-unique validator. The successful response also carries:

```text
Cache-Control: private, no-cache, must-revalidate
Vary: Authorization, X-API-Key
```

The server evaluates policy lifecycle, tenant/facility scope, current key
status, revocation, effective window, checksum, and signature before evaluating
`If-None-Match`. A matching tag can return `304 Not Modified` only when that
same policy is still the current valid deliverable authority. Revocation,
supersession, expiry, or withdrawal returns its typed response even when the
request tag matches.

GET conditional semantics accept a list, weak comparison, and `*` as required
by HTTP. The production Staff client sends only the last locally verified
strong tag. A `304` carries the current `ETag` and no body.

Staff may reuse bytes after `304` only when its C4.3 verified cache still has
the exact matching ETag, policy checksum, and full-envelope digest and passes
audience, key, policy, registry, revocation, trusted-time, and signed
effective-window checks. If those bytes are absent or unusable, Staff performs
one unconditional recovery GET. A second empty or invalid result becomes typed
unavailable. A `304` never advances a trust floor or trusted time.

## 4. Authenticated backend route

### 4.1 Route family

The only new backend route family is:

```text
GET /api/v1/clinical-continuity/facilities/:facilityId/policy
```

It is mounted below the existing global API-key, JWT, full-scope, tenant
context, and tenant-RLS middleware. Inside the router it uses the standard
`wrapAutoRBAC` path with the existing all-Staff `staffRoutes` role set, a
dedicated policy-delivery limiter, the landed AF facility-context verifier, the
parameter validator, and the controller.

The route:

- accepts a bounded positive integer `facilityId`;
- receives AF's signed context in
  `X-VH-Continuity-Facility-Context`, reusing AF's landed decoder/resolver;
- derives tenant from authenticated server state;
- derives the authorized facility from AF's signed, server-verified context;
- requires the path parameter to equal that derived facility;
- never derives facility from tenant, department, care-team text, hostname,
  mutable screen state, or an unsigned client header;
- rejects the default tenant;
- reads under explicit tenant context and RLS;
- returns no patient, encounter, note, staff name, or other PHI; and
- does not attach `phiAccessLogger`.

The standard route audit wrapper may record the bounded route identity and
outcome. It must not record the envelope body, signature, JWT, API key, client
certificate, raw request headers, or any clinical payload.

The dedicated limiter starts at 30 requests per authenticated actor per minute,
is enforced in tests, and uses the repository's existing rate-limit response
shape. This is a transport-abuse ceiling, not the refresh cadence.

### 4.2 Deliverable state selection

Selection occurs in one tenant-scoped `RepeatableRead` transaction. A `200` or
`304` requires exactly one approved, database-active, currently effective
schema-v3 row for the exact tenant/facility, with:

- finite `effectiveUntil`;
- valid immutable approval evidence;
- no active-row ambiguity;
- no current superseding successor;
- non-revoked and non-compromised policy key;
- current monotonic policy/revocation floors;
- exact action-registry row binding; and
- successful checksum and signature verification.

A signed policy whose document says `activation.mode = shadow` is deliverable.
Shadow is a C4.2 evaluation posture, not a lifecycle absence, and C4.3 still
must not use it to authorize capture. This route does not change shadow to
enforce.

### 4.3 Typed absence and failure states

Errors use the standard backend error envelope with a stable top-level `code`.
They never include a policy document, signature, policy ID, staff identity,
tenant details, or database state.

| HTTP | Code | Meaning |
|---|---|---|
| `403` | `CONTINUITY_POLICY_FACILITY_FORBIDDEN` | The authenticated Staff context cannot access the requested facility |
| `404` | `CONTINUITY_POLICY_NOT_PUBLISHED` | No approved schema-v3 action policy has been published for the authorized facility |
| `409` | `CONTINUITY_POLICY_NOT_ACTIVATED` | A schema-v3 policy exists but no row is yet lifecycle-active/effective for delivery |
| `410` | `CONTINUITY_POLICY_SUPERSEDED` | The last deliverable row is retired/superseded and no current successor can be served |
| `410` | `CONTINUITY_POLICY_REVOKED` | The applicable policy authority or signing key is revoked/compromised |
| `503` | `CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED` | Stored checksum, canonicalization, registry binding, signature, ambiguity, or trusted database time failed closed |

Authentication, API-key, validation, RBAC, and rate-limit failures retain their
existing platform codes.

The state precedence is authorization, exact facility, revoked, superseded,
unactivated, not-published, and internal integrity. That order prevents an
unauthorized caller from learning policy lifecycle.

Backend security-event logging records stable reason codes for cross-facility
attempts, revoked/superseded use attempts, active-row ambiguity, checksum
mismatch, signature failure, and canonicalization failure. Details are bounded
to non-PHI identifiers already available from authenticated server context.
Normal `200`, `304`, not-published, and not-yet-activated outcomes are metrics,
not security-event noise.

## 5. Approved source inventory

No source is authoritative until C4.3 verifies the exact inner policy signature,
audience, checksums, effective window, registry, and floors. Transport
authentication narrows who supplied bytes; it does not replace signing
authority.

### 5.1 Source matrix

| Source | When usable | Transport and authorization | Required provenance | Governing records |
|---|---|---|---|---|
| Authenticated backend route | Stable authenticated readiness reports public or internal backend reachability | Existing API key + Staff JWT; AF server-owned facility context; HTTPS through the C2.1 same-host endpoint state | Source kind, route posture, endpoint revision, tenant/facility audience, Staff/device/session context, fetch time, trusted time, ETag, full-body digest, HTTP status | C-D3 action classification; C-D4 normal backend auth; C-D13 split-horizon hostname/certificate/flat current-next pins; C-D14 facility context |
| C3.3 verified encrypted cache | The complete set was previously verified and atomically cached; current user is reauthorized; pack and policy windows remain valid | No network transport at open; secure cache binding, named session/local unlock rules, trust bundle, and secure witness are rechecked | Publication set, composition/manifest/policy/registry/revocation floors, pack content hash, envelope digest, original authenticated source provenance, cache binding, current unlock/session evidence, trusted-time witness | C-D2 pack freshness; C-D3 action classification; C-D4 named-user and 12-hour offline authorization; C-D10 device loss/wipe and at-most-24-hour pack expiry; C-D14 facility context |
| Existing C3.2b LAN edge mirror | Backend readiness is unavailable, the exact location pack is reachable, and provisioned mTLS/facility/location authorization is complete | Existing HTTPS GET/HEAD `pack.json` surface only; mandatory client certificate; exact unrevoked signed grant matching tenant/facility/location/Staff/device/certificate/policy/access revision | Edge source kind, gateway identity/trust revision, certificate fingerprint, grant/access revision, location, pack hash/signing key, envelope digest, trusted time | C-D2 pack freshness; C-D3 action classification; C-D4 named-user/no-generic-account posture; C-D10 device loss; C-D14 facility binding; the landed C3.2b mTLS/grant contract |

C-D13 governs the public/internal backend origin. It is not silently reused as
authority for the separate C3.2b edge gateway. The edge uses C3.2b's mandatory
mTLS server/client trust and signed grant contract.

### 5.2 Source selection

Selection is deterministic and single-source:

1. use the authenticated backend route while readiness says that route is
   stable;
2. when backend readiness is unavailable, use the existing edge `pack.json`
   only if every C3.2b credential, grant, location, clock, and transport
   precondition is present;
3. otherwise evaluate the already verified cached last-known-good state.

Bytes from different sources are never merged. A lower-version source cannot
replace a higher verified floor. A failed preferred source may fall through
only after its request is cancelled or conclusively unavailable; concurrent
responses from a prior user, tenant, facility, or session are discarded.

The current Staff checkout does not yet have a production C3.2b source,
provisioned mTLS lifecycle, trusted edge locator, or edge server trust
installation. `MtlsClientService` is only a hook and presently documents an
ordinary-client fallback. That fallback is forbidden here. The edge source
therefore remains typed unavailable until AF/C6.1-B provisioning supplies all
of those values. The lane may add the strict adapter and tests, but it may not
activate or fall back to non-mTLS.

### 5.3 Rejected sources

The following are never accepted:

- `GET /encounters/downtime-policy`;
- a parsed legacy `ClinicalDowntimePolicy`;
- raw database JSON or a direct database connection;
- an unsigned API response, WebSocket message, push notification, QR code,
  email, file share, environment variable, or manually imported JSON file;
- a policy reconstructed from action IDs or client configuration;
- a pack HTML render;
- an unverified or partially downloaded pack set;
- a C3.2b request without mandatory mTLS and the exact current grant;
- plain HTTP, certificate-error bypass, a non-pinned backend origin, or an
  unprovisioned edge CA;
- a device wall clock substituted for trusted time; or
- any parsed/pre-verified object supplied across the C4.3 byte-source boundary.

## 6. C3.3 pack composition

### 6.1 Current-state finding

The current signed manifest carries policy ID, version, checksum, and
revocation epoch. Each current pack's `policy` object carries only policy ID,
version, and revocation epoch. The full signed policy delivery envelope does
not ride the C3.3 pack set today.

Adding a separate `policy.json` asset is rejected because:

- the C3.2b mirror verifier enforces exact manifest asset coverage;
- the existing edge gateway exposes only the authorized location's
  `pack.json` and `pack.html`; and
- a new edge endpoint or manifest-listing surface would be a second edge design.

### 6.2 Closed pack-composition v2

The envelope is embedded in the existing signed `pack.json` content. Because
the current client treats pack schema v1 and its nested policy object as closed,
the new fields do not masquerade as a v1 additive extension.

Pack-composition v2 keeps every v1 clinical field unchanged and changes the
closed `policy` object to:

```json
{
  "id": "policy UUID",
  "version": "canonical governance version",
  "checksum": "64-lower-hex policy-document checksum",
  "revocation_epoch": "canonical governance version",
  "delivery": {
    "envelope_format": "vhhealth_clinical_continuity_policy_delivery/v1",
    "media_type": "application/vnd.vhhealth.clinical-continuity-policy+json",
    "envelope_sha256": "64-lower-hex full-envelope digest",
    "envelope_base64": "base64 of the exact backend-route body bytes"
  }
}
```

Rules are:

- pack schema v1 retains its exact old shape and remains usable only for
  read-only continuity-pack display;
- pack schema v2 requires policy schema v3 and the exact delivery object;
- `envelope_base64` decodes to the byte-identical route representation;
- `envelope_sha256` hashes those decoded bytes;
- the decoded envelope is at most 256 KiB and the complete signed pack remains
  inside the existing 2 MiB canonical-content limit;
- the outer delivery `policyId` and inner signed payload's version, checksum,
  and revocation epoch equal the surrounding pack policy fields and manifest
  policy fields;
- every pack in one publication set carries the same envelope bytes and digest;
- a missing, differing, malformed, oversized, or non-canonical envelope rejects
  policy extraction; and
- the existing pack envelope signature and content hash bind the embedded
  bytes, after which C4.3 independently verifies the inner policy signature.

The full-set C3.3 verifier compares every pack. A single authorized edge pack
cannot perform cross-pack comparison, but it still has the outer signed pack
hash plus the independently signed inner policy.

The existing edge filesystem verifier and gateway need no code or route change:
they already verify the complete signed pack content generically and serve the
same `pack.json` bytes. Backend pack producer, Staff verifier, and tests own the
v2 composition change.

No policy row is authored or activated by this slice. Pack v2 generation starts
only when a separately approved signed policy says `packSchemaVersion = 2`.

### 6.3 Merge-blocking compatibility fixtures

Step 2 checks in real serialized fixture sets, not map literals assembled
inside one test:

1. a valid signed v2 facility set generated by the backend producer and
   publication path, presented unchanged to the unmodified pre-Step2 C3.3
   verifier in a clean baseline worktree; the result must be its existing
   stable pack-invalid reason, with no exception, pack display, cache write,
   witness advance, or partially accepted asset; and
2. a correctly signed pack declaring `pack_schema_version = 1` whose nested
   `policy` object contains v2 delivery fields; the upgraded verifier must
   reject it as a closed-v1 shape violation even when all hashes and signatures
   are otherwise valid.

The fixture generator also emits an exact valid v1 control and valid v2 control
so the negative results cannot be explained by broken signing data. Backend and
Dart tests consume the same checked-in byte fixtures and assert the same
composition decision. The receipt records the baseline SHA used for the
unupgraded-client run. These four fixtures and their cross-runtime results are
merge-blocking receipts.

## 7. One C3.3/C4.3 trust path

This lane extends, and never forks:

- `ClinicalContinuityTrustStore`;
- `ClinicalContinuityVerifier`;
- `ClinicalContinuityCache`;
- the secure monotonic witness;
- C4.3's action-policy verifier and immutable decision snapshot; and
- C4.3's `StaffActionPolicySource` and repository.

The verified trust bundle retains the already validated policy-signing key.
Every source passes exact bytes into the same C4.3 verifier. The verifier
requires:

- exact delivery format and closed JSON;
- RFC 8785 canonical outer and payload bytes;
- policy schema v3;
- exact tenant/facility audience;
- a trusted policy-signing key and public-key hash;
- a valid Ed25519 signature;
- exact policy-document, registry, action, and schema checksums;
- a finite effective interval under the shared trusted clock;
- non-revoked and non-compromised key state;
- exact supersession lineage;
- supported device posture and application minimum version; and
- the existing compiled action inventory and transport ceiling.

### 7.1 Monotonic witnesses

One opaque tenant/facility witness persists the greatest accepted:

- pack-composition version;
- policy version;
- action-registry version;
- revocation epoch; and
- trusted time.

The composition value is the positive integer `packSchemaVersion` signed inside
the policy document and repeated as `pack_schema_version` in each signed pack.
Before v2 has been witnessed, a v2-capable client may continue to accept an
exact closed v1 pack for its existing read-only display path, but v1 supplies
no action-policy authority. Once v2 is verified from any approved source, the
witness advances to 2 and every later v1 pack is rejected as a composition
rollback even if its other signatures and versions remain valid.

Manifest and access-revision floors remain in their existing C3.3/C3.2b
locations and are checked when the source is a pack. No source-specific
composition, policy, registry, revocation, clock, trust store, or cache is
added.

Source change, cache eviction, logout, application update, `304`, network
failure, or a lower signed response never lowers a witness. A v1-shaped pack
with v2 fields, a v2-shaped pack without its exact closed delivery object, an
irreconcilable witness loss, or any rollback fails through the existing
pack-invalid/unavailable path without partial persistence or display.

### 7.2 Last-known-good behavior

A previously verified action policy may remain the immutable decision snapshot
only until the earliest of:

- its signed `effectiveUntil`;
- the enclosing pack expiry when it came from a pack;
- the current named-user/session or local-unlock authorization expiry;
- AF facility-context expiry or mismatch;
- the edge grant/certificate expiry when it came from the edge;
- a witnessed supersession or revocation; or
- a trust-bundle/key-state change that invalidates it.

Network failure never extends any deadline. An online-delivered verified policy
retained in C4.3's cache is last-known-good state derived from an approved
source, not a fourth transport source.

Possessing a verified policy, including a last-known-good policy, does not
override C-D4's current full-backend-outage read-only posture. This delivery
slice does not authorize an offline write or activate C4 capture.

A backend `410` immediately makes the live decision unavailable and preserves
the old bytes only as quarantined evidence. It does not advance the secure
revocation floor because an HTTP error is not a signed revocation artifact.
Only a verified signed policy/trust/pack update advances that witness.

## 8. Refresh, retry, and lifecycle

The adapter reuses C2.2 stable authenticated readiness and the existing C3.3
refresh lifecycle. It adds no connectivity observer.

Refresh triggers are:

- immediately after authenticated login and AF facility-context establishment;
- immediately on application foreground;
- immediately after an explicit facility switch;
- immediately when readiness changes into a stable public/internal route;
- immediately after a trust-bundle or signed policy-change notification; and
- periodically while stable readiness remains true.

The periodic interval is 15 minutes with full per-cycle jitter in the closed
13-to-17-minute range. This reuses C3.3's existing 15-minute refresh intent and
spreads fleet load; it does not alter policy or pack validity.

Transient failures use single-flight retries with full jitter and ceilings of
5 seconds, 15 seconds, 30 seconds, 60 seconds, and 5 minutes. `Retry-After` is
honored only within the 5-minute ceiling. Authentication or facility-context
failure does not retry until context changes. Revoked, superseded, malformed,
rollback, or signature failures do not retry as transient failures.

Logout, revocation, user switch, tenant switch, facility switch, application
background cancellation, or repository disposal invalidates the generation
token and discards late responses. There is never more than one active fetch
for one tenant/facility/session.

## 9. Supersession and pending work

When a newly verified policy supersedes the current snapshot, the repository
publishes one immutable policy-change signal containing only old/new signed
identity, checksum, registry, revocation, and effective-window evidence.

The delivery adapter does not mutate queue rows and does not decide replay.
C4.3's action gateway re-evaluates display, persistence, lease, and send against
the new decision. Pending rows retain the exact captured policy, registry,
action, schema, facility, and fingerprint pins from C4.1/C4.2.

C4.2/C5.1's server evaluator remains the only authority that may find exact
historical compatibility. A pending row that no longer has exact compatibility
moves to its typed `needs_review` path. The adapter may signal re-evaluation; it
may not rewrite, auto-submit, discard, widen, or relabel the row.

## 10. Readiness checksum echo assessment

This slice does **not** add a policy-checksum echo to readiness.

The current readiness v1 response is tenant-scoped while action policies are
facility-scoped. One tenant may have several current facility checksums, so a
single value would be ambiguous. The strict current client response parser
would also reject an uncoordinated field. AF already owns readiness v2 and its
facility-context contract.

The policy route's signed payload plus strong
checksum-and-representation ETag provides the exact facility-scoped change
detector needed by this adapter. If readiness later needs a checksum for
orchestration, AF's facility-resolved v2 contract must add it through its own
reviewed ledger. This lane does not assume it.

## 11. Expected Step 2 file ledger

This is the clearance ceiling. Exact paths must be revalidated after AF and
C4.3 merge. A substituted or additional runtime path requires a revised delta.

### 11.1 Add — backend

- `apps/backend/src/controllers/downtime/clinicalContinuityPolicyDeliveryController.js`
- `apps/backend/src/routes/downtime/clinicalContinuityPolicyDeliveryRoutes.js`
- `apps/backend/src/services/downtime/clinicalContinuityPolicyDeliveryService.js`
- `apps/backend/src/validators/clinicalContinuityPolicyDeliveryValidator.js`
- `apps/backend/scripts/openapi/schemas/clinicalContinuityPolicyDelivery.mjs`
- `apps/backend/src/tests/clinical-continuity-policy-delivery.deep.test.js`
- `apps/backend/src/tests/helpers/clinicalContinuityPolicyDeliveryFixtures.js`
- `apps/backend/src/tests/unit/clinicalContinuityPolicyDeliveryService.test.js`

### 11.2 Modify — backend

- `apps/backend/src/app.js` for the one authenticated route mount
- `apps/backend/src/config/rateLimitProfiles.js` for the dedicated limiter
- `apps/backend/src/services/downtime/clinicalContinuityPolicyService.js` to
  construct and retain the verified canonical delivery representation from the
  already selected row
- `apps/backend/src/services/downtime/continuityPackProducers.js` for closed
  pack-composition v2
- `apps/backend/scripts/generate-openapi.mjs` for exactly one schema-module
  import and one `SCHEMA_MODULES` registry entry
- `apps/backend/scripts/openapi/buildSpec.mjs`
- `apps/backend/src/docs/openapi.json` as generated output
- focused existing policy, producer, orchestration, publication, and edge-mirror
  tests

The design does not add a second pack orchestrator, publisher, signer, edge
verifier, gateway, or route.

### 11.3 Add — core

- `packages/vhhealth_core/lib/services/clinical_continuity_policy_delivery.dart`
- `packages/vhhealth_core/test/clinical_continuity_policy_delivery_test.dart`
- `packages/vhhealth_core/test/fixtures/continuity_policy_delivery/v1_valid.snapshot.json`
- `packages/vhhealth_core/test/fixtures/continuity_policy_delivery/v2_valid.snapshot.json`
- `packages/vhhealth_core/test/fixtures/continuity_policy_delivery/v1_masquerading_v2.snapshot.json`
- `packages/vhhealth_core/test/fixtures/continuity_policy_delivery/v2_missing_delivery.snapshot.json`

### 11.4 Modify — core

- the landed C4.3
  `packages/vhhealth_core/lib/models/clinical_continuity_action_policy.dart`
- `packages/vhhealth_core/lib/models/clinical_continuity.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_trust_store.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_verifier.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_cache.dart`
- `packages/vhhealth_core/lib/services/http_client.dart` for conditional raw-byte
  GET headers without reserialization
- `packages/vhhealth_core/lib/services/mtls_client_service.dart` for a strict
  no-fallback edge-client path
- `packages/vhhealth_core/lib/vhhealth_core.dart`
- `packages/vhhealth_core/swagger/openapi.json` as generated synced output
- focused existing trust-store, verifier, cache, HTTP, mTLS, and canonical JSON
  tests

### 11.5 Add — Staff

- `apps/staff/test/core/services/staff_action_policy_delivery_source_test.dart`

The planned standalone delivery-source file was not needed after rebasing onto
the landed C4.3 seam. The implementation remains additive in
`staff_action_policy_source.dart`, so the unused add path is dropped from the
final ledger rather than created for symmetry.

### 11.6 Modify — Staff

- the landed C4.3
  `apps/staff/lib/core/services/staff_action_policy_source.dart`
- the landed C4.3
  `apps/staff/lib/core/services/staff_action_policy_repository.dart`
- `apps/staff/lib/core/services/api_client.dart` for exact bytes and
  `If-None-Match`
- `apps/staff/lib/features/clinical_continuity/services/staff_continuity_repository.dart`
  for verified pack-v2 extraction only
- `apps/staff/lib/main.dart` for unavailable-by-default production wiring after
  readiness/facility gates pass
- focused existing C3.3 and C4.3 repository/bootstrap/lifecycle tests

There is no clinical feature screen, action attachment, offline queue schema,
replay, reconciliation, Patient, Admin, migration, Prisma, infrastructure,
deployment, provisioning, policy-authoring, receipt, or activation file in the
ledger.

## 12. Step 2 verification receipts

Step 2 retains command logs under:

```text
D:\Dev\_codex\artifacts\logs\<date>\continuity-policy-delivery\
```

### 12.1 Backend and wire contract

- refreshed prerequisite SHAs, merge states, open-PR state, worktree collision
  check, and three-dot overlap receipts;
- canonical byte parity across publication fixture, database row, route body,
  pack base64, and client fixture;
- 256 KiB delivery-envelope and existing 2 MiB signed-pack boundary tests,
  including atomic publication refusal rather than a partial set;
- stored inner policy checksum, full-body `Content-Digest`, and Ed25519
  verification proofs;
- merge-blocking identity and gzip wire captures through the mounted Express
  stack, including API key, JWT, tenant/RLS, RBAC, AF facility context,
  compression, content type, transfer encoding, and stored-checksum equality;
- exact content type, checksum-plus-representation `ETag`, cache headers,
  conditional-list/weak/`*` semantics, same-checksum/new-representation
  behavior, and `304` no-body tests;
- proof that revocation, supersession, expiry, and integrity checks run before
  `304`;
- API-key, JWT, role, default-tenant, cross-tenant, wrong-facility, malformed
  facility, rate-limit, RLS, and AF-context tests;
- typed not-published, unactivated, superseded, revoked, and integrity states;
- no success-envelope wrapping and no PHI logger/body logging;
- OpenAPI generation, drift, core sync, Spectral, and contract tests;
- unchanged C4.2 policy/action-binding tests;
- the four real v1/v2 cross-runtime compatibility fixtures from section 6.3,
  including an unmodified baseline-client run, masquerading-v1 rejection,
  controls, and composition-version witness rollback;
- full-set byte agreement and unchanged C3.2b edge verification/gateway surface;
- backend format/lint, raw-parameter lint, Prisma validation, schema drift,
  focused unit/deep tests, and full backend Jest shards; and
- dependency, secret, Semgrep, and CodeQL checks applicable to the diff.

### 12.2 Core and Staff

- strict delivery-envelope JSON, canonicalization, duplicate-key, size/depth,
  signature, checksum, audience, effective-window, supersession, registry,
  revocation, and app/posture tests;
- composition/policy/registry/revocation/trusted-time rollback tests across
  every source transition;
- v1 pack display without policy authority and v2 exact envelope extraction;
- online, edge, cached, and last-known-good source selection with no byte
  merging;
- mTLS absence, invalid certificate/grant/location, and ordinary-HTTP fallback
  denial;
- `If-None-Match`, valid `304` reuse, missing-cache unconditional recovery,
  digest mismatch, and response reserialization rejection;
- login, foreground, readiness transition, jitter, backoff, logout, revocation,
  user/tenant/facility switch, cancellation, and late-response tests with fake
  clock and injected randomness;
- supersession notification and pending-row re-evaluation without adapter-owned
  mutation;
- unchanged C0A containment, C2.2 lifecycle, C3.3 cache, and C4.3 action-gateway
  suites;
- `melos run format`;
- `melos run analyze`;
- `melos run test`;
- Staff localization health and `i18n_guard_test.dart`;
- Android Staff release APK and app-bundle builds; and
- Windows Staff release build.

### 12.3 Intent and hygiene

- `git diff --check`;
- exact `git diff --name-status github/main...HEAD`;
- zero migration and Prisma-schema diff;
- zero C5.1 file overlap;
- no edge gateway or route change;
- no policy seed/approval/activation change;
- no deployment; and
- no merge by this lane.

## 13. Rollback

Rollback restores the unavailable production source and removes the backend
route and pack-v2 producer support. It does not:

- delete or rewrite a policy row, approval, signature, trust root, pack,
  witness, queue row, receipt, or audit evidence;
- lower a composition, policy, registry, manifest, access, revocation, or
  trusted-time floor;
- reinterpret a v2 pack as v1;
- re-enable the unsigned downtime-policy getter;
- fall back from mTLS to ordinary edge HTTP; or
- activate capture.

Existing pack-schema-v1 read-only cache behavior remains available under its
own signed window only before the device has witnessed composition v2. A device
that has witnessed composition v2 or a higher policy/registry/revocation floor
remains fail-closed after rollback until compatible signed authority is
restored.

## 14. Explicit non-goals

This slice provides:

- no migration, Prisma model, RLS, grant, or database lifecycle change;
- no new policy, registry, action ID, action schema, route binding, approval,
  authoring, countersignature, shadow-to-enforce transition, or facility
  activation;
- no second signature, trust store, key registry, canonicalizer, verifier,
  cache, witness, clock, or policy evaluator;
- no use of the unsigned legacy downtime getter;
- no second edge design, edge endpoint, manifest listing, gateway, verifier,
  credential authority, certificate provisioning, CA installation, or
  non-mTLS fallback;
- no new readiness contract or checksum echo;
- no offline-action widening, capture attachment, queue mutation, replay
  receipt, idempotency behavior, command-effect transaction, or
  reconciliation decision;
- no automatic submission, deletion, rewriting, or re-scoping of pending work;
- no Patient or Admin change;
- no deployment; and
- no merge.

## 15. Coordinator clearance record

The coordinator approved these Step 2 decisions on 2026-07-31:

1. one canonical delivery envelope containing the exact existing signed
   payload and stored signature, with the current UUID explicitly
   carrier-bound rather than falsely described as policy-key-signed;
2. vendor `+json` media type, canonical UTF-8 body,
   checksum-plus-representation ETag, full-body `Content-Digest`, and
   post-verification `304`;
3. one Staff-only, API-key/JWT authenticated, AF facility-resolved, rate-limited,
   PHI-free backend GET family;
4. the typed not-published, unactivated, superseded, revoked, and integrity
   outcomes;
5. only the backend, verified cache, and conditionally usable existing C3.2b
   edge sources, with every other source rejected;
6. closed pack-composition v2 embedding the byte-identical envelope in existing
   `pack.json`, with no edge surface change;
7. one C3.3/C4.3 trust, verifier, cache, witness, and monotonic-floor path;
8. 15-minute refresh with 13-to-17-minute jitter, bounded retry, and no validity
   extension;
9. supersession signaling with C4.2/C5.1 retaining sole `needs_review`
   authority;
10. no readiness checksum echo and AF readiness v2 as a wiring prerequisite;
11. zero DDL/Prisma expectation and zero C5.1 overlap; and
12. the exact file ceiling, receipt matrix, rollback behavior, and non-goals.

Approval remains subject to the four merge-blocking conditions in section 0.
AF #668 and C4.3 have since landed and the coordinator supplied the Step 2 GO
SHA. The remaining serialization gate is C5.1: this branch stays draft, must
rebase onto C5.1 if it lands first, and must rerun the combined shared-service
focused suites before readiness. It must not be merged or deployed by this
lane.

## 16. Step 2 implementation receipts

The implementation was built from `5f96f39fe`, whose parent chain is pinned to
`888de6c06605b3ec22f0bbdc35c0bea966b8c4e6`. Logs are under
`D:\Dev\_codex\artifacts\logs\2026-07-31\continuity-policy-delivery\`.

### 16.1 Contract and focused gates

- The four checked-in fixtures cover valid v1, valid composition v2,
  masquerading v1, and v2 missing delivery. An unmodified verifier at the
  exact Step 2 base accepted v1 and rejected v2 as one invalid set; the current
  verifier accepts valid v2, rejects masquerading v1, and persists the
  composition floor.
- The mounted authenticated Express proof exercises API key, JWT, tenant and
  role middleware, facility resolution, compression, chunked transfer, the
  exact vendor media type, full-body digest, inner policy checksum, post-check
  `304`, and auth denial without a service call.
- Twelve continuity-focused backend suites pass 214 tests. The exact grouped
  CI contact chunk passes 60 tests after removing an unnecessary delivery-size
  export dependency from a commonly mocked policy module.
- Core focused tests pass 115 tests. Staff focused tests pass 30 tests. The
  Staff i18n guard passes 24 tests.
- `melos run format`, `melos run analyze`, and `melos run test` pass. The Staff
  analyzer retains 15 pre-existing informational lints; the canonical
  `--no-fatal-infos` gate succeeds. The workspace test run includes 887 Staff
  tests with one intentional skip.
- OpenAPI generation produces 3,611 operations over 3,166 paths; backend/core
  drift checks and Spectral succeed. Flutter client generation writes no
  outputs beyond its existing FHIR exclusions.
- Backend lint succeeds with zero ESLint warnings and clean raw-parameter,
  tenant/PHI, default-tenant, region, and secret guards. Prisma validation and
  schema drift succeed after rebuilding the isolated local test database.
- The full gitleaks worktree scan succeeds. Fixture assets remain byte-exact
  and are serialized as path/content records so the `edge-access.json` path is
  not falsely coupled to its high-entropy base64 content by the generic-key
  heuristic.
- Staff release APK and app bundle builds pass with the repository-compatible
  JDK 17 toolchain. The Windows release build passes from an exact short-path
  worktree; its executable SHA-256 is
  `4F36172C95FA07DB2EBE43C923FA7698203C519853521EBFFDE9A9D65D271FF5`.
- Core and Staff `flutter pub get --enforce-lockfile` succeed with no lockfile
  delta. Staff localization health is informational and reports no orphan
  calls or hardcoded-English heuristic hits.

### 16.2 Broad backend matrix

The exact three-shard CI topology was run against three independent databases
created with the workflow's `ci-setup-db.mjs` and comprehensive seed. This run
found and closed one delivery composition defect: a sibling suite mocked the
shared policy service without a newly imported size constant. The exact eight
suite chunk now passes 60/60, and the final continuity-focused set passes
214/214.

Two broad local failures remain on files unchanged by this branch:

- `clinicalContinuityEdgeAccessMigration.deep.test.js` asserts an existing
  migration's textual `FORCE ROW LEVEL SECURITY` shape; and
- `immunisation-linkage-reconciliation.deep.test.js` observes the Windows
  `Asia/Calcutta` timestamp rather than its UTC literal.

The intent diff is empty for both tests and the referenced migration. These are
reported, not adapted in this scope; GitHub's Linux/UTC checks remain the
authoritative broad gate after draft publication.

### 16.3 Intent, overlap, and hold

- The tracked diff from `5f96f39fe` contains no Prisma schema or migration
  path. Prisma and DDL remain zero as a build-time assertion.
- `generate-openapi.mjs` changes by exactly two added lines: one module import
  and one `SCHEMA_MODULES` entry. `buildSpec.mjs` remains necessary for the
  vendor response content type and typed `304` response; it was not touched for
  symmetry.
- Against C5.1 PR #670 at
  `6b297a78a0f465102a545fd0bea0d04e267aa759`, this lane has 42 files and C5.1
  has 24. The sole overlap is the coordinator-declared
  `clinicalContinuityPolicyService.js`; this lane's representation builder is
  additive. The formerly overlapping existing unit test is restored to its
  Step 2 base content.
- C5.1 is still open and unmerged at this receipt. This branch therefore stays
  draft. If C5.1 lands first, the second-lane rule requires a rebase onto its
  merge SHA and a focused combined-service rerun before the draft may be
  marked ready. Any non-additive collision is surfaced rather than resolved
  locally.
- No policy, registry, activation, migration, Prisma, deployment, or merge
  action was performed.
