# C2.2 split-horizon DNS and client-readiness design delta

**Packet:** J / C2.2
**Status:** Step 1 design only — coordinator clearance required before implementation
**Baseline:** `github/main` at
`ed5167385d44853b4f0adae497a62c92418340de` (2026-07-30 00:44:58 +05:30)
**Branch:** `feat/continuity-c2-2-client-readiness`
**Implementation/deployment status:** none
**Migration delta:** zero; the live migration high-water mark is `600`

## 1. Outcome

C2.2 will make `connectivity_plus` a wake signal only. An authenticated,
fail-closed readiness exchange will become the mandatory precondition for every
offline-queue drain. The exchange will prove the expected API identity, the
public/internal route kind, tenant routing, backend and database readiness,
C3.1 policy-schema compatibility, and a server-time sample. A failed startup or
wake probe will not inspect, mutate, or increment the retry count of any
clinical queue row.

The slice also supplies inert BIND 9 split-horizon templates and an operator
runbook. The templates render exact private A records for
`api.vhhealth.app` and each explicitly onboarded `<slug>-api.vhhealth.app`
host only in the managed-clinical view. They do not contain a wildcard, do not
deploy DNS, and do not invent the C2.1 private address.

The shipped-pin evidence and undecided C-D13 options are recorded separately in
[`c2-2-cd13-pin-inventory.md`](c2-2-cd13-pin-inventory.md). That evidence does
not make a trust decision.

## 2. Authority and fixed boundaries

This delta implements:

- plan §5, C2.2;
- design §5.2, §5.6, and C-D13;
- the C2.1 private controller/VIP as the routing target; and
- the C3.1 schema-version contract already merged on `main`.

It preserves these boundaries:

1. No live DNS, ingress, certificate, VPN, MDM, or resolver change occurs in
   this slice's implementation or tests.
2. No trust-model choice is made. Pin handling remains one flat accepted set,
   exactly as it is today; C2.2 only makes the existing set rotation-safe by
   requiring an overlapping production set.
3. No WAN-removal or resolver-failure drill is executed. The runbook describes
   commands and evidence collection for a later authorized drill.
4. No C4 action policy is enforced.
5. No database or Prisma migration is required.
6. `ConnectivitySyncService.isOnline` retains its existing meaning:
   interface-level transport availability. Existing callers are not silently
   redefined as backend-ready.

## 3. Coordinator clearance conditions

Implementation must not start until the coordinator explicitly clears all of
the following:

### 3.1 Trusted route-kind provenance

The current backend and same-host contract cannot distinguish a public request
from a C2.1 internal request by Host, URL, tenant, certificate, or backend
process: those are intentionally the same. C2.1's cleared delta does not yet
define a trusted per-request route-kind signal.

C2.2 therefore sequences behind C2.1 and adds a controller-owned
`X-VH-Route-Kind` request header:

- the public controller overwrites any caller-supplied value with `public`;
- the C2.1 internal controller overwrites it with `internal`; and
- the readiness endpoint rejects a missing or unknown value in production.

This is controller configuration, not a client header. The existing backend
NetworkPolicy keeps normal API traffic behind the ingress namespace. C2.2's
contract test must prove both controller values and prove that caller input is
overwritten.

If the coordinator assigns this marker to C2.1 instead, the two C2.2 ingress
ledger entries below are removed only after C2.1 exposes the same tested
contract.

### 3.2 Clock tolerance is owner input

The governing design requires a “tolerable clock state” but provides no numeric
maximum skew. Repository values for SSO assertion skew, MAR timestamps, and
backup snapshots belong to different threat models and are not authority for
clinical drain readiness.

C2.2 will add the production build input
`CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS`. Production clients fail closed when
it is missing, invalid, or exceeded. The security/operations owner must supply
the approved value at clearance; engineering will not copy or invent one.

### 3.3 C-D13 remains unsigned

The security owner must choose a C-D13 trust option before split-horizon
activation. C2.2 may build inert DNS templates, readiness, and current/next
overlap support before that decision, but no private DNS record or internal
certificate may be activated.

## 4. C0A containment invariants

C2.2 extends the current drain entry and does not replace or reorder the C0A
safety model.

The production order is:

1. refuse while the session barrier is active;
2. require an authenticated current owner;
3. require interface transport;
4. run or refresh the authenticated readiness exchange;
5. re-check the session barrier and capture owner;
6. enter the existing scoped C0A drain; and
7. preserve the existing per-row containment, encryption-version, tenant,
   capture-owner, partition, retry, and logout/session checks.

No readiness failure can call:

- `OfflineQueue.unresolvedEntriesForCurrentOwner`;
- `OfflineQueue.readBodyForReplay`;
- `OfflineQueue.incrementRetryOrExhaust`;
- `OfflineQueue.markConflict`; or
- a queued clinical endpoint.

`connectivity_sync_c0a_test.dart` remains unedited. Its test reset installs an
explicit always-ready readiness probe so the existing C0A assertions and HTTP
request counts remain byte-for-byte equivalent. New C2.2 tests inject strict
success and failure probes independently.

HTTP `401` or a session-owner change during readiness or drain follows the
existing session-expiry and C-D7 path. C2.2 must not catch and downgrade it to
an ordinary connectivity failure.

## 5. Operator DNS artifacts

### 5.1 Required inputs

The renderer accepts an operator-owned inventory containing:

- resolver A and resolver B identities;
- managed clinical VLAN/SSID source CIDRs;
- guest/patient/non-clinical source CIDRs;
- the C2.1 private IPv4 address;
- an owner-approved positive and negative TTL; and
- an explicit FQDN list containing `api.vhhealth.app` plus every currently
  onboarded `<slug>-api.vhhealth.app` host.

The example inventory contains placeholders only. Rendering fails if the
private address, either resolver, either view's CIDRs, TTLs, or the apex host is
absent. It rejects wildcard hosts, duplicate hosts, non-VH-Health names,
overlapping clinical/non-clinical CIDRs, public/multicast/loopback VIPs, and
invented AAAA values.

### 5.2 BIND view behavior

The same reviewed inventory is rendered independently on two redundant BIND 9
resolvers.

- The managed-clinical view loads one exact-host authoritative zone per
  inventoried FQDN. The apex has an A record pointing at the C2.1 private
  address. Because the exact-host zone contains no AAAA record, an AAAA query
  returns authoritative NODATA and cannot fall through to a stale public IPv6
  answer.
- The guest/patient/non-clinical view has no private zone and resolves the
  public answer through the operator's normal upstream path.
- No `*.vhhealth.app` or `*-api.vhhealth.app` wildcard is generated.
- Both resolvers serve the same serial and host inventory. The runbook requires
  comparison of their rendered hashes before an authorized rollout.

DHCP/MDM for managed clinical networks must advertise only the two hospital
resolvers. If one fails, the other continues. If both fail, name resolution
fails; clients keep transport and continuity states separate, readiness closes,
and no queue drains. The template does not configure a public DNS fallback.

### 5.3 Runbook coverage

The runbook includes read-only diagnosis and later authorized rollback for:

- resolver A/B disagreement and stale zone serials;
- stale A records;
- stale public or private AAAA answers;
- client and resolver caches;
- private DNS-over-TLS / DNS-over-HTTPS bypass;
- corporate and personal VPN DNS capture;
- Android Private DNS in Off, Automatic, and provider-hostname modes;
- managed SSID/VLAN versus guest/patient resolution checks;
- route-kind readiness confirmation after DNS resolution; and
- withdrawing private records before any C2.1 ingress rollback.

The commands are examples that require operator substitution and approval.
They do not run as part of C2.2.

## 6. C-D13 pin handling without a trust decision

The current production contract is a single comma-separated
`CERT_PIN_HASHES` define. `SecurityConfig` parses one flat list and
`CertificatePinner` accepts a certificate whose SPKI matches any member. There
is no per-host, public/internal, current/next, or tenant distinction.

C2.2 preserves that trust model:

- one flat set remains the only runtime acceptance set;
- production configuration requires at least two distinct, well-formed
  `sha256/<base64>` SPKI pins so a current and next key overlap;
- duplicate or malformed pins and a one-pin production build fail before
  release/runtime use;
- release workflows, the tenant helper, and both Windows update paths validate
  and pass the same flat set;
- no real pin value or key material is committed; and
- tests prove old+next acceptance and safe removal only after a release has
  carried the next pin.

The overlap requirement is rotation safety, not a C-D13 decision. If the
security owner chooses same-host union trust, that flat set will contain the
approved public and internal current/next keys and inherits the union risk. If
the owner chooses a different trust model, a later cleared slice changes the
model before activation.

## 7. Backend readiness contract

### 7.1 Route and authentication

`GET /api/v1/health/client-readiness` is mounted separately from the public
monitoring routes and uses, in this order:

1. API-key validation;
2. JWT authentication;
3. tenant context;
4. tenant RLS;
5. all-staff RBAC;
6. a dedicated tenant-aware readiness limiter that does not inherit the global
   health-route skip; and
7. the readiness handler.

Unauthenticated requests return the existing `401` posture. Unauthorized tenant
or role requests retain the existing `403` posture. The dedicated limiter
returns the standard `429` envelope and `Retry-After`.

### 7.2 Response

The success envelope contains only:

```json
{
  "readinessContractVersion": 1,
  "ready": true,
  "endpointId": "vhhealth-api",
  "routeKind": "public",
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "database": "ready",
  "policy": {
    "state": "compatible",
    "schemaVersion": 1
  },
  "serverTime": "2026-07-30T00:00:00.000Z"
}
```

The route kind may also be `internal`. The tenant ID is an infrastructure
identifier and is returned so the authenticated client can compare it with its
baked tenant identity.

The service runs a bounded database probe inside the resolved tenant/RLS
context and reads the active C3.1 policy metadata through
`loadActiveClinicalContinuityPoliciesForTenant`. It never returns a database
host, name, topology, latency, SQL text/error, policy body, facility, patient,
staff, or clinical value.

Not-ready responses use a stable low-information state drawn from:

- `endpoint_unverified`;
- `database_unavailable`;
- `policy_unavailable`; or
- `policy_incompatible`.

They return `503` with the contract version, `ready: false`, route kind when
trusted, server time when available, and the stable state only. Internal
exceptions are logged through the existing sanitizer and never serialized.

### 7.3 Client checks

The client accepts readiness only when all of these are true:

- HTTPS and the existing certificate pinner succeeded;
- the endpoint ID and readiness contract version are exact;
- route kind is one of `public` or `internal`;
- response tenant ID equals `TenantConfig.id`;
- `ready` and database state are positive;
- the C3.1 policy schema equals a supported client schema;
- server time is valid and the midpoint-adjusted local skew is within the
  owner-provided threshold; and
- no auth/session change occurred during the exchange.

Unknown/missing/extra-enum values, invalid timestamps, a wrong tenant, an
unsupported policy schema, and all malformed/error responses fail closed.

## 8. Client state machine

### 8.1 Separate state axes

The service exposes two independent axes:

- **Transport:** `unknown`, `available`, `unavailable`, derived only from
  `connectivity_plus`.
- **Continuity lifecycle:** `signedOut`, `checking`, `notReady`,
  `clockUncertain`, `policyIncompatible`, `readyPublic`, `readyInternal`,
  `rateLimited`, `syncing`, and `reviewRequired`.

The transport state is never called “backend online.” `isOnline` remains a
compatibility accessor for transport only.

### 8.2 Wake, debounce, and hysteresis

- Connectivity events, authenticated login/startup, manual Sync Now, and
  `retryConflict` are wake sources.
- Interface events are coalesced with a 750 ms debounce.
- A transport loss or any failed/malformed/auth/tenant/policy/clock probe closes
  readiness immediately and resets the success streak.
- Opening a closed readiness gate requires two matching successes, separated
  by at least one second. Both must report the same endpoint, tenant, route
  kind, and policy schema.
- Once open, every new drain entry performs a fresh authenticated probe; one
  matching success refreshes the open gate.
- `429 Retry-After` suppresses readiness re-probes until the indicated instant.
  It never increments a clinical retry counter.
- Only one readiness probe and one drain may be in flight. Later wakes coalesce
  into one follow-up evaluation.

These timing constants are technical anti-flap defaults, injectable in tests,
and do not define a clinical offline policy. The clock-skew threshold remains
owner input.

### 8.3 Queue behavior

The gate is checked before `_isSyncing` enters the existing clinical-drain
section and before queue enumeration. Manual Sync Now and retry-conflict cannot
bypass it. After the gate opens, the current C0A drain code runs without changes
to classification, partition barriers, retry exhaustion, idempotency keys,
owner scoping, or session barriers.

## 9. Staff connection UI and i18n

The existing app-bar badge and sync sheet remain the entry point. The sheet
shows separate labeled rows:

- `Transport — available/unavailable`; and
- `Continuity — checking/not ready/clock uncertain/policy incompatible/ready
  via public/ready via internal/rate limited/syncing/review required`.

Pending, conflict, and review counts remain separate queue-lifecycle evidence.
The Sync Now action is enabled only when transport is available, an
authenticated session exists, and the readiness gate can be evaluated; pressing
it always runs the gate.

All new strings are supplied in English, Hindi, Tamil, Telugu, and Malayalam.
The i18n guard verifies key parity and prevents an English fallback from hiding
a missing connection-state translation. Widget tests assert the two state axes
in visible text and semantics, not color alone.

## 10. Exact file ledger

No file outside this ledger may be edited without a new coordinator clearance.

### 10.1 Step 1 — design packet only

| Action | File | Purpose |
|---|---|---|
| ADD | `docs/continuity/c2-2-client-readiness-design-delta.md` | This delta |
| ADD | `docs/continuity/c2-2-cd13-pin-inventory.md` | Signable shipped-pin evidence and undecided C-D13 options |
| MODIFY | `docs/continuity/c0-4-owner-decision-dossier.md` | Link the evidence under C-D13 without filling an owner-input field |

### 10.2 DNS and operator runbook

| Action | File | Purpose |
|---|---|---|
| ADD | `infra/onprem/dns/c2-2/README.md` | Inert artifact boundary and operator inputs |
| ADD | `infra/onprem/dns/c2-2/managed-hosts.example.json` | Placeholder-only resolver/view/VIP/host inventory |
| ADD | `infra/onprem/dns/c2-2/templates/named.conf.views.tmpl` | Clinical and non-clinical BIND views |
| ADD | `infra/onprem/dns/c2-2/templates/private-host.zone.tmpl` | Exact-host A zone with authoritative AAAA NODATA |
| ADD | `infra/onprem/dns/c2-2/render.mjs` | Validating, non-deploying renderer |
| ADD | `infra/onprem/dns/c2-2/test/contract.test.mjs` | View/host/A/AAAA/failure/static safety contract |
| ADD | `docs/continuity/c2-2-split-horizon-dns-runbook.md` | Resolver, cache, bypass, Android, validation, and rollback runbook |

### 10.3 C2.1 route-kind sequencing

| Action | File | Purpose |
|---|---|---|
| MODIFY | `infra/kubernetes/base/ingress-nginx/ingress-nginx.yaml` | Public controller overwrites route kind with `public` |
| MODIFY AFTER C2.1 | `infra/kubernetes/base/ingress-nginx-internal/controller.yaml` | Internal controller overwrites route kind with `internal` |
| ADD | `infra/kubernetes/qa/c2-2-route-kind-contract.mjs` | Prove both markers and caller-header overwrite |

The internal-controller path is declared in C2.1's cleared future ledger and
does not exist on this Step 1 baseline. C2.2 must rebase after C2.1 lands and
modify, never recreate, that file.

### 10.4 Backend and OpenAPI

| Action | File | Purpose |
|---|---|---|
| ADD | `apps/backend/src/services/health/clientReadinessService.js` | Low-information endpoint/tenant/DB/C3.1 policy evaluation |
| ADD | `apps/backend/src/controllers/health/clientReadinessController.js` | Thin HTTP mapping and sanitized failure envelope |
| ADD | `apps/backend/src/routes/health/clientReadinessRoutes.js` | Authenticated, RBAC- and limiter-protected route |
| MODIFY | `apps/backend/src/routes/health/index.js` | Mount readiness separately from public health routes |
| MODIFY | `apps/backend/src/config/rateLimitProfiles.js` | Dedicated readiness profile |
| MODIFY | `apps/backend/src/middleware/rateLimitMiddleware.js` | Do not apply the generic health skip to that profile |
| ADD | `apps/backend/scripts/openapi/schemas/clientReadiness.mjs` | Typed request/response contract overlay |
| MODIFY | `apps/backend/scripts/generate-openapi.mjs` | Register the readiness schema module |
| MODIFY GENERATED | `apps/backend/src/docs/openapi.json` | Canonical generated backend spec |
| MODIFY GENERATED | `packages/vhhealth_core/swagger/openapi.json` | Byte-identical client spec |
| ADD | `apps/backend/src/tests/unit/clientReadinessService.test.js` | Ready/fail-closed/low-information service cases |
| ADD | `apps/backend/src/tests/client-readiness.deep.test.js` | Auth, tenant, route, DB, policy, no-PHI, rate-limit runtime contract |
| MODIFY | `apps/backend/src/tests/rateLimit.test.js` | Prove readiness cannot inherit the health-route skip |

There is no migration, Prisma schema, seed, or C3.1 policy-service edit.

### 10.5 Shared Flutter readiness and UI

| Action | File | Purpose |
|---|---|---|
| ADD | `packages/vhhealth_core/lib/config/client_readiness_config.dart` | Endpoint/contract/policy constants and owner-provided skew input |
| ADD | `packages/vhhealth_core/lib/models/client_readiness.dart` | Strict response parser and transport/lifecycle enums |
| ADD | `packages/vhhealth_core/lib/services/client_readiness_service.dart` | Authenticated probe, midpoint clock check, hysteresis, Retry-After |
| MODIFY | `packages/vhhealth_core/lib/services/connectivity_sync_service.dart` | Wake/debounce and mandatory pre-drain readiness gate |
| MODIFY | `packages/vhhealth_core/lib/vhhealth_core.dart` | Export new config/model/service |
| MODIFY | `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart` | Visible transport-versus-continuity state separation |
| ADD | `packages/vhhealth_core/test/client_readiness_test.dart` | Parsing, endpoint, tenant, policy, time, Retry-After fail-closed cases |
| ADD | `packages/vhhealth_core/test/connectivity_sync_readiness_test.dart` | Refused drain, zero retry burn, debounce/hysteresis/session behavior |
| ADD | `packages/vhhealth_core/test/offline_sync_connection_state_test.dart` | Two-axis visible and semantic UI contract |

`packages/vhhealth_core/test/connectivity_sync_c0a_test.dart` is deliberately
not in the ledger and must remain unedited.

### 10.6 Pin overlap and build paths

| Action | File | Purpose |
|---|---|---|
| ADD | `scripts/validate-cert-pin-set.mjs` | Strict flat-set syntax, uniqueness, and current/next overlap check |
| MODIFY | `packages/vhhealth_core/lib/config/security_config.dart` | Fail closed on fewer than two valid production pins |
| MODIFY | `packages/vhhealth_core/lib/services/certificate_pinner.dart` | Consume the validated deduplicated flat set; no host/route roles |
| MODIFY | `packages/vhhealth_core/test/security_config_test.dart` | Production overlap validation cases |
| MODIFY | `packages/vhhealth_core/test/certificate_pinner_test.dart` | Both overlap pins accepted; malformed/removed pins rejected |
| MODIFY | `scripts/build-tenant-client.sh` | Require production mode, flat overlap pins, and clock-skew input |
| MODIFY | `scripts/build-staff-windows-update.ps1` | Validate/pass pins and clock-skew input |
| MODIFY | `scripts/update-local-staff-windows-app.ps1` | Validate/pass pins and clock-skew input |
| MODIFY | `.github/workflows/release-staff.yml` | Validate Staff pins/skew before Android and Windows releases |
| MODIFY | `.github/workflows/release-patient.yml` | Validate Patient pins/skew before Android releases |
| MODIFY | `.forgejo/workflows/release-staff.yml` | Mirror Staff release validation |
| MODIFY | `.forgejo/workflows/release-patient.yml` | Mirror Patient release validation |
| MODIFY | `apps/staff/README.md` | Correct the documented Windows production build inputs |

No pin value, certificate, private key, trust bundle, or generated release
artifact is added.

### 10.7 Staff localization

| Action | File | Purpose |
|---|---|---|
| MODIFY | `apps/staff/lib/l10n/app_strings.dart` | Five-locale transport/readiness/lifecycle strings |
| MODIFY | `apps/staff/test/i18n_guard_test.dart` | Key parity and visible connection-state coverage |

The Staff wrapper badge and `staff_scaffold.dart` require no C2.2 edit.

## 11. C3.3 ledger overlap and sequencing

C3.3 froze its Step 1 ledger on the same baseline and reconciled the reciprocal
overlap in follow-up commit `11331af4d`.
The exact overlap is three files:

1. `packages/vhhealth_core/lib/vhhealth_core.dart`;
2. `apps/staff/lib/l10n/app_strings.dart`; and
3. `apps/staff/test/i18n_guard_test.dart`.

Sequence:

1. C2.2 implements and lands first after its own clearance.
2. C3.3 rebases onto that result.
3. C3.3 preserves the readiness exports and every connection-state string/test,
   then adds its cache/verifier exports and localization.
4. C3.3 consumes readiness/trusted-clock context only through its injected
   `ClinicalContinuitySource`; it adds no `connectivity_plus` listener and no
   wake, debounce, hysteresis, or pre-drain behavior.

There is zero overlap with C3.3's `staff_scaffold.dart`, `tenant_config.dart`,
`secure_blob.dart`, `pubspec.yaml`, `pubspec.lock`, navigation, cache, verifier,
print, display, or integration-test files. There is zero C3.3 edit to either
offline-sync badge, `ConnectivitySyncService`, `ConnectivityService`,
`OfflineQueue`, `OfflineWriteContainment`, `OfflineWriteEntry`, Staff
`AuthService`, `SessionRevocationListener`, or `SessionTimeoutProvider`.

Any newly discovered shared file requires a new coordinator clearance before
either implementation changes it.

## 12. Verification gates and receipts after clearance

### 12.1 Static and operator artifacts

- render two independent resolver outputs from test fixtures;
- `named-checkconf` and `named-checkzone` on every rendered exact-host zone;
- `node --test infra/onprem/dns/c2-2/test/contract.test.mjs`;
- `node infra/kubernetes/qa/c2-2-route-kind-contract.mjs`; and
- the repository Kubernetes manifest validator/kustomize build gate.

No DNS query is sent to a live hospital resolver.

### 12.2 Backend

- targeted unit and deep tests from the ledger;
- full backend lint and test gates;
- `npm run openapi:generate`;
- `npm run openapi:sync-core`;
- `npm run openapi:check`;
- `npm run openapi:check-core`;
- Spectral validation; and
- the canonical backend CI gate.

The receipt must include authenticated success, unauthenticated `401`,
wrong-tenant/role refusal, `429` with `Retry-After`, DB and policy failure,
route-marker rejection, and a response-key/no-PHI assertion.

### 12.3 Flutter and Staff

- formatting;
- full workspace analyze and test gates;
- `vhhealth_core` readiness, C0A, pin, and widget tests;
- Staff i18n guard and widget tests; and
- explicit proof that failed startup/readiness probes leave clinical row retry
  counts and C0A state unchanged.

Receipts identify the exact SHA, commands, exit codes, and artifact/log paths.

## 13. Activation and rollback

Implementation remains inert until:

- C2.1 is landed and its owner-provided VIP is present;
- both resolver identities, view CIDRs, TTLs, and full host inventory are
  approved;
- C-D13 is signed;
- current and next pins are supplied to every production release path;
- clock-skew tolerance is supplied;
- the readiness endpoint and client are deployed in public mode first; and
- an authorized later change enables private DNS.

Rollback order is:

1. stop/withhold client drain by failing readiness;
2. withdraw private DNS records and flush managed resolver caches;
3. confirm managed clients resolve the public route;
4. only then roll back the C2.1 internal ingress/VIP; and
5. retain the current+next pin overlap until all released clients have moved
   beyond the removed key.

This packet authorizes none of those operational actions.

## 14. Coordinator decision

**Owner:** coordinator
**State:** awaiting clearance
**Required response:** approve the ledger and sequencing, assign the
route-marker owner, and provide or explicitly route the clock-skew owner input.
