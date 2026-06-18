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
- **W1 full chunked test:ci gate** — RUNNING (then merge W1 → main, start W2).
- Migrations 317–321 applied to QA DB + recorded.
