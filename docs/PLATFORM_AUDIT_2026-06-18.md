# VH Health Platform — Full Deep Audit (Merged)

- **Date:** 2026-06-18
- **Commit:** `main @ 75fd9cbef226ac5fdb6b060b7910b7662cd4cc6b`
- **Mode:** Read-only. No files changed by either audit.
- **Sources merged into this report:**
  1. **Audit A (this one):** 14 parallel read-only domain agents (auth, multi-tenancy/RLS, PHI/consent/ABAC, clinical-core/safety, revenue/billing, clinical-AI, FHIR/HL7/ABDM, data/SQL/migrations, admin portal, patient app+core, staff app, infra/supply-chain, reliability/observability, doc-reconciliation), each verifying against current code, with lead spot-checks on the top criticals.
  2. **Audit B (independent auditor):** 9 findings, same commit (~877k tokens / ~20 min). Reconciled and folded in below.

Every finding cites `path:line`. Findings are marked **[A]**, **[B]**, or **[A+B]** (corroborated by both — highest confidence). Confidence is the agent's, refined by lead spot-checks where noted.

> The prior full audit is `docs/PLATFORM_AUDIT_2026-06-13.md`; the live remediation ledger is `docs/PLATFORM_REMEDIATION_PLAN.md`; operator activation is `docs/GO_LIVE_ACTIVATION_CHECKLIST.md`. This report **verifies against current code** and separates genuinely-new findings from the already-tracked baseline.

---

## 1. Executive summary

**Overall verdict: B — solid and materially improved, but not yet production-proven where it matters most.**

The platform is well-engineered and well past the prior "B−" framing in its *core*: multi-tenant RLS is real, fail-closed, and test-proven; the canonical clinical-timeline atomicity invariant is correctly implemented in the high-frequency writers; the clinical-AI governance substrate is among the better designs of its kind; admin-portal and patient-app security have been thoroughly hardened; and the IaC (pod security, NetworkPolicies, CNPG role design) is mature.

The risk is **concentrated and consistent**, and lives in:
1. **Newer / less-audited code** — billing V2, revenue-cycle tracker (shipped 2026-06-18), results-inbox/escalation.
2. **Clinical-safety lifecycle logic** the prior audit never went deep on — escalation delivery, SLA-clock completion, med-rec change detection, theatre/surgical atomicity.
3. **Operational correctness** — the cluster/worker + cron model.
4. **Latent multi-tenant / "enforce-flip" seams** — safe today single-tenant, but they arm together at the SaaS cutover or the RLS/ABAC enforce flip.

Two independent passes converged on the tenant-isolation seams (ABDM, admin-appointment RLS-reliance) and the infra activation gaps — those are real and should not be deferred as one auditor's opinion.

### Grade by sub-domain

| Sub-domain | Grade | One-line |
|---|---|---|
| Multi-tenant RLS core | A− | Strong, fail-closed, test-proven; holds single-tenant |
| Clinical-AI governance | B+ | Fail-closed defaults; 2 ungoverned patient surfaces |
| Admin portal (Next.js) | A− | Exemplary token/proxy/CSP; one API-key footgun |
| Patient app + core | B+ | Real cert-pinning/App-Check; PHI-at-rest gaps |
| Data layer / migrations | B+ | Disciplined; 2 money-path defects |
| Infra / k8s / supply chain | B+ | Mature; cosign scheme mismatch |
| FHIR / HL7 / ABDM interop | B / B− | Strong crypto; inbound tenant-binding gaps |
| Auth / session | B− | Mature but real token + 2FA defects |
| Clinical core & safety | C+ | Core atomic; safety-lifecycle holes |
| Revenue cycle / billing V2 | C+ | Double-charge + lost-update |
| Reliability / cron model | C+ | Multi-fire + un-drained outbox |

---

## 2. Critical findings (fix before go-live)

### C-1 — Billing V2: double-charge + lost-update on real money `[A+B]`
- **No idempotency + no DB uniqueness on payments** — `apps/backend/src/routes/billing/billingV2Routes.js` (POST `/payments`), `apps/backend/src/services/billing/billingV2Service.js:~1140`, `apps/backend/src/migrations/149_billing_core.sql:156`. `requireIdempotencyKey` is not used on the V2 money routes, and `billing_payments.reference` has no UNIQUE constraint (verified by grep). A retry / double-click / gateway-webhook replay inserts a second real payment row → invoice over-credited, phantom collection. Same exposure for advances, refunds, payment-links.
- **Balance mutations are read-compute-write with no lock/transaction** — `billingV2Service.js:253` (`recomputeInvoicePaymentState`), `:1085` (`collectPayment`), `:1228` (`settleAdvance`). Verified: **zero `FOR UPDATE` in the entire `services/billing/` tree**. Two concurrent payments both read `amount_due` and both succeed → overpayment; `settleAdvance` writes an *absolute* balance (classic lost update).
- **No state-machine guards on claims/preauth/payer-decision** — `claimsService.js:1841` (`recordClaimDecision`), `:1912` (`recordClaimPayment`), `billingService.js:482` (`updateClaimStatus`), `priorAuthorizationService.js:289` (`recordPayerDecision`). `insurance_claims.status` is a bare varchar with no CHECK; `paid→submitted`, `rejected→paid`, `approved→denied` all accepted. A `denied` flip auto-spawns appeal workflows.
- **Impact:** direct financial loss + AR/settlement-state corruption. **Confidence: high** (double-found + grep-verified).
- **Fix:** wrap each money mutation in `setTenantTx` + `SELECT … FOR UPDATE`; add `requireIdempotencyKey({required:true})` on payment/advance/refund/settle/link routes; add a partial unique index `billing_payments(tenant_id, reference, mode) WHERE reference IS NOT NULL`; introduce `from→to` transition maps (pattern already exists in `submitAppealLetter`).

### C-2 — Clinical-safety lifecycle holes `[A]`
- **Med-rec performs no change/omission detection** — `medicationReconciliationService.js:72-85, 479-569`. `mergeMedicationLists` dedupes by lowercased name; `completeReconciliation` only checks each item got *a* decision. An omitted home anticoagulant/insulin/AED is never flagged; brand≠generic; reconciliation "completes." Core safety purpose absent. **Fix:** ingredient-level (RxNorm/ATC) diff → per-item `discrepancy_type`; block completion on unaddressed omission/dose-change for high-alert classes; run `evaluateMedicationSafety` on the reconciled list.
- **Entire theatre/surgical subsystem is invisible to the canonical timeline + audit** — `services/theatre/*` (theatreService, orBoardService, surgicalDocumentationService, anesthesiaChartService) import no canonical writer. Every surgical write persists only its detail row (no timeline/audit). No medico-legal trail for wrong-site override, retained-object close, implant placement. **Fix:** wrap each mutator in a tx + `recordCanonicalClinicalEvent({...},{db:tx})`.
- **Theatre `updateStatus` is check-then-act with no lock + no from-state predicate** — `theatreService.js:428-479`. UPDATE lacks `AND status=$current` and there's no `FOR UPDATE`/tx → a case can be double-started or advanced past a safety gate (incl. the WHO-timeout gate) a concurrent tx invalidates.
- **OR double-booking is `force`-bypassable, no DB exclusion constraint** — `orBoardService.js:111-159`; migration 154 adds only a plain btree index. **Fix:** `EXCLUDE USING gist (ot_room WITH =, tenant_id WITH =, tsrange(start,end) WITH &&) WHERE status NOT IN ('cancelled','completed')`.
- **Legacy `bedService.admitPatient`/`dischargePatient` are live and bypass everything** — `bedService.js:759-815`, routed at `bedController.js:206,222`. Discharge flips bed straight to `available` (skips `cleaning`/infection-control), starts no SLA/housekeeping ticket, writes no canonical event, **and does not close the `admissions` row** (patient "admitted to nowhere"). **Fix:** route the controller to `admissionService`/`bedManagementService`.
- **Vitals CRITICAL-alert persistence is non-atomic and downgraded to a `warn`** — `vitalsChartService.js:638-668` + `vitalSignMonitor.js:290-396`. A second simultaneous critical vital can be dropped while the POST returns 200.
- **Impact:** patient harm (undetected med errors, lost surgical trail, double-start, dropped critical alert). **Confidence: high.**

### C-3 — Critical-result escalation that never reaches a human `[A]`
- **Escalation tiers T2/T3 record intent but never page** — `escalationEngineService.js:183-229`. Enqueue to `notificationOutbox` with `recipientPhone:null`; that outbox is **never drained** (see C-6). The only guaranteed signal is a T1 priority bump visible if someone opens the inbox.
- **Acknowledging a critical result never stops the SLA clock** — `taskService.js:387-446` flips the task to `in_progress` but never calls `completeWorkflowSla`; instance stays active/breached forever, and the backfill re-creates a fresh task for an already-handled result (false re-alerts). Lab path compounds: producer keys `sourceTable='lab_result'`, ack completes `'investigations'`/`'lab_critical_alerts'` — never `'lab_result'` (`labResultsService.js:391` vs `canonicalOperationalBridgeService.js:473-536`).
- **Investigation critical results get no ack-task / no tier for the first ~15 min** — `investigationService.js:924-938` starts the SLA but never calls `enqueueCriticalResultTask` (unlike lab/vitals).
- **Impact:** "no critical result falls through the cracks" is only partially true. **Confidence: high** (some self-documented in code). **Fix:** resolve role → on-shift users → real delivery (FCM/SMS) as `drugChartSlaService` already does, or drain the outbox; complete the linked SLA on ack/complete.

### C-4 — ABDM + HL7 inbound: cross-tenant patient writes under one global secret `[A+B]`
- **ABDM inbound data-export has zero tenant scoping** — `abdmService.js:283/284, 308, 514, 579, 653-831`. The callback router mounts public + pre-tenant-context (`app.js:515`, before jwtAuth/tenantContext). `handleConsentRequest` resolves the patient by ABHA with no `tenant_id`; `handleDataRequest`/`collectHealthData` filter only by `patient_uid`; `abdm_consents`/`abdm_data_requests` inserted without explicit tenant → DB default may stamp the default tenant for non-default patients. One ABHA matched globally exports a full record across tenant boundary.
- **HL7 `/receive` writes admissions/lab-results to any patient in any tenant** under one shared `HL7_INBOUND_SHARED_SECRET` — `hl7Routes.js:45` (mounted `app.js:562` pre-tenant). `loadHl7Patient` resolves with no tenant scope.
- **Impact:** cross-tenant PHI export + clinical-integrity (injected lab results). **Single-tenant-safe today; a hard blocker for the multi-tenant SaaS direction.** **Confidence: high** (corroborated by both audits). **Fix:** thread the consent/sender's tenant into every collection query (or wrap in `setTenant(tenant,…)`); per-tenant inbound secrets.

### C-5 — Multi-process cron multi-fire `[A]`
- Verified: `cluster.js` forks `CLUSTER_WORKERS` workers; each worker `import('./bin/www.js')` which registers all ~40 in-process crons and calls `runAllScheduledTasksNow()`; **no leader gate**. `withJobLock` (`scheduler.js:12`) dedupes via an in-process `Set` only. With `CLUSTER_WORKERS=2 × replicas=3 = 6` processes, every mutating sweep without its own DB claim runs up to 6×.
- Confirmed-unsafe (no DB claim): `retryFailedNotifications`, `sendAppointmentReminders`/`processPendingScheduledNotifications`, `runEscalationSweep` (read-modify-write on `tasks.metadata`), `runUnreadCriticalEscalation`, `runPausedWorkflowSweep`, monthly-payroll first run. Outage-critical jobs (`backup-db`, `ward-downtime-packs`, `canary-health-check`) **also** still run in-process despite dedicated k8s CronJobs (`scheduler.js:128-134,204-206,350-352`) → e.g. 6 concurrent nightly `pg_dump`.
- **Impact:** duplicate patient SMS, double clinical escalations/audit rows, money-path race, resource spikes. **Confidence: high.** **Fix:** single-runner gate (`RUN_SCHEDULER` env on one replica/worker) or `pg_try_advisory_lock(hashtext(jobName))` inside `withJobLock`; delete the in-process twins of the externalized CronJobs.

### C-6 — `notification_outbox` is written but never drained `[A]`
- `notificationOutbox.queue()` (`notificationOutbox.js:93-110`) persists intent as `PENDING`; `getPendingForRetry()` has **zero callers**; the retry cron reads `failed_notifications`, not the outbox. Writers include breach notifications, lab critical alerts, results-inbox escalation (its own comment admits the channel isn't drained), discharge, claims.
- **Impact:** the durable-retry guarantee is inert; critical-lab/breach/escalation notices are lost on inline-send failure. Contradicts CLAUDE.md "notification never lost." **Confidence: high.** **Fix:** add a `withJobLock`+`SKIP LOCKED` drain cron, or route all writers through the live `failed_notifications` path.

### C-7 — Readiness probe gates traffic on RLS *security posture* `[A]`
- `uptimeRoutes.js:93-118` includes a `tenant_rls` check in `/health/ready`; `ready = every(c==='ok')`. `tenantRlsRolePosture()` returns `ok:false` for `effective_role_bypasses_rls` / `owner_exempt_unforced_tables` / `replica_role_bypasses_rls`. The k8s readiness probe execs this (`deployment.yaml:156-190`).
- **Impact:** an RLS misconfig (unforced table after a migration, a bypassing role) makes **every replica fail readiness simultaneously → full API outage** from a security warning. **Confidence: high.** **Fix:** drop `tenant_rls` from readiness; keep it a loud boot ERROR (exists) + metric + alert. Readiness checks DB reachability only.

### C-8 — Prod logger writes file transports to a read-only filesystem `[A]`
- `logger.js:15-18` `mkdirSync('../logs')` at import; `transports.File` registered for error/combined/daily-rotate; `fileTransportsSilent` is `isTest` only (not prod). The container has `readOnlyRootFilesystem:true` with writable mounts only at `/tmp`, `/app/tmp`, `/app/node_modules/.prisma`.
- **Impact:** EROFS at module load (unguarded) → boot-crash risk; at minimum continuous file-write errors. (Note: the dalekdefender test overlay sets `readOnlyRootFilesystem:false` so it doesn't reproduce there.) **Confidence: high.** **Fix:** `fileTransportsSilent = isTest || isProduction`, or point `logsDir` at a writable mount; wrap `mkdirSync` in try/catch.

### C-9 — Public refresh endpoint accepts access tokens (no type check, no rate limit) `[A]`
- Verified: `authService.js:818-876` `refreshToken` calls `verifyTokenAllowExpired(token)` and checks only the jti blacklist + user existence — **no `decoded.type === 'refresh'`**. Patient/admin get no separate refresh token, so the access token *is* the refresh credential. Route is mounted before `validateApiKey`/`jwtAuth` and carries no `authRateLimiter` (`authRoutes.js:60,78`, `app.js:509`).
- **Impact:** a captured (even already-expired) access token whose jti was never blacklisted can be rotated into a fresh live session, unthrottled — nullifies the short-access-token mitigation. **Confidence: high (verified).** **Fix:** require `decoded.type==='refresh'`; issue real refresh tokens for patient/admin; add `authRateLimiter` to `/refresh-token` and `/token`.

> **Severity note:** C-5/C-6/C-7/C-8 were reported by the reliability agent as "critical-class" reliability/ops defects; C-9 is a critical-class auth defect requiring possession of a (possibly expired) token. Treat all as must-fix but sequence behind the money + clinical-safety criticals if forced to choose.

---

## 3. High findings

### Auth / session `[A]`
- **Admin 2FA silently bypassed if the TOTP-challenge insert fails** — `authService.js:303-330` ("fall through to normal login"). A DB error degrades 2FA-enabled admins to password-only. **Fix:** fail closed.
- **Second, divergent TOTP implementation references non-existent columns** — `routes/auth/totpRoutes.js` (mounted `app.js:686`) reads `admins.totp_secret`/`totp_enabled_at`/`totp_backup_codes` (schema has `totp_secret_encrypted`/`totp_enrolled_at`) and mints tokens with the integer id as `uid`. Latent foot-gun; **delete it**.
- **No token audience/issuer enforcement** — `jwtUtils.js:64-104`; `verifyToken` checks signature+exp only, one shared secret across realms. Only the `role` claim + `requireRole` separates a patient token from an admin token.
- **SUPER_ADMIN is a single un-scoped master key** with three bypass layers + a `SUPER_ADMIN→ADMIN` normalization seam (`jwtMiddleware.js:51-56` vs `roles.js`). **Fix:** scope the bypass per sensitive namespace or require `mfa:true`.

### Multi-tenancy / RLS (residual; core is strong) `[A]`
- **Two cron notification fan-outs cross tenant** — `escalateStuckOrders` (`utils/notifications/stuckOrderEscalation.js`) selects admins with no tenant filter and mixes all tenants' counts; `runMissingDrugChartSweep` (`drugChartSlaService.js:222/278/339`) resolves nurse recipients role-only and mis-stamps `notifications.tenant_id` to the literal default.
- **rbacService cross-tenant user mutation** — `rbacService.js:304` (`changeRole`), `:566` (`toggleUserStatus`) update `users WHERE phone=$1` (globally unique) inside a bare `$transaction` (RLS permissive). A tenant-A admin who knows a tenant-B phone can change that user's role/status.

### Revenue cycle / billing `[A]`
- **Tracker cron sweeps only the default tenant** — `revenueCycleTrackerService.js:190` + `scheduler.js` (`runRevenueCycleSweep({})`). Every other tenant's denied-PA/appeal cases are silently never tracked.
- **`billingService.updateClaimStatus` has no tenant filter** — `billingService.js:482`, `billingRoutes.js:319` (`findUnique`/`update` by `id` only on SERIAL ids). Cross-tenant claim IDOR when RLS flag is off; defense-in-depth debt when on. Same in `appealLetterGeneratorService.loadClaim` (`:448`, accepts but ignores `tenantId`).
- **Cash-out paths reachable by non-finance staff** — `billingV2Routes.js` `/refunds/:id/pay`, `/advances`, `/advances/:id/settle` gated by `requireStaffOrAdmin` (clears receptionist/nurses). Segregation-of-duties failure.
- **No idempotency / double-submit guard on TPA decision + payment** — `claimsService.js:1841,1912` → duplicate settlements.
- **V1 billing routes have no PHI logging and no audit on money mutations** — `app.js:1107` (only V2 mount has `billingPhiAccessLogger`).

### PHI / consent / ABAC / audit `[A]`
- **Consent enforcement is dead code** — `requireConsent` (`consentMiddleware.js:20`) mounted nowhere (verified zero call sites). A revoked/absent consent blocks no PHI read.
- **FHIR is a latent enumeration oracle** — `fhirRoutes.js:513` (mount `app.js:778`): present-but-unresolvable patient → 404, existing-no-relationship → 403 under enforce. Arms on the CareTeam enforce flip. CDS-invoke/documents set the safe "403-both" precedent; FHIR doesn't follow it.
- **FHIR `GET /Patient` search has no relationship scoping** — `fhirRoutes.js:526` returns the whole tenant directory (name/phone/email/DOB/address), all roles, even with no params.
- **Audit "hash chain" is theatrical** — `migrations/282_audit_hash_chain_esign.sql:45`: single-table (`clinical_audit_events` only), unkeyed SHA-256, no off-box anchor; verifier (`integrityRoutes.js:76`) runs only on a manual admin endpoint (no cron); no audit table has append-only protection (no `BEFORE UPDATE/DELETE`/`REVOKE`). App DB role can edit/delete + re-hash undetectably; `audit_log`/`hipaa_access_log` are unchained.
- **Audit writers are best-effort/lossy** — `auditLog.js:405` (drop-on-full ≥1000), `hipaaAudit.js:37` (setImmediate fire-and-forget), `accessDecisionService.js:964` (swallow; no row when patient unresolved). Contradicts "never lost."

### Clinical core & safety (beyond C-2/C-3) `[A]`
- **Referral domain writes all canonical + the response-SLA best-effort, outside the tx, swallowed** — `referralService.js:64-71,417-458,…`. If `startWorkflowSla('referral_response')` fails, the SLA never starts.
- **MAR schedule/missed/held write canonical outside any tx; cross-row dup-guard is lock-free** — `marService.js:246-503` (only `recordAdministration` passes `db:tx`), dup guard `:349-368` (TOCTOU → double-charting). `recordCanonicalMarEvent` swallows all errors.
- **Handover canonical events best-effort/outside-tx** — `handoverService.js:35-42` (SBAR safety artifact can vanish from timeline).
- **Allergy severity can degrade SEVERE→warning + union fail-open** — `allergySourceService.js:30-73`, `prescriptionSafetyCheck.js:802-807`. Non-canonical severity labels rank 0; a single source's schema fault zeroes the whole UNION.
- **Cleaning-turnaround SLA best-effort + two clocks disagree (30 vs 120 min)** — `bedManagementService.js:260-677`, `housekeepingTaskDispatchService.js`. Vacated beds can skip cleaning-SLA tracking.
- **No WHO sign-out gate; consent only checked at close** — `theatreService.js:243-341,439-462`.

### Clinical AI `[A]`
- **Patient RAG chatbot bypasses the module-enable gate AND the review queue** — `patientChatbotService.js:143-189` returns model text straight to the patient with no `requireEnabledModule` and only `detectPhiLeaks` (not full `runOutputDefenses`). Safe only because the module is off; no in-route assertion enforces that.
- **Triage chatbot returns raw model text to patients on JSON-parse failure** — `triageService.js:222-244` (`summary: rawText`); outside the governed substrate. Default provider `template` + model id `claude-opus-4-8` (current/valid). Arms when an operator selects a live provider.

### FHIR / HL7 / ABDM (beyond C-4) `[A]`
- **ABDM consent artifact is never cryptographically verified** — `abdmRoutes.js:77`, `abdmService.js:261` trusts the notification body and self-fabricates consent (`consentManager:{id:'sbx'}` hardcoded). **Fix:** verify the CM-signed artifact.
- **Unauthenticated ABDM/HL7 inbound have no rate limiting** — `app.js:515,562` (DB work before/around the HMAC check → brute-force/DoS surface).
- **HMAC replay protection is process-local** — `signedRequest.js:14` (`new Map()` per process); defeated by the 3-replica cluster. **Fix:** shared store (Redis `SETNX`/unique-insert).

### Data layer `[A]`
- **Money mutations not atomic; `appointments` has no double-booking constraint; `medications.price` is `double precision` (float money)** — `billingV2Service.js` (zero `$transaction`), `000_baseline.sql:1354`, `000_baseline.sql:12304`/`schema.prisma:6189`. (`investigation_template_tests.cost` is the same float class and flows into billing.)

### Mobile — patient + core `[A]`
- **Downloaded clinical docs written to disk in cleartext** — `cache_file_utils.dart:56,72`, `document_opener.dart:86` (only the JSON cache is encrypted).
- **Downloaded PHI survives logout on shared devices** — `logout_service.dart:52-65` clears caches but never purges `getTemporaryDirectory()`.
- **Root/jailbreak detection is a permanent always-pass stub** wired into a real gate — `device_integrity_service.dart:60-68`, `splash_screen.dart:238-245`; also dominates the device-trust score.
- **`flutter_secure_storage` Android options rely on plugin defaults with a self-contradictory comment** — `secure_storage.dart:35-40` (load-bearing for all token/PHI-key confidentiality on Android; verify the v10.3.1 default actually encrypts).
- **Release keystore passwords in a plaintext file** (`android/key.properties:1-2`) — gitignored (local-disk exposure only). **iOS target uses placeholder bundle id** `com.example.vhhealth` (App Check/push/HealthKit unprovisioned).

### Mobile — staff `[A]`
- **Offline write-queue persists PHI in plaintext, unencrypted SQLite** — `offline_queue.dart:17-36,71-79` (vitals/notes payloads incl. patient id).
- **Offline queue is global, not staff-scoped → cross-user PHI/authorship bleed** — `offline_queue.dart:24-35` + `connectivity_sync_service.dart`: user B's login can drain user A's queued writes under B's JWT.
- **No screenshot/screen-capture protection on Windows desktop** — `main.dart:299-306` (`screen_protector` has no Windows impl; swallowed).
- **No root/jailbreak/emulator detection anywhere** in `apps/staff`.

### Admin / infra `[A+B]`
- **Backend API key duplicated into a client-inlinable `NEXT_PUBLIC_API_KEY`** — `apps/admin/.env.local` + `scripts/config.ts:2` (same value as `BACKEND_API_KEY`). One stray client reference from shipping the master key to every browser. **[A]**
- **Admin appointment routes rely on RLS, no explicit tenant predicate** — `appointmentAdminRoutes.js:31,141,346` (analytics/search/export). Export is injection-safe (date/dept regex-validated, `:357`) but has no `tenant_id` predicate; backend CSV export also lacks formula escaping. If RLS is off/inert, an ordinary admin can read/export cross-tenant PHI. **[A+B]**
- **cosign signing-scheme mismatch** — `kyverno-verify-images.yaml:54` verifies *keyless OIDC*, but the live Forgejo pipeline signs *key-based* (`release-images.yml:273`). Flipping Kyverno to Enforce → cluster-wide pod-admission outage. **[A]** (Audit B also flags Kyverno still in Audit. **[B]**)
- **ArgoCD auto-syncs `targetRevision: HEAD` with selfHeal+prune** — `argocd/applications/apps.yaml:20-27`, `platform.yaml:20-28`. Any merge to `main` (incl. the digest-bot's auto-commit) auto-deploys prod with no manual gate. Audit B adds: ArgoCD project allows all namespaced kinds (`project.yaml:74`). **[A+B]**
- **Runtime DB-role sealing + alert/backup secrets are `.example`-only** — `cnpg/cluster.yaml`, `*sealed-secret.yaml.example`. Design is correct (NOSUPERUSER/NOBYPASSRLS `vhhealth_runtime`); live enforcement unverifiable from repo. Operator-gated but load-bearing. **[A]**

---

## 4. Medium findings (grouped)

- **Upload validator coverage `[B, verified]`** — handwritten prescription upload (`routes/prescription/index.js:16` — MIME `fileFilter` only), staff prescription compat upload (`routes/staff/index.js:143`), and clinical-AI KB-document upload (`routes/admin/clinicalAi/knowledgeBaseRoutes.js:305`) **skip the shared magic-byte `validateFileContent`** (`uploadMiddleware.js:252`). MIME ≠ magic bytes → spoofed-type upload; KB path feeds the RAG/prompt-injection pipeline (content *is* injection-scanned, not type-validated). **This was a gap in Audit A.**
- **Idempotency** — caches & replays 5xx (transient failure pinned, clinical write lost) and not tenant-scoped on the staff-vitals route (`idempotencyMiddleware.js:53-99`, `idempotencyService.js:79,94`); opt-in `required:false` on money/clinical mounts; replay served past `expires_at`.
- **Rate limiting** — in-memory per-process store × 6 workers → effective limits ~6× documented; Redis provisioned but not wired (`rateLimitMiddleware.js:118-131`).
- **Tenant scoping (latent, multi-tenant)** — V2 billing helpers operate on `invoiceId`/`code` with no tenant predicate (`billingV2Service.js:182,253,499,1274`); appeal cron runs the per-PA chain under RLS-bypass (`scheduler.js:31`); `tenantOf`/`parseTenantId` default-tenant fallback masks missing context; `withTenantTx`/`scopedTx` permissive fallback when `tenantId` null (`problemListService.js:142`, `medicationReconciliationService.js:42`); ops tables with no `tenant_id` (`staff_shift_roster_requests`, `housekeeping_floor_assignments`, `leave_applications`); `payment_transactions` has no `tenant_id` (verify dead).
- **Observability/logging** — Prometheus route-label fallback doesn't collapse UUIDs/phones → cardinality blow-up + PHI in labels (`prometheusMiddleware.js:202-209`); morgan `combined` logs full URLs incl. `?api_key=`/`?token=` outside redaction (`logger.js:115`); `paymentLinkService.js:175` logs `link_token` **[A+B]**; FCM full/prefix tokens + patient SOS raw-phone `debugPrint` **[A+B]**; Sentry breadcrumbs unscrubbed (`sentry.js:31-49`); PHI redaction value-only not key-aware (`logMasking.js`); `/health/deep` + `/downtime/static` token-gated only in prod (`uptimeRoutes.js:122-259`).
- **AI hardening** — prompt-injection detector is regex-only, single-pass, no Unicode normalization (`documentPromptInjectionDetectorService.js`); output defenses heuristic-only (`hallucinationDefenses.js`); external-region egress defaults allow-all (`localLlmClient.js:212-218`).
- **FHIR/interop** — SMART scopes issued but not enforced at the FHIR resource boundary (`fhirRoutes.js`, JWT-role only); conformance gate validates static samples, not adapter output; ABDM/SMART use MD5 (protocol-mandated) / unsalted SHA-256 for the SMART client secret (`smartOAuthService.js:164`); ABDM HMAC computed over re-serialized JSON (`signedRequest.js:28,89`) → likely fails against real gateways.
- **Reliability** — graceful shutdown never stops crons (`www.js:169-199`); `runAllScheduledTasksNow` fire-and-forget on every worker boot → SMS/backup stampede on deploy (`www.js:165`); backup returns success when `pg_dump` absent / verifies stale file (`scheduler.js:128`, `backupVerification.js`); `getHealthStatistics` fake-success zeros on DB error (`healthStatsController.js:25-44`); canary write-check downgrades real failures to `skip` (`canaryHealthCheck.js:28-38`); escalation holds a tx open across notifications + synchronous webhook HTTP (`escalationEngineService.js:276-436`); several sweeps load unbounded result sets; payroll month math uses server-TZ with no cron timezone (`scheduler.js:438-443`).
- **Clinical (secondary)** — CPOE CDS fails open on error (`orderEntryService.js:248-252`); `recordCanonicalClinicalEvent` swallow fires on `42703`/regex → silent degrade on schema drift (`canonicalClinicalPlatformService.js:163-180`); critical-vital notification dispatched to `recorded_by` (device actor) (`vitalSignMonitor.js:349-358`); NEWS2 non-atomic best-effort + needs full vitals set (`news2Service.js`); anaesthesia running totals non-transactional RMW (`anesthesiaChartService.js:49-138`); discharge summary lifecycle writes only legacy `audit_logs`, `sign()` non-tx (`dischargeService.js:218-859`); `completeChecklist` lets pre-incision safety items be rewritten mid-op (`theatreService.js:485-530`); `markBedReady` fire-and-forget audit (`bedManagementService.js:615-677`).
- **Mobile** — patient repro-health data in plaintext SharedPreferences (`cycle_tracker.dart:154-176`) **[A+B]**; staff med-favorites in SharedPreferences (`prescriptions_screen.dart:425`, low — clinician convenience list, not patient PHI) **[B]**; Firebase client config committed/defaulted (`patient/firebase_options.dart`, `staff/firebase_options.dart`, `google-services.json`) **[A+B]**; FileProvider whole-storage root paths (`file_paths.xml`); staff idle-timeout doesn't reactively clear on-screen PHI (`app_router.dart` no `refreshListenable`); no mock-location check on attendance (`location_service.dart:27-46`); no per-route role guard on the staff router (defense-in-depth).
- **Admin** — WS ticket passed in the URL query (`useRealtimeChannel.ts:25`); auth-route Origin checks allow missing `Origin` and carry stale `*.vhhealth.app` logic, inconsistent with the proxy (`api/login/route.ts:20`, `api/refresh/route.ts:20`, `api/logout/route.ts:10`) **[A+B]**.
- **Infra** — third-party CI actions pinned by tag not SHA (renovate configured but drifted) **[A+B]**; Forgejo `pin-prod-digest` pushes to `main` from CI (`release-images.yml:340-351`); semgrep/OSV/Trivy-misconfig advisory on the Forgejo path (`security-sweep.yml`); staff-web no startupProbe + `:latest-staff-web` tag; Dockerfiles use mutable base tags; dalekdefender backend `readOnlyRootFilesystem:false` + superuser DB role (`overlays/dalekdefender/backend.yaml:55`) **[B, verified]** (test-env; weaker than prod — don't mistake for prod posture).

---

## 5. Low findings (grouped)

- **Auth:** weak password floors (`min:6` vs config 8); two OTP attempt caps (3 vs 5); dev OTP hardcoded `123456` (`NODE_ENV==='development'`); MFA/TOTP brute-force keyed by IP only; `logout` doesn't drop the active-session row; `authenticateStaff` returns a refresh token with no session row; `adminOtpRoutes`/`validateApiKey` mount-order quirks (fail-closed today).
- **Data:** same-number migration files (cosmetic, disjoint); float `staff.salary`/leave columns; mig 299 column drops (guarded archive); missing composite `(tenant_id, patient_uid)` indexes + secondary FK indexes; `e_prescriptions`/`pharmacy_orders` number defaults without UNIQUE.
- **Clinical:** `applyOrderSet` swallows per-item failures; med-rec `change_detail` provenance only in the audit event; no infant/neonate vital band; NEWS2 no idempotency key; OR-board compliance counts only `status='complete'` (hides override rate).
- **Admin:** dead `(protected)`/`ProtectedRoute` localStorage gate; `SystemAlerts` href no scheme validation (unmounted); verbose backend error text surfaced to client; **dead privileged server actions with no in-action authz** (`admin-management/actions.ts`, `settings/actions.ts`) — see §6 reconciliation; CSP `unsafe-eval` (tracked stage-2).
- **Reliability:** `selfHealingMiddleware` is observability mislabeled as healing + unbounded `routeErrors` Map; Prometheus records only on `finish` (aborted requests uncounted); `attachUserContext` Sentry `setUser` dead (mount order); `wardDowntimePackService` interpolates `INTERVAL '${MAR_WINDOW_HOURS}'` (module constant today); archive/r2 jobs bypass `withJobLock`; `express.json({limit:'1mb'})` vs documented 10MB.
- **Patient:** latent analytics PHI shape (no callers); dev-login double-gated; no release minify/obfuscation; release-variant debug-signing fallthrough (true release guarded); iOS background modes.

---

## 6. Reconciliation with the independent auditor (Audit B)

| B# | Finding | Disposition |
|---|---|---|
| 1 | ABDM callbacks → wrong tenant/patient | **Corroborated** → C-4 |
| 2 | Admin appointment routes rely on RLS, no tenant predicate; CSV no formula-escape | **Corroborated + sharpened** → §3 Admin. Export is injection-safe (regex-validated) but tenant-predicate-absent; backend CSV-escape gap is distinct from the admin-frontend guard |
| 3 | Admin Server Actions bypass proxy → "likely breaks prod writes" | **Resolved in Audit A's favor.** Grep confirms the 4 actions have **zero call sites** (dead code, unreachable) → not a live prod break; reclassify **Medium/High → LOW/latent**. Both agree on the fix (delete or add in-action authz) |
| 4 | Upload paths skip the shared magic-byte validator | **Audit B's catch — a real gap in Audit A.** Verified true → §4 |
| 5 | Mobile plaintext prefs (cycle data, med favorites) | **Corroborated** (cycle data = Medium; staff med-favorites = Low) → §4 |
| 6 | Firebase client config committed/defaulted | **Corroborated** → §4 |
| 7 | Admin auth-route Origin checks lenient | **Corroborated** → §4 |
| 8 | Token/link material in logs | **Corroborated + specifics** (paymentLink `link_token` verified) → §4 |
| 9 | Infra: tag-pinned actions, Kyverno Audit, ArgoCD all-kinds, dalek RO-rootfs:false | **Corroborated + specifics** (dalek RO-rootfs verified) → §3/§4 |

**Net:** 7/9 corroborated; 1 genuine gap closed in Audit A (#4 uploads); 1 disagreement resolved by evidence (#3). The two passes are complementary — Audit B broad on infra/upload/mobile-config/admin-edge; Audit A deeper on backend business-logic correctness (money, clinical-safety lifecycle, reliability/cron, auth tokens, PHI/FHIR). Findings found by **both** independently (tenant-isolation seams, infra activation) carry the highest confidence.

---

## 7. Cross-cutting themes (root causes)

1. **"Built but not proven," and docs overstate done** — AI module count is wrong in *every* doc (code = 103; docs say 99, incl. the "machine-generated" inventory); "enabled by default" is 6 (docs say 4 or 7); `SESSION_HANDOFF.md` is stale/self-contradictory; `S_TIER_ROADMAP` marks `STATEMENT_TIMEOUT_MS`/Longhorn/Vault complete while code/self-assessment disagree.
2. **Two generations of code, two quality bars** — legacy `billingService.js` follows the Phase-0/1/2 transaction rule; newer `billingV2Service.js` abandoned it (zero transactions). Newest subsystems (revenue-cycle mig 316, operational-alerts mig 315, results-inbox) shipped 2026-06-18 with the thinnest review.
3. **RLS-bypass cron context is load-bearing** — every cron runs under `runWithSuperAdmin` (RLS off); isolation rests on hand-written `WHERE tenant_id` filters that must never drift. The two fan-out leaks are exactly this drift.
4. **Latent multi-tenant + enforce-flip seams** — ABDM/HL7/rbacService/FHIR-oracle/billing-helpers assume one tenant; they arm together at the SaaS / `enforce` cutover.
5. **No CI guard for the invariants that matter** — nothing flags a new `prisma.$transaction` on a policied table, a new `tenant_id` table without a policy, a new PHI route without `phiAccessLogger`, or a new upload route without `validateFileContent`.

---

## 8. What's genuinely strong (don't regress)

Multi-tenant RLS (383 tables ENABLE+FORCE+policy; GUC-default inserts; fail-closed readiness; test-proven through real HTTP); canonical-timeline atomicity in the core clinical writers (~20 services thread `{db:tx}`); `validatePrescriptionSafety` (fails closed, weight-based paeds dosing, empty-name guard); BCMA two-scan (server-enforced, on by default); WHO time-out + retained-object gates; discharge-readiness gate (fails loud); AI fail-closed defaults + non-self-approvable two-person + citation fail-close + deep-tier readiness probe; CDS-invoke/documents oracle-safe (403-both); admin httpOnly-cookie + allowlisting reverse-proxy + nonce-CSP + default-deny route policy with CI coverage; patient cert-pinning (SPKI, no trusted roots) + App Check + FLAG_SECURE + AES-GCM cache; SSRF guard re-checked before every outbound fetch; ABDM FIDELIUS crypto; SMART OAuth (hashed tokens, timing-safe, PKCE); pod-security + default-deny NetworkPolicy mesh; CNPG hardening (superuser off, sync replication, checksums, encrypted backups); the migration runner (fatal-on-failure, single-tx, dollar-quote-aware splitter); Prisma singleton circuit breaker (excludes schema-shape SQLSTATEs).

---

## 9. Already-tracked baseline (don't double-count)

**Confirmed fixed since the 2026-06-13 audit:** SEC-1/2/3/4 (OTP/refresh/tenant-tx/crypto), DB-1 (RLS coverage), BA-1 (atomic timeline core), AI-1/2/3 (fail-closed/delivery/triage governance), cert-pinning, FLAG_SECURE, admin CSP `unsafe-inline`.

**Known operator-gated (on `GO_LIVE_ACTIVATION_CHECKLIST.md` — not new):** seal the non-superuser DB role + runtime RLS verify; Kyverno Audit→Enforce; bootstrap real image digests; deploy monitoring + prove alert path; run the timed DR drill; nightly R2 backup + object-lock; secret rotation; external pen-test / ABDM cert / NABH / DPDP.

**Tracked-open in the remediation ledger:** CSP `unsafe-eval` stage-2; "make `tenant_id` explicit in app queries" (defense-in-depth, partial); `/api/v1/quality` + `/api/v1/referrals` mount-level `requireRole`; semgrep→blocking; pre-existing admin appointment 500s (BigInt serialization) and `/admin/analytics` dropped-column bug.

---

## 10. Prioritized remediation roadmap

1. **Money path (C-1)** — idempotency + `FOR UPDATE` + transaction wrapping + state-transition guards. Concrete loss, single-tenant-live.
2. **Clinical-safety lifecycle (C-2, C-3)** — escalation actually pages; ack stops the SLA clock; med-rec omission detection; theatre atomicity + locks + DB overlap constraint; retire legacy bedService bypass; atomic vitals criticals.
3. **Reliability/ops (C-5, C-6, C-7, C-8)** — scheduler leader-election or per-job advisory lock; drain or delete the outbox; drop RLS from the readiness gate; logger → writable path.
4. **Auth (C-9 + §3)** — refresh-token type check + rate limit; 2FA fail-closed; delete `totpRoutes`.
5. **Latent multi-tenant / interop seams (C-4 + §3)** — before any second tenant: ABDM/HL7 tenant binding + consent-artifact verification + rate limiting + shared replay store; rbacService scoping; FHIR oracle/search; cron fan-out scoping.
6. **PHI/consent (§3)** — mount `requireConsent` (or document advisory + remove); audit-chain hardening (schedule the verifier, HMAC+anchor, append-only); FHIR/specialty mount guards.
7. **Mobile PHI-at-rest (§3)** — encrypt + purge downloaded docs (patient); identity-scope + encrypt the staff offline queue; implement or remove the root-detection stub; Windows screen-capture protection.
8. **Input hardening (§4)** — apply `validateFileContent` to the prescription/staff/KB upload routes.
9. **Infra (§3/§4)** — match the cosign attestor to the Forgejo signer before any Enforce flip; pin ArgoCD prod `targetRevision`; SHA-pin actions/base images. **Admin:** remove `NEXT_PUBLIC_API_KEY`.
10. **Add invariant-guarding lint/CI** for the patterns in §7.5.

---

## 11. Coverage & recommended follow-ups

**Deep-read:** the full backend middleware/auth/RLS/PHI stack; ~26 canonical-importing clinical services; billing V1/V2 + claims/prior-auth + the new tracker; the AI governance substrate + 2 patient surfaces; FHIR/HL7/ABDM + SMART; the migration runner + RLS migrations + risky raw-SQL sites; the entire admin Next.js app; patient + core Dart security surface; staff app (security + offline + shared-workstation); infra (k8s/CNPG/Kyverno/ArgoCD/CI); reliability (scheduler/crons/logging/metrics/health).

**Not exhaustively covered (recommended next passes):**
- Pharmacy dispense race (`pharmacy/orderService.js`) — known double-dispense surface, dedicated concurrency review.
- ICU (`icuService.js`), ED operations, blood-bank 2-person check, CDS engine internals, terminology services.
- Payroll `savePayslip`/`calculatePayslip` idempotency + `resumeWorkflow` checkpoint locking (blast radius of the cron multi-fire).
- `payerContractVarianceService`, PMJAY, `ediGenerator` (837), billing/insurance validators.
- The ~80 tier-C–H AI module services (consistent pattern verified on a representative sample).
- A live `pg_policies` / `\du` check on the running cluster to confirm the RLS posture matches migration intent (static-only here).
- Dependency CVE scan (`npm audit` / `osv`) — out of scope under the no-install rule.

*This report is a static read-only analysis. All findings cite current code at `75fd9cbe`; verify on the live cluster where noted.*
