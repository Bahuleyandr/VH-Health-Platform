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
