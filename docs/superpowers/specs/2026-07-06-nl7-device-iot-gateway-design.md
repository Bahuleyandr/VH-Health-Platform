# NL-7 Device & IoT Gateway Design

- Date: 2026-07-06
- Program: NL-7 Device & IoT gateway
- Status: Design for review — build not started
- Scope: Specification only. This document does not implement application code, database migrations, Kubernetes manifests, or client screens.
- Recommendation: Build a thin, in-cluster MLLP/HTTP device gateway (`apps/device-gateway`) that terminates device protocols on the hospital device VLAN and forwards into the **existing** `deviceVitalsRoutes` → `recordVitals(source='device')` → `checkVitalAnomalies` pipeline; add a device registry + device-to-patient association spine, a backend charting/alarm policy (downsample + artifact filter + suppression window), cold-chain tables on the existing notification/escalation rails, CMMS work orders on the existing biomed registry, and an RTLS interface contract only. Device data remains decision-support input everywhere. Zero cloud egress for device data; the gateway needs **no** Cloudflare Tunnel ingress at all.

## 1. Context and Binding Invariants

The NL-7 roadmap entry (`docs/NEXT_LEVEL_ROADMAP.md` §5) calls for: bedside-monitor ingestion (HL7v2 ORU / vendor protocols → `deviceVitalsRoutes` → vitals stream + NEWS2), cold-chain sensors + alerts (reuse alert fabric), CMMS on the biomed registry, and an RTLS/asset seam.

Binding invariants for this design:

1. **Device data is decision-support input, never an actor.** No auto-clinical actions from device data: no auto-medication, no auto-orders, no closed-loop control, no auto-quarantine of blood units, no auto-completion of clinical workflows. Device-sourced vitals stay `device_verified = false` until a clinician verifies (`verifyDeviceVitals`, audited). This mirrors the posture already encoded in `biomedDeviceMaintenanceService.js` ("decision-support only; never auto-schedules maintenance") and in the device-vitals verify queue.
2. **All vitals flow through the existing write path.** The gateway must not write `vitals_chart` (the canonical vitals table — the roadmap's "vitals stream"; the older `patient_vitals` table serves the legacy wearable/FHIR path) or `clinical_alerts` directly. Everything enters via `ingestDeviceVitals` → `recordVitals` so the canonical clinical timeline invariant (detail row + `clinical_timeline_events` + `clinical_audit_events` in one transaction, `docs/CANONICAL_CLINICAL_TIMELINE.md`), NEWS2 persistence, and the anomaly-alert fan-out all fire exactly as they do today.
3. **`source='device'` provenance is load-bearing.** `recordVitals` already normalizes `source ∈ {staff, device, fhir, patient_app}`, stamps `source_device`, sets `device_verified=false`, tags the timeline event `['vitals','device-synced','unverified']`, and words the summary "Device vitals received (…) — unverified". NL-7 extends around this; it does not re-model it.
4. **Zero cloud egress for device data.** PHI stays in-hospital (deployment guide §0: only encrypted backups leave). No vendor-cloud relays, no sensor SaaS backends, no external MQTT brokers. Devices that can only publish to a vendor cloud are out of scope for procurement.
5. **Deploy stays HELD.** Manifests land under `infra/kubernetes/base/device-gateway/` unreferenced by the root kustomization until the operator track opens (same convention as `infra/kubernetes/base/telemedicine/` from NL-3).
6. **Tenant scoping is explicit.** `ingestDeviceVitals` already refuses to run without a caller tenant (CAN-045) and rejects cross-tenant PID-3 lookups. Every new table carries `tenant_id UUID NOT NULL` with RLS, and service writes go through `setTenantTx` with an explicit tenant (the GUC-default column trap: non-default-tenant inserts without explicit tenant context land under the literal default).

Repository evidence used for this design:

- `docs/NEXT_LEVEL_ROADMAP.md` §5 (NL-7, NL-11, NL-6), §7 do-not-build, §8 execution conventions.
- `apps/backend/src/routes/emr/deviceVitalsRoutes.js` — POST `/api/v1/devices/vitals/ingest`, GET `/vitals/unverified`, POST `/vitals/:id/verify`; mounted at `app.js:930` behind `requireRole(...CLINICAL_STAFF_ROLES)` + `phiAccessLogger('DEVICE_VITALS')`.
- `apps/backend/src/services/emr/deviceVitalsService.js` — inbox row in `lab_interface_messages` (replayable), `parseHL7`, PID-3 must carry the patient UID (the BCMA wristband identifier), tenant-scoped patient check, `obxResultsToVitals`, `recordVitals(source='device')`, verify flow with `recordClinicalAuditEvent`.
- `apps/backend/src/services/hl7/hl7Parser.js` — dependency-free HL7v2 parser (MSH/PID/PV1/OBR/OBX), escape decoding, `generateACK(controlId, AA|AE|AR)`.
- `apps/backend/src/services/hl7/loincValidator.js` — strict-allowlist / structural LOINC validation.
- `apps/backend/src/services/fhir/observationVitalsMapper.js` — `LOINC_TO_VITALS_FIELD` (12 vital-sign LOINCs incl. 8867-4 HR, 8480-6/8462-4 BP, 2708-6/59408-5 SpO₂), shared by FHIR write + device ORU.
- `apps/backend/src/services/emr/vitalsChartService.js` `recordVitals` — atomic vitals row + canonical timeline + `news2_scores`; post-commit `escalateNews2` and `checkVitalAnomalies`.
- `apps/backend/src/utils/clinical/vitalSignMonitor.js` — hardcoded cohort ranges (adult/paediatric/pregnancy-BP), CRITICAL/WARNING, atomic `clinical_alerts` persist, post-commit fan-out: `cds_alerts` mirror, `emitVitalAnomaly` (`staff:clinical-alerts`), `emitCodeBlue` (`staff:code-blue` + FCM multicast) for `CODE_BLUE_VITALS`, push notification to `recorded_by`, `enqueueCriticalResultTask` (results-inbox). **No dedupe/cooldown exists anywhere on this path.**
- `apps/backend/src/services/clinical/news2Service.js` — `calculateNEWS2`, `NEWS2_ESCALATION_THRESHOLD = 5` (≥7 = critical), ack-tracked results-inbox task with DUTY-role fallback, idempotent per score.
- `apps/backend/src/routes/hl7/hl7Routes.js` — POST `/api/v1/hl7/receive`: HTTP-only system-to-system HL7 entry (ADT^A01/A02/A03, ORM^O01, ORU^R01), HMAC `X-HL7-Signature` with per-tenant sender secret resolution (`tenantInteropSecretService.resolveTenantBySender`). **There is no TCP/MLLP listener anywhere in the platform today.**
- `apps/backend/src/routes/hl7/hl7FeedRoutes.js` + `apps/backend/src/services/hl7/hl7OutboundService.js` — outbound HL7v2 feed subscriptions (HTTP delivery, SSRF-guarded endpoints, `deliverPendingFeedMessages` cron every 2 min).
- `apps/backend/src/routes/clinical/dialysisRoutes.js` POST `/dialysis/machines/ingest` + `apps/backend/src/services/clinical/dialysisMachineService.js` — the NL-6-adjacent device precedent: JSON observations, `machine_no` matched to the in-progress `dialysis_sessions` row, staff/admin JWT (no per-device credential), inbox row + `dialysis_intra_obs` `source='device'`.
- `apps/backend/src/migrations/281_lab_closed_loop.sql` — `lab_interface_messages` (protocol CHECK: `hl7v2 | astm_e1394 | poct1a | other`; status CHECK: `received | parsed | ingested | failed | sent`; FORCE RLS).
- `apps/backend/prisma/schema.prisma` — `clinical_ai_biomed_devices` (unique `[tenant_id, device_code]`, device_type, manufacturer/model/serial, location, installed_at, warranty_expires_on, last/next maintenance timestamps, usage_hours, fault_events_last_90d, MTBF, status) + `clinical_ai_biomed_maintenance_predictions` (risk bands, reviewer decisions) + `apps/backend/src/services/ai/biomedDeviceMaintenanceService.js` (`DEVICE_TYPES`, `DEFAULT_SERVICE_INTERVALS_HOURS`).
- `housekeeping_requests` / `housekeeping_request_recipients` / `housekeeping_request_updates` / `housekeeping_zones` + `apps/backend/src/services/staff/housekeepingTaskDispatchService.js` — the proven work-order lifecycle (open → assigned → in_progress → completed, SLA due/breach, roster-based recipient resolution, incharge escalation, verification) that CMMS mirrors.
- `apps/backend/src/services/auth/apiClientService.js` — `api_clients`/`api_keys` (tenant-scoped, scopes, allowed_ips, rate-limit profile, prefixed sha256 key hash + display prefix, timing-safe compare). **Dormant, and earmarked by NL-11 ("developer portal — activate `api_clients`"); NL-7 deliberately does not squat on it.**
- `apps/backend/src/services/workflow/escalationEngineService.js` — `runEscalationSweep` cron every 2 min; tiers T1 (re-notify assignee), T2 (duty doctor, 10 min), T3 (leadership, 30 min); actions notify/reassign/escalate-priority via `notificationOutbox`.
- `apps/backend/src/utils/notifications/notificationOutbox.js` — durable notification intent (`PENDING → SENT/FAILED`, 3-attempt retry, drain cron every 2 min).
- `apps/backend/src/utils/websocket/realtimeEmitter.js` + `channelAuth.js` — `staff:clinical-alerts`, `staff:code-blue` channels; CHANNEL_CATALOG + emitter + producer recipe proven across 13 realtime boards.
- `apps/backend/src/observability/metricPrimitives.js`, `reliabilityMetrics.js`, `teleconsultOpsMetrics.js` — dependency-free Histogram/Counter/Gauge classes; `/metrics` gated by `MONITORING_TOKEN` (always-on); `infra/kubernetes/base/monitoring/` PrometheusRule CRs validated by `validate-monitoring.mjs` in CI.
- `docs/DEPLOYMENT_GUIDE.md` — 3-node RKE2 on a dedicated cluster VLAN (10.10.0.11–13) with a separate IPMI VLAN; zero inbound firewall ports; Cloudflare Tunnel egress-only ingress; Longhorn storage class; namespace layout; `code-blue-misfire.md` runbook exists.
- `facility_locations` (static location hierarchy) and `beds` (migration 001 + baseline) — the location/bed context the association and RTLS seams reference.

## 2. Scope Boundary — NL-7 vs NL-11 (and NL-6)

This boundary is explicit because both programs speak HL7.

**NL-7 owns the device-side ingestion gateway**: terminating device-native transports (MLLP TCP, sensor HTTP push) at the hospital network edge, device identity (registry + per-device auth), device-to-patient association, store-and-forward across network blips, and normalizing device traffic into **existing backend HTTP ingestion surfaces**. The gateway is deliberately protocol-dumb about content: it frames, authenticates, associates, spools, and forwards. It does not transform, route, filter, or map messages between systems.

**NL-11 owns the Mirth-class HL7 interface engine**: general system-to-system integration — legacy HIS/LIS/PACS feeds, channel management UI, per-channel mapping/filter/transform pipelines, message routing between external systems, and the migration-toolkit importers. Its natural inbound seam already exists: POST `/api/v1/hl7/receive` (HMAC-signed, per-tenant sender resolution) and the outbound `hl7-feeds` subscription queue.

**The seam between them** is the backend HTTP surface, not a shared process:

- The NL-7 gateway forwards device vitals to `POST /api/v1/devices/vitals/ingest` (and cold-chain readings to the new cold-chain ingest route). These backend surfaces are the stable contract.
- When NL-11's engine lands, it becomes *another caller* of the same backend surfaces (or a peer listener for non-device feeds). Two integration options are then possible — (a) the engine subsumes the gateway's MLLP listener and the gateway shrinks to sensor/HTTP duty, or (b) the gateway stays the dedicated device path and the engine handles only system feeds. That choice belongs to the NL-11 design; nothing in NL-7 pre-commits it, because the persistent contract both would call is the backend ingestion API, not the listener.
- NL-7 must not build: channel management UI, arbitrary transform pipelines, ADT/ORM routing, or importer tooling. If a pilot vendor needs a bespoke field mapping, it is implemented as a narrow **adapter** inside the gateway (per §3.1), not as a generic mapping engine.

**NL-6 overlap (dialysis machines):** `POST /dialysis/machines/ingest` already exists as an authenticated JSON ingest matched to in-progress sessions. NL-6's "dialysis machine HL7" slice can later ride the NL-7 gateway as one more adapter (MLLP in → existing dialysis service call), without changing `dialysisMachineService`. NL-7 P1 does not touch dialysis; the registry (§3.3) reserves a `kind` for it so the seam is ready.

## 3. Bedside Monitor Ingestion (P1)

### 3.1 Protocol Reality

- **HL7 v2 ORU^R01 over MLLP is the common denominator.** Patient-monitor fleets are integrated via the vendor's central station / gateway product (Philips IntelliVue Information Center / IntelliBridge, GE CARESCAPE Gateway, Mindray eGateway, Nihon Kohden gateway options), which exports periodic consolidated ORU^R01 results over MLLP (the classic IHE PCD-01 shape: MSH/PID/PV1/OBR/OBX with numeric OBX segments). The pilot therefore most likely speaks to **one central-station feed per unit**, not to individual monitors — the architecture must handle both, but the MVP assumption is few long-lived TCP connections, each multiplexing many patients.
- **Vendor-proprietary protocols are adapters, not the core.** Philips Data Export, Mindray-proprietary, serial/RS-232 bridges, and waveform streams are explicitly out of MVP scope. The gateway's listener layer is structured as `adapters/` (same drift-isolation idea as Triveni's selector adapters): `mllp-hl7v2` is the only P1 adapter; each future vendor adapter normalizes to the same internal envelope `{source, receivedAt, controlId, rawMessage | observations}`.
- **Waveforms are out of scope for the whole program.** NL-7 ingests numerics (periodic vitals + device alarms), not ECG waveforms. Waveform storage/streaming is a different system class (bandwidth, retention, review UI) and is not on the roadmap.
- **Parsing stays in the backend.** `hl7Parser.js` + `obxResultsToVitals` already handle ORU content (12 vital LOINCs, escapes, BP panels). The gateway does **not** re-implement or import the full parser; it needs only MLLP framing (`<VT> … <FS><CR>`), MSH-9/MSH-10 extraction for message type + control id (a ~50-line frame reader), and ACK emission mirroring `generateACK` semantics (AA on durable accept, AE on processing error, AR on reject/backpressure). Content interpretation, LOINC mapping, and validation remain backend concerns so thresholds and mappings live in exactly one place.
- **Unmapped OBX codes** already surface in the ingest response (`unmapped`), land in the inbox row `verdicts`, and are skipped — vendor codes that should map get added to `LOINC_TO_VITALS_FIELD` (or a per-device-model translation table in the registry `metadata`) during pilot bring-up. `loincValidator` strict mode is available if the pilot feed proves noisy.

### 3.2 Gateway Architecture and Deployment Shape

**New service `apps/device-gateway`** (Node 22, same repo, own container image built/signed like backend/admin, ArgoCD-synced) rather than an in-backend TCP listener. Reasons: the backend is a stateless HTTP Deployment behind ingress — grafting long-lived raw TCP listeners onto it couples monitor connectivity to API rollouts and breaks the one-process-one-protocol posture; a separate pod gives the MLLP surface its own blast radius, resource envelope, spool volume, and NetworkPolicy identity.

Deployment shape (all manifests HELD, §8):

- **Single-replica Deployment** in namespace `vhhealth` (or `vhhealth-devices` if ops prefers isolation), `Recreate` strategy. MLLP senders hold one persistent TCP connection and expect in-order ACKs; round-robining a multi-replica Service would split a sender's stream. HA for the MVP comes from: kubernetes restart + central stations' own retransmit buffers + the gateway spool (§3.6). Scaling later is per-listener-port (a second Deployment/port for a second unit), not replica count.
- **Exposure: NodePort (e.g. 30575 → container 2575)** on the cluster VLAN, reached from the device VLAN through the hospital L3 firewall (§7). No ingress object, no Cloudflare Tunnel hostname, no public DNS. `externalTrafficPolicy: Local` is not required for MVP (source-IP preservation is nice for the IP allowlist but the allowlist can also be enforced at the firewall; if source IP must reach the pod, pin the gateway to one node with a nodeSelector and use `Local`). A dedicated edge node is an owner decision (§10.2).
- **Listener table via ConfigMap**: `[{ name, port, adapter: 'mllp-hl7v2', tenant_slug, source_kind: 'central_station' }]`. One tenant per listener port for MVP — port identity is part of source authentication (§3.3); multi-tenant demux by MSH sending-facility is a later concern (single-hospital pilots are single-tenant).
- **Spool PVC** (Longhorn, few GiB) for store-and-forward (§3.6).
- **Forwarding**: HTTPS to the backend Service (`vhhealth-backend.vhhealth.svc`) calling the existing ingest endpoints with the gateway's service credential (§3.3). In-cluster east-west traffic; never leaves the node fabric.
- **Gateway holds no database connection.** All state is either in the spool (transient) or in the backend via API. This keeps RLS, tenancy, and audit exactly where they already are.

### 3.3 Device Registry and Per-Device Auth

**New table `device_registry`** (tenant-scoped, RLS, unique `[tenant_id, device_code]`):

- `device_code` (the identifier stamped into `lab_interface_messages.analyzer_code` and `vitals_chart.source_device` today), `display_name`, `kind` (`central_station | monitor | monitor_gateway | fridge_sensor | dialysis_machine | rtls_feed | other`), `vendor`, `model`, `protocol` (`mllp-hl7v2 | http-json | …`), `biomed_device_id` (nullable FK → `clinical_ai_biomed_devices` — the asset registry stays the asset source of truth; the device registry is the *connectivity* record), `location_id` (nullable FK → `facility_locations`), `allowed_source_ips` (inet[]), `credential_hash` + `credential_prefix` (prefixed sha256 digest + timing-safe compare, one-time-plaintext issue — same pattern as `api_keys`), `status` (`active | paused | revoked`), `last_seen_at`, `metadata` (per-model quirks, OBX translation overrides), timestamps.

Deliberate choice: **do not activate `api_clients` for devices.** That table is NL-11's developer-portal spine (partner/integration clients with scopes and rate profiles). Device connectivity records are operationally different — provisioned by biomed/IT staff, IP-pinned to a VLAN, bound to physical assets, and largely incapable of presenting bearer tokens. A dedicated registry keeps both programs clean; the sha256-hash/prefix key handling pattern is reused, not the table.

**Authentication is layered by what the transport can actually do:**

1. **Network layer (always):** device VLAN membership + firewall rules + listener port. Only the device VLAN can reach the NodePort at all (§7).
2. **Registry layer (always):** the gateway resolves the sender to a `device_registry` row — by source IP ∈ `allowed_source_ips` for MLLP senders (central stations cannot send credentials), or by `Authorization: Bearer <device token>` for HTTP-capable senders (cold-chain sensors, §4). Unknown sender → connection refused / 401, counted in metrics, nothing forwarded.
3. **Gateway→backend layer:** the gateway itself is the authenticated API caller — a **per-tenant service principal** (a `users` row with new narrow role `DEVICE_GATEWAY`) whose JWT the gateway obtains/refreshes plus the standard API key. `deviceVitalsRoutes`' mount gains `DEVICE_GATEWAY` alongside `CLINICAL_STAFF_ROLES` (the role grants exactly the two ingest surfaces and nothing else; it is excluded from `ALL_STAFF_ROLES`/`isStaff` so it can never subscribe to staff channels, log into apps, or pass `requireStaffOrAdmin`). This replaces the current implicit assumption that a human-ish staff JWT posts ORUs, without weakening the human verify/review endpoints (verify keeps `canVerify` as-is — a gateway can never verify vitals).

Registry CRUD lands under `/api/v1/admin/devices` (admin portal page; integration-admin roles per `canManageIntegrations`), with `last_seen_at` maintained from ingest traffic — that field powers the silent-device watchdog (§7.4).

### 3.4 Device-to-Patient Association — the Hard Problem

Today `ingestDeviceVitals` requires PID-3 to carry the patient UID (the BCMA wristband identifier). Real monitor fleets do not know VH Health UIDs; central stations emit whatever the monitor tech typed (bed label, MRN fragment, nothing). **Association is therefore a first-class workflow, not a parsing detail.**

**New table `device_patient_associations`** (tenant-scoped, RLS):

- `device_registry_id` FK, `channel` (nullable — central-station feeds identify the origin monitor per message, typically via PV1-3 bed/location or an OBR/OBX device identifier; `device+channel` is the association key), `patient_uid`, `bed_id` (nullable FK → `beds`, context snapshot), `started_at`, `started_by` (staff uid), `start_method` (`scan | manual | adt`), `ended_at`, `ended_by`, `end_reason` (`manual | discharge | transfer | device_reassigned | ttl_expired`), audit timestamps.
- **Exactly one active association per (device, channel)** — partial unique index on `ended_at IS NULL`. A new association auto-closes the previous one with `end_reason='device_reassigned'` inside the same transaction.

**Association workflow (staff app, P1):** a nurse connects a monitor to a patient by scanning the patient wristband (existing BCMA scan surface — the wristband already encodes the UID PID-3 expects) and then scanning/selecting the monitor (QR/asset label printed from the device registry; manual pick from the ward's device list as fallback). Disconnect is the inverse action. Both are audited clinical-adjacent actions (`clinical_audit_events` via the existing audit helper).

**ADT hooks (P1, backend-only):** discharge and ward-transfer flows end any active associations for the patient (`end_reason='discharge' | 'transfer'`), because a stale association is the wrong-patient hazard. Auto-*creating* associations from bed assignments is deliberately **not** done in P1 (bed-data freshness is unproven against real transfer practice); it can become a P4 enhancement once the pilot shows bed data is trustworthy.

**Ingest resolution:** for each inbound ORU the gateway resolves (device, channel) → active association → patient UID, and forwards to the existing endpoint with the resolved patient identity. Concretely, `POST /devices/vitals/ingest` gains an optional `patient_uid` parameter that — when the caller is the gateway — overrides/patches PID-3 resolution; `ingestDeviceVitals` keeps its existing PID-3 path for direct senders so the current contract is unchanged. The backend re-validates patient-tenant membership exactly as today.

**Unassociated traffic parks, never guesses.** No active association → the message still lands in `lab_interface_messages` (`status='failed'`, error `DEVICE_NOT_ASSOCIATED`) and is ACKed AE. It is visible on the review queue ("device sending, nobody associated" is itself a nursing signal), counted in metrics, and replayable after association (the inbox replay pattern already exists for lab). No fuzzy matching on names/bed strings — wrong-patient charting is the one unrecoverable failure mode, so the system refuses rather than guesses.

**Safety rules:** single-active-per-channel (above); association changes always audited; optional per-unit TTL/re-confirm policy (e.g. ICU re-confirms every 24h — configurable, default off, governance decision §10.4); the unverified-until-clinician-review posture stays the final backstop.

### 3.5 Flow into `vitals_chart` and the Charting/Alarm Policy

The happy path is exactly today's path: gateway → `POST /api/v1/devices/vitals/ingest` → inbox row → parse/map → `recordVitals({ source: 'device', source_device })` → atomic vitals row + timeline (`unverified`) + NEWS2 → post-commit `escalateNews2` + `checkVitalAnomalies` → `clinical_alerts` + realtime + results-inbox. What NL-7 must add is **policy**, because continuous sources break two assumptions the manual path makes:

**(a) Charting cadence.** A central station emitting one ORU/min/patient would write ~1,440 `vitals_chart` + timeline rows per patient per day and drown the chart, the canonical timeline, and the verify queue. Policy (implemented in `deviceVitalsService`, config per unit/device-kind in the registry or tenant settings):

- Persist a device reading when **either** (i) the per-patient charting interval has elapsed since the last persisted device row (default: 5 min for ICU-class monitors; configurable), **or** (ii) any received value breaches its reference range (the backend knows the ranges; the gateway does not), **or** (iii) the reading completes a NEWS2-relevant delta (e.g. first reading carrying a previously-missing parameter).
- Non-persisted samples are **counted, not stored**: a `device_samples_suppressed_total{device,reason}` metric and a rolling `last_seen_at`/latest-values cache update — no inbox row per suppressed sample (the inbox stays meaningful: persisted, alert-relevant, or failed messages only). This keeps `lab_interface_messages` from becoming a 1/min/patient log; the inbox already has a status+created_at index and gains a retention/pruning note in the runbook.
- **Idempotency:** MSH-10 (message control id) is recorded per device; a duplicate control id from the same device within the dedupe horizon is ACKed AA and dropped (spool replays and central-station retransmits must not double-chart).

**(b) Alarm fatigue.** `checkVitalAnomalies` has **no dedupe** — grounded fact — and fires the full fan-out per breaching write. At 1/min that is 60 CRITICAL alerts + 60 results-inbox tasks + 60 code-blue broadcasts per hour for one persistent breach: unusable and dangerous (staff learn to ignore the channel). Policy:

- **Suppression window (backend, device path only):** `checkVitalAnomalies` gains an opt-in `options.suppressRepeats = { windowMinutes }` used only by the device ingest path. Before inserting, it skips alert creation (and the whole per-alert fan-out) when an **unacknowledged** `clinical_alerts` row for the same `(patient_id, vital_name, severity)` exists within the window (defaults: CRITICAL 10 min, WARNING 30 min; per-tenant/per-unit configurable). Acknowledging an alert re-arms it immediately — a persisting breach after ack re-alerts. The manual/staff path is untouched (infrequent writes; changing its behavior is a clinical change nobody asked for). Supporting index on `clinical_alerts (patient_id, vital_name, severity, acknowledged, created_at)`.
- **Artifact filter (device path only):** a device-sourced CRITICAL must be corroborated by **N consecutive breaching samples** (default 2 of the last 3 samples received for that vital) before the alert fires. The evaluation happens in the backend, which sees every forwarded sample (the gateway forwards all samples; only *persistence* is downsampled), so no thresholds leak into the gateway. SpO₂-probe-off (→ 0%), leads-off HR dropouts, and cuff artifacts are the classic false code-blue triggers; the `code-blue-misfire.md` runbook exists precisely because mis-fires are a known operational hazard. An uncorroborated single-sample breach still charts (it persists under rule (a)-ii) — it just does not page until corroborated.
- **Escalation stays on the existing rails:** the ONE alert that fires is ack-tracked via `enqueueCriticalResultTask` (results-inbox), and the existing escalation engine chases un-acked tasks (T1/T2/T3). Suppression never mutes escalation of the alert that already fired — it prevents *duplicate* alerts, not follow-through.
- **Notification target fix:** `checkVitalAnomalies` currently pushes the CRITICAL notification to `recorded_by` — for device-sourced vitals that is the gateway service principal, i.e. nobody. For `source='device'`, skip the recorder push and rely on the results-inbox task's DUTY-role recipient resolution (the exact W1-H4 lesson already applied to NEWS2 escalation: route to a real, assigned, acknowledgement-tracked recipient). `emitCodeBlue`/`emitVitalAnomaly` behavior is unchanged (they broadcast to channels, not to the recorder).
- Alarm-policy parameters (windows, N-consecutive, charting intervals, per-unit overrides) are **clinical governance artifacts** — they ship with safe defaults but their ownership is an explicit owner decision (§10.4).

**NEWS2** needs no new policy: it persists atomically with each charted row and `escalateNews2` is already idempotent per score with DUTY-role fallback. The charting-interval policy (a) inherently paces it.

### 3.6 Backpressure and Store-and-Forward

Failure layers, in order of preference:

1. **Sender-side buffering** — central stations buffer and retransmit when the TCP peer is down (vendor-standard). The gateway leans on this by simply not ACKing what it cannot durably take.
2. **Gateway spool** — an append-only NDJSON spool on the PVC (one file per source, fsync-on-append, entries `{controlId, receivedAt, raw}`). **ACK discipline: ACK AA only after the entry is durably spooled** (or synchronously forwarded 2xx); AE for processing rejects; **AR when the spool is full** — the sender then holds/retries per its own buffer policy. This is the standard interface-engine trade: the ACK is a durability receipt, not a delivery receipt.
3. **Drain loop** — per-source, in-order forwarding to the backend with bounded retry + exponential backoff; on 4xx-class content errors (bad message) the entry is moved to a dead-letter file + AE-equivalent metric rather than blocking the stream (the backend inbox also records the failure and is replayable); on 5xx/network the drain pauses and resumes.
4. **Bounds and visibility** — spool size cap (config, default a few hundred MB ≈ hours of unit traffic), `gateway_spool_depth`/`gateway_spool_oldest_age_seconds` gauges with PrometheusRule alerts (§7.4). Overflow policy is **reject-new (AR)**, never drop-oldest — silently losing the oldest unforwarded vitals is worse than pushing backpressure to a device designed for it.
5. **Backend inbox** — once forwarded, `lab_interface_messages` is the durable, replayable record (existing semantics).

The spool holds raw HL7 (PHI): it lives on the in-cluster PVC, is bounded, is deleted on successful forward, and never appears in logs (`piiMask` discipline; log control ids and counts, not message bodies).

### 3.7 Safety Posture (summary)

- Decision-support only; no auto-clinical actions anywhere in the program (binding invariant §1.1).
- Device rows are unverified until clinician verification; the ICU review queue (`GET /vitals/unverified`) is unchanged and now becomes genuinely load-bearing.
- Refuse-rather-than-guess association; audited association lifecycle; ADT auto-end on discharge/transfer.
- Artifact filter + suppression window + ack-tracked escalation = the alarm-fatigue posture; parameters governance-owned.
- Code-blue emission stays enabled for corroborated device CRITICALs (that is the point of monitor integration) with the mis-fire runbook updated for the device source.

## 4. Cold-Chain IoT (P2)

Grounded: **nothing exists today** — no temperature/fridge/cold-chain tables, routes, or services (verified sweep). `vaccine_catalogue` is a reference table only. This is a net-new domain that reuses the alert rails.

**Sensor reality and transport:** commodity temperature/humidity sensors (pharmacy fridges, blood-bank fridges/freezers, vaccine ILRs, OT/lab ambient) that can push locally — WiFi/Ethernet HTTP(S) push, or a LoRaWAN/BLE gateway box that POSTs JSON. The gateway exposes an HTTP ingest adapter (`POST /ingest/cold-chain` on the gateway, or sensors POST directly to the backend route when they can do HTTPS+token — both paths authenticate via `device_registry` bearer tokens, `kind='fridge_sensor'`). **MQTT is a documented adapter seam, not an MVP dependency** — running a broker is real operational surface; add it only if the chosen sensors demand it (owner decision §10.5 constrains procurement to local-push-capable units; vendor-cloud-only sensors are excluded by the zero-egress invariant).

**New tables** (tenant-scoped, RLS):

- `cold_chain_units` — monitored storage units: `unit_code`, `display_name`, `kind` (`fridge | freezer | ilr | ambient`), `department` (`pharmacy | blood_bank | lab | ward | ot`), `location_id` FK → `facility_locations`, `biomed_device_id` nullable FK (the fridge is often also a biomed asset), `device_registry_id` FK (the sensor), `min_temp_c`/`max_temp_c`, `excursion_grace_minutes` (sustained-breach filter: door-open transients must not page — default 15 min pharmacy fridge, tighter for blood bank per department policy), `alert_roles` (recipient roles), `status`, timestamps.
- `cold_chain_readings` — append-only: `unit_id`, `temp_c`, `humidity_pct` nullable, `battery_pct` nullable, `recorded_at`, `received_at`. High-volume but tiny rows; monthly-partition or BRIN-index note at build time; retention ≥ 2 years (drug-inspector/NABH audit horizons), configurable per tenant.
- `cold_chain_excursions` — the compliance artifact: `unit_id`, `opened_at`, `closed_at`, `peak_temp_c`, `duration_minutes`, `severity` (`warning | critical`), `acknowledged_by/at`, `corrective_action` (free text, required to close), `disposition_note` (what happened to the stock — advisory only), `status` (`open | acknowledged | closed`). One row per episode (opened when breach survives the grace window, closed when readings return in-range **and** a corrective action is recorded).

**Alerting path (existing rails, no new machinery):** excursion opens → `notificationOutbox.queue()` push/SMS to the unit's `alert_roles` (department incharge roster — recipient resolution mirrors `housekeepingTaskDispatchService`'s roster/delegation lookup) → un-acknowledged excursions escalate through the existing escalation engine (a `workflow_sla_instances`-backed task with T1 re-notify / T2 department head / T3 leadership timers). The results-inbox is **not** used here — it is patient-scoped by design; cold-chain is facility-scoped and fits the task/SLA rails instead. A new `staff:cold-chain` realtime channel + admin dashboard tile follows the proven 13-board recipe (CHANNEL_CATALOG entry + emitter + producer at the excursion write site + `useRealtimeInvalidation`).

**Compliance/audit trail:** the readings table is append-only evidence; excursion rows carry ack + corrective action + disposition; a monthly temperature-register export per unit (PDF/CSV through the existing reporting/export rails) satisfies pharmacy and blood-bank register practice. **Blood-bank linkage is advisory only:** an excursion on a blood-bank unit raises a *flag* visible on the blood-bank board (units stored in that fridge during the window may be listed for review) — it never auto-quarantines or auto-discards stock (invariant §1.1); quarantine remains a human blood-bank workflow action.

**Silent-sensor watchdog:** a registered active sensor with no reading for > 3× its expected interval raises a WARNING through the same notification path (a dead sensor on a blood-bank freezer is itself an excursion risk). Powered by `last_seen_at` + the §7.4 metrics.

## 5. CMMS on the Biomed Registry (P3)

Grounded: `clinical_ai_biomed_devices` already carries the asset inventory (type, vendor/model/serial, location, install date, warranty expiry, usage hours, fault counts, MTBF, `last/next_preventive_maintenance_at`) and `biomedDeviceMaintenanceService` already computes failure-risk **predictions** with reviewer decisions and default service intervals per device type. What is missing is the operational loop: schedules that generate work, work orders that get done, and evidence for NABH/warranty/AMC.

**New tables** (tenant-scoped, RLS; lifecycle deliberately mirrors the proven `housekeeping_requests` shape):

- `biomed_work_orders` — `work_order_number` (`BWO-YYYYMMDD-xxxxxx`), `biomed_device_id` FK, `kind` (`preventive | corrective | calibration | inspection | condemnation`), `priority` (`normal | high | urgent`), `status` (`open → assigned → in_progress → completed → verified`, plus `cancelled`), `description`, `assigned_to(_uid)`, `assigned_at/by`, `sla_due_at`, `sla_breached`, `completed_at`, `completion_notes`, `parts_used` (jsonb), `cost_amount` nullable, `downtime_started_at/ended_at` (feeds availability KPIs and the existing `usage_hours`/MTBF fields), `verified_by/at`, `source` (`schedule | manual | device_fault | ai_prediction`), `source_ref` (e.g. prediction id, gateway fault event), timestamps. Recipient fan-out + updates trail reuse the housekeeping pattern (`biomed_work_order_updates`, or a generalized shared updates table if the build finds the housekeeping one cleanly liftable — build-time call, not a design commitment).
- `biomed_maintenance_schedules` — recurring plans per device: `biomed_device_id` FK, `kind` (`preventive | calibration | inspection`), `interval_days` **or** `interval_usage_hours` (seeded from `DEFAULT_SERVICE_INTERVALS_HOURS`), `next_due_at`, `assigned_role/vendor`, `active`. A `withJobLock` cron materializes due schedules into work orders (idempotent per schedule+due-window) and refreshes `next_scheduled_maintenance_at` on the device row so the existing AI prediction inputs stay live.
- `biomed_calibration_certificates` — `biomed_device_id` FK, `work_order_id` nullable FK, `certificate_number`, `calibrated_at`, `due_at`, `performed_by` (staff or vendor string), `document_id` (via the existing validated upload/R2 path — never raw base64), `result` (`pass | fail | adjusted`). Calibration status surfaces on the device page and in a NABH-style compliance view (device list × calibration/PM currency).
- AMC/vendor-contract fields extend the registry story (contract number, vendor, coverage window) — small columns on `clinical_ai_biomed_devices` or a `biomed_service_contracts` table if multiple contracts per device emerge; build-time sizing.

**Integration points:**

- **From the gateway (P1 seam):** device faults observed at the connectivity layer (a registered monitor gone silent, repeated malformed output) can raise a `source='device_fault'` **corrective work-order suggestion**. Whether these auto-create (it is an operational ticket, not a clinical action — auto-create with dedupe-per-open-WO is defensible) or queue as suggestions is an owner decision (§10.6).
- **From AI predictions:** an accepted `clinical_ai_biomed_maintenance_predictions` row (reviewer decision `accepted`) offers one-click work-order creation with `source='ai_prediction'` — the human reviewer stays in the loop, matching the service's existing decision-support contract.
- **Escalation/notifications:** SLA breach on urgent work orders rides the existing escalation engine + `notificationOutbox`, identical to housekeeping.
- **Surfaces:** admin portal biomed board (device list, WO queue, calibration currency, downtime KPIs) and a staff-app "my work orders" list for biomed technicians — both follow existing board/list patterns; a `BIOMED_TECHNICIAN` role addition follows the slice-7/slice-12 RBAC-cleanup protocol (own PR, role-config suite + authorization suite green) if the role does not already exist at build time.

## 6. RTLS / Asset-Tracking Seam (P4 — interface only, no build)

Grounded: **nothing exists** (no rtls/beacon/tag surfaces; `facility_locations` is a static hierarchy; `devices` is the FCM mobile-device table). Per the task, NL-7 designs the seam and explicitly does not build an RTLS.

**What the seam is:**

- **Tag binding:** `asset_tags` — `tag_id` (vendor tag identifier), `biomed_device_id` FK (or, later, other asset kinds via a polymorphic `asset_kind/asset_ref`), `tenant_id`, `active`, `bound_by/at`. Binding/unbinding is an admin action on the device page.
- **Location events:** `asset_location_events` — `tag_id`, `location_id` FK → `facility_locations` (zone/room granularity — the vendor system owns triangulation; VH Health stores *resolved zones*, never raw radio data), `observed_at`, `source` (`device_registry_id` of the RTLS feed), `confidence` nullable. Append-only, aggressively retained (e.g. 90 days full + latest-per-tag snapshot table/materialized view for "where is it now").
- **Ingest contract:** the vendor RTLS server (they all ship one — Ubisense/Sonitor/CenTrak/BLE-gateway class) pushes batched JSON to the gateway/backend: `POST /ingest/rtls` `{ events: [{tag_id, zone_ref, observed_at, confidence?}] }`, authenticated as a `device_registry` row `kind='rtls_feed'`, with a per-tenant `zone_ref → facility_locations.id` mapping table maintained at commissioning. Zero cloud egress applies: the RTLS server must run on-prem on the device VLAN.
- **Read API:** latest location per asset + simple history endpoint, surfaced as a column/panel on the CMMS device board ("last seen: Ward 3 utility room, 12 min ago"). No live map in NL-7.
- **Deliberately out:** patient/staff tracking (workflow + consent + works-council territory — separate program if ever), wander management, nurse-duress, real-time map UI, and any radio-layer processing.

P4 builds the tables + contract + board column **only if** an actual vendor pilot is scheduled (owner decision §10.7); otherwise the seam ships as this documented contract and the registry `kind` reservation, at zero code cost.

## 7. Network and PHI Posture

### 7.1 Device VLAN Assumptions

The deployment baseline already mandates VLAN discipline (cluster VLAN 10.10.0.0/24 for the 3 RKE2 nodes; separate IPMI VLAN). NL-7 adds the assumption of **hospital-IT-owned device VLAN(s)**: monitors/central stations on a clinical-device VLAN; IoT sensors either on the same or a separate low-trust sensor VLAN. Concretely required from hospital IT (owner decision §10.3):

- Device VLAN(s) with static addressing (or DHCP reservations) for central stations, sensor gateways, and the future RTLS server.
- L3 firewall rules: device VLAN → cluster VLAN **only** to the gateway's published ports (MLLP NodePort, HTTPS ingest); established-return traffic only (the MLLP ACK rides the same TCP session); everything else denied — in particular **device VLAN → internet: denied** (this, at the network layer, is what makes "zero cloud egress" enforceable rather than aspirational).
- Cluster VLAN → device VLAN: denied (the platform never initiates connections to devices in this design; if a future adapter needs to poll a device, that specific rule gets added then).
- No overlap with the IPMI VLAN; MTU/jumbo consistency per the existing guide.

### 7.2 Zero Cloud Egress for Device Data

Device data (vitals, temperatures, locations) terminates in-cluster and is stored in CNPG. It never transits Cloudflare, vendor clouds, or any external broker. Procurement constraint (restated as §10.5): sensors/monitors must support local push or local export; "cloud-first" IoT products are excluded. Off-site encrypted DB backups (existing R2 path) are the only way device data leaves the building, identical to all other PHI.

### 7.3 The Gateway Needs No Ingress — Documented Explicitly

The platform's ingress model is Cloudflare Tunnel → ingress-nginx → Service, with zero inbound firewall ports. **The device gateway does not participate in that model at all**: no public hostname, no Ingress object, no tunnel route, no certificate on the public edge. Its entire exposure is a NodePort on the cluster VLAN reachable only from the device VLAN through the hospital's internal firewall — east-west hospital traffic, not north-south internet traffic. The zero-inbound-ports property of the *hospital perimeter* firewall is preserved untouched; the new rules live on the internal VLAN boundary. This also means Cloudflare outages are irrelevant to device ingestion, and conversely the gateway can never be reached from the internet even by misconfiguration of the tunnel.

In-cluster, a NetworkPolicy pins the gateway pod: ingress from the device VLAN CIDR(s) (ipBlock) on the listener ports + Prometheus scrape from the monitoring namespace; egress to the backend Service, kube-dns, and nothing else (explicitly no internet egress — the Kyverno/image-policy and Falco layers already watching the cluster apply to it like any workload).

### 7.4 Monitoring the Gateway Itself

Follow the shipped observability pattern exactly (dependency-free `metricPrimitives`, `/metrics` behind the always-on `MONITORING_TOKEN` gate on the backend; the gateway exposes its own `/metrics` on an internal port scraped via ServiceMonitor):

- **Gateway-local metrics:** `mllp_connections_active{listener}`, `mllp_messages_received_total{source,status}` (accepted/rejected/malformed), `gateway_ack_latency_seconds` histogram, `gateway_spool_depth{source}`, `gateway_spool_oldest_age_seconds`, `gateway_forward_failures_total{reason}`, `gateway_dead_letter_total`.
- **Backend DB-derived gauges** (added to `reliabilityMetrics.js`'s one-batched-query collector): `device_registry_active_devices`, `device_silent_devices` (active devices with `last_seen_at` older than 3× expected interval), `device_vitals_unverified_rows`, `device_associations_active`, `device_unassociated_messages_total` (counter at ingest), `device_samples_suppressed_total{reason}`, `cold_chain_open_excursions` (P2).
- **PrometheusRule additions** under `infra/kubernetes/base/monitoring/` (label `release: vhhealth-monitoring`, validated by `validate-monitoring.mjs`/promtool in CI): spool-depth/age alerts (store-and-forward engaged), silent-device warning (the monitor-unplugged / dead-sensor watchdog), unassociated-message rate, forward-failure burn, cold-chain open-excursion critical. Grafana dashboard-as-code panel set alongside the existing RED/reliability dashboards. Metric names cross-checked exporter↔rules at review time (the #1 monitoring review check — a typo is a silently dead alert).

### 7.5 PHI Handling Specifics

- The spool contains raw HL7 with patient identifiers: bounded, in-cluster PVC, deleted on forward, never logged (log control ids/counts only; `piiMask` discipline).
- `lab_interface_messages` is already FORCE-RLS'd and tenant-stamped; new tables follow the same policy shape (migration-281 pattern).
- Gateway logs are operational only (connections, counts, control ids); message bodies never appear in Loki.
- `phiAccessLogger('DEVICE_VITALS')` already covers the ingest/review/verify surface; the registry/association admin surfaces get standard PHI/audit logging where they expose patient bindings (an association row is PHI-adjacent: device↔patient).

## 8. Held Manifests Sketch — Deploy Held

No manifests in this design PR. P1 introduces, under `infra/kubernetes/base/device-gateway/` (unreferenced by the root kustomization until owner sign-off — the telemedicine precedent):

- `deployment.yaml` — single replica, `Recreate`, resources ~`requests cpu:100m/mem:128Mi, limits cpu:500m/mem:512Mi` (the gateway is a framing/spooling proxy, not a compute service), liveness = process/socket probe (DB-free by construction), preStop drain (stop ACKing, flush spool head).
- `service.yaml` — NodePort for MLLP listener(s); ClusterIP for metrics.
- `configmap.yaml` — listener table + forwarding target + policy defaults.
- `secret` (sealed example) — gateway service-principal credentials + device-token pepper.
- `pvc.yaml` — Longhorn spool volume.
- `networkpolicy.yaml` — §7.3 pinning.
- `servicemonitor.yaml` + PrometheusRule additions in `base/monitoring/`.
- `kustomization.yaml` — present but not referenced by the root until activation.

## 9. Phased Plan, Test Strategy, Migration Estimates

Execution conventions per roadmap §8 (PRs with checks green, chunked backend gate, `openapi:check` after any route change, migration counter verified against `src/migrations/`, deploy HELD). Effort class L overall; phases sized M each.

### P1 — Gateway core + MLLP + device registry + association (M)

- Backend: `device_registry` + `device_patient_associations` migrations; registry CRUD (`/api/v1/admin/devices`); `DEVICE_GATEWAY` role (narrow mount allowlist change + role-config/authorization suites per the RBAC protocol); `ingestDeviceVitals` extensions (resolved `patient_uid` param, MSH-10 idempotency, charting-interval/breach persist policy, suppressed-sample metrics); `checkVitalAnomalies` `suppressRepeats` option + artifact-filter hook + device-source notification-target fix; ADT auto-end hooks; unassociated parking + replay.
- Gateway: `apps/device-gateway` service — MLLP framing/ACK, listener table, source resolution (IP/token → registry), spool + drain, forwarder, `/metrics`; own CI lane (lint + jest) wired like backend's.
- Staff app: associate/disconnect flow (wristband scan + device scan/pick) on the existing BCMA scan surface.
- Held manifests (§8). CI: full fixture-replay suite (below).
- Migrations: **3–4** (registry, associations, alert-suppression index + policy config columns, possibly an inbox retention helper). As of this design the migration counter shows 366–367 used with reservations through 372 — **verify the next free number via `ls apps/backend/src/migrations/` at build time** (373+ expected).

### P2 — Cold-chain (M)

- `cold_chain_units/readings/excursions` migrations (**2–3**); HTTP ingest (gateway adapter + backend route); excursion engine (grace windows, open/close, corrective-action gate); notificationOutbox + escalation wiring; `staff:cold-chain` channel + admin tile (proven board recipe); monthly register export; silent-sensor watchdog; registry `kind='fridge_sensor'` provisioning UX.

### P3 — CMMS (M)

- `biomed_work_orders` + `biomed_maintenance_schedules` + `biomed_calibration_certificates` migrations (**2–3**); schedule-materializer cron (`withJobLock`); WO lifecycle routes/services mirroring housekeeping; calibration-certificate upload via existing validated path; prediction→WO and device-fault→WO hooks; admin biomed board + staff WO list; `BIOMED_TECHNICIAN` RBAC cleanup PR if needed.

### P4 — RTLS seam + pilot hardening (S–M)

- RTLS contract tables + ingest + board column (**1–2** migrations) **only if** a vendor pilot is scheduled (§10.7).
- Pilot hardening: artifact-filter/suppression tuning against real pilot traffic; association TTL policy per governance; optional ADT-driven association assist; soak test via fixture replayer at pilot volumes; runbooks (`device-gateway-triage.md`, spool-drain procedure, silent-device response, cold-chain excursion response; update `code-blue-misfire.md` for the device source); Grafana polish; activation checklist for the held manifests.

### Test Strategy — protocol-fixture replay, no real devices in CI

- **Fixture corpus** under `apps/device-gateway/fixtures/` + backend test fixtures: per-vendor ORU^R01 samples (multi-OBX, BP panel via components, escape sequences, unmapped codes, missing PID, malformed segments), recorded once from pilot hardware / vendor simulators and committed as text. CI replays fixtures; it never opens real device connections (the NL-3 "mock the SFU, no live media in CI" precedent).
- **Gateway unit/integration (its own jest lane):** MLLP framing across split/joined/interleaved TCP chunks; ACK-after-spool ordering; AR-on-full; duplicate control-id handling; drain ordering + dead-letter on 4xx; spool crash-recovery (kill mid-drain, restart, assert no loss/no dup). Backend is stubbed with a local HTTP double.
- **Backend (existing chunked jest discipline):** ingest-policy tests (interval persist, breach pass-through, suppression window arm/re-arm on ack, artifact filter N-of-M, idempotent control ids); association lifecycle (single-active, auto-close, ADT end, unassociated parking + replay); registry auth (unknown IP/token refused, revoked device refused, `DEVICE_GATEWAY` role can ingest but cannot verify/subscribe); tenant isolation (cross-tenant PID-3 and association attempts refused — extends the CAN-045 tests); cold-chain grace/excursion/corrective-action-gate; CMMS materializer idempotency; timeline/NEWS2 regression proving the device path still lands `unverified` events and paced NEWS2 rows.
- **End-to-end replay (deep test, live QA PG):** fixture stream → gateway (spawned in-process) → real backend → assert `vitals_chart` rows, suppression counters, one alert per breach episode, results-inbox task creation — the same deterministic-journey style as the existing journey suites.
- **Not tested in CI, documented honestly:** real vendor ACK quirks, VLAN routing, NodePort reachability — these are pilot bring-up checks in the P4 runbook, mirroring how NL-3 handled live media.

## 10. Owner Decisions

1. **Pilot monitor vendor/models and integration point.** Which monitor fleet (Philips IntelliVue / GE CARESCAPE / Mindray / Nihon Kohden) and whether the feed comes from a central station (expected) or per-monitor sockets. This picks the first adapter's dialect, sources the fixture corpus, and decides whether a vendor gateway license (e.g. IntelliBridge/eGateway HL7 export option) must be procured. **Blocking for P1 pilot bring-up; not blocking for P1 build** (the MLLP/ORU core + fixtures proceed on the IHE PCD-01 shape).
2. **Edge hardware: in-cluster vs dedicated node.** Recommended: run the gateway on the existing 3-node cluster (NodePort) for the pilot — zero new hardware, HA via restart+spool+sender buffering. Alternative if hospital IT wants physical separation or the device VLAN cannot be routed to the cluster VLAN: a small dedicated node (NUC/DIN-rail class) joined as a labeled+tainted RKE2 agent pinning the gateway Deployment. Decide with hospital IT during §10.3.
3. **Device VLAN + firewall rules with hospital IT.** CIDRs, static addressing for central stations/sensors, the device→cluster port allowlist, device→internet deny, and who owns switch/firewall change management. Prerequisite for any deploy; the design assumes §7.1 as stated.
4. **Alarm-policy governance owner.** Who signs the clinical parameters: suppression windows (CRITICAL 10 min / WARNING 30 min defaults), artifact filter (2-of-3 default), charting intervals (5 min default), per-unit overrides, and the association re-confirm TTL. Recommended: the clinical governance committee that owns the existing code-blue/escalation policies, with parameters recorded in tenant settings and change-audited.
5. **Cold-chain sensor procurement constraint.** Affirm the binding rule: local-push-capable sensors only (HTTP/LoRaWAN-gateway/BLE-gateway); vendor-cloud-only products excluded; MQTT broker added only if the chosen hardware requires it.
6. **CMMS auto-work-order from device faults.** Auto-create corrective WOs from gateway-observed faults (with open-WO dedupe) vs suggest-only queue. Recommended: auto-create — it is an operational ticket, not a clinical action — but biomed team preference rules.
7. **RTLS pilot gating.** P4 RTLS tables/ingest are built only when a specific vendor pilot is scheduled; otherwise the seam remains this documented contract. Confirm, and name the candidate vendor if one exists.

## 11. Source Notes

Primary grounding is the repository evidence in §1. External/protocol context relied on (well-established, to be re-verified against the chosen pilot vendor's interface manual during P1 bring-up per §10.1):

- HL7 v2 MLLP framing (`<VT>` 0x0B message start, `<FS><CR>` 0x1C 0x0D trailer) and ORU^R01 ACK semantics (MSA AA/AE/AR) — HL7 v2.x messaging standard; the repo's `generateACK` already emits the MSA shape.
- IHE Patient Care Device (PCD-01) profile — the standard shape for periodic device observation ORU^R01 feeds from monitor central stations; aligns with the existing `deviceVitalsService` expectations (OBX numerics keyed by LOINC).
- Monitor-fleet integration is normally licensed at the central-station/gateway tier (Philips IntelliVue Information Center/IntelliBridge, GE CARESCAPE Gateway, Mindray eGateway, Nihon Kohden HL7 options) — vendor interface manuals to confirm exact export cadence, PV1/OBR population, and buffering behavior for the chosen fleet.
- NEWS2 escalation thresholds (score 5 urgent / 7 emergency) — already encoded in `news2Service.js`; unchanged by this design.
