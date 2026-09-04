# VH Health Full-Repository Audit — Reconciled Ledger

**Current-main reconciliation:** 2026-09-03, authoritative `github/main`
`f60df4e95` (PR
[#990](https://github.com/Bahuleyandr/VH-Health-Platform/pull/990)). Earlier the
same day: `61e7dcf7a` (PR #980) and `a4ffe9860` (merge-train PR #967, 2026-09-02).
PRs [#983](https://github.com/Bahuleyandr/VH-Health-Platform/pull/983) (`5b9b765b3`)
and [#982](https://github.com/Bahuleyandr/VH-Health-Platform/pull/982)
(`9e70d950d`) landed after the `61e7dcf7a` reconciliation and are dispositioned
below.
The original remediation snapshot was branch `fix/full-repository-audit-2026-08`,
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

### 2026-09-03 current-main receipt

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

Since `a4ffe9860`, fourteen further PRs have landed on main across eleven
first-parent merge commits, ending at the current tip `61e7dcf7a`:

| PR | Merge commit | Landed (UTC) | Audit disposition |
| --- | --- | --- | --- |
| #971 | `8115c91d0` | 2026-09-03 00:48 | `fast-uri` pinned `>=3.1.7`, clearing the HIGH advisory that reddened `npm audit` on every branch. |
| #970 | `d8930c98c` | 2026-09-03 01:34 | Malayalam technical parity landed; closes the technical half of OPEN-21 only. Human linguistic/clinical/legal review remains held. |
| #969 | `0fae5aa3a` | 2026-09-03 02:12 | Alertmanager routing guards are mutation-proved to fail closed. |
| #966 | `7e59f955d` | 2026-09-03 03:24 | Clinical-import receipt authority, custody and reconciliation. |
| #968 | `1c55ee04c` | 2026-09-03 06:48 | Auth fails closed when a token subject has no live identity row. Closes no existing ledger row. |
| #976 | `a37bf33e3` | 2026-09-03 07:14 | The fleet-wide clinical-import worklist concurrency cap is removed. |
| #978 | `f4b6aa989` | 2026-09-03 08:05 | Merge train landing #972, #974 and #975 under one canonical gate. |
| #972 | `0ab0e756a` | via #978 | Go-live authority and evidence-gate documentation reconciled. |
| #974 | `2e82f1ce5` | via #978 | Prior ledger reconciliation. |
| #975 | `9b20d6b71` | via #978 | Dead-code retirement guard; **closes OPEN-20**. |
| #977 | `edcc96fb2` | 2026-09-03 08:23 | Auth identity creation no longer takes a lifecycle lock. Subtractive; the mutation-path control is intact. |
| #979 | `e3a302f1d` | 2026-09-03 08:45 | The pre-auth surface runs tenant-scoped under RLS enforcement; narrows SEC-002. |
| #973 | `2c429d561` | 2026-09-03 09:08 | Maternity pregnancy-status and identifier integrity, including a fail-closed patient ownership guard. Does **not** close any part of OPEN-19. |
| #980 | `61e7dcf7a` | 2026-09-03 09:28 | Apex-host tenant context pinned; RESTRICTIVE-policy tables counted distinctly. |

`#972`, `#974` and `#975` are reported `MERGED` by the GitHub API against the
train branch `train/docs-audit-2026-09-03`; their listed commits are merges into
that branch, not first-parent merges into main. They reach main only through
`f4b6aa989`. Do not cite them as independent main merges.

PR #966 is **no longer open**: it merged at `7e59f955d` on 2026-09-03. Any
statement elsewhere in this ledger that treats #966 as an open, separately owned
clinical-import lane is historical. PR
[#872](https://github.com/Bahuleyandr/VH-Health-Platform/pull/872) remains an
open draft held by design and is the only open PR in the repository. It is not
merge or activation authority.

Gate evidence at the current tip: `61e7dcf7a` carries no Canonical CI run of its
own. Its merge-boundary evidence is Canonical CI run `33737286910` on the #980
head `9b32280b8`, with green named `Merge Gate` and `Full Merge Gate` jobs. The
historical #967 marker (`64ce8ee0029d1893f29dc39bb0cdc6865b74198b`, Canonical CI
run `33579878494`) remains valid for `a4ffe9860` only.

Scheduled deep-suite evidence is behind the tip. The newest Full Stack Sweep is
run `33720972436` at `7e59f955d` (green, 2026-09-03 05:56 UTC); the newest Smoke
E2E is run `33726802402` at `1c55ee04c` (red, 2026-09-03 07:11 UTC). Neither has
been re-run at `61e7dcf7a`, so neither is exact-main evidence for the current
tip. Run `33726802402` is red on the **same** MAR route-authority defect recorded
as OPEN-11 — `e2e/route-crawl.spec.ts:97` `/dashboard/mar` receives `403 Only
inpatient nursing roles can enumerate due medications` from both
`clinical/mar/due` and `clinical/mar/overdue` on all three Playwright attempts.
OPEN-11 is therefore reconfirmed on current main, not closed. A green matrix must
not be described as complete release-readiness evidence.

Per-PR gate verification for this wave was by name (`Merge Gate` and, where the
`[full-ci]` marker was present, `Full Merge Gate`) on each PR head before merge.
Because `strict: true` requires each branch to be up to date, every merge put the
next PR `BEHIND`; each therefore carries its own merge-main plus `[full-ci]`
cycle. Consecutive merges also cancel main's own `Backend CI` run, so
`edcc96fb2`, `e3a302f1d` and `2c429d561` show `cancelled` on main — that is the
merge train overtaking the run, not a failure.

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
| SEC-002 | Production RLS posture probe failed open on error, and — narrowed 2026-09-03 — the verdict it produced was itself blind to the connection role. | `apps/backend/src/lib/prisma.js` retries within a startup budget and surfaces a distinct error posture rather than proceeding silently. An audited single-tenant override remains; this is a bounded fail-closed production default, not an unconditional removal of every override. **Narrowed by #979/#980:** the verdict was keyed only on `testRole \|\| connectionRole`, so it was structurally blind to work done OUTSIDE `setTenant`/`setTenantTx` and reported "posture OK" on a cluster where every pre-auth `users` write was rejected 42501 and every pre-auth `users` read returned zero rows (`prisma.js:865-867`). Migration 758 puts a RESTRICTIVE `explicit_tenant_context_753` policy on `public.users`, and that migration is byte-identical at `a4ffe9860` — so this was already latent, and already unrecorded, when SEC-002 was last certified. The verdict now also reports `connectionRole`, `connectionBypassesRls`, `connectionRoleRlsSubject` and `restrictiveForcedTables` (`prisma.js:870-876`), counted as distinct tables rather than policy rows (`:997-1004`, 167 tables over 169 policy rows), and the boot log states when the bare connection role is RLS-subject (`:1175-1195`). `ok`/`reason` semantics are unchanged, so this is added truthfulness, not a new fail-closed gate. **Gate-honesty caveat, recorded here because no other row carries it:** the ordinary backend CI Postgres connection is a superuser and bypasses RLS even under FORCE, and `ci-setup-db.mjs:459-485` provisions the non-superuser RLS roles only when the connection is superuser — so RLS-subject behaviour is observable only in suites that explicitly `SET ROLE`. A green backend matrix is not evidence that RLS-scoped paths work. |
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
| DEAD-001…011 | Empty, unreachable, duplicate, placeholder, and orphan surface. | The historical 40-file set remains absent, including the patient/staff compatibility residues, 21 Admin sources, duplicate reminder scheduler, orphan auth implementations, four Firebase 501 routes, and placeholder ServiceMonitor. A single maintained gate now preserves the whole set: `scripts/ci/dead-code-retirements.json` pins all 40 retired paths and finding ids DEAD-001…DEAD-011, enforced fail-closed by `scripts/ci/check-dead-code-retirements.mjs` in the unconditional CI security stage (OPEN-20 closed, PR #975). |

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
| OPEN-11 | **Verified implemented (PR #982, `9e70d950d`).** The MAR page no longer enumerates due doses for an identity that cannot read them. **Proven, not inferred:** Smoke E2E was dispatched against exact main `9e70d950d` (run `33763189623`) and `/dashboard/mar` no longer appears in the failure set at all — the immediately preceding run `33726802402` at `1c55ee04c` failed on `/dashboard/mar` and nothing else. | Both enumerate reads are gated on the caller's raw role (`apps/admin/src/app/(with-auth)/dashboard/mar/page.tsx`, `enabled:` on each `useQuery`); `apps/admin/src/lib/marRoles.ts` mirrors `MAR_DUE_LIST_ROLES` from `clinicalRoutes.js:145-153`; 16 assertions in `mar-due-list-gate.test.tsx` pin the refusal, mutation-proved by deleting both guards. `rawRole` is used rather than `usePermissions().allowed`, which short-circuits SUPER_ADMIN. **The fix was deliberately NOT made at the route policy**, which still reads `mar: { minRank: STAFF }` (`routePolicy.ts:164`): the page carries four backend contracts and only the enumerate one excludes administrators — `MEDICATION_ADMINISTRATION_ROLES` (`clinicalRoutes.js:126-137`) admits ADMIN and SUPER_ADMIN, `POST /mar/verify` (`:437-442`) has no role gate, and wristband print admits administrators by owner decision of 2026-08-25 audited as `wristband-print-administrative-access` (`bcmaRoutes.js:50,120`). A route gate would have revoked three grants to silence one. **Scope check:** the only other caller of these endpoints is the Flutter staff app (`medical_api_service.dart:714,729`), whose users hold nursing roles and which the crawl does not visit; no other Admin surface can reproduce the 403. Note also that the page header previously claimed administrators get a 403 from the wristband guard — stale and contradicted by `PrintBandLink` in the same file; corrected in #982. |
| OPEN-22 | **Verified implemented (PR #983, `5b9b765b3`).** Neither app overrides `minimatch` nor rewrites `node_modules` from `postinstall`; every consumer resolves the major it declares at a patched release. | Repo-wide on `9e70d950d`: zero `"postinstall"` entries in any `package.json`, and no `patch-*-compat.mjs` anywhere in the tree (both measured, not just in the two apps). The admin `js-yaml` override went with it — redocly 1.34.19 already pins the patched 4.3.1 — as did `apps/admin/.prettierrc.json`, which held only an overrides block styling the deleted script. **The gate was inverted rather than removed:** `scripts/security/check-infra-security-controls.mjs` now asserts the ABSENCE of the mutation, that each Docker `npm ci` stage copies only the manifests, and that both lockfiles meet the per-major floors in the new `scripts/security/dependency-floors.mjs`. Independently mutation-tested three ways on the merged tree — re-adding a `postinstall`, inserting an extra `COPY` before `npm ci`, and dropping `minimatch` below its floor — each caught by a distinct named check. Lockfile entries were transplanted rather than regenerated, so the npm 11 `libc`-stripping trap was avoided: `libc` line counts are identical to the prior head (backend 26, admin 68) with none removed. |
| OPEN-24 | **Verified implemented (PR #988).** The authenticated route crawl now reports every broken dashboard route in one run instead of the alphabetically first. | `route-crawl.spec.ts` asserted inside each per-route `test.step`, and a failing `expect` propagates out of an awaited step and ends the run — so however many routes were broken the crawl named exactly one, and because routes are crawled in sorted order the masking was systematic: `/dashboard/mar` sorts before `/dashboard/pharmacy`, so fixing MAR in #982 immediately surfaced a pharmacy 409 that had been present and invisible behind it (run `33726802402` reported only `/dashboard/mar`; run `33763189623` on the next main reported only `/dashboard/pharmacy`). Findings are now collected per route and asserted once after the loop. Two properties kept deliberately: the per-route step still THROWS, so a broken route is still marked failed in the Playwright report rather than silently green, and the throw is caught at the loop so the crawl continues; and within a route each check is recorded rather than thrown, so a redirect cannot hide a console error and a console error cannot hide a failed backend response. `EXPECTED_DARK_GATE_RESPONSES` is untouched: this widens what the tier can SEE, not what it tolerates. **Expect the first runs to name more routes than before — that is the fix working, and those routes were already broken.** |
| OPEN-20 | **Verified implemented (PR #975, train #978).** One maintained gate now reproduces the whole DEAD-001…011 retirement proof, and it cannot be skipped by path or tier routing. | `scripts/ci/dead-code-retirements.json` pins the census (`expectedAbsentPathCount: 40`, 40 `absentPaths`, 4 scoped `forbiddenFragments`) and declares `requiredFindingIds` DEAD-001…DEAD-011; `scripts/ci/check-dead-code-retirements.mjs` fails closed when a retired path returns (`:159`), a fragment-guard target is deleted (`:182`), a retired fragment is restored (`:199`), the census is shrunk (`:144`), or a required finding id has no rule (`:217`). Ten mutation tests in `check-dead-code-retirements.test.mjs` prove each failure mode, including dangling-symlink evasion and census-shrink. The gate runs in the canonical security stage (`scripts/ci/security.mjs:216-217`, reached from `.github/workflows/ci.yml:127` under `if: always() && needs.plan.result == 'success'`), and a meta-test (`:295-325`) fails CI if that wiring is removed. Verified green on `61e7dcf7a`: 0/40 retired paths present, 0/10 forbidden fragments restored. Note the gate proves *retirement* (absence plus forbidden fragments), not a re-derived import graph — the durable form of the invariant, since reachability cannot be computed over deleted files. Advisory knip reachability remains at `_reusable-admin-ci.yml:98` (`--no-exit-code`, admin-only) and must not be mistaken for this gate. |
| OPEN-14 | **Verified implemented (PR #985, `15c4327b4`).** The comprehensive seed's `checkedValue()` is now column-bound and provably order-independent. | The new `apps/backend/scripts/lib/checkConstraintValues.mjs` tokenises each CHECK into a boolean skeleton with classified atoms and binds literals to the conjunct that actually constrains the requested column, in two tiers: positive literals from single-column conjuncts minus any that also appear as a trigger inside a multi-column conjunct, then the enumeration when every member is a trigger, then null to `semanticValue`. **Tie-break is on definition TEXT, not `conname`**, which is the direct repair of the `dce625f48` error class — ordering by a name made a seed value depend on what someone called a constraint. Whole-schema proof: all 2,107 CHECK definitions on main parse, with **zero order flips under reversal**. The three `event_type` override pins are retired because the corrected function derives their exact pinned values (`receive`, `created`, `LINE_MATERIALIZED`) from the definitions alone in every order; `pharmacy_funding_decision_events` survives only for its two NON-text columns, which `checkedValue` never touched. Per-constraint verification: 2,107 evaluated against seeded rows via `SELECT count(*) FROM t WHERE (expr) IS FALSE`, `NOT VALID` included (Postgres enforces those on new rows), **0 violations**. 21 assertions in `comprehensiveSeedCheckedValue.test.js` covering both definition orders plus 8 shuffles, mutation-proved three ways — first-literal reversion, dropped trigger exclusion, and caller-order instead of text-order. **Evidence boundary, stated rather than implied:** of the columns whose answer changes, 78 sit on tables carrying no row on the schema-only base, 78 on hand-seeded tables, 84 where a pin or an earlier path supplies the value, and **14 reach the row** — so "0 violations" covers the 176 that materialise and exercises the change for 14, with the remaining 240 resting on the unit tests and the whole-schema proof. **Figures corrected:** the prediction was 254 columns (132 changed + 122 fallen through), not the 283 first reported, and 1,379 columns answer from this function (not 1,483), 849 from a multi-column CHECK (not 968), 187 order-sensitive (not 199); 65 substring cases unchanged. The inflated set came from offline measurement scripts written through a bash heredoc that collapsed doubled backslashes, so a copied regex carried a backspace where a word boundary belonged and never recognised a regex or LIKE atom. Two independent implementations disagreeing (122 vs 169) is what exposed it. |
| OPEN-16 | **Verified implemented (PR #987).** Engagement-campaign approval is now bound to an immutable material hash, so no change of template, audience, channel, schedule or rate policy survives an existing approval. | `campaignApprovalMaterial.js` hashes the campaign fields, both template bodies and the audience snapshot; migration 763 stores `approval_material`, `approval_material_hash` and `approved_material_hash`. Submit stores the material, approve recomputes and stamps on match, and queue re-verifies in one tenant transaction. All three consequences this row recorded are closed, not two: post-approval `materializeCampaignRecipients` is refused (`ENGAGEMENT_APPROVAL_LOCKED`); `frozen_audience_hash` is no longer written-but-never-read — it is redefined as the approved recipients hash and compared; and the due-recipient SELECT is filtered by `audience_snapshot_id`, so recipients materialised after approval cannot be dispatched under the earlier one. A mismatch returns the campaign to draft with an audit row, and **the reset is committed before the 409 is thrown** — both paths return the mismatch out of the transaction rather than throwing inside it, because a throw inside would roll the reset back and leave the campaign approved while telling the caller it had been returned to draft. The identity hash deliberately EXCLUDES every column dispatch or a consent re-check writes (recipient `status` among them): including them would self-lock any drip-fed campaign on consent churn, so both the included and excluded lists are pinned by unit test. A campaign approved before 763 has no stamped hash and is reset to draft at queue time (`ENGAGEMENT_APPROVAL_MATERIAL_MISSING`) rather than failing forever. Migration 763's CHECK is `NOT VALID` by necessity, and its header carries the drain query and the exact `VALIDATE CONSTRAINT` follow-up so it does not silently join the OPEN-15 debt class. |

### High

| ID | Finding | What would settle it |
| --- | --- | --- |
| OPEN-3 | **Care-team relationship denials are non-blocking by default.** `careTeamEnforcement.js:15-28,47-48,72-123` defaults to `shadow`; lookup failure correctly raises `CARE_TEAM_MODE_UNAVAILABLE`, but an unconfigured tenant gets observation rather than denial. The historical 0/28 QA count has not been revalidated and must not be presented as current inventory. | Clinical/tenant-governance review of live memberships and break-glass evidence; tenant-by-tenant activation; then a gate rejecting new production tenants that silently inherit `shadow`. Also HELD-3/ENV-5. |
| OPEN-12 | **Migration 753 appears to make ordinary successful cath consumable usage unrecordable without a pre-existing shortfall task, SLA, and outbox.** Only the `not_applicable` disposition exits before the reconciliation checks — `cath_inventory_authority_assert_contract_753` contains exactly one `RETURN;`, at `753_pharmacy_order_inventory_authority.sql:4421` — so every other real-stock usage reaches the shortfall evidence requirement (`:4371-4422,4523-4569`), including an eventually fully decremented usage (`:4653-4665`). The constraint trigger fires on every row: `trg_cath_usage_authority_contract_753` is `AFTER INSERT OR UPDATE OR DELETE ON public.cath_case_consumable_usage` (`:4765-4768`) and its handler sets `relevant := TRUE` unconditionally for that table (`:4670-4725`). Re-verified unchanged at `61e7dcf7a`. **No migration supersedes it:** the only migrations on main above 753 are 754, 755, 757, 758, 759, 760, 761 and 762 (756 was never allocated); none drops the cath trigger or function, and 758 re-emits the identical contract — `758_pharmacy_advance_funding_authority.sql:4042-4363` re-declares the function with a byte-identical body and re-emits the trigger handler at `:4364` — so the obligation is the last-wins definition in the applied chain. | Clinical/pharmacy/finance owner decides whether every usage intentionally carries a shortfall obligation; ballot `753-D1` in `GO_LIVE_READINESS_GAP_MATRIX.md:44-66` is still unsigned (both options blank at `:58-63`) and the service still materializes the shortfall unconditionally (`cathLabService.js:4439-4448`). If the obligation is not intended, repair forward in a newly allocated migration that re-declares the function (as 758 already does) and add production-shape tests. Never edit applied migration 753 or 758. |
| OPEN-15 | **Migration 753 constraint activation has no final readiness receipt.** Current main contains 82 `NOT VALID` clauses and no `VALIDATE CONSTRAINT` statement in the file. Historical rows may be intentionally worklisted, so blind validation is unsafe. | After owned recovery/runtime decisions freeze, produce a zero-open or named-exception readiness receipt and a forward migration that validates every applicable constraint and proves `pg_constraint.convalidated=true`. Never edit migration 753 or silently accept unresolved rows. |

### Medium

| ID | Finding | What would settle it |
| --- | --- | --- |
| OPEN-5 | **PAT-008 deep links are only partially closed.** Android carries local custom-scheme links only (`AndroidManifest.xml:150-158`); iOS carries URL types but no associated-domains entitlement (`Info.plist:27`). The structural test explicitly proves HTTPS association is not active (`deep_link_platform_wiring_test.dart:13-36`). | Owned domain + signing authority (see HELD-7), then `assetlinks.json` / AASA publication and routing tests. |
| OPEN-6 | **INF-006 release-authority containment is unresolved.** GitHub is authoritative for this program, while held PR #872 contains the proposed one-way authority interlock. Current main does not contain its registry/interlock files, and the external identity/secret/tag containment ceremony has not happened. `docs/RELEASE_READINESS.md:32-33,85-86,140-150` also retains stale local-runner/Forgejo/`origin` authority wording. | Release/operator owner completes the named identity retirement, tag protection, secret removal, key rotation, and parity evidence; then #872 must be rebased and reverified. It remains held and must not merge early. Reconcile the readiness document without treating documentation as authority. |
| OPEN-7 | **INF-007 Forgejo inputs are pinned but unexercised.** `scripts/check-forgejo-supply-chain-pins.mjs:772-779` and `.github/workflows/_reusable-kubernetes-manifests.yml:92,104` gate the static contract; no real Forgejo run proves it. | Exercise the immutable action/image gate on Forgejo or formally retire that release lane. |
| OPEN-8 | **Interoperability has no protocol conformance evidence.** The canonical write paths, adapters, retry, and replay are implemented and unit/deep-tested, but no HL7v2 or FHIR conformance suite has been run against a live endpoint. | Protocol E2E/conformance run recorded before any interop activation. |
| OPEN-13 | **Migration 757 only partially supersedes the migration-753 JSON-scalar finding.** Migration 757 (`78e077e3a`) correctly normalizes SQL NULL and the JSON `null` scalar to `[]` (`757_pharmacy_clinical_projection_json_null.sql:74-76`), repairing the product order lifecycle without weakening the comparison fence. Other non-array scalars still raise SQLSTATE 22023 by design (`:32-34`). Re-verified through migration 762 on `61e7dcf7a`: nothing further addresses the scalar policy. Migration 758 re-creates only the parent `pharmacy_patient_safety_projection_753` (`758_pharmacy_advance_funding_authority.sql:10048`) and still routes `chronic_medications`/`medications`/`items_list`/`dispensed_medications` through the unchanged child (`:10062,10086,10100-10101`); it does not redefine `pharmacy_erx_clinical_projection_753`, so 757's normalization stands and the residual abort is unchanged. No migration installs a `jsonb_typeof` array fence on those columns, so a malformed scalar can still be written and then block an unrelated update. | Pharmacy/clinical data owner decides whether every non-null scalar is irrecoverably malformed and should keep aborting, or must instead enter a governed recovery/quarantine path (`GO_LIVE_READINESS_GAP_MATRIX.md:68-89` 753-D2, both options still blank; `apps/backend/docs/DB-MIGRATION-PLAN.md:66` disposition still `______`). Any change is a new migration; do not edit 753, 757, or 758. |
| OPEN-17 | **First-bed ADT emission remains an explicit interface-contract decision.** The capability string was narrowed rather than inventing an A02/A01 semantic. | Integration owner and receiving-vendor contract decide the event semantics before implementation or activation. ROADMAP `:1256-1288`. |
| OPEN-18 | **Linen ward and CSSD theatre-case pickers cannot be completed by every role allowed to use their consoles.** The backend lookup authority is narrower than the frontend workflow authority. | Decide and implement the least-privilege lookup contract; do not broaden unrelated ward/theatre access. ROADMAP `:1352-1407`. The callerless CSSD warning endpoint at `:1409-1429` is an intentional duplicate and is not this finding. |
| OPEN-21 | **Five-locale coverage is technically complete on `main` but linguistically unapproved; the residual is human review, not engineering.** PR #970 merged 2026-09-03 (`d8930c98c`, final head `ea168be76`), so the technical half of this finding is closed on `61e7dcf7a`: the ordinary appointment/About English bypasses are gone; patient ARBs measure 1,447/1,447 keys in every locale including `ml`; the Staff Malayalam structural exemption is removed (`apps/staff/scripts/i18n-verify.mjs:54`, `FULL_LOCALES = ['hi','ta','te','ml']`) at 6,502/6,502 keys; and the parity gate is blocking in both Flutter CI halves (`.github/workflows/_reusable-flutter-workspace.yml:66-69`), verified to have actually executed green — not tier-skipped — in Canonical run `33702447172`. The backend contract `apps/backend/src/tests/unit/fiveLocalePresentationContracts.test.js` is on main. **What remains open is entirely human review plus two bounded scope gaps.** (1) Staff Malayalam parity is 2,494 explicit entries plus **4,008 generated English-source placeholders** (`apps/staff/lib/l10n/app_strings_ml_parity.g.dart`); every one is the English source copied verbatim — a placeholder is not a translation. (2) `hi`/`ta`/`te` carry 501/954/955 `// REVIEW:` flags and the patient app has a 48-key first-pass queue (`docs/TRANSLATION_REVIEW_TRACKER.md:113-140`); both Malayalam rows read `Pending` (`:19`, `:23`). (3) Backend payment wording is resolved but **not translated**: `paymentLinkService.js:46-52` points all five locales at one frozen object that is English plus a single Hindi line, so a Malayalam, Tamil or Telugu patient still receives English/Hindi payment copy. (4) Dependent guardianship/relationship/consent copy remains hardcoded English (`apps/patient/lib/features/family/screens/family_screen.dart:784-787,839-840`), fail-closed on legal plus linguistic review. (5) Staff Web activation copy remains hardcoded English (`apps/staff/lib/main.dart:476-484`). (6) Coverage is still not a repository-wide inventory: the contract test hard-codes exactly the four `_PRESENTATIONS` constants that exist today, so a fifth backend presentation surface would ship without Malayalam and no gate would catch it; and `apps/admin` contains **zero** locale resources, placing the entire Admin surface outside every locale contract. | The engineering remediation is discharged — do not re-open it. Route the 4,008 Staff placeholders, the 2,494 explicit Staff entries, the patient 48-key queue and the backend payment wording to named human Malayalam reviewers, with clinical, finance and legal sign-off where the string carries those meanings; prioritise clinical action, dosage/MAR, consent, emergency, controlled-drug and legal-declaration copy. Guardianship/consent wording stays held for legal plus linguistic review and Staff Web activation copy for operator/release ownership; neither may be converted into a technical placeholder to make the parity ledger look complete. Separately, make the backend five-locale contract enumerate presentation constants dynamically so a newly added surface fails the gate, and decide whether Admin is in scope for localisation at all — today it is silently exempt. Technical parity and a green gate are not approval. |
| OPEN-23 | **411 inline CHECK constraints are declared but were never enforced; the class is now DETECTED (PR #989) but not remediated.** Inline CHECKs declared inside `CREATE TABLE IF NOT EXISTS` re-declarations of baseline-owned tables have never existed in any database: `000_baseline.sql` creates the table first, so the later migration's column-level CHECKs are silently discarded. It is self-perpetuating — the baseline is a `pg_dump` of a `prisma db push` bootstrap and Prisma cannot express CHECK constraints, so regenerating the baseline does not fix it. **Measured census** (corpus vs a database built from empty + `ci-setup-db`): 2,194 inline CHECKs in `CREATE TABLE` statements; **465** inside `IF NOT EXISTS` re-declarations of baseline-owned tables (209 tables, 101 files); **411 absent** from `pg_constraint` (182 tables, 86 files); 54 enforced because the baseline happened to carry them; zero re-declarations of migration-created tables, so the class is confined to baseline-owned tables. These supersede the 369 / 157 / 82 figures previously carried here — not a correction of an error but a different basis: the census keys per DECLARING FILE, which is what a per-file gate acts on, so a table re-declared in two migrations (`ambulance_requests` in 126 and 233) contributes each file's clauses. Mostly defence-in-depth loss, but `maternity_pregnancies.edd_method` and `booking_status` reach their INSERT caller-controlled with no enum guard at any layer. **What PR #989 closed:** the class can no longer silently reappear. `scripts/ci/check-inline-check-census.mjs` pins all 465 with their enforced flag; the gate and its meta-test run in the UNCONDITIONAL security stage (`security.mjs:226-227`) so no path or tier routing can skip them; and a `--verify-db` calibration in the backend job, immediately after `check-schema-drift` (which cannot see CHECK constraints at all), asserts the static classification matches `pg_constraint` in BOTH directions. Its first CI run — against a database nobody built on a workstation — reported **0 discrepancies over 2,108 CHECK constraints** and reproduced 465/411/54 exactly. The census may shrink but not grow, so remediation is rewarded rather than blocked (verified by simulating a real fix, 411 → 410 and back). | Triage the 411 (`--report` prints the worklist) to separate dead CHECKs already mirrored in application code from those that are the sole guard on a clinically or security-relevant column; `dialysis_patients` serology/modality enums, `mfa_devices` and `abdm_consent_requests` first. For the sole-guard set, backfill or quarantine out-of-domain rows, then add the constraints in newly allocated forward migrations — `check-migration-immutability.mjs` forbids editing applied files, so never edit 155 or `000_baseline.sql`. Each genuine fix flips its census entry and decrements the count. Escalate to High if triage finds a sole-guard CHECK on an activated clinical or consent surface. |
| OPEN-25 | **Half fixed and re-diagnosed: `/dashboard/pharmacy` is still the sole failing route, but for a DIFFERENT reason, and the remaining half looks like the OPEN-11 pattern rather than a seeding gap.** The tenant-configuration precondition is closed: `seed-smoke-pharmacy-facility.mjs` (PR #986) now seeds one active default facility as a smoke-only step, and the exact-main run `33823079467` on `f60df4e95` confirms it — the log shows *seeded SMOKE-PHARM-MAIN (id 2) as the active default facility*, and the 409 `PHARMACY_FACILITY_REQUIRED` is gone. What replaced it is a 403 `PHARMACY_FACILITY_GRANT_REQUIRED`, *"The authenticated actor has no current pharmacy facility authority"*, from `pharmacyFacilityAuthorityService.js:294`. **That is not a role mismatch:** `FACILITY_OPERATION_ROLES` (`:53-61`) explicitly admits ADMIN and SUPER_ADMIN, so unlike OPEN-11 the backend does not exclude administrators from this surface by design. It requires something narrower — a matching `staff` row (the LEFT JOIN's `actor.staff_id` must be non-null) AND an active `pharmacy_staff_facility_grants` row for that actor and facility (`:298-306`). The crawl's SUPER_ADMIN has neither. **So the page assumes an actor-level facility grant that a role-eligible administrator may legitimately not hold** — which is the OPEN-11 shape one level in: a page whose reach exceeds the per-actor authority behind it. Also confirmed by this run: the route crawl is now honest. It reported `1 of 125 dashboard route(s) failed`, so it crawled every route rather than stopping at the first — **pharmacy was not hiding a queue; it is the only broken route.** | **Owner decision, and the two readings imply different fixes.** Either (a) the smoke environment should model an ASSIGNED administrator — seed the `staff` row and an active facility grant, which makes the crawl represent a pharmacy-operating identity; or (b) the PAGE should treat "no facility grant" as a legitimate empty state rather than firing a call that 403s, which is what a real administrator who has not been assigned a facility will hit in production. (b) is the same repair as OPEN-11 and fixes a real user's experience rather than only the synthetic one; (a) is cheaper and keeps the crawl exercising the populated page. Do NOT add this to `EXPECTED_DARK_GATE_RESPONSES`: it is a 403 authorization boundary, not a deliberate dark gate, and waiving it would hide a live precondition while turning the tier green. |
| OPEN-26 | **Half fixed (PR #986); the R8 half is instrumented rather than fixed, deliberately.** PR #982 — a four-file ADMIN-ONLY change — needed three CI runs to land, failing twice on unrelated backend suites and passing the third with no code change. **(1) FIXED:** `document-integrity.deep.test.js` failed to run with `23503`, `DELETE FROM tenants` blocked by `fk_audit_log_tenant`. Its teardown ordering was already correct — it deletes `audit_log` and `audit_logs` before `tenants` — so the cause was a late asynchronous audit write landing between the two and recreating the FK child. The suite already anticipated this class for a different table (`waitForPhiAuditWrites` exists because the PHI logger writes after the response); the same settling now covers `audit_logs` via a bounded retry on 23503. **(2) STILL OPEN:** `patient-data-import-vitals.deep.test.js` R8 failed with `40001` (could not serialize) and `23505` under `Promise.all`. Whether the TEST is racy — refusing a legitimate alternative interleaving — or the service path should retry `40001` and does not is **not established**: the CI logs expired before it could be determined, and the importer already retries `40001` on another path, so a guess had even odds of fixing the wrong side. The failure now reports the driver SQLSTATE rather than a bare rejection, so the next occurrence answers the question. | Let R8 fail once more and read the SQLSTATE it now names, then fix the side the evidence indicates. **Do not rerun until green** — a green rerun proves nothing about a race; amplify instead. The cost of this row is not the wasted cycles but that a red backend shard currently trains everyone to rerun rather than read, which is how a real regression eventually gets waved through. |

### Low

| ID | Finding | What would settle it |
| --- | --- | --- |
| OPEN-10 | **Linux/macOS Staff screen-capture protection is still unimplemented.** Windows is the documented desktop pilot, so this is currently latent — it becomes a release blocker the moment either additional desktop is supported. | Implement per-platform capture protection, or record an owner decision restricting Staff desktop to Windows. |
| OPEN-19 | **Several product workflows remain callerless or deliberately one-way.** Re-verified on `61e7dcf7a`. **Wholly callerless HTTP surfaces** (zero references anywhere in `apps/admin/src`, `apps/patient/lib`, `apps/staff/lib`): the admin reward catalogue and voucher redemption (`app.js:1889`; `adminGamificationRoutes.js:4-9` records its own callerlessness); the step-rewards router (`app.js:1336` — `/rewards/badges`, `/badges/check`, `/vouchers`, `/leaderboard/monthly`, `/my-monthly-rank`, and the ADMIN-gated write `/issue-monthly`); all 12 research-registry routes (`app.js:1702`); all 5 paediatric-immunisation routes (`app.js:2140`); all 4 document-integrity routes (`app.js:1669`) — **including `POST /integrity/sign`, so this is a write-and-read gap, not a read-only one**: signatures are minted only server-side (`encounterRoutes.js:180`, `diagnosticResultActionService.js:498`, `inpatientPathwayDomainService.js:4144`, `referralClosedLoopService.js:1284`) and the chain verifier runs only from `scheduler.js:330`; and all 5 bed-inspection routes (`app.js:1455`). **Partially callerless:** surgical documentation now mounts at `/api/v1/surgical` (`app.js:1946`, 308 from the legacy `/api/v1/admin/surgical` at `:1880`) and exactly one of its 21 endpoints has a production caller — `PUT /surgical/safety/:scheduleId/:phase` (`apps/staff/.../theatre_api_service.dart:99`); preop, intraop, postop, anaesthesia-record, implant and complication writes have none. Structured maternity capture is likewise partial: partograph and labour admissions are wired from Staff (`maternity_screen.dart:81`, `partograph_entry_screen.dart:94`) and Admin (`dashboard/maternity/page.tsx:73,188`), and the newborn-immunisation family from Admin (`dashboard/immunisations/page.tsx:130,201,211,389,574`), while `POST /maternity/pregnancies`, `PATCH /pregnancies/:id`, `POST /anc-visits`, `POST /labor-admissions`, `POST /deliveries`, `POST /newborns`, `POST /newborns/:id/apgar`, `POST /postnatal-visits`, `POST /supplements` and `POST /immunisations/up-to-date` still have no client. **PR #973 (`2c429d561`) does not close any part of this row:** its files are all under `apps/backend`, it added no client caller, and it hardened `updatePregnancy` actor context plus a fail-closed patient pregnancy-id guard. **Correction to the earlier wording:** the patient-facing gamification surface is *not* callerless — `POST /gamification/checkin` and `POST /gamification/milestones/:id/claim` are called from `daily_checkin_sheet.dart:115` and `health_points_screen.dart:252` — but the loop can neither start nor close while the catalogue and redemption halves have no client; the one unused patient-router route is `GET /gamification/adherence-risk/:patientId`. Ask-a-Doubt is accurate as previously recorded: the dead reply path is deleted (`feedbackRoutes.js:68-73`), patients submit only, and there is no staff reply or patient answer rendering. | Product/clinical owner either authorizes an end-to-end client workflow with role and lifecycle tests or records the surface as intentionally restricted/retired. ROADMAP `:402-451` (gamification / step-rewards loop) and `:846-1111` (research registry, surgical documentation, maternity, paediatric immunisations, document signatures, bed inspections, Ask-a-Doubt). The previous `:374-423,818-1069` anchors did not resolve to this content even at `a4ffe9860`, and `docs/ROADMAP.md` moved 205 lines in this wave. |

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
