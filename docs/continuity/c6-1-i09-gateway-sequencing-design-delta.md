# C6.1 I09 device-vitals gateway sequencing — design delta

**Status:** Step 1 discovery-first design delta; implementation is not cleared

**Scope in this step:** this document only

**Future implementation owner:** `apps/device-gateway` and its held tests and
deployment configuration; C6.1-B separately owns every backend acceptance-path
change

**Branch:** `feat/continuity-i09-gateway-contract`

**Baseline:** `github/main` at
`fe55406d299ee93d595170aedb803de9acecf681`, fetched
`2026-08-01T02:21:07+05:30`

**Baseline commit time:** `2026-08-01T01:46:22+05:30`

**Activation:** none; the gateway deployment remains held

**Merge state:** never merge from this lane

## 1. Phase A verdict — an existing in-repository component needs a code change

**Verdict:** I09 is an existing in-repository Node service under
`apps/device-gateway`, not an external appliance contract and not a greenfield
component. This packet is therefore a **code-change design delta for the
existing gateway**. The repository contains a gateway-side durable spool, but
the deployment is held, its production entrypoint does not start a drain, and
the spool has no source sequence, predecessor chain, durable duplicate ledger,
or backend-high-water handshake. No device-side buffer was found.

This verdict does not claim that the held gateway is deployed at a facility.
The actual monitor vendors, any vendor or central-station buffering, the
facility endpoint, and the running production component are **OWNER/OPERATOR
INPUT**. Repository evidence supports the implementation shape, not a live-site
claim.

### 1.1 What receives device MLLP, and where it runs

The repository names the component directly:

> "VH Health NL-7 bedside device gateway: MLLP ingress, durable spool,
> backend drain."

That description is in `apps/device-gateway/package.json:2-7`. The runtime
opens MLLP TCP listeners with `net.createServer`, passes complete frames to
`GatewayRuntime.acceptFrame`, and sends MLLP acknowledgements
(`apps/device-gateway/src/gateway.js:210-246`). It then calls the backend's
separate device-vitals resolve and ingest routes
(`apps/device-gateway/src/backendClient.js:18-38`).

The intended runtime is one Kubernetes replica with a persistent spool volume:

> `replicas: 1`

> `mountPath: /var/spool/vhhealth-device-gateway`

> `claimName: device-gateway-spool`

Those values are in
`infra/kubernetes/base/device-gateway/deployment.yaml:9-10` and
`:49-51`, `:74-77`. However, the same manifest pins
`ghcr.io/bahuleyandr/vh-health-device-gateway:held`, and the component
Kustomization calls itself `vhhealth-device-gateway-held`
(`infra/kubernetes/base/device-gateway/deployment.yaml:25-27`;
`infra/kubernetes/base/device-gateway/kustomization.yaml:1-10`). No production
or default Kustomization includes that component directory on this baseline.

The generic Admin interface-engine page and backend tables are not the I09
receiver. They configure systems/channels, including a declared
`mllp_listener` connector kind, but their visible inbound data plane is an HTTP
route at `/api/v1/interface-engine/channels/:channelKey/hl7`
(`apps/backend/src/routes/interfaceEngine/interfaceEngineIngressRoutes.js:21-44`).
The device path is separately mounted at `/api/v1/devices`
(`apps/backend/src/app.js:1045-1050`). The interface-engine transform path
records a `deliver_backend` attempt without invoking a device-vitals adapter
(`apps/backend/src/services/interfaceEngine/interfaceEngineService.js:778-812`).
It is not substituted for `apps/device-gateway` in this delta.

### 1.2 Identity and authentication the backend sees today

The trust path has two layers.

1. **Gateway to backend.** `BackendClient` adds a bearer token and API key to
   the resolve and ingest HTTP requests
   (`apps/device-gateway/src/backendClient.js:1-37`). The held deployment loads
   `DEVICE_GATEWAY_BACKEND_TOKEN` and `DEVICE_GATEWAY_API_KEY` from a Secret
   (`infra/kubernetes/base/device-gateway/deployment.yaml:36-48`). The backend
   permits the `DEVICE_GATEWAY` role only on the resolve and ingest surfaces
   and derives tenant context from the authenticated request
   (`apps/backend/src/routes/emr/deviceVitalsRoutes.js:29-39`, `:48-80`).
2. **Monitor/device within that tenant.** The gateway sends source IP, the
   MSH sending application/facility-derived device code, and channel to the
   resolve operation (`apps/device-gateway/src/gateway.js:64-93`). The backend
   resolves an active tenant-scoped `device_registry` row either by an optional
   device bearer credential or by allowed source IP plus device code
   (`apps/backend/src/services/emr/deviceVitalsService.js:573-596`;
   `apps/backend/src/services/devices/deviceRegistryService.js:330-409`).

The registry contains tenant, device code, kind, protocol, source-IP allowlist,
credential hash/prefix, and lifecycle status. It explicitly supports
`monitor_gateway`, `monitor`, and `mllp-hl7v2`
(`apps/backend/src/migrations/371_device_registry.sql:1-41`). Credentials can
be issued and rotated through the existing registry service and Admin surface
(`apps/backend/src/services/devices/deviceRegistryService.js:207-250`,
`:310-328`; `apps/backend/src/routes/admin/deviceRegistryRoutes.js:73-82`,
`:245-255`).

The present `apps/device-gateway` MLLP flow does **not** forward a per-device
bearer token. It uses its gateway JWT/API key and resolves the monitor by
source IP/device code. No I09 mTLS or HMAC verification was found. This delta
does not describe either control as existing.

The backend ultimately sees:

- authoritative tenant from the authenticated gateway request;
- the gateway actor role/UID from its JWT;
- active `device_registry.id` and `device_code` after resolution;
- source IP during resolution, but not during the later ingest call;
- optional device/patient association and channel;
- MSH-10 as the message control ID; and
- the raw HL7 message submitted to `/vitals/ingest`.

Tenant is never taken from MSH fields or a gateway-supplied tenant assertion.
The current ingest path checks the active device code again but does not repeat
the source-IP resolution (`apps/backend/src/services/emr/deviceVitalsService.js:387-415`).

### 1.3 What buffer exists today and what an outage does

There is a gateway-side spool. `NdjsonSpool.append` writes one JSON line and
calls `fh.sync()` before returning; exceeding `maxBytes` throws
`SPOOL_FULL` (`apps/device-gateway/src/spool.js:12-52`). `acceptFrame` returns
MLLP `AA` only after that append succeeds, `AR` when the spool is full, and
`AE` on other rejection (`apps/device-gateway/src/gateway.js:64-103`).

The spool is not yet a safe recovery stream:

- it is partitioned by the MSH sending application/facility-derived string,
  not the required tenant/gateway/device identity;
- its row ID is a random UUID, not a monotonic source position;
- it stores no generation, source token, predecessor token, message SHA-256,
  or backend offset binding;
- duplicate MSH-10 state is an in-memory map with a 24-hour TTL and is lost on
  restart (`apps/device-gateway/src/gateway.js:19-61`);
- a 4xx backend response moves the payload to a dead-letter file and removes it
  from the active spool (`apps/device-gateway/src/gateway.js:106-130`;
  `apps/device-gateway/src/spool.js:72-87`);
- removal rewrites the complete file, without a transaction tying compaction
  to an authoritative backend high-water mark
  (`apps/device-gateway/src/spool.js:65-75`); and
- `apps/device-gateway/src/index.js:1-23` starts listeners but never invokes or
  schedules `drainSource`.

The repository contains no device-firmware or central-station spool. A monitor
that receives `AR`/`AE` may retry, buffer, or drop according to vendor behavior;
that behavior is **OWNER/OPERATOR INPUT**. When the held gateway is not deployed,
the repository cannot claim any production outage buffer. When it is running
with the PVC mounted, it durably accepts frames into the gateway spool, but
automatic post-restart/backend-outage delivery is currently unwired.

## 2. Binding authority and frozen safety boundary

The merged C6.1 disposition is exact:

> "I09 | HWM required — gateway MLLP spool stream"

> "Durable gateway spool sequence and predecessor token reconciled to the
> backend offset. Backend refuses unsequenced recovery traffic."

It binds the partition to tenant/gateway source/device, duplicate identity to
tenant plus device/source plus MSH-10, and fingerprint to the canonical message
SHA-256 (`docs/continuity/c6-1-resume-markers-design-delta.md:426-437`). The
delivery order then states:

> "The backend refuses recovery traffic until a separately cleared
> gateway/client change supplies source sequence and duplicate identity."

That is `docs/continuity/c6-1-resume-markers-design-delta.md:508-511`. This
delta is the separately cleared gateway side of that seam. It does not modify,
restate, or pre-implement C6.1-B's backend acceptance path.

Migration 603 is the backend authority. Its external offset rows carry
`high_water_position`, `high_water_token`, retained-from and resume-cutoff
markers, recovery state, policy, signature, and retention bindings
(`apps/backend/src/migrations/603_external_interface_recovery.sql:17-38`). Its
named recovery states are:

> `paused`

> `ready`

> `replaying`

> `reconciliation_required_missing_marker`

> `reconciliation_required_retention_gap`

> `reconciliation_required_source_gap`

> `retired`

These are the only states used by this contract
(`apps/backend/src/migrations/603_external_interface_recovery.sql:54-66`). The
gateway never invents a parallel state vocabulary that claims backend
acceptance.

C-D8 remains closed. Every I09 recovery-backlog observation is
`late_pending_only`: persist the observation and required pending-review work,
but do not start or change NEWS2 escalation, triage, care pathways, workflow
SLAs, notifications, or other current clinical effects. Migration 603 already
requires pending work before a late item can be terminally handled and guards
SLA, pathway-transition, and notification writes
(`apps/backend/src/migrations/603_external_interface_recovery.sql:367-396`,
`:785-820`). Gateway sequencing never widens that boundary.

## 3. Contract vocabulary and partition identity

The contract identifier is `vhhealth.i09.gateway-sequence/v1`. It is a closed
schema. Unknown fields or a different version are non-conformant, not
best-effort-compatible.

One source partition is exactly:

```text
(authoritative tenant_id, gateway device_registry.id, monitor device_registry.id)
```

The canonical `source_partition` text is:

```text
i09/gateway/{gateway_registry_id}/device/{device_registry_id}
```

Tenant remains the separate tenant key on migration 603's offset and inbox
rows. The gateway stores the tenant UUID returned by the authenticated backend
read and compares it on every handshake; it cannot choose or override it.

The identities are assigned as follows:

- `gateway_registry_id` is an operator-provisioned active `device_registry`
  row with `kind='monitor_gateway'`. The held gateway instance is bound to it
  through protected configuration, not an MSH field.
- `device_registry_id` is the immutable database identity returned by the
  existing resolve operation for the active monitor source. `device_code` is
  retained as a display/audit snapshot but is not the partition key.
- `generation` comes only from the backend's live migration-603 offset row.
  Restart, local file deletion, device-code rename, redeployment, or clock
  change never increments it.
- `channel` and patient association are clinical routing context. They do not
  split or join a sequencing partition.

One gateway credential may serve multiple device partitions within its
authenticated tenant. It must not serve multiple tenants under one backend
credential. A separate authenticated tenant binding and separate spool root
are required for each tenant.

Creating the `monitor_gateway` registry row, assigning its facility, confirming
its monitor set, and deciding whether a facility runs one or several gateway
instances are **OWNER/OPERATOR INPUT**. The contract fixes identity semantics;
it does not make a deployment or procurement choice.

## 4. Durable spool contract

### 4.1 Persisted record

Before the gateway sends `AA`, one immutable record is durably committed under
the exact partition. It contains:

| Field | Rule |
| --- | --- |
| `schema` | Exact `vhhealth.i09.gateway-sequence/v1` |
| `tenant_id` | Backend-authenticated tenant UUID; never derived from HL7 |
| `gateway_registry_id` | Provisioned active `monitor_gateway` identity |
| `device_registry_id` | Resolved active monitor identity |
| `device_code_snapshot` | Resolved display/audit value; not authority |
| `source_partition` | Exact canonical partition string above |
| `generation` | Backend-supplied live offset generation |
| `source_position` | Unsigned monotonic value representable by PostgreSQL `BIGINT` |
| `source_token` | Hash-chain token defined in section 5 |
| `predecessor_token` | Token at the immediately preceding position |
| `msh10` | Exact non-empty MSH-10 after HL7 field extraction |
| `duplicate_key` | Canonical duplicate key defined in section 5 |
| `message_sha256` | Lower-case SHA-256 of the exact accepted unframed bytes |
| `message_bytes` | The one existing PHI-bearing payload copy, byte preserving |
| `source_occurred_at_raw` | Exact source timestamp text when present; no correction or inference |
| `gateway_received_at` | Gateway clock evidence only; never ordering authority |
| `clock_evidence` | Clock source/status/sample and measured offset when available |
| `accepted_at` | Gateway operational evidence, not clinical occurrence time |
| `delivery_state` | Local pending/attempt evidence; never a claim of backend acceptance |

The MLLP reader must retain the exact bytes between the leading VT and trailing
FS+CR. It validates strict UTF-8 for the current JSON/backend transport but does
not decode and re-encode before hashing. MLLP framing bytes are excluded. A
same-MSH-10 message with different byte content is a conflict even if a parser
would normalize it to equivalent fields.

Mutable attempt count, last attempt time, safe error code, and locally observed
backend state are stored separately from the immutable record. They never
change duplicate identity, fingerprint, sequence, or tokens.

### 4.2 AA ordering and crash safety

The acceptance order is fixed:

1. parse a complete bounded MLLP frame and require message type and MSH-10;
2. resolve authoritative tenant, gateway, and device partition;
3. verify that the partition is provisioned and its local manifest agrees with
   the backend-issued generation and marker;
4. check the durable duplicate ledger;
5. allocate exactly the next source position and construct its predecessor and
   source token;
6. append the payload record and duplicate receipt, update the partition
   manifest, and make all three crash durable;
7. re-read or otherwise verify the committed tail; and only then
8. send `AA`.

Any failure before step 8 returns `AE`, except a verified hard-capacity refusal,
which returns `AR`. A process crash after durable commit but before `AA` is
resolved by the sender retrying the same MSH-10: the durable receipt returns
`AA` without allocating another position. A crash before durable commit leaves
no receipt and cannot produce `AA`.

An implementation may retain an append-only file format or use another local
store, but it must provide atomic manifest/tail recovery, checksums, file and
directory durability, single-writer partition locking, and deterministic torn
tail handling. A successful unit test around `fsync` is not by itself proof of
PVC/storage durability; the storage class and node power-loss behavior remain
an activation preflight.

### 4.3 Compaction and retention

A backend HTTP 2xx response alone never deletes an item. The gateway may
compact payload bytes only after an authenticated backend read reports a
matching or later high-water position and the token at the compacted boundary
matches the durable local receipt chain. Lost-response ambiguity is therefore
settled by backend authority, not an assumed success or a blind resend.

After payload compaction, the gateway retains the non-payload receipt containing
partition, generation, position, tokens, MSH-10 duplicate identity,
`message_sha256`, and backend outcome reference for at least the signed
retention period returned with the offset. This prevents a restarted gateway
from re-arming a duplicate after its PHI payload has been removed.

Current 4xx dead-letter-and-remove behavior is forbidden for sequenced I09
items. A 4xx keeps the immutable item and chain in place, stops that partition,
and requests owner reconciliation. A 5xx, timeout, or connection loss keeps the
item pending and causes a fresh high-water read before another delivery.

### 4.4 Bounded capacity and explicit overflow

Capacity is bounded twice: a per-partition hard limit and a gateway-wide hard
limit that reserves space for manifests, receipt ledgers, gap records, and
safe compaction. The byte values, alert watermarks, required outage horizon,
and retention duration are **OWNER/OPERATOR INPUT** derived from measured
message rates and the provisioned PVC. The existing 1 GiB per-source setting
and 10 GiB PVC do not become clinical policy by appearing in a manifest.

There is no oldest-drop, circular overwrite, unrecorded dead-letter, or
automatic retention shortening. At a hard limit the gateway:

1. leaves every already-acknowledged record unchanged;
2. durably records a non-payload gap event with reason `capacity_refusal`,
   partition, last committed position/token, MSH-10, message hash, time, and
   capacity evidence when that frame can be safely identified;
3. returns `AR` and does not allocate a source position for the refused frame;
4. raises a non-PHI operational alert; and
5. reports the gap at the next backend handshake, which holds the partition in
   `reconciliation_required_retention_gap` until owner disposition.

If even the gap record cannot be committed, the gateway returns `AE`, marks the
whole spool unhealthy, and removes listener readiness. It never returns `AA`.

## 5. Monotonic sequence, predecessor, and duplicate identity

### 5.1 Source position and generation

Positions increase by exactly one within a partition and backend-issued
generation. The next position is the durable local tail plus one. On an empty
local tail it is the backend high-water position plus one. Position zero is
reserved for a backend-provisioned genesis marker and is never a device
message.

The gateway cannot create a generation. A new partition starts only after the
backend has created an external I09 offset with a non-null high-water position
and token. A missing initial marker maps to
`reconciliation_required_missing_marker`; the conformant listener is not ready
and no frame from that source receives `AA`.

If `BIGINT` exhaustion is approached, the gateway pauses the partition and
requires owner-directed retirement/new-generation provisioning. It never wraps
or resets to zero.

### 5.2 Exact message and token calculations

`message_sha256` is:

```text
lower_hex(SHA-256(exact bytes between MLLP VT and FS+CR))
```

The logical duplicate identity is exactly:

```text
(tenant_id, device_registry_id, MSH-10)
```

The transport `duplicate_key` is lower-case SHA-256 over length-prefixed UTF-8
components in this order:

```text
vh-i09-duplicate-v1
tenant_id
device_registry_id in canonical base-10
MSH-10 exact text
```

Length-prefixing is mandatory; delimiter concatenation is not equivalent.
MSH-10 and the component values remain stored beside the digest for audit and
collision diagnosis.

`source_token` is lower-case SHA-256 over length-prefixed UTF-8 components in
this order:

```text
vh-i09-source-token-v1
tenant_id
source_partition
generation in canonical base-10
source_position in canonical base-10
predecessor_token
duplicate_key
message_sha256
```

For position `N`, `predecessor_token` must equal the source token at `N-1`.
For the first locally accepted item it equals the authenticated backend
high-water token. This makes the locally durable chain and migration-603
cursor comparable without allowing the gateway to rewrite backend history.

### 5.3 Duplicate and conflict behavior

- Same logical duplicate identity and same `message_sha256`: return the stored
  local/backend typed outcome when known, do not allocate a position, do not
  append another payload, and return `AA` only after the durable receipt is
  verified.
- Same logical duplicate identity and different `message_sha256`: return
  `AE`, keep all existing evidence, stop the partition, and request
  `reconciliation_required_source_gap` with reason
  `msh10_fingerprint_conflict`.
- Same source position with any different token, predecessor, duplicate key,
  or fingerprint: never rewrite. Hold as
  `reconciliation_required_source_gap`.
- A duplicate response lost between backend and gateway is resolved by the
  next authenticated high-water read or the backend's exact stored duplicate
  outcome. Neither side re-executes the clinical adapter.

The current 24-hour in-memory gateway map and 24-hour backend
`device_vitals_control_ids` expiry are not the C-D8 duplicate contract. They
may remain as short-circuit compatibility controls, but cannot authorize
receipt deletion, replay, or re-execution.

## 6. Recovery handshake and ordered replay

C6.1-B owns the backend routes and writes. This section freezes the logical
operations and fields the gateway consumes so the two lanes meet at one seam;
it does not require a specific URL in this gateway-only packet.

### 6.1 Read authoritative resume state

Before the first drain, after restart, after any backend error/timeout, after
credential rotation, and before recovery resumes, the gateway invokes a
C6.1-B authenticated **Read I09 Resume State** operation using its existing
gateway JWT/API key and provisioned gateway/device identities. The response is
read from the live migration-603 external row and contains:

```text
contract = vhhealth.i09.gateway-sequence/v1
interface_family = I09
tenant_id
offset_id
source_partition
generation
recovery_state
high_water_position
high_water_token
retained_from_position
retained_from_token
resume_cutoff_position
resume_cutoff_token
policy_version
policy_signature
retention_policy
retention_until
```

The backend-authenticated tenant and offset row are authority. The gateway
compares them to its local partition manifest and stops on any mismatch. It
never sends a write that sets or advances the backend high-water mark directly.

The gateway may report its retained-from marker, durable local head, capacity
evidence, and chain digest as **resume evidence**. That report is a proposal for
owner review, not a cursor update. Only the backend/owner-controlled C6.1-B
transition can place the offset in `replaying` and set a resume cutoff.

### 6.2 Identify every submitted item

Every enrolled source sends the existing device-vitals request plus a closed
`recovery` envelope. Enrolled live traffic also carries the envelope; this
avoids inferring recovery from clinical timestamps.

```json
{
  "message": "<existing HL7 payload>",
  "device_code": "<existing resolved code>",
  "patient_uid": "<existing optional resolved association>",
  "channel": "<existing channel>",
  "recovery": {
    "schema": "vhhealth.i09.gateway-sequence/v1",
    "interface_family": "I09",
    "arrival_class": "live | recovery_backlog",
    "tenant_id": "<must equal authenticated tenant>",
    "gateway_registry_id": 0,
    "device_registry_id": 0,
    "offset_id": "<backend UUID>",
    "source_partition": "i09/gateway/.../device/...",
    "generation": 1,
    "source_position": "1",
    "source_token": "<lower-case SHA-256>",
    "predecessor_token": "<previous token>",
    "msh10": "<message control ID>",
    "duplicate_key": "<lower-case SHA-256>",
    "message_sha256": "<lower-case SHA-256>",
    "gateway_received_at": "<RFC 3339 clock evidence>",
    "clock_evidence": {}
  }
}
```

The numeric zeroes above are schema examples only and are invalid runtime
identities. Positions are decimal strings so JavaScript cannot lose `BIGINT`
precision. The backend re-derives tenant, device, MSH-10, duplicate key, and
message SHA-256 and rejects any mismatch. It does not trust the echoed tenant
or fingerprint.

`arrival_class` is operational, not timestamp-inferred:

- `live` is permitted only when the backend state is `ready`, the local tail
  directly follows the authenticated HWM, and no recovery cutoff is open;
- `recovery_backlog` covers every item at or below the backend-authorized
  resume cutoff; and
- items accepted while recovery is open remain queued behind the cutoff and
  are not interleaved with backlog.

Unknown or missing arrival class is not treated as live. C6.1-B holds it for
reconciliation.

### 6.3 Replay order

For a backend offset in `replaying`:

1. freeze that partition's live drain and continue only durable spooling;
2. verify the local chain from backend HWM plus one through the backend-issued
   resume cutoff;
3. send exactly HWM plus one, with its predecessor equal to the authenticated
   HWM token;
4. wait for a typed backend result;
5. re-read backend state after any ambiguity and at bounded checkpoints;
6. proceed only when backend HWM equals the submitted position and token; and
7. stop when the backend reports a reconciliation state, credential failure,
   conflict, or unprocessable item.

There is one in-flight item per partition. Different partitions may progress
independently only when storage locking and backend tenant isolation remain
valid. A later item never bypasses a failed predecessor.

### 6.4 Completion

Recovery is complete only when an authenticated read reports all of:

- `recovery_state='ready'`;
- `high_water_position=resume_cutoff_position`;
- `high_water_token=resume_cutoff_token`; and
- the local receipt at that position has the same token.

The gateway cannot declare completion from an empty local file, a final HTTP
2xx, an attempt count, or its own head. After completion it may compact payloads
through the confirmed HWM, retain the receipt ledger, and drain post-cutoff
items under a new authoritative read.

## 7. Failure modes are owner-reconciled, never inferred

| Evidence/failure | Mandatory gateway action | Migration-603 state/reason |
| --- | --- | --- |
| Offset absent, HWM position/token incomplete, or local manifest has no authenticated genesis | Do not mark source ready; return `AE` for enrolled source and expose non-PHI fault | `reconciliation_required_missing_marker`; reason identifies missing backend or local marker |
| Local retained-from position is later than backend HWM plus one; acknowledged receipt/payload is missing; hard-capacity refusal occurred; corrupt/torn evidence cannot prove the acknowledged chain | Preserve files, stop partition, no skip or oldest-drop | `reconciliation_required_retention_gap`; reason such as `local_retention_gap`, `capacity_refusal`, or `spool_corruption` |
| Sequence reset/regression, predecessor mismatch, token mismatch, MSH-10/fingerprint conflict, unexplained backend-ahead marker, or unprocessable sequenced item | Preserve both sides of conflict; no renumber/rewrite | `reconciliation_required_source_gap`; precise non-PHI reason |
| Backend timeout or response loss | Keep item; read HWM; resend only if backend remains behind | No inferred state change; backend row remains authority |
| Backend 5xx | Stop ordered drain and retry with backoff after resume-state read | No inferred state change |
| Backend 4xx validation/policy refusal | Keep item and chain; stop later positions | `reconciliation_required_source_gap` unless C6.1-B returns a more specific existing reconciliation state |
| Device replacement during an unresolved gap | Keep old device partition intact; resolve replacement to a new `device_registry.id`; never move old payloads to it | Old partition remains in its reconciliation state; new partition needs separately provisioned marker/generation |
| Gateway source replacement or restored PVC from another instance | Refuse manifest adoption until tenant, gateway ID, device ID, generation, and chain are owner-verified | Missing marker, retention gap, or source gap according to the evidence; never auto-select |
| Clock unavailable, untrusted, or outside the owner-approved bound; source clinical time missing/ambiguous | Preserve raw source time and gateway clock evidence; never adjust occurrence time or sequence; hold owner review | `reconciliation_required_source_gap` with `clock_evidence_untrusted` or `source_time_ambiguous` when C6.1-B cannot validate occurrence evidence |
| Position space exhaustion | Stop before overflow; retain chain | `reconciliation_required_source_gap`, then owner-authorized retirement/new generation |

Only an authorized owner/operator workflow may resolve a reconciliation state,
choose a new generation, accept a documented loss, retire a partition, or set
a resume cutoff. The gateway provides evidence and obeys the returned state; it
does not infer approval from silence or elapsed time.

Device replacement never changes patient association retrospectively. Old
spooled entries remain bound to the old `device_registry.id` and their original
association evidence. The existing service rule that it never guesses a
patient from bed/location context remains unchanged
(`apps/backend/src/services/emr/deviceVitalsService.js:3-7`, `:348-379`).

## 8. Security and PHI boundary

### 8.1 Credential lifecycle

The contract preserves the existing layered authentication:

- MLLP ingress is restricted by the gateway network boundary and resolved
  against an active tenant-scoped device registry row with allowed source IPs;
- compatible sources may additionally use the registry's existing per-device
  credential, but the current MLLP gateway does not do so and activation cannot
  claim it;
- gateway-to-backend calls require the existing API key and a tenant-bound
  `DEVICE_GATEWAY` JWT;
- the gateway's stable source identity is a separate active
  `monitor_gateway` registry row;
- paused, revoked, archived, source-IP-mismatched, wrong-tenant, or wrong-kind
  identities fail closed; and
- credential issue/rotation uses the existing one-time plaintext issuance and
  stored hash/prefix model. No plaintext credential, JWT, API key, or Secret
  value is written to spool, gap, receipt, metric, or log records.

Rotation is per gateway/source, not global. A rotated/expired backend token
pauses delivery but not durable MLLP acceptance while local capacity and marker
integrity remain safe. The first request after rotation performs a new resume
state read. Device credential rotation invalidates cached resolution and
requires re-resolution before another `AA`.

This delta does not add or claim mTLS, HMAC, device firmware authentication, or
vendor certificate support. Whether a facility requires those controls is
**OWNER/OPERATOR INPUT** and any addition needs a separately reviewed trust and
provisioning contract.

### 8.2 No new PHI exposure

The I09 vitals payload already crosses the MLLP gateway, is stored in the
current spool, and is sent to the device-vitals backend. The sequencing change
keeps exactly one payload copy in the same gateway trust boundary. It adds
tenant/gateway/device identifiers, positions, tokens, MSH-10 duplicate
identity, hashes, state, and clock evidence; it does not add a second clinical
payload, new patient field, new external recipient, or new telemetry copy.

Spool files remain PHI-bearing because the existing HL7 message is PHI. Step 2
must use restrictive filesystem ownership/mode, the existing non-root pod,
bounded access, encrypted storage where the approved storage class provides
it, and byte-safe compaction. Logs, Prometheus labels, and gap alerts contain
no patient UID, raw HL7, OBX value, or MSH-10. Detailed receipt evidence remains
inside the protected spool/administrative evidence surface.

Payload retention, PVC encryption assurance, backup policy, forensic retention,
and secure disposal are activation inputs. This packet neither lengthens nor
shortens a clinical/legal retention period.

## 9. Per-source rollout without a global flag

Capability is detected and enforced by source partition. There is no process-
wide `I09_RECOVERY_ENABLED` switch.

Each listener/source mapping may declare
`recovery_contract='vhhealth.i09.gateway-sequence/v1'` together with its
provisioned `gateway_registry_id`. The gateway treats a resolved monitor as
conformant only after the backend returns a matching live I09 offset and the
local manifest/chain verifies. Merely setting configuration does not claim the
capability.

The backend detects capability from the enrolled source partition and the
closed envelope:

- an enrolled partition requires valid sequencing metadata on live and
  recovery submissions;
- another facility/source without an I09 offset remains non-conformant and is
  not affected by a global activation;
- a gateway cannot borrow another partition's offset, generation, or HWM;
- malformed, missing, cross-tenant, wrong-generation, or wrong-partition
  metadata is refused; and
- C6.1-B's refusal for non-conformant recovery remains unchanged: refuse the
  recovery item and surface pending review, with no NEWS2, triage, pathway,
  SLA, or notification effect.

Recommended rollout states are evidence labels, not new backend states:

1. `legacy_unsequenced`: current live-only compatibility; recovery is not
   authorized and C6.1-B refuses it;
2. `shadow_chain`: gateway computes and verifies the chain on synthetic or
   non-activated sources, but cannot send recovery traffic; and
3. `enrolled`: a specific partition has an owner-cleared migration-603 offset,
   matching local marker, cleared C6.1-B endpoint, and passing facility
   evidence.

Promotion is one partition at a time. Removing enrollment does not delete
offsets, receipts, payloads, gaps, pending work, or audit evidence. Rollback
stops new recovery delivery and returns the backend offset to an owner-directed
paused/reconciliation state; it never rewinds HWM or re-arms accepted messages.

The held image, Service, PVC, NetworkPolicy, and Kustomization remain
unactivated. This delta makes no facility, vendor, endpoint, storage-class,
capacity, or procurement decision.

## 10. Step 2 code-change ledger and clearance gates

### 10.1 Gateway-owned files

After coordinator clearance and the standard preflight, one gateway Step 2 may
change only the following implementation surfaces unless a revised ledger is
approved:

| Surface | Required change |
| --- | --- |
| `apps/device-gateway/src/mllpFrameReader.js` | Preserve exact unframed bytes and validate strict UTF-8 without hash-changing re-encoding |
| `apps/device-gateway/src/hl7.js` | Closed extraction of MSH-10/source time needed by the contract; no clinical interpretation |
| `apps/device-gateway/src/spool.js` | Tenant/gateway/device partitions, durable manifests/receipts/gaps, monotonic chain, safe compaction, corruption detection, global and partition capacity |
| `apps/device-gateway/src/gateway.js` | Provisioned partition resolution, AA ordering, durable duplicate behavior, ordered live/recovery drain, failure-state fencing |
| `apps/device-gateway/src/backendClient.js` | Consume C6.1-B resume-state read and send the closed recovery envelope |
| `apps/device-gateway/src/index.js` | Supervised startup validation and per-partition drains; no drain before handshake |
| `apps/device-gateway/src/metrics.js` | Non-PHI capacity, chain-health, HWM lag, recovery-state, refusal, and reconciliation signals |
| `apps/device-gateway/tests/**` and `apps/device-gateway/scripts/soak-replay.mjs` | Crash, ambiguity, capacity, chain, mixed-rollout, and recovery proofs |
| `infra/kubernetes/base/device-gateway/**` | Held per-source capability configuration, storage/probe/resource wiring only; still excluded from production composition |

The Step 2 gateway PR does not touch `apps/backend`, backend migrations,
Prisma, Admin, Staff, Patient, production overlays, Argo CD Applications, DNS,
or deployment activation. If the cleared C6.1-B contract requires a different
field or operation, the coordinator reconciles the two deltas before either
build; the gateway lane does not edit backend code to make tests pass.

### 10.2 Required preflight

Before any Step 2 build:

1. re-fetch `github/main` and record exact SHA/time;
2. verify the exact C6.1-B merge/PR state and re-read its landed request,
   response, error, and pending-review contract;
3. confirm migration 603 and the I09 catalogue disposition have not drifted;
4. inspect every active worktree and ensure the requested gateway branch/path
   is unoccupied;
5. read all applicable repository instructions;
6. obtain the owner/operator inputs below or leave the corresponding activation
   path blocked;
7. freeze the gateway-only file ledger and test matrix; and
8. create a fresh worktree from current `github/main`.

Step 2 queues only after coordinator clearance. It remains an inert gateway
code PR and never merges from the implementation lane.

### 10.3 Required verification

At minimum, Step 2 proves:

- crash before append, after append/before `AA`, and after `AA`;
- duplicate retry after gateway restart and after receipt-only compaction;
- backend commit with lost response, backend timeout/5xx, and 4xx refusal;
- local head/HWM match, backend ahead, local ahead, token mismatch,
  predecessor gap, sequence regression, and generation mismatch;
- torn tail, corrupted middle record, missing manifest, restored foreign PVC,
  and receipt/payload disagreement;
- per-partition and global hard capacity with no oldest-drop and durable gap
  evidence;
- device replacement and gateway replacement while old backlog exists;
- trusted, skewed, absent, and ambiguous clock evidence without timestamp-based
  ordering;
- mixed facility/source rollout where an enrolled source cannot widen a legacy
  source;
- gateway JWT/API-key and device credential rotation without credential
  persistence;
- strict no-PHI metrics/logs;
- one in-flight item per partition and no later-item bypass;
- recovery completion only from backend `ready` plus matching HWM/cutoff; and
- soak replay across process restarts with zero lost, duplicated, renumbered,
  or silently discarded accepted messages.

Repository tests do not replace a facility power-loss/PVC durability drill,
monitor `AR`/`AE` retry proof, or owner reconciliation exercise.

### 10.4 Owner/operator inputs that remain open

- actual running gateway/appliance/software and facility endpoint inventory;
- monitor vendors/models and their retry or device-side buffer behavior;
- gateway and monitor `device_registry` identities, facility binding, allowed
  source IPs, and credential custody/rotation;
- whether per-device credentials, mTLS, HMAC, or another vendor control is
  required;
- measured source rates, maximum outage horizon, per-partition/global capacity,
  watermarks, receipt retention, and PVC/storage-class durability/encryption;
- trusted clock source, evidence format, acceptable skew bound, and loss-of-
  clock response;
- initial genesis marker, resume cutoff, reconciliation authority, accepted-loss
  procedure, and generation retirement authority;
- facility/source enrollment order and rollback approvers; and
- any procurement, vendor configuration, network, firewall, or activation
  change.

No default in this document answers those questions.

## 11. Non-goals and rollback boundary

This packet does not:

- change backend device-vitals acceptance, migration 603, the canonical inbox,
  NEWS2, triage, pathways, SLAs, notifications, or pending-review behavior;
- build or activate gateway code;
- define device firmware beyond MLLP retry/identity evidence consumed at the
  contract boundary;
- replace `device_registry`, the generic interface engine, or the existing
  device/patient association model;
- create a new PHI destination or payload copy;
- choose a vendor, appliance, storage class, capacity, retention duration,
  network, facility, or procurement;
- include the held gateway in a production Kustomization;
- deploy, sync Argo CD, migrate a database, or activate a source; or
- merge this branch.

Pre-implementation rollback is deletion of this unmerged document branch.
After a later gateway implementation, rollback stops new recovery sends and
leaves the held component excluded from production. It never deletes or
rewinds an acknowledged spool record, receipt, gap, backend offset, inbox item,
pending-review task, audit row, duplicate identity, or owner disposition.
