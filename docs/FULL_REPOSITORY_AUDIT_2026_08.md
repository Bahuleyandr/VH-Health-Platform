# VH Health Full-Repository Audit — 2026-08-13

**Status:** OPEN — validated remediation is in progress.  This document is a
finding and evidence ledger, not deployment authority.

**Audited source:** dependency-upgrade content commit
`8a692269f71b0666182fa82a5b7582119b9e2539`.  The published draft PR head is
the no-source-change full-CI marker
`614216b28ffbf8f0270c4d88178cceae604ac091`.

## Executive verdict

VH Health is an unusually broad and ambitious healthcare monorepo with strong
domain coverage, a large automated test corpus, explicit tenant/RLS controls,
and several well-designed durable workflow primitives.  It is not, however, a
production-ready integrated platform at this snapshot.  Too many user-visible
flows are only partially wired, multiple background jobs report success before
delivery, several clinical interoperability writes bypass the canonical event
and audit transaction, and the committed production platform is both
deliberately held and unable to pull several active infrastructure images.

**Overall monorepo rating: 4.8 / 10.**

That rating is intentionally harsher than a code-style or unit-test score.  It
answers: “Can this repository, as committed, operate safely as one healthcare
platform?”  The answer is no.  A green build currently proves that many units
compile and pass their tests; it does not prove that the client/server
contracts, delivery receipts, deployment pins, failover design, or canonical
clinical write paths work together.

| Dimension | Rating | Audit conclusion |
| --- | ---: | --- |
| Domain architecture and breadth | 8.0 | Deep feature coverage and useful shared primitives. |
| Automated test volume | 7.0 | Large suites pass, but important gates are narrow or false-green. |
| Authentication, tenant, and privacy posture | 5.5 | Strong backend intent; several client/session gaps and shadow-mode assumptions remain. |
| Clinical correctness and durable delivery | 4.0 | Reminder, notification, payroll, and canonical-write defects are active. |
| Mobile and desktop integration | 4.5 | Core screens exist, but realtime, device/PIN, transport, and cache lifecycles drift. |
| Admin/operator truthfulness | 4.5 | Compiles cleanly; role, session, refresh, health, and composer contracts are broken. |
| Interoperability readiness | 3.0 | Several advertised paths are receipt-only, manual-only, no-op, or split across stores. |
| Infrastructure and deployability | 2.0 | Intentionally held; active third-party pins and HA/runbook contracts are also invalid. |
| Maintainability/dead-code control | 5.0 | Clear structure in places, but significant retired, duplicate, placeholder, and unreachable surface. |

## Audit method and limits

Eight independent read-only lanes reviewed backend API/auth, data and scheduled
jobs, Admin, Patient, Staff, interoperability, infrastructure/CI, and horizontal
dead/unwired code.  Findings below were accepted only after checking the exact
source path, call site or route registration, current activation posture, and
available tests at the audited commit.

The dependency-upgrade validation also completed clean installs, zero-vulnerability
npm audits, backend static/OpenAPI/database gates, 49 backend coverage suites
(1,151 tests), 94 Admin suites (1,130 tests), all Flutter analysis/tests,
Android debug builds, web release builds, and clean Patient and Staff Windows
builds.  Hosted full CI is the authoritative Ubuntu coverage run.

Codex Security Deep Scan could not create its managed read-only worker because
the desktop session did not provide the plugin a managed filesystem permission
profile.  No Deep Scan result is claimed.  The manual multi-lane audit
continued independently.  There was no live hospital cluster access, no
deployment, no production mutation, and no claim that repository configuration
equals live external tenant settings.

## Release blockers and active high-severity findings

`OPEN` means source-proven and not yet remediated in this ledger. `IN PROGRESS`
means an isolated remediation lane is running but has not yet been integrated
and revalidated. `HELD` is an intentional activation stop, not permission to
delete or bypass the control.

| ID | Status | Finding and evidence | Required outcome |
| --- | --- | --- | --- |
| INF-001 | IN PROGRESS | Eight active platform `tag@digest` pins fail live registry manifest verification: Redis/exporter (`infra/kubernetes/base/redis/redis-sentinel.yaml:250`, `:393`), BusyBox/Vault (`infra/kubernetes/base/vault/vault.yaml:220`, `:249`), step-ca (`infra/kubernetes/base/step-ca/step-ca.yaml:105`), Sealed Secrets (`infra/kubernetes/base/sealed-secrets/sealed-secrets.yaml:142`), cloudflared (`infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml:158`), and kured (`infra/kubernetes/base/kured/kured.yaml:141`). The production overlay imports them, while infra CI checks syntax rather than registry existence. | Resolve reviewed multi-architecture digests, record supply-chain evidence, and make CI verify every rendered active image against its registry. |
| INF-002 | HELD | Production is intentionally not activatable: platform-owned app digests are zero placeholders (`infra/kubernetes/apps/kustomization.yaml:21-52`), admin allowlists are empty (`:54-96`), `CF_R2_URL` is empty (`infra/kubernetes/apps/backend/configmap.yaml:43-53`), and real SealedSecrets are absent. | Preserve a machine-readable HELD result until reviewed digests, secrets, R2, allowlists, and operator sign-off exist. Never reinterpret a green render as deployable. |
| JOB-001 | IN PROGRESS | Appointment reminder windows compare timestamp bounds with `appointment_date` only and ignore the separately stored `appointment_time` (`apps/backend/prisma/schema.prisma:885-886`; `apps/backend/src/utils/notifications/appointmentReminderJob.js:19-57`). The hourly job is live (`apps/backend/src/utils/scheduler.js:710-714`). | Build one validated tenant-timezone appointment timestamp and use half-open 1-hour/24-hour windows, with real PostgreSQL boundary tests. |
| JOB-002 | IN PROGRESS | A queued SMS sets reminder-sent state (`appointmentReminderJob.js:60-103`, `:160-172`) although the delivery worker deterministically rejects SMS as `sms_gateway_not_configured` (`notificationOutboxDelivery.js:201-208`). | Separate queue acceptance from provider acknowledgement and retain rejected/missing delivery as a retry/operator obligation. |
| JOB-003 | IN PROGRESS | Scheduled notifications are claimed, push failures are swallowed, and every row is unconditionally marked `sent` (`appointmentReminderJob.js:193-224`). | Use a lease and durable receipt state; only provider acknowledgement may transition to sent. Model missing recipient, retry, ambiguous, and terminal rejection explicitly. |
| FIN-001 | OPEN | Manual payroll is a non-transactional find/update/create plus independent payslip, advance, deduction, and arrears mutations (`apps/backend/src/controllers/staff/payrollController.js:286-432`). The optional cron calculates/saves but omits the same advance/arrears effects (`apps/backend/src/utils/payrollSchedulerJobs.js:66-108`). | One shared tenant-scoped, per-staff transaction with locking/CAS, idempotent deduction identity, exact arrears closure, and manual/cron parity before enabling the cron. |
| PAT-001 | IN PROGRESS | Patient subscribes to legacy appointment/queue channels denied to PATIENT (`apps/patient/lib/core/services/websocket_service.dart:77-80`; `apps/backend/src/utils/websocket/channelAuth.js:44-47`), while direct delivery uses numeric `patient_id` instead of the JWT UUID (`appointmentStatusController.js:119-122`; `wsServer.js:225-230`). The legacy client reports connected before acknowledgement and suppresses polling (`dashboard_provider.dart:276-289`). | Consolidate on the acknowledged shared realtime client and tenant/patient-UID personal channel; retain polling until server subscription acknowledgement. |
| PAT-002 | IN PROGRESS | Patient cache AES key is memoized indefinitely (`apps/patient/lib/core/offline/api_cache_manager.dart:31-51`); logout clears secure storage first and cache cleanup never clears the in-memory key (`logout_service.dart:176-187`; `api_cache_manager.dart:318-334`). Re-login can write PHI with an orphaned key. | Single-flight key initialization plus generation-safe, zeroizing session teardown, proven across logout, re-login, restart, and concurrent first use. |
| STF-001 | IN PROGRESS | App-scoped Staff `WebSocketProvider` caches notifications, appointments, and queue state (`apps/staff/lib/main.dart:720-723`; `websocket_provider.dart:14-25`), but logout never stops/clears it and queue state has no clear path (`logout_flow.dart:24-60`; `websocket_provider.dart:92-100`). | End the authenticated generation on every logout path, cancel subscriptions, clear all PHI caches, and reject late prior-account events. |
| STF-002 | IN PROGRESS | Every `StaffScaffold` mounts a Code Blue listener (`staff_scaffold.dart:38-41`); pushed routes retain prior listeners and each independently emits a notification/dialog (`code_blue_listener.dart:24-49`, `:121-129`). | Mount one session-scoped listener above routing, deduplicate by event ID/generation, and prove one alert surface after multi-route navigation. |
| STF-003 | OPEN | Active Oncology reads and toxicity writes use raw `package:http` (`apps/staff/lib/features/oncology/screens/oncology_screen.dart:1-6`, `:162-251`) rather than the shared pinned/App-Check/refresh transport. | Move the adapter behind `ApiClient`/`VHHttpClient`; use an idempotency key for the toxicity write and add transport-contract tests. |
| STF-004 | IN PROGRESS | Trusted-device/PIN/biometric onboarding is contract-incompatible: login never stores the issued device token (`apps/staff/lib/core/services/auth_service.dart:101-180`), PIN setup omits the required token (`settings_screen.dart:68-72`; backend validator `authValidator.js:341-350`), and device removal calls nonexistent `StaffAuthService.removeDevice` (`staffAuthController.js:216-225`). Verify-device and legacy attendance handlers also call missing methods. | Implement password-authenticated registration, securely bind/persist the installation token, wire PIN/biometric flows, and add tenant/owner-bound device removal that revokes associated sessions. Delegate or remove orphan routes. |
| ADM-001 | IN PROGRESS | Admin route policy recognizes 69 roles but cached-profile schema accepts only 37 (`apps/admin/src/lib/routePolicy.ts:28-102`; `schemas.ts:73-123`). Invalid cache returns without probing a valid cookie session, and null role defaults to `AdminDashboard` (`AuthContext.tsx:89-110`; `DashboardRouter.tsx:271-287`). | Generate role/cache/router mapping from one graph; probe the server when a cookie may exist; make unknown/null roles least-privileged. |
| ADM-002 | IN PROGRESS | Idle timeout calls only local `/api/logout` (`apps/admin/src/hooks/useIdleTimeout.ts:21-27`), which expires cookies but does not revoke the backend session (`app/api/logout/route.ts:8-31`). | Reuse the canonical backend-revoking logout flow, always clear local state, and surface/audit revocation failure. |
| ADM-003 | IN PROGRESS | Canonical Admin `requestJSON` has single-flight refresh, but the dominant `fetchAdminAPI` helper bypasses it and throws every 401 (`apps/admin/src/lib/api/core.ts:84-205`, `:291-329`); it is used across more than 150 files. | Put both APIs over one refresh/retry engine with mutation/idempotency safeguards and concurrency tests. |
| ADM-004 | IN PROGRESS | Dashboard secondary health failures become `null`/zero and null system health renders the text `healthy` (`apps/admin/src/app/(with-auth)/dashboard/hooks/useDashboardData.ts:91-140`; `components/SystemHealthPanel.tsx:74-92`). | Explicit unknown/unavailable/stale states; last-known-good data is separate and timestamped; absence can never render healthy. |
| ADM-005 | IN PROGRESS | Notification composer sends `normal`/`high`, `target`/`targetValue`, and `scheduledAt` (`NotificationComposer.tsx:64-104`) while backend validation accepts uppercase `HIGH|MEDIUM|LOW`, `target_roles|target_departments|user_ids|criteria`, and `scheduled_for` (`notificationValidator.js:66-87`). Normal sends fail validation; targeted and scheduled semantics are unwired. | Share a typed request contract, map each target explicitly, use canonical fields/enums, and prove immediate/scheduled/all/role/department/user behavior. |
| API-001 | OPEN | Anonymous `/api/v1/auth/firebase/health` is mounted before API-key/JWT enforcement and returns global Firebase/adoption/device statistics while fanning one query per tenant (`apps/backend/src/app.js:726-736`; `firebaseAuthService.js:568-608`). | Public endpoint returns constant liveness only; privileged cached metrics use explicit authorization and one grouped query. |
| API-002 | OPEN | Progress-note alias omits `tenant_id`, unlike the canonical route (`apps/backend/src/routes/clinical/clinicalRoutes.js:224-250`; `routes/emr/clinicalNotesRoutes.js:107-130`). It silently defaults today and fails/mis-scopes during multi-tenant cutover. | Pass `req.tenantId` through the alias and test non-default tenants with default fallback disabled across detail/timeline/audit. |
| SEC-001 | OPEN / activation-gated | Governed care-team authorization defaults to non-blocking `shadow` and unexpected guard errors fail open (`apps/backend/src/services/security/careTeamEnforcement.js:15-112`; `middleware/phiAccessMiddleware.js:83-275`). No committed production override proves every tenant is in `enforce`. | Inventory live tenant settings, prove care-team completeness and break-glass, activate enforce tenant-by-tenant, then gate new production tenants against shadow defaults. |
| INT-001 | IN PROGRESS | Interface-engine `backend.interop.preview` records a receipt with `network_call_performed: false` but marks the message delivered (`apps/backend/src/services/interfaceEngine/interfaceEngineService.js:810-840`; `protocolAdapters/hl7v2Adapter.js:33-71`). | Preview is validation-only and can never equal clinical delivery; production activation requires a concrete canonical adapter. |
| INT-002 | IN PROGRESS | Generic interface outbound queues messages but has no autonomous worker; dispatch is reachable only through Admin “dispatch now” (`interfaceEngineService.js:963-1081`; `routes/admin/interfaceEngineRoutes.js:206-215`). | Tenant-fanned, locked, leased dispatcher with bounded claims, backpressure, metrics, crash recovery, and concurrency tests. |
| INT-003 | IN PROGRESS | Stored retry/max-attempt policy is ignored; every error goes directly dead/held, and replay reports completed while writing skipped/no-status-change attempts (`interfaceEngineService.js:340-405`, `:1141-1285`, `:1410-1477`). | Implement retry state/backoff/jitter/exhaustion and truthful authorized replay, distinguishing definitive from ambiguous sends. |
| INT-004 | IN PROGRESS | Live HL7 ADT/ORM directly mutate admissions/investigations and acknowledge `AA` without the required atomic clinical timeline/audit transaction (`apps/backend/src/routes/hl7/hl7Routes.js:423-482`). | Canonical commands plus durable sender/MSH-10 outcome receipt in one tenant transaction; idempotent retransmission beyond the in-memory window. |
| INT-005 | IN PROGRESS | FHIR AllergyIntolerance POST writes `patient_allergies` while GET reads `allergies`, so a successful create disappears from search and has no canonical timeline/audit (`apps/backend/src/routes/fhir/fhirRoutes.js:1217-1265`, `:1335-1357`). | One canonical store/reader, immediate POST→GET round trip, atomic timeline/audit, duplicate and tenant tests. |
| INF-003 | OPEN | Backend expects one standalone `REDIS_URL`; Sentinel exposes only 26379 while the example URL uses nonexistent port 6379 (`infra/kubernetes/base/redis/redis-sentinel.yaml:148-167`; `apps/backend/sealed-secret.yaml.example:102-105`; `apps/backend/src/lib/redis.js:13-23`). | Wire ioredis Sentinel hosts/master/credentials and prove read/write/pub-sub continuity across primary failure. |
| INF-004 | OPEN | Redis boot always re-elects ordinal 0 locally and Sentinel restarts monitor ordinal 0 (`redis-sentinel.yaml:94-118`), permitting a former primary to return independently writable after failover. The config checksum is also a literal placeholder (`:219-222`). | Adopt a supported HA operator/chart or make startup follow quorum-elected state; prove exactly one writable primary through restart/partition/rotation drills. |

## Medium-severity correctness, hardening, and activation gaps

| ID | State | Finding | Evidence / required direction |
| --- | --- | --- | --- |
| PAT-003 | OPEN | Local Patient route/cache authority accepts any three-segment JWT-shaped string. | `apps/patient/lib/core/navigation/app_router.dart:76-85`, `:191-203`; `splash_screen.dart:271-313`. Reject expired tokens and use a bounded server-confirmed offline lease for PHI cache access. |
| PAT-004 | IN PROGRESS | Decrypted documents persist in plaintext staging until explicit logout. | `doc_staging.dart:31-69`; `cache_file_utils.dart:126-147`; `document_opener.dart:88-106`. Prefer streaming/in-app view or purge on cold start, recovery, failure, and safe viewer completion. |
| PAT-005 | IN PROGRESS | Every health-record filter shares `records_manifest_$phone`, so filtered and all-record results overwrite each other. | `your_health_screen.dart:131-170`, `:202-206`; `record_cache_manager.dart:11-27`. Scope by canonical filter, tenant, and captured profile, or cache the complete manifest. |
| PAT-006 | OPEN | Minimum-version enforcement uses raw unpinned HTTP and fails open on non-200/exception. | `minimum_version_gate_service.dart:29-53`, `:86-90`. Use pinned unauth transport plus signed monotonic last-known policy and explicit grace. |
| PAT-007 | IN PROGRESS | Two Patient WebSocket stacks have conflicting lifecycle/auth semantics. | `apps/patient/lib/main.dart:232-235`, `:300-335`; `app_router.dart:87-106`. Consolidate on shared `RealtimeProvider`. |
| PAT-008 | OPEN | External deep links are incomplete across platforms. | Android has only a broad custom scheme (`apps/patient/android/app/src/main/AndroidManifest.xml:108-114`); iOS lacks URL types/associated domains (`ios/Runner/Info.plist`; `Runner.entitlements:4-9`). Define verified universal/app-link ownership and routing tests. |
| STF-005 | OPEN | Staff router checks authentication, not route-level roles/capabilities; notification-provided routes are normalized but not allowlisted. | `apps/staff/lib/core/navigation/app_router.dart:173-233`; `notification_provider.dart:141-146`, `:672-678`. Central route metadata and denial before screen construction. |
| STF-006 | OPEN | Drug catalog errors silently become hard-coded “common drug” suggestions that clear canonical identity. | `drug_chart_screen.dart:54-67`, `:1424-1469`, `:1941-1949`. Show unavailable state; require catalog identity or governed privileged free-text override with reason/audit. |
| STF-007 | OPEN | Explicit/revoked logout does not wipe encrypted recent-patient cache although idle timeout does. | `recent_patients_service.dart:128-147`; `session_timeout_provider.dart:231-238`. Apply one retention policy to every logout path. |
| ADM-006 | IN PROGRESS | Fresh documented Admin dev server is port 3001, but default CSRF origin permits only 3000. | `apps/admin/package.json:9`; `src/lib/csrfOrigin.ts:35-45`. Align default and test local/foreign origins. |
| ADM-007 | IN PROGRESS | Visible Forgot Password and Preview controls are no-ops; shortcut modal advertises navigation/search keys it never implements. | `LoginClient.tsx:540-546`; `NotificationComposer.tsx:271-279`; `KeyboardShortcutsModal.tsx:6-33`; `CommandPalette.tsx:94-108`. Implement or remove every advertised control and test interaction. |
| ADM-008 | OPEN | Retired Workbox/PWA output still ships while root cleanup unregisters all service workers and deletes every origin cache. | `apps/admin/package.json:37-68`; `Dockerfile:80-84`; `ServiceWorkerCleanup.tsx:9-25`. Use version-scoped retirement, then remove artifacts/dependencies/cleanup. |
| CI-001 | OPEN | Admin clinical-AI bundle budget is false-green under Next 16/Turbopack because the expected manifest is absent and absence passes. | `apps/admin/scripts/check-clinical-ai-bundle.mjs:87-129`; `_reusable-admin-ci.yml:82-84`. Measure supported emitted chunks and add an oversized failure fixture. |
| CI-002 | OPEN | Admin CI runs plain Jest; optional coverage measures only three files out of 637 TypeScript sources. | `apps/admin/package.json:18-21`; `jest.config.ts:33-65`; `_reusable-admin-ci.yml:80`. Add risk-first protected coverage and ratchet scope. |
| CI-003 | OPEN | Admin lint passes with 2,540 warnings, including accessibility warnings, because there is no warning ceiling. | `apps/admin/eslint.config.mjs:61-81`; `_reusable-admin-ci.yml:70`. Baseline/ratchet, then promote safety/accessibility rules. |
| JOB-004 | OPEN | Safety/durability tenant fan-out falls back to default tenant on discovery failure and swallows per-tenant failures, yet outer scheduler logs completion. | `apps/backend/src/utils/tenantFanout.js:31-56`; `scheduler.js:161-176`, `:710-733`, `:825-829`. Continue healthy tenants but aggregate-fail and persist per-tenant outcomes. |
| JOB-005 | OPEN | Scheduled notification tenant ownership uses ID-only user relation and tenant-unsafe joins. | `apps/backend/prisma/schema.prisma:9291-9302`; `appointmentReminderJob.js:195-200`. Composite tenant FK, explicit tenant inserts, tenant-equality joins. |
| BOOT-001 | OPEN | API calls `listen` before migrations/bootstrap/RLS posture complete; readiness proves only DB access and one old table. | `apps/backend/src/bin/www.js:108-170`, `:283-285`; `routes/health/uptimeRoutes.js:68-108`. Complete bootstrap before listen and make the migration Job the sole production writer. |
| SEC-002 | OPEN | Production RLS posture probe errors explicitly fail open. | `apps/backend/src/lib/prisma.js:989-998`, `:1108-1112`. Retry within startup budget and fail closed unless an audited maintenance override is present. |
| CI-004 | OPEN | Comprehensive seed eventually sets `session_replication_role=replica` to force non-empty tables, while the gate checks row presence rather than valid domain invariants. | `apps/backend/scripts/seed-comprehensive-test-data.mjs:1391-1439`; `src/db/schemaContracts.js:318-393`. Seed valid dependency graphs with triggers enabled and test orphan/constraint rejection. |
| INT-006 | IN PROGRESS | Interface `allowed_source_ips` is stored but never loaded/enforced; source IP is logging-only. | `interfaceEngineService.js:217-305`, `:899-960`. Enforce normalized trusted-proxy CIDRs with an explicit empty policy. |
| INT-007 | IN PROGRESS | Activatable connector kinds have no runtime, and `http_outbound` can activate without an endpoint. | `interfaceEngineService.js:15-18`, `:602-656`, `:899-977`. Remove unsupported activatable kinds or implement them; require protocol-specific readiness. |
| ABDM-001 | HELD | Consent/transfer notifications occur after local commit as fire-and-forget, without an outbox/reconciliation ledger. | `apps/backend/src/services/abdm/abdmService.js:1171-1272`, `:1887-1905`. Transactional ordered outbox before enablement. |
| ABDM-002 | HELD | Gateway hardcodes `X-CM-ID: sbx`; production preflight omits CM ID/host/credential validation. | `services/abdm/abdmGateway.js:76-100`; `config/abdmConfig.js:4-13`; `utils/validateEnv.js:460-484`. Enabled production must reject sandbox/default hosts and missing identity. |
| ABDM-003 | HELD | Raw callback bytes are captured but signature verification reserializes JSON. | `apps/backend/src/app.js:573-580`; `routes/abdm/abdmRoutes.js:86-103`; `utils/signedRequest.js:34-36`. Pin official byte contract and test official vectors/alternate serialization. |
| INF-005 | OPEN | MinIO comments claim four pools/16 pods/four-drive tolerance, but manifest defines one pool/four servers and preferred anti-affinity over local disks. | `infra/kubernetes/base/minio/tenant.yaml:1-18`, `:82-134`; `docs/HARDWARE_REQUIREMENTS.md:61-74`. One authoritative topology/capacity/parity model plus whole-node failure drill. |
| INF-006 | OPEN | Forgejo is documented canonical, Argo watches GitHub, and both remotes can independently write production digests; audited remote heads differed. | `scripts/ci/README.md:103-114`; `.forgejo/workflows/release-images.yml:405-416`; `infra/kubernetes/base/argocd/applications/apps.yaml:17-20`; `.github/workflows/release-pin-digests.yml:80-92`. Select one authority and enforce one-way mirror SHA parity. |
| INF-007 | OPEN | Canonical Forgejo workflows execute mutable third-party tags/images with release/deploy credentials. | `.forgejo/workflows/ci.yml:52-74`; `release-images.yml:337-423`; `infra/forgejo/ci-image/Dockerfile:1`; `renovate.yml:36-44`. Immutable action SHA/image digest gate and internal mirrors where practical. |
| INF-008 | OPEN | Dalekdefender deploy exits 0 when prerequisites are missing, so green can mean no deployment. | `.forgejo/workflows/deploy-dalekdefender.yml:218-306`. Required mode fails closed and verifies `/api/v1/health/version`; optional mode emits machine-readable `not_deployed`. |
| INF-009 | OPEN | Sealed Secrets and Argo bootstrap documentation uses wrong controller namespace/name and `kubectl apply -f` on a Kustomize directory. | `infra/kubernetes/base/sealed-secrets/README.md:3-47`; `docs/DEPLOYMENT_GUIDE.md:553-564`; `base/argocd/README.md:18-23`. One tested sealing/bootstrap helper and ephemeral-cluster smoke. |
| INF-010 | OPEN | CNPG/Barman, MinIO operator, and cert-manager lifecycle is manual/marker-only despite GitOps claims. | `infra/kubernetes/base/cnpg/kustomization.yaml:1-20`; `base/minio/operator.yaml:1-35`; `base/cert-manager/cert-manager.yaml:1-14`. Immutable manual-sync Argo Applications and CRD/controller preflight. |

## Dead, empty, duplicate, and deliberately unwired surface

These items are lower immediate risk, but they make the repository harder to
reason about and allow partially implemented features to masquerade as product
surface.

| ID | Classification | Evidence and disposition |
| --- | --- | --- |
| DEAD-001 | Patient empty/dead | `apps/patient/lib/features/your_health/widgets/consultations_tab.dart:1` contains only `e`; `core/offline/record_cache_manifest.dart:1-2` is comment-only. Delete after confirming no generated/reference contract. |
| DEAD-002 | Patient unreachable | Static import reachability found 23 of 240 production Dart files unreachable. Strong examples: unused token store `shared_prefs_service.dart:6-40`, live wait-time widget `wait_time_widget.dart:4-35`, startup `permission_gate.dart:8-31`, and step share card `step_share_card.dart:5-27`. Decide wire-versus-delete feature by feature and add advisory reachability CI. |
| DEAD-003 | Staff compatibility residue | Five zero-inbound compatibility files appear removable after import-graph confirmation: `core/config/security_config.dart`, `core/services/api_retry.dart`, `certificate_pinner.dart`, `core/widgets/data_state_builder.dart`, and `core/services/staff_api_service.dart`. |
| DEAD-004 | Staff interface trap | `ClinicalInboxApi` defaults throw `UnimplementedError` (`clinical_inbox_api_service.dart:19-42`), while the production subclass implements them (`:45-153`). Make required methods abstract so test fakes cannot silently inherit runtime traps. |
| DEAD-005 | Admin dead code/deps | Knip reported 28 unused-file and 15 dependency candidates. Source-confirmed examples include `AppointmentsTable.tsx`, `AIExpansionPanels.tsx`, deferred panel barrel, duplicate relative-time helpers, `SendAnnouncementForm.tsx`, system-log controls, `useDebounce.ts`, `api-response.types.ts`, and orphan `src/scripts/test-auth.ts`. Remove in reviewed batches with a configured advisory Knip gate. |
| DEAD-006 | Backend dead scheduler/docs | `apps/backend/src/schedulers/appointmentReminderScheduler.js:13-80` has no importer, duplicates the active broken implementation, and swallows failure. `apps/backend/prisma/migrations/README.md:7-36` incorrectly describes Prisma directory migrations as authoritative. Delete the scheduler and document the raw SQL/PreSync runner. |
| DEAD-007 | Published 501 surface | Four Firebase-admin routes intentionally return 501 but remain published (`apps/backend/src/routes/auth/firebaseAuthRoutes.js:172-225`). Remove from route/OpenAPI until implemented or delegate to canonical admin/device services. |
| DEAD-008 | Orphan auth implementation | `apps/backend/src/config/authConfig.js:66-169` contains unused, unscoped verification/attendance implementations; live controllers call missing service methods instead. Delete rather than wiring the unsafe duplicate. |
| DEAD-009 | Admin observability placeholder | Active Admin ServiceMonitor scrapes `/api/metrics`, explicitly known not to exist (`infra/kubernetes/apps/admin/service-monitor.yaml:1-35`). Either implement authenticated/safe metrics or keep the monitor out of active render so “target down” is not normal. |
| DEAD-010 | Admin scripts/types | `npm run format` has no paths, `clean` points at the wrong file, E2E is excluded from TypeScript, `lucide-react.d.ts` makes 174 files effectively `any`, and generated OpenAPI types are used in only five source files. Repair scripts and migrate high-risk contracts first. |
| DEAD-011 | Infra redundant config | Argo monitoring Application declares both singular `source` and multi-source `sources`; singular config is ignored (`infra/kubernetes/base/argocd/applications/monitoring.yaml:31-57`). Remove and schema-validate. |

## Correctly held capabilities, not current defects

- Staff Web is fail-closed and requires a browser session/storage/App Check/CSP
  design plus E2E certification before activation (`apps/staff/lib/main.dart:158-162`,
  `:444-480`).
- Clinical continuity defaults to unavailable/disabled and needs an approved
  facility source plus login/foreground/facility/logout lifecycle before
  activation (`staff_continuity_repository.dart:39-42`, `:400-416`;
  `packages/vhhealth_core/lib/config/tenant_config.dart:94-105`).
- Device Gateway is not composed, uses a held image and empty enrollments. It
  also lacks the required clock-evidence producer/mount; preserve the hold
  until enrollment, credential, clock, capacity, network, and replay-soak
  evidence exists.
- PACS is optional/operator-gated. The documented worklist sidecar and
  `OnStableStudy` hook are absent and no machine identity exists for their
  clinical-staff-protected endpoints.
- ABDM is disabled in the known overlay; ABDM findings above are activation
  blockers rather than proof of a live sandbox leak.
- Linux/macOS Staff screen-capture protection is not implemented, while Windows
  is the currently documented desktop pilot. Treat this as a release blocker
  if either additional desktop becomes supported (`apps/staff/lib/main.dart:635-669`).

## Verified strengths and closed prior findings

- All 297 backend route modules are statically reachable from `src/app.js`; no
  unintended same-router/method/path shadow was confirmed.
- All 311 audited PHI tables carry `tenant_id`; all 836 tenant tables have
  isolation policies. Raw SQL parameter and no-silent-default static gates
  passed.
- Earlier broad user search/bed ordering and Staff profile missing-method
  findings have regression coverage and are no longer current.
- Patient notification privacy/tap gating, logout teardown, health-sync
  owner/session checks, Staff offline queue owner/action registry, results-inbox
  acknowledgement/reconciliation, and multiple canonical workflow primitives
  were materially strong at this snapshot.
- Dependency manifests are current within recorded peer/SDK ceilings and npm
  audits report zero current advisories. See
  [Consolidated Dependency Upgrade](./DEPENDENCY_UPGRADE_2026_08.md).

## Remediation and upgrade path

### Wave 0 — make every status truthful

1. Keep production HELD until active image pins resolve and platform-owned
   digests/secrets/R2/allowlists exist.
2. Remove false delivery/success states in reminders, scheduled notifications,
   interface preview/replay, tenant fan-out, health dashboards, and deploy jobs.
3. Add machine-readable `HELD`, `NOT_DEPLOYED`, `UNKNOWN`, `RETRYING`,
   `AMBIGUOUS`, and `REJECTED` states instead of empty/green fallbacks.

### Wave 1 — active patient and staff safety

1. Repair reminder timestamps and provider receipt state.
2. Close Patient and Staff realtime session isolation; make Code Blue a
   singleton; repair cache key/plaintext lifecycle.
3. Complete trusted-device/PIN/remove-device contracts and route-level Staff
   authorization.
4. Put Oncology and minimum-version traffic on the hardened transport.

### Wave 2 — transaction and tenant invariants

1. Consolidate payroll manual/cron semantics into one atomic domain service.
2. Add composite tenant foreign keys for scheduled notifications and finance
   satellites, plus explicit tenant writes/joins.
3. Finish bootstrap before listen; make the PreSync migration Job the sole
   production schema writer; fail closed on unknown RLS posture.
4. Replace replica-mode seed forcing with constraint-valid fixtures/invariants.

### Wave 3 — interoperability must produce real domain effects

1. Preview cannot be delivery; unsupported connector kinds cannot activate.
2. Add leased outbound workers, real retry policy, durable replay, source-IP
   enforcement, and ABDM outboxes.
3. Route HL7/FHIR writes through canonical atomic clinical commands and durable
   protocol identity/outcome ledgers.
4. Require protocol E2E/conformance evidence before PACS, Device Gateway, or
   ABDM activation.

### Wave 4 — infrastructure authority and failure drills

1. Select one canonical Git/release/Argo authority and make the other remote a
   verified one-way mirror.
2. Replace Redis boot scripts with a proved HA design; reconcile MinIO topology
   and capacity; make operator lifecycle declarative.
3. Pin Forgejo actions/images immutably and execute bootstrap, primary-loss,
   node-loss, backup/restore, and version-equality drills.
4. Follow the qualified RKE2/CNPG/PostgreSQL ladder in deployment documentation;
   do not jump directly to PostgreSQL 18 activation.

### Wave 5 — honest CI and dependency majors

1. Fix Admin bundle/coverage/lint/E2E gates, add registry reachability and
   controller-to-service/static contract checks, and add import/dead-file
   advisory gates.
2. Upgrade Flutter to 3.47 or newer, migrate to built-in Kotlin, then attempt
   AGP 9 and the deferred Win32/plugin cohort with all platform builds and
   secure-storage/device/offline regressions.
3. Move ESLint 10 only with compatible import-plugin peer support. Move Admin
   TypeScript 7 with a compatible `@typescript-eslint` family and a real bundle
   budget plus authenticated Playwright gate.
4. Re-profile Prisma generation and retain the generated-client cache; do not
   accept a 19-minute codegen path as permanently harmless.
5. Upgrade stateful/control-plane components one at a time with rollback and
   restore proof; globally disabled Renovate majors are a review queue, not an
   excuse for indefinite drift.

## Exit criteria

This audit may be marked complete only when every active Blocker/High row is
either integrated and verified or explicitly converted to an owner-approved
HELD activation gate; every Medium/Low row has an owner, disposition, and test
or deletion proof; the final remediation head passes the immutable `[full-ci]`
matrix; and no deployment or merge is inferred from those green checks.

