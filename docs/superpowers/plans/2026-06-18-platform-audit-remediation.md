# Platform Audit Remediation — Execution Plan & Tracker

- **Branch:** `fix/platform-audit-2026-06-18` (base `5f8c5303`)
- **Source of findings:** `docs/PLATFORM_AUDIT_2026-06-18.md`
- **Approved decisions (2026-06-18):** everything in one branch; merge to main at tier checkpoints (ArgoCD-pin lands first → main deploy-safe); best-judgment on design-laden items.
- **Local gates (GHA billing-blocked):** backend `npm --prefix apps/backend run lint` + chunked `npm --prefix apps/backend run test:ci`; admin lint+type-check+jest+build; mobile `melos run analyze` + targeted `flutter test`; infra `kubectl kustomize`.
- **Orchestration rules:** parallel agents own **non-overlapping file-sets**; hot shared files (`app.js`) edited by orchestrator after agents report; **migration numbers centrally allocated** below; each agent works TDD (failing test → fix → focused test green) and runs its own focused tests; orchestrator runs the domain/full gate per (sub-)wave before commit.

## Migration ledger (allocated)
| # | Owner | Purpose |
|---|---|---|
| 317 | W1 money | `billing_payments` safe partial-unique idempotency index (guarded vs existing dups) |
| 318 | W1 med-rec | reconciliation discrepancy columns (if needed) |
| 319 | W1 theatre | OR-booking `EXCLUDE USING gist` overlap constraint (btree_gist, guarded) |
| 320 | W1 reliability | `notification_outbox` drain index |
| 321 | W1 interop | cross-replica HMAC replay store (or Redis) |
| 322+ | W2+ | appointments double-booking constraint, etc. (allocated when dispatched) |

> Constraint migrations MUST be safe-on-existing-data: detect dups and `RAISE EXCEPTION` with a clear dedupe message rather than failing cryptically; create extensions guarded.

---

## W0 — Safety + deploy foundation  ·  status: IN PROGRESS
| id | fix | files | status |
|---|---|---|---|
| W0.1 | Pin ArgoCD off `HEAD` (manual prod sync gate) | `infra/kubernetes/base/argocd/applications/{apps,platform}.yaml` | todo |
| W0.2 | cosign: add key-based attestor matching the Forgejo signer (key operator-supplied) | `infra/kubernetes/base/image-policy/kyverno-verify-images.yaml` | todo |
Gate: `kubectl kustomize infra/kubernetes/apps` + `…/base/cnpg`.

## W1 — Criticals  ·  status: pending
Money (1 agent): idempotency on V2 payment/advance/refund/settle/link routes; `FOR UPDATE`+`setTenantTx` on collect/settle/recompute; atomic advance balance; claims/preauth/payer state-transition guards; mig 317.
Clinical escalation/SLA (1 agent): T2/T3 real delivery; ack→`completeWorkflowSla`; lab/investigation SLA resource-key unify; investigation `enqueueCriticalResultTask`.
Med-rec (1 agent): ingredient-level change/omission detection + block on high-alert omission; mig 318.
Theatre (1 agent): canonical timeline+audit on surgical writes; status `FOR UPDATE`+from-state predicate; OR exclusion (mig 319); WHO sign-out + consent-at-start gates.
Bed+vitals (1 agent): retire legacy `bedService.admit/discharge` (route to admissionService/bedManagementService); atomic vitals critical-alert persistence.
Reliability (1 agent): cron leader-lock (pg advisory) in `withJobLock` + remove in-process twins of externalized CronJobs; `notification_outbox` drain cron (mig 320); drop `tenant_rls` from readiness; logger writable path.
Auth (1 agent): refresh-token `type==='refresh'` + real refresh tokens + rate-limit; admin 2FA fail-closed; delete `totpRoutes` (orchestrator removes its `app.js` mount).
Interop (1 agent): ABDM + HL7 inbound tenant binding; ABDM consent-artifact verification; cross-replica replay store (mig 321); rate-limit inside the routers.
Gate: backend lint + chunked test:ci.

## W2 — High  ·  status: pending
FHIR oracle+`/Patient` directory scoping; `requireConsent` wiring; audit-chain hardening (scheduled verifier, HMAC+anchor, append-only); cron fan-out tenant scoping (escalateStuckOrders, drugChartSla); rbacService tenant scoping; billing tenant-filter+RBAC (V1 PHI logging, claim IDOR, cash-out roles); appointments double-booking constraint; mobile PHI-at-rest (patient docs encrypt+purge; staff offline queue encrypt+scope; root-stub; Windows capture); admin `NEXT_PUBLIC_API_KEY` removal; medications.price float→numeric.

## W3 — Medium  ·  status: pending
Upload `validateFileContent` coverage; idempotency hardening (no 5xx cache, tenant-scope, expiry); rate-limit→Redis store; observability (route-label UUID collapse, morgan query redaction, Sentry breadcrumbs, key-aware log redaction, prod-only monitoring gates); AI hardening (injection normalize, fail-closed egress, patient-surface enable assertion); SMART scope enforcement; medium clinical/data/mobile items.

## W4 — Low  ·  status: pending
Password floors; composite/FK indexes; dead-code removal (admin (protected)/ProtectedRoute/SystemAlerts/dead actions); doc/config drift (express.json 1mb→10mb, STATEMENT_TIMEOUT note); misc grouped lows.

## Operator-gated (prep code/config, flag for cluster — cannot complete here)
Kyverno Audit→Enforce; seal `vhhealth-pg-runtime` non-superuser role; timed DR drill; secret rotation; real image digest bootstrap; monitoring stack deploy.

## Already fixed (since audit / by drift)
- revenue-cycle `parseTenantId` query-fallback removed (commits e7265c75, 5f8c5303).

## Progress log
- **W0 DONE** — `62e8c59c` (ArgoCD manual sync + cosign attestor). kustomize green.
- **W1a DONE** — `d7fd0211` (money idempotency/FOR UPDATE/state-guards mig 317; reliability advisory-lock/outbox-drain mig 320/readiness/logger; auth refresh-type/2FA/totpRoutes; interop ABDM+HL7 tenant-binding/consent-verify/replay mig 321). 11 suites/258 tests green.
- **C-9 patient-refresh companion DONE** (background tasks) — `79a22493` + firebaseAuthService returns refresh token, authController reads body.refreshToken, vhhealth_core http_client sends it. Admin refresh = pre-existing non-critical limitation (admin not in `users`).
- **bed validator** — `1605d37c` (admitValidation requires resolvable patient ref).
- **W1b DONE** — `67920133` (escalation/SLA delivery+ack-stops-clock+lab-key-unify+investigation-task; med-rec change-detection mig 318; theatre canonical+locks+OR-exclusion mig 319+sign-out/consent gates; bed legacy-bypass retired + atomic vitals criticals; billingV2 unit tests realigned; schema.prisma regen +interop_replay_guard). 16 suites/355 tests green; lint green; schema-drift clean.
- **W1 full chunked test:ci gate** — passed (1 pre-existing chunk-1 failure, fixed in `373db42d` — stale clinical_ai_tenant_modules QA-DB rows, test-isolation only).
- Migrations 317–321 applied to QA DB + recorded.
- **W2a DONE** — `07d6a300` (FHIR oracle→403-both + /Patient directory restriction + requireConsent on $everything; audit append-only triggers mig 324 + scheduled chain verifier; escalateStuckOrders per-tenant + drugChartSla recipients tenant-scoped + rbacService assignRole/toggleUserStatus actor-tenant-confined; appointments double-booking mig 322 + float→numeric mig 323). 11 suites/121 tests + lint + drift green.
- **W2b DONE** — `e138db4f` (patient docs encrypted at rest + temp purge on logout + real root detection; staff offline-queue encrypted + staff_id-scoped + VACUUM + Windows capture exclusion; admin NEXT_PUBLIC_API_KEY removed + CI guard). patient/core/staff analyze clean + 149+99 patient/core tests; admin lint+type-check+build.
- **W3 DONE (partial)** — `71e67473` (upload magic-byte validation on prescription/staff/KB; idempotency 5xx-no-replay + expiry; observability route-label/morgan/Sentry-breadcrumb/key-aware-redaction + monitoring fail-closed off-prod; CPOE CDS fail-closed + canonical-swallow→42P01-only + NEWS2 in-tx/partial/loud + discharge canonical events + markBedReady proof; prompt-injection NFKC+zero-width normalize). lint green.
- Migrations 322/323/324 applied + recorded; schema.prisma drift-clean.
- **Final full chunked test:ci gate** — RUNNING (then merge branch → main).

## DEFERRED to follow-up (medium/low; lower-risk, have compensating controls)
W3 mediums not yet done (the ai-data-mobile agent died after only the injection-detector fix):
- **AI external-egress fail-closed default** — `localLlmClient.js` `tenantCanUseExternal()` returns true when `CLINICAL_AI_EXTERNAL_REGIONS` unset; flip to deny-by-default. (Compensating: `CLINICAL_AI_ALLOW_EXTERNAL` + per-module gates still required.)
- **Patient-surface enablement assertion** — block enabling any `settings.surface==='patient'` module in `clinicalAiModuleService` enable path. (Compensating: patient surfaces are off; two-person+eval governance already enforced.)
- **Perf/unique index migration (was 325)** — `(tenant_id, patient_uid)` composite indexes on hot PHI tables; partial-unique on `e_prescriptions.prescription_number` + `pharmacy_orders.order_number`.
- **cycle_tracker at-rest encryption** — `apps/patient/.../period_tracker/models/cycle_tracker.dart` move from plaintext SharedPreferences to the encrypted store. (Compensating: cleared on logout.)
Other deferred mediums (from the audit, not yet scheduled): SMART-on-FHIR scope enforcement at the FHIR boundary; FHIR conformance golden-bundle CI; ABDM HMAC over raw bytes; admin WS-ticket-out-of-URL + origin-check consolidation; documentRoutes CCDA/fhir-bundle consent gate (skipped to avoid the CDS/documents oracle test).
Known pre-existing bug filed as background task: drugChartSla 42P08 audit-insert; canonicalOperationalBridge safeCanonical broad swallow.

## W4 — Low (not started)
Password floors (min 6→8); composite/FK indexes (overlaps the deferred perf-index migration); dead-code removal (admin (protected)/ProtectedRoute/SystemAlerts/dead actions, staff biometric/remember-me); doc/config drift (express.json 1mb→10mb vs HTTP_BODY_LIMIT, STATEMENT_TIMEOUT note, SESSION_HANDOFF stale); misc grouped lows from the audit §5.

## 4-parallel-session review + corrected all-green (2026-06-18 eve) — local main `577ba1df`, NOT pushed
Reviewed the 4 background/sibling-session commits (drug-chart 42P08 `f87987db`, admitValidation `1605d37c`, C-9 patient-refresh `79a22493`, safeCanonical narrowing `1bd21671`): all individually correct. A clean **`jest --bail=0` full sweep** (the chunked `test:ci` runner stops at the first failing chunk, so prior gates only proved a prefix — the pre-merge "full green" was overstated) surfaced **7 latent failures, all fixed → 655/655 suites, 8468 tests, 0 fail**:
- **REAL: admin 2FA was non-functional** — `totp_challenges` table was never created by any migration. Created → **migration 325** (`ff9846c9`).  ⚠️ The deferred "perf/unique index migration" above must now use **326+**, not 325.
- **REAL: injection-detector regression** — W3 newline-collapsing normalizer broke the newline-anchored `INSTRUCTION_BLOCK_INJECTION` rule; now scans raw text (`577ba1df`).
- **5 stale tests** vs correct W1/W3 behavior: billingV2FrontOfficeAudit + tpa-journey (idempotency-key required; `7971e740`/`caff5cd6`), mfa-enforcement (mig 325), priorAuth from-state guard + paymentLink `setTenantTx` 2nd arg (`577ba1df`), future-proof stale AI-module rows (`373db42d`).
- The two "known pre-existing bug" background tasks above are now BOTH FIXED: drug-chart 42P08 (`f87987db`) + canonicalOperationalBridge safeCanonical swallow (`1bd21671`).
- Migrations now **317–325**. Branch synced to main. Authoritative all-green = `jest --bail=0 --maxWorkers=2` (a single chunked run never proves full green).

---

## Wave D + W4 completion (2026-06-19) — local `main` `a831a1ee`, NOT pushed (HOLD)

Finished the deferred tail. All on branch `fix/platform-audit-2026-06-18`, ff-merged to local `main` per batch. NOT pushed (hold stands; origin=Forgejo canonical, github=mirror).

**Commits (chain `92d79a82` → `a831a1ee`):**
- **Wave D** `403a83e2` — deferred MEDIUMs: AI external-egress fail-CLOSED (`localLlmClient.tenantCanUseExternal`, `*` sentinel, `validateEnv` region var); patient-surface enablement assertion (`clinicalAiModuleService`); SMART scope-enforcement middleware (`fhirRoutes.enforceSmartScopes` — no-op on JWT path, **DORMANT** until an app.js SMART mount-shim, a product follow-up); **migration 326** ((tenant_id,patient_uid) composites + e_prescriptions/pharmacy_orders partial-unique); admin WS-ticket-off-URL (first-frame auth msg) + consolidated origin/CSRF check (`csrfOrigin.ts`) on 7 auth routes. Gate: `--bail=0` **659/659 suites, 8508 pass / 8 skip / 0 fail**; admin lint+type-check+jest(416).
- **cycle_tracker** `f9dcc614` (MEDIUM) — patient menstrual PHI moved plaintext SharedPreferences → `VHSecureStorage` (Keystore/Keychain), one-time write-before-delete migration + purge, clear-on-logout preserved, 10 tests. flutter analyze clean + 14 tests.
- **W4 lows #1** `76998646` — password floors 6→8 at all SET-time paths (routed through `SECURITY_CONFIG.password.minLength`; admin **LOGIN** validator deliberately left min:6 to avoid locking out pre-floor accounts); admin dead-code removal (5 files / 345 lines: empty `(protected)` group, `ProtectedRoute`, `SystemAlerts` component [live data layer kept], 2 dead server-action modules). Gate: backend lint + 201 tests; admin lint+type-check+jest(416)+build.
- **W4 lows #2** `a831a1ee` — reliability: selfHealing `routeErrors` Map bounded (LRU 1000); archive + R2 jobs under `withJobLock`; wardDowntime INTERVAL parameterized; Sentry `attachUserContext` moved after `jwtAuth`; `express.json` reads `HTTP_BODY_LIMIT` (default 1mb) + configmap/ingress/CLAUDE.md drift reconciled. auth-hygiene: MFA verify keyed by IP+challengeToken-hash; password-reset OTP cap reads securityConfig; storage/document routes stop leaking `err.message`; dev-OTP gated behind `ALLOW_DEV_OTP` (fail-closed in prod). Gate: backend lint + 137 tests (incl. app-boot smoke) + kustomize.
- **Staff dead-code:** investigated → **removed nothing** — biometric/remember-me is LIVE (backend endpoints + `vhhealth_core` BiometricAuthService + rendered settings toggle + passing tests; `local_auth` used by tests; remember-me is a rendered-but-unused UX toggle). Fixed the stale staff docs that called it "future/missing" (`apps/staff/CLAUDE.md` + `apps/staff/test/README.md`).

**Migrations now 317–326.**

### Final gate — GREEN (2026-06-19) + two real issues caught + corrected gate mechanics
Authoritative full-suite run = **`node apps/backend/scripts/run-ci-jest.mjs` (chunked, `--runInBand` per chunk) connected as the `postgres` superuser** → **All chunks passed, 0 fail** on a clean rebuilt DB. Getting there corrected how the gate must be run AND surfaced two genuine bugs (both now fixed, both uncommitted on the branch awaiting the commit below):

- **`jest --bail=0 --maxWorkers=2` is NOT reliable for this suite.** A pre-existing shared-phone race — multiple deep suites hardcode `9000030001`–`05` with *different* UIDs but clean up *by UID* — collides under concurrency; the 3 new W4 test files shifted jest's worker scheduling and exposed it. The chunked runner runs each chunk `--runInBand` (no concurrency race) in a fresh process (no single-process OOM that plain `--runInBand`-over-all-662 hits). **Use the chunked runner as the authoritative local gate.**
- **The test harness must connect as the `postgres` superuser.** Several deep suites legitimately UPDATE/DELETE audit tables (cleanup + tamper-detection simulation), which migration 324's append-only guard blocks for non-super by design (the guard's superuser branch exists for exactly this). RLS/append-only suites `SET LOCAL ROLE` to non-super roles so they still assert correctly. (Running as `qa_writer` made ~9 deep suites fail on `P0001`/`42501` — a red herring that cost several full sweeps.)
- **REAL prod bug fixed — `canonicalClinicalPlatformService.recordClinicalAuditEvent`.** It used `ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key` (a no-op upsert) on `clinical_audit_events`. Under the sealed **non-super prod role**, migration 324's append-only guard turns that UPDATE into `P0001`, which aborts the enclosing clinical-write tx — so an idempotent audit re-record would break the clinical write in production. The superuser test harness masked it. Rewrote as a single CTE: `INSERT … ON CONFLICT … DO NOTHING RETURNING` `UNION ALL` read-back of the existing row — append-only-safe, still returns the row on conflict (so `documentIntegrityService` `sig.audit_event_id = events.audit.id` linking still works), single query (mock-sequenced unit tests unaffected). Verified passing under non-super `qa_writer`. Swept all six audit tables — this was the ONLY runtime hazard (the `audit_log` retention purge already sets `app.audit_bypass`).
- **CI-setup ordering fixed — `seed-icd10-local.mjs`.** Migration 275 federates `icd10_codes`→`terminology_concepts` *during* the migration chain, but `ci-setup-db` seeds the 221-code catalog *after* migrations, so terminology held zero ICD-10 concepts and `codingValidationService` marked every real code `validated:false` (broke `clinicalCodingAssist`). The seed now re-runs 275's federation (idempotent) after populating the catalog (221 concepts on a fresh DB).

**Lesson (DB):** never drop the long-lived QA DB casually — a fresh `ci-setup-db` rebuild needs the six extensions created BEFORE migrations (baseline has no `CREATE EXTENSION`), grants applied AFTER the schema exists (run `qa-cluster-up` last), and reveals latent setup-ordering issues (terminology federation). Full reset recipe in `[[tools_vhhealth_qa_cluster]]`.

### DEFERRED with rationale (NOT done — for a user decision)
Each was consciously left; each has a stated reason + compensating control:
- **SMART-on-FHIR live mount (app.js shim)** — enforcement middleware is built+tested+**dormant**; opening a SMART-bearer auth path into the PHI FHIR API is a product/security decision (audit called it a follow-up). Compensating: JWT path unaffected; no SMART bearer accepted today.
- **documentRoutes CCDA/fhir-bundle consent gate** — adding it risks re-opening the CDS/documents patient-existence oracle (see `project_vh_health_careteam_enforce_oracle`); needs the in-route-403-both pattern, not a mount guard.
- **ABDM HMAC over raw bytes** — changing signature canonicalization risks breaking the live ABDM integration for marginal gain.
- **FHIR conformance golden-bundle CI** — GHA is billing-blocked here; the informational FHIR validator + existing non-blocking `fhir-conformance` job are the compensating controls.
- **`staff.salary` / leave `float` → `numeric`** — money-type correctness, but a column-type migration with payroll-calc blast radius; lower stakes than billing money (already numeric).
- **`applyOrderSet` per-item failure surfacing** — clinical behavior change needing product input.
- **Clinical enhancements (not bugs):** neonate/infant vital band; NEWS2 idempotency key; OR-board override-rate metric.
- **Patient release minify/obfuscation** — build-pipeline change needing on-device release testing.
- **Staff session-row lifecycle** (logout drop row + `authenticateStaff` session row) — intertwines with the recently-hardened refresh-token flow (C-9); compensating: tokens are JWT-blacklisted on logout/rotation (revocation works); missing piece is per-session tracking.
- **`adminOtpRoutes`/`validateApiKey` mount-order quirk** — fail-closed today (no live risk).
- **selfHealing `healingActions` array** also unbounded (far slower leak; not the named finding) — trivial to bound later.
- **Cosmetic:** same-number migration files (disjoint); dev-login double-gating; iOS background modes; release-variant debug-signing fallthrough (true release guarded); patient latent analytics PHI shape (no callers — not active).
