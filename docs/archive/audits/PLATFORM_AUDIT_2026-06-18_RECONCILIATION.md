# Platform Audit 2026-06-18 — Per-Finding Reconciliation

- **Verified:** 2026-06-19, against current code at **`main @ 116aa01f`** (remediation range `5f8c5303..116aa01f`).
- **Method:** 7 read-only verification auditors, one per domain, each confirming the actual cited code at HEAD (not the remediation plan's claims) with `file:line` + commit evidence. Headline "untouched" claims re-confirmed via `git log <range> -- <file>`.
- **Legend:** ✅ fixed · ⏸️ consciously deferred (compensating control) · 🔧 operator-gated (needs cluster action) · ❌ not done / partial / regressed.

> **Correction to the earlier status:** prior summaries stated "all criticals + all highs done." That was the wave-level label, not a per-finding truth. This reconciliation showed the **criticals ~all closed** but **several HIGH items were never addressed**.
>
> **Follow-up fixes since this reconciliation (2026-06-19, TDD + gated):**
> **Batch A** — C-4b ABDM consent-artefact threading (`8fc850f5`), admin CSV formula-injection (`202a3908`), allergy severity-downgrade + fail-open UNION (`11d09c9d`), MAR lock-free dup-guard mig 327 (`d7550fd7`), audit-writer durable fallback (`76382052`), ABDM callback shared replay (`08e542f0`), revenue-cycle cron per-tenant fan-out (`d9957c73`), token aud/iss enforcement (`26a68691`).
> **Batch B** — clinical-safety SLA/canonical atomicity for referral/handover/MAR(schedule/missed/held)/bed-cleaning (`57cc251f`); SUPER_ADMIN 2FA step-up on the admin-portal control planes + a newly-found 2FA challenge-verify timezone bug that would have locked out every 2FA admin (`8f00e565`).
> **Batch B (cont.)** — triage-chatbot fail-closed on unparseable output + critical safety flag (`161b28be`).
> The per-finding lines below are flipped accordingly. **Remaining High ❌ (1):** the iOS `com.example` bundle id (release-config change — needs the iOS toolchain + Firebase reconfig, deliberately deferred).

## Tally (≈140 sub-findings)

| Tier | ✅ | ⏸️ | 🔧 | ❌ |
|---|---|---|---|---|
| Critical (C-1…C-9) | 27 | 0 | 0 | 2 |
| High (§3) | ~35 | 3 | 4 | 1 |
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
- ✅ **ABDM consent-artifact verification — route gap fixed (`8fc850f5`, 2026-06-19).** The route now extracts `consentArtefact` (consentDetail/consentArtefact, flat or nested under `consent.*`) + `signature` and threads them into `_verifyConsentArtefact` (`abdmRoutes.js:99`); covered by `abdmConsentArtefactVerification.test.js` (5 tests: route extraction + verifier valid/tampered/missing/disabled). Still operator-gated (flag off + ABDM disabled). *[was 🟡 latent-broken — verifier existed but the route never passed it the inputs.]*
- ✅ HL7 `/receive` tenant binding (no default fallback) — `hl7Routes.js:73` (`d7fd0211`)
- ❌ **Per-tenant inbound secrets — not done.** Both paths still use one global secret. (Audit scoped this as a multi-tenant-SaaS blocker; single-tenant-safe today.)

### C-5…C-9 — ✅ all
C-5 cron `pg_try_advisory_lock` in `withJobLock` + externalized-twins removed; C-6 outbox drain cron (`SKIP LOCKED`); C-7 `tenant_rls` dropped from readiness; C-8 file transports silent in prod + writable path + guarded mkdir; C-9 refresh `type==='refresh'` + real refresh tokens + rate-limit. (`d7fd0211`, `07d6a300`, `71e67473`)

---

## 3. Highs

### Auth / session
- ✅ Admin 2FA fail-closed on TOTP-insert-fail — `authService.js:329` + mig 325
- ✅ Divergent `totpRoutes` deleted — file gone (`d7fd0211`)
- ✅ **2FA login challenge-verify tz bug fixed (`8f00e565`)** — `totp_challenges.expires_at` was bound as a client JS Date → reinterpreted across the Node/DB timezone gap → stored ~5.5h in the PAST, so `expires_at > NOW()` was always false and login-time challenge-verify *always failed* (would lock out every 2FA admin once enabled). Now computed server-side (`NOW() + INTERVAL`). Surfaced by the first-ever integration test of the challenge-verify path (`mfa-enforcement.deep.test.js` sc.7). *[newly-found latent bug, not in original audit]*
- ✅ **Token audience/issuer enforcement (`26a68691`)** — `verifyToken`/`verifyTokenAllowExpired` call `assertAudienceAndIssuer` after `jwt.verify`; throws only when a *present* claim is wrong-realm (missing = backward-compat no-op). `generateToken` defaults `iss=vh-health-backend` + per-role `aud`. Unit-tested (`jwtAudienceIssuer.test.js`).
- ✅ **SUPER_ADMIN un-scoped master key — scoped behind 2FA step-up (`8f00e565`)** — new `requireSuperAdminStepUp` mounted on the admin-portal control planes (`/api/v1/admin`, `/admin/gamification`, `/system`, `/logs`): a SUPER_ADMIN relying on the blanket bypass must hold a 2FA-verified session (JWT `mfa:true`, stamped only by the TOTP enroll-confirm / login challenge-verify paths, carried onto `req.user` by jwtMiddleware) else `403 SUPER_ADMIN_MFA_REQUIRED`. Normal ADMINs unaffected; recovery endpoints sit outside the gate. Unit + deep-tested (`superAdminStepUp.test.js`, `mfa-enforcement.deep.test.js` sc.7/8); operational activation = GO_LIVE B6. Cross-tenant override compensating control (reason+audit) also retained.

### Multi-tenancy / RLS — ✅ all 3
`escalateStuckOrders` per-tenant; `runMissingDrugChartSweep` nurse-recipient + `notifications.tenant_id` explicit; `rbacService.assignRole/toggleUserStatus` actor-tenant-scoped. (`07d6a300`, `f87987db`)

### Revenue cycle / billing
- ✅ **Revenue-cycle tracker cron fans out per-tenant (`d9957c73`)** — new `runRevenueCycleSweepAllTenants()` iterates `tenants` with per-tenant fault isolation; `scheduler.js` calls it (flag-gate/cadence/withJobLock unchanged). Unit-tested.
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
- ✅ **Audit writers durable fallback (`76382052`)** — queue-full drop / deferred-write failure / swallowed patient-access audit now route to a Winston file sink; the unresolved-patient case emits a marked file-sink record instead of dropping. (`auditLog.js`, `hipaaAudit.js`, `accessDecisionService.js`.) Unit-tested.

### Clinical core & safety (beyond C-2/C-3) — ⚠️ 5 of 6 UNTOUCHED
- ✅ WHO sign-out gate + consent-at-incision — `theatreService.js:384,559` (`67920133`)
- ✅ **Referral response-SLA atomic (`57cc251f`)** — `createReferral` persists the referral + canonical `referral.requested` + `startWorkflowSla('referral_response')` in one `setTenantTx`. Deep-tested (`referral-canonical-atomicity.deep.test.js`).
- ✅/❌ **MAR** — **lock-free dup-guard FIXED (`d7550fd7`)**: migration 327 partial-unique `uniq_mar_administered_dose` makes a second administered row for the same (patient_uid, medication_name, scheduled_time) impossible regardless of concurrency; `23505`→`MAR_DUPLICATE_ADMINISTRATION`; deep-tested. ✅ residual also fixed (`57cc251f`): `scheduleMedications`/`recordMissed`/`holdMedication` now write the canonical MAR event inside `setTenantTx` (re-throws non-42P01 so the detail row + canonical event are atomic); `recordAdministration` was already in-tx. Deep-tested (`mar-canonical-atomicity.deep.test.js`).
- ✅ **Handover canonical atomic (`57cc251f`)** — `createHandover`/`acknowledgeHandover` persist the canonical event inside `setTenantTx`. Deep-tested (`handover-canonical-atomicity.deep.test.js`).
- ✅ **Allergy SEVERE→warning degrade + UNION fail-open — FIXED (`11d09c9d`)**: `rankSeverity` fails safe (present-but-unparseable → SEVERE; explicit no-claim sentinels stay 0) and the prescription gate ranks severity instead of matching a hardcoded label set; `getUnifiedActiveAllergies` queries each source independently so one source's schema fault degrades only that source. Unit-tested.
- ✅ **Cleaning-turnaround SLA atomic + clock reconciled (`57cc251f`)** — bed-keyed `bed_cleaning_turnaround` SLA started in-tx from `dischargePatient`/`transferPatient`, completed in-tx by `markBedReady`; dispatch clock reconciled 120→30 min (mig 269 canonical target). Deep-tested (`bed-cleaning-sla-atomicity.deep.test.js`).

### Clinical AI
- 🔧 Patient RAG chatbot — still no in-route enable-gate / full `runOutputDefenses`; safe only because module is OFF + a new admin-side enable guard (`403a83e2`). No in-service fail-closed assertion.
- ✅ **Triage chatbot fail-closed on bad/dangerous output (`161b28be`)** — parse-failure no longer echoes raw model text to the patient (returns a safe canned escalation + logs raw server-side), and a **critical** output-defense flag now BLOCKS the parsed content instead of returning it (was log-only). Shared `buildBlockedTriage` (`see_doctor_now`, no `raw`, `blocked:true`, flags surfaced); non-critical flags still annotate. Unit-tested (`triageService.test.js` — raw-not-leaked / critical-blocks / non-critical-annotates). Still dormant until a live model provider is selected.

### FHIR / HL7 / ABDM (beyond C-4)
- 🔧 ABDM consent-artifact crypto-verify — built, flag-gated; operator must enable + supply CM public key (also see C-4b route gap above)
- ✅ Unauthenticated ABDM/HL7 inbound rate-limited — `abdmRoutes.js:24`, `hl7Routes.js:31`
- ✅ **ABDM callback shared replay store (`08e542f0`)** — `validateABDMRequest` (now async) runs `assertSharedReplayOnce({replayNamespace:'abdm-callback', …})` fail-closed (mirrors HL7), using the cross-replica store (mig 321). Unit-tested (`abdmCallbackSharedReplay.test.js`).

### Data layer — ✅ all
money mutations atomic; `appointments` double-booking partial-unique (mig 322); `medications.price` + `investigation_template_tests.cost` → `numeric(12,2)` (mig 323).

### Mobile — patient + core
- ✅ Downloaded docs encrypted at rest (AES-256-GCM); ✅ temp PHI purged on logout; ✅ root-detect stub replaced (native su/Magisk channel not yet implemented — emulator probe live); ✅ secure_storage singleton (v10 Keystore default)
- ❌ **iOS bundle id still `com.example.vhhealth`** (Android keystore handling fixed)

### Mobile — staff — ✅ all 4
offline queue AES-256-GCM; staff_id-scoped (no cross-user drain); Windows `WDA_EXCLUDEFROMCAPTURE`; device-integrity gate (native caveat as above).

### Admin / infra
- ✅ `NEXT_PUBLIC_API_KEY` removed + CI guard (`check-no-public-secrets.mjs`)
- ⏸️ Admin appointment tenant predicate — relies on RLS (single-tenant-latent) / ✅ **CSV formula-injection FIXED (`202a3908`)**: the export builds via the new `src/utils/csv.js` (`rowsToCsv`/`escapeCsvField` — formula-neutralized + RFC-4180-quoted); unit-tested.
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
1. ~~Clinical-safety highs~~ — **ALL FIXED.** MAR lock-free dup-guard (mig 327, `d7550fd7`), allergy SEVERE-downgrade & fail-open UNION (`11d09c9d`), and referral/handover/MAR(schedule/missed/held)/bed-cleaning SLA + canonical atomicity incl. 120→30-min clock reconcile (`57cc251f`). Deep-tested.
2. ~~Audit writers lossy~~ — **FIXED (`76382052`)**: queue-full / deferred-fail / unresolved-patient now route to a durable file sink.
3. ~~Admin appointment CSV formula-injection~~ — **FIXED (`202a3908`)** via `rowsToCsv`/`escapeCsvField`.
4. ~~ABDM callback HMAC replay~~ — **FIXED (`08e542f0`)**: shared cross-replica store, fail-closed (mirrors HL7).
5. ~~**C-4b ABDM consent-verify** route never passes the artifact~~ — **FIXED (`8fc850f5`)**: route now threads the artefact + signature into the verifier; unit-tested.
6. ~~Token aud/iss enforcement; SUPER_ADMIN un-scoped bypass~~ — **both FIXED**: `26a68691` (aud/iss validation), `8f00e565` (SUPER_ADMIN 2FA step-up on admin-portal control planes **+ a newly-found 2FA challenge-verify timezone bug that would have locked out every 2FA admin**).
7. **C-1 `billingService.updateClaimStatus`** from-state guard (legacy path) — still open.

**Medium concern:** idempotency on clinical mounts; `getHealthStatistics` fake zeros; canary downgrade; `completeChecklist` rewrite-lock; rate-limit Redis store. *(revenue-cycle cron fan-out — FIXED `d9957c73`; triage raw-text/critical-flag fail-open — FIXED.)*

**Operator-gated (🔧):** seal non-super DB role + kubeseal secrets; Kyverno Audit→Enforce (cosign secret); SMART mount-shim; ABDM consent-verify enable + CM key; monitoring ArgoCD auto-sync; DR drill / monitoring deploy / secret rotation / external pen-test-cert.

**Low / defense-in-depth:** staff.salary numeric; applyOrderSet; OR-board metric; Prometheus aborted; patient minify; iOS bundle id; FileProvider; mock-location; per-route guard; FCM/SOS debugPrint.

---

*Generated by 7 read-only verification auditors against `main @ 116aa01f`; every ✅ confirmed at the cited `file:line`, every ❌ confirmed untouched/partial in the remediation range.*
