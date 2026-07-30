# C3.3 Staff continuity cache and verifier — client design delta

**Status:** Step 1 design delta; implementation is not cleared
**Scope:** `packages/vhhealth_core` and `apps/staff` only
**Branch:** `feat/continuity-c3-3-staff-cache`
**Baseline:** `github/main` and `origin/main` at
`ed5167385d44853b4f0adae497a62c92418340de` (2026-07-30)
**Release state:** inert and default-OFF
**Merge state:** never merge from this slice

## 1. Outcome and authority

This slice adds a read-only Staff continuity cache, an independent client
verifier, ward/paediatric/ED/OPD display, and printing. It does not add offline
authentication, offline writes, an action registry, trust-root generation, or a
transport.

The binding authority is:

- plan section 6, C3.3;
- design sections 5.3 and 5.5;
- C3.1 as merged in PR 641, including the signed envelope and manifest
  contracts, Ed25519 over RFC 8785/JCS, current/next keys, revocation epochs,
  monotonic policy and manifest versions, exact refusal states, and the C-D2
  display floor;
- C3.2's cleared transport delta, consumed only through an injected source
  boundary;
- C-D2 as recorded in `c0-4-owner-decision-dossier.md`;
- the still-open C-D4, C-D10, and C0.3 owner rows.

No implementation may begin until the coordinator clears this delta and its
file ledger.

## 2. Hard gates and activation contract

Two independent tenant build flags are added to `TenantConfig`:

- `VH_CLINICAL_CONTINUITY_CACHE_ENABLED`, default `false`;
- `VH_CLINICAL_CONTINUITY_LOCAL_UNLOCK_ENABLED`, default `false`.

The cache flag controls prefetch, persistence, display, and printing. The local
unlock flag cannot enable local unlock by itself. Local unlock is permitted only
when all of the following are true:

1. the cache flag is enabled;
2. the local-unlock flag is enabled;
3. the signed, verified tenant/facility policy carries a complete, approved
   local-unlock contract;
4. the current device and staff session meet that contract; and
5. the current time is trusted.

The following C-D4 values remain `OWNER INPUT` and have no client defaults:

- local-unlock duration;
- maximum authorization age or revocation-risk window;
- emergency-access rule and eligible roles;
- any additional local re-authentication factor or attempt/lockout rule.

An absent, incomplete, zero-valued-as-placeholder, malformed, or unverifiable
C-D4 contract denies local unlock. Engineering will not infer a usable value.
With C-D4 open, the implemented local-unlock component remains present but
default-OFF and returns a typed policy-unavailable denial.

C-D10 device-loss command authority, delivery timing, offline retention, and
lost-device behavior also remain `OWNER INPUT`. This slice exposes a governed
wipe primitive but does not invent or activate a remote-wipe policy.

Staff has real Android and Windows desktop projects, so both platforms receive
build and test evidence. Every relevant C0.3 inclusion cell is still
`OWNER INPUT`; therefore this slice makes no Android, Windows, browser, iOS, or
facility release-support claim. A green build or test does not widen C0.3.

## 3. Inputs and trust boundaries

### 3.1 Provisioned trust

The client consumes the C3.1
`vhhealth_clinical_continuity_trust/v1` bundle provisioned out of band by an
operator. It does not generate, download on first use, rotate, or embed a trust
root. No public or private key material, test production key, tenant key, or
facility key is committed to the repository.

The trust-store adapter accepts a provisioned bundle only from the established
secure-storage channel. The verifier validates its format, distribution marker,
tenant/facility audience, key identifiers, Ed25519 key type, SPKI encoding,
current/next states, revoked key list, minimum policy version, and minimum
revocation epoch before it is usable. Missing, malformed, cross-audience, or
internally inconsistent trust material fails closed.

Every cache open re-verifies the selected set against the currently provisioned
trust bundle. A key that was valid when prefetched but is now revoked or
compromised cannot continue to authorize display.

### 3.2 Online source

`ClinicalContinuitySource` is an injected read-only client boundary. A C3.2
adapter may implement it, or an online backend adapter may implement it while
C3.2 is unavailable. The source returns:

- the exact signed manifest envelope bytes;
- the exact `pack.json` and `pack.html` bytes named by the manifest;
- source provenance, including the transport access revision when supplied;
- current authenticated tenant, facility, named staff, role, and opaque device
  context; and
- the trusted-clock assessment supplied by the authenticated readiness layer.

This slice does not implement C3.2 grant issuance, mTLS, edge authorization,
transport retry, connectivity observation, or access-revision semantics. An
access revision is authenticated provenance and associated data, not a new
C3.3 authorization rule.

The source must not expose verified clinical objects. It exposes bytes so the
client verifier independently enforces the C3.1 contract before any storage or
display.

## 4. Prefetch and verification-before-store

Prefetch runs only when the cache flag is enabled and C2.2 reports stable
authenticated readiness. The order is fixed:

1. obtain the current session/access context and trusted-clock assessment;
2. load the operator-provisioned trust bundle;
3. fetch the signed facility manifest and its exact referenced assets into
   bounded memory or a non-persistent staging stream;
4. parse under explicit depth, node, string, byte, asset-count, and duplicate-key
   limits;
5. verify the manifest envelope;
6. enforce exact tenant/facility audience and manifest shape;
7. enforce the stored policy-version, manifest-version, and revocation-epoch
   floors;
8. reject revoked or compromised keys and unsupported key states;
9. verify manifest asset coverage, rejecting missing, duplicate, unsafe,
   unexpected, or extra assets;
10. verify every per-file SHA-256 value;
11. verify every `pack.json` envelope and its content hash, audience, signature,
    floors, and freshness;
12. verify every `pack.html` SHA-256 and match its render hash to its paired
    signed pack envelope;
13. construct the authenticated cache binding; and
14. atomically persist the complete facility set and its monotonic witnesses.

No manifest, pack, rendered HTML, patient field, partial set, or floor is stored
as a usable cache entry before all facility-set checks succeed. Staging contains
no durable plaintext and is discarded on every success or failure.

Manifest validation follows
`vhhealth_clinical_continuity_manifest/v1`. It requires the C3.1 fields and exact
facility coverage, including each location's `contentHash`, `renderHash`,
`packJsonSha256`, `packHtmlSha256`, `generatedAt`, `expiresAt`, `keyId`,
`locationId`, and `locationType`. It accepts only the C3.1 pack shapes:
`ward`, `paeds`, `ed_board`, and `opd_day`.

Unsafe logical asset paths, case-colliding names, repeated JSON object keys,
non-UTF-8 JSON, non-finite numbers, non-JCS numbers, unknown envelope versions,
and unsupported algorithms fail closed.

## 5. Client verifier

### 5.1 Cryptography and canonicalization

Ed25519 verification uses `package:cryptography` (`cryptography` 2.7.x), already
present in `vhhealth_core`. It is pure Dart, supports the Staff app's Android and
Windows targets without a platform-specific signing plugin, and exposes
verification without introducing private-key operations. The verifier accepts
only an RFC 8410 Ed25519 SPKI public key with the exact 32-byte raw key and
rejects trailing or alternate algorithm material.

The C3.1 signed projection is canonicalized with the new internal
`clinical_continuity_canonical_json.dart` RFC 8785/JCS implementation. It uses
the C3.1 limits: maximum depth 64, maximum 100,000 nodes, maximum 2 MiB canonical
UTF-8 content, and maximum 4 MiB rendered bytes. Conformance tests include the
RFC 8785 vectors, UTF-16 property ordering, escaping, ECMAScript number
serialization boundaries, duplicate keys, invalid Unicode, and the backend's
cross-runtime fixtures.

The verified envelope fields are exactly:

`algorithm`, `audience`, `content`, `contentHash`, `envelopeVersion`,
`expiresAt`, `issuedAt`, `keyId`, `manifestVersion`, `policyVersion`,
`revocationEpoch`, `renderHash`, and `signature`.

The algorithm is exactly `Ed25519`; the envelope version is exactly `1`.
Signatures are checked over the C3.1 RFC 8785/JCS projection. Content and
rendered bytes remain unavailable to callers until all checks pass.

### 5.2 Monotonic verifier persistence

For each opaque tenant/facility cache namespace, the client persists the highest
accepted:

- policy version;
- manifest version; and
- revocation epoch.

These C3.1 values are canonical decimal BIGINT strings. Dart parses and compares
them with `BigInt`; it never converts them through `double`, JavaScript-safe
integer assumptions, locale-aware parsing, leading-zero normalization, or
lexicographic ordering.

The persisted witness exists in secure storage and is mirrored inside the
encrypted cache envelope. It is updated monotonically and never reset by cache
refresh, eviction, logout, user switch, application update, or ordinary cache
repair. The verifier uses the greatest value from the provisioned trust minimum,
the secure witness, and the encrypted facility set.

A lower value is rejected as `POLICY_ROLLBACK`, `MANIFEST_ROLLBACK`, or
`REVOCATION_EPOCH_ROLLBACK`. A missing witness when an existing cache indicates
that one should exist, or disagreement that cannot be resolved monotonically,
is `ROLLBACK_STATE_REQUIRED`. A crash after advancing a witness may make the old
set unusable, but can never make an older set valid.

Only the governed device-loss wipe may remove the witnesses, and it removes the
corresponding encrypted set and encryption key in the same idempotent operation.

### 5.3 Keys, freshness, and exact refusals

Only provisioned `current` and `next` Ed25519 pack keys are accepted. Unknown,
revoked, compromised, unsupported-state, malformed, or mismatched keys fail
closed. Revocation is checked both from the trust bundle and the signed
revocation epoch.

The trusted clock is injected by C2.2's authenticated readiness/session
boundary. C3.3 does not derive trust from the device wall clock or listen to
connectivity directly. A missing, untrusted, materially backward-moving, or
otherwise indeterminate clock assessment is `CLOCK_UNCERTAIN`.

Freshness is exactly the C-D2/C3.1 model:

- 0 through 15 minutes after generation: current;
- after 15 minutes and before 24 hours: aged, with visible age badges;
- at 24 hours, at an earlier signed `expiresAt`, or later: `EXPIRED`.

`CLOCK_UNCERTAIN`, `EXPIRED`, and every verification failure are hard refusals.
No clinical content, historical mode, stale override, print action, or cached
patient count is exposed. The refusal surface uses the C3.1 wording:

- `CLOCK UNCERTAIN — this continuity pack cannot be displayed.`
- `PACK EXPIRED — this continuity pack cannot be displayed.`
- `PACK VERIFICATION FAILED — this continuity pack cannot be displayed.`
- `Use paper and phone.`

The client preserves the C3.1 reason taxonomy, including invalid envelope,
unsupported algorithm, key/audience/hash/render/signature failures, rollback
failures, expiry, clock uncertainty, and canonicalization failure.

## 6. Encrypted persistence, bounds, and lifecycle

### 6.1 Encryption envelope

The cache reuses `SecureBlobCodec` and `VHSecureStorage`. `SecureBlobCodec` gains
backward-compatible optional AES-256-GCM authenticated data and an explicit
key-destruction operation. Existing callers that omit authenticated data retain
their current format and behavior.

Each C3.3 encrypted envelope is schema-versioned. Its authenticated data binds:

- tenant identifier;
- facility identifier;
- named prefetching staff identifier and role as provenance;
- opaque device identifier;
- policy identifier and version;
- manifest version and publication-set identifier;
- revocation epoch;
- C3.2 access revision when present; and
- source revision/watermark.

Bindings are encoded as a length-delimited canonical structure, not string
concatenation. A binding mismatch is authenticated-decryption failure and fails
closed.

The external authenticated-data projection uses keyed opaque digests for the
tenant, facility, prefetching user, device, and policy bindings. The full
identifiers and human-readable provenance remain inside the ciphertext. The
cache index therefore needs no plaintext binding to re-open a row, while a
controlled user switch can authenticate the original prefetch provenance and
then independently authorize the new current user.

Database names, row keys, secure-storage labels, filesystem paths, logs, metrics,
exceptions, and semantic labels contain no plaintext patient identifier, name,
phone, medication, allergy, code status, location name, ward name, or other PHI.
Tenant/facility cache keys are opaque keyed digests. Clinical payload, manifest,
HTML, binding metadata, and human-readable provenance are inside the encrypted
envelope.

### 6.2 Atomicity and storage limits

One facility set is the atomic unit, and the database has one current slot for
each opaque tenant/facility namespace. A newly verified ciphertext replaces that
slot in one database transaction. The previous current ciphertext remains the
row visible to readers until the transaction commits; rollback preserves it.
Old bytes left by SQLite transaction/WAL mechanics are removed by the database's
secure maintenance path and are never an addressable historical set.

Technical denial-of-service bounds are fixed engineering limits, not clinical
policy:

- C3.1 canonical JSON and rendered-byte limits remain 2 MiB and 4 MiB per
  artifact;
- at most 512 manifest assets are accepted;
- at most 256 MiB is accepted for one complete encrypted facility set;
- at most 512 MiB of C3.3 encrypted facility sets is retained per device.

Capacity eviction considers complete expired sets only, oldest expiry first. It
never evicts the current valid set and never partially evicts a facility set.
An in-place verified refresh of the same facility is a transactional current-slot
replacement, not retention or eviction of a historical version. If a new
facility slot would exceed the device bound and the bound cannot be met by
deleting expired facility slots, the new prefetch is rejected. A same-facility
refresh that cannot fit is also rejected and the existing current valid set is
preserved. These limits do not relax the 24-hour validity ceiling.

### 6.3 Refresh and failure behavior

While online, the repository requests refresh:

- immediately after stable authenticated readiness;
- on authenticated login, app foreground, or facility change;
- every 15 minutes while stable authenticated readiness remains true; and
- after a trust-bundle change notification.

The repository subscribes only to C2.2's stable readiness abstraction. It does
not import `connectivity_plus`, add wake/debounce/hysteresis, alter the pre-drain
gate, or compete with pending-write draining. Refresh has one in-flight request
per tenant/facility and uses bounded backoff supplied by the transport adapter.
A failed refresh does not mutate floors or the current set; the current set may
continue only until its signed expiry.

### 6.4 User switching and access

The cached set is facility reference data, not a user's offline clinical work.
The prefetching staff identity is authenticated provenance, not ownership that
allows a later user to inherit the first user's session.

On logout, session revocation, tenant/facility switch, or controlled user switch:

1. all decrypted objects, rendered widgets, byte buffers, print buffers, and
   in-flight source requests are discarded;
2. the next user must establish a new authenticated session;
3. access is re-evaluated for the same tenant, facility, device, named staff,
   role, provisioned trust, and signed policy;
4. no previous session token, authorization result, route state, or open patient
   view is reused; and
5. the encrypted facility set remains at rest unless the governed wipe contract
   directs deletion.

While online, ordinary backend authentication and current C3.2 authorization
are required. While offline, any access depends entirely on the still-open C-D4
contract. With C-D4 incomplete or local unlock disabled, a newly switched or
logged-out user cannot display cached clinical content.

### 6.5 Device-loss wipe

The repository exposes an idempotent facility-scoped and device-wide governed
wipe operation. It clears decrypted memory, closes the continuity database,
deletes continuity rows, deletes continuity monotonic witnesses, destroys only
the continuity encryption keys, and verifies absence before acknowledging.

The wipe operation accepts only an already authenticated governed command from
the owning device-management path. C3.3 does not define how a lost device
receives that command and does not alter logout or session-revocation behavior
to pretend it is remote wipe. It never deletes C0A pending writes, conflicts,
containment evidence, or another feature's secure-storage keys.

## 7. Read-only display and print

The Staff route is a separate, read-only continuity surface reached from a
global `StaffScaffold` action. Its status is continuity-set status, not network,
transport, or pending-write status. It never says that the application is
online/offline or that queued work is safe.

Only a verified, unexpired pack is parsed for display. Every pack shows:

- a prominent `READ ONLY — CONTINUITY PACK` frame;
- facility and location context;
- generated date and time in the facility's IANA timezone with a visible zone
  label;
- current/aged status and age badge;
- signed not-valid-after time;
- per-field recorded-at time and age;
- source revision/watermark; and
- no edit, acknowledge, administer, order, sign, submit, or workflow-advance
  controls.

All dates are rendered in the facility-local timezone from the signed facility
timezone. The device timezone is never substituted. An invalid or unavailable
facility timezone fails verification/display; it does not silently fall back.
Timezone conversion uses `package:timezone` 0.11.x with the bundled IANA
database so Android and Windows apply the same named-zone rules.

The C-D2 record is displayed without weakening:

- two identifiers: name plus MRN/UID plus date of birth;
- allergies;
- code status;
- medications due;
- active medication orders;
- recently administered medications from the last 12 hours;
- unresolved critical results;
- location;
- attending clinician;
- diagnosis or chief complaint;
- vitals and NEWS2 with recorded-at time;
- recent released results; and
- care team.

Paediatric packs also show latest weight and its date. ED packs also show
arrival time, triage information, and time in department. OPD day packs show
today's appointments, allergies, active medicines, and phone number.

The exact spoken/display unknowns are:

- `Allergy status UNKNOWN — not recorded`
- `Code status NOT RECORDED — confirm per hospital policy`

Unknown status has visual, semantic, spoken, focus-order, and contrast prominence
at least equal to a positive status. The semantics label contains the exact
visible wording; it is not replaced by an icon, abbreviation, tooltip, or
colour-only state. Screen and print derive from the same verified record, and
widget tests assert display/spoken parity.

Blood group is not added. No client-generated “helpful” clinical inference,
normal/negative substitution, historical pack selector, or hidden field is
allowed.

Printing uses the exact verified signed `pack.html` bytes through
`Printing.layoutPdf` and `Printing.convertHtml`; the client does not reconstruct
clinical print content from widgets. The artifact must contain:

`Generated <date time TZ> — NOT VALID AFTER <date time TZ>, then use paper and phone.`

An OPD artifact must also contain:

`Destroy after clinic day`

Printing is unavailable for `CLOCK_UNCERTAIN`, `EXPIRED`, or any verification
failure. Tests capture the exact verified HTML supplied to the print converter
and inspect the converted artifact text.

## 8. C0A, C2.2, and C3.2 boundaries

### 8.1 C0A and C2.2 static non-edits

C3.3 has zero behavioral overlap with pending writes, offline queue drain,
containment, reconciliation, or C2.2 authenticated-readiness logic. The
following baseline blobs are explicit non-edits:

| Blob at baseline | File |
|---|---|
| `b5e860be9f661b9abd62df3db0deadcb93a9a035` | `packages/vhhealth_core/lib/services/connectivity_sync_service.dart` |
| `8172382bec0cf98574e2c712df07db0e5792d5ef` | `packages/vhhealth_core/lib/services/connectivity_service.dart` |
| `0efa513767b5a2d08bfadbb495eb9d12ab167717` | `packages/vhhealth_core/lib/services/offline_queue.dart` |
| `2b395be3b71f0b739daa1373ae7b19be68d980ce` | `packages/vhhealth_core/lib/services/offline_write_containment.dart` |
| `5dc65b2a3a73c13e988e2b5904d535762e8ebf07` | `packages/vhhealth_core/lib/models/offline_write_entry.dart` |
| `611109108f759e938af56421990c58b296215f8b` | `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart` |
| `7858748db0d1bf1cadbede278bd9c27c97a1923e` | `apps/staff/lib/core/services/auth_service.dart` |
| `5b2c6d21597002b5b12507459f1c8b28edade36d` | `apps/staff/lib/core/widgets/offline_sync_badge.dart` |
| `9bae4b420551541b88710e275458945d0175a432` | `apps/staff/lib/core/widgets/session_revocation_listener.dart` |
| `8cf929dc0f94ad9c3d418eb1b5ae413e7e6b1e3f` | `apps/staff/lib/core/providers/session_timeout_provider.dart` |

The ledger does not touch these files. After implementation, a receipt compares
each path to its post-C2.2 merge baseline and records no C3.3 diff.

### 8.2 Declared shared-file overlap and sequencing

C2.2 owns authenticated readiness, connectivity wake/debounce/hysteresis, the
pre-drain gate in `connectivity_sync_service.dart`, and
transport-versus-continuity connection-state UI. C3.3 declares only these
shared-file integration overlaps:

- `packages/vhhealth_core/lib/vhhealth_core.dart` — barrel exports;
- `apps/staff/lib/core/widgets/staff_scaffold.dart` — C3.3 adds a distinct
  continuity-cache action, never connection status;
- `apps/staff/lib/l10n/app_strings.dart` — separate C3.3 message keys;
- `apps/staff/test/i18n_guard_test.dart` — shared locale completeness guard;
- `pubspec.lock` — workspace dependency resolution only.

C2.2 should land first. C3.3 then rebases on that merge, preserves C2.2's
connection UI and translations, and injects C2.2's stable authenticated
readiness/clock context into `ClinicalContinuitySource`. C3.3 must not add a
second connectivity listener, alter C2.2 state labels, or edit the pre-drain
gate. If C2.2 needs another shared file, the coordinator must update and
re-clear this ledger before C3.3 implementation.

C3.2 owns transport. C3.3 owns only the source interface, independent client
verification, encrypted persistence, access re-evaluation, display, and print.

## 9. Exact implementation file ledger

The ledger is frozen. Step 2 may modify only the following files after
coordinator clearance. Any addition or substitution requires another design
delta and clearance.

### 9.1 Add

Core:

- `packages/vhhealth_core/lib/models/clinical_continuity.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_canonical_json.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_source.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_trust_store.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_verifier.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_cache.dart`
- `packages/vhhealth_core/test/clinical_continuity_canonical_json_test.dart`
- `packages/vhhealth_core/test/clinical_continuity_verifier_test.dart`
- `packages/vhhealth_core/test/clinical_continuity_cache_test.dart`
- `packages/vhhealth_core/test/clinical_continuity_config_test.dart`

Staff:

- `apps/staff/lib/features/clinical_continuity/services/staff_continuity_repository.dart`
- `apps/staff/lib/features/clinical_continuity/services/continuity_print_service.dart`
- `apps/staff/lib/features/clinical_continuity/screens/continuity_cache_screen.dart`
- `apps/staff/lib/features/clinical_continuity/widgets/continuity_cache_action.dart`
- `apps/staff/lib/features/clinical_continuity/widgets/continuity_pack_view.dart`
- `apps/staff/test/features/clinical_continuity/staff_continuity_repository_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_cache_screen_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_pack_view_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_print_service_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_accessibility_test.dart`
- `apps/staff/integration_test/clinical_continuity_airplane_mode_test.dart`

### 9.2 Modify

Core/workspace:

- `packages/vhhealth_core/lib/config/tenant_config.dart`
- `packages/vhhealth_core/lib/services/secure_blob.dart`
- `packages/vhhealth_core/lib/vhhealth_core.dart`
- `packages/vhhealth_core/pubspec.yaml`
- `packages/vhhealth_core/test/secure_blob_test.dart`
- `pubspec.lock`

Staff:

- `apps/staff/lib/core/navigation/app_router.dart`
- `apps/staff/lib/core/widgets/staff_scaffold.dart`
- `apps/staff/lib/l10n/app_strings.dart`
- `apps/staff/test/i18n_guard_test.dart`

### 9.3 Step 1 design-only file

- `docs/continuity/c3-3-staff-cache-design-delta.md`

No backend, admin, patient, infrastructure, offline-queue, pending-write,
containment, connectivity, or C3.2 transport file is in the ledger.

## 10. Test and evidence matrix

All clinical fixtures are synthetic.

### 10.1 Core verification

- valid current-key and next-key manifest/set;
- RFC 8785/JCS cross-runtime vectors and canonical byte parity;
- Ed25519 signature tamper;
- manifest content-hash tamper;
- `pack.json` and `pack.html` per-file hash tamper;
- render-hash mismatch;
- missing, duplicate, unsafe, and extra assets;
- unknown, malformed, revoked, and compromised keys;
- key-ID and audience mismatch;
- wrong tenant, wrong facility, wrong device binding, and wrong policy binding;
- lower policy version, manifest version, and revocation epoch;
- missing/inconsistent rollback witness;
- 15-minute current-to-aged boundary;
- exact 24-hour `EXPIRED` boundary;
- forward, backward, absent, and untrusted-clock `CLOCK_UNCERTAIN`;
- no content exposure on every refusal;
- authenticated-decryption and associated-data tamper;
- interrupted atomic replace and witness-advance crash;
- capacity rejection, expired-only eviction, and current-valid-set retention;
- trust-bundle reprovisioning and post-cache key revocation;
- governed wipe scope and idempotence;
- existing `SecureBlobCodec` caller compatibility; and
- both feature flags default-OFF with incomplete C-D4 denial.

### 10.2 Staff behavior

- airplane-mode open of a previously verified pack;
- no initial offline fetch and no unverified partial display;
- logout, revocation, named-user switch, role switch, tenant switch, and facility
  switch clear decrypted state and re-authorize;
- local unlock cannot activate while C-D4 fields are missing;
- refresh requests only after injected stable authenticated readiness;
- refresh failure retains an unexpired current set but never extends expiry;
- exact ward, paediatric, ED, and OPD shapes;
- exact unknown wording;
- visible/spoken unknown parity and prominence;
- per-field recorded-at rendering;
- generated and not-valid-after date/time in facility-local timezone with zone
  label, including a daylight-saving boundary fixture;
- current/aged badges and exact expiry refusal;
- English, Hindi, Tamil, Telugu, and Malayalam key completeness;
- text scaling, keyboard traversal, screen-reader semantics, contrast, and
  colour-independent state;
- no mutating/action-registry controls;
- print input is the exact verified HTML;
- print artifact contains the exact generated/not-valid-after/paper-and-phone
  line; and
- OPD print artifact contains `Destroy after clinic day`.

### 10.3 Gates after clearance

Step 2 runs and retains receipts for:

- `melos format`;
- `melos analyze`;
- `melos test`;
- Staff i18n guard tests;
- focused core and Staff C3.3 tests;
- Android Staff build plus the airplane-mode integration flow on an Android
  emulator/device;
- Windows Staff build plus the same airplane-mode integration flow on Windows;
- static verification that C0A/C2.2 non-edit blobs have no C3.3 diff;
- static verification that no key material or plaintext PHI fixture was added;
  and
- the repository's standard secret and dependency checks.

Command output belongs under
`D:\Dev\_codex\artifacts\logs\<date>\c3-3-staff-cache\`; platform screenshots and
UI evidence belong under the corresponding dated artifacts directories. Those
receipts are not repository source files and do not widen this ledger or the
C0.3 release claim.

## 11. Non-goals

This slice deliberately provides:

- no offline write of any kind;
- no creation, editing, acknowledgement, administration, ordering, signing,
  submitting, queueing, replaying, or workflow advancement;
- no C4 action registry;
- no local-unlock duration, revocation window, emergency role/rule, or other
  invented C-D4 value;
- no trust-root or signing-key generation;
- no embedded trust material;
- no C3.2 transport, grant, mTLS, retry, or edge implementation;
- no pending-write, containment, reconciliation, or connection-state change;
- no historical mode;
- no browser or iOS implementation;
- no device-loss policy invention; and
- no Android, Windows, facility, tenant, or cohort release-claim widening.

## 12. Clearance conditions

Coordinator clearance must confirm:

1. the exact ledger in section 9;
2. C2.2-first sequencing for the five shared files in section 8.2;
3. the injected stable-readiness and trusted-clock boundary;
4. the default-OFF/incomplete-policy-denies C-D4 treatment;
5. the Android-plus-Windows evidence scope without C0.3 widening; and
6. zero changes to every C0A/C2.2 static non-edit in section 8.1.

Until that clearance is recorded, the branch remains design-only.
