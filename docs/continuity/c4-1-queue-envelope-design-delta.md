# C4.1 queue envelope and replay state machine — design delta

**Status:** Step 1 design packet; awaiting coordinator clearance

**Authority:** implementation plan section 7 C4.1, design section 5.6, the
frozen C0.2 action inventory section 6, and the merged C0A, C2.2, and C3.3
slices

**Base re-derived at kickoff:**
`1f5c94e36623c6c392f55f85f43e03eec480f57f`

**Base commit time:** `2026-07-31T01:50:26+05:30`

**Branch:** `feat/continuity-c4-1-queue-envelope`

**Activation:** none

## 1. Outcome, scope, and parallel safety

C4.1 evolves the Staff local SQLite pending-write queue from schema v5 to v6
and adds the client-side prepared-command envelope, pre-attempt persistence
boundary, leased state machine, causal ordering, bounded retry scheduling, and
reasoned reconciliation needed by later continuity replay.

The runtime ledger is client-only:

- `packages/vhhealth_core`;
- `apps/staff`; and
- this design record.

There is no backend, server migration, Prisma, Admin, Patient, infrastructure,
policy publication, registry activation, or facility activation change.
The only schema changed by C4.1 is the Staff local SQLite queue.

PR #660 / C4.2 is open in parallel and is strictly backend plus its own design
record. C4.1 has zero runtime-file overlap with that PR. C4.1 stores only
stable action IDs and signed-authority claims; it does not reproduce C4.2's
catalogue, executable route bindings, policy evaluation, or server
enforcement. This client-only boundary is frozen.

The feature is inert until a later coordinator-cleared activation supplies a
complete signed capture context. Current Staff authentication and the C2.2
readiness response do not expose a trustworthy facility ID. C4.1 therefore
does not infer facility from tenant, department, host, or current screen text.
A C4-ready capture whose provisioned/signed facility context is absent fails
before persistence or network. The existing two C0A controls retain their
legacy compatibility behavior while activation remains off; they do not
silently become C4-authorized captures.

## 2. Existing behavior that remains authoritative

### 2.1 C0A

C0A remains the always-on lower safety boundary:

- the six contained families remain denied at enqueue and drain;
- unknown actions remain denied;
- `POST /health/records` and `PUT /emr/notes/draft` remain the only legacy
  controls;
- tenant, capture-owner, encryption, and attested-handoff checks remain;
- the drain remains partitioned by tenant, capture owner, and action family;
- the strict v5 encrypted-body decoder never falls back to plaintext after
  migration; and
- queue rows and the AES key survive idle timeout, restart, user switch,
  revocation, and logout according to the existing session barrier.

C4.1 extends this behavior. It does not reopen any contained route, widen the
two-control set, or make an attested `needs_review` row drainable.

### 2.2 C2.2

C2.2 continues to own:

- the interface-transport versus continuity-readiness state axes;
- wake coalescing and debounce;
- authenticated readiness and clock evidence;
- the mandatory pre-drain gate; and
- the session barrier around enqueue and drain.

C4.1 never sends directly from a screen. An online first attempt is scheduled
through the same `ConnectivitySyncService` path as a later replay, after C2.2
readiness succeeds and the session/capture owner are rechecked. Manual Sync
Now, conflict retry, lease recovery, and an online first attempt cannot bypass
readiness.

### 2.3 C3.3

C3.3 remains a separate signed, encrypted, read-only cache. C4.1 may record
the version and source time of a verified cache item supplied by the caller,
but it does not read clinical cache internals, change cache storage, add a
second connectivity listener, or turn cached content into authority.

### 2.4 Frozen action IDs

C4.1 accepts only the 17 stable IDs frozen in
`docs/continuity/c0-2-action-route-inventory.md` section 6, plus `unknown`:

1. `op.prescription.draft`
2. `ip.drug_chart.draft`
3. `mar.administration.backfill`
4. `lab.specimen_collection.backfill`
5. `blood.transfusion_verification.backfill`
6. `emr.nursing_note.observation.capture`
7. `emr.nursing_note.medication_note.capture`
8. `emr.nursing_note.post_procedure.capture`
9. `emr.nursing_note.intake_output.capture`
10. `emr.nursing_note.patient_complaint.capture`
11. `emr.nursing_note.wound_care.capture`
12. `emr.nursing_note.shift_handover.capture`
13. `emr.nursing_note.emergency.capture`
14. `emr.nursing_note.other.capture`
15. `vitals.capture`
16. `emr.nursing_note.draft.store`
17. `emr.op_note.draft.store`
18. `unknown`

`unknown` is a fail-closed value, not an executable fallback. C4.1 does not
bind any ID to an executable endpoint stored in SQLite. C4.2 owns the
authoritative server binding and C4.3 owns client policy enforcement.

## 3. The v6 command envelope

`OfflineCommandEnvelope` is immutable after its durable insert. Mutable
attempt, lease, state, and reconciliation evidence is stored alongside it and
never changes command identity.

The payload and sensitive identity metadata remain encrypted. Non-PHI query
projections are authenticated as AES-GCM associated data. The associated data
includes a SHA-256 digest of the exact stored body ciphertext, so metadata
cannot be transplanted onto another payload. A metadata, projection, body, or
authentication-tag mismatch moves the row to typed `needs_review`; there is no
legacy-plaintext interpretation.

### 3.1 Identity and authority fields

| Field | Capture-time source | What it binds |
| --- | --- | --- |
| `client_event_id` | Device-generated RFC 4122 UUID, minted once inside the insert transaction | The logical command across first attempt, lost response, retry, dependency, supersession, and reconciliation |
| `idempotency_key` | Device-generated stable key, minted in the same transaction; a migrated non-null v5 key is preserved exactly | Every HTTP attempt for the command; it is never regenerated after an ambiguous outcome |
| `action_id` | Typed caller input checked against the frozen 17-plus-`unknown` set | The clinical action contract; it is the only stored execution selector |
| `command_fingerprint` | SHA-256 of the RFC 8785 canonical immutable-command projection | Action, capture identity, target, occurrence, authority snapshot, ordering, expiry, and `payload_hash`; it excludes lease/retry/current replay actor and response state |
| `payload_hash` | SHA-256 of the RFC 8785 canonical payload bytes before encryption | Exact command body without exposing PHI |
| `app_version` | Running Staff semantic version plus build number supplied by the Staff adapter | The binary that captured the command |
| `envelope_schema_version` | Core constant `1` for the C4 envelope | The closed envelope language |
| `queue_schema_version` | SQLite schema constant `6` | The local persistence format |
| `action_version` | Verified capture policy/action entry supplied by the future policy adapter | The exact action-contract generation |
| `action_checksum` | Same verified action entry | The complete canonical action contract |
| `action_schema_id` | Same verified action entry | The closed client payload validator selected at capture; retained as envelope evidence but not trusted as a server route or replay binding |
| `action_schema_version` | Verified capture policy/action entry supplied by the future policy adapter | The schema used to validate the payload |
| `action_schema_checksum` | Same verified action entry | The exact action schema bytes |
| `policy_id` | Verified signed capture policy | The policy document used at capture |
| `policy_version` | Verified signed capture policy | The monotonic capture policy version |
| `policy_checksum` | Verified signed capture policy | The exact capture policy |
| `policy_signing_key_id` | Verified signed capture policy | The signing authority used at capture |
| `policy_effective_from` | Verified signed capture policy | The beginning of the exact authority window |
| `policy_effective_until` | Verified signed capture policy | The finite end of the exact authority window |
| `policy_supersedes_id` | Verified signed capture policy, explicit null when absent | The policy lineage asserted at capture |
| `policy_revocation_epoch` | Verified signed capture policy | The revocation knowledge at capture |
| `registry_version` | Verified signed action registry | The exact registry generation |
| `registry_checksum` | Verified signed action registry | The exact registry contents |
| `minimum_app_version` | Signed per-action/per-posture policy claim | The minimum safe client version that applied at capture |

The fingerprint excludes `client_event_id` and `idempotency_key`; those values
identify transport and receipt lookup, while the fingerprint represents the
command semantics compared for a duplicate `(tenant_id, client_event_id)`.
The fingerprint includes the stable capture actor and role snapshot, but not a
later replay actor.

The current repository has no client-side C4 signed policy adapter yet.
Missing action-schema, policy, registry, minimum-version, or signing claims
therefore make a row `legacy_c0a`, never `c4_ready`. C4.1 does not invent
checksums or use a client-bundled table as signed authority.

### 3.2 Tenant, facility, device, actor, and patient binding

| Field | Capture-time source | What it binds |
| --- | --- | --- |
| `tenant_id` | Validated `TenantConfig.id`, database namespace, authenticated readiness tenant, and signed policy audience must agree | Tenant ownership and queue namespace |
| `facility_id` | Provisioned device/facility context confirmed by the signed policy; never tenant or department inference | Facility authorization |
| `unit_id` | Explicit workflow context when the action contract requires it | Ward, OPD, ED, theatre, laboratory, or other unit scope |
| `device_id` | Stable opaque device-provisioning identifier; never transient `deviceType` or a user-entered label | Device audience and later loss/revocation handling |
| `device_posture` | Verified posture snapshot used by the signed policy | Policy compatibility at capture |
| `capture_session_id` | Always-present device-generated UUID from a durable capture-session manager | A sequence of commands captured by the same actor, tenant, facility, device, and app session |
| `incident_id` | Optional signed hospital incident declaration only | The incident known at capture; free text and client-created incident IDs are rejected |
| `capture_actor_uuid` | Stable Staff UID from the authenticated JWT/profile, not employee number or local row ID | The actor whose intent created the command |
| `capture_role` | Normalized current Staff role at capture | The role snapshot included in the fingerprint |
| `patient_reference` | Typed caller input using the action contract's stable UID or canonical patient key | The patient target |
| `encounter_id` | Typed workflow context, explicit null only when the action contract permits it | Encounter target |
| `appointment_id` | Typed workflow context, explicit null only when the action contract permits it | OP/appointment target |
| `admission_id` | Typed workflow context, explicit null only when the action contract permits it | Inpatient target |

`capture_session_id` is generated before the first command for an authenticated
tenant/facility/device/actor session and stored in secure device state. It is
reused for that capture session across app restarts, then rotated on explicit
session completion, controlled user change, tenant/facility change, device
reprovisioning, or policy-directed rotation. Existing rows retain their
original value after rotation.

If no authorized hospital incident exists, `incident_id` is null while
`capture_session_id` remains present. A later association with a hospital
incident is an append-only reconciliation event. It never edits the envelope
or fingerprint.

`current_replay_actor_uuid` and the replay-role snapshot are mutable attempt
evidence, not immutable command fields. They are freshly derived from the
authenticated session before every lease and appended to the state-event
ledger. They are separately authorized and excluded from the command
fingerprint. A replay actor may differ from `capture_actor_uuid` only after an
approved handoff; changing the current login never rewrites the capture actor.

### 3.3 Time, source, causality, and review fields

| Field | Capture-time source | What it binds |
| --- | --- | --- |
| `occurred_at` | Explicit clinical occurrence time from the typed workflow; capture time is used only when the approved action contract defines capture-as-occurrence | When the clinical observation/action occurred |
| `captured_at` | Device wall clock when the immutable command snapshot is created | Local intent time |
| `queued_at` | Device wall clock recorded by SQLite when the transaction commits | Durable-journal time |
| `clock_evidence` | C2.2 readiness midpoint, server time, measured skew, uncertainty/tolerance, route kind, and observation time | Whether local timestamps were tolerable at capture/attempt |
| `cached_sources` | Canonically sorted map of signed action-contract source IDs to the exact RFC 3339 source timestamps observed by the typed workflow | The complete source-freshness proof required by the action, including `patient_identity` for the two currently capture-ready draft actions |
| `source_cache_version` | Optional verified C3.3 manifest/pack version supplied by the caller | The C3.3 cache generation that supplied one or more `cached_sources`; it is provenance, not signed action authority |
| `base_revision` | Optional authoritative resource revision supplied by the workflow | Optimistic-concurrency base |
| `base_etag` | Optional exact ETag supplied by the workflow | HTTP/resource concurrency base |
| `expires_at` | Signed action policy's capture/replay horizon | The latest automatic-attempt time |
| `ordering_key` | Typed action contract logical key, encrypted in the envelope | The workflow/entity ordering scope |
| `ordering_key_digest` | Device-keyed opaque digest of `ordering_key` | Local indexing without plaintext patient/workflow identity |
| `sequence` | Monotonic integer allocated in SQLite for tenant/actor/action/ordering key | Deterministic causal order |
| `predecessor_client_event_id` | Explicit prior local command selected by the typed workflow | A hard dependency that must apply first |
| `supersession_generation` | Non-negative generation from an approved draft workflow | The generation within which draft coalescing is allowed |
| `human_review_required` | Signed action policy plus capture-time safety conditions | Whether automatic application is forbidden even if transport is healthy |

All keys are present in the canonical envelope. Contract-permitted absence is
encoded as explicit JSON null, not by omitting a key. A required null, malformed
identifier, unknown enum, untrusted clock, expired action, or contradictory
source revision fails closed before network.

Server `received_at` and authoritative `recorded_at` are not fabricated by the
client. They belong to the later server receipt/effect transaction in C5.1.

### 3.4 Exact C4.2 replay projection

The C4.1 envelope stores every value consumed by the in-flight C4.2
middleware, but it does not copy C4.2's server binding registry or persist a
route. After both slices are merged and C4.3 supplies verified policy capture,
the prepared sender projects the immutable fields into this exact wire
contract:

| Stored field | Replay header |
| --- | --- |
| `action_id` | `X-VH-Continuity-Action-Id` |
| `facility_id` | `X-VH-Continuity-Facility-Id` |
| `captured_at` | `X-VH-Continuity-Captured-At` |
| `capture_session_id` | `X-VH-Continuity-Capture-Session-Id` |
| `cached_sources` | `X-VH-Continuity-Cached-Sources`, serialized in sorted `source_id=timestamp` order |
| `app_version` | `X-VH-Continuity-Client-App-Version` |
| `action_version` | `X-VH-Continuity-Action-Version` |
| `action_checksum` | `X-VH-Continuity-Action-Checksum` |
| `action_schema_version` | `X-VH-Continuity-Action-Schema-Version` |
| `action_schema_checksum` | `X-VH-Continuity-Action-Schema-Checksum` |
| `policy_id` | `X-VH-Continuity-Policy-Id` |
| `policy_version` | `X-VH-Continuity-Policy-Version` |
| `policy_checksum` | `X-VH-Continuity-Policy-Checksum` |
| `policy_signing_key_id` | `X-VH-Continuity-Policy-Signing-Key-Id` |
| `policy_effective_from` | `X-VH-Continuity-Policy-Effective-From` |
| `policy_effective_until` | `X-VH-Continuity-Policy-Effective-Until` |
| `policy_supersedes_id` | `X-VH-Continuity-Policy-Supersedes-Id`, encoded as `none` when null |
| `policy_revocation_epoch` | `X-VH-Continuity-Revocation-Epoch` |
| `registry_version` | `X-VH-Continuity-Registry-Version` |
| `registry_checksum` | `X-VH-Continuity-Registry-Checksum` |
| `idempotency_key` | Standard `Idempotency-Key` |

C4.2 derives the replay actor, role/capabilities, tenant, and current device
posture from the authenticated request. C4.1 never substitutes stored
capture-time claims for those current server-owned facts. The stored
`device_posture`, capture actor/role, tenant, facility, and patient/workflow
identity remain immutable fingerprint and audit evidence; the request body and
authenticated context must satisfy C4.2 independently.

`action_schema_id` and `minimum_app_version` are deliberately not emitted as
authority headers. C4.2 resolves the schema ID and current per-posture minimum
version from its verified signed registry, then compares the pinned
version/checksum claims and the actual client version. Any absent envelope
value, malformed header projection, authority mismatch, stale required source,
or identity mismatch fails closed before the authoritative handler.

## 4. Pre-attempt persistence and online/offline unification

This is the load-bearing invariant:

> Before the first network attempt, one durable SQLite transaction persists
> `client_event_id`, `idempotency_key`, `action_id`, and
> `command_fingerprint`. If that transaction does not commit, no mutation is
> sent.

### 4.1 Prepared-command flow

1. A typed Staff workflow creates `OfflineCommandDraft`. It supplies an action
   ID and semantic context, never an endpoint or method.
2. `ConnectivitySyncService.prepareCapture()` checks the session barrier, C0A
   containment, the closed action-ID set, the capture actor, tenant, and the
   supplied capture context.
3. `OfflineQueue.persistPreparedCommand()` canonicalizes the payload and
   immutable fingerprint projection, generates the event/key pair, encrypts
   the payload and envelope, allocates the ordering sequence, and inserts the
   `pending` row plus its initial state event in one transaction.
4. Only after the transaction returns success may the service evaluate
   transport/readiness and schedule an immediate first attempt.
5. Offline, not-ready, or barrier-active outcomes leave the same row pending.
   Online readiness leases and attempts that same row. There is no second
   enqueue and no second key.

`VHHttpClient` gains a prepared-mutation send path that requires a
`PersistedOfflineCommand`. It accepts the stored idempotency key and the
in-memory route resolved from the closed client transport adapter. It cannot
mint an identity. It performs one leased attempt and returns the raw response
plus parsed `Retry-After` evidence to the state machine.

The existing generic `VHHttpClient.post/put/patch/delete` auto-key behavior
remains for non-continuity online calls. The two C0A controls stop using that
auto-mint path when the C4 envelope feature is enabled. This is how the current
split is removed: Staff no longer chooses between "online HTTP that mints a
key" and "offline enqueue that mints another key"; both dispositions begin
with the same committed command row.

The legacy `ConnectivitySyncService.enqueue(endpoint, method, body)` facade is
retained while activation is off so the existing C0A surface and unchanged
tests keep their behavior. It recognizes only the exact two C0A controls,
translates them to their frozen action IDs, and delegates to the v6 journal.
Contained and unknown routes are still rejected before insert. No C4-ready
code accepts or persists the facade's endpoint/method as execution authority.

### 4.2 Ambiguous and lost responses

The row is moved from `pending` or due `retry_wait` to leased `in_flight`
before the socket call. A clear typed 2xx moves it to `applied`. Timeout,
connection loss, process death, lost response, or lease expiry is ambiguous:
the row moves to `retry_wait` and reuses the original event ID, idempotency key,
action ID, and fingerprint.

No code treats a thrown exception as proof that the server did not apply the
command. No code creates a replacement row after an ambiguous attempt.

## 5. Local SQLite v5 to v6 migration

### 5.1 Additive schema

Schema v6 keeps `pending_writes` and all v5 columns. It adds these nullable or
defaulted columns:

| Column | SQLite type | Purpose |
| --- | --- | --- |
| `client_event_id` | `TEXT` | Stable logical command ID |
| `action_id` | `TEXT` | Frozen action-registry ID |
| `command_fingerprint` | `TEXT` | SHA-256 canonical command fingerprint |
| `payload_hash` | `TEXT` | SHA-256 canonical payload hash |
| `envelope_ciphertext` | `TEXT` | AES-GCM encrypted immutable metadata |
| `envelope_schema_version` | `INTEGER` | Recognized envelope decoder |
| `envelope_ready` | `INTEGER DEFAULT 0` | `1` only for a complete C4-ready envelope |
| `ordering_key_digest` | `TEXT` | Opaque local causal partition |
| `sequence_no` | `INTEGER` | Monotonic ordering sequence |
| `predecessor_client_event_id` | `TEXT` | Explicit dependency |
| `supersession_generation` | `INTEGER DEFAULT 0` | Draft generation |
| `human_review_required` | `INTEGER DEFAULT 0` | Immutable review requirement |
| `lease_id` | `TEXT` | Random compare-and-swap lease token |
| `lease_expires_at` | `INTEGER` | Lease expiry |
| `next_attempt_at` | `INTEGER` | Due time for `retry_wait` |
| `attempt_count` | `INTEGER DEFAULT 0` | Total claimed attempts |
| `last_attempt_at` | `INTEGER` | Last lease/attempt time |
| `applied_at` | `INTEGER` | Clear client-observed applied time |
| `state_reason_code` | `TEXT` | Typed transition/review reason |

The existing `status` column becomes the durable v6 state column. The v5
`conflict` value migrates to `needs_review` with a typed conflict reason; it is
not an extra v6 durable state.

Two additive local tables support the state machine:

- `offline_write_sequences` atomically allocates the next sequence for the
  opaque tenant/actor/action/ordering-key partition; and
- `offline_write_state_events` stores append-only state and reconciliation
  observations with timestamp, actor, from/to state, typed reason, and
  encrypted detail.

Unique indexes cover non-null `client_event_id`. A partial unique index covers
the idempotency key within the tenant/capture-owner scope only for
`envelope_ready = 1`, so preserved duplicate legacy keys can remain as
`needs_review` instead of making the migration fail. Due-work indexes cover
state, `next_attempt_at`, lease expiry, owner, and opaque ordering key. No
index contains plaintext patient, encounter, admission, incident, or workflow
keys.

The v5 `endpoint` and `method` columns remain only because this is an additive
upgrade and they are `NOT NULL`. Existing bytes are retained as inert legacy
evidence. New v6 inserts store fixed non-executable sentinels in those columns.
No v6 model, drain query, or transport resolver reads them as authority.

### 5.2 One-transaction, idempotent upgrade

Both version upgrade and defensive `onOpen` repair use one SQLite transaction:

1. Read `PRAGMA table_info` and `PRAGMA index_list`.
2. Add only missing columns, tables, and indexes.
3. Read every existing row in `created_at ASC, id ASC` order.
4. Preserve the exact existing `id`, `body`, `staff_id`, `tenant_id`,
   `idempotency_key`, `reconciliation_owner_id`, `handoff_attested_at`, and
   `handoff_attested_by` values. Existing endpoint, method, context, conflict,
   creation, and retry bytes remain available as legacy evidence. The original
   status is the `from_state` of the migration state event before any v6
   normalization.
5. Authenticated-decrypt the v5 body without rewriting it. The v6 envelope
   stores a digest of those exact ciphertext bytes.
6. Preserve every non-null idempotency key exactly. A null, malformed, or
   duplicate legacy key is never replaced after a possible prior attempt; the
   row becomes `needs_review/legacy_identity_incomplete`.
7. Mint a `client_event_id` once inside the migration transaction. A rollback
   exposes neither that value nor a send; a repeated migration mints only when
   the committed field is still null.
8. Map exact C0A controls to `vitals.capture` or the draft ID selected by the
   closed `note_type` discriminator. A legacy draft without a discriminator
   retains the historical nursing-draft compatibility classification while
   activation is off. Contained current authoritative routes are not
   reinterpreted as future draft/backfill commands; they use `unknown` plus
   their preserved C0A typed review reason.
9. Build only the metadata that can be truthfully derived. Missing facility,
   device, actor UUID, occurrence, signed action schema, signed policy, source,
   revision, or expiry evidence leaves `envelope_ready = 0`.
10. A row that cannot be safely decoded, mapped, authenticated, or completed
    moves to typed `needs_review`; it is never dropped.
11. Convert legacy `conflict` to `needs_review/legacy_conflict`, preserving the
    encrypted conflict evidence and its current Retry/Discard presentation
    compatibility.
12. Insert an initial migration state event, then commit all schema and row
    changes together.

There is no table rebuild, `VACUUM`, body rewrite, current-login owner
attribution, or best-effort partial migration. Disk-full, key loss, corrupt
ciphertext, unknown encryption, future schema, duplicate identity, and
interrupted-upgrade tests prove rollback and byte retention.

Existing C0A test-only compatibility readers continue to project applied and
draft-cancelled rows as absent and migrated `legacy_conflict` rows through the
old conflict facade. New v6 tests inspect the full journal and state-event
tables directly. This preserves the current black-box contracts without
pretending `conflict` is a new durable v6 state or deleting v6 history.

## 6. Durable state machine

The only durable command states are:

| State | Meaning and permitted transitions |
| --- | --- |
| `pending` | Committed and not attempted; may lease to `in_flight`, or a draft may become `superseded`/`cancelled` |
| `in_flight` | One compare-and-swap lease owns one network attempt; may become `applied`, `retry_wait`, or `needs_review` |
| `retry_wait` | Retained until `next_attempt_at`; may lease to `in_flight`, expire to `needs_review`, or a never-attempted draft may be superseded/cancelled |
| `applied` | A clear typed successful result was observed; never rearms |
| `needs_review` | Typed, owner-visible human disposition is required |
| `superseded` | Draft only; an immutable older local draft command was replaced by a newer approved generation |
| `cancelled` | Draft only; an explicit reasoned local draft cancellation was recorded before final authority |

“Quarantine” is UI/plain-language shorthand for typed `needs_review`. It is
never stored as a state.

An `in_flight` transition sets a random lease ID, lease expiry, attempt number,
and attempt time in one compare-and-swap transaction. Only that lease may
finish the attempt. On restart, an unexpired lease remains owned and an expired
lease becomes `retry_wait/ambiguous_lease_expired`; it never becomes a fresh
unidentified command.

`applied` is client-observed state, not the server replay receipt introduced by
C5.1. It cannot authorize canonical timeline, audit, SLA, outbox, task, or
pathway claims.

## 7. Drain, retry, dependency, and coalescing rules

### 7.1 Outcome classification

- 2xx with the expected typed response becomes `applied`.
- 400/422 validation, 403 authorization, 404 not-found, 410 gone,
  409/412 conflict/concurrency, unknown action, policy incompatibility,
  expired command, malformed response, and integrity failure become typed
  `needs_review` with a named reconciliation owner.
- 401 or a changed/cleared session stops the whole drain without consuming a
  clinical retry.
- 429 becomes `retry_wait` and honors valid delta-seconds or HTTP-date
  `Retry-After`.
- 5xx, timeout, connection loss, and other transport ambiguity become
  `retry_wait`.

Backoff is bounded exponential delay with bounded jitter. The next due time is
the later of the client backoff and `Retry-After`; jitter may delay but never
advance the server's requested time. If the due time exceeds `expires_at`, the
row becomes `needs_review/expired_before_retry`. Reaching the configured
attempt ceiling becomes `needs_review/retry_exhausted`. Exhausted work is never
skipped, deleted, or hidden.

The cleared constants are a 90-second lease, six lease cycles, a 2-second
initial client delay doubled per cycle and capped at 5 minutes, plus injectable
0-to-20-percent positive jitter. A valid `Retry-After` is not capped below the
server's requested instant; command expiry remains the hard upper bound.
One lease may include the existing single-flight token refresh and one
same-key post-refresh command replay. A persistent 401 still stops the drain
without consuming a clinical retry.

### 7.2 Ordering and predecessor behavior

Rows retain global `queued_at ASC, id ASC` inspection order. The existing C0A
tenant/owner/action-family partition behavior remains for legacy rows. V6 adds
the opaque ordering key, monotonic sequence, and explicit predecessor:

- a predecessor in `pending`, `in_flight`, or `retry_wait` blocks the dependent
  row without consuming its retry;
- a predecessor in `applied` releases the dependent row;
- a predecessor in `needs_review` moves the dependent to
  `needs_review/predecessor_failed`;
- a predecessor that is draft-only `superseded` or `cancelled` releases a
  dependent only when the action contract explicitly names that transition as
  compatible; otherwise it requires review; and
- a missing or cross-tenant/cross-owner predecessor is integrity failure and
  requires review.

Independent safe partitions continue. No dependent row executes after a
failed predecessor.

### 7.3 Draft coalescing

Append-only observations never coalesce. In the frozen inventory this includes
`vitals.capture` and every future observation-shaped capture.

Only the two explicitly draft-shaped store actions may coalesce:

- `emr.nursing_note.draft.store`; and
- `emr.op_note.draft.store`.

The match is exact tenant, capture actor, action ID, encrypted logical key, and
supersession generation. Coalescing never overwrites an identity or
fingerprint. It inserts a new command and marks only a never-attempted older
draft `superseded` in the same transaction. An older attempted or ambiguous
draft becomes the new command's predecessor instead; it is not erased.

An explicit editor clear/finalize may mark only a never-authoritative draft
`cancelled`, with actor, reason, generation, and encrypted detail. No
observation, physical action, final authority, or unknown action can become
`superseded` or `cancelled`.

## 8. Preservation across session lifecycle

All `pending`, `in_flight`, `retry_wait`, and `needs_review` rows are unresolved
work. They survive:

- idle timeout;
- app/process restart;
- token refresh failure and forced revocation;
- controlled user switch;
- tenant/facility switch;
- ordinary logout after the existing blocker/handoff rules; and
- device reboot.

The queue database, encryption key, capture session IDs used by existing rows,
state events, and reconciliation evidence are never cleared by session-key
cleanup. A different user cannot display, lease, retry, cancel, supersede, or
reconcile the previous capture owner's rows.

The C0A attested-handoff fields remain immutable and keep their existing logout
effect: an attested review row stops blocking ordinary logout but remains
encrypted, visible to its owner/reconciliation flow, and undrainable.

## 9. Reasoned, auditable reconciliation

The Sync status UI removes generic one-tap Discard. A reconciliation action
requires:

- fresh current actor, tenant, owner, state, encryption, and action checks;
- a typed reason selected from the action/state-specific allow-list;
- required explanatory text when the reason requires it;
- explicit confirmation using clinical “not recorded on server” language; and
- one transaction that appends encrypted reconciliation evidence before any
  row leaves the unresolved view.

Initial reason families are `recorded_elsewhere_verified`,
`transferred_to_paper`, `manual_entry_verified`, `duplicate_confirmed`,
`wrong_patient_or_context`, `policy_or_schema_conflict`, and
`draft_cancelled`. The exact allowed set is narrowed by action shape.
`draft_cancelled` is draft-only. A non-draft observation is never deleted or
cancelled merely to empty the badge.

The current boolean conflict-discard facade remains as a deprecated C0A
compatibility adapter for the unchanged tests. A confirmed call records a
typed `legacy_reconciliation_confirmed` state event and the authoritative actor
before it resolves the old conflict view. Production UI no longer calls that
facade. Unconfirmed, wrong-owner, wrong-tenant, skipped, exhausted,
review-required, and integrity-failed rows remain non-deletable through it.

Reconciliation detail is encrypted. Plaintext state rows contain only typed
non-PHI codes and opaque IDs.

## 10. C0A, C2.2, and C3.3 non-regression

The following existing suites remain unedited and green in black-box behavior.
C4.1 extends them with new files instead of weakening or rewriting assertions.

### 10.1 C0A queue and containment

- `packages/vhhealth_core/test/connectivity_sync_c0a_test.dart`
- `packages/vhhealth_core/test/offline_queue_c0a_safety_test.dart`
- `packages/vhhealth_core/test/offline_queue_drain_order_test.dart`
- `packages/vhhealth_core/test/offline_queue_remove_matching_test.dart`
- `packages/vhhealth_core/test/offline_queue_v5_migration_test.dart`
- `packages/vhhealth_core/test/offline_write_containment_test.dart`
- `packages/vhhealth_core/test/clinical_discard_guard_test.dart`
- `packages/vhhealth_core/test/offline_write_status_row_test.dart`
- `apps/staff/test/features/offline_physical_evidence_fallback_test.dart`
- `apps/staff/test/features/physical_evidence_screen_containment_test.dart`
- `apps/staff/test/features/doctor/prescription_offline_rx_test.dart`
- `apps/staff/test/features/ipd/drug_chart_offline_order_test.dart`
- `apps/staff/test/features/nursing/mar_scan_offline_test.dart`
- `apps/staff/test/core/services/auth_service_c0a_test.dart`
- `apps/staff/test/core/widgets/session_revocation_listener_c0a_test.dart`

In particular, contained/unknown actions still insert zero rows and send zero
HTTP, unknown metadata and bad ciphertext retain bytes, retry 5-to-6 becomes
visible review, partition blocking remains scoped, 401/owner change stops the
pass without retry burn, the session barrier closes enqueue/drain races, and
logout/revocation preserves rows and keys.

### 10.2 C2.2 readiness

- `packages/vhhealth_core/test/client_readiness_test.dart`
- `packages/vhhealth_core/test/connectivity_sync_readiness_test.dart`
- `packages/vhhealth_core/test/offline_sync_connection_state_test.dart`

Failed readiness still leaves every clinical row and retry count byte-equal,
successful readiness enters the scoped drain, barrier changes during readiness
prevent drain entry, wakes coalesce, `Retry-After` suppresses probes, and the
transport/continuity UI axes remain distinct.

### 10.3 C3.3 read-only cache

- `packages/vhhealth_core/test/clinical_continuity_cache_test.dart`
- `packages/vhhealth_core/test/clinical_continuity_canonical_json_test.dart`
- `packages/vhhealth_core/test/clinical_continuity_verifier_test.dart`
- `apps/staff/test/features/clinical_continuity/staff_continuity_repository_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_cache_screen_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_pack_view_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_print_service_test.dart`
- `apps/staff/test/features/clinical_continuity/continuity_accessibility_test.dart`
- `apps/staff/integration_test/clinical_continuity_airplane_mode_test.dart`

C4.1 does not edit C3.3 cache, verifier, trust-store, display, print, source, or
repository files. Source-cache provenance enters C4.1 only as an explicitly
supplied, verified immutable reference.

### 10.4 New extension suites

C4.1 adds focused tests for:

- every envelope field, strict closed parsing, canonical hash, and fingerprint
  stability;
- the exact C4.2 replay-header projection, including all 14 pinned authority
  claims, deterministic cached-source serialization, and absent-claim refusal;
- pre-attempt disk failure causing zero HTTP;
- online first attempt and offline retry reusing one identity;
- lost 2xx, process death, duplicate request, expired lease, and app restart;
- all durable states and forbidden transitions;
- v5-to-v6 idempotent additive migration and exact byte retention;
- malformed/missing/duplicate legacy identity moving to review;
- wrong tenant, user, facility, device, role, and action;
- clock rollback/uncertainty, expiry, policy supersession, and corrupt
  ciphertext;
- `Retry-After`, jitter bounds, max attempt, and no silent exhausted skip;
- predecessor failure and independent-partition progress;
- append-only no-coalescing and draft-only supersession/cancellation;
- reasoned reconciliation audit and deprecated-facade authorization; and
- session timeout, user switch, logout, and restart preservation.

## 11. Exact implementation ledger after clearance

No Step 2 implementation begins until the coordinator approves this ledger.
Any added or substituted file requires another design delta.

### 11.1 Add

Core:

- `packages/vhhealth_core/lib/models/offline_command_envelope.dart`
- `packages/vhhealth_core/lib/services/offline_action_ids.dart`
- `packages/vhhealth_core/lib/services/offline_command_codec.dart`
- `packages/vhhealth_core/test/offline_command_envelope_test.dart`
- `packages/vhhealth_core/test/offline_queue_v6_migration_test.dart`
- `packages/vhhealth_core/test/connectivity_sync_pre_attempt_test.dart`
- `packages/vhhealth_core/test/connectivity_sync_state_machine_test.dart`
- `packages/vhhealth_core/test/offline_reconciliation_test.dart`

Staff:

- `apps/staff/lib/core/services/staff_offline_capture_context.dart`
- `apps/staff/test/core/services/staff_offline_capture_context_test.dart`
- `apps/staff/test/features/emr/note_draft_queue_identity_test.dart`
- `apps/staff/test/features/nursing/vitals_queue_identity_test.dart`

### 11.2 Modify

Core:

- `packages/vhhealth_core/lib/models/offline_write_entry.dart`
- `packages/vhhealth_core/lib/services/offline_queue.dart`
- `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`
- `packages/vhhealth_core/lib/services/http_client.dart`
- `packages/vhhealth_core/lib/vhhealth_core.dart`
- `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart`

Staff:

- `apps/staff/lib/core/config/c0a_reconciliation_config.dart`
- `apps/staff/lib/features/emr/note_draft_autosave.dart`
- `apps/staff/lib/features/nursing/screens/vitals_screen.dart`
- `apps/staff/lib/l10n/app_strings.dart`
- `apps/staff/test/i18n_guard_test.dart`

### 11.3 Step 1 design-only file

- `docs/continuity/c4-1-queue-envelope-design-delta.md`

There is no backend, Prisma, server migration, Admin, Patient,
infrastructure, C3.3 cache, C4.2 registry, OpenAPI, or generated API file in
the ledger.

## 12. Verification receipts after clearance

Step 2 retains command logs under
`D:\Dev\_codex\artifacts\logs\<date>\c4-1-queue-envelope\` and runs:

- focused new C4.1 core and Staff tests;
- every unchanged C0A, C2.2, and containment suite named above;
- focused C3.3 non-regression suites;
- `melos run format`;
- `melos run analyze`;
- `melos run test`;
- `flutter test apps/staff/test/i18n_guard_test.dart`;
- `melos run i18n-health-staff`;
- Android Staff build and focused SQLite restart/airplane-mode flow;
- Windows Staff build and the equivalent SQLite restart flow;
- repository secret/dependency checks applicable to the changed client files;
- `git diff --check`; and
- `git diff --name-status main...HEAD`.

The three-dot intent receipt must contain only this design record plus the
cleared client files in section 11. It must contain no backend or migration
outside local SQLite.

## 13. Explicit non-goals

C4.1 provides:

- no backend or server database change;
- no action-registry enforcement or policy publication (C4.2/C4.3);
- no backend replay receipt, command-effect transaction, or tombstone (C5.1);
- no new offline-eligible action;
- no binding of the current authoritative prescription, CPOE, MAR, specimen,
  transfusion, generic note-create, or vital route;
- no automatic replay activation;
- no facility, tenant, device, role, cohort, or platform activation;
- no signed policy, registry, key, checksum, facility identity, incident, or
  clinical occurrence-time invention;
- no C3.3 cache mutation or cache-derived authority;
- no executable endpoint or method stored as v6 authority; and
- no merge.

## 14. Coordinator clearance requested

Please approve or correct these exact decisions before Step 2:

1. the client-only parallel-safe boundary and zero overlap with C4.2;
2. the complete envelope and canonical fingerprint projection;
3. fail-closed handling of the currently unavailable trustworthy facility
   context, with no activation;
4. the single prepared-command path for both online first attempt and offline
   retry;
5. the additive v5-to-v6 columns, sequence table, and state-event table;
6. the seven-state model with `conflict` folded into typed `needs_review`;
7. draft-only supersession/cancellation and no observation coalescing;
8. the reasoned reconciliation model and temporary C0A compatibility facade;
9. the exact Step 2 file ledger; and
10. the named non-regression and platform receipt matrix.

Until clearance is recorded, this branch remains design-only.
