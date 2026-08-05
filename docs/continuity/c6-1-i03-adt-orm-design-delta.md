# C6.1 I03 inbound ADT/ORM sequencing — design delta

**Status:** design-only Packet BQ delta; no runtime, migration, activation, or
deployment authority.

**Re-anchored baseline:** `github/main` at
`f0746de93996b6a255ed6d05008f471da4afaecc` on 2026-08-05.

**Branch:** `feat/continuity-c6-1-i03-adt-orm`.

**Migration ledger:** main contains migrations through 627. Migration 626 is
permanently vacant by ledger decision. This delta claims no migration number;
Step 2 must re-fetch main and derive a fresh number in its own authorized build
window.

This delta closes the repository-side contract for I03, the public inbound HL7v2
HTTP bridge that accepts ADT A01/A02/A03 and ORM O01 messages. It does not make
the current live path replay-safe and it does not authorize recovery. A future
Step 2 may add the inert adapter only after coordinator GO, and a later
per-credential activation still requires the canonical offset, signed policy,
retention, source-conformance, and owner evidence described below.

## 1. Phase A verdict — the backend and each external sender need bounded changes

**Verdict:** the receiving endpoint is an existing in-repository backend
component, but the durable source spool is external to this repository. A safe
I03 implementation therefore has two inseparable halves:

1. the backend adds a closed, signed recovery envelope and an I03 adapter on the
   existing C6.1 canonical recovery substrate; and
2. each external HL7 sender or bridge proves that it durably assigns and retains
   the monotonic positions, predecessor chain, exact message bytes, and source
   times required by that contract.

Backend code alone cannot manufacture a sender high-water mark after an outage.
No receipt timestamp, MSH-10 value, row id, or “start from now” inference is a
substitute.

### 1.1 Current request and authentication path

At the pinned baseline:

- `apps/backend/src/routes/hl7/hl7Routes.js:49-54` records that the router is
  mounted before global JWT authentication. `POST /api/v1/hl7/receive` is a
  public HMAC surface protected by the generic per-IP limiter.
- `hl7Routes.js:63-136` parses MSH-6, resolves a tenant-scoped
  `tenant_interop_secrets` row when one exists, otherwise permits the legacy
  default-tenant environment secret, verifies HMAC over the raw HL7 message,
  checks any DB API-client tenant, and then claims the short-lived local/shared
  replay guard.
- `apps/backend/src/services/interop/tenantInteropSecretService.js:63-105`
  returns tenant id and secret through separate calls. It does not return the
  authoritative credential row id needed for an I03 partition, and its lookup
  failure may fall back to the legacy environment path.
- `apps/backend/src/utils/signedRequest.js:1-6,71-107` signs
  `<timestamp>.<requestId>.<payload>`. The current I03 payload is only the raw
  HL7 string. Adding an unsigned `recovery` object beside `message` would leave
  cursor and duplicate evidence forgeable.
- `signedRequest.js:110-220` and `interop_replay_guard` provide only a freshness
  fence. They are not the durable I03 duplicate key or high-water mark.

The current credential lookup remains the tenant-resolution boundary. The
implementation must not reinterpret untrusted MSH-3 or MSH-4 text as a signing
client identity. For recovery, the stable identity is the active DB credential
row that supplied the verified secret.

### 1.2 Current parsing and clinical effects

`apps/backend/src/services/hl7/hl7Parser.js:61-103` exposes MSH-3 through MSH-12,
including message type and MSH-10, but not MSH-13, EVN-2, ORC-2/ORC-9, or
PV1-19. `hl7Transformer.js:128-209` maps ADT and ORM data but does not establish
a durable delivery identity.

After authentication, `hl7Routes.js:212-317` acts synchronously:

- A01 and A02 insert directly into `admissions` with `ON CONFLICT DO NOTHING`;
- A03 updates the most recent admitted row;
- O01 inserts directly into `investigations`;
- a successful statement returns a newly generated HL7 `AA`; and
- errors return an `AE`, with no durable outcome linking a retry to the first
  attempt.

Those statements do not use the canonical admission or investigation services.
They also do not provide a permanent domain duplicate, a source cursor, an exact
ACK receipt, or an ordered outage-recovery path. A request replayed after the
short TTL can repeat or drift the clinical effect.

This delta does **not** authorize repairing or replacing the legacy live ADT/ORM
semantics. It adds a strictly separate recovery branch whose only terminal
domain disposition is pending human reconciliation.

### 1.3 Existing canonical recovery seam

`apps/backend/src/config/externalInterfaceRecoveryCatalog.js:29` already marks
I03 `hwm_required`, but I03 is not in the implemented-family list at line 9 and
has no metadata or adapter.

`apps/backend/src/services/integrations/externalInterfaceRecoveryService.js`
already supplies the required substrate:

- offset registration and owner-authorized resume use `event_consumer_offsets`;
- `enqueueExternalRecoveryItem` accepts only `recovery_backlog`, checks duplicate
  key and position collisions, and records a `late_pending_only` canonical inbox
  row (`352-452`);
- `processNextItemTx` locks the offset and next inbox row, proves position and
  predecessor contiguity, mints the effect capability, requires domain evidence
  plus a pending task, terminalizes the inbox, and advances the cursor in one
  serializable transaction (`668-833`); and
- the adapter registry at `635-651` does not yet include I03.

I03 must extend this seam. It must not add a parallel cursor, replay queue,
claim table, or recovery work ledger.

## 2. Binding authority and frozen safety boundary

The controlling C-D8 disposition in
`docs/continuity/c6-1-resume-markers-design-delta.md` is binding:

- I03 requires a high-water mark partitioned per tenant, signing client, and
  message family;
- its permanent duplicate identity is tenant, signing client, message
  type/trigger, and MSH-10, with exact payload SHA-256 as the fingerprint;
- the short-lived HMAC replay table remains only a freshness fence;
- the sender must supply a negotiated sequence/token per ADT and ORM partition;
- an absent sequence holds recovery rather than inferring a start point; and
- late backlog becomes pending admission or order reconciliation with no
  downstream live effect.

C-D8 also fixes Dr Bahuleyan S as the accountable I03 recovery owner. That
operational accountability is not a machine identity and is not serialized into
sender requests. The owner signs the source reconciliation, resume cutoff,
policy, retention, and activation evidence through the canonical control
surface.

The following invariants are non-negotiable:

1. Every recovery item has `arrival_class='recovery_backlog'` and
   `effect_disposition='late_pending_only'`.
2. No late I03 message directly creates, transfers, discharges, or changes an
   admission and no late ORM message directly creates or changes an
   investigation/order.
3. No late item starts or settles an SLA, transitions a pathway, emits an
   outbox/webhook, sends a patient/staff notification, pages a clinician, or
   creates a retrospective breach.
4. The only human effect is an existing workflow task with
   `slaCompletionSemantics='none'`.
5. Raw HL7 and parsed PHI never enter `pathway_projector_inbox` or
   `event_consumer_offsets`. An interface-specific, same-tenant receipt holds the
   encrypted exact bytes and links to the canonical inbox.
6. The domain receipt, pending task, terminal inbox evidence, exact ACK issuance,
   and cursor decision are atomic.
7. Missing, ambiguous, stale, cross-tenant, or conflicting evidence fails closed.

## 3. Closed recovery contract

The contract identifier is:

```text
vhhealth.i03.adt-orm-sequence/v1
```

The existing request path remains `POST /api/v1/hl7/receive`. A request without
`recovery` continues through the legacy live branch, subject to the downgrade
fence in section 7. A request with `recovery` is irrevocably a recovery request:
if its closed contract fails, it must not fall through to live processing.

The top-level recovery body has exactly two fields:

```json
{
  "message": "<exact HL7v2 bytes represented as a JSON string>",
  "recovery": {
    "schema": "vhhealth.i03.adt-orm-sequence/v1",
    "interface_family": "I03",
    "arrival_class": "recovery_backlog",
    "tenant_id": "<authenticated tenant UUID>",
    "signing_credential_id": "<DB credential id as canonical decimal>",
    "offset_id": "<canonical external-interface offset UUID>",
    "source_partition": "i03/credential/<id>/family/<adt|orm>",
    "generation": 1,
    "source_position": "<canonical non-negative decimal>",
    "source_token": "<lowercase SHA-256>",
    "predecessor_token": "<previous source token>",
    "duplicate_key": "<lowercase SHA-256>",
    "message_family": "adt",
    "message_type": "ADT",
    "trigger_event": "A01",
    "message_control_id": "<exact MSH-10>",
    "message_sha256": "<SHA-256 of exact message UTF-8 bytes>",
    "source_observed_at": "<RFC 3339 timestamp with explicit offset>",
    "source_received_at": "<RFC 3339 timestamp with explicit offset>",
    "clock_evidence": {
      "source_clock_id": "<stable configured clock identity>",
      "synchronized_at": "<RFC 3339 timestamp with explicit offset>",
      "maximum_error_ms": 1000
    }
  }
}
```

The recovery object is closed. Unknown keys, aliases, casing variants, numeric
coercions, empty required values, non-canonical decimals, timestamps without an
explicit offset, non-lowercase hashes, or unsupported nested clock fields are
refused. The message limit remains bounded at 2,000,000 UTF-8 bytes, matching
the established external-recovery precedent.

`clock_evidence` is also closed: `source_clock_id` is a non-empty string of at
most 120 characters, `synchronized_at` is an explicit-offset timestamp, and
`maximum_error_ms` is an integer from 0 through 300,000. Synchronization cannot
post-date `source_received_at`; after applying the declared maximum error,
sender receipt cannot precede clinical occurrence. These checks are evidence
quality rails, not permission to replace the clinical timestamp with a server
clock.

Only these message identities are accepted:

| Family | `message_type` | `trigger_event` | Exact MSH-9 |
|---|---|---|---|
| ADT | `ADT` | `A01` | `ADT^A01` |
| ADT | `ADT` | `A02` | `ADT^A02` |
| ADT | `ADT` | `A03` | `ADT^A03` |
| ORM | `ORM` | `O01` | `ORM^O01` |

The envelope values must exactly match the parsed MSH-9 and MSH-10. Recovery
does not widen the current route to other trigger events or structural-message
variants.

### 3.1 Source occurrence and reconciliation fields

Recovery must distinguish clinical occurrence from transport receipt:

- ADT A01/A02/A03 uses EVN-2 as `source_observed_at`.
- ORM O01 uses ORC-9 as `source_observed_at`.
- `source_received_at` is when the durable sender spool accepted the exact
  message, not when VH Health later received the replay.
- MSH-7, PV1-44/PV1-45, ORC-2, OBR-2, OBR-4, and PV1-19 are recorded as bounded
  reconciliation evidence when present, but none becomes the cursor.
- MSH-13 may be parsed and retained as non-authoritative evidence. It is not the
  I03 high-water mark unless a future versioned contract is separately approved.

EVN-2 or ORC-9 must include seconds and an explicit UTC offset. Missing or
ambiguous source occurrence refuses the automated recovery contract and leaves
the partition for owner reconciliation. Receipt time must never be substituted.

PID-3 must be a UUID-shaped patient identity. The adapter looks it up only under
the authenticated tenant. An absent PID-3 is a contract error. A syntactically
valid identity that is unknown, inactive, merged, deleted, or belongs to another
tenant is not dereferenced; it yields a pending review receipt with no linked
patient rather than a cross-tenant read or clinical mutation.

## 4. Authentication and immutable signing-client identity

### 4.1 DB-backed credentials are mandatory for recovery

Step 2 adds one service helper that resolves the active
`tenant_interop_secrets` row and decrypted secret as one credential snapshot:

```text
id, tenant_id, kind, sender_identifier, status, secret
```

The helper resolves the same MSH-6 value used by the current route and returns
no secret or tenant metadata to the caller. Recovery requires:

- `kind='hl7_inbound'`;
- an active DB row;
- exact equality between envelope `signing_credential_id` and the resolved row;
- exact tenant equality for any attached DB API client; and
- the server-derived source partition for that row and family.

The environment-backed `HL7_INBOUND_SHARED_SECRET` fallback has no durable
credential identity. It may retain current legacy live compatibility but it is
never recovery-enrollable and must receive typed
`HL7_I03_RECOVERY_CREDENTIAL_REQUIRED` if `recovery` is supplied. A tenant must
provision a DB credential before I03 recovery can be activated.

A credential lookup error is fail-closed for recovery. It must not silently
degrade to the environment secret.

### 4.2 The sequence envelope is part of the HMAC

For legacy requests, the HMAC payload remains the exact raw message. For a v1
recovery request, the route computes:

```text
message_sha256  = sha256(UTF-8 exact message string)
recovery_sha256 = canonicalCommandFingerprint(closed recovery object)

signed_payload =
  "vhhealth.i03.adt-orm-sequence/v1\n" +
  message_sha256 + "\n" +
  recovery_sha256

HMAC input = timestamp + "." + request_id + "." + signed_payload
```

`canonicalCommandFingerprint` is the existing deterministic, recursively
key-sorted JSON fingerprint from
`externalInterfaceRecoveryService.js:14-37`. Before accepting the HMAC, the
route independently recomputes the message hash and requires equality with the
closed envelope.

This binds every cursor, duplicate, clock, credential, partition, family, and
payload assertion to the same secret that authenticates the message. Changing
one byte or one envelope field invalidates the signature. TLS remains required;
HMAC is not a replacement for transport confidentiality.

The existing local/shared replay claim remains in front of durable enqueue. Its
only meaning is “this fresh signed HTTP request has not already been observed in
the TTL window.” A sender retry after a lost response uses a new request id and
timestamp; durable I03 identity, not `interop_replay_guard`, converges the
retry.

## 5. Partition, high-water mark, duplicate, and source token

### 5.1 Partition identity

The server-derived partition is:

```text
i03/credential/<tenant_interop_secrets.id>/family/adt
i03/credential/<tenant_interop_secrets.id>/family/orm
```

ADT A01, A02, and A03 share one ordered partition because their meaning depends
on visit order. ORM O01 has a separate partition so an order gap does not permit
or block an ADT transition. Tenant scope comes from the credential and canonical
offset, never from a caller-selected tenant or facility field.

The canonical offset uses:

```text
scope_kind       = external_interface
interface_family = I03
direction        = inbound
facility_scope   = tenant
cursor_kind      = monotonic_position_and_predecessor
consumer_key     = external:I03
```

There is one active generation per partition. A reset or unbridgeable retention
gap retires the old generation and requires a newly reconciled higher
generation; it never rewinds or reactivates the old ledger.

### 5.2 Duplicate identity

The permanent duplicate key is the lowercase SHA-256 of the established
length-prefixed components:

```text
vh-i03-duplicate-v1
tenant_id
signing_credential_id
message_family
message_type
trigger_event
MSH-10
```

The exact UTF-8 message SHA-256 is the fingerprint, not an alternative duplicate
key. Therefore:

- the same duplicate key, position, predecessor, source token, occurrence, and
  exact message bytes is an exact retry;
- the same duplicate key with different bytes, source tuple, trigger, patient,
  or occurrence is a conflict;
- the same position with a different duplicate key or payload is a conflict;
  and
- a conflict moves the canonical offset to reconciliation-required and never
  chooses a winner from arrival order.

The duplicate identity does not expire while its signed retention policy
requires evidence. A cleanup job must not make an old MSH-10 reusable inside the
retained recovery generation.

### 5.3 Source token

The source token is the lowercase SHA-256 of these length-prefixed components:

```text
vh-i03-source-token-v1
tenant_id
source_partition
generation
source_position
predecessor_token
duplicate_key
message_sha256
```

For position `N`, `predecessor_token` must equal the committed token at `N-1`.
Position must be the canonical non-negative base-10 string and must equal the
next expected position during processing. The source must retain the exact
token and exact message bytes through the signed retention boundary.

The initial position/token and the resume cutoff come only from owner-reconciled
sender evidence. Missing evidence leaves the offset in
`reconciliation_required_missing_marker`; a gap or retention hole leaves it in
the corresponding reconciliation-required state.

## 6. Interface-specific append-only receipt

Step 2 adds exactly one domain evidence table named
`hl7_inbound_recovery_receipts`. It is not a queue or cursor. Each row is the
immutable terminal evidence for one I03 canonical inbox item.

Its closed column families are:

| Group | Required evidence |
|---|---|
| Provenance | tenant id, canonical recovery inbox id, I03 family, credential id, partition, generation, position, token, predecessor, duplicate key |
| Message | family, type, trigger, MSH-10 SHA-256, exact payload ciphertext, payload SHA-256, byte count |
| Reconciliation | source occurrence, sender receipt time, bounded clock evidence, optional hashed visit/order identities, optional same-tenant patient uid |
| Human work | pending task id and route role, `pending_review` status, typed outcome code |
| ACK | exact ACK ciphertext, ACK SHA-256, byte count, ACK code, intended HTTP status |
| Governance | policy version/signature, retention policy/until, server recorded time |

Concretely, those families map to `id`, `tenant_id`, `recovery_inbox_id`,
`interface_family`, `signing_credential_id`, `source_partition`, `generation`,
`source_position`, `source_token`, `predecessor_token`, `duplicate_key`,
`message_family`, `message_type`, `trigger_event`,
`message_control_id_sha256`, `payload_ciphertext`, `payload_sha256`,
`payload_bytes`, `source_observed_at`, `source_received_at`, `clock_evidence`,
nullable `patient_uid`, nullable `visit_identity_sha256`, nullable
`order_identity_sha256`, `pending_task_id`, `review_role`, `status`,
`outcome_code`, `ack_ciphertext`, `ack_sha256`, `ack_bytes`, `ack_code`,
`http_status`, `policy_version`, `policy_signature`, `retention_policy`,
`retention_until`, and `recorded_at`. There is no mutable delivery status,
attempt counter, lease, or cursor column.

The raw message is encrypted with the existing tenant-bound field-encryption
helper before insertion. MSH-10 is available inside that ciphertext; only a
SHA-256 form is stored in an indexed plaintext column. Task titles,
descriptions, logs, metrics, and error responses must not copy raw HL7, patient
name, address, phone, PID-3, order text, or visit identifiers.

The receipt has:

- a unique `(tenant_id, recovery_inbox_id)` identity;
- a unique `(tenant_id, source_partition, generation, source_position)` source
  occurrence;
- a composite same-tenant foreign key to the canonical I03 inbox provenance;
- a composite same-tenant foreign key to the signing credential;
- composite same-tenant links for patient and task when present;
- a permanent duplicate constraint matching the approved I03 identity;
- `tenant_id NOT NULL` with no default;
- application-role `SELECT` and `INSERT` only;
- `UPDATE` and `DELETE` rejection through the established append-only trigger
  pattern; and
- explicit owner-governed retention metadata rather than an implicit purge.

To keep the receipt insert-only while linking the task atomically, the adapter
reserves `id` from the receipt sequence, creates the task with that id as its
related resource, and then inserts the complete receipt with the returned task
id. A rolled-back transaction may consume a sequence number; it cannot leave a
receipt or task. The adapter never inserts a partial receipt and updates it
later.

The Prisma mirror and seed-coverage policy must change with the SQL migration.
The migration, schema mirror, and test fixture must agree exactly; raw SQL is the
runtime authority for RLS, restrictive policies, triggers, and composite FKs.

## 7. Submission, downgrade fence, and late-domain adapter

### 7.1 Route branching

After parsing enough MSH data to resolve a credential, the route behaves as
follows:

1. A request containing `recovery` uses only the v1 recovery branch. A contract,
   signature, credential, family, or marker failure cannot fall through.
2. A DB-backed credential/family with an active I03 offset whose state is
   `paused`, `replaying`, or reconciliation-required cannot omit the recovery
   envelope and reach live mutation. It receives typed
   `HL7_I03_RECOVERY_ENVELOPE_REQUIRED`.
3. An exact already-handled recovery retry may retrieve its stored ACK even when
   the offset has reached `ready`.
4. A request without `recovery` for a credential/family with no non-ready I03
   offset continues through the current legacy live path. This delta does not
   claim that path is a durable sequenced stream.
5. The environment-secret fallback can use only the legacy path.

The fence prevents a sender from bypassing a paused/replaying recovery ledger
by deleting one JSON field. It does not introduce a global flag.

### 7.2 Validation and enqueue

The new I03 service validates the closed envelope inside a tenant transaction,
derives every identity server-side, and builds a closed command. It then calls
the existing `enqueueExternalRecoveryItem` with:

```text
interfaceFamily   = I03
arrivalClass      = recovery_backlog
sourcePartition   = server-derived credential/family partition
duplicateKey      = server-derived permanent key
commandFingerprint= exact message SHA-256
occurredAt        = EVN-2 or ORC-9
```

No raw message is put in the canonical inbox. The closed command is resupplied
to the synchronous processor, as existing C6.1 adapters do.

### 7.3 Adapter disposition

`persistLateHl7InboundRecovery` is registered as the I03 adapter. It requires
the minted I03 `late_pending_only` capability and revalidates the closed command
against the locked inbox before persistence.

For ADT it:

- inserts the encrypted immutable receipt;
- links the patient only when an active same-tenant patient is resolved;
- creates one existing workflow `review` task assigned to `MEDICAL_RECORDS`;
- uses `relatedResourceType='hl7_inbound_recovery_receipt'` and the receipt id;
- sets priority `high` and `slaCompletionSemantics='none'`; and
- returns `i03_adt_pending_admission_reconciliation`.

For ORM it performs the same receipt flow but assigns the review task to
`DUTY_DOCTOR` and returns
`i03_orm_pending_order_reconciliation`. A late order is clinical intent that
must not be authored by an integration credential or non-clinical queue.

The task tells an authorized human that retained external evidence needs
reconciliation. Completing it does not itself create an admission/order. Any
eventual clinical action must use the existing authenticated domain workflow and
its own audit, timeline, ownership, and authorization rails.

The adapter must not call the raw SQL live branch,
`admissionService.admitPatient`, a discharge/transfer mutation,
`createInvestigationOrder`, notification/outbox code, the pathway executor, or
an SLA service. Reimplementation of those effects inside the adapter is a
review failure.

### 7.4 Exact ACK contract

On a successful atomic late disposition, the adapter generates and stores one
exact HL7 `AA` whose text states that the message was accepted for
reconciliation and had no live clinical effect. `AA` here means durable
application acceptance into the owner-review workflow; it does not claim an
admission or order was applied.

The exact ACK bytes, hash, code, and intended HTTP status are committed with the
receipt. The route returns those committed bytes. It never regenerates an ACK
for an exact retry.

An exact duplicate behaves as follows:

- if the canonical inbox is handled, load the same-tenant receipt by inbox id,
  decrypt the exact stored ACK, verify its hash, and return the same bytes and
  status with no new task or effect;
- if the canonical inbox is still pending because another request committed
  enqueue but has not committed processing, return a retryable `AE`/HTTP 409;
  never fabricate an `AA`; and
- if the receipt, ACK, task, or terminal evidence is missing or inconsistent,
  fail closed and require reconciliation.

## 8. Atomicity, partial failure, and convergence

The public request spans four explicit phases. Only Phase 1.5 is the terminal
domain/cursor atomic unit.

| Phase | Atomic together | Semantics after failure |
|---|---|---|
| 0 — authenticate | HMAC verification and short-lived replay claim | The TTL claim can exist without durable I03 work. A retry uses a new signed request id; no clinical effect or cursor was committed. |
| 1 — durable enqueue | Canonical inbox collision check or pending inbox insert | A crash after commit leaves one pending item. Re-invocation finds the exact duplicate and continues or returns retryable pending evidence. |
| 1.5 — late disposition | Encrypted receipt, no-SLA review task, exact ACK issuance, terminal inbox status/outcome/task link, and cursor advance or owner-required pause | Any database error rolls back all of these. There is no partial receipt, task, ACK, or cursor. Serializable retry revalidates every fence. |
| 2 — HTTP response | Network delivery only | A lost response cannot roll back Phase 1.5. A newly signed exact retry returns the stored ACK and creates no second effect. |

Additional convergence rules:

1. Validation or authentication failure occurs before enqueue and has zero
   clinical, task, receipt, inbox, or cursor effect.
2. A task-insert, receipt-insert, encryption, terminal-fence, or cursor-fence
   failure rolls back Phase 1.5.
3. A source gap, retention gap, identity conflict, or predecessor mismatch does
   not skip the item. It leaves or moves the offset to an explicit
   reconciliation-required state.
4. An unknown same-tenant patient relation does not create a guessed identity or
   block later source positions. The immutable receipt and role task carry the
   item to human review without a patient link.
5. A recovered item never invokes post-commit clinical side effects. There is
   therefore no notification or pathway retry tail outside the database unit.

## 9. Failure and ACK mapping

| Condition | HL7 / HTTP result | Durable effect |
|---|---|---|
| Malformed HL7 or missing MSH | `AR` / 400 | None |
| Unknown, inactive, env-only, or wrong-tenant recovery credential | generic `AR` / 401 or 403 | None; no tenant/credential oracle |
| Invalid HMAC, stale timestamp, or modified recovery field | `AR` / 401 | None |
| Unknown recovery field, family/trigger mismatch, bad hash/token, or missing source occurrence | `AR` / 400 or 409 | None; partition remains closed |
| Recovery envelope omitted while its credential/family offset is non-ready | `AE` / 409 | None; live path is not reached |
| Marker absent, offset paused without owner resume, wrong generation, or retention gap | `AE` / 409 | Existing pending evidence retained; no cursor skip |
| Position, duplicate, payload, or predecessor conflict | `AE` / 409 | Offset becomes reconciliation-required; no winner inferred |
| Valid message with patient unresolved in authenticated tenant | stored `AA` / 200 after commit | Encrypted receipt plus unlinked role task; no clinical mutation |
| Valid late ADT/ORM | stored `AA` / 200 after commit | Receipt plus review task; no live clinical effect |
| Exact handled retry | exact stored `AA` / stored status | No new write or task |
| Exact retry while original inbox is pending | retryable `AE` / 409 | Existing pending row only |
| Database unavailable or Phase 1.5 rolls back | `AE` / 500 or 503 | No terminal receipt/task/ACK/cursor; sender retries |
| Response lost after commit | sender observes timeout | Exact retry returns stored outcome |

Error text is generic at the public boundary. Logs and metrics may include the
typed code, interface family, hashed partition, generation, and state, but not
raw HL7 or patient data.

## 10. Tenant, RLS, privilege, and PHI controls

The Step 2 migration must satisfy section 6.8 directly:

1. `tenant_id` is non-null and has no default.
2. Every tenant-bearing reference is a composite same-tenant FK. A scalar id is
   never sufficient evidence.
3. `PUBLIC` receives no privileges. Runtime roles receive only the table and
   sequence privileges required for same-tenant insert/read; they cannot update,
   delete, disable the append-only trigger, or alter policy.
4. RLS is enabled and forced. Policies are restrictive and require an explicit,
   valid `app.current_tenant_id`; absent, empty, default-tenant, malformed,
   `bypass`, or another tenant context sees/writes nothing.
5. Raw-PG tests use a temporary `NOSUPERUSER NOBYPASSRLS` role and prove
   same-tenant success plus cross-tenant, missing-GUC, default-tenant, forged
   credential, forged inbox, forged task, update, and delete rejection.
6. The runtime path uses `setTenantTx` and does not open raw `pg` connections or
   rely on a permissive pre-auth policy for domain writes.
7. Exact HL7 and ACK bytes are tenant-encrypted. Plaintext is decrypted only to
   return an authenticated exact duplicate or to an authorized reviewer through
   an existing PHI-audited surface; this slice adds no new receipt-read endpoint.
8. Retention is pinned to the signed canonical offset policy. Application code
   cannot shorten it, and no opportunistic TTL sweep removes permanent duplicate
   evidence.

The route must stop logging `patientUid`, test name, sending application, or raw
control id for recovery requests. Safe operational dimensions are bounded
hashes and typed state only.

## 11. Activation and operational sequencing

I03 remains inert after code merge. There is no global `I03_RECOVERY_ENABLED`
flag and no automatic offset creation.

A credential/family becomes recovery-capable only when all of the following are
true:

1. an active DB-backed HL7 credential exists for the tenant;
2. the sender has passed v1 conformance for exact-byte retention, durable
   monotonic sequence, predecessor chain, clock evidence, duplicate calculation,
   canonical HMAC, and exact-ACK retry;
3. the canonical activation surface has created the precise I03 offset with a
   signed policy, retention boundary, reconciled initial marker, and active
   generation;
4. Dr Bahuleyan S has signed the sender outstanding-count reconciliation and
   resume cutoff separately for the ADT and ORM partitions;
5. the `MEDICAL_RECORDS` and `DUTY_DOCTOR` review queues are visible to active
   tenant staff; and
6. the worker remains paused until owner-authorized resume moves that exact
   offset to `replaying`.

Restart order for one sender is:

1. keep external ingress closed;
2. restore database, encryption keys, replay store, task service, and canonical
   recovery substrate;
3. reconcile sender retained range and VH Health high-water evidence for ADT and
   ORM independently;
4. record the signed resume cutoff through the canonical activation surface;
5. replay one partition at a time and verify receipt/task/cursor counts after
   each item;
6. stop and reconcile every conflict or gap; never skip it;
7. verify the terminal cursor equals the signed cutoff and all late items have
   reachable review tasks; and
8. only then reopen that sender's normal live traffic.

The runbook continues to own external sender spool verification, physical or
vendor bridge handling, credential distribution/rotation, clock verification,
outstanding-count comparison, and reviewer-queue verification. Code cannot
absorb those physical and external-system facts.

## 12. Step 2 code-change ledger and clearance gates

This is a future ledger, not an edit authorization. The build must rebase on the
then-current main and derive its migration number fresh. It must not use 626.

### 12.1 Expected backend ledger

The smallest expected implementation delta is:

- `apps/backend/src/config/externalInterfaceRecoveryCatalog.js` — add closed I03
  metadata and mark I03 implemented only when the adapter is complete;
- `apps/backend/src/services/integrations/externalInterfaceRecoveryService.js`
  — register I03 and return its receipt identity without changing other family
  semantics;
- `apps/backend/src/services/integrations/externalHl7InboundRecoveryService.js`
  — new validator, canonical duplicate/token/signature helpers, adapter, exact
  ACK retrieval, and enqueue/process orchestration;
- `apps/backend/src/services/interop/tenantInteropSecretService.js` — one
  fail-closed DB credential-snapshot resolver for recovery;
- `apps/backend/src/services/hl7/hl7Parser.js` — bounded EVN, ORC, MSH-13, and
  visit/order evidence parsing without changing unrelated transformations;
- `apps/backend/src/routes/hl7/hl7Routes.js` — closed recovery branch,
  HMAC-envelope binding, downgrade fence, exact stored ACK response, and PHI-safe
  logging;
- `apps/backend/src/migrations/<fresh>_hl7_inbound_recovery.sql` — receipt,
  provenance, append-only, privilege, and restrictive RLS contract;
- `apps/backend/prisma/schema.prisma` and
  `apps/backend/src/db/seedCoveragePolicy.js` — exact schema/seed mirror;
- focused unit, route, integration, and raw-PG migration tests; and
- both OpenAPI specifications as a pair:
  `apps/backend/src/docs/openapi.json` and
  `packages/vhhealth_core/swagger/openapi.json`, including the recovery-envelope,
  exact-ACK, error, and downgrade-fence descriptions.

No package, deployment, application, migration, or route manifest addition is
expected. A discovered need to widen this ledger returns to design review.

### 12.2 Step-0 preflight

Before a build edit:

1. fetch `github/main` and record its exact SHA;
2. verify this delta is merged/cleared and the coordinator has opened the I03
   build window;
3. enumerate `apps/backend/src/migrations/*.sql`, confirm the live ceiling and
   vacancy notes, and derive the next unclaimed number fresh;
4. rerun the I03 route/parser/auth/catalog/recovery-service inventory against
   that SHA;
5. prove no competing work owns an overlapping migration or file ledger;
6. prove the worktree is clean and branch ancestry is exact; and
7. keep activation, deployment, main mutation, and merge outside the build lane.

### 12.3 Merge-blocking verification

The build is not complete until it proves all of the following:

- closed-envelope acceptance and every unknown-field/casing/coercion negative;
- every recovery field and message byte is HMAC-bound; modifying any one yields
  zero durable work;
- DB credential id, tenant, MSH-6, any API-client tenant, offset, partition,
  generation, family, trigger, MSH-10, payload hash, occurrence, position,
  predecessor, duplicate, and source token equality;
- environment-secret recovery is refused while legacy live compatibility is
  unchanged;
- an omitted envelope cannot bypass a non-ready enrolled offset;
- ADT and ORM partitions are independent, while A01/A02/A03 are strictly
  ordered together;
- exact retry returns the exact stored ACK and creates no second inbox, receipt,
  task, admission, investigation, timeline, audit, outbox, SLA, notification, or
  pathway effect;
- MSH-10 reuse with different bytes and position reuse with different identity
  both fail closed and require reconciliation;
- injected failure at receipt, task, terminal-inbox, ACK, and cursor steps rolls
  back the full Phase 1.5 unit;
- lost-response retry converges and a pending concurrent duplicate never receives
  a fabricated `AA`;
- unknown/cross-tenant patient identity creates no cross-tenant read or link and
  no live clinical mutation;
- the effect gate proves zero late writes to admissions, investigations,
  canonical clinical timeline/audit, outbox/webhook, notification, SLA,
  pathway, alert, and escalation tables;
- append-only and all section 6.8 raw-PG negatives pass under a non-owner,
  `NOBYPASSRLS` role;
- migration, Prisma schema, seed coverage, catalog, and both OpenAPI mirrors are
  exact;
- `git diff --check`, focused tests, backend lint, raw-parameter and no-default-
  tenant checks, OpenAPI drift/core/lint gates, schema/seed guardrails, the full
  backend suite, and the repository's canonical CI gate are green at the exact
  pushed SHA; and
- the branch is pushed and opened as an inert draft PR with receipts. The build
  lane never self-merges.

### 12.4 External clearance evidence

The repository cannot create these facts. Activation remains blocked until the
packet contains, per credential and family:

- sender/bridge product and version;
- durable spool location, capacity, encryption, retention, and backup evidence;
- sequence-allocation transaction and crash-consistency proof;
- oldest retained and last assigned position/token;
- outstanding count and exact-byte hash manifest;
- clock identity, last synchronization, and maximum error;
- v1 canonical HMAC conformance vectors, including forgery negatives;
- exact-ACK retry behavior and timeout policy;
- named vendor/operator contact; and
- Dr Bahuleyan S's signed initial marker, resume cutoff, retention policy, and
  restart authorization.

## 13. Non-goals and rollback boundary

This delta does not:

- authorize a migration number, implementation, activation, deployment, or
  environment change;
- change the current live A01/A02/A03/O01 clinical semantics;
- turn MSH-10, MSH-13, receipt time, an admission id, or an investigation id into
  a cursor;
- create a new admin activation surface, replay workbench, task engine, cursor,
  queue, or generic interface framework;
- ingest ORU results through the legacy route;
- apply a late admission, transfer, discharge, or order automatically;
- notify a patient or staff member, page a clinician, start/settle an SLA, or
  transition a pathway from late I03 data;
- allow environment-secret recovery or infer a credential identity;
- expose a new PHI receipt reader;
- activate every tenant or sender through a global flag; or
- merge its own future build PR.

Before per-sender activation, rollback is removal of the inert code/schema only
through a separately reviewed forward change. After any durable I03 receipt or
offset evidence exists, rollback never deletes, rewrites, or reuses it. The
credential/family offset is paused or retired, sender ingress is closed, and a
new generation or implementation is introduced only after owner reconciliation
and a new signed decision.
