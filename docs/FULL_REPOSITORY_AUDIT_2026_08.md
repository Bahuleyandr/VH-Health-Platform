# VH Health Full-Repository Audit — Reconciled Ledger

**Current-main reconciliation:** 2026-09-02, authoritative `github/main`
`a4ffe9860596f07ae984d9334fe78f008b75907b` (merge-train PR
[#967](https://github.com/Bahuleyandr/VH-Health-Platform/pull/967)). The
original remediation snapshot was branch `fix/full-repository-audit-2026-08`,
head `b3807dccbc9281e94182041dd440542e6e77f14d`, draft PR
[#867](https://github.com/Bahuleyandr/VH-Health-Platform/pull/867). Historical
ratings and branch measurements below remain attached to that snapshot; the
finding dispositions and evidence tables are reconciled to current main.

**Originally audited source:** dependency-upgrade content commit
`8a692269f71b0666182fa82a5b7582119b9e2539` (published marker
`614216b28ffbf8f0270c4d88178cceae604ac091`).

**Status:** This document is a finding and evidence ledger. It is not merge,
deploy, activation, or release authority. The **4.8 / 10 rating and the
`IN PROGRESS` status table that this file previously carried are historical**:
they described the audited snapshot, not this branch after the remediation
train. Both are replaced below.

**Companion documents (these three must agree):**

- `docs/FABLE_5_FULL_AUDIT_HANDOFF_2026_08_13.md` — owner handoff; authority for
  hard stops, resumption order, and the deferral list.
- `docs/FULL_REPOSITORY_AUDIT_REMEDIATION_CHECKPOINT_2026_08_13.md` — historical
  mid-remediation pause receipt. Its per-lane "preserved, uncommitted" table is
  now fully superseded: every lane it lists has been reviewed, committed, and
  integrated into this branch.
- This file — the current finding ledger and the historical PR #867 rating.

### 2026-09-02 current-main receipt

GitHub was queried directly; merge state was not inferred from local history.
PRs #940–#943 and #945–#959 are merged; #944 and #960 are closed unmerged and
superseded. PRs #961–#965 are individually merged through merge-train PR #967:

| PR | Merged evidence | Audit disposition |
| --- | --- | --- |
| #961 | `e542f7ec9` | Alertmanager validation is wired into the unconditional security stage with pinned `amtool` and route assertions. |
| #962 | `9971c20e5` | Unused Prisma care-handoff relations are verified deleted. |
| #963 | `9cd920002` | Advertised Admin keyboard shortcuts are implemented and interaction-tested; closes OPEN-9. |
| #964 | `632333389` | Notification `/my` owner-path reads and read-state events are implemented; the corresponding ROADMAP entry is historical. |
| #965 | `9430bc9b2` | ABDM presentation has all-five-locale technical parity, including Malayalam; human linguistic approval remains held. |

PR #966 remains an open draft in its separately owned clinical-import lane. PR
#872 remains an open draft held by design; neither is merge or activation
authority.

The no-source-change full marker for #967 (`64ce8ee0029d1893f29dc39bb0cdc6865b74198b`)
has green named `Merge Gate` and `Full Merge Gate` contexts in Canonical CI run
`33579878494`. Exact-main Full Stack Sweep run `33596798546` is also green.
Exact-main Smoke E2E run `33601968478` is red on the MAR route-authority defect
recorded as OPEN-11. A green matrix therefore must not be described as complete
release-readiness evidence.

---

## What changed since the pause (PR #867 historical receipt)

The handoff (`FABLE_5_FULL_AUDIT_HANDOFF_2026_08_13.md`) paused at content head
`5533ba90a` with 39 commits ahead of `github/main`, a list of seven P1 release
or activation blockers, three P2 residuals, two named Patient test failures, and
one backend suite failing at module load. This branch is 33 commits further on.

Every numbered item in the handoff's "Current test failures and incomplete final
gates" and "Validated open findings" sections has been addressed, deliberately
held, or explicitly reclassified below. Where the handoff and this file could
disagree, the mapping is spelled out:

| Handoff item | Disposition here |
| --- | --- |
| Failures §1 — Patient final-gate suite not green | FIXED. Root cause was a cross-zone future leak through a process-wide singleton, plus an unbounded teardown. |
| Failures §2 — `interfaceEngineSchedulerWiring.test.js` module-load failure | FIXED. The Prisma mock now provides the named `setTenant` export. |
| Failures §3 — Admin post-build checks not retained in transcript | CLOSED on current main. The checks are normal reusable-workflow gates and ran in #967 Canonical CI. |
| Failures §4 — no final `[full-ci]` marker | CLOSED for #967. Canonical CI run `33579878494` has both required named contexts green on marker head `64ce8ee0029d1893f29dc39bb0cdc6865b74198b`. |
| P1 §1 HL7 flag not authoritative | FIXED |
| P1 §2 inbound activation without a canonical adapter | FIXED (migration 670) |
| P1 §3 care-team denials non-blocking in `shadow` | HELD (unchanged, deliberately) |
| P1 §4 migration Job invokes `npm`, absent from the runtime image | FIXED + regression test |
| P1 §5 four GitHub Android lanes call bare `sdkmanager` | FIXED |
| P1 §6 PG18 actively composed | HELD (moved out of the active graph) |
| P1 §7 Ollama pending-GPU tier actively composed | HELD (moved out of the active graph) |
| P2 §1 payslip announced before issuance | FIXED |
| P2 §2 FHIR AllergyIntolerance in-memory pagination | FIXED |
| P2 §3 fleet-scope jobs have no durable receipt | FIXED (migration 671) |

Two defects that did **not** exist in the handoff's finding list were found and
fixed inside the remediation train itself, and are recorded as such below
(FIX-P1, FIX-P2 in the FIXED table). Both were introduced by earlier remediation
commits on this same branch. That is a real quality signal about this train and
is reflected in the rating.

---

## Rating (PR #867 historical score; not a current release verdict)

### Scale and method

The rating answers the same question as the original 4.8, so the two numbers are
directly comparable: **"Can this repository, as committed, operate safely as one
integrated healthcare platform?"** It is deliberately harsher than a code-style
or unit-test score. A passing build proves units compile and their tests pass; it
does not prove that client/server contracts, delivery receipts, deployment pins,
failover design, or canonical clinical write paths work together.

Method is unchanged from the original: nine dimensions, each scored 0–10, and the
**unweighted arithmetic mean** is the headline number. (The original 43.5 / 9 =
4.83 is where "4.8" came from; the same arithmetic is used here so the movement
is reproducible rather than asserted.)

### Result

**PR #867 remediation-snapshot rating: 6.4 / 10** (58.0 / 9 = 6.44),
up from **4.8 / 10**. This score has not been recomputed for current main.

| Dimension | Was | Now | Why it moved, or did not |
| --- | ---: | ---: | --- |
| Domain architecture and breadth | 8.0 | 8.0 | Unchanged. No new domains; the shared primitives that earned the 8.0 are intact. |
| Automated test volume and gate honesty | 7.0 | 7.5 | Ratchets replaced absent budgets (`apps/admin/scripts/check-eslint-ratchet.mjs`, `check-format-ratchet.mjs`, risk-first `collectCoverageFrom` in `apps/admin/jest.config.ts`); new contract tests pin the image/Job and migration surfaces. Held back because the hosted full matrix has not run on this head. |
| Authentication, tenant, and privacy posture | 5.5 | 6.5 | Trusted-device contract, backend session authority, versioned tenant KEK, RLS-gated startup, and idempotency keys all landed. Held back hard because care-team PHI enforcement is still `shadow` in production. |
| Clinical correctness and durable delivery | 4.0 | 6.5 | The whole class of "reports success before delivery" defects is gone: reminders, scheduled notifications, tenant fan-out, fleet sweeps, and payroll are receipt-driven with DB-level constraints. Held back because migrations 670–672 have targeted suites but no recorded fresh-chain application proof. |
| Mobile and desktop integration | 4.5 | 6.5 | Patient realtime consolidated, cache/session lifecycle fixed, logout severance bounded with a stated ceiling, version gate unbricked, Staff device/PIN/Code-Blue/logout contracts closed. Held back by incomplete deep links and absent Linux/macOS capture protection. |
| Admin/operator truthfulness | 4.5 | 7.0 | Role graph, refresh engine, health states, composer contract, idempotency, PWA retirement, and 26 Admin files removed. Held back by advertised-but-unimplemented keyboard shortcuts. |
| Interoperability readiness | 3.0 | 5.5 | All four originally-cited defects (preview-as-delivery, no dispatcher, ignored retry policy, split allergy store) are fixed with migrations 665/666/670 and tests, and ingress now fails closed. Held back because ABDM is untouched and there is no protocol conformance E2E evidence. |
| Infrastructure and deployability | 2.0 | 3.5 | Active third-party pins are now real and registry-verified, bootstrap/runbook errors corrected, holds made machine-readable, operator lifecycle declarative-but-held. Barely moved because production still cannot deploy — and in one respect now needs *more* operator input than at the audited snapshot (see HELD-4). |
| Maintainability/dead-code control | 5.0 | 7.0 | 40 files deleted with import-graph proof; advisory reachability/knip signals wired; duplicate scheduler and orphan auth implementation removed. |

### Why 6.4 and not higher

The 1.6-point gain is concentrated in *truthfulness* — the repository now says
what it actually does — and in *contract repair* between clients and the API.
That is the bulk of what the remediation train was for, and it landed.

The residual 3.6 is dominated by four things, none of which any amount of further
local work can close:

1. **Production is still not activatable**, by design, and one of the holds is
   new: the CNPG cluster image moved from a real PG18 digest on `github/main` to
   an all-zeros PG17 placeholder here. That is the honest state — the deployment
   guide forbids PG17 and PG18 syncing together and no cutover authority exists —
   but it means an operator must supply *more* before production can start, not
   less.
2. **The strongest PHI-authorization control is still non-blocking.** Care-team
   enforcement defaults to `shadow`; the last read-only readiness inventory found
   0 of 28 QA tenants ready.
3. **No hosted evidence exists for this exact head.** The handoff's verified-gate
   list was collected at `5533ba90a`, 33 commits ago. The final `[full-ci]`
   marker has not been created.
4. **The remediation train is itself a demonstrated defect source.** Migration
   672 exists only to repair a guard that migration 669 shipped broken; the HL7
   rate limiter had to be reordered after the gate landed; migrations 666 and 668
   had to be rewritten non-transactionally after they were merged; and a
   fail-closed version gate that could have bricked every Patient install was
   introduced and then caught on this branch. Six of these were found by review,
   not by a gate. A rating above ~7 would imply a review-independent safety net
   that this branch has not demonstrated.

A 6.4 said the PR #867 snapshot was materially better than the audited source
and honest about its holds. It is preserved for trend history, not carried
forward as a current release claim. Current main has hosted matrix evidence but
also a red Smoke E2E run and the OPEN/HELD/ENVIRONMENT-UNPROVEN rows below.

---

## 1. FIXED

Source-verified on this head. Original finding IDs are retained so the ledger
stays traceable; `FIX-*` rows are defects introduced and closed inside this
branch.

| ID | Finding | Evidence on this head |
| --- | --- | --- |
| FIX-P1 | Patient minimum-version gate could hard-block every install: a fail-closed path fired before `/config` was consulted, so an operator who had not provisioned `PATIENT_MINIMUM_VERSION_POLICY_JSON` bricked the app. | `apps/patient/lib/core/services/minimum_version_gate_service.dart` — the unprovisioned and pre-config paths now return `_allow(...)`; genuinely-refusing responses keep the unchanged fail-closed treatment. Commit `6089c4282`. |
| FIX-P2 | Patient logout final-gate suite hung (10-minute timeout, `pumpAndSettle` timeout). Root cause was a cross-zone future leak through a process-wide singleton, not a test-harness artifact; a second defect left the realtime teardown unbounded. | `apps/patient/test/core/services/logout_teardown_paths_test.dart`, `.../core/navigation/backend_session_authority_test.dart` present and re-pinned to behaviour. `logout_service.dart` documents a **44s** worst-case ceiling with a 6s per-call network step timeout and a 4s inner call timeout. Commits `7a4eaf857`, `63649241e`, `dba87f2f8`, `7bf5f4e08`. |
| FIX-P3 | `onSessionExpired` was never wired: `RealtimeProvider()` was constructed with no callback, so `onSessionExpired?.call()` hit a null target and PHI retention on session expiry was silently skipped. | `apps/patient/lib/core/services/patient_session_expiry.dart` (new), wired via `ApiClient.onSessionExpired` → `VHHttpClient.onSessionExpired`. Commit `6089c4282`. |
| INF-001 | Eight active third-party `tag@digest` pins failed live registry manifest verification. | Pins replaced with resolved multi-arch digests (e.g. `redis:7.4.10-alpine@sha256:e7723ff7…`, `oliver006/redis_exporter:v1.66.0@sha256:d98e6db8…`). `scripts/check-prod-digests-pinned.mjs` re-resolves every active pin against its registry; `scripts/check-prod-helm-image-inventory.mjs` inventories them. |
| JOB-001 | Reminder windows compared timestamp bounds against `appointment_date` only, ignoring `appointment_time`. | `apps/backend/src/utils/notifications/appointmentReminderJob.js` rebuilt on a validated tenant-timezone timestamp. |
| JOB-002 | A queued SMS set reminder-sent state although the delivery worker deterministically rejects SMS. | Queue acceptance and provider acknowledgement separated; rejection is retained as a retry/operator obligation. Commit `19f85ccd8`. |
| JOB-003 | Scheduled notifications were unconditionally marked `sent`, swallowing push failures. | Lease + durable receipt state; only provider acknowledgement transitions to sent. |
| JOB-004 | Tenant fan-out fell back to the default tenant on discovery failure and swallowed per-tenant failures while the outer scheduler logged completion. | `apps/backend/src/utils/tenantFanout.js` now persists a scheduler run receipt with explicit `discovery_failed` / `reconciliation_failed` / `abandoned` aggregate states and rejects the aggregate; migration 668. |
| JOB-005 | Scheduled-notification tenant ownership used an ID-only user relation and tenant-unsafe joins. | Migration 668 adds the `(tenant_id, id)` anchor on `users` (built `CONCURRENTLY`) and the tenant-scoped composite FK. |
| FIN-001 | Manual payroll was a non-transactional find/update/create; the cron omitted advance/arrears effects entirely. | One shared `executePayrollRun` in `apps/backend/src/services/staff/payrollService.js` serves both manual and cron paths. Current serialization is compare-and-set plus a per-staff lock (`payrollService.js:1643-1705`), rather than the historical table-lock wording; `payrollSchedulerJobs.js` imports the shared executor. Migration 669. |
| PAT-001 | Patient subscribed to legacy channels denied to PATIENT; direct delivery used numeric `patient_id` rather than the JWT UUID. | Legacy `websocket_service.dart` deleted; consolidated on the acknowledged shared realtime client. |
| PAT-002 | Cache AES key memoized indefinitely; logout cleared secure storage first and never zeroized the in-memory key, so re-login could write PHI under an orphaned key. | Single-flight key init plus generation-safe zeroizing teardown; covered by `logout_teardown_paths_test.dart`. |
| PAT-004 | Decrypted documents persisted in plaintext staging until explicit logout. | Purge on cold start, recovery, failure, and viewer completion. |
| PAT-005 | Every health-record filter shared one `records_manifest_$phone` cache key. | Scoped by canonical filter, tenant, and captured profile. |
| PAT-006 | Minimum-version enforcement used raw unpinned HTTP and failed open. | Pinned transport plus signed monotonic last-known policy (`minimum_version_policy.dart`, `scripts/validate-patient-minimum-version-trust.mjs`). Real signing keys remain HELD. |
| PAT-007 | Two Patient WebSocket stacks with conflicting lifecycle/auth semantics. | Consolidated on the shared `RealtimeProvider`; the second stack is deleted. |
| STF-001 | App-scoped Staff `WebSocketProvider` cached PHI that logout never stopped or cleared. | `apps/staff/lib/core/widgets/logout_flow.dart` ends the authenticated generation and clears every session-scoped cache. |
| STF-002 | Every `StaffScaffold` mounted its own Code Blue listener, so pushed routes multiplied alerts. | Single session-scoped listener above routing, deduplicated by event ID/generation. Commit `6f299126c`. |
| STF-003 | Oncology reads/writes used raw `package:http`, bypassing the pinned/App-Check/refresh transport. | `oncology_screen.dart` now goes through `ApiClient.get`/`ApiClient.post` with `idempotencyKey: IdempotencyKey.generate()` on the toxicity write, behind an injectable `OncologyApiClient`. |
| STF-004 | Trusted-device/PIN/biometric onboarding was contract-incompatible end to end, including a call to a nonexistent `StaffAuthService.removeDevice`. | Commits `45101df0d`, `b7e754549`. |
| STF-005 | Staff router checked authentication but not route-level roles/capabilities. | `apps/staff/lib/core/navigation/app_router.dart` calls `StaffRoutePolicy.authorize(...)` and denies before screen construction; contract generated by `scripts/generate-staff-role-contract.mjs`. |
| STF-006 | Drug catalog errors silently became hard-coded "common drug" suggestions that cleared canonical identity. | `drug_chart_screen.dart` surfaces `catalogUnavailable` state instead of substituting suggestions. |
| STF-007 | Explicit/revoked logout did not wipe the encrypted recent-patient cache although idle timeout did. | `logout_flow.dart` invokes `RecentPatientsService.clear` on every logout path. |
| ADM-001 | Route policy recognized 69 roles, cached-profile schema accepted 37; null role defaulted to `AdminDashboard`. | `routePolicy.ts` regenerated from one graph; unknown/null is least-privileged. |
| ADM-002 | Idle timeout called only the local `/api/logout`, never revoking the backend session. | `useIdleTimeout.ts` reuses the canonical backend-revoking flow. |
| ADM-003 | The dominant `fetchAdminAPI` helper bypassed single-flight refresh and threw on every 401, across 150+ files. | Both APIs now sit on one refresh/retry engine in `apps/admin/src/lib/api/core.ts`. |
| ADM-004 | Secondary health failures became `null`/zero and null system health rendered the literal text `healthy`. | Explicit unknown/unavailable/stale states in `useDashboardData.ts` and `SystemHealthPanel.tsx`. |
| ADM-005 | Notification composer sent field names and enums the backend validator rejects. | `NotificationComposer.tsx` uses the canonical fields/enums; targeted and scheduled semantics wired. |
| ADM-006 | Documented dev server is 3001 but the default CSRF origin allowed only 3000. | `apps/admin/src/lib/csrfOrigin.ts`. |
| ADM-008 | Retired Workbox/PWA output still shipped while root cleanup unregistered all service workers. | The Workbox artifacts and obsolete cleanup implementation are deleted. A narrowly scoped `LegacyPwaRetirement` replacement remains intentionally, and `apps/admin/scripts/check-pwa-retirement.mjs` gates reintroduction of the retired surface. |
| API-001 | Anonymous `/api/v1/auth/firebase/health` returned global Firebase/adoption/device statistics and fanned one query per tenant. | `firebaseAuthService.getHealthStatus()` now returns a constant `{status, firebaseConnection, timestamp}` shape with a single `listUsers(1)` probe; the mount also sits behind `appCheckMiddleware`. |
| API-002 | The progress-note alias omitted `tenant_id`, unlike the canonical route. | One-line fix in `apps/backend/src/routes/clinical/clinicalRoutes.js`: `tenant_id: req.tenantId` is now passed to `clinicalNotesService.createNote`. |
| BOOT-001 | API called `listen` before migrations/bootstrap/RLS posture completed. | `apps/backend/src/bin/www.js` refuses to start on migration-readiness failure and only reaches `server.listen(PORT)` after every boot/readiness gate. Migration 667 + `startupMigrationReadiness.test.js`. |
| SEC-002 | Production RLS posture probe failed open on error. | `apps/backend/src/lib/prisma.js` retries within a startup budget and surfaces a distinct error posture rather than proceeding silently. An audited single-tenant override remains; this is a bounded fail-closed production default, not an unconditional removal of every override. |
| INT-001 | `backend.interop.preview` recorded `network_call_performed: false` yet marked the message delivered. | Preview is validation-only; production activation now requires a concrete registered canonical adapter (migration 670). |
| INT-002 | Generic interface outbound had no autonomous worker; dispatch was reachable only via Admin "dispatch now". | `dispatchOutboundMessages` is imported and scheduled in `apps/backend/src/utils/scheduler.js` with tenant fan-out, locking, and leasing. |
| INT-003 | Stored retry/max-attempt policy was ignored; replay reported completed while writing no-status-change attempts. | Retry state/backoff/exhaustion and truthful authorized replay; migration 665. |
| INT-004 | Live HL7 ADT/ORM mutated admissions/investigations and acknowledged `AA` without the atomic timeline/audit transaction. | Canonical commands plus durable MSH-10 outcome receipt in one tenant transaction; migration 666. |
| INT-005 | FHIR AllergyIntolerance POST wrote `patient_allergies` while GET read `allergies`. | Canonical writes now use `patient_allergies` plus receipt/event evidence. The reader at `fhirAllergyIntoleranceService.js:245-297` intentionally unions the canonical and legacy stores for compatibility; it is not literally a single-store reader. Migration 666 adds the `(tenant_id, id)` receipt anchor. |
| INT-006 | `allowed_source_ips` was stored but never enforced; source IP was logging-only. | Normalized trusted-proxy CIDR enforcement with an explicit empty policy. |
| INT-007 | Activatable connector kinds had no runtime; `http_outbound` could activate without an endpoint. | Protocol-specific readiness required at both service and DB activation boundaries. |
| INF-003 | Backend expected a standalone `REDIS_URL` while Sentinel exposed only 26379. | `apps/backend/src/lib/redis.js` parses `REDIS_SENTINEL_HOSTS`, requires ≥3 unique sentinels and named non-`default` ACL identities in strict mode, and rejects configuring both modes at once. |
| INF-004 | Redis boot always re-elected ordinal 0, permitting a former primary to return independently writable; config checksum was a literal placeholder. | Quorum topology enforced (`41ad6d68e`), failover security blockers closed (`2a96ed6a3`), deterministic harness in `scripts/check-redis-ha-contract.test.mjs`. **Live drill remains unproven — see ENV-1.** |
| INF-005 | MinIO comments claimed four pools/16 pods while the manifest defined one pool/four servers. | `infra/kubernetes/base/minio/tenant.yaml` and the hardware doc reconciled to one authoritative topology. **At 3 nodes that topology is recovery-only under whole-node loss (2 co-located pods = 8/16 drives, outside EC:4); only the recovery drill remains unproven — see ENV-2.** |
| INF-008 | Dalekdefender deploy exited 0 when prerequisites were missing, so green could mean no deployment. | `.forgejo/workflows/deploy-dalekdefender.yml` and `scripts/ci/forgejo-deploy-preflight.mjs` fail closed in required mode and emit machine-readable `not_deployed` otherwise. This is statically tested; a real Forgejo execution remains unproven under OPEN-7/ENV evidence. |
| INF-009 | Sealed Secrets and Argo bootstrap docs used the wrong controller namespace/name and `kubectl apply -f` on a Kustomize directory. | Corrected, plus `scripts/bootstrap-sealed-secrets.sh`, `scripts/validate-sealed-secrets-bootstrap.mjs`, and `scripts/sealed-secrets-bootstrap-smoke.mjs`. |
| CI-001 | Admin clinical-AI bundle budget was false-green because an absent manifest passed. | `apps/admin/scripts/check-clinical-ai-bundle.mjs` throws on a missing manifest, a chunk path escaping `.next`, and an invalid entry; `check-clinical-ai-bundle.test.mjs` fixtures cover the oversized case. |
| CI-002 | Admin CI ran plain Jest; optional coverage measured 3 of 637 sources. | `apps/admin/jest.config.ts` declares an explicit risk-first `collectCoverageFrom` (auth routes, proxy, CSRF, fetch guard, route policy, api core) with 85/85/75/70 global thresholds and a per-file `middleware.ts` threshold. |
| CI-003 | Admin lint passed with 2,540 warnings and no ceiling. | `apps/admin/scripts/check-eslint-ratchet.mjs` enforces 0 errors and a per-rule warning ceiling; `check-format-ratchet.mjs` added alongside. |
| CI-004 | The comprehensive seed set `session_replication_role=replica` to force non-empty tables. | Zero occurrences of `session_replication_role` remain in `apps/backend/scripts/seed-comprehensive-test-data.mjs`; the gate now checks domain invariants. |
| DEAD-001…011 | Empty, unreachable, duplicate, placeholder, and orphan surface. | The historical 40-file set remains absent, including the patient/staff compatibility residues, 21 Admin sources, duplicate reminder scheduler, orphan auth implementations, four Firebase 501 routes, and placeholder ServiceMonitor. PWA, patient reachability, infra, and Firebase guards cover important subsets, but no one current gate preserves the original all-40/all-eleven import-graph proof; see OPEN-20. |

**Also fixed this session, outside the original ledger IDs:**

- **Backend migration image/PreSync contract.** `infra/kubernetes/apps/backend/migration-job.yaml` invokes `node scripts/…` directly; the production Dockerfile deletes `npm`/`npx`, so the previous `npm run db:ensure-pgvector` would have aborted the PreSync hook at step 1. `scripts/backend-image-command-contract.test.mjs` derives the runtime image's binaries and file tree from the Dockerfile and fails if any command in the manifest is not actually in the image.
- **Pinned Android SDK provisioning ×4.** All four GitHub lanes (`deploy-patient-staging.yml`, `deploy-staff-staging.yml`, `release-patient.yml`, `release-staff.yml`) now run `android-actions/setup-android@40fd30fb…` (v4.0.1) pinned to `cmdline-tools-version: '15859902'` ahead of every `sdkmanager` call. Forgejo lanes deliberately excluded.
- **HL7 fail-closed ingress + correctly-ordered rate limiter.** `hl7InboundIngressGate.js` makes `HL7_INBOUND_ENABLED === 'true'` authoritative at three layers; `hl7IngressRateLimit.js` is mounted **ahead** of the gate so the gate's own refusal cannot be used as an unmetered oracle.
- **Migrations 666 and 668 rewritten `@no-transaction`.** Both build their `(tenant_id, id)` anchors `CREATE UNIQUE INDEX CONCURRENTLY`, with drop-then-rebuild of any `_invalid_rebuild` remnant. `runMigrations.js` honours the `@no-transaction` directive on a dedicated session client, and both files are written re-runnable because a mid-file failure leaves them applied-but-unrecorded.
- **Versioned tenant-KEK re-provision (migration 672).** Migration 669's guard required both old and new material to be non-NULL, so the two-step shred-then-refill *was* an in-place v1 replacement; it also only inspected `v1`, so it stopped protecting at the first real rotation. 672 makes the invariant "material may only move set → NULL", per version, and gives the provider a versioned insert path so a crypto-shred is no longer a one-way door.
- **Admin idempotency-key wiring across 7 endpoints**, via `apps/admin/src/hooks/useIdempotencyKey.ts` and `src/lib/idempotencyKey.ts`, with dedicated tests (e.g. `PayrollRunsTab.idempotency.test.tsx`).
- **FHIR AllergyIntolerance database work halved** — the page and its verdict are read in one pass with DB-side `UNION ALL` + `LIMIT/OFFSET` rather than two full-store reads sliced in memory.
- **Payroll notice moved behind issuance** — the pre-issuance outbox row must exist before issuance by design (the `delivery_pending` gate blocks first), so its *claim* changed: it now states the pending state and offers no action, and the collectable announcement is queued by `issuePayrollRun` after both approvals.
- **Fleet-scope scheduler receipts (migration 671).** Audit-chain verification and results-inbox escalation enumerate the fleet themselves and cannot be described by 668's tenant-fan-out row shape; 671 adds a mutually-exclusive fleet row shape so a tick that never fired is distinguishable from a tick that failed.

---

## 2. OPEN

Active rows below are still real on this head and severity-ranked. The closed
subsection preserves original IDs without leaving them falsely open.

### Closed since the PR #867 snapshot — IDs retained for history

| ID | Current disposition | Evidence |
| --- | --- | --- |
| OPEN-1 | **Verified implemented / superseded.** Exact-head hosted gate evidence now exists. | PR #967 marker head `64ce8ee0029d1893f29dc39bb0cdc6865b74198b`; Canonical CI run `33579878494` has both named `Merge Gate` and `Full Merge Gate` green. |
| OPEN-2 | **Verified implemented / superseded.** The reusable backend gate now builds an ephemeral database through the complete ordered migration chain, checks drift, exercises the comprehensive seed and schema contracts, and proves teardown. | `.github/workflows/_reusable-backend-lint-test.yml:286-318,393,446-515`; #967 Canonical CI and exact-main Full Stack Sweep run `33596798546`. |
| OPEN-4 | **Verified implemented.** Admin post-build checks are normal hosted gates. | `apps/admin/package.json:19,33,37`; `.github/workflows/_reusable-admin-ci.yml:92,95,128`; #967 Canonical CI. |
| OPEN-9 | **Verified implemented.** The advertised command-palette and keyboard shortcuts have interaction and contract coverage. | PR #963 (`9cd920002`); `CommandPalette.tsx:122-198`; `KeyboardShortcutsModal.tsx:15-30,61-82`; `dashboard-shortcuts.test.tsx:29-91`; `dashboard-shortcuts-contract.test.ts:1-19`. |

### High

| ID | Finding | What would settle it |
| --- | --- | --- |
| OPEN-3 | **Care-team relationship denials are non-blocking by default.** `careTeamEnforcement.js:15-28,47-48,72-123` defaults to `shadow`; lookup failure correctly raises `CARE_TEAM_MODE_UNAVAILABLE`, but an unconfigured tenant gets observation rather than denial. The historical 0/28 QA count has not been revalidated and must not be presented as current inventory. | Clinical/tenant-governance review of live memberships and break-glass evidence; tenant-by-tenant activation; then a gate rejecting new production tenants that silently inherit `shadow`. Also HELD-3/ENV-5. |
| OPEN-11 | **Exact-main Admin Smoke E2E is red because the MAR page authority is broader than its backend reads.** `/dashboard/mar` is available through the Admin role policy (`routePolicy.ts:164,296-305`; `navConfig.ts:214`) but its due/overdue calls correctly reject the crawl's SUPER_ADMIN identity because the backend admits only inpatient nursing roles (`clinicalRoutes.js:186-191,877,899`). Run `33601968478` reproduced both 403s on all three Playwright attempts. | Preserve the backend nursing restriction. Align Admin route/navigation/page construction with the due-list role contract, and retain a test proving unauthorized identities cannot construct the page while an authorized nursing identity completes the route smoke. |
| OPEN-12 | **Migration 753 appears to make ordinary successful cath consumable usage unrecordable without a pre-existing shortfall task, SLA, and outbox.** Only the `not_applicable` disposition exits before the reconciliation checks; every other real-stock usage reaches the shortfall evidence requirement (`753_pharmacy_order_inventory_authority.sql:4371-4422,4523-4569`). | Clinical/pharmacy/finance owner decides whether every usage intentionally carries a shortfall obligation. If not, repair forward in a newly allocated migration and add production-shape tests. Never edit applied migration 753. |
| OPEN-15 | **Migration 753 constraint activation has no final readiness receipt.** Current main contains 82 `NOT VALID` clauses and no `VALIDATE CONSTRAINT` statement in the file. Historical rows may be intentionally worklisted, so blind validation is unsafe. | After owned recovery/runtime decisions freeze, produce a zero-open or named-exception readiness receipt and a forward migration that validates every applicable constraint and proves `pg_constraint.convalidated=true`. Never edit migration 753 or silently accept unresolved rows. |

### Medium

| ID | Finding | What would settle it |
| --- | --- | --- |
| OPEN-5 | **PAT-008 deep links are only partially closed.** Android carries local custom-scheme links only (`AndroidManifest.xml:150-158`); iOS carries URL types but no associated-domains entitlement (`Info.plist:27`). The structural test explicitly proves HTTPS association is not active (`deep_link_platform_wiring_test.dart:13-36`). | Owned domain + signing authority (see HELD-7), then `assetlinks.json` / AASA publication and routing tests. |
| OPEN-6 | **INF-006 release-authority containment is unresolved.** GitHub is authoritative for this program, while held PR #872 contains the proposed one-way authority interlock. Current main does not contain its registry/interlock files, and the external identity/secret/tag containment ceremony has not happened. `docs/RELEASE_READINESS.md:32-33,85-86,140-150` also retains stale local-runner/Forgejo/`origin` authority wording. | Release/operator owner completes the named identity retirement, tag protection, secret removal, key rotation, and parity evidence; then #872 must be rebased and reverified. It remains held and must not merge early. Reconcile the readiness document without treating documentation as authority. |
| OPEN-7 | **INF-007 Forgejo inputs are pinned but unexercised.** `scripts/check-forgejo-supply-chain-pins.mjs:772-779` and `.github/workflows/_reusable-kubernetes-manifests.yml:92,104` gate the static contract; no real Forgejo run proves it. | Exercise the immutable action/image gate on Forgejo or formally retire that release lane. |
| OPEN-8 | **Interoperability has no protocol conformance evidence.** The canonical write paths, adapters, retry, and replay are implemented and unit/deep-tested, but no HL7v2 or FHIR conformance suite has been run against a live endpoint. | Protocol E2E/conformance run recorded before any interop activation. |
| OPEN-13 | **Migration 757 only partially supersedes the migration-753 JSON-scalar finding.** Migration 757 (`78e077e3a`) correctly normalizes SQL NULL and the JSON `null` scalar to `[]`, repairing the product order lifecycle without weakening the comparison fence. Other non-array scalars still raise SQLSTATE 22023 by design. | Pharmacy/clinical data owner decides whether every non-null scalar is irrecoverably malformed and should keep aborting, or must instead enter a governed recovery/quarantine path. Any change is a new migration; do not edit 753 or 757. |
| OPEN-14 | **The comprehensive seed's `checkedValue()` remains a non-column-bound literal heuristic.** The format guard closes the previously observed digest class, but a `LIKE`-constrained or enum-adjacent column can still receive a neighbouring conjunct's literal (`seed-comprehensive-test-data.mjs:529-555`). | Replace the heuristic with column-bound CHECK-expression handling, then run the full deterministic seed/contract matrix. Do not loosen constraints or paper over rejected rows. |
| OPEN-16 | **Engagement-campaign approval is not materially version-bound.** The inserted material and later approve/materialize transitions do not bind approval to an immutable content hash (`engagementCampaignService.js:523-543,955-970,997-1064`). | Persist and compare a canonical material hash/version across submit, approve, and materialize; mutation requires a new approval. ROADMAP `:1238-1254`. |
| OPEN-17 | **First-bed ADT emission remains an explicit interface-contract decision.** The capability string was narrowed rather than inventing an A02/A01 semantic. | Integration owner and receiving-vendor contract decide the event semantics before implementation or activation. ROADMAP `:1256-1288`. |
| OPEN-18 | **Linen ward and CSSD theatre-case pickers cannot be completed by every role allowed to use their consoles.** The backend lookup authority is narrower than the frontend workflow authority. | Decide and implement the least-privilege lookup contract; do not broaden unrelated ward/theatre access. ROADMAP `:1352-1407`. The callerless CSSD warning endpoint at `:1409-1429` is an intentional duplicate and is not this finding. |
| OPEN-21 | **Broader five-locale technical parity exists only in unmerged draft PR #970.** Live draft head `ac012b6a2b40546a65282c4a39aafe5d16832ada` removes the ordinary appointment/About English bypasses (`c55cda907`), reports patient parity at 1,447/1,447 keys, removes the Staff Malayalam structural exemption at 6,502/6,502 keys, and records 4,008 Staff English-source Malayalam placeholders. Its backend contract covers exactly four named presentations—payment link, gateway-refund reconciliation, clinical-alert recovery, and Cath shortfall—across `en`/`hi`/`ta`/`te`/`ml` (`apps/backend/src/tests/unit/fiveLocalePresentationContracts.test.js`). It changes no Admin locale resources and is not a repository-wide inventory of every backend/Admin presentation surface. The draft is not on `github/main`, and its current Canonical run `33657452600` is red in backend static checks, backend shard 3, Admin, and Flutter, so none of this is current-main completion. | Repair and rerun every red #970 gate, independently verify the exact final head, then merge only under separate authority. Human Malayalam review remains fail-closed for 2,494 explicit Staff entries, 4,008 generated placeholders, the patient first-pass queue, and the backend payment wording. Dependent setup, guardianship/relationship declaration/consent wording remains held for legal plus linguistic review; Staff Web activation copy remains held for operator/release ownership. No technical placeholder is approval. |

### Low

| ID | Finding | What would settle it |
| --- | --- | --- |
| OPEN-10 | **Linux/macOS Staff screen-capture protection is still unimplemented.** Windows is the documented desktop pilot, so this is currently latent — it becomes a release blocker the moment either additional desktop is supported. | Implement per-platform capture protection, or record an owner decision restricting Staff desktop to Windows. |
| OPEN-19 | **Several product workflows remain callerless or deliberately one-way.** The current code exposes gamification/reward writes, research-registry routes, most surgical-document writes, structured maternity writes, paediatric immunisation routes, document-signature reads, and bed-inspection routes without a production client. Ask-a-Doubt's dead reply path is correctly deleted, but the product remains explicitly one-way. | Product/clinical owner either authorizes an end-to-end client workflow with role and lifecycle tests or records the surface as intentionally restricted/retired. ROADMAP `:374-423,818-1069`. |
| OPEN-20 | **The DEAD-001…011 deletion set lacks one maintained regression proof.** Important subsets have PWA, patient reachability, infra, and Firebase guards, but the historical all-40/all-eleven import-graph proof is not reproduced by one current gate. | Add a current reachability/retirement manifest and mutation-tested gate, without restoring compatibility residues merely to satisfy the inventory. |
| OPEN-22 | **Backend dependency compatibility still relies on install-time mutation.** Current main globally overrides `minimatch` to 10.2.5, runs `apps/backend/scripts/patch-minimatch-compat.mjs` from `postinstall`, copies that patch into both backend image install stages, and gates that arrangement (`apps/backend/package.json:9,394`; `apps/backend/Dockerfile:8,52`; `scripts/security/check-infra-security-controls.mjs:21,40-41,100-110`). Normal `npm ci` succeeds because the hook runs, so this is hardening debt rather than a current install outage. Local unpushed commit `e5699a180f72f736b1dd953ba9235a3299a3e80b` removes the backend override/hook and resolves dependency-native patched majors; it is not an ancestor of `github/main` and is not current-main completion. | Land an independently reviewed native-resolution change with fresh `npm ci`, direct ESLint compatibility imports, mutation-tested dependency-floor coverage, full backend lint/security, and both backend Docker install stages green. The retained local candidate reports those checks green, including 4/4 focused tests and a Docker build, but requires fresh-main reconciliation and publication before this row can close. |

---

## 3. HELD

Deliberately inert. A hold is an activation stop, not permission to delete or
bypass the control, and **not** a defect. Each row names the evidence it awaits.

| ID | What is held | Where | Evidence it awaits |
| --- | --- | --- | --- |
| HELD-1 | **PG18 cutover.** PG18 was actively composed in production on `github/main` (with a real digest) even though the deployment guide forbids PG17 and PG18 definitions syncing together. | Moved wholesale to `infra/kubernetes/held/c1-1-pg18-cutover/`, composed by nothing. Paired image↔archive-identity invariant documented in `infra/kubernetes/base/cnpg/cluster.yaml` and gated by `scripts/check-c1-1-manifest-contract.mjs`. | Completed PG18 qualification per `docs/CNPG_POSTGRES_18_QUALIFICATION.md` plus explicit owner cutover authority. The invariant is deliberately strict: image generation and `serverName` archive prefix may never move independently. |
| HELD-2 | **Ollama pending-GPU deep tier.** Its preflight was a normal failing Job rather than a deployment hook, so the active graph was neither cleanly held nor safely deployable. | Moved to `infra/kubernetes/held/clinical-ai-deep-tier/` (statefulset, PVC, service, PDB, network policy, preflight job). | GPU hardware present and qualified; explicit fail-closed activation. |
| HELD-3 | **Care-team PHI enforcement stays in `shadow`.** | `apps/backend/src/services/security/careTeamEnforcement.js:15-28,47-48,72-123`; platform-owner default recorded 2026-06-14. | Owner-reviewed current tenant evidence, complete memberships, and break-glass proof. The older 0/28 QA inventory is historical and was not rerun in the 2026-09-02 reconciliation. **Do not flip this to make the repository look green.** |
| HELD-4 | **Production database image digest.** `infra/kubernetes/base/cnpg/cluster.yaml` carries `postgresql:17.10-standard-bookworm@sha256:0000…0000` — an intentional fail-closed placeholder. Dev and staging overlays patch in the real PG17 digest (`@sha256:f94c0eea…`); the prod overlay does not. | `infra/kubernetes/base/cnpg/cluster.yaml`. | An operator pinning the real PG17 digest at cutover time. **This is stricter than `github/main`, where the cluster carried a live PG18 digest.** Production therefore needs *more* operator input than at the audited snapshot, by design. |
| HELD-5 | **Platform-owned application digests, admin allowlists, `CF_R2_URL`, and SealedSecrets.** Fail-closed placeholders remain in the active app and staging Kustomizations. | `infra/kubernetes/apps/kustomization.yaml:48-65,103-118`; `infra/kubernetes/overlays/staging/apps/kustomization.yaml:184-188`. | Reviewed release digests from a real release run, real SealedSecrets, R2 URL, allowlists, and operator sign-off. A green Kustomize render is **not** proof of deployability. |
| HELD-6 | **Operator lifecycle applications** (CNPG/Barman, MinIO operator, cert-manager), formerly manual/marker-only despite GitOps claims. | `infra/kubernetes/held/operator-lifecycle/applications.yaml`, gated by `scripts/operator-lifecycle-preflight.mjs`. | CRD/controller preflight against a real cluster, then immutable manual-sync Argo Applications. |
| HELD-7 | **Patient minimum-version policy signing keys and universal/app-link association.** The signed-policy substrate and Ed25519 trust validator are in-tree and tested; the real keys and domain association are not. | `scripts/validate-patient-minimum-version-trust.mjs`; `apps/patient/lib/core/services/minimum_version_policy.dart`. | Owned domain and signing authority. |
| HELD-8 | **ABDM activation.** ABDM-002 is now environment-configured and production-preflighted (`abdmConfig.js:27-33`; `validateEnv.js:922-956`), and ABDM-003 verifies the captured raw callback bytes (`abdmRoutes.js:37-48,140-171`; `abdmHiuService.js:1224-1234`). ABDM-001 remains fire-and-forget without a transactional ordered outbox (`abdmService.js:1192-1195,1232-1235,1271-1274,1905-1912`). ABDM is disabled in known configuration. | `apps/backend/src/services/abdm/`; `apps/backend/src/config/abdmConfig.js`. | Transactional ordered outbox, NHA credentials/certification, official contract vectors, and explicit operator activation. Technical Malayalam parity from #965 does not satisfy linguistic approval. |
| HELD-9 | **Staff Web, PACS, Device Gateway, Keycloak SSO, warm standby.** Fail-closed and uncomposed. Staff Web has hosted build evidence, not browser release certification. | `apps/staff/lib/main.dart`; `apps/device-gateway/README.md:3`; `infra/kubernetes/held/c6-2-warm-standby/`; `infra/kubernetes/base/sso-keycloak/keycloak-app.held.yaml`. | Browser session/storage/App Check/CSP E2E certification for Staff Web; enrollment, credential, clock, capacity, network, and replay-soak evidence for Device Gateway; worklist sidecar and machine identity for PACS; capability-specific operator approval. |
| HELD-10 | **Clinical continuity** defaults to unavailable/disabled. | `staff_continuity_repository.dart`; `packages/vhhealth_core/lib/config/tenant_config.dart`. | Approved facility source plus login/foreground/facility/logout lifecycle. |
| HELD-11 | **Alertmanager delivery activation.** Validation and route assertions are wired by #961, but no repository rule proves a real person receives a notification. | `.github/workflows/ci.yml:105-122`; `infra/kubernetes/base/monitoring/validate-alertmanager.mjs:63-72`; `infra/kubernetes/base/monitoring/alertmanager.yaml.example`. | Owner-supplied Discord/PagerDuty/Slack/SMTP values and team destinations; operator sealing and Kustomization inclusion; manual Argo sync; captured end-to-end delivery proof and rollback evidence. No real secret belongs in this ledger. |
| HELD-12 | **Human linguistic approval.** The five-locale technical contract is `en`/`hi`/`ta`/`te`/`ml`; #965 closes the known ABDM Malayalam omission. Technical key parity and placeholder wording are not approval of clinical, dosage, consent, legal, or ABDM meaning. OPEN-21 separately records the residual hardcoded presentation categories, including dependent guardianship/consent text that no technical lane may approve. | Locale resources, structural parity gates, and `docs/TRANSLATION_REVIEW_TRACKER.md`. | Named human linguistic reviewers, with clinical/legal review where the string carries those meanings. |

---

## 4. DEFERRED

Owner-decided. These are compatibility or authority *programs*, not one-line
bumps, and are explicitly outside this continuation per the handoff.

| ID | Deferred item | Owner rationale |
| --- | --- | --- |
| DEFER-1 | **Forgejo release-authority work.** GitHub is the only publication target for this continuation. Immutable pin checks already in the branch may remain; Forgejo activation must not be extended. | Handoff, "Authority and hard stops". The unresolved documentation contradiction is tracked as OPEN-6. |
| DEFER-2 | **Android Gradle Plugin 9.** Flutter 3.47 / Dart 3.13 is now the pinned toolchain; patient/staff Android still use AGP 8.13.2. The remaining upgrade requires the built-in-Kotlin migration and all platform, secure-storage, device, and offline regressions. | Handoff, "Upgrade path still intentionally deferred"; `apps/patient/android/settings.gradle.kts:23`; `apps/staff/android/settings.gradle.kts:22`. |
| DEFER-3 | **The coordinated Flutter plugin cohort** — secure-storage, device-info, sharing, Windows. | Re-derive compatibility against Flutter 3.47 rather than relying on the now-stale pre-upgrade dependency rationale. See `docs/FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md`. |
| DEFER-4 | **ESLint 10** plus compatible import/tooling plugins. Blocked on import-plugin peer support. | See `docs/DEPENDENCY_UPGRADE_2026_08.md`. |
| DEFER-5 | **TypeScript 7** plus a compatible `typescript-eslint` family. TypeScript is now 6.0.3, and real bundle and authenticated Playwright gates exist; those completed gates are no longer part of this deferment. | `docs/DEPENDENCY_UPGRADE_2026_08.md`. |
| DEFER-6 | **Prisma generator/runtime performance.** Hosted caching substantially reduces the CI bottleneck, but the pathological Windows generation path has not been reprofiled and should not be called resolved. | Handoff. |
| DEFER-7 | **Live Kubernetes/operator and Redis HA qualification**, only after the HELD prerequisites in the runbooks are satisfied. | Handoff. Overlaps ENV-1/ENV-3. |

---

## 5. ENVIRONMENT-UNPROVEN

No local run can settle these. They are neither fixed nor open defects — they are
claims whose proof requires an environment this session does not have. Listing
them here prevents a future reader from mistaking a green local gate for
evidence.

| ID | Claim requiring proof | Why local work cannot settle it | Proof required |
| --- | --- | --- | --- |
| ENV-1 | **Redis HA actually survives failover.** Static topology, render, deterministic failover-harness, and the full infra gates passed; `scripts/check-redis-ha-contract.test.mjs` covers the contract. | The Docker daemon was unavailable, so no live three-node cluster ever existed. The deterministic harness proves the *design's* decision table, not the runtime. | A live three-node drill: primary loss, network partition, restart of a demoted primary, and credential rotation — with exactly one writable primary proven at every step. |
| ENV-2 | **MinIO recovers from whole-node loss at the reconciled topology (recovery-only posture — the topology does NOT tolerate whole-node failure).** The manifest and hardware doc agree on one pool / four servers, and no drill is needed to know tolerance is absent: on the 3-node cluster the preferred-only anti-affinity co-locates two of the four server pods on one node, so losing that node removes 8 of 16 drives — outside EC:4 parity — meaning total object-store unavailability until the node returns, and destruction of that node's local-path disks is permanent data loss (`infra/kubernetes/base/minio/tenant.yaml:15-21` explicitly forbids any whole-node-tolerance claim). What remains environment-unproven is only *recovery*: pods rescheduling and quorum resuming once the node is back. Whole-node tolerance itself is an owner decision at procurement — a fourth storage failure domain, or `EC:8` (halves usable capacity and forces pool re-creation). | Recovery behaviour under real node loss cannot be inferred from a Kustomize render. | Node-loss **recovery** drill against a real cluster (return-of-node → quorum resumes; this drill cannot and will not demonstrate tolerance). |
| ENV-3 | **Operator lifecycle and Argo bootstrap work on the target cluster.** Hosted Kind Sealed Secrets bootstrap coverage now runs in `.github/workflows/_reusable-kubernetes-manifests.yml:31-70,94-95,111-112`. | An ephemeral hosted cluster proves the bootstrap contract, not the target RKE2 controllers, storage classes, policies, or manual-sync ceremony. | CRD/controller preflight and controlled evidence on the target RKE2/Argo cluster. |
| ENV-4 | **The four Android release/staging workflows build current main.** The pinned Android setup step exists, but the 2026-09-02 full sweep is not evidence for all four release artifacts; recent release-workflow success was not established in this reconciliation. | These are GitHub-runner/release-workflow properties. | A current green run of each patient/staff staging/release workflow with retained artifact evidence. |
| ENV-5 | **Repository configuration equals live external tenant settings.** | The audit had no live tenant access; the care-team readiness inventory was SELECT-only and deliberately blocked. | Owner-supplied live tenant inventory. This is the gate HELD-3 waits on. |
| ENV-6 | **Codex Security Deep Scan.** No Deep Scan result is claimed anywhere in this ledger. | The desktop session never provided the plugin a managed filesystem permission profile, so its read-only worker could not be created. | A session where the scan can create its worker. The multi-lane manual audit ran independently and is not a substitute. |

---

## Exit criteria

This audit may be marked complete only when **all** of the following hold:

1. Every row in **OPEN** is either closed with recorded evidence or converted to
   an owner-approved **HELD** row naming the evidence it awaits.
2. The final source head has a no-source-change `[full-ci]` marker with both
   required named contexts green, plus green current-head smoke/release gates.
   Any later source push invalidates the marker evidence. The red exact-main
   Smoke E2E run recorded under OPEN-11 must be repaired, not waived.
3. Every migration has ordered fresh-chain, drift, seed/contract, and teardown
   evidence. Applied migrations remain immutable. In particular, OPEN-12,
   OPEN-13, and OPEN-15 require explicit owner dispositions and forward-only
   changes; no readiness claim may infer validated constraints from `NOT VALID`
   declarations.
4. Every **HELD** row still names its awaited evidence and remains inert. No
   hold is flipped to make the repository look green.
5. Every **ENVIRONMENT-UNPROVEN** row is still labelled unproven, or has been
   promoted to FIXED with the named environment evidence attached.
6. No deployment, Argo sync, merge, or activation is inferred from green checks.
   The draft PR stays draft until the owner says otherwise.
