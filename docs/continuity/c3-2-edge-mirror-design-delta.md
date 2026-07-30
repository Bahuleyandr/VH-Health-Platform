# C3.2 durable publication and independent edge mirror — cleared design delta

**Status:** coordinator-cleared 2026-07-29
**Build split:** C3.2a backend substrate now; C3.2b infrastructure and edge
runtime later
**Baseline:** `github/main` at kickoff, re-fetched as
`ed5167385d44853b4f0adae497a62c92418340de`
**Activation posture:** inert and fail-closed

## 1. Structural ruling and safety boundary

C3.2 is one design with two separately reviewable builds. Plan rule 3 requires
each slice to have its own design delta, file ledger, tests, rollback, and
coordinator review. A combined backend-plus-infrastructure pull request is
therefore refused.

C3.2a contains only:

- the database migration and Prisma alignment;
- signed policy-schema v2 support;
- edge-access grant, revocation, and receipt services;
- reusable mirror verification and signed grant-set publication;
- source-side signed-retention purge;
- the two operator command-line tools;
- continuity metric primitives;
- the legacy static-route credential cutover and deprecation;
- backend tests; and
- this complete design record.

C3.2b is a later, separate pull request. It owns:

- durable shared RWX storage and the backend/CronJob mounts;
- the independently powered continuity-edge component and its held
  manifests/automation;
- edge disk encryption, pull-only replication, local authorization and
  tamper-evident access-log runtime;
- monitoring and alert rules;
- continuity-edge runbooks and outage drills; and
- the `GO_LIVE` H1 rewrite.

Nothing under `infra/**` may change in C3.2a. C3.2a does not deploy, provision a
key, create a credential, seed a grant, seed a policy, or activate an edge.
`CLINICAL_CONTINUITY_PACKS_ENABLED` remains false by default. An absent
countersigned policy-schema v2 document blocks grant export and edge
activation.

## 2. Dependencies and owner-held decisions

C3.1 supplies the signed, facility-scoped pack and policy governance substrate:

- RFC 8785/JCS canonical serialization;
- Ed25519 signing with current/next/revoked/compromised key states;
- a closed policy-schema v1 language;
- an exact tenant/facility audience;
- manifest, policy, and revocation anti-rollback versions;
- signed per-location pack envelopes;
- exact coverage with no missing or extra location;
- immutable versioned set directories and an atomically replaced
  `current.json` pointer; and
- append-only publication evidence.

C3.2 extends this substrate; it does not weaken or reinterpret it.

The owner dossier still has no countersigned values for C-D4 (offline
authentication and revocation risk) or C-D10 (break-glass and retention).
Engineering must not invent those values. Policy schema v2 therefore requires
the following signed values with no fallback:

- the permitted authentication mode;
- the maximum offline authorization/revocation-risk window;
- credential lifetime;
- emergency-read posture;
- source pack retention;
- edge pack retention; and
- access-log retention.

The C3.2 credential substrate accepts an operator-supplied public mTLS client
certificate and stores only its SHA-256 fingerprint. It never generates,
exports, installs, or retains a device private key. This shape is consistent
with the current C-D4 recommendation: a named, recently authorized user,
device-bound access, no shared generic account, and bounded revocation risk.
It is not a substitute for the missing C-D4 decision. If C-D4 later chooses a
different authentication mechanism, the policy language and credential
contract advance to v3; existing v2 documents are not silently reinterpreted.

## 3. Non-negotiable invariants

1. Every continuity edge row has an explicit, non-default tenant and facility.
2. Every facility reference is a composite `(tenant_id, facility_id)` foreign
   key through `ux_facilities_tenant_id`.
3. Every staff/actor reference is a composite `(tenant_id, user_uid)` foreign
   key to `users (tenant_id, uid)`.
4. Tenant-aware uniqueness and indexes prevent global or cross-tenant
   discovery.
5. All three tables use `ENABLE ROW LEVEL SECURITY` and
   `FORCE ROW LEVEL SECURITY`.
6. The migration-600 Pattern-A permissive policy remains for house-tooling
   compatibility, with a restrictive explicit-context policy ANDed over it.
   Unset, empty, default-tenant, and `bypass` application tenant contexts
   match no edge-access rows.
7. Runtime roles receive only the operations needed by the C3.2a services.
   `PUBLIC` receives none.
8. Grants, revocations, and log receipts are append-only. Renewal creates a
   new grant row.
9. A revocation row is the only state transition that invalidates a grant.
   Time-window evaluation also refuses a grant outside its signed finite
   interval, but no process updates the grant to represent expiry.
10. A grant never widens across tenant, facility, location, named staff user,
    device, certificate fingerprint, policy version, or access revision.
11. No global all-tenant or all-facility index is published.
12. Every served set, grant set, and accepted access-log batch is verifiable
    without trusting filenames, clocks, or transport alone.
13. No raw pack PHI is stored in central log receipts.
14. A currently referenced set is never purged. Withdrawal of its pointer is
    atomic and precedes eligibility for purge.
15. Missing signed authentication or retention policy blocks activation; it
    never becomes a permissive default or indefinite PHI retention.

## 4. Migration 601 data design

`601_clinical_continuity_edge_access.sql` follows migration 600's
guarded/re-runnable `DO` blocks and reporting preflights. The number was
re-derived from the kickoff baseline; a later collision requires renumbering
before publication.

### 4.1 Shared access revision

`clinical_continuity_edge_access_revision_seq` supplies a positive `BIGINT`
revision to every grant and revocation. Grant creation and revocation each
advance the same monotonic sequence. A revocation therefore has an independent
revision rather than copying the revision of the grant it invalidates.

The exported facility grant set carries the highest committed access revision.
The verifier persists and enforces this value as an anti-rollback floor.
Unrelated grant renewal or revocation cannot cause another grant to disappear,
but an old grant-set artifact cannot be replayed after any newer access
decision.

### 4.2 `clinical_continuity_edge_access_grants`

Each immutable row contains:

- tenant/facility-first composite primary key
  `(tenant_id, facility_id, id)`, with a UUID row ID;
- bounded `location_type` and `location_identifier`;
- named `staff_uid`;
- bounded opaque `device_id`;
- lower-case 64-hex mTLS client-certificate SHA-256 fingerprint;
- finite `valid_from` and `valid_until`, with the latter strictly later;
- pinned `policy_version_id` and `policy_version`;
- monotonic `access_revision`;
- operator `created_by`; and
- database `created_at`.

The pinned policy reference is tenant/facility aware and must identify the
exact countersigned schema-v2 policy used to authorize the grant. The service
also proves that validity length does not exceed that policy's signed
credential lifetime and stays inside the supplied Ed25519 public
certificate's validity window.

An unconditional `BEFORE UPDATE OR DELETE` trigger rejects mutation. Renewal
re-runs all authorization checks and inserts a new row with a new ID and access
revision. It may reuse the same public certificate fingerprint, named staff
user, device, and location when that is the operator's intended renewal.

Indexes begin with tenant and facility. Query support is limited to:

- exact tenant/facility export ordered by access revision;
- exact tenant/facility/location authorization;
- exact tenant/facility/staff/device/fingerprint authorization; and
- exact tenant/facility/policy provenance.

There is no fingerprint-only, device-only, user-only, or global active-grant
index.

### 4.3 `clinical_continuity_edge_access_revocations`

Each immutable row contains:

- tenant/facility-first composite primary key
  `(tenant_id, facility_id, id)`, with a UUID row ID;
- the exact `grant_id`;
- a separately allocated monotonic `access_revision`;
- named `revoked_by`;
- database `revoked_at`; and
- a non-blank bounded `reason`.

The composite grant reference includes tenant and facility. A tenant-aware
unique constraint permits exactly one revocation per grant. An unconditional
`BEFORE UPDATE OR DELETE` trigger rejects mutation.

Authorization treats a grant as usable only when all exact scope fields match,
the trusted time is within its finite validity interval, its pinned policy is
still the policy being evaluated, its access revision is not below a persisted
floor, and no same-tenant/same-facility revocation exists. Revoking one grant
does not invalidate another grant that happens to share a user, device,
certificate, or location.

### 4.4 `clinical_continuity_edge_log_receipts`

Each immutable receipt contains only verification evidence:

- tenant/facility-first composite primary key
  `(tenant_id, facility_id, id)`, with a UUID row ID;
- bounded opaque `device_id`;
- the authorizing `grant_id` and certificate fingerprint;
- signed policy ID/version and access revision;
- a bounded opaque `batch_id`;
- previous batch hash, nullable only for the first batch;
- canonical batch hash;
- event count;
- first and last event sequence;
- first and last event timestamp;
- signature algorithm and signature hash/evidence;
- importer actor and database receipt time.

It contains no raw pack, patient, encounter, ward-census, clinical, or local
access-log event body. Tenant-aware uniqueness on `(tenant_id, facility_id,
device_id, batch_id)` and on the canonical batch hash makes replay an
idempotent no-op only when all supplied evidence is identical. A conflicting
duplicate is rejected. An unconditional `BEFORE UPDATE OR DELETE` trigger
preserves the receipt.

## 5. Signed policy schema v2

The closed C3.1 document advances from schema version 1 to version 2. Every v1
field and exact-shape validation remains. V2 adds exactly two signed top-level
objects:

```json
{
  "edgeAccess": {
    "authenticationMode": "mtls_client_certificate",
    "maximumOfflineAuthorizationMinutes": 0,
    "credentialLifetimeMinutes": 0,
    "emergencyReadPosture": "owner_supplied"
  },
  "retention": {
    "sourcePackRetentionHours": 0,
    "edgePackRetentionHours": 0,
    "accessLogRetentionHours": 0
  }
}
```

The zeroes and `owner_supplied` text above are schema placeholders, not
accepted values. The parser requires explicit approved positive integer
durations and an approved posture. It does not insert defaults. The only
implemented v2 credential shape is `mtls_client_certificate`; supplying any
other mode fails closed and requires a v3 design/build.

The parser enforces:

- schema version 2 exactly for edge operations;
- an exact tenant/facility audience;
- a positive maximum offline authorization window;
- a positive credential lifetime no shorter than that window;
- an explicit bounded emergency-read posture from the supported closed set;
- positive source, edge, and access-log retention values; and
- the existing C3.1 coverage, freshness, field, key, approval, signature, and
  anti-rollback rules.

Schema-v1 policies remain valid for C3.1 pack generation where already
supported. They are insufficient for grant creation/export, purge, or edge
activation. No migration rewrites a v1 policy document.

## 6. Operator access service and CLI

`continuityEdgeAccessService.js` is the single service boundary for:

- parsing an operator-supplied PEM certificate and deriving its public
  certificate SHA-256 fingerprint;
- creating append-only grants under explicit tenant context;
- creating append-only revocations under explicit tenant context;
- exact-scope authorization checks;
- building a tenant/facility grant-set document; and
- ingesting verified recovered-log receipt evidence.

`scripts/continuity-edge-access.mjs` exposes operator-only `grant`, `renew`,
`revoke`, and `export` commands. Required arguments are explicit tenant,
facility, location, named staff, device, certificate path, validity interval,
policy identity, actor, and reason where applicable. It prints identifiers and
revisions, never private-key material or raw PHI.

Grant creation consumes a public certificate file. It never calls key
generation, writes a certificate, changes a trust store, or installs anything
on a device. `renew` is an insert operation, not an update alias.

There is no new HTTP route. Discovering a need for one requires stopping this
slice for coordinator amendment and running both `openapi:check` and
`openapi:check-core`.

## 7. Signed grant-set publication

Every facility publication includes a signed `edge-access.json` envelope
beside the signed manifest. Its content has:

- exact tenant/facility audience;
- policy ID/version and revocation epoch;
- current `accessRevision`;
- export time;
- only currently relevant, exact-scope grants;
- the immutable revocation evidence needed to reject revoked credentials; and
- the policy-controlled offline authorization and credential bounds.

The facility manifest names and hashes this asset, and its own signed content
also carries `accessRevision`. The atomic set publisher commits packs,
grant-set, and manifest into the same immutable set before replacing
`current.json`. A grant-set build failure aborts publication. A schema-v1
policy, absent policy value, cross-scope row, duplicate scope collision, or
ambiguous revision blocks export.

The independent edge stores its highest accepted access revision and refuses a
signed but older set. Revocation therefore propagates by publishing a greater
access revision; no online database lookup is required at read time.

## 8. Reusable mirror verifier

`continuityEdgeMirrorVerifier.js` is runtime-neutral backend code intended for
reuse by C3.2b. Given an expected root, tenant/facility audience, trusted keys,
trusted time posture, and persisted floors, it verifies in this order:

1. `current.json` exists, is regular-file content, has the exact
   `continuity-current-v1` shape, names only `sets/v<manifestVersion>`, and has
   a valid manifest SHA-256;
2. every resolved path remains beneath the expected root, contains no unsafe
   segment, and is not a symbolic-link escape;
3. manifest bytes match the pointer hash;
4. the signed manifest uses the exact C3.1 canonical envelope;
5. every C3.1 trust, key-state, key-ID, algorithm, audience, canonicalization,
   content-hash, render-hash, signature, expiry, and clock-uncertainty decision
   is preserved;
6. manifest, policy, revocation-epoch, and access-revision floors do not roll
   back;
7. declared required coverage equals produced coverage exactly;
8. every declared asset exists once, has a safe relative path, and matches its
   hash;
9. no undeclared regular file or unexpected directory appears in the immutable
   set; and
10. `edge-access.json` has the same tenant, facility, policy, revocation epoch,
    and access revision as the manifest.

The verifier returns a stable `{ ok, reason, ...evidence }` decision. It
preserves all C3.1 verification reasons:

`INVALID_ENVELOPE`, `UNSUPPORTED_ALGORITHM`, `KEY_ID_MISMATCH`,
`KEY_NOT_TRUSTED`, `KEY_REVOKED`, `KEY_COMPROMISED`,
`KEY_STATE_UNSUPPORTED`, `KEY_INVALID`, `AUDIENCE_REQUIRED`,
`AUDIENCE_MISMATCH`, `CONTENT_HASH_MISMATCH`, `RENDER_HASH_MISMATCH`,
`RENDER_REQUIRED`, `SIGNATURE_INVALID`, `POLICY_ROLLBACK`,
`MANIFEST_ROLLBACK`, `REVOCATION_EPOCH_ROLLBACK`,
`ROLLBACK_STATE_REQUIRED`, `PACK_EXPIRED`, `CLOCK_UNCERTAIN`, and
`CANONICALIZATION_FAILED`.

C3.2-specific structural failures use stable additional reasons for pointer
shape/hash, unsafe path, symlink escape, manifest hash, missing/extra asset,
asset hash, coverage, grant-set mismatch, and access-revision rollback.
Metrics consume these reason strings without rewriting them.

## 9. Recovered access-log import

`scripts/ingest-continuity-edge-logs.mjs` accepts a recovered signed batch file
and explicit operator actor. The batch envelope binds:

- tenant, facility, device, grant, certificate fingerprint, policy, and access
  revision;
- a batch ID;
- first/last event sequence and timestamp;
- previous batch hash;
- a canonical hash of the event payload; and
- an Ed25519 signature by the authorized client credential or the
  policy-approved logging key defined by the final v2 contract.

Before any receipt insert, the importer:

1. verifies canonical shape and bounded size;
2. verifies tenant/facility/grant/device/certificate scope;
3. verifies the signature and canonical batch hash;
4. verifies the grant was valid and unrevoked for the batch's signed access
   revision and time window;
5. requires sequence `1` for the device's genesis batch, then verifies each
   bounded event's sequence, the declared contiguous range, and the
   previous-batch hash against the latest receipt for that exact device scope;
6. refuses an access revision that the facility has not issued; and
7. resolves replay idempotently.

An exact already-ingested batch returns the existing receipt. A reused batch ID
with different evidence, a hash-chain gap, an unknown future access revision,
or a cross-scope batch is rejected. Historical batches created before a later
revocation remain admissible only when their signed event window ends before
that revocation; a fabricated future revision is rejected. Only the receipt
evidence from §4.4 is written centrally.

## 10. Legacy `/downtime/static` route

The legacy route is explicitly deprecated. Responses carry deprecation
headers, documentation labels it legacy-only, and its handlers continue to
serve only the root legacy `index.html` and `ward-<id>.html` files. It never
indexes, resolves, redirects to, or falls through to the tenant/facility
`continuity-v1` signed set layout.

The monitoring-token fallback is removed. If neither
`DOWNTIME_ACCESS_TOKEN` nor its retained dedicated alias is configured,
authorization fails closed with `DOWNTIME_AUTH_REQUIRED` in every environment.
A monitoring token never authorizes this PHI surface.

**Pre-sync operator warning:** after C3.2a is synced, legacy ward packs go dark
on the next sync unless `DOWNTIME_ACCESS_TOKEN` is provisioned first. That is
an operator choice to make before syncing, not an outage-time surprise.
C3.2a does not provision the token and does not sync or deploy the change.

## 11. Metrics contract

`continuityMetrics.js` defines bounded in-process primitives for:

- `vhhealth_continuity_pack_fresh_until_timestamp_seconds`;
- `vhhealth_continuity_verification_failures_total{reason}`;
- `vhhealth_continuity_coverage_complete`;
- `vhhealth_continuity_edge_last_sync_success_timestamp_seconds`; and
- `vhhealth_continuity_edge_replication_lag_seconds`.

The backend sets pack freshness and coverage after a successful atomic
publication, and increments verification failures on stable verifier reasons.
C3.2b sets the edge sync and lag metrics from the edge runtime. C3.2a ships no
Prometheus rule or alert threshold.

## 12. Signed-retention purge

Source purge is policy-driven and has no engineering fallback duration:

1. load and verify the exact active schema-v2 policy under explicit tenant
   context;
2. derive source retention only from
   `retention.sourcePackRetentionHours`;
3. read and validate `current.json` before selecting candidates;
4. exclude the currently referenced immutable set unconditionally;
5. treat withdrawn/revoked sets as candidates once the signed retention rule
   permits; an unexpired pack timestamp is not an independent preservation
   rule;
6. remove only complete versioned sets inside the exact
   tenant/facility root; and
7. refuse purge on an absent/invalid policy, malformed pointer, unsafe path,
   symlink, uncertain reference, or concurrent pointer change.

Atomic pointer withdrawal must complete before a formerly served set becomes
purgeable. Missing approved retention blocks edge activation instead of
retaining PHI indefinitely. Rollback never reconstructs purged PHI.

## 13. C3.2b edge and infrastructure design

The later C3.2b pull request consumes, without weakening, C3.2a's verified
contracts.

### 13.1 Durable source publication

Backend and generator mount the same durable RWX volume at the configured
continuity root. The volume is not pod-local temporary storage. Publication
keeps the C3.1 immutable-set-plus-atomic-pointer protocol. Kubernetes
identities receive only their required read/write paths.

### 13.2 Independent edge

The edge is separately powered and remains useful with backend, PostgreSQL,
Kubernetes, Cloudflare, and internet unavailable. It pulls from the source;
the source never mounts or writes edge storage. Replication uses separate,
scoped machine credentials and the verifier from §8 before advancing the local
pointer.

The edge:

- stores encrypted pack bytes and sensitive metadata;
- keeps no global tenant index;
- authorizes the exact tenant/facility/location/named-user/device/certificate
  tuple from the signed grant set;
- persists policy, manifest, revocation, and access-revision floors;
- refuses expired or clock-uncertain content according to signed policy;
- appends tamper-evident access logs locally;
- exports signed hash-chained log batches for later central receipt import;
- purges packs and logs only by the signed v2 retention values; and
- can retrieve and print only after verification and exact-scope
  authorization.

The component and manifests remain held until C-D4 and C-D10 are countersigned,
credentials are provisioned, and the facility activation gate explicitly
opens.

### 13.3 Monitoring, runbooks, and proof

C3.2b owns alerts for freshness, verification failure, coverage, last sync,
and replication lag. Runbooks cover certificate provisioning/rotation,
revocation publication, clock uncertainty, failed verification, log recovery,
retention, edge loss, and rollback.

Its acceptance drill stops backend and database, isolates internet, and proves
authorized retrieval/printing from the edge. It also proves corrupt,
unsigned, partial, rolled-back, expired, wrong-audience, revoked-credential,
and cross-tenant sets fail closed.

## 14. C3.2a file ledger

### Add

- `docs/continuity/c3-2-edge-mirror-design-delta.md`
- `apps/backend/src/migrations/601_clinical_continuity_edge_access.sql`
- `apps/backend/src/services/downtime/continuityEdgeAccessService.js`
- `apps/backend/src/services/downtime/continuityEdgeMirrorVerifier.js`
- `apps/backend/src/observability/continuityMetrics.js`
- `apps/backend/scripts/continuity-edge-access.mjs`
- `apps/backend/scripts/ingest-continuity-edge-logs.mjs`
- focused unit and deep tests for the migration, verifier, access service,
  authorization, publication atomicity, log ingestion, purge, metrics, and
  legacy route

### Modify

- `apps/backend/prisma/schema.prisma`
- `apps/backend/src/services/downtime/clinicalContinuityPolicyService.js`
- `apps/backend/src/services/downtime/clinicalContinuityPackOrchestrationService.js`
- `apps/backend/src/services/downtime/continuityPackPublicationService.js`
- `apps/backend/src/app.js`
- `apps/backend/src/middleware/infrastructureAccessMiddleware.js`
- `apps/backend/src/routes/downtime/staticDowntimeRoutes.js`
- `apps/backend/src/routes/metrics/metricsRoutes.js`
- `apps/backend/scripts/seed-comprehensive-test-data.mjs` to declare the
  three inert edge-access tables intentionally empty instead of synthesizing
  credentials or evidence
- existing focused tests/fixtures only where schema-v2 or legacy expectations
  require alignment

### Forbidden in C3.2a

- every path under `infra/**`;
- any new HTTP route, controller, validator, or OpenAPI path;
- generated or installed device keys;
- seeded policy, grant, revocation, receipt, credential, or activation row;
- deployment, ArgoCD sync, or go-live documentation activation.

## 15. Test and gate ledger

Focused tests prove:

- grant update and delete are rejected at the database;
- renewal succeeds only by inserting a new row/revision;
- revocation is immutable, independently revisioned, and one-per-grant;
- a revoked credential fails while unrelated grants remain valid;
- scope cannot widen across user, device, unit, facility, or tenant;
- policy schema v1 cannot export grants or activate an edge;
- absent C-D4/C-D10 values fail closed with no default;
- certificate handling stores a fingerprint and never generates a key;
- every C3.1 verifier reason remains reachable;
- pointer, manifest, per-asset hashes, exact coverage, safe paths, symlink
  escape, missing files, and extra files are checked;
- policy, manifest, revocation, and access-revision anti-rollback floors hold;
- no global index or cross-tenant discovery exists;
- exact duplicate log batches are idempotent, conflicting replay is rejected,
  and a hash-chain gap is rejected;
- source purge uses only signed retention and cannot remove a referenced set;
- the legacy route fails closed without its dedicated token and never serves
  signed C3.1/C3.2 output;
- direct-SQL unset, empty, default, and bypass tenant contexts fail closed;
- migration fresh apply succeeds and guarded re-apply is a no-op; and
- Prisma matches the migrated database.

Required gates:

```text
npm run lint
npm run check:schema-drift
targeted continuity unit/deep suites
full Jest
git diff --check
```

`openapi:check` and `openapi:check-core` are required only if the slice is
amended to add a route. Under this cleared design, no route is added.

## 16. Rollback and operator handoff

Rollback is a forward safety floor:

- keep `CLINICAL_CONTINUITY_PACKS_ENABLED=false`;
- never drop migration 601 or its grants, revocations, receipts, sequences,
  triggers, policies, or constraints;
- preserve all C3.1 policies, keys, publications, and evidence;
- never restore the monitoring-token fallback;
- withdraw a bad pointer atomically rather than serving an earlier unverified
  set;
- retain anti-rollback floors;
- do not activate the edge without countersigned v2 policy; and
- never reconstruct purged PHI.

Before any later sync, the operator must consciously choose whether legacy ward
packs should remain reachable. If yes, provision `DOWNTIME_ACCESS_TOKEN`
before the sync. If not, accept that the deprecated legacy route will go dark.
C3.2a records this warning in the pull request and documentation and performs
no sync or deployment.
