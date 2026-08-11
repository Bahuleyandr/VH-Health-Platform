# VH Health Platform Full-Repository Audit — 2026-08-11

> Point-in-time evidence snapshot. The live remediation queue is
> [`docs/ROADMAP.md`](../../ROADMAP.md). Do not use this file as a second
> tracker.

## Audit identity and limits

- Full-read audit baseline: `a64a5dd80122637849d9cb0c80e28a4966e19341`.
- Reconciled against GitHub `main`: `9bcdb6563a7f585c0cdc2daf5bf6f0f56278319b`.
- Reconciliation date: 2026-08-11.
- Scope: backend, database/migrations, schedulers and recovery paths, admin,
  staff, patient, shared Flutter packages, device gateway, infrastructure,
  CI/CD, documentation, dead/unwired code, and upgrade posture.
- Method: static source/contract tracing plus targeted analyzers and tests.
  This was not a live-cluster, live-database, retained-log, secret, or external
  provider audit. Checked-in production hazards are confirmed source defects;
  whether they have already affected live data must be established separately.

## Brutal rating

| Area | Rating | Reason |
| --- | ---: | --- |
| Clinical/product breadth | 8.5/10 | Exceptionally broad hospital workflows and strong domain ambition. |
| Security and tenant design | 6.0/10 | Good RLS, audit, and step-up foundations, but several callers bypass or fail open around them. |
| Data and workflow correctness | 5.0/10 | Strong transactional work exists beside retry, cursor, scheduler, and fake-success gaps. |
| Client/backend contract integrity | 4.5/10 | Multiple active screens cannot satisfy their backend contracts or discard server failure. |
| Operations and deployment integrity | 3.5/10 | Production seeding, runtime migration-role contradiction, and placeholder image state are release blockers. |
| Maintainability | 5.5/10 | Large duplicated transports/providers and a meaningful amount of held or unwired code increase drift. |
| Test and CI posture | 7.0/10 | Broad gates exist, but several clinically important end-to-end contracts are absent. |
| **Overall monorepo** | **5.7/10** | Strong platform potential, but too many trust-boundary and wiring defects for its current size. |
| **Production readiness** | **3.0/10** | Not fit for unrestricted real-PHI expansion until P0/P1 is closed and live impact is checked. |

The repository is not a hollow prototype. It contains substantial, thoughtful
clinical and operational engineering. The problem is uneven integration: a
number of impressive subsystems are locally correct but connected through
unsafe defaults, stale contracts, duplicated transports, or fail-open wrappers.

## Status vocabulary

- `OPEN`: validated on the reconciliation SHA and not covered by a merged fix.
- `PARTIAL`: one part landed, but the end-to-end invariant is still broken.
- `MERGED`: the audit claim was fixed on `main`; retained for provenance.
- `IN REVIEW`: work exists off `main`; it is not counted as fixed.
- `HELD`: deliberately inactive, but must be fixed before activation.
- `OPERATOR`: code alone cannot close the live-state consequence.

## P0 and High findings

| ID | Status | Finding and evidence | Required closure |
| --- | --- | --- | --- |
| AUG11-C1 | **OPEN / OPERATOR** | The Argo PreSync Job runs `node scripts/ci-setup-db.mjs` in production without `--skip-seeds`; that script imports the test staff seed. [`migration-job.yaml`](../../../infra/kubernetes/apps/backend/migration-job.yaml), [`ci-setup-db.mjs`](../../../apps/backend/scripts/ci-setup-db.mjs), and [`seed-test-staff-accounts.mjs`](../../../apps/backend/scripts/seed-test-staff-accounts.mjs) show a default `test1234` password and active `EMP-1007` `SUPER_ADMIN`, with insert/reactivation and credential logging. | Make the manifest and script independently fail closed in production; disable matching live identities, revoke sessions, rotate exposed credentials, and inspect retained Job logs. Prove a production-mode scratch migration creates no staff/users/doctors. |
| AUG11-H1 | **OPEN / IN REVIEW DEPENDENCY** | Runtime workers call `runMigrations()` and always issue `CREATE TABLE IF NOT EXISTS _migrations`, while the declared production runtime role is NOCREATE. [`www.js`](../../../apps/backend/src/bin/www.js), [`runMigrations.js`](../../../apps/backend/src/utils/migrations/runMigrations.js), migration 578, and the CNPG role manifest contradict one another. A separate migration-safety branch exists, but its reviewed diff does not close this runtime DDL invariant. | Only the owner PreSync Job may apply/create migration state. Runtime startup must read and verify the exact migration tip/checksums without DDL. Verify the live role and grants, then boot six NOCREATE workers after PreSync. |
| AUG11-H2 | **OPEN** | `/api/v1/search` accepts every broad `isStaff` role, including non-clinical roles, and returns tenant-wide appointment reason/notes outside the curated patient-lookup RBAC and PHI audit path. [`searchRoutes.js`](../../../apps/backend/src/routes/searchRoutes.js), [`searchService.js`](../../../apps/backend/src/utils/search/searchService.js), and [`roleHelpers.js`](../../../apps/backend/src/utils/roleHelpers.js). | Define purpose-specific search scopes, exclude non-clinical roles from clinical results, minimize fields, and route patient-result access through PHI logging and care-team policy. |
| AUG11-H3 | **OPEN** | Care-team enforcement fails open when a route uses a generic `:id` or omits patient context. Oncology list and diagnosis staging can resolve by tenant/resource ID while the parent guard resolves no patient and allows the request. [`phiAccessMiddleware.js`](../../../apps/backend/src/middleware/phiAccessMiddleware.js), [`accessDecisionService.js`](../../../apps/backend/src/services/security/accessDecisionService.js), [`oncologyRoutes.js`](../../../apps/backend/src/routes/oncology/oncologyRoutes.js), and [`oncologyCompletionService.js`](../../../apps/backend/src/services/oncology/oncologyCompletionService.js). | Require a resolved patient for every patient-owned resource, add resource-to-patient resolvers, reject missing context under enforcement, and log the resolved patient. Test list, resource-ID write, shadow, and break-glass cases. |
| AUG11-H4 | **OPEN** | Patient profile completion posts to a JWT-protected endpoint using an API-key-only raw HTTP client. New users cannot complete the profile contract. [`backend_api_service.dart`](../../../apps/patient/lib/core/services/backend_api_service.dart), [`profile_setup_screen.dart`](../../../apps/patient/lib/features/profile/screens/profile_setup_screen.dart), and [`firebaseAuthRoutes.js`](../../../apps/backend/src/routes/auth/firebaseAuthRoutes.js). | Use the authenticated shared client and add a new-user end-to-end contract test that reaches a successful profile completion. |
| AUG11-H5 | **OPEN** | Android health sync labels vitals `health_connect`, but the backend vitals endpoint rejects that source. Partial failures still advance a sentinel cursor; background work reports success; repeated iOS reads can insert duplicate vitals. [`health_sync_service.dart`](../../../apps/patient/lib/core/services/health_sync_service.dart) and [`patientHealthController.js`](../../../apps/backend/src/controllers/health/patientHealthController.js). | Align source enums, track independent durable cursors per stream, retry partial failures, propagate background failure, and make vital ingestion idempotent by source/sample timestamp. |
| AUG11-H6 | **PARTIAL** | PR #844 merged the backend Code Blue token-source correction and tenant-explicit emitter. The staff app still constructs `NotificationProvider` without calling `initialize()`, so FCM registration/listeners are not proven wired through the provider lifecycle. [`main.dart`](../../../apps/staff/lib/main.dart), [`notification_provider.dart`](../../../apps/staff/lib/core/providers/notification_provider.dart), and [`realtimeEmitter.js`](../../../apps/backend/src/utils/websocket/realtimeEmitter.js). | Initialize once per authenticated session, tear down on logout, test FCM registration and Code Blue receipt end to end, and retain tenant-explicit fan-out. |
| AUG11-H7 | **OPEN** | The routed staff blood-bank request screen sends `bloodType`, `reason`, and `patientName`; the backend requires `patient_uid`, `blood_group`, `component`, and `clinical_indication`. Every normal submission should fail validation. [`blood_bank_screen.dart`](../../../apps/staff/lib/features/bloodbank/screens/blood_bank_screen.dart), [`sharedValidators.js`](../../../apps/backend/src/validators/sharedValidators.js), and [`bloodBankRoutes.js`](../../../apps/backend/src/routes/bloodbank/bloodBankRoutes.js). | Replace the map with a typed DTO and patient/component selection. Add a widget-to-API contract test proving a 201 response. |
| AUG11-H8 | **OPEN** | Staff logout clears only selected providers. App-lifetime WebSocket and notification maps can retain account A's PHI and merge it into account B's screen, especially after a failed refresh. [`logout_flow.dart`](../../../apps/staff/lib/core/widgets/logout_flow.dart), [`websocket_provider.dart`](../../../apps/staff/lib/core/providers/websocket_provider.dart), and [`notification_provider.dart`](../../../apps/staff/lib/core/providers/notification_provider.dart). | Introduce one authenticated-session reset contract that clears/cancels every provider before navigation. Test A event, logout, B login, failed refresh, and zero retained A identifiers. |
| AUG11-H9 | **OPEN** | Clinical-alert acknowledgement is optimistic: local state is marked read before I/O, the service discards the `ApiResponse`, and errors are swallowed. Staff can believe an alert is acknowledged when the backend rejected it. [`notification_provider.dart`](../../../apps/staff/lib/core/providers/notification_provider.dart) and [`hr_api_service.dart`](../../../apps/staff/lib/core/services/hr_api_service.dart). | Require 2xx before mutation, preserve the actionable alert on 409/500/timeout, expose a persistent failure state, and add retry coverage. |
| AUG11-H10 | **OPEN** | Staff message POSTs are automatically retried with a stable idempotency key, but `/messaging/send` has no idempotency middleware and inserts before a later notification failure can return 500. A retry can create duplicate messages. [`messaging_api_service.dart`](../../../apps/staff/lib/core/services/messaging_api_service.dart), [`messagingRoutes.js`](../../../apps/backend/src/routes/messaging/messagingRoutes.js), and [`messagingService.js`](../../../apps/backend/src/services/messaging/messagingService.js). | Enforce tenant/user-scoped idempotency and return the original receipt. Fault-test commit followed by notification/response failure and retry. |
| AUG11-H11 | **OPEN** | Recovery enqueue commits separately from processing. Exact retries of a pending I01/I02/I09/FHIR item can return duplicate/pending without reclaiming it, and no generic non-test drain/reaper exists. A crash after enqueue can strand the head of an ordered partition indefinitely. [`externalInterfaceRecoveryService.js`](../../../apps/backend/src/services/integrations/externalInterfaceRecoveryService.js), [`deviceVitalsService.js`](../../../apps/backend/src/services/emr/deviceVitalsService.js), and [`fhirRoutes.js`](../../../apps/backend/src/routes/fhir/fhirRoutes.js). | Add a fenced durable worker/reaper or stale-lease takeover for every interface. Kill after every transaction boundary and prove exactly one domain effect plus forward cursor progress. |
| AUG11-H12 | **PARTIAL** | PR #841 fixed the shadowed user `/search` and `/system-info` routes. The AI knowledge-base `/retrieval-logs` static route remains vulnerable to an earlier parameter route and needs a complete static-before-parameter sweep. | Reorder or constrain the remaining routers and add route-reachability tests for every static/parameter sibling. Regenerate and verify OpenAPI. |
| AUG11-H13 | **OPEN / HELD** | Production app manifests still contain fail-closed/placeholder image state, including Staff Web's all-zero digest. This correctly prevents accidental activation but means the checked-in delivery path is not release-complete. [`apps/kustomization.yaml`](../../../infra/kubernetes/apps/kustomization.yaml) and the activation tracker. | Resolve signed release digests through the approved release path, verify provenance, and keep each held surface dark until its own activation gates pass. |
| AUG11-H14 | **OPEN** | The admin pathology surface is not backed by one authoritative typed workflow; proxy/fallback behavior can display success or empty state without proving the underlying laboratory action. | Trace each pathology action to its canonical backend route, delete proxy/stub fallbacks, and add browser-to-database contract coverage for success and failure. |

## Medium findings and activation blockers

| ID | Status | Finding | Required closure |
| --- | --- | --- | --- |
| AUG11-M1 | **OPEN** | `/devices/my-devices` converts arbitrary database failures into HTTP 200 with an empty device list, hiding compromised-device visibility and revocation failures. | Return an explicit 5xx except for a narrowly proven optional-table compatibility case; test permission, connectivity, and syntax failures. |
| AUG11-M2 | **OPEN / IN REVIEW** | Admin audit/system-log queries and system-log export convert arbitrary query failures into authoritative empty success/CSV. A separate fake-success branch exists off `main`; it is not counted as fixed. | Preserve absence-vs-failure semantics and test database failure at every audited endpoint. |
| AUG11-M3 | **OPEN** | The legacy daily appointment cron erases tenant fan-out with nested super-admin context, calls the push sender with the wrong signature, uses lowercase `cancelled`, logs success on zero sends, and inserts incomplete notification fields. | Remove it in favor of the canonical hourly path or make it tenant-explicit, idempotent, result-gated, and schema-correct. Test two tenants and all sender outcomes. |
| AUG11-M4 | **OPEN / MULTI-TENANT BLOCKER** | Monthly payroll and annual salary-review crons run without a feature gate, enumerate globally under bypass, and omit `tenant_id` on financial writes that default to the platform tenant. | Feature-gate until explicit tenant fan-out, tenant-scoped transactions/writes, composite tenant FKs, and two-tenant retry tests are present. |
| AUG11-M5 | **OPEN** | Patient walk/challenge sessions are held only in memory; disposal does not reconcile, and the next start can close the previous backend session without metrics. | Persist and reconcile the active session on lifecycle transitions; make server close/restart idempotent and test process death. |
| AUG11-M6 | **OPEN** | The biometric splash path treats a stored phone as session state and can route to home without first proving an access/refresh token matrix. Backend APIs still fail closed, so this is a UI/auth-state invariant rather than a backend bypass. | Make token/session state authoritative and test stale phone, missing access, missing refresh, expired refresh, and partial teardown. |
| AUG11-M7 | **OPEN** | Firebase login/profile setup uses raw `package:http`, bypassing the shared SPKI-pinned transport and App Check telemetry path. | Move auth bootstrap to the shared unauthenticated/authenticated transports and test pin/App Check headers without weakening bootstrap recovery. |
| AUG11-M8 | **OPEN** | Patient lock-screen notification bodies can include patient/test/doctor/time/token detail, and the client renders backend title/body verbatim. | Send privacy-minimized lock-screen copy and reveal PHI only after authenticated in-app navigation. |
| AUG11-M9 | **OPEN** | WebSocket notifications are queued in `WebSocketProvider` but never merged into `NotificationProvider`; badges refresh mainly on init/resume. | Choose one notification state owner and prove live event, unread badge, read/ack, reconnect, and logout behavior. |
| AUG11-M10 | **HELD** | Staff Web persists access/refresh tokens through the Web secure-storage implementation's localStorage-backed path. The checked-in deployment is held, so this is an activation blocker, not a current production exposure. | Use an HttpOnly/BFF or truly ephemeral token design before activation; add XSS/storage and logout tests. |
| AUG11-M11 | **HELD** | Staff Web starts the native SQLite offline queue even though Web does not support that implementation. | Provide an IndexedDB implementation or an explicit Web-disabled capability path that never claims offline durability. Test browser startup, logout, enqueue, and replay. |
| AUG11-M12 | **HELD** | Device-gateway readiness uses `.every()` and is true with zero enrollments. Legacy routing accepts unmatched MSH-derived sources; per-source spools and uncapped dead letters do not provide a global disk bound. | Require at least one production enrollment, keep legacy dev-only, narrow ingress, and enforce global cardinality/byte quotas before activation. |

## Dead, empty, duplicated, or left-unwired code

The audit did not find a monorepo full of empty placeholder files. The more
dangerous form of dead code here is production-looking code that is either held,
uninitialized, shadowed, duplicated, or incapable of satisfying its peer
contract:

1. Notification state exists in multiple providers and transport paths; one
   queue is not consumed and logout does not reset all owners.
2. Staff Web and the device gateway are substantial release-capable surfaces
   that remain deliberately held. They must not be presented as production
   capability until their activation blockers close.
3. The legacy daily appointment-reminder path overlaps a better hourly path and
   is currently broken. Delete it unless it has a distinct, tested purpose.
4. Raw Flutter HTTP clients duplicate the shared pinned/authenticated client and
   drift in headers, refresh, idempotency, and failure semantics.
5. Broad catch-and-return-empty wrappers turn executable failure paths into
   false success. These are not harmless fallbacks in clinical or audit views.
6. Static routes placed after parameter routes are executable source that is
   unreachable at runtime. The merged user fix should become a repository-wide
   route-order invariant.
7. Point-in-time roadmap text still claimed prior audit completion while new P0
   and High findings were open; current work must live in the roadmap, not in a
   growing set of competing trackers.

## What is already strong

- Tenant RLS, step-up authorization, audit-event concepts, idempotency
  primitives, outbox patterns, and recovery fingerprints are serious controls.
- The Argo PreSync owner-only migration architecture is the right direction;
  runtime workers should verify it, not duplicate it.
- The repository has unusually broad contract, migration, Flutter, and
  canonical CI gates.
- Several safety paths fail closed, including held delivery surfaces and I03's
  stale-lease recovery behavior.
- Recent PRs fixed real route reachability, CI merge-gate bypass, and the Code
  Blue backend token contract. The remediation process is capable of working
  when each invariant gets an end-to-end test.

## Upgrade path

### Stage 0 — contain and establish truth

1. Stop production seeding at both manifest and script layers.
2. Inspect live accounts, sessions, migration Job logs, runtime DB role/grants,
   deployed digests, and current tenant count.
3. Keep Staff Web, device gateway, multi-tenant payroll, and other held surfaces
   inactive.

### Stage 1 — close trust and clinical correctness

1. Make patient context mandatory for patient-owned resources.
2. Replace broad role predicates with purpose-specific policy and PHI logging.
3. Make every client mutation server-result-authoritative and idempotent.
4. Close blood-bank, profile-completion, health-sync, Code Blue, logout, alert
   acknowledgement, and messaging contract gaps.
5. Add a durable recovery drain and remove fake-success responses.

### Stage 2 — simplify the platform

1. One Flutter HTTP/auth transport, one notification state owner per app, one
   appointment reminder engine, and one typed contract per workflow.
2. Delete shadowed, superseded, and held-without-owner code after provenance and
   activation decisions are recorded.
3. Split oversized routers/services only where it creates enforceable policy or
   transaction boundaries; avoid cosmetic rewrites.

### Stage 3 — harden delivery and observability

1. Owner-only migrations with checksum verification by runtime roles.
2. Signed, non-placeholder image digests and activation-specific readiness.
3. Alerts for pending recovery age, failed acknowledgements, notification
   delivery, health-sync partial failure, scheduler per-tenant counts, and audit
   query failures.
4. Fault-injection and two-tenant suites become release gates.

### Stage 4 — dependency upgrades

Upgrade only after Stages 0–2 stabilize the contracts. Use one ecosystem lane
at a time: Node/runtime and database tooling, backend libraries, Flutter/Dart
and plugins, admin/Next.js, then infrastructure controllers. For each lane:
pin the toolchain, read breaking changes, regenerate locks/contracts, run the
full local gate, canary in a non-PHI environment, and retain a rollback digest.
Do not combine clinical behavior fixes with framework major upgrades.

## Definition of done

A finding is closed only when its invariant is represented by a regression
test, the focused and canonical gates pass, the change is merged, the roadmap
links the evidence, and any live-state consequence has an operator receipt.
An off-main branch, a successful local happy path, or an empty-error fallback is
not closure.
