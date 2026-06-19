# Platform Audit 2026-06-18 — Per-Finding Reconciliation

- **Verified:** 2026-06-19, against current code at **`main @ 116aa01f`** (remediation range `5f8c5303..116aa01f`).
- **Method:** 7 read-only verification auditors, one per domain, each confirming the actual cited code at HEAD (not the remediation plan's claims) with `file:line` + commit evidence. Headline "untouched" claims re-confirmed via `git log <range> -- <file>`.
- **Legend:** ✅ fixed · ⏸️ consciously deferred (compensating control) · 🔧 operator-gated (needs cluster action) · ❌ not done / partial / regressed.

> **Correction to the earlier status:** prior summaries stated "all criticals + all highs done." That was the wave-level label, not a per-finding truth. This reconciliation shows the **criticals are ~all closed** (2 small residuals) but **several HIGH items were never addressed** — most importantly the "Clinical core & safety (beyond C-2/C-3)" subsection (5 of 6 items untouched), the three lossy audit-writer paths, token aud/iss enforcement, and a live admin CSV-injection.

## Tally (≈140 sub-findings)

| Tier | ✅ | ⏸️ | 🔧 | ❌ |
|---|---|---|---|---|
| Critical (C-1…C-9) | 26 | 0 | 0 | 2 (+1 latent-broken) |
| High (§3) | ~22 | 3 | 4 | ~11 |
| Medium (§4) | 21 | 13 | 3 | 6 |
| Low (§5) | 16 | 7 | 0 | 6 |

---

## 2. Criticals

### C-1 Billing V2 double-charge + lost-update
- ✅ Idempotency on V2 money routes — `billingV2Routes.js:357,405,432,514,714` `requireIdempotencyKey({required:true})` (`d7fd0211`)
- ✅ `billing_payments` partial-unique idempotency index — `migrations/317:50` (`d7fd0211`)
- ✅ `FOR UPDATE` + `setTenantTx` on collect/settle/recompute — `billingV2Service.js:104,1139,1238,281,1312` (`d7fd0211`)
- ✅ Atomic advance balance (lost-update) — conditional decrement `billingV2Service.js:1359` (`d7fd0211`)
- ✅ Claims/preauth/payer state-transition guards — `claimsService.js:66,83`, `priorAuthorizationService.js:324` (`d7fd0211`)
- ❌ **`billingService.updateClaimStatus` (legacy V1) still has no from-state guard** — `billingService.js:482-515` got tenant-scoping but only an enum check; the cited `approved→denied`/`paid→submitted` flip is still accepted on this path. (Primary TPA verdict paths ARE guarded.)

### C-2 Clinical-safety lifecycle — ✅ all 6
med-rec ingredient/omission detection + completion block; theatre canonical+audit; `updateStatus` `FOR UPDATE`+from-state; OR `EXCLUDE USING gist` (mig 319); legacy `bedService.admit/discharge` rewritten; atomic loud-failing vitals criticals. (`67920133`, `1605d37c`)

### C-3 Escalation never pages — ✅ all 4
T2/T3 real recipient delivery; ack→`completeWorkflowSla`; lab-key unified (`lab_result`); investigation `enqueueCriticalResultTask`. (`67920133`)

### C-4 ABDM/HL7 cross-tenant inbound
- ✅ ABDM inbound tenant scoping + multi-tenant-ABHA rejection — `abdmService.js:302,416,708,822` (`d7fd0211`)
- 🟡 **ABDM consent-artifact verification — latent-broken.** Verifier + config-driven CM id exist (`abdmService.js:327`), but the route never extracts `consentArtefact`/`signature` (`abdmRoutes.js:89`) → if `ABDM_VERIFY_CONSENT_ARTEFACT` is enabled it would reject **every** consent. Flag off today.
- ✅ HL7 `/receive` tenant binding (no default fallback) — `hl7Routes.js:73` (`d7fd0211`)
- ❌ **Per-tenant inbound secrets — not done.** Both paths still use one global secret. (Audit scoped this as a multi-tenant-SaaS blocker; single-tenant-safe today.)

### C-5…C-9 — ✅ all
C-5 cron `pg_try_advisory_lock` in `withJobLock` + externalized-twins removed; C-6 outbox drain cron (`SKIP LOCKED`); C-7 `tenant_rls` dropped from readiness; C-8 file transports silent in prod + writable path + guarded mkdir; C-9 refresh `type==='refresh'` + real refresh tokens + rate-limit. (`d7fd0211`, `07d6a300`, `71e67473`)

---

## 3. Highs

### Auth / session
- ✅ Admin 2FA fail-closed on TOTP-insert-fail — `authService.js:329` + mig 325
- ✅ Divergent `totpRoutes` deleted — file gone (`d7fd0211`)
- ❌ **Token audience/issuer enforcement** — admin login now emits `iss`/`aud` claims but `jwtUtils.js:98` `verifyToken` never validates them; realm separation still role-claim-only.
- ❌ **SUPER_ADMIN single un-scoped master key** — blanket RBAC bypass intact (`rbacMiddleware.js:51`), no per-namespace scoping / `mfa:true`. Partial compensating control: cross-tenant override now needs a reason + is audited.

### Multi-tenancy / RLS — ✅ all 3
`escalateStuckOrders` per-tenant; `runMissingDrugChartSweep` nurse-recipient + `notifications.tenant_id` explicit; `rbacService.assignRole/toggleUserStatus` actor-tenant-scoped. (`07d6a300`, `f87987db`)

### Revenue cycle / billing
- ❌ **Revenue-cycle tracker cron still default-tenant-only** — service is tenant-parameterized but `scheduler.js:543` calls `runRevenueCycleSweep({})`; no fan-out. (Flag-gated off + advisory read-model.)
- ✅ `billingService.updateClaimStatus` tenant filter (+ `appealLetterGenerator.loadClaim`)
- ✅ Cash-out paths re-gated to `requireCashOut` (excludes receptionist/nurse)
- ✅ TPA decision+payment idempotency/state-guards
- ✅ V1 billing routes now have PHI logging + audit — `app.js:1121`

### PHI / consent / ABAC / audit
- ✅ FHIR enumeration oracle closed (403-both) — `fhirRoutes.js:635,776`
- ✅ FHIR `GET /Patient` directory-scoped (role-limited + `role='PATIENT'`)
- ✅ requireConsent mounted on `$everything` export (export-surface by design; single-resource reads stay on RBAC+ABAC)
- ✅ Audit append-only triggers on all 6 audit tables (mig 324) + hourly advisory-locked verifier with loud alert
- ⏸️ Audit chain HMAC keying + off-box anchor — explicitly deferred (documented)
- ❌ **Audit writers still best-effort/lossy** — `auditLog.js:405` drop-on-full (no fallback on that path), `hipaaAudit.js:37` fire-and-forget, `accessDecisionService.js:964` swallow + no row when patient unresolved. **All 3 untouched.**

### Clinical core & safety (beyond C-2/C-3) — ⚠️ 5 of 6 UNTOUCHED
- ✅ WHO sign-out gate + consent-at-incision — `theatreService.js:384,559` (`67920133`)
- ❌ **Referral response-SLA** best-effort outside tx — `referralService.js` untouched
- ❌ **MAR** canonical outside tx + **lock-free dup-guard** (no `FOR UPDATE`, no unique index) — `marService.js` untouched
- ❌ **Handover** SBAR canonical best-effort — `handoverService.js` untouched
- ❌ **Allergy SEVERE→warning degrade + UNION fail-open** (one source's fault blanks all allergies) — `allergySourceService.js` untouched
- ❌ **Cleaning-turnaround SLA** best-effort + 30-vs-120-min clock mismatch — `bedManagementService.js`/`housekeepingTaskDispatchService.js`

### Clinical AI
- 🔧 Patient RAG chatbot — still no in-route enable-gate / full `runOutputDefenses`; safe only because module is OFF + a new admin-side enable guard (`403a83e2`). No in-service fail-closed assertion.
- ❌ **Triage chatbot returns raw model text on JSON-parse failure** — `triageService.js:233`; defenses annotate but don't block. Arms when a live provider is selected.

### FHIR / HL7 / ABDM (beyond C-4)
- 🔧 ABDM consent-artifact crypto-verify — built, flag-gated; operator must enable + supply CM public key (also see C-4b route gap above)
- ✅ Unauthenticated ABDM/HL7 inbound rate-limited — `abdmRoutes.js:24`, `hl7Routes.js:31`
- ❌ **HMAC replay store wired for HL7 only; ABDM callback still process-local `Map`** — `signedRequest.js` shared store (mig 321) not invoked by `abdmRoutes.js:54`. Replay across replicas/after-restart not caught. (Unintentional omission; ABDM disabled today.)

### Data layer — ✅ all
money mutations atomic; `appointments` double-booking partial-unique (mig 322); `medications.price` + `investigation_template_tests.cost` → `numeric(12,2)` (mig 323).

### Mobile — patient + core
- ✅ Downloaded docs encrypted at rest (AES-256-GCM); ✅ temp PHI purged on logout; ✅ root-detect stub replaced (native su/Magisk channel not yet implemented — emulator probe live); ✅ secure_storage singleton (v10 Keystore default)
- ❌ **iOS bundle id still `com.example.vhhealth`** (Android keystore handling fixed)

### Mobile — staff — ✅ all 4
offline queue AES-256-GCM; staff_id-scoped (no cross-user drain); Windows `WDA_EXCLUDEFROMCAPTURE`; device-integrity gate (native caveat as above).

### Admin / infra
- ✅ `NEXT_PUBLIC_API_KEY` removed + CI guard (`check-no-public-secrets.mjs`)
- ⏸️ Admin appointment tenant predicate — relies on RLS (single-tenant-latent) / ❌ **CSV formula-escape NOT applied — `appointmentAdminRoutes.js:404` hand-rolls CSV, bypassing the `escapeCsvField` helper → live CSV-injection via PHI fields**
- 🔧 cosign key-based attestor added; operator must create the secret + flip Kyverno to Enforce
- ✅ ArgoCD `apps`/`platform` auto-sync removed (⚠️ `monitoring.yaml` still auto-syncs HEAD; ⏸️ project `namespaceResourceWhitelist` still `*`)
- 🔧 Runtime DB-role sealing + alert/backup secrets — prepped in-repo; operator must seal the role + kubeseal real secrets

---

## 4. Mediums (§4) — 21 ✅ / 13 ⏸️ / 3 🔧 / 6 ❌

✅ upload magic-byte validation (presc/staff/KB); idempotency 5xx-no-cache + tenant-scope + expiry; V2 billing tenant-threading; appeal cron per-tenant; observability (Prometheus UUID/phone collapse, morgan token redaction, paymentLink, Sentry breadcrumb, key-aware redaction, infra-access prod-gating); AI (injection NFKC normalize, egress fail-closed); reliability (graceful-shutdown stops crons, boot-stampede gate, escalation no-HTTP-in-tx, bounded sweeps); clinical (CPOE CDS fail-closed, canonical swallow→42P01-only, critical-vital→on-shift task, NEWS2 atomic, anaesthesia atomic, discharge sign() in-tx, markBedReady sync); cycle_tracker encrypted; admin WS-ticket-off-URL + origin/CSRF consolidation.

⏸️ rate-limit Redis store (still MemoryStore ×workers — *fell out of the deferred list, effectively undocumented*); default-tenant fallbacks; permissive `scopedTx`; ops tables w/o tenant_id; `payment_transactions` untenanted (**audit's "verify dead" was wrong — it's live**); output-defenses heuristic; MD5/SHA-256 secrets; backup freshness (externalized); payroll TZ; staff med-favorites; Firebase config; dalekdefender/staff-web/Dockerfile infra.

🔧 SMART scope enforcement (built+tested, dormant until app.js mount-shim); ABDM HMAC-over-raw-bytes (HL7 done, ABDM not); semgrep/OSV/Trivy-misconfig advisory (Trivy+npm-audit blocking, rest triaged).

❌ **idempotency `required:true` on clinical mounts** (only money done); **FCM/SOS phone `debugPrint`** (low); **FHIR conformance golden-bundle gate** (no golden files); **`getHealthStatistics` returns fake zeros on DB error** (violates own convention); **canary write-check downgrades real failure to `skip`**; **`completeChecklist` can rewrite pre-incision WHO items** (forward-progression gates added, rewrite-lock not); plus mobile defense-in-depth (FileProvider root paths, idle-timeout reactive clear, mock-location check, per-route role guard) + Forgejo digest-bot pushes main.

---

## 5. Lows (§5) — 16 ✅ / 7 ⏸️ / 6 ❌

✅ password floors 6→8 (set-time; login deliberately permissive); OTP cap via config; dev-OTP behind `ALLOW_DEV_OTP` (fail-closed in prod); MFA keyed by IP+challenge; mig 299 guarded; composite `(tenant_id,patient_uid)` indexes + presc/pharmacy partial-uniques (mig 326); admin dead-code (×4) removed; verbose-error scrubbed; selfHealing Map LRU-bound; Sentry mount-after-jwt; wardDowntime INTERVAL param; archive/r2 jobLock; express.json `HTTP_BODY_LIMIT`; patient dev-login + release-signing guards.

⏸️ logout session-row not dropped (JTI blacklist compensates); same-number migrations (cosmetic); med-rec change_detail audit-only (reconstructable); no infant/neonate vital band (explicit); NEWS2 idempotency; CSP `unsafe-eval` (stage-2; `unsafe-inline` removed); patient analytics PHI shape (no callers); iOS background modes.

❌ **`authenticateStaff` refresh token has no session row** (access-token half done); **`staff.salary` still `double precision`** (off billing path); **`applyOrderSet` per-item failures** (sentinel-logged, not raised); **OR-board override-rate not surfaced** as a distinct metric; **Prometheus aborted requests uncounted** (`finish`-only); **patient release minify/obfuscation** not enabled.

---

## 6. Genuine open gaps, prioritized

**Higher concern (clinical-safety + security correctness):**
1. Clinical-safety highs untouched — **MAR lock-free dup-guard / canonical-outside-tx**, **allergy SEVERE→warning + UNION fail-open**, referral/handover SLA best-effort, cleaning-SLA + clock mismatch.
2. **Audit writers lossy** (auditLog drop-on-full, hipaaAudit fire-and-forget, accessDecision swallow) — contradicts "audit never lost."
3. **Admin appointment CSV formula-injection** (live) — route bypasses the `escapeCsvField` helper.
4. **ABDM callback HMAC replay** still process-local (HL7 fixed, ABDM not).
5. **C-4b ABDM consent-verify** route never passes the artifact (would reject all consents if the flag is enabled).
6. **Token aud/iss enforcement** (claims emitted, never validated); **SUPER_ADMIN** un-scoped bypass.
7. **C-1 `billingService.updateClaimStatus`** from-state guard (legacy path).

**Medium concern:** triage raw-text-on-parse-fail; idempotency on clinical mounts; `getHealthStatistics` fake zeros; canary downgrade; `completeChecklist` rewrite-lock; revenue-cycle cron fan-out; rate-limit Redis store.

**Operator-gated (🔧):** seal non-super DB role + kubeseal secrets; Kyverno Audit→Enforce (cosign secret); SMART mount-shim; ABDM consent-verify enable + CM key; monitoring ArgoCD auto-sync; DR drill / monitoring deploy / secret rotation / external pen-test-cert.

**Low / defense-in-depth:** staff.salary numeric; applyOrderSet; OR-board metric; Prometheus aborted; patient minify; iOS bundle id; FileProvider; mock-location; per-route guard; FCM/SOS debugPrint.

---

*Generated by 7 read-only verification auditors against `main @ 116aa01f`; every ✅ confirmed at the cited `file:line`, every ❌ confirmed untouched/partial in the remediation range.*
