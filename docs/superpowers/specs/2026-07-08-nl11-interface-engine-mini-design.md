# NL11-S10 Interface Engine Mini-Design Gate

- Date: 2026-07-08
- Program: NL-11 Productization
- Slice: 10, Interface Engine Mini-Design Gate
- Status: Design-only gate for owner sign-off before NL11-S11
- Scope: Specification only. This document does not implement application code, database migrations, generated files, client screens, Kubernetes manifests, seed data, or deployment activation.
- Recommendation: Build the interface engine as a peer data plane to the NL-7 device gateway in v1. NL-11 owns system-to-system feeds, migration importers, channel management, transforms, message storage, replay, and operator monitoring. NL-7 remains the dedicated device transport path. Both call stable backend HTTP/domain APIs rather than writing clinical tables directly.

## 1. Context and Binding Invariants

NL-11 productization includes the HL7 interface engine because a buyer needs a credible way to connect existing HIS, LIS, PACS, state HIE bridges, and migration feeds before go-live. The platform already has useful HL7 pieces, but it does not yet have a Mirth-class engine: no channel catalog, connector worker, transform sandbox, message store, replay workspace, or operator dashboard.

Repository evidence used for this design:

- `docs/superpowers/specs/2026-07-07-nl11-productization-plan.md` section 3.8 and slice row 10: the mini-design must decide peer-vs-subsumed architecture, channel schema, connector worker, transform DSL/sandbox, message store, replay, and deployment topology before NL11-S11.
- `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md` section 2: NL-7 owns device-native transport and must not build channel UI, arbitrary transform pipelines, ADT/ORM routing, or importer tooling.
- `apps/backend/src/routes/hl7/hl7Routes.js`: existing HTTP bridge for inbound HL7v2 ADT/ORM/ORU with HMAC authenticity, per-tenant receiver resolution, cross-replica replay guard, and ACK responses.
- `apps/backend/src/services/hl7/hl7OutboundService.js`: existing outbound HL7 feed subscription and durable retry/replay queue for ADT/ORU messages.
- `apps/backend/src/migrations/281_lab_closed_loop.sql`: `lab_interface_messages` already proves the value of a raw interface inbox with parse/ingest outcome and replayable failures.
- `apps/backend/src/migrations/283_hl7_outbound_feeds.sql`: `hl7_feed_subscriptions` and `hl7_outbound_messages` show the existing tenant-RLS queue pattern for outbound PHI payloads.
- `apps/backend/src/migrations/338_tenant_interop_secrets.sql` and `apps/backend/src/services/interop/tenantInteropSecretService.js`: per-tenant encrypted interop secrets are the right secret ownership pattern.
- `apps/backend/src/utils/signedRequest.js`: signed request validation and `assertSharedReplayOnce` already provide the cross-replica replay guard that public integration mounts need.

Binding invariants:

1. **Peer, not subsumed, in v1.** The NL-11 engine does not absorb the NL-7 device gateway. Device vitals, cold-chain sensors, RTLS, and bedside transport stay on NL-7. The interface engine handles hospital systems and migration feeds: HIS, LIS, PACS/RIS bridge messages, billing imports, public HIE/partner feeds, and migration toolkit channels.
2. **No direct clinical-table writes from connectors.** Connector workers can write the engine-owned message store and attempts ledger. Patient, admission, order, result, billing, and migration commits go through backend domain services or explicit backend HTTP adapter endpoints so canonical timeline, audit, RLS, idempotency, and validation stay centralized.
3. **Tenant first.** Every channel, system, secret, message, attempt, replay batch, and transform test is tenant-scoped. Unknown receivers/senders fail closed. Per-tenant secrets replace global shared secrets for active channels.
4. **Raw payloads are PHI.** Raw HL7, CSV, JSON, and file payloads are never logged, never exposed in list views, and are retained only in the message store with tenant RLS, audit, redacted previews, and retention controls.
5. **Transforms are deterministic and sandboxed.** V1 does not execute arbitrary JavaScript or shell commands. The transform layer is a declarative, allowlisted DSL interpreted inside CPU/time/output budgets.
6. **Deploy remains held.** Any worker service, MLLP listener, SFTP/file poller, NodePort, PVC, ServiceMonitor, or NetworkPolicy lands unreferenced until the operator track explicitly activates it.
7. **This slice is design-only.** Migration count for NL11-S10 is zero.

## 2. Scope Decision

### In Scope for the Engine Program

- Channel CRUD and versioned activation.
- External system registry and per-tenant credentials.
- Inbound connectors for HTTP and MLLP HL7v2 feeds.
- File/SFTP poller design for migration/import feeds, with build deferred until a real source sample exists.
- Outbound connectors for HTTP HL7v2 delivery, reusing the current SSRF-guarded delivery posture.
- Message store, attempt ledger, status model, dead-letter state, replay batches, redacted operator views, and metrics.
- Transform DSL, sandbox, fixture tests, and activation gate.
- Backend adapter calls for ADT, ORM, ORU, migration rehearsal, and later commit flows.
- Admin/operator monitoring surface for integration admins.

### Out of Scope for NL11-S10 and NL11-S11

- Device gateway unification or device-vitals transport changes.
- Direct writes into clinical tables from the engine worker.
- Public SMART/FHIR endpoint productization. That stays in the developer portal/Public SMART slice.
- PACS DICOM storage/viewing. The engine may route RIS/PACS order/result metadata, not imaging pixels.
- Vendor-cloud brokers, public internet listener exposure, or Cloudflare Tunnel routes for hospital-internal feeds.
- Arbitrary code transforms, user-uploaded packages, npm dependencies inside transforms, or network/file access from transform logic.
- Production deployment activation.

## 3. Target Architecture

V1 is a control-plane/data-plane split:

```text
Admin UI / backend control plane
  -> manages systems, channels, versions, credentials, transform tests, replay batches
  -> stores config in tenant-scoped interop tables

Interface-engine worker data plane
  -> owns long-running connectors, spooling, transform execution, delivery attempts, metrics
  -> writes only interop_* message/attempt/replay rows directly
  -> calls backend adapter APIs for domain mutations and migration rehearsal/commit

Existing backend domain APIs
  -> own clinical writes, canonical timeline, audit events, RLS, idempotency, and validation
```

The worker is a future `apps/interface-engine` Node service, not a raw TCP listener inside the backend API process. The backend remains the authenticated control plane and domain API. This keeps long-lived sockets, file polling, backpressure, and spooling out of the stateless HTTP API deployment while still using the same monorepo, shared parser helpers, and database.

Data flow:

```text
External system
  -> connector listener or poller
  -> tenant/channel resolution
  -> interop_messages raw store row
  -> parser and validation
  -> transform DSL sandbox
  -> backend adapter call or outbound delivery
  -> interop_message_attempts outcome
  -> operator dashboard / metrics / replay
```

The current `/api/v1/hl7/receive` and `/api/v1/hl7-feeds` surfaces should remain compatibility paths until the engine replaces them deliberately. NL11-S11 may either wrap them as legacy channels or add new engine-native endpoints, but it must not remove working HL7 behavior as part of the first runtime slice.

## 4. Channel Schema

NL11-S11 should use the migration block assigned to that slice, not this design slice. The logical schema below is the contract.

### `interop_systems`

One row per external system or internal adapter identity.

Required fields:

- `tenant_id`
- `system_key`, unique per tenant
- `display_name`
- `kind`: `his`, `lis`, `ris`, `pacs`, `billing`, `hie`, `migration_source`, `vh_backend`, `other`
- `direction`: `inbound`, `outbound`, `bidirectional`
- `status`: `draft`, `active`, `paused`, `revoked`
- `allowed_source_ips` for inbound network allowlists where applicable
- `metadata` for nonsecret vendor/facility identifiers, HL7 sending/receiving application and facility names, file naming rules, and commissioning notes
- audit columns

Secrets do not live in `metadata`. They use the per-tenant encrypted secret pattern from `tenant_interop_secrets`, extended or mirrored into a dedicated engine secret table only if the implementation needs multiple credentials per system.

### `interop_channels`

One row per channel identity. A channel is the buyer/operator unit: "Acme HIS ADT inbound", "LIS ORU outbound", "Legacy CSV patient rehearsal", and so on.

Required fields:

- `tenant_id`
- `channel_key`, unique per tenant
- `display_name`
- `source_system_id` and `target_system_id`
- `direction`: `inbound`, `outbound`, `bidirectional`
- `connector_kind`: `http_inbound`, `mllp_listener`, `http_outbound`, `file_sftp_poll`, `manual_upload`, `internal_backend`
- `protocol`: `hl7v2`, `csv`, `json`, `fhir_json`, `other`
- `message_types`: text array such as `ADT^A01`, `ADT^A03`, `ORM^O01`, `ORU^R01`, or import profile keys
- `status`: `draft`, `active`, `paused`, `archived`
- `active_version_id`
- `retention_days`, `max_attempts`, `retry_policy`, `dead_letter_policy`
- audit columns

Status rules:

- `draft`: editable, cannot process live traffic.
- `active`: only the active immutable version processes live traffic.
- `paused`: accepts no new live traffic unless the connector explicitly stores but does not process. For PHI safety, the default should reject at the connector.
- `archived`: no new traffic, historical messages remain visible under retention rules.

### `interop_channel_versions`

Every activation creates an immutable version. Editing a live channel creates a new draft version; promotion requires transform tests and connector validation.

Required fields:

- `tenant_id`
- `channel_id`
- `version_number`
- `status`: `draft`, `candidate`, `active`, `retired`
- `connector_config`: nonsecret JSON for ports, endpoint paths, file masks, message type filters, ACK mode, and parser profile
- `validation_profile`: required segments/fields, allowlisted message types, patient identifier strategy, LOINC/code policies, and maximum payload size
- `transform_dsl`: declarative transform document
- `routing_policy`: backend adapter target and idempotency key mapping
- `redaction_profile`: list-view and log-preview rules
- `activated_by`, `activated_at`, `retired_at`

The active version ID is stamped onto every message. Replaying with "original version" is the default. Reprocessing with a newer version is an explicit operator action with preview and audit.

### `interop_messages`

The canonical message store. It is not a clinical record; it is the integration ledger.

Required fields:

- `tenant_id`
- `channel_id`
- `channel_version_id`
- `direction`
- `protocol`
- `message_type`
- `external_control_id`
- `dedupe_key`
- `payload_hash`
- `raw_payload_ciphertext` or equivalent protected raw payload storage
- `redacted_preview`
- `parsed_summary`: non-PHI or minimized operational JSON
- `patient_uid` nullable and only after validated resolution
- `source_table`, `source_id` nullable for outbound/domain-origin messages
- `status`: `received`, `parsed`, `validated`, `transformed`, `delivering`, `delivered`, `failed`, `dead`, `quarantined`, `replay_requested`, `replayed`, `ignored_duplicate`
- `last_error_code`, `last_error_safe`
- `retention_until`
- timestamps

`raw_payload_ciphertext` is preferred over plain text because the engine stores arbitrary external payloads, not just curated HL7 snippets. If implementation reuses a plain `TEXT` pattern for delivery speed, the PR must document why database encryption plus RLS is sufficient and must keep raw payloads out of logs and list APIs.

### `interop_message_attempts`

Append-only attempt ledger.

Required fields:

- `tenant_id`
- `message_id`
- `channel_version_id`
- `attempt_number`
- `phase`: `receive`, `parse`, `validate`, `transform`, `deliver_backend`, `deliver_external`, `ack`
- `status`: `ok`, `failed`, `dead`, `skipped`
- `started_at`, `finished_at`
- `duration_ms`
- `request_id`
- `backend_idempotency_key`
- `response_status`
- `safe_error`
- `metrics`: JSON for counts, not raw payload

Attempts make retries and audits explainable without rewriting the original message row.

### `interop_transform_tests`

Stored fixture tests for channel versions.

Required fields:

- `tenant_id`
- `channel_version_id`
- `name`
- `input_payload_ciphertext` or synthetic fixture text
- `expected_output`
- `expected_findings`
- `last_run_status`
- `last_run_at`

Owner rule: production channel activation requires at least one passing transform test per message type accepted by the channel. Synthetic fixtures are preferred. Real customer samples must be explicitly marked, redacted where possible, and retained only under the same PHI controls as messages.

### `interop_replay_batches`

Operator replay request and audit record.

Required fields:

- `tenant_id`
- `channel_id`
- `requested_by`
- `reason`
- `selection_filter`
- `mode`: `retry_delivery`, `reprocess_original_version`, `reprocess_current_version`, `redeliver_external`
- `status`: `queued`, `running`, `completed`, `completed_with_failures`, `cancelled`
- `message_count`
- `safe_summary`
- timestamps

Replay batches must require `INTEGRATION_ADMIN` or stronger and an explicit reason.

## 5. Connector Worker

The future worker should be small and boring: acquire connector leases, receive or poll, write the message store, run transforms, call backend adapters or external endpoints, and emit metrics.

Core worker responsibilities:

1. **Connector leasing.** Only one worker instance owns a listener or poller at a time. Use a database lease with heartbeat or a Kubernetes single-replica deployment for MLLP in P1. Do not let two workers consume the same file drop or bind the same MLLP port.
2. **Source resolution.** Resolve tenant/channel before accepting payloads. For MLLP, listener port plus sending/receiving facility and source IP can resolve the channel. For HTTP, HMAC/API-key headers plus path identify the channel. For files, configured folder, filename mask, and source system identify the channel.
3. **Durable accept before ACK.** Inbound connectors only ACK success after a message row is durably stored. Parse or transform failure should return AE/AR for synchronous HL7 only when the sender expects immediate semantic ACK. The default safe stance is AA after durable acceptance, then operator-visible processing status, unless a channel explicitly requires application ACK semantics.
4. **Backpressure.** Reject or pause when spool/message-store thresholds are exceeded. Do not accept unbounded PHI into memory.
5. **Backend adapter calls.** Domain effects are outbound HTTP calls into backend adapter endpoints with tenant context and idempotency keys. The worker does not import domain services and write clinical tables directly.
6. **External delivery.** Outbound HTTP delivery uses the current `assertSafeFeedUrl`/`safeFetch` posture: reject private, loopback, metadata, DNS-rebinding, and unsafe endpoints. MLLP outbound may be deferred until pilot need; if built, it gets the same attempt/dead-letter model.
7. **Metrics.** Emit channel-level counters and gauges: received, accepted, rejected, transformed, delivered, failed, dead, replayed, oldest pending age, connector lease health, and ACK latency.

P1 connector subset for NL11-S11:

- Must include HTTP inbound or MLLP inbound for HL7v2.
- Must include the message store and transform test harness.
- May include file/manual upload only if it is required by the migration toolkit handoff; otherwise leave file/SFTP as a schema-supported later connector.
- Must leave NL-7 device gateway untouched.

## 6. Transform DSL and Sandbox

V1 transform logic should be declarative. The DSL should be JSON or YAML-like data stored as JSONB after validation, not arbitrary code.

Allowed primitives:

- `select`: read a parsed field by protocol path, such as HL7 `PID.3`, `PV1.3`, `OBR.4`, or OBX values by code.
- `constant`: emit a literal configured value.
- `map`: lookup a source value in a channel-owned table, with configured missing-value behavior.
- `coalesce`: first nonempty source.
- `concat`: deterministic string construction.
- `normalize`: allowlisted transforms such as trim, uppercase, lowercase, phone normalization, date parse, numeric parse, unit normalization, and HL7 escape decode.
- `condition`: simple if/then/else over equality, presence, regex match, numeric comparison, and message type.
- `validate`: required field, enum, regex, date range, max length, and code allowlist.
- `emit`: produce an adapter payload, not perform the adapter call directly.

Explicitly forbidden:

- `eval`, `Function`, dynamic imports, shell execution, filesystem access, network access, timers, randomness, unrestricted regex backtracking, and process/env access.
- Secret reads from transform DSL.
- Raw payload logging.

Runtime controls:

- Parse first using protocol-specific parsers (`parseHL7` for HL7v2).
- Run the DSL in a worker-thread or equivalent bounded interpreter with a strict wall-clock timeout, output size limit, max findings count, and max collection size.
- Return structured findings: `error`, `warning`, `info`, each with a safe path and message.
- Activation requires all stored transform tests to pass.

Example DSL shape:

```json
{
  "kind": "hl7v2-to-backend-adapter",
  "messageTypes": ["ADT^A01", "ADT^A03"],
  "output": {
    "patientUid": { "select": "PID.3[0].id" },
    "admission.ward": { "select": "PV1.3.pointOfCare" },
    "admission.bedNumber": { "select": "PV1.3.bed" },
    "admission.admittedAt": { "normalize": "datetime", "from": { "select": "PV1.44" } }
  },
  "validate": [
    { "path": "patientUid", "required": true },
    { "path": "admission.admittedAt", "type": "datetime" }
  ],
  "emit": {
    "adapter": "backend.admission.upsertFromInterop",
    "idempotencyKey": ["channel", "MSH.10", "messageType"]
  }
}
```

The first implementation can support a smaller subset, but it must keep the no-arbitrary-code rule and the transform-test activation gate.

## 7. Message Store, Statuses, and Idempotency

The message store is the engine's source of truth for operational state. It is not a substitute for canonical clinical tables.

Status model:

- `received`: payload durably stored.
- `parsed`: protocol parse succeeded.
- `validated`: channel validation passed.
- `transformed`: DSL produced adapter output.
- `delivering`: backend/external delivery attempt in flight.
- `delivered`: adapter/external delivery succeeded.
- `failed`: retryable failure.
- `dead`: max attempts exhausted or permanent failure.
- `quarantined`: operator or validation rule blocked further processing.
- `ignored_duplicate`: dedupe key already processed.
- `replayed`: message was replayed or reprocessed through a replay batch.

Dedupe contract:

- HL7 uses `(tenant_id, channel_id, MSH-10/message control ID, message_type)` when present.
- HTTP/file imports use an external idempotency header or payload hash plus source filename/row number.
- Backend adapter calls must carry a deterministic idempotency key derived from channel, message ID/control ID, phase, and target adapter. A replay must not create duplicate admissions, orders, results, billing openers, or migration commits.

Retention contract:

- Raw payload retention is channel-configured and defaults short.
- Redacted previews and attempt metadata may be retained longer for audit.
- Deleting raw payload after retention must leave an audit-safe shell row with hash, timestamps, status, and attempts so operators can explain what happened without exposing payload content.

## 8. Replay and Operator Workflow

Replay must be explicit, auditable, and bounded.

Replay modes:

- `retry_delivery`: keep parse/transform output, retry only backend or external delivery.
- `reprocess_original_version`: parse and transform again with the version stamped on the message.
- `reprocess_current_version`: transform with the current channel version after explicit preview and operator confirmation.
- `redeliver_external`: resend a previously delivered outbound message to the external endpoint when the external system requests it.

Replay rules:

- Default to original channel version.
- Require operator reason.
- Require role `INTEGRATION_ADMIN` or `SUPER_ADMIN`.
- Show a dry-run preview for reprocess-current-version, including changed findings and changed adapter payload summary.
- Rate-limit batches and cap concurrent replays per tenant/channel.
- Preserve the original message and write new attempts; do not mutate history into looking like the first attempt succeeded.
- Never replay messages whose raw payload has expired unless the target mode can safely use retained transformed output.

Operator pages should show channel health, queue depth, oldest pending age, recent failures, dead-letter counts, and per-message redacted details. Raw payload view, if built, must be an explicit step-up action with PHI audit logging and should default to unavailable for ordinary integration admins.

## 9. Security and PHI Posture

Inbound authenticity:

- Active channels use per-tenant secrets or per-system credentials. The global `HL7_INBOUND_SHARED_SECRET` path remains only a legacy/default-tenant compatibility path until migrated.
- HMAC signatures use the existing signed-request canonical shape where possible: timestamp, request id, payload, and timing-safe comparison.
- Every public or semi-public integration mount uses `assertSharedReplayOnce` or an equivalent shared replay guard.
- Source IP allowlists are an additional check, not the sole credential.

Outbound safety:

- HTTP outbound uses SSRF-guarded URL validation and pinned safe fetch on every delivery attempt.
- Stored endpoint edits are audited.
- No connector may call loopback, pod metadata, Kubernetes API, private service ranges, or internal admin endpoints unless the channel type is explicitly internal and implemented as a backend adapter, not arbitrary URL delivery.

RBAC and audit:

- Configuration and replay require integration-admin capabilities.
- Message detail views that expose PHI require `phiAccessLogger` or equivalent audit.
- Transform activation records who promoted the version and which tests passed.
- Replay batches include operator, reason, message count, and mode.

Tenant isolation:

- Every new table uses `tenant_id UUID NOT NULL`, FORCE RLS, and the current `tenant_isolation` policy shape.
- Worker writes set explicit tenant context and explicit `tenant_id`. Do not rely on the default tenant GUC behavior.
- Cross-tenant sender/receiver mismatches fail closed.

Error handling:

- Client/operator-facing errors use safe codes and safe summaries.
- Raw `err.message`, raw payload snippets, patient names, phone numbers, and identifiers stay out of connector logs and delivery errors.

## 10. Deployment Topology

Future deployment, still held:

- `apps/interface-engine` container image built and signed like backend/admin.
- One control-plane backend route group for systems, channels, versions, transform tests, messages, and replay batches.
- Interface worker Deployment with one replica for P1 MLLP listener ownership. Horizontal scaling can come later per channel/lease type.
- Internal Service for worker health and metrics.
- Optional NodePort only for hospital-internal MLLP listeners, reachable from approved hospital network segments. No public Ingress and no Cloudflare Tunnel route.
- PVC or database-backed spool for connector backpressure. Raw PHI spools are encrypted at rest and deleted after durable message-store accept.
- NetworkPolicy: ingress only from approved hospital CIDRs/listener ports and monitoring namespace; egress only to backend Service, database if direct message-store writes are used, DNS, and explicitly approved external endpoints.
- ServiceMonitor and PrometheusRule additions for queue age, dead-letter rate, failed delivery burn, listener down, replay batch failure, and oldest raw payload over retention.
- Kustomize base present but unreferenced by root kustomization until operator activation.

The topology intentionally mirrors NL-7's separation of raw transport from backend domain logic, while keeping the NL-11 engine focused on system feeds instead of bedside devices.

## 11. NL11-S11 Build Contract

NL11-S11 can start after owner acceptance of this mini-design.

Minimum S11 acceptance target:

- Add the engine-owned schema using only the migration block assigned to S11.
- Add backend control-plane APIs for systems, channels, versions, transform tests, message list/detail, and replay batches.
- Add a minimal worker/data-plane implementation for one inbound HL7v2 connector path and one backend adapter path, or wrap the existing HL7 receive bridge as the first channel while still storing messages in the new engine ledger.
- Add transform DSL validation plus at least one passing transform test fixture per supported message type.
- Add message attempts, retry/dead-letter handling, and replay for failed messages.
- Add metrics and safe operator list views.
- Keep NL-7 unchanged.
- Keep deployment held.

Required local/CI tests for S11:

- Channel CRUD and version activation.
- Tenant isolation and cross-tenant sender/receiver rejection.
- HMAC freshness and replay guard.
- Transform DSL validation, timeout, forbidden operation rejection, and fixture pass/fail reporting.
- Message dedupe and idempotent replay.
- Retry/dead-letter transitions.
- PHI-safe list/detail redaction.
- Existing HL7 receive/outbound behavior not regressed.

Open owner decisions before broad build-out:

1. First pilot source: HIS ADT, LIS ORU, migration CSV, or outbound feed monitoring.
2. Whether P1 must support MLLP immediately or can start with HTTP bridge plus channel ledger.
3. Whether raw payloads must be application-encrypted in addition to database/storage encryption.
4. Default raw-payload retention window by tenant and channel.
5. Which integration-admin roles should view raw payloads under step-up audit, if any.

## 12. Build Ledger for This PR

- Added this single design-only NL11-S10 Interface Engine mini-design gate.
- Locked the v1 architecture as peer-to-NL7, not subsumed.
- Defined the logical channel schema, connector worker responsibilities, transform DSL/sandbox rules, message store, replay model, security/PHI posture, deployment topology, and NL11-S11 acceptance contract.
- No code, generated files, database migrations, app assets, seed data, client UI, or deployment manifests were changed.
- Migration numbers used: none.
- Expected validation for this slice: `git diff --check` plus the local gate required by the worker common rules.
