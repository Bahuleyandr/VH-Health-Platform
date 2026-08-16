# C6.1 External-Dependency Recovery Inventory

**Status:** analysis evidence for C-D8; all policy and ownership decisions remain `OWNER INPUT`
**Baseline:** `github/main` at `dfac4c7202f49037f3407a705064be3c1945b3f0`
**Scope:** repository census of implemented external interfaces and explicitly requested integration domains that currently have no external connector

## 1. Authority and proof standard

The continuity plan requires an inventory of interface queues, acknowledgement behavior, idempotency, high-water marks, retention, replay, stop/restart ownership, and late-arrival effects for LIS/laboratory, PACS, pharmacy, blood bank, SSO, FHIR/ABDM, and messaging integrations (`docs/superpowers/plans/2026-07-28-clinical-service-continuity.md:658-672`). The design requires late replay to avoid retrospective SLA starts, pathway transitions, and patient notifications unless an approved policy expressly permits them (`docs/superpowers/specs/2026-07-28-clinical-service-continuity-design.md:531-549`). C-D8 leaves the high-water mark, duplicate key, ordering rule, restart owner, and late-data effects to owner decision (`docs/superpowers/specs/2026-07-28-clinical-service-continuity-design.md:1037-1042`; `docs/continuity/c0-4-owner-decision-dossier.md:173-188`).

This document therefore records implemented behavior only. A behavior is treated as durable only when a repository-backed store and restart path are both visible. A transport-level success is not treated as a domain acknowledgement unless the code inspects that acknowledgement. A replay guard is not treated as a high-water mark. Where the repository does not prove a value, the value is **unverified**. No retention period, alert threshold, replay order, or ownership assignment is proposed here.

All named owners are `OWNER INPUT`: the repository contains functional domains and role checks, but it does not establish a named accountable C-D8 owner for any interface.

## 2. Coverage reconciliation

The census found 30 interface families. Consolidated families enumerate every provider or protocol variant found under that lifecycle; they do not imply that the variants share an owner. Internal app-to-backend APIs, PostgreSQL/Redis, and the application's own WebSocket fabric are platform components rather than external integration boundaries and are not counted as external interfaces.

| ID | Interface family | Repository state |
|---|---|---|
| I01 | Laboratory/LIS authenticated HL7 ORU ingestion | Implemented |
| I02 | Laboratory/LIS ASTM ingestion | Implemented |
| I03 | Legacy inbound HL7 ADT/ORM bridge | Implemented; legacy ORU is rejected |
| I04 | Outbound HL7 admission, discharge, and result feeds | Implemented |
| I05 | Generic interface engine, including HL7, ASTM, FHIR, DICOM, X12, CSV, and custom payloads | Implemented; inbound backend delivery and replay execution are incomplete |
| I06 | PACS/radiology study linking, modality worklist, Orthanc, and DICOMweb metadata lookup | Implemented |
| I07 | External pharmacy system | No external connector found; internal pharmacy REST/database workflows only |
| I08 | External blood-bank system | No external connector found; internal blood-bank REST/database workflows only |
| I09 | Bedside/device-gateway monitor HL7 over MLLP | Implemented; production drain invocation not found |
| I10 | Device-gateway cold-chain sensor ingestion | Implemented |
| I11 | OIDC staff and platform-admin SSO | Implemented |
| I12 | SAML staff and platform-admin SSO | Implemented |
| I13 | SCIM identity provisioning | Implemented |
| I14 | Firebase patient identity and patient App Check | Implemented conditionally; backend App Check enforcement not found |
| I15 | FHIR/SMART on FHIR, including FHIR Observation writes and SMART OAuth | Implemented |
| I16 | ABDM consent, callback, data request, and health-information push | Implemented |
| I17 | Notification delivery: FCM push, SMTP email, WhatsApp, voice, and SMS path | Implemented conditionally; SMS is dry-run/not gateway-wired |
| I18 | Generic outbound subscriber webhooks and event-outbox bridge | Implemented |
| I19 | NHCX outbound messages and inbound callbacks | Implemented conditionally |
| I20 | Generic prior-authorization payer adapter | Implemented conditionally |
| I21 | LiveKit teleconsultation media | Implemented conditionally |
| I22 | WHO ICD terminology service | Implemented conditionally |
| I23 | ClinicalTrials.gov catalog synchronization | Implemented |
| I24 | External AI providers: LLM, embeddings/RAG, speech-to-text, and chatbot inference | Implemented conditionally |
| I25 | SIEM export by webhook, syslog, or object drop | Implemented; automatic scheduler/route invocation is unverified |
| I26 | Observability: Sentry, Firebase Crashlytics, Prometheus scrape, and security/operations alert webhooks | Implemented conditionally |
| I27 | R2-compatible object storage and ClamAV-style malware scanning | Implemented conditionally |
| I28 | CDS Hooks service for third-party EHR clients | Implemented |
| I29 | Metabase embedded analytics | Implemented conditionally |
| I30 | UPI/payment-link handoff | Implemented; external gateway callback not found |

## 3. Operational recovery inventory

### I01 — Laboratory/LIS authenticated HL7 ORU ingestion

- **Direction and transport:** inbound HL7 ORU body over authenticated HTTP `POST /oru/ingest`; tenant identity comes from the authenticated API client, not an HL7 facility assertion (`apps/backend/src/routes/lab/labIngestRoutes.js:65-83`).
- **Queue or buffer:** durable database inbox/command receipt in `lab_oru_ingest_messages`. The claim, results, canonical event, order advancement, critical task/SLA materialization, and receipt outcome share one tenant transaction (`apps/backend/src/services/lab/labResultsService.js:808-872`, `apps/backend/src/services/lab/labResultsService.js:1407-1455`).
- **Acknowledgement and unacknowledged behavior:** HTTP success is returned after the transaction completes. A failed transaction leaves no completed receipt; the sender must retry. Post-commit notification failure does not roll back the accepted result (`apps/backend/src/services/lab/labResultsService.js:1466-1476`).
- **Idempotency:** durable, per tenant, keyed by `(tenant_id, trusted_sender_identity, message_control_id)`, with exact raw-message comparison on replay. No expiry or cleanup is defined in the table or service (`apps/backend/src/services/lab/labResultsService.js:902-956`; `apps/backend/src/migrations/582_lab_oru_replay_idempotency.sql:201-243`). The separate manual/panel command guard is also per tenant, keyed by `(tenant_id, actor_uid, command_scope, command_key)`, and has no expiry (`apps/backend/src/migrations/582_lab_oru_replay_idempotency.sql:872-895`); it is prior art, not the ORU transport guard.
- **High-water mark:** none found. Message-control deduplication is not an ordered cursor.
- **Retention:** unverified; no receipt purge or expiry path was found.
- **Stop and restart:** committed receipts and results survive. An item whose transaction did not commit must be resent by the LIS. A replay of the same raw message returns the stored outcome; a reused control ID with different content conflicts.
- **★ Late-data blast radius:** **high**. An hours-late result is inserted with no analyzer/performed timestamp in this path, so canonical occurrence falls back to receipt/create time; it can advance an investigation, create a critical alert/task and SLA, and send post-commit notifications (`apps/backend/src/services/lab/labResultsService.js:1170-1278`, `apps/backend/src/services/lab/labResultsService.js:1280-1404`, `apps/backend/src/services/lab/labResultsService.js:1497-1585`). That is current behavior, not an approved C-D8 policy.
- **Owner:** `OWNER INPUT`.

### I02 — Laboratory/LIS ASTM ingestion

- **Direction and transport:** inbound ASTM text over authenticated HTTP `POST /interface/ingest`; HL7 is explicitly rejected from this route (`apps/backend/src/routes/lab/labIngestRoutes.js:84-110`).
- **Queue or buffer:** durable `lab_interface_messages` receipt/inbox in the tenant database transaction (`apps/backend/src/services/lab/labClosedLoopService.js:1025-1086`).
- **Acknowledgement and unacknowledged behavior:** HTTP success follows the completed transaction. Exact completed duplicates return the prior outcome. A failed original may be retried only through the same channel; an in-progress claim conflicts (`apps/backend/src/services/lab/labClosedLoopService.js:728-847`).
- **Idempotency:** durable, per tenant and analyzer, using the canonical raw-message SHA/fingerprint. The database enforces uniqueness and terminal-record protections; no expiry or cleanup was found (`apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:255-256`, `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:306-311`, `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:3861-3993`).
- **High-water mark:** none found.
- **Retention:** unverified; no purge or expiry path was found.
- **Stop and restart:** committed inbox outcomes survive. An uncommitted item requires analyzer/LIS retry. Failed receipts have a constrained same-channel retry path.
- **★ Late-data blast radius:** **high**. Receipt time is recorded at ingestion and used for the result/canonical event; a late critical result can advance the investigation, materialize a critical alert/SLA, and notify after commit (`apps/backend/src/services/lab/labClosedLoopService.js:1103-1243`, `apps/backend/src/services/lab/labClosedLoopService.js:1310-1318`). That is current behavior, not an approved C-D8 policy.
- **Owner:** `OWNER INPUT`.

### I03 — Legacy inbound HL7 ADT/ORM bridge

- **Direction and transport:** inbound HL7 over public HMAC-authenticated HTTP `POST /receive`. Tenant selection is derived from MSH-6 and then constrained by the signing client (`apps/backend/src/routes/hl7/hl7Routes.js:49-136`).
- **Queue or buffer:** none. The request is parsed and mutates admissions/investigations synchronously (`apps/backend/src/routes/hl7/hl7Routes.js:212-290`).
- **Acknowledgement and unacknowledged behavior:** a successful ADT/ORM returns an HL7 `AA`. Unsupported messages return `AE`; legacy ORU is specifically rejected in favor of the authenticated laboratory route. Internal failure returns HTTP 500 with `AE`, leaving retry to the sender (`apps/backend/src/routes/hl7/hl7Routes.js:160-203`, `apps/backend/src/routes/hl7/hl7Routes.js:293-318`).
- **Idempotency:** only the shared signed-request replay guard: key material is request ID, timestamp, and signature; Redis or `interop_replay_guard` stores it for the configured TTL. The database design explicitly has no tenant column and the default acceptance/replay window is five minutes (`apps/backend/src/utils/signedRequest.js:15-20`, `apps/backend/src/utils/signedRequest.js:111-219`; `apps/backend/src/migrations/321_interop_replay_store.sql:25-55`). It is not a durable domain-command guard. ADT admission insert uses `ON CONFLICT DO NOTHING`; ORM has no equivalent transport-command receipt.
- **High-water mark:** none found.
- **Retention:** no message payload is retained. Replay-guard entries expire by TTL.
- **Stop and restart:** no request resumes. The sender must retry. The database replay store survives restart until TTL; Redis/cache availability depends on deployment. After expiry, a replay can be accepted again.
- **★ Late-data blast radius:** **medium**. A late ADT can create/update admission state and a late ORM can create an investigation (`apps/backend/src/routes/hl7/hl7Routes.js:212-290`). No direct patient notification, SLA start/settlement, or care-pathway transition was found in this handler; downstream effects are **unverified**.
- **Owner:** `OWNER INPUT`.

### I04 — Outbound HL7 admission, discharge, and result feeds

- **Direction and transport:** outbound HL7 messages to configured HTTP bridge endpoints, created from admission/discharge hooks and signed-result publication (`apps/backend/src/services/hl7/hl7OutboundService.js:149-267`).
- **Queue or buffer:** durable per-subscription `hl7_outbound_queue`; the scheduler drains due `QUEUED`/`FAILED` rows under a lock every two minutes (`apps/backend/src/services/hl7/hl7OutboundService.js:112-133`, `apps/backend/src/utils/scheduler.js:703-708`).
- **Acknowledgement and unacknowledged behavior:** any HTTP 2xx marks the row sent; an HL7 ACK body is not parsed. Failure retries with backoff and becomes dead after seven attempts (`apps/backend/src/services/hl7/hl7OutboundService.js:272-355`).
- **Idempotency:** no unique source-event/subscription enqueue guard was found. Manual replay can requeue even a previously sent row (`apps/backend/src/services/hl7/hl7OutboundService.js:376-386`; `apps/backend/src/migrations/283_hl7_outbound_feeds.sql:38-58`).
- **High-water mark:** none found.
- **Retention:** unverified; queue rows have no expiry and no purge path was found.
- **Stop and restart:** due queued/failed rows resume on scheduler restart. A crash after downstream acceptance but before local `SENT` update can redeliver. Dead rows require an operator replay.
- **★ Late-data blast radius:** **downstream-dependent**. This interface does not itself notify a patient, start/settle a local SLA, or transition a local care pathway. A late or duplicate downstream ADT/ORU may do so in the receiving system; repository evidence cannot verify that behavior.
- **Owner:** `OWNER INPUT`.

### I05 — Generic interface engine

- **Direction and transport:** inbound and outbound records can represent HL7, ASTM, FHIR, DICOM, X12, CSV, or custom payloads. Inbound requests are HMAC signed; outbound dispatch is HTTP (`apps/backend/src/services/interfaceEngine/interfaceEngineService.js:14-23`, `apps/backend/src/services/interfaceEngine/interfaceEngineService.js:850-956`).
- **Queue or buffer:** encrypted durable message rows with `retention_until`; outbound dispatch records attempts. Inbound parsing/transform is stored, but the `deliver_backend` success attempt has no actual backend invocation in the visible path (`apps/backend/src/services/interfaceEngine/interfaceEngineService.js:646-813`).
- **Acknowledgement and unacknowledged behavior:** inbound returns after record processing. Outbound treats HTTP 2xx as acknowledgement and otherwise increments attempts/dead-letters; automatic dispatch scheduling was not found (`apps/backend/src/services/interfaceEngine/interfaceEngineService.js:959-1063`, `apps/backend/src/services/interfaceEngine/interfaceEngineService.js:1123-1154`).
- **Idempotency:** HL7 dedupe uses channel, type, and MSH-10; other formats use a payload hash. A duplicate updates the existing message to `ignored_duplicate`. Signed inbound additionally uses the shared short-TTL, no-tenant replay guard (`apps/backend/src/services/interfaceEngine/interfaceEngineService.js:137-142`, `apps/backend/src/services/interfaceEngine/interfaceEngineService.js:717-745`, `apps/backend/src/services/interfaceEngine/interfaceEngineService.js:850-911`).
- **High-water mark:** none found.
- **Retention:** `retention_until` is stored from configuration; enforcement/purge is unverified.
- **Stop and restart:** durable rows survive, but no automatic outbound dispatcher invocation or execution of `replay_requested` inbound work was found. A replay batch changes state but does not prove domain reprocessing (`apps/backend/src/services/interfaceEngine/interfaceEngineService.js:1157-1232`).
- **★ Late-data blast radius:** **currently unverified/inert at the generic handoff** because actual inbound backend delivery is not visible. If connected, the blast radius inherits the target domain and must not be inferred from the declared format.
- **Owner:** `OWNER INPUT`.

### I06 — PACS/radiology, Orthanc, and DICOMweb

- **Direction and transport:** inbound/manual HTTP study-linking, outbound HTTP modality-worklist reads, and synchronous Orthanc/DICOMweb metadata pulls (`apps/backend/src/routes/radiology/pacsRoutes.js:42-77`; `apps/backend/src/services/ai/imagingPacsAdapterService.js:239-327`).
- **Queue or buffer:** none. Study links are written synchronously; modality worklist and metadata lookups are request/response.
- **Acknowledgement and unacknowledged behavior:** HTTP success confirms the local study-link transaction or lookup response. A failed request is not retained by this interface; caller/PACS retry is required.
- **Idempotency:** study linking rejects a conflicting study UID and writes canonical events with idempotency keys, but there is no transport receipt/replay guard for the incoming webhook/manual request (`apps/backend/src/services/radiology/pacsService.js:83-156`). Worklist and lookup reads do not need a mutation guard.
- **High-water mark:** none. Worklist is a stateless current query (`apps/backend/src/services/radiology/pacsService.js:179-215`).
- **Retention:** no interface payload retention was found; linked study identity is retained as domain data.
- **Stop and restart:** no work resumes. PACS/caller retries a failed study link or lookup. A committed study link survives.
- **★ Late-data blast radius:** **low/medium**. A late link updates the imaging order and emits `imaging.study_linked` (`apps/backend/src/services/radiology/pacsService.js:83-156`). No direct patient notification, SLA start/settlement, or care-pathway transition was found in this path; downstream effects are **unverified**.
- **Owner:** `OWNER INPUT`.

### I07 — External pharmacy system

- **Direction and transport:** no external pharmacy/LIS-style connector was found. Supplier, purchase-order, and goods-receipt operations are internal authenticated REST/database workflows (`apps/backend/src/routes/admin/pharmacySupplyRoutes.js:42-60`, `apps/backend/src/services/pharmacySupply/pharmacySupplyService.js:200-232`, `apps/backend/src/services/pharmacySupply/pharmacySupplyService.js:723-902`).
- **Queue, acknowledgement, idempotency, high-water mark, retention, stop/restart:** not applicable to an external interface on this baseline. Whether an external pharmacy interface exists outside this repository is **unverified**.
- **★ Late-data blast radius:** not applicable to a repository-implemented external pharmacy connector.
- **Owner:** `OWNER INPUT`.

### I08 — External blood-bank system

- **Direction and transport:** no external blood-bank system connector was found. Requests, crossmatch, issue, and transfusion completion are internal authenticated REST/database workflows (`apps/backend/src/routes/bloodbank/bloodBankRoutes.js:220-317`). Cold-chain sensor ingress is separately inventoried as I10.
- **Queue, acknowledgement, idempotency, high-water mark, retention, stop/restart:** not applicable to an external blood-bank interface on this baseline. Whether an external blood-bank interface exists outside this repository is **unverified**.
- **★ Late-data blast radius:** not applicable to a repository-implemented external blood-bank connector.
- **Owner:** `OWNER INPUT`.

### I09 — Bedside/device-gateway monitor HL7 over MLLP

- **Direction and transport:** inbound HL7 from monitor sources over MLLP TCP into `apps/device-gateway`, then HTTP resolve/ingest calls to the backend (`apps/device-gateway/src/gateway.js:210-275`; `apps/device-gateway/src/backendClient.js:18-38`).
- **Queue or buffer:** per-source append-only NDJSON spool on the gateway filesystem. Append is followed by `fsync`; removal rewrites the spool. Failed 4xx items can be moved to a dead-letter file (`apps/device-gateway/src/spool.js:12-87`). Kubernetes declares one replica and a persistent volume, but the base overlay is held from the default composition (`infra/kubernetes/base/device-gateway/deployment.yaml:9-10`, `infra/kubernetes/base/device-gateway/deployment.yaml:25-51`, `infra/kubernetes/base/device-gateway/deployment.yaml:74-77`; `infra/kubernetes/base/device-gateway/kustomization.yaml:1-10`).
- **Acknowledgement and unacknowledged behavior:** the gateway returns MLLP `AA` only after the record is durably spooled. Spool-full returns `AR`; other failures return `AE`. Drain removes on backend 2xx, dead-letters on 4xx, and stops on 5xx (`apps/device-gateway/src/gateway.js:64-130`).
- **Idempotency:** gateway memory dedupe is per source/control ID with a default 24-hour TTL and is lost on restart (`apps/device-gateway/src/gateway.js:19-61`). The backend has a durable per-tenant/device/control-ID guard with a 24-hour TTL (`apps/backend/src/services/emr/deviceVitalsService.js:163-179`; `apps/backend/src/migrations/373_device_ingest_policy.sql:27-44`).
- **High-water mark:** none found. FIFO spool position is not persisted as a source sequence/cursor.
- **Retention:** spool and dead-letter files have no time-based purge in the implementation. The backend replay guard expires after 24 hours.
- **Stop and restart:** spooled files survive only if the configured spool directory is durable. The production entrypoint starts listeners but no invocation of `drainSource` was found, so automatic replay after restart is **unverified and appears unwired** (`apps/device-gateway/src/index.js:1-23`; `apps/device-gateway/src/gateway.js:106-130`).
- **★ Late-data blast radius:** **high**. Backend ingestion calls `recordVitals` with the supplied clinical time; that path persists observations and NEWS2, can escalate NEWS2, propagate triage, and create clinical alerts (`apps/backend/src/services/emr/deviceVitalsService.js:443-546`; `apps/backend/src/services/emr/vitalsChartService.js:430-494`, `apps/backend/src/services/emr/vitalsChartService.js:521-703`). Direct patient notification and SLA creation/settlement from this exact path are **unverified**.
- **Owner:** `OWNER INPUT`.

### I10 — Device-gateway cold-chain sensor ingestion

- **Direction and transport:** inbound sensor HTTP to the gateway, followed by synchronous HTTP from the gateway to the backend (`apps/device-gateway/src/gateway.js:138-148`, `apps/device-gateway/src/gateway.js:184-207`; `apps/device-gateway/src/backendClient.js:40-55`).
- **Queue or buffer:** none in the gateway cold-chain path.
- **Acknowledgement and unacknowledged behavior:** a backend HTTP success is passed back as request success. Failure is not retained; the sensor/caller must retry.
- **Idempotency:** no reading-level transport receipt or unique replay guard was found. The backend inserts readings without a uniqueness constraint in the visible path (`apps/backend/src/services/devices/coldChainService.js:794-840`).
- **High-water mark:** none found.
- **Retention:** the schema records a minimum 730-day policy and unit-level `retention_days`; enforcement/purge is unverified (`apps/backend/src/migrations/391_cold_chain_units.sql:1-3`, `apps/backend/src/migrations/391_cold_chain_units.sql:20-74`).
- **Stop and restart:** no request resumes. The external sender must retry; a retry can create a duplicate reading and repeat state evaluation.
- **★ Late-data blast radius:** **critical**. The supplied `recorded_at` is evaluated against current excursion state, so late readings can open, update, or close an excursion. Opening creates SLA/task and blood-bank review effects and queues notifications (`apps/backend/src/services/devices/coldChainService.js:342-532`, `apps/backend/src/services/devices/coldChainService.js:794-930`). That is current behavior, not an approved C-D8 policy.
- **Owner:** `OWNER INPUT`.

### I11 — OIDC staff and platform-admin SSO

- **Direction and transport:** outbound browser redirect plus synchronous HTTPS metadata/JWKS/token calls and inbound browser callback. Staff flow uses an in-memory state store; platform-admin flow uses a signed state cookie (`apps/backend/src/services/auth/staffOidcSsoService.js:485-535`, `apps/backend/src/services/auth/staffOidcSsoService.js:579-670`; `apps/backend/src/services/auth/adminOidcSsoService.js:576-626`, `apps/backend/src/services/auth/adminOidcSsoService.js:661-716`).
- **Queue or buffer:** none. Metadata/JWKS and staff authorization state are memory caches; the admin signed state is client-held.
- **Acknowledgement and unacknowledged behavior:** successful token exchange, nonce validation, and local session creation complete the login. Failure requires a new login attempt (`apps/backend/src/services/auth/adminOidcSsoService.js:880-940`).
- **Idempotency:** no local durable callback receipt. PKCE/nonce/state and the identity provider's authorization-code semantics protect the flow, but are not an interface replay cursor.
- **High-water mark:** none.
- **Retention:** bounded state/token-cache TTLs are implementation security windows, not undelivered-message retention.
- **Stop and restart:** staff in-flight authorization state is lost and the callback fails; metadata/JWKS caches refill. The admin signed-cookie flow may survive a backend restart if all other validity checks still pass.
- **★ Late-data blast radius:** **none found for C-D8 clinical effects**. A late/invalid callback fails or creates an authenticated session; it does not directly notify a patient, start/settle a clinical SLA, or transition a care pathway.
- **Owner:** `OWNER INPUT`.

### I12 — SAML staff and platform-admin SSO

- **Direction and transport:** outbound browser SAML request and inbound browser assertion; metadata may be fetched over HTTPS and configuration is stored encrypted (`apps/backend/src/services/auth/samlSsoConfigService.js:143-154`, `apps/backend/src/services/auth/samlSsoConfigService.js:340-399`).
- **Queue or buffer:** none.
- **Acknowledgement and unacknowledged behavior:** a validated assertion creates a local session. Invalid, expired, or replayed assertions fail and require a new login.
- **Idempotency:** durable `identity_saml_replay_cache` for request/response/assertion keys, unique per provider and kind, tenant-scoped except platform-admin records. Request TTL is 10 minutes and replay TTL is 24 hours (`apps/backend/src/services/auth/samlSsoService.js:28-29`, `apps/backend/src/services/auth/samlSsoService.js:320-440`, `apps/backend/src/services/auth/samlSsoService.js:995-999`).
- **High-water mark:** none.
- **Retention:** replay entries expire by their defined TTL; there is no undelivered payload queue.
- **Stop and restart:** durable replay records survive. In-flight browser flows remain subject to request/assertion validity and may require a new login.
- **★ Late-data blast radius:** **none found for C-D8 clinical effects**.
- **Owner:** `OWNER INPUT`.

### I13 — SCIM identity provisioning

- **Direction and transport:** inbound tenant/provider bearer-authenticated SCIM HTTP create, update, patch, and delete calls (`apps/backend/src/services/auth/scimProvisioningService.js:205-246`, `apps/backend/src/services/auth/scimProvisioningService.js:543-800`).
- **Queue or buffer:** none.
- **Acknowledgement and unacknowledged behavior:** SCIM HTTP response follows the synchronous local transaction. Failure is not retained; the identity provider must retry.
- **Idempotency:** semantic lookup/upsert uses local identity and external ID, but no durable request/command receipt or version precondition was found. Deactivation revokes sessions (`apps/backend/src/services/auth/scimProvisioningService.js:520-540`, `apps/backend/src/services/auth/scimProvisioningService.js:918-959`).
- **High-water mark:** none.
- **Retention:** no interface-payload retention; resulting identity/audit data follows domain retention, which is unverified here.
- **Stop and restart:** no request resumes. The provider retries; a repeated request re-evaluates current identity state.
- **★ Late-data blast radius:** **access-control only in the visible path**. Late delivery can enable, update, or deactivate an identity and revoke sessions. No direct patient notification, clinical SLA effect, or care-pathway transition was found.
- **Owner:** `OWNER INPUT`.

### I14 — Firebase patient identity and App Check

- **Direction and transport:** inbound Firebase ID token over the patient authentication flow; backend synchronously verifies with Firebase Admin, binds/creates a tenant patient identity, and issues a local session (`apps/backend/src/services/auth/firebaseAuthService.js:50-153`). The patient client also activates Firebase App Check, but no backend App Check-token enforcement path was found (`apps/patient/lib/main.dart:66-98`).
- **Queue or buffer:** none.
- **Acknowledgement and unacknowledged behavior:** successful verification/session issue is the acknowledgement. Failure requires the patient/client to retry authentication.
- **Idempotency:** identity binding by Firebase UID is durable domain identity, but no transport callback receipt is applicable/found.
- **High-water mark:** none.
- **Retention:** no undelivered item exists. Identity/session retention is outside C-D8 and unverified here.
- **Stop and restart:** no in-flight authentication or attestation resumes; the client retries. Firebase token revocation is an outbound synchronous provider call (`apps/backend/src/services/auth/firebaseAuthService.js:372-388`).
- **★ Late-data blast radius:** **none found for C-D8 clinical effects**.
- **Owner:** `OWNER INPUT`.

### I15 — FHIR/SMART on FHIR

- **Direction and transport:** inbound/outbound FHIR HTTP APIs, including authenticated `POST Observation`; SMART uses browser/OAuth HTTPS and durable authorization-code records (`apps/backend/src/routes/fhir/fhirRoutes.js:179-191`, `apps/backend/src/routes/fhir/fhirRoutes.js:1093-1142`; `apps/backend/src/services/smartFhir/smartOAuthService.js:488-558`).
- **Queue or buffer:** no FHIR message queue. SMART authorization codes are durable security artifacts, not clinical-message buffers.
- **Acknowledgement and unacknowledged behavior:** FHIR write returns HTTP 201 after synchronous domain mutation. A failure is not retained and requires client retry. SMART authorization-code consumption is atomic (`apps/backend/src/services/smartFhir/smartOAuthService.js:761-764`; `apps/backend/src/migrations/125_smart_on_fhir_oauth.sql:64-94`).
- **Idempotency:** SMART authorization codes are unique/single-use. No FHIR Observation transport command receipt, conditional-create guard, or replay key was found.
- **High-water mark:** none. Read pagination uses request offsets/counts, not a durable per-tenant cursor.
- **Retention:** FHIR resources become domain records; raw request retention is not implemented. SMART artifacts use configured expiry windows (`apps/backend/src/services/smartFhir/smartOAuthService.js:35-45`).
- **Stop and restart:** no clinical write resumes. The FHIR client retries and can create a duplicate observation. Durable SMART codes survive subject to expiry.
- **★ Late-data blast radius:** **high**. FHIR Observation maps directly to `recordVitals` using the supplied effective time; that path can calculate NEWS2, propagate triage, and create clinical alerts (`apps/backend/src/routes/fhir/fhirRoutes.js:1093-1142`; `apps/backend/src/services/emr/vitalsChartService.js:430-703`). Direct patient notification and SLA creation/settlement from this exact path are **unverified**.
- **Owner:** `OWNER INPUT`.

### I16 — ABDM

- **Direction and transport:** inbound HMAC-authenticated HTTP callbacks for consent/data requests and outbound HTTPS calls for consent status and health-information push (`apps/backend/src/routes/abdm/abdmRoutes.js:31-124`; `apps/backend/src/services/abdm/abdmGateway.js:20-115`, `apps/backend/src/services/abdm/abdmGateway.js:193-240`).
- **Queue or buffer:** consent and request state is durable. A data request is saved as `PROCESSING`, then work continues asynchronously in the backend process; no durable work queue/recovery scheduler was found (`apps/backend/src/services/abdm/abdmService.js:968-1007`).
- **Acknowledgement and unacknowledged behavior:** callbacks pass the shared HMAC/replay checks. Health-information push treats provider HTTP success as acknowledgement. Several outbound grant/deny/revoke notifications are fire-and-forget with logged failure, not durable delivery (`apps/backend/src/services/abdm/abdmService.js:762-851`, `apps/backend/src/services/abdm/abdmService.js:1315-1389`).
- **Idempotency:** inbound signed requests use the shared default five-minute, no-tenant replay guard. Consent artifacts additionally have durable consent/artifact identity checks (`apps/backend/src/services/abdm/abdmService.js:626-686`). No general durable command receipt covers every callback or outbound send.
- **High-water mark:** none found.
- **Retention:** consent expiry and `dataEraseAt` fields exist, but repository enforcement/purge of integration payloads is **unverified**.
- **Stop and restart:** committed consent/request state survives. In-process data-request work can be stranded as `PROCESSING`; no resume/reaper was found. Fire-and-forget outbound notifications drop on stop/failure.
- **★ Late-data blast radius:** **privacy/consent and export-state impact**. Late callbacks can change consent/data-request state and initiate health-information collection/push. No direct patient notification, clinical SLA start/settlement, or care-pathway transition was found in these paths.
- **Owner:** `OWNER INPUT`.

### I17 — Notification delivery

- **Direction and transport:** outbound FCM push, SMTP email, WhatsApp, voice, and SMS. SMS is explicitly dry-run/not gateway-wired in the dispatcher (`apps/backend/src/utils/notifications/notificationDispatcher.js:149-169`; `apps/backend/src/services/smsService.js:1-31`).
- **Queue or buffer:** durable `notification_outbox` database queue (`apps/backend/src/utils/notifications/notificationOutbox.js:21-60`; `apps/backend/src/migrations/000_baseline.sql:12747-12760`).
- **Acknowledgement and unacknowledged behavior:** rows are selected in batches and retried up to three attempts with a five-minute delay (`apps/backend/src/utils/notifications/notificationOutbox.js:100-166`). Provider functions are invoked by channel (`apps/backend/src/utils/notifications/notificationOutboxDelivery.js:173-248`). FCM/WhatsApp/voice inspect provider calls (`apps/backend/src/utils/notifications/sendPushNotification.js:35-125`; `apps/backend/src/utils/notifications/sendWhatsAppNotification.js:70-92`; `apps/backend/src/utils/notifications/sendVoiceNotification.js:78-101`). Email returns `null` on absent SMTP/failure, but the dispatcher does not reject that result, so a row can be marked sent without provider acceptance (`apps/backend/src/utils/notifications/sendEmailNotification.js:39-56`; `apps/backend/src/utils/notifications/notificationDispatcher.js:82-99`). FCM client listeners exist, but no application-level receipt from the patient/staff device is returned to the outbox (`apps/patient/lib/main.dart:51-69`; `apps/staff/lib/core/providers/notification_provider.dart:131-161`).
- **Idempotency:** generic enqueue has no unique source-event guard. A later diagnostic-result producer adds source-specific dedupe, but it does not cover the generic queue (`apps/backend/src/migrations/593_structured_diagnostic_patient_notifications.sql:1-45`). Workers release row locks before network delivery, so concurrent delivery can duplicate.
- **High-water mark:** none.
- **Retention:** unverified; no sent/dead queue purge was found.
- **Stop and restart:** queued/retry rows resume when the scheduler drains the outbox (`apps/backend/src/utils/scheduler.js:352-390`, `apps/backend/src/utils/scheduler.js:568-575`). A crash/concurrent worker around provider acceptance can duplicate. Rows past the attempt limit remain terminal.
- **★ Late-data blast radius:** **critical by definition**. Hours-late queued rows can directly notify patients or staff. The queue does not carry or enforce a general “late replay may notify” policy gate in the visible path.
- **Owner:** `OWNER INPUT`.

### I18 — Generic outbound webhooks

- **Direction and transport:** outbound signed HTTP delivery to subscriber endpoints, fed by direct enqueue and an `event_outbox` bridge (`apps/backend/src/services/integrations/webhookDeliveryService.js:121-227`).
- **Queue or buffer:** durable deliveries with claim leases, attempts, backoff, and dead state. Scheduler jobs bridge source events, dispatch deliveries, and reap stale leases (`apps/backend/src/services/integrations/webhookDeliveryService.js:470-633`; `apps/backend/src/utils/scheduler.js:584-600`, `apps/backend/src/utils/scheduler.js:913-922`).
- **Acknowledgement and unacknowledged behavior:** HTTP 2xx acknowledges; failures retry up to seven attempts. A stable delivery/request ID is sent downstream (`apps/backend/src/services/integrations/webhookDeliveryService.js:20-35`, `apps/backend/src/services/integrations/webhookDeliveryService.js:470-545`).
- **Idempotency:** source-event/subscription enqueue has a unique database guard (`apps/backend/src/migrations/588_event_outbox_recovery_hardening.sql:192-194`). Ad hoc direct enqueue is not proven to have an equivalent unique source command.
- **High-water mark:** no subscriber/source cursor was found; source events are individually claimed rather than advanced through a declared per-tenant high-water mark.
- **Retention:** unverified; no delivery purge was found.
- **Stop and restart:** queued/retry work resumes. Expired in-flight leases are reaped, so a crash after downstream acceptance but before local completion can redeliver.
- **★ Late-data blast radius:** **downstream-dependent and unverified**. Local patient notification/SLA/pathway state is not changed by delivery, but a subscriber may act on a late event; the repository cannot prove the subscriber's behavior.
- **Owner:** `OWNER INPUT`.

### I19 — NHCX

- **Direction and transport:** outbound HTTPS NHCX API messages and inbound HMAC-authenticated HTTP callbacks (`apps/backend/src/services/nhcx/nhcxOutboundDispatcherService.js:680-803`; `apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:60-153`).
- **Queue or buffer:** durable NHCX message/attempt records, including correlation payloads; the scheduler claims/retries outbound work and reaps stale sent state (`apps/backend/src/migrations/359_nhcx_messages.sql:12-83`; `apps/backend/src/utils/scheduler.js:930-941`).
- **Acknowledgement and unacknowledged behavior:** outbound 2xx is accepted; failures remain retryable under dispatcher rules. Callback processing completes before HTTP 202. Failed callbacks rely on payer/NHCX retry.
- **Idempotency:** outbound uniqueness is `(tenant_id, api_call_id, environment)`. Inbound callbacks use the shared short-TTL signed-request guard and then durable envelope/domain correlation (`apps/backend/src/services/nhcx/nhcxInboundCallbackService.js:593-733`).
- **High-water mark:** none found.
- **Retention:** unverified; no message/attempt purge was found.
- **Stop and restart:** outbound durable work resumes. In-flight callbacks do not; sender retry is required. The short-TTL replay guard can reject a retry inside its window even if downstream handling failed after claim.
- **★ Late-data blast radius:** **financial/authorization state impact**. Late preauthorization and claim callbacks can update finance state (`apps/backend/src/services/nhcx/nhcxInboundCallbackService.js:505-590`). Payment notice remains a manual-review workflow rather than automatic settlement (`apps/backend/src/services/nhcx/nhcxPaymentNoticeService.js:1-4`). No direct patient notification, clinical SLA effect, or care-pathway transition was found.
- **Owner:** `OWNER INPUT`.

### I20 — Generic prior-authorization payer adapter

- **Direction and transport:** conditional outbound synchronous HTTPS `POST` to a configured payer endpoint (`apps/backend/src/services/ai/priorAuthorizationPayerAdapterService.js:60-144`, `apps/backend/src/services/ai/priorAuthorizationPayerAdapterService.js:230-345`).
- **Queue or buffer:** none.
- **Acknowledgement and unacknowledged behavior:** payer HTTP 2xx marks the synchronous submission accepted. Failure returns to the caller; no local durable retry is created.
- **Idempotency:** sends `Idempotency-Key: vh-prior-auth-{priorAuth.id}`. Provider enforcement is unverified; there is no local delivery receipt.
- **High-water mark:** none.
- **Retention:** request/response details follow prior-authorization domain records; interface-payload retention is unverified.
- **Stop and restart:** in-flight work is lost; caller/operator retry is required with the same idempotency key.
- **★ Late-data blast radius:** **administrative/financial in the visible path**. There is no asynchronous late callback here and no direct patient notification, clinical SLA, or pathway transition was found.
- **Owner:** `OWNER INPUT`.

### I21 — LiveKit teleconsultation media

- **Direction and transport:** backend issues signed LiveKit room tokens; clients connect to the configured LiveKit WebSocket service (`apps/backend/src/services/telemedicine/teleconsultProvisioningService.js:89-125`, `apps/backend/src/services/telemedicine/teleconsultProvisioningService.js:552-632`).
- **Queue or buffer:** none. Room/session identity is stored locally and reused, but media is external and real-time (`apps/backend/src/services/telemedicine/teleconsultProvisioningService.js:352-381`).
- **Acknowledgement and unacknowledged behavior:** token issue is local; media connection acknowledgement is client/provider behavior and unverified in this repository.
- **Idempotency:** durable room/session reuse prevents gratuitous room identity creation. No callback/replay receipt is applicable/found.
- **High-water mark:** none.
- **Retention:** media retention is external/unverified. Local teleconsult records follow domain retention.
- **Stop and restart:** new tokens can be issued from durable session state. In-flight media drops or recovery are LiveKit/client responsibilities and unverified.
- **★ Late-data blast radius:** **none found**. The telemedicine service is explicitly provider-agnostic and requires explicit state transitions rather than provider callbacks (`apps/backend/src/services/telemedicine/telemedicineService.js:11-17`).
- **Owner:** `OWNER INPUT`.

### I22 — WHO ICD terminology service

- **Direction and transport:** outbound synchronous HTTPS OAuth/token and terminology search requests (`apps/backend/src/services/terminology/whoIcdClient.js:66-120`, `apps/backend/src/services/terminology/whoIcdClient.js:190-270`).
- **Queue or buffer:** none; token cache is in memory.
- **Acknowledgement and unacknowledged behavior:** HTTP response completes the lookup. Failure falls back through local terminology behavior where allowed (`apps/backend/src/services/terminology/terminologyService.js:270-286`).
- **Idempotency:** read-only lookup; no mutation replay guard.
- **High-water mark:** none.
- **Retention:** no undelivered item; response caching/retention is unverified.
- **Stop and restart:** no request resumes; caller retries and token cache refills.
- **★ Late-data blast radius:** **none** because there is no asynchronous delivery/replay path.
- **Owner:** `OWNER INPUT`.

### I23 — ClinicalTrials.gov catalog synchronization

- **Direction and transport:** scheduled outbound HTTPS catalog fetch and inbound response data (`apps/backend/src/services/ai/trialCatalogSyncService.js:146-163`).
- **Queue or buffer:** a durable sync-run record is created before fetch; studies are upserted and the run is finalized (`apps/backend/src/services/ai/trialCatalogSyncService.js:171-283`). Scheduler invokes the sync (`apps/backend/src/utils/scheduler.js:1108-1115`).
- **Acknowledgement and unacknowledged behavior:** successful fetch/upserts finalize the run. Failure records run failure; no per-page/per-item retry queue was found.
- **Idempotency:** per-study upsert identity limits duplicate catalog rows. There is no source response receipt or page-level replay guard.
- **High-water mark:** none; no durable `nextPageToken`, source revision, or last-source cursor was found.
- **Retention:** sync-run and catalog retention is unverified.
- **Stop and restart:** a crash can leave a run incomplete; the next schedule starts a fresh sync rather than resuming a cursor.
- **★ Late-data blast radius:** **low**. Late catalog refresh changes research catalog data. No direct patient notification, clinical SLA effect, or care-pathway transition was found.
- **Owner:** `OWNER INPUT`.

### I24 — External AI providers

- **Direction and transport:** outbound synchronous HTTP to configured LLM, Ollama-compatible embedding/RAG, speech-to-text, and chatbot providers; results return inline (`apps/backend/src/services/ai/localLlmClient.js:530-655`, `apps/backend/src/services/ai/ragService.js:55-62`, `apps/backend/src/services/ai/sttService.js:201-279`, `apps/backend/src/services/chatbot/triageService.js:316-387`).
- **Queue or buffer:** none in these provider calls. Some clients use bounded inline retry; failed STT is returned/persisted as failed by its caller path (`apps/backend/src/services/ai/localLlmClient.js:818-915`, `apps/backend/src/services/ai/sttService.js:298-360`).
- **Acknowledgement and unacknowledged behavior:** provider HTTP response completes the request. Regional/configuration gates can disable external calls (`apps/backend/src/services/ai/localLlmClient.js:418-443`; `apps/backend/src/services/chatbot/triageService.js:174-205`).
- **Idempotency:** no provider command receipt or replay guard was found; these are synchronous generation/read operations.
- **High-water mark:** none.
- **Retention:** provider-side retention is unverified. Local output retention follows the invoking domain and is outside this interface census.
- **Stop and restart:** in-flight work drops; caller retries. There is no delayed provider callback to replay.
- **★ Late-data blast radius:** **none through an asynchronous late-delivery path**. Outputs return inline as decision support/drafts; any later use is governed by the invoking domain, not provider replay.
- **Owner:** `OWNER INPUT`.

### I25 — SIEM export

- **Direction and transport:** outbound webhook, syslog, or object-drop export from audit log (`apps/backend/src/services/security/siemExportService.js:666-708`, `apps/backend/src/services/security/siemExportService.js:711-785`).
- **Queue or buffer:** durable per-tenant export event and attempt tables with claim/dispatch/retry logic (`apps/backend/src/services/security/siemExportService.js:564-635`, `apps/backend/src/services/security/siemExportService.js:786-901`).
- **Acknowledgement and unacknowledged behavior:** webhook 2xx, syslog send completion, or object write is treated as acknowledgement. Failures retry. Automatic production scheduler/route invocation was not found; only internal/drill use was found, so live draining is **unverified**.
- **Idempotency:** unique exported source event by tenant/source/source ID and unique attempt identity (`apps/backend/src/migrations/449_siem_export_events_deliveries.sql:9-38`, `apps/backend/src/migrations/449_siem_export_events_deliveries.sql:77-114`).
- **High-water mark:** **yes**: durable, per-tenant audit-log ID cursor (`apps/backend/src/services/security/siemExportService.js:414-494`).
- **Retention:** retention policy rows exist, but purge enforcement is unverified (`apps/backend/src/migrations/449_siem_export_events_deliveries.sql:143-172`).
- **Stop and restart:** pending/retry records are durable. No stale in-flight lease recovery was found, so a process stop after claim can strand an item. Without a confirmed scheduler caller, automatic restart behavior remains unverified.
- **★ Late-data blast radius:** **observability only**. Late export does not directly notify patients, start/settle a clinical SLA, or transition a care pathway.
- **Owner:** `OWNER INPUT`.

### I26 — Observability and security/operations alerting

- **Direction and transport:** outbound Sentry SDK reporting from backend, admin, and staff; outbound Firebase Crashlytics from mobile clients; inbound Prometheus HTTP scrape; and outbound fire-and-forget HTTP security/operations webhooks (`apps/backend/src/utils/sentry.js:14-85`; `apps/admin/instrumentation-client.ts:25-41`; `apps/staff/lib/main.dart:143-190`; `apps/patient/lib/main.dart:66-139`; `apps/backend/src/app.js:551-565`; `apps/backend/src/utils/securityWebhook.js:27-83`).
- **Queue or buffer:** no application-owned durable queue. Sentry/Crashlytics SDK buffering and provider retention are **unverified**. Prometheus serializes current in-process metrics on request. One webhook service has only an in-memory five-minute debounce (`apps/backend/src/services/alerting/alertService.js:3-31`).
- **Acknowledgement and unacknowledged behavior:** Sentry/Crashlytics provider acknowledgement is hidden inside the SDK and unverified from repository code. A metrics scrape is acknowledged by its HTTP response. The security webhook logs non-2xx/errors; the alert service does not verify `response.ok`. Webhook failures are not retained.
- **Idempotency:** no application-level durable event guard. In-memory metrics/debounce state is lost on restart.
- **High-water mark:** none.
- **Retention:** no application retention of undelivered observability items. Provider retention is **unverified**.
- **Stop and restart:** app-owned in-flight/failed webhook events drop; counters/debounce reset. SDK recovery behavior is **unverified**. Metrics resume from new process state.
- **★ Late-data blast radius:** **observability/security response only**. No patient notification, clinical SLA, or care-pathway transition is driven by these outputs.
- **Owner:** `OWNER INPUT`.

### I27 — R2-compatible object storage and malware scanning

- **Direction and transport:** outbound S3/R2-compatible object operations with local-storage fallback, plus loopback clamd malware scanning declared by `FILE_SCAN_POLICY` (`apps/backend/src/utils/r2Storage.js:70-119`, `apps/backend/src/utils/r2Storage.js:215-264`; `apps/backend/src/utils/virusScanner.js`).
- **Queue or buffer:** none in the provider adapters.
- **Acknowledgement and unacknowledged behavior:** provider upload/read success or scanner HTTP response completes the request. Storage has bounded inline retry; scanner failure returns an error. Failed work is not queued by these adapters.
- **Idempotency:** object key gives overwrite identity at the provider but is not a local command receipt. No scan-request replay guard was found.
- **High-water mark:** none.
- **Retention:** provider/object/domain retention is unverified here. Scan results may be persisted by the invoking messaging workflow (`apps/backend/src/services/messaging/messagingService.js:410-430`).
- **Stop and restart:** in-flight work drops; caller retries. Local fallback behavior depends on configuration.
- **★ Late-data blast radius:** **content availability/security only in the visible paths**. No direct patient notification, clinical SLA, or care-pathway transition is driven by delayed provider completion.
- **Owner:** `OWNER INPUT`.

### I28 — CDS Hooks service

- **Direction and transport:** inbound authenticated HTTP discovery/invocation from a third-party EHR CDS Hooks client; the backend returns CDS Hooks cards (`apps/backend/src/routes/clinical/cdsHooksRoutes.js:1-5`; `apps/backend/src/app.js:931-931`).
- **Queue or buffer:** none. Each hook evaluates current patient/encounter/order context synchronously (`apps/backend/src/routes/clinical/cdsHooksRoutes.js:60-197`).
- **Acknowledgement and unacknowledged behavior:** an HTTP card response acknowledges the invocation. Failure is not retained; the EHR client must retry.
- **Idempotency:** no command receipt; the visible hook path is a synchronous decision-support read/evaluation rather than an external state mutation.
- **High-water mark:** none; no event stream is consumed.
- **Retention:** no undelivered request or response is retained by the interface.
- **Stop and restart:** no invocation resumes. The EHR client retries and receives a new evaluation of current state.
- **★ Late-data blast radius:** **none through replay**. The interface returns cards inline and does not itself notify a patient, start/settle an SLA, or transition a care pathway. Whether an external EHR acts on a late/retried card is **unverified**.
- **Owner:** `OWNER INPUT`.

### I29 — Metabase embedded analytics

- **Direction and transport:** outbound browser HTTPS to a Metabase iframe URL carrying a backend-signed, tenant-scoped embed JWT (`apps/backend/src/services/dashboards/metabaseService.js:1-17`, `apps/backend/src/services/dashboards/metabaseService.js:84-118`; `apps/backend/src/routes/dashboards/dashboardsRoutes.js:103-123`).
- **Queue or buffer:** none.
- **Acknowledgement and unacknowledged behavior:** the backend only creates the signed URL. Dashboard-load acknowledgement and retry occur in the browser/Metabase and are unverified in this repository.
- **Idempotency:** read-only embed generation; no mutation replay guard.
- **High-water mark:** none. Dashboard freshness/cursor behavior is owned by Metabase and **unverified**.
- **Retention:** embed JWTs have a bounded configured expiry in code; dashboard/provider data retention is **unverified** (`apps/backend/src/services/dashboards/metabaseService.js:27-32`, `apps/backend/src/services/dashboards/metabaseService.js:102-118`).
- **Stop and restart:** existing signed URLs remain subject to their expiry and shared secret; new URLs can be regenerated. No work replays.
- **★ Late-data blast radius:** **analytics display only**. No direct patient notification, clinical SLA, or care-pathway transition is driven by the embed helper.
- **Owner:** `OWNER INPUT`.

### I30 — UPI/payment-link handoff

- **Direction and transport:** outbound `upi://` intent/share URL to a patient's payment application, with optional direct SMS/WhatsApp/email distribution. No external payment-gateway API call or callback handler was found (`apps/backend/src/services/billing/paymentLinkService.js:200-268`, `apps/backend/src/services/billing/paymentLinkService.js:280-362`).
- **Queue or buffer:** the payment-link record is durable, but distribution is synchronous best-effort and has no delivery queue.
- **Acknowledgement and unacknowledged behavior:** channel send completion updates sent timestamps; failures are logged and not queued. The repository has no machine acknowledgement from the payment app/gateway. Payment is settled only through the authenticated, idempotency-key-protected manual mark-paid route (`apps/backend/src/routes/billing/billingV2Routes.js:714-760`; `apps/backend/src/services/billing/paymentLinkService.js:464-543`).
- **Idempotency:** durable link token/transaction reference and manual mark-paid guards prevent the visible manual double-settlement path. There is no external delivery receipt or gateway callback replay guard.
- **High-water mark:** none.
- **Retention:** links have an implemented expiry and stale-expiry operation, but row purge/undelivered-message retention is unverified (`apps/backend/src/services/billing/paymentLinkService.js:20-20`, `apps/backend/src/services/billing/paymentLinkService.js:564-590`).
- **Stop and restart:** link records survive. In-flight distribution drops and must be manually resent. No external payment result resumes or replays because no callback path was found.
- **★ Late-data blast radius:** **patient-notification and financial-administration boundary**. A delayed manual resend can notify a patient; an authenticated manual mark-paid action creates the payment/settlement state. No late external callback can settle automatically on this baseline because none was found.
- **Owner:** `OWNER INPUT`.

## 4. Stop and restart order recommendation

This is an engineering dependency order for C-D8 owner review, not a clinical policy decision. It does not authorize replay, notification, SLA calculation, pathway mutation, or acceptance of data beyond any existing limit.

### Stop order

1. **Quiesce new ingress at external senders or edge listeners:** I01, I02, I03, I05 inbound, I06 study-link ingress, I09, I10, I13, I15 FHIR writes, I16 callbacks, and I19 callbacks. This prevents new acknowledgements while downstream consumers are being stopped. For I09, stopping the MLLP listener only after sender quiescence avoids acknowledging to a spool whose production drain is unverified.
2. **Stop synchronous clinical/domain consumers:** laboratory processing, FHIR/device-vitals processing, cold-chain processing, PACS linking, ABDM/NHCX callback handlers, and identity provisioning. These components create the domain state that downstream outboxes publish.
3. **Drain or deliberately freeze durable outbound queues:** I04 HL7, I17 notifications, I18 webhooks, I19 NHCX outbound, and I25 SIEM. The operator must record queue counts and oldest-item timestamps before stopping. Whether draining or freezing is correct for each interface is `OWNER INPUT`; the repository cannot make the late-notification decision.
4. **Stop schedulers/reapers after queue state is recorded:** this preserves an auditable boundary between work completed before shutdown and work deferred to restart.
5. **Stop stateless/request-response dependencies last:** OIDC/SAML/Firebase, payer submission, LiveKit token issue, WHO ICD, trial sync, AI providers, CDS Hooks, Metabase embeds, payment-link handoff, observability/security webhooks, and storage/scanning. These do not provide a durable replay stream in their adapter paths.
6. **Stop databases and durable storage after all application writers:** tenant databases, shared replay store/Redis, gateway spool volume, and object storage metadata are recovery prerequisites for every durable receipt or queue.

### Restart order

1. **Restore and verify durable foundations first:** tenant databases, shared replay store/Redis, gateway spool volume, secrets/configuration, and object storage. Confirm time synchronization before evaluating TTL-bound guards.
2. **Start identity and dependency clients without opening clinical ingress:** OIDC/SAML/Firebase verification, PACS/ABDM/NHCX/payer clients, provider notification credentials, CDS Hooks, Metabase, payment-link dependencies, observability, and storage/scanner clients. Readiness must not imply replay authorization.
3. **Start domain services and queue workers in a paused/frozen state:** verify schema availability and record, per tenant/interface, queue depth, dead/in-flight rows, oldest age, last acknowledged identity, and any available cursor. I09 additionally requires proof of an invoked drain loop; none is present in the current entrypoint.
4. **Apply the signed C-D8 disposition per interface before any backlog replay:** duplicate key, high-water mark, ordering, late-notification permission, SLA/pathway treatment, and owner. If an answer is absent, retain the backlog and mark it `OWNER INPUT`; do not infer a replay policy.
5. **Resume foundational exports before externally consequential notifications where possible:** SIEM/observability first, then PACS/terminology/read-only dependencies, then financial/authorization interfaces. This improves visibility before high-blast clinical replay.
6. **Resume clinical ingress and replay one interface at a time:** laboratory, device-vitals/FHIR Observation, and cold-chain require the strictest late-data gate because current code can create alerts, SLA/task effects, triage changes, or notifications. Validate queue/receipt counts before and after each interface.
7. **Resume outbound patient/staff notifications only after upstream replay disposition is recorded:** otherwise an upstream late event can immediately fan out through I17. Resume outbound HL7/webhooks/NHCX only after downstream duplicate and late-event expectations are confirmed.
8. **Open external senders last and reconcile:** compare sender-side outstanding counts with local receipts/queues and the approved per-interface high-water mark. Interfaces without a high-water mark require owner-directed reconciliation rather than an inferred “start from now” or “replay all” rule.

## 5. Paste-ready C-D8 questions

The following questions are intentionally phrased as decisions. Answers such as “not applicable” still require the named owner to sign them.

### I01 — Laboratory/LIS authenticated HL7 ORU

1. What durable, per-tenant high-water mark identifies the last accepted LIS item, given that the repository currently has only message-control deduplication?
2. Is `(tenant, trusted sender, MSH-10 message control ID)` the approved duplicate identity, and may that identity ever expire?
3. What source timestamp and ordering rule governs results received hours late or out of order?
4. Who owns reconciliation and restart for each LIS sender?
5. May a late result create a critical alert/task or start an SLA using receipt time?
6. May a late result send patient/staff notifications or advance an investigation without separate review?

### I02 — Laboratory/LIS ASTM

1. What durable, per-tenant/per-analyzer high-water mark identifies the last accepted ASTM item?
2. Is the canonical raw-message fingerprint the approved duplicate identity, and may it ever expire?
3. What analyzer timestamp and ordering rule governs hours-late or out-of-order results?
4. Who owns failed-receipt replay and analyzer reconciliation?
5. May a late result create a critical alert or start an SLA using ingestion time?
6. May it notify or advance an investigation without separate review?

### I03 — Legacy inbound HL7 ADT/ORM

1. What durable, per-tenant/source high-water mark replaces the current short-TTL signed-request guard?
2. What domain duplicate key is approved separately for ADT and ORM, and how long must it remain effective?
3. What ordering rule applies to late A01/A02/A03 and ORM messages?
4. Who owns sender reconciliation after an `AE`, HTTP failure, or restart?
5. May late ADT/ORM state trigger downstream notification, SLA, or pathway effects?
6. Is the legacy bridge permitted to restart before those downstream effects are proven?

### I04 — Outbound HL7 feeds

1. What per-subscription acknowledgement/high-water mark is authoritative when the code currently accepts any HTTP 2xx without parsing an HL7 ACK?
2. What source-event/subscription key prevents duplicate enqueue and manual replay of already-sent data?
3. Does downstream order have to match local event order, and how are gaps reconciled?
4. Who owns dead rows and uncertain delivery after a crash between downstream acceptance and local `SENT`?
5. May hours-late ADT/ORU be emitted to a downstream system that can notify, start an SLA, or transition a pathway?
6. What proof from each downstream system is required before backlog release?

### I05 — Generic interface engine

1. Which declared protocols/channels are authorized for production, and what durable high-water mark applies to each?
2. Are the current MSH-10/payload-hash keys the approved duplicate identities for their domains?
3. What execution and ordering semantics apply to `replay_requested` inbound rows?
4. Who owns implementing/operating actual backend delivery and automatic outbound dispatch?
5. For each target domain, may late replay notify, start/settle an SLA, or transition a pathway?
6. Must currently stored-but-not-delivered rows remain frozen until those target-domain answers are signed?

### I06 — PACS/radiology

1. What per-PACS/tenant high-water mark or reconciliation query proves that all studies were linked?
2. Is study UID plus order the approved duplicate/conflict identity?
3. How are late or out-of-order study-link and worklist changes handled?
4. Who owns PACS resend/reconciliation and synchronous metadata failures?
5. May a late study link trigger downstream patient notification, SLA, or care-pathway effects?
6. Is manual review required when an existing order is linked after the outage window?

### I07 — External pharmacy system

1. Does C-D8 confirm that no external pharmacy interface exists for this deployment, or must an out-of-repository interface be inventoried?
2. If one exists, what is its direction/transport, duplicate key, high-water mark, ordering rule, retention, and restart owner?
3. Can late pharmacy data notify a patient, start/settle an SLA, or transition a medication/care pathway?

### I08 — External blood-bank system

1. Does C-D8 confirm that no external blood-bank system interface exists for this deployment, separate from cold-chain sensors?
2. If one exists, what is its direction/transport, duplicate key, high-water mark, ordering rule, retention, and restart owner?
3. Can late blood-bank data notify a patient, start/settle an SLA, or transition a transfusion/care pathway?

### I09 — Device-gateway monitor MLLP

1. What durable per-source/per-tenant high-water mark reconciles the gateway spool with backend receipts?
2. Is `(tenant, device, message control ID)` with a 24-hour TTL sufficient, and what happens to a replay after expiry?
3. What observation-time ordering rule applies to hours-late vitals?
4. Who owns the spool, dead-letter files, drain process, and proof that drain is running?
5. May late vitals calculate/escalate NEWS2, change triage, or create alerts?
6. May any resulting alert notify or start/settle an SLA without separate review?

### I10 — Cold-chain sensors

1. What durable per-sensor/unit high-water mark is authoritative?
2. What reading identity prevents duplicate retries when the current path has no transport guard?
3. What event-time ordering rule prevents an old reading from opening or closing current excursion state?
4. Who owns sender retry and reconciliation because the gateway has no cold-chain spool?
5. May an hours-late reading open/close an excursion, create a task/SLA, or set a blood-bank review flag?
6. May it send staff/patient notifications without separate review?

### I11 — OIDC

1. Is a high-water mark formally not applicable to OIDC browser/token flows, and who signs that decision?
2. What state/nonce/code identity and expiry are authoritative for staff and platform-admin flows?
3. Who owns restart and reconciliation when staff in-memory state is lost or token exchange is uncertain?
4. Can a late successful login unblock a queued clinical action, and must that action be re-authorized?
5. Does C-D8 confirm that OIDC may not directly notify, start/settle an SLA, or transition a care pathway?

### I12 — SAML

1. Is a high-water mark formally not applicable to SAML browser/assertion flows, and who signs that decision?
2. Are the durable provider/kind/request-response-assertion replay keys and current expiry windows the approved duplicate controls?
3. Who owns reconciliation of an in-flight request/assertion across restart?
4. Can a late valid assertion unblock a queued clinical action, and must that action be re-authorized?
5. Does C-D8 confirm that SAML may not directly notify, start/settle an SLA, or transition a care pathway?

### I13 — SCIM

1. What provider/tenant high-water mark identifies the last applied provisioning change?
2. What provider event/version/request key prevents duplicate or stale create/update/deactivate operations?
3. What ordering rule applies to late enable, update, deactivate, and delete calls?
4. Who owns provider reconciliation after timeout/restart?
5. Can a late identity change or session revocation unblock/block a queued clinical action, and must that action be re-authorized?
6. Does C-D8 confirm that SCIM may not directly notify, start/settle an SLA, or transition a care pathway?

### I14 — Firebase identity and App Check

1. Is a high-water mark formally not applicable to Firebase token verification/App Check, and who signs that decision?
2. What Firebase UID/token identity and expiry are authoritative on client retry?
3. Who owns recovery of failed authentication, token revocation, and App Check activation?
4. Is backend App Check enforcement required before restart, given that no enforcement path was found?
5. Can a late successful login unblock a queued clinical action, and must that action be re-authorized?
6. Does C-D8 confirm that Firebase identity/attestation may not directly notify, start/settle an SLA, or transition a care pathway?

### I15 — FHIR/SMART on FHIR

1. What durable per-client/per-tenant high-water mark applies to inbound FHIR writes?
2. What conditional-create or command key prevents duplicate Observation creation?
3. What event-time ordering rule applies to late FHIR Observations and other mutable resources?
4. Who owns client reconciliation after timeout/restart?
5. May late Observation replay calculate/escalate NEWS2, change triage, or create alerts?
6. May it indirectly notify or start/settle an SLA without separate review?

### I16 — ABDM

1. What durable per-consent/request high-water mark proves callback and health-information transfer completeness?
2. Which callbacks require a durable command receipt beyond the shared five-minute replay guard?
3. What ordering rule applies to late grant, deny, revoke, data-request, and transfer events?
4. Who owns recovery of `PROCESSING` requests and failed fire-and-forget outbound notifications?
5. May late consent/data-request events initiate a new collection or push after the outage window?
6. Does C-D8 confirm that ABDM replay may not notify, start/settle a clinical SLA, or transition a care pathway?

### I17 — Notification delivery

1. What durable per-tenant/channel high-water mark proves notification delivery completeness?
2. What source-event/recipient/channel key must prevent duplicate enqueue and concurrent duplicate send?
3. What ordering rule applies to late notifications, especially when a newer state has already been communicated?
4. Who owns uncertain provider acceptance, terminal rows, and the currently unverified email acknowledgement?
5. Which patient/staff notification classes may be released hours late, and which must be suppressed or reviewed?
6. What signed rule links notification release to the upstream event's SLA/pathway disposition?

### I18 — Generic outbound webhooks

1. What per-subscriber/tenant high-water mark proves that all source events were delivered?
2. Is source-event plus subscription the required duplicate key for every enqueue path, including ad hoc delivery?
3. What subscriber ordering contract applies to redelivery after stale-lease recovery?
4. Who owns dead delivery and uncertain downstream acceptance?
5. Which subscribers can cause patient notification, SLA, or pathway changes from late events?
6. What subscriber acknowledgement is required before backlog release?

### I19 — NHCX

1. What per-tenant/environment/api-call high-water mark proves outbound and callback completeness?
2. Which inbound callback identity must remain durable beyond the short signed-request replay window?
3. What ordering rule applies to late preauthorization, claim, and payment-notice callbacks?
4. Who owns stale outbound records, rejected callbacks, and payer reconciliation?
5. May late authorization/claim state unblock clinical or patient-facing workflow?
6. Does C-D8 confirm that payment notice remains manual and cannot retrospectively settle or trigger patient notification?

### I20 — Generic payer adapter

1. Is prior-authorization ID the approved downstream idempotency key, and what provider evidence confirms enforcement?
2. Is a durable local delivery receipt/high-water mark required?
3. Who owns retry after timeout or process restart?
4. Can a late retry/response unblock a clinical workflow, notify a patient, or start/settle an SLA?

### I21 — LiveKit

1. Is high-water-mark/replay policy formally not applicable to real-time media, and who signs that decision?
2. What durable session identity is authoritative after restart?
3. Who owns reconnection and provider outage reconciliation?
4. Does C-D8 confirm that media/provider state cannot transition the local care pathway without an explicit local action?

### I22 — WHO ICD terminology

1. Is high-water-mark/replay policy formally not applicable to synchronous read-only terminology lookup?
2. Who owns provider outage/fallback correctness?
3. Can stale fallback terminology affect any queued clinical decision, and if so what review is required?

### I23 — ClinicalTrials.gov sync

1. What source revision/page cursor is the approved high-water mark?
2. Is NCT ID upsert sufficient for duplicates across a restarted full sync?
3. Who owns incomplete `RUNNING` syncs and reconciliation?
4. May a late catalog change notify a patient or transition a recruitment/care pathway?

### I24 — External AI providers

1. Is high-water-mark/replay policy formally not applicable to each synchronous LLM, embedding, STT, and chatbot provider?
2. What request identity prevents a caller retry from creating conflicting persisted outputs?
3. Who owns in-flight loss and provider fallback after restart?
4. Can a late/caller-retried output notify, start/settle an SLA, or transition a care pathway without fresh human authorization?

### I25 — SIEM export

1. Is the existing per-tenant audit-log ID cursor the approved high-water mark for every SIEM transport?
2. Are tenant/source/source-ID and attempt keys sufficient for duplicate control?
3. What ordering guarantee applies across webhook, syslog, and object-drop retries?
4. Who owns enabling the dispatcher, stale in-flight recovery, and downstream reconciliation?
5. What retention/purge enforcement is required for queued and exported evidence?

### I26 — Observability and security/operations alerting

1. For Sentry, Crashlytics, Prometheus, and webhooks separately, is loss/reset-on-restart approved or is a durable queue/high-water mark required?
2. What event identity replaces restart-volatile metrics/debounce, and what SDK delivery semantics are accepted?
3. Who owns reconciliation when an SDK send, scrape, non-2xx, or network request fails?
4. Can missing/late observability data affect authorization to resume a clinical interface?

### I27 — Object storage and malware scanning

1. Is high-water-mark/replay policy formally not applicable to each synchronous provider operation?
2. What upload/scan request identity is authoritative on caller retry?
3. Who owns reconciliation of provider success with local failure and local-fallback objects?
4. Can late object availability or scan completion release patient-visible content or transition a workflow, and what explicit gate controls that release?

### I28 — CDS Hooks

1. Is high-water-mark/replay policy formally not applicable to synchronous CDS Hooks invocation?
2. What invocation identity, if any, must an EHR send when retrying after timeout?
3. Who owns reconciliation when the EHR does not receive a card response?
4. May an EHR act on a late/retried card, and can that external action notify, start/settle an SLA, or transition a care pathway?

### I29 — Metabase

1. Is high-water-mark/replay policy formally not applicable to the signed embed flow?
2. What dashboard/source freshness evidence is required after an outage?
3. Who owns expired embeds, Metabase availability, and tenant-filter reconciliation?
4. Does C-D8 confirm that a stale/late dashboard cannot itself authorize notification, SLA, or pathway action?

### I30 — UPI/payment-link handoff

1. Does C-D8 confirm that no external payment gateway/callback exists on this baseline?
2. Is link token/transaction reference the approved handoff identity, and is a delivery acknowledgement required?
3. Who owns uncertain direct channel send, manual resend, and manual payment reconciliation after restart?
4. May an hours-late payment-link resend notify a patient?
5. What evidence is required before an operator manually marks a link paid, and can that settlement affect a care pathway or SLA?

## 6. Ranked gaps by late-data blast radius

This ranking is an evidence-based triage order, not a decision to replay or remediate. “Guard gap” means no durable domain-command guard was found or the existing guard does not cover the full recovery window/path. “HWM gap” means no durable, per-tenant/source high-water mark was found.

| Rank | Interface | Gap | Late-data reason for rank |
|---:|---|---|---|
| 1 | I10 cold-chain sensors | No guard; no HWM | Late/duplicate readings can open/close excursion state, create task/SLA and review effects, and queue notifications. |
| 2 | I15 FHIR Observation | No clinical-write guard; no HWM | A retried/late Observation can create duplicate vitals, NEWS2/triage effects, and alerts. |
| 3 | I09 device-gateway MLLP | Gateway guard is restart-volatile; backend guard expires; no HWM; drain invocation unverified | Spooled hours-late vitals can create NEWS2/triage effects and alerts, while automatic recovery is not proven. |
| 4 | I01 laboratory ORU | Strong durable guard; no HWM | Hours-late receipt can advance investigation, create critical task/SLA/alert, and notify. |
| 5 | I02 laboratory ASTM | Strong durable guard; no HWM | Hours-late receipt can advance investigation, create critical alert/SLA, and notify. |
| 6 | I17 notification delivery | Generic enqueue/concurrency guard gap; no HWM | The backlog is itself the patient/staff notification blast radius. |
| 7 | I03 legacy HL7 ADT/ORM | Short-TTL transport guard only; no HWM | Late/duplicate traffic mutates admission or investigation state; downstream blast is unverified. |
| 8 | I13 SCIM | No command guard; no HWM | Late identity state can enable/deactivate users and revoke sessions. |
| 9 | I19 NHCX | Callback guard is short-TTL; no HWM | Late callbacks mutate authorization/claim state; clinical knock-on effects are unverified. |
| 10 | I04 outbound HL7 | No source enqueue guard; no HWM | Duplicate/late messages can drive unknown downstream clinical effects. |
| 11 | I18 generic webhooks | Ad hoc enqueue guard gap; no HWM | Subscriber late-data behavior is outside repository control and unverified. |
| 12 | I05 interface engine | Partial format dedupe; no HWM | Intended downstream blast depends on target domain; actual delivery/replay execution is incomplete. |
| 13 | I16 ABDM | Partial/short-TTL guard; no HWM | Late work can mutate consent/export state; in-process requests can be stranded. |
| 14 | I06 PACS/radiology | No transport guard; no HWM | Late links update imaging state; downstream clinical effects are unverified. |
| 15 | I30 UPI/payment-link handoff | No external delivery guard/receipt; no HWM | A delayed manual resend can notify a patient; settlement remains an authenticated manual action. |
| 16 | I23 ClinicalTrials.gov sync | Upsert only; no source cursor/HWM | Late refresh changes catalog data; no direct C-D8 clinical effect found. |
| 17 | I20 payer adapter | Downstream idempotency header only; no local receipt/HWM | Administrative effect; no asynchronous clinical effect found. |
| 18 | I11 OIDC | No durable callback receipt; no HWM | Login/access only; late clinical effects not found. |
| 19 | I14 Firebase identity/App Check | No transport receipt; no HWM; backend App Check enforcement not found | Login/access/attestation only; late clinical effects not found. |
| 20 | I12 SAML | Durable expiring replay guard; no HWM | Login/access only; assertion validity constrains late use. |
| 21 | I24 external AI providers | No request receipt/HWM | Synchronous calls; no delayed callback path found. |
| 22 | I27 storage/scanning | No command receipt/HWM | Content availability/security only in visible paths. |
| 23 | I26 observability/security alerting | No application guard/HWM/durable queue | Lost or reset observability; no direct clinical transition. |
| 24 | I21 LiveKit | No event guard/HWM; applicability undecided | Real-time media only; no provider-driven local transition found. |
| 25 | I22 WHO ICD | No event guard/HWM; applicability undecided | Synchronous read-only lookup; no delayed delivery path. |
| 26 | I28 CDS Hooks | No invocation receipt/HWM; applicability undecided | Synchronous cards only; external EHR action is unverified. |
| 27 | I29 Metabase | No event guard/HWM; source freshness unverified | Read-only analytics display; no direct clinical transition. |

Not ranked: I25 SIEM has durable event identity and the only explicit per-tenant high-water mark in this census. I07 and I08 have no repository-implemented external connector to rank.

## 7. Coverage statement

This census searched backend and client runtime routes/services, schedulers, migrations, provider SDK initialization, the device-gateway application, and deployment descriptors for external network/provider, protocol, callback, queue, replay, and cursor behavior. Every repository-implemented external integration found is enumerated in I01–I30, including conditional and currently incomplete paths. Laboratory/LIS (ORU and ASTM), legacy and outbound HL7, the generic interface engine, PACS/radiology, identity/SSO (OIDC, SAML, SCIM, and Firebase), FHIR/SMART and CDS Hooks, ABDM, notifications, device gateway, cold chain, NHCX/payer, teleconsult media, terminology, trial sync, AI providers, SIEM/Sentry/Crashlytics/Prometheus/security webhooks, storage/scanning, Metabase, and UPI/payment-link handoff are covered. Pharmacy and blood bank are explicitly recorded as having internal workflows but no external system connector found. No integration found by the census was skipped.
