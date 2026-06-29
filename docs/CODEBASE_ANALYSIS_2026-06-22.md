# VH Health Platform — Full Codebase Analysis (2026-06-22)

> ▶ **All findings in this dated snapshot have been REMEDIATED** (see docs/ROADMAP.md §0 for the live tracker). This document is the point-in-time evidence record, not an open-issues list.

**Status:** Wave 1 (backend) complete. Wave 2 (frontend) + Wave 3 (infra + strategic synthesis) in progress.
**Method:** multi-agent deep read, partitioned by domain×lens; every Critical/High finding independently **adversarially refuted** before inclusion (the refutation pass downgraded 2 over-called findings and refuted 0 of the 7 Highs — it confirmed all 7). Findings carry `file:line` evidence; medium/low are reported as-found (single-pass).
**Baseline:** `main` @ `502fc033`, CI green. Prior audits (2026-06-13, 2026-06-18) were treated as priors — only *new* gaps or *incomplete* remediations are reported here.

---

## Executive summary

The backend is genuinely strong: the prior-audit remediations (full tenant RLS, billing-V2 locking + idempotency, append-only clinical audit chain, fail-closed safety checks, cron multi-fire fix, refresh-token type guards, ABDM/HL7 inbound HMAC + cross-tenant binding) are **present and intact**. The new findings are overwhelmingly **siblings the remediations missed** — the same defect class surviving in a parallel code path — plus one **scale/go-live hazard** in the migration runner. None are trivially exploitable by an anonymous attacker; most require an authenticated actor, a concurrency window, the multi-tenant cutover, or an active integration. But several are real patient-safety / money-integrity / cross-tenant-PHI defects worth fixing before the first real-PHI deployment.

**The 7 confirmed Highs cluster into four themes:**
1. **"Fix applied to one path, not its sibling."** Step-up MFA (dashboards ✓, admin-identity-mutation ✗), billing locks (V2 ✓, V1 ✗), cross-tenant claim filter (appeal generator ✓, denial-risk ✗).
2. **Escalation that never reaches a human.** The NEWS2 deterioration alert is queued with no recipient and silently dead-letters.
3. **Money writes without a lock.** PMJAY floater increment is non-atomic, non-idempotent, no paid≤approved guard.
4. **Latent go-live bombs.** Synchronous index builds + full-table tenant backfills under a hard 120s timeout will crashloop the pod at real hospital data volume; outbound HL7 has no delimiter escaping (injection into downstream EHRs).

---

## Confirmed HIGH findings (7) — fix before real-PHI go-live

### H1 — SUPER_ADMIN 2FA step-up gate is missing on the admin-management routes
- **Where:** `routes/auth/adminAuthRoutes.js:177-240` (create-admin, deactivate, reactivate, revoke-all-sessions, update-permissions) vs the gate mounts at `app.js:1077-1089`.
- **What:** `requireSuperAdminStepUp` (forces `mfa:true`) is mounted on `/admin`, `/system`, `/logs`, `/admin/gamification` — but **not** on the highest-privilege identity-mutation endpoints under `/api/v1/auth/admin/*`. `wrapAutoRBAC` only injects `rbac(roles)`, never the step-up gate; `rbacMiddleware.js:55` is an unconditional SUPER_ADMIN bypass.
- **Impact:** a full-scope SUPER_ADMIN token lacking `mfa:true` (flag-off deployment, pre-enrollment, or grandfathered token) can create a backdoor admin, deactivate the real super-admins, rewrite permissions, and force-logout sessions — a *larger* blast radius than the dashboards the gate protects.
- **Fix:** add `requireSuperAdminStepUp` to the `adminManagement` group (or to the `/admin` mount in `routes/auth/index.js` after the role gate). Test: a SUPER_ADMIN token with `mfa!==true` must 403 on `POST /create-admin`.

### H2 — Legacy V1 `billingService.recordPayment` has no row lock and no idempotency backstop (double-charge race)
- **Where:** `services/billing/billingService.js:143-217`; route `routes/billing/billingRoutes.js:150-189` (live at `app.js:1137`).
- **What:** reads the invoice with `findFirst` (no `FOR UPDATE`) *outside* the tx, computes `newPaid = currentPaid + amount`, checks overpay, then writes inside `scopedTx` (which only sets the RLS GUC — no lock). `payment_transactions` has **no unique on `transaction_ref`**; idempotency middleware is `{ required: false }`. The identical class was fixed in billingV2 (`lockBillingInvoice` FOR UPDATE + mig-317 unique) — V1 was left behind.
- **Impact:** concurrent/replayed payments overpay an invoice and create duplicate `payment_transactions` rows, corrupting `paid_amount`/`payment_status` and the revenue ledger.
- **Fix:** move read+check+write into `scopedTx` with `SELECT … FOR UPDATE`; recompute paid from `SUM` under the lock; add a partial unique `payment_transactions(tenant_id, transaction_ref) WHERE transaction_ref IS NOT NULL` with 23505→409. **Better: deprecate V1, route all payments through billingV2 `collectPayment`** (see opportunity O-money-1).

### H3 — `pmjayService.transition` claim_paid: non-atomic, non-idempotent floater increment, no paid≤approved guard
- **Where:** `services/insurance/pmjayService.js:218-277`.
- **What:** the `pmjay_cases` UPDATE and `UPDATE pmjay_beneficiaries SET cumulative_used = cumulative_used + paid_amount` are **two independent statements with no transaction**, no `FOR UPDATE`, and **no `paid_amount ≤ approved_amount`** guard (contrast `claimsService.recordClaimPayment:2003-2011`). `payment_reference` is stored but never used for idempotency.
- **Impact:** PMJAY family-floater utilization (which gates future scheme eligibility) can be **double-counted** under concurrency or **silently under-counted** if the second statement fails; a claim can be marked paid above approved → payer recovery/audit exposure.
- **Fix:** wrap status-update + cumulative-increment in one `setTenantTx` with `SELECT … FOR UPDATE` on `pmjay_cases`; add the paid≤approved guard; make the bump idempotent (apply only on the approved→paid edge or key on `payment_reference`).

### H4 — High-NEWS2 deterioration alert is queued with NO recipient → never delivered
- **Where:** `services/clinical/news2Service.js:236-247` (`escalateNews2`); drained by `utils/scheduler.js:408-413`.
- **What:** `notificationOutbox.queue({...})` is called with **no `recipientId` / `recipientPhone`**. The drain resolves zero tokens, throws "no resolvable device token or recipient_id", `markFailed`, and after 3 retries the row drops out (silent dead-letter). The "loud throw" guard only catches *enqueue* failure, not undeliverability. The only other path writes a passive `cds_alerts` dashboard row — gated on a disabled AI module.
- **Impact:** a NEWS2 ≥ 5 (aggregate deterioration that no single vital's CRITICAL band catches) never actively pages nursing/duty staff. This is the "escalation never pages" class reappearing in the NEWS2 path.
- **Fix:** resolve concrete recipients before queueing (reuse `drugChartSlaService.resolveDrugChartAlertRecipients`), or route through `enqueueCriticalResultTask` with a DUTY fallback so it becomes an assigned, ack-tracked task. Test: NEWS2 ≥ 7 produces ≥ 1 non-null-recipient outbox row.

### H5 — Synchronous index builds + full-table tenant backfills under a hard 120s timeout will crashloop the pod at production scale
- **Where:** `utils/migrations/runMigrations.js:133-152` (`SET LOCAL statement_timeout='120s'`, whole file in one tx) vs migrations 322/326/331/333/336.
- **What:** the runner caps every statement at 120s and runs the whole file in one transaction (CONCURRENTLY impossible). Mig 322/326 build synchronous unique/composite indexes on `appointments`/`admissions`/`prescriptions`/…; 331/333/336 do `ADD COLUMN tenant_id` + full-table `UPDATE … SET tenant_id` + `SET NOT NULL` (full-table AccessExclusive scan) across PHI + 82 MEDIUM-tail tables. The W2 design doc reasoned about *correctness*, never *build time*; CI passes only at QA scale.
- **Impact:** on a real hospital DB (millions of appointments/audit/notification rows) any one statement exceeding 120s aborts the migration → `bin/www.js` exits fatal → **ArgoCD pod crashloop, backend won't start after the multi-tenant cutover deploy** (the exact moment data has grown and was never tested at volume). No partial-apply recovery (one tx).
- **Fix:** add a per-file escape hatch (`-- @no-transaction` / `-- @statement_timeout: 0`) so heavy DDL runs `CREATE UNIQUE INDEX CONCURRENTLY` uncapped; split tenant rollout into `ADD COLUMN` → chunked batched backfill → `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE, interruptible) instead of `SET NOT NULL`. Document expected build times in the go-live runbook.

### H6 — `generateDenialRiskAssist` reads `insurance_claims` by id with NO tenant filter (cross-tenant IDOR / PHI leak)
- **Where:** `services/ai/clinicalAiWorkflowService.js:1212-1226`; route `routes/billing/revenueCycleRoutes.js:460-467`.
- **What:** raw `$queryRawUnsafe` `SELECT … FROM insurance_claims c … WHERE c.id = $1` on the plain client (RLS bypassed when GUC unset), **no `tenant_id` predicate**, `claimId` passed straight from the route. `insurance_claims` has `tenant_id` + RLS (mig 239); SERIAL ids aren't globally unique. The sibling `appealLetterGeneratorService.js:460-463` was *explicitly* fixed for this; denial-risk was missed.
- **Impact:** a billing user in tenant A passes a tenant-B `claimId` and receives that claim's PHI (patient name, payer, policy, amounts) into an AI draft, persisted under tenant A.
- **Fix:** add `AND c.tenant_id = $2::uuid` and pass `resolveTenantId(...)` (mirror the sibling), or wrap in `setTenant`. Add a 2-tenant deep test (foreign claimId → 404).

### H7 — Outbound HL7v2 messages never escape delimiter characters (HL7 injection / segment forgery)
- **Where:** `services/hl7/hl7Transformer.js:186-264` (buildPID/PV1/OBR/OBX) + `resultToORU:80-82`; delivered live by `hl7OutboundService.js`.
- **What:** `PID|||${uid}||${name}||…` interpolates `name`/`address`/`phone`/lab `value` verbatim. There is **no encoder** (grep: zero `encodeHL7`); the inbound parser *decodes* `\F\ \S\ \T\ \R\ \E\` but nothing encodes the inverse. `stripHtml` preserves `| ^ ~ &`. Patient name/address are patient-self-editable.
- **Impact:** a `|`/`^`/`~`/`&`/CR in a free-text field forges HL7 fields/segments in ADT/ORU pushed to subscribed external EHR/LIS — PID identity spoofing or fabricated OBX results in a downstream clinical record (CWE-93/CWE-91). Fires only where an HL7 feed subscription is active.
- **Fix:** add `encodeHL7Field` (`\`→`\E\`, `|`→`\F\`, `^`→`\S\`, `&`→`\T\`, `~`→`\R\`, strip/encode CR/LF) applied to every interpolated text field (not MSH/structural separators); property-based round-trip test against `decodeHL7Escapes`.

---

## MEDIUM findings (17) — harden before/around go-live

| # | Area | Finding | Location |
|---|---|---|---|
| M1 | auth | Admin OTP verify attempt-counter is non-atomic (TOCTOU) — per-OTP cap bypassable under concurrency | `services/auth/otpService.js:100-123` |
| M2 | auth | OTP legacy fallback uses non-constant-time `===` on the secret | `otpService.js:115-117`, `authService.js:537-539` |
| M3 | auth | Login 2FA challenge has no per-challenge attempt counter; not consumed on failed verify | `controllers/auth/adminAuthController.js:597-668` |
| M4 | money | `claimsService.recordClaimPayment/Decision` read-then-write without `FOR UPDATE` (distinct-ref last-writer-wins) | `services/insurance/claimsService.js:1872-2045` |
| ~~M5~~ | money | ~~`cashDrawerService.closeSession` sums CASH with no upper time bound → cross-session double-count~~ **FALSE POSITIVE** (verified 2026-06-23, 2 independent adversarial verifiers) — the double-count is unreachable: `uq_cash_drawer_sessions_open` (mig 198) caps open sessions at one per (cashier,shift) so same-key sessions are strictly sequential, and `collected_at` is insert-time `CURRENT_TIMESTAMP`, so an earlier session's payments are always `< opened_at` of any later same-key session and never counted twice. No code change beyond a load-bearing-invariant comment in closeSession. Separate residual (NOT M5): a CASH payment with NULL `collected_by`/`shift` is invisible to reconciliation (under-count) — minor, deferred. | `services/billing/cashDrawerService.js:106-194` |
| M6 | clinical | Order state transitions (verify/complete/cancel/discontinue) TOCTOU — no status guard in UPDATE WHERE | `services/emr/orderEntryService.js:1066-1285` |
| M7 | clinical | Med-rec snapshot excludes `administered` doses — running meds read as omissions or missed | `services/clinical/medicationReconciliationService.js:373-382` |
| M8 | data/RLS | `registerDevice`/`claimUserSession` write FORCE-RLS tables with no explicit tenant_id (default-tenant mis-attribution post-cutover) | `controllers/deviceController.js`, `services/auth/userActiveSession.js` |
| M9 | reliability | Synthetic canary checks (stuck notifications, unack CRITICAL alerts) run nowhere — `runCanaryChecks` orphaned | `utils/canaryHealthCheck.js`, `scheduler.js:728`, canary CronJob |
| M10 | reliability | Webhook deliveries can orphan permanently in `in_flight` on crash — no stale-claim reaper | `services/integrations/webhookDeliveryService.js:174-380` |
| M11 | reliability | `idempotency_keys` retention sweep implemented but wired to no cron — unbounded growth on the hot money path | `services/idempotency/idempotencyService.js:208-230` |
| M12 | reliability | Circuit breaker is process-global module state — one bad query class browns out all queries; per-worker, unobservable in aggregate | `lib/prisma.js:130-277` |
| M13 | AI gov | Patient RAG chatbot has NO module-enable gate — runs while module ships `enabled:false`/`surface:'patient'` | `services/ai/patientChatbotService.js:95-190` |
| M14 | AI gov | Module-update accepts arbitrary `settings.surface` override → evades patient-surface enablement guard | `services/ai/clinicalAiModuleService.js:2792-2811` |
| M15 | AI gov | `decisionSupportOnly`/`patientFacing` declared on ~90 modules but **never read/enforced** (inert safety claim) | `services/ai/clinicalAiModuleService.js` |
| M16 | AI | Patient chat free-text embedded in prompt with no injection scan / untrusted-content fence | `patientChatbotService.js:139-149` |
| M17 | interop | SSRF guard DNS-rebind TOCTOU — validates resolved IPs, then `fetch()` re-resolves independently | `utils/ssrfGuard.js:151-168` |
| M18 | api | `deviceController` misuses `success()/error()` (string as first arg) → `/legacy-register` always 500 | `controllers/deviceController.js:12,34,37` |
| M19 | api | No terminal JSON 404 handler — unmatched routes return HTML, break the envelope | `app.js:1216-1227` |
| M20 | api | `admin/index.js` is a 697-line god-router; 36 inline handlers, 70 raw `res.json` bypassing envelope+Sentry | `routes/admin/index.js` |

## LOW findings (8)

| # | Finding | Location |
|---|---|---|
| L1 | revoke-all-tokens check can fail OPEN if Redis revoke-all key evicted while DB unreachable | `utils/tokenBlacklist.js:148-197` |
| L2 | Cross-tenant SUPER_ADMIN override audit is fire-and-forget (override succeeds even if audit row drops) | `middleware/tenantContextMiddleware.js:86-172` |
| L3 | `markPaymentLinkPaid` doesn't check `expires_at` (stale-but-uncronned link still reconcilable) | `services/billing/paymentLinkService.js:224-279` |
| L4 | Refund approve doesn't enforce raiser≠approver (admin self-approval) | `services/billing/billingV2Service.js:1496-1508` |
| L5 | CRITICAL vital push targets the recording nurse, not the responsible/ordering clinician | `utils/clinical/vitalSignMonitor.js:399-412` |
| L6 | `POST /devices/legacy-register` ON CONFLICT (phone) has no matching unique → 42P10 (deprecated endpoint only) | `controllers/deviceController.js:16-24` |
| L7 | Notification dead-letter states (outbox + failed_notifications) have no alerting; two parallel retry systems | `notificationOutbox.js`, `notificationRetryService.js` |
| L8 | ABDM X25519 doesn't reject low-order/all-zero shared secret; ABDM token cache is a process-global singleton (per-tenant-credential hazard) | `services/abdm/abdmCrypto.js`, `abdmGateway.js` |
| L9 | Patient registry create/update writes name/address with no `stripHtml` (convention gap; no confirmed XSS sink) | `controllers/patient/patientSearchController.js` |
| L10 | API versioning is inert + parses lossily (`2.1`→`2`); no field-shaping/deprecation path | `middleware/apiVersionMiddleware.js` |
| L11 | CLAUDE.md doc-drift: claims `STATEMENT_TIMEOUT_MS` unused, but `prisma.js:395` reads + applies it | `apps/backend/CLAUDE.md` |
| L12 | RAG 'flag'-verdict content retrieved into prompts with no retrieval-time re-check/warning | `services/ai/ragService.js:165-268` |

---

## Strategic opportunities — toward S-tier / Epic-competitor (33, grouped)

**Security / Auth**
- Sender-constrained sessions (DPoP/mTLS-bound access + server-side opaque rotating refresh) → stolen-token replay structurally impossible; revocation becomes one authoritative DB delete `[L]`.
- Risk-based adaptive step-up: feed `loginAnomalyDetector` + impossible-travel + new-device + off-shift signals into a dynamic MFA-challenge engine instead of the static flag `[M, ai]`.
- DB-backed per-tenant `api_keys` as the sole surface (hashed, scoped, rotatable); env keys → bootstrap-only with deprecation warning `[M]`.
- Collapse duplicated per-realm auth helpers (tenant resolver, refresh type-guard, lockout) into one auth-core module `[M]`.

**Money — the biggest structural upgrade**
- **O-money-1: retire V1 billing, consolidate on billingV2** (removes H2 + halves the money attack surface) `[L]`.
- **Double-entry ledger as money source-of-truth** with DB-enforced invariants (postings net to balance, no negative advance) + integer minor-units (paise) to kill float rounding → overpayment/lost-update/negative classes impossible at the DB layer (Epic-grade) `[L]`.
- Stamp `billing_payments` with `cash_drawer_session_id`; reconcile by session id `[M]`. **(NB: M5 itself was a false positive — see the Medium table. This stamp is still worthwhile defense-in-depth/future-proofing IF shared multi-cashier drawers are ever introduced, since that would relax the `uq_cash_drawer_sessions_open` invariant the current time-window reconciliation leans on. Not needed for today's single-cashier-per-(shift) model. Pair it with requiring `collected_by` for CASH to also close the NULL-collected_by under-count residual.)**
- AI (governed, enabled=false): auto-match bank NEFT advice → claims; pre-submission denial/short-pay risk score from cap-utilization + missing-doc profile `[M]`.

**Clinical safety**
- Replace substring drug/allergy/interaction matching with an **RxNorm/SNOMED-coded terminology spine + licensed DDI engine** (the `drugKnowledgeBaseService` scaffolding + mig 277 exist) — curated tables as the deterministic floor `[L]`.
- Per-age-band paediatric vital ranges + weight-based dose ceilings from a real drug master (deterministic, high-yield) `[M]`.
- One shared `resolveResponsibleClinicians()` helper across NEWS2 / critical-vital / drug-chart-SLA (root-cause fix for H4 + L5) `[M]`.
- Trend-aware deterioration predictor feeding the dormant early-warning module, deterministic threshold as floor `[M, ai]`.

**Data / Reliability**
- **CI guard: diff every `ON CONFLICT` target against live unique indexes** (catches L6 + the whole tenant-composite-unique regression class) `[M]`.
- Migration runner per-file `@no-transaction`/`@statement_timeout:0` escape hatch (fixes H5) + a reusable `NOT VALID → VALIDATE` Pattern-A macro (removes ~600 lines, scale-safe by construction) `[M/L]`.
- Standard stale-`in_flight` reaper + per-queue heartbeat for every claim-based dispatcher (fixes M10) `[M]`.
- Promote `/health/metrics` to real Prometheus exposition (queue depth/age, dead-letter count, breaker open-worker spread, oldest unack CRITICAL alert) + alert rules (fixes M9/M12/L7 visibility) `[M]`.
- Wire `prismaReadOnly` to the provisioned CNPG RO pooler + EXPLAIN-plan drift detector on the slow-query path `[M, ai]`.
- Consolidate the two notification retry subsystems onto one outbox `[L]`.

**AI integration / governance**
- **Make `decisionSupportOnly`/`patientFacing`/`rulesAuthoritative` load-bearing** (registry lint + runtime assertion) — converts the platform's headline safety claim from inert metadata to an enforced invariant (closes M13/M14/M15) `[S]`.
- One `generateGovernedDraft({moduleKey, tenantId, loadContext})` wrapper that always requireEnabledModule + tenant-scopes + runs the defense matrix (makes H6/M13 classes structurally impossible across ~20 entrypoints) `[M]`.
- Output-side injection/jailbreak detector + governed LLM-as-judge citation-faithfulness reviewer `[M]`.
- Ambient/voice docs as a first-class `workflowGraphRunner` DAG (inherits checkpointing + defense matrix uniformly) `[L]`.
- Continuous post-enablement drift→auto-rollback (human-confirmed) via `driftCanaryService` + `modelRegistryWorkbench` `[M]`.
- AI terminology auto-coding for inbound HL7/FHIR free-text → RxNorm/SNOMED/full-LOINC (raises interop conformance) `[L]`.

**Architecture / Future-proofing**
- **First-class typed event/outbox bus** (domain events on every clinical/billing write → notifications, analytics read-models, FHIR Subscriptions, HL7 feeds, AI triggers) — the backbone for real-time dashboards, AI event triggers, multi-region CDC; decouples the god-services `[L]`.
- Declarative route-manifest + auto-generated OpenAPI (replaces the 1,278-line imperative `app.js`; lets a test assert "every PHI mount has phiAccessLogger") `[L]`.
- MCP/tool-call gateway exposing the 99 governed modules as typed tools → embeddable clinical copilot without re-plumbing each module `[L]`.
- Cursor pagination + ETag/conditional-GET in the response envelope `[M]`.
- One `resilientFetch()` for all outbound calls (SSRF-before-connect + timeout + bounded retry + breaker) — removes per-call-site drift (fixes M17 permanently) `[M]`.
- Mandatory-in-prod outbound host allowlist with a startup assertion `[S]`.

---

## Coverage & known gaps (Wave 1)

153 files deep-read across 8 slices. Explicitly **not** deep-read (candidate follow-up / "Wave 1.5"): `breakGlassService`, staff-realm ABAC (`staffAccessDecisionService`/`staffAccessPolicyRegistry`), PHI-at-rest crypto (`phiColumnEncryption`/`phiEnvelopeService`/`kmsProviderService`/`tenantKekProvider`), `consentMiddleware`, the role/access **policy data** (a misconfigured row could widen access with no code change); the back half of `clinicalAiWorkflowService.js` (review/approval/break-glass), `workflowGraphRunner`/`workflowCheckpointStore` (crash-resume + PHI-in-JSONB), ~90 per-domain AI rules-modules' generation internals; specialty clinical services (`icu`/`dialysis`/`dental`/`ophthalmology`), `admissionService` (173KB) + `dischargeSummaryGenerator` state machines, the biggest controllers (`appointmentWorkflow`/`ePrescription`/`payroll`); `smartFhir`/`smartOAuthService` (SMART-on-FHIR OAuth), `observationVitalsMapper`, DB-level money CHECK constraints. No dynamic/runtime testing — all findings are static with file:line evidence.

---

## Wave 2 — Frontend (admin Next.js + Flutter patient/staff)

**2 confirmed High, 0 refuted, ~18 Medium, ~13 Low, 33 opportunities.** The web admin is solid (React 19 auto-escaping → no XSS sinks found; the proxy/act-as tenant discipline holds; the adversarial pass *downgraded* two over-calls — an i18n one because Hindi is actually reviewed, and a "52k-LOC dead client drifted from the contract" one that was a CRLF artifact, not real drift). The two Highs are **staff-app clinical-safety** and they **compound Wave 1's NEWS2 gap**.

### F-H1 — MAR 5-rights: a failed "right patient" check is overridable like any other right (wrong-patient never hard-blocked)
- **Where:** `apps/staff/lib/features/nursing/screens/mar_scan_screen.dart:240-258,380-388,98-119`.
- **What:** when `verify5Rights` returns `allPassed=false`, the UI shows a generic override box **regardless of which right failed**. A nurse who scans the *wrong patient wristband* (the canonical BCMA never-event) gets the same justify-and-proceed amber box as a benign timing variance, and the backend honors the override (`bcma-closed-loop.deep.test.js` B4.2 confirms a mismatched scan still returns `administered` with an override reason).
- **Impact:** defeats the core closed-loop BCMA guarantee — wrong-patient/wrong-drug administration becomes "justify and proceed" instead of impossible (sentinel-event potential).
- **Fix:** branch on `rights['patient']==false` (and `rights['drug']==false`) → hard-stop panel, **no override**, re-scan only. Surface the specific failed right inside the override box.

### F-H2 — Vitals/NEWS2 entry discards the server response (the NEWS2 score + escalation are never shown to the nurse)
- **Where:** `apps/staff/lib/features/emr/screens/vitals_chart_screen.dart:640-663` + `medical_api_service.dart:1304-1308`.
- **What:** `recordEmrVitals` returns `{vitals, news2, alerts, …}` (NEWS2 score/band + anomaly fan-out, per `vitalsRoutes.js:89`), but the screen ignores it and shows a static "Recorded successfully" toast. Zero point-of-care NEWS2 surface exists in the staff app (grep confirmed). The basic nursing vitals path doesn't even capture RR/consciousness, so NEWS2 can't be derived there.
- **Impact:** a nurse recording a critically high NEWS2 sees only "success" — the deterioration signal and the prompt to escalate are invisible at the bedside (failure-to-rescue). **Pairs with Wave 1 H4** (the backend's NEWS2 page also never reaches a human): the early-warning system is broken on *both* layers.
- **Fix:** render the returned NEWS2 score/band as a colour-coded banner with a one-tap "Escalate / notify doctor" affordance; compute client-side as a fallback.

### Medium (18)
| Area | Finding | Location |
|---|---|---|
| admin-sec | CSP `script-src` still allows `'unsafe-eval'` (ADM-2, confirmed open) | `apps/admin/src/middleware.ts:201` |
| admin | Dashboard `error.tsx` renders raw `error.message` (info-leak) + skips Sentry | `app/(with-auth)/dashboard/error.tsx:8` |
| admin/white-label | `--tenant-primary` published to DOM but consumed by nothing (theming dead); 160/313 pages hardcode palette classes | `contexts/TenantContext.tsx:27-39` |
| admin | "System announcement" banner persists only to `localStorage` — not global | `…/notifications/components/AnnouncementBannerManager.tsx` |
| admin-a11y | Icon-only buttons lack accessible names across god-pages (935 buttons, 46 files use aria) | `…/incidents/page.tsx:206` (rep.) |
| patient-sec | Off-host document download bypasses scheme check → PHI over `http://`/`file://` possible | `apps/patient/lib/core/utils/document_opener.dart:67`, `cache_file_utils.dart:62` |
| staff-clin | Manual vitals entry keys a raw numeric `patient_id` with no name read-back (wrong-patient) | `apps/staff/lib/features/nursing/screens/vitals_screen.dart:176-184` |
| staff-clin | Desktop-only write gate enforced reactively (after a full basket/scan); MAR shows it as a cryptic raw exception | `order_composer_screen.dart:260`, `mar_scan_screen.dart:98` |
| staff-i18n | ~1,339 first-pass **machine-translated, clinically-unreviewed** ta/te strings ship live (incl. MAR "right dose/drug") | `apps/staff/lib/l10n/app_strings.dart` |
| staff-i18n | ~105 user-facing clinical strings hardcoded in English (discharge sign-off, CDS reason picker) | `apps/staff/lib/features/**` |
| staff-offline | The 4 highest-stakes write screens (e-Rx, CPOE, pharmacy/MAR, drug chart) have **no offline queue** → dropped connection silently loses the clinical action | `prescriptions/order_composer/pharmacy/drug_chart` |
| staff-arch | No typed-model layer: 135 files thread raw `Map<String,dynamic>` with stringly-typed key lookups | `apps/staff/lib/**` |
| staff-perf | God-widgets: single screens 2.6k–5.4k LOC, 30–57 `setState` (whole-tree rebuilds) | `front_office_workbench_screen.dart` (5,359 LOC) |
| frontend-arch | Both Flutter apps open **two** live WebSocket connections per session (legacy + core); divergent refresh logic | `main.dart` + `websocket_service.dart` + `realtime_client.dart` |
| frontend-arch | Per-tenant theming inconsistent: works in patient, **absent in staff**, **dead in admin** | `apps/staff/.../app_theme.dart`, `TenantContext.tsx` |
| frontend-arch | Admin TS API types hand-maintained, stale since 2026-04-04, no CI drift gate | `apps/admin/src/lib/api-types.generated.ts` |
| patient-a11y | Patient app (public consumer client, 5-lang, SOS) has near-zero `Semantics` coverage (4/39 screens) | `apps/patient/lib/features/**` |

### Low (13, condensed)
IP-allowlist trusts leftmost `X-Forwarded-For` (spoofable if ingress doesn't strip it) · proxy is auth-only/no role gate (relies on backend RBAC) · client-side table pagination + unused `react-virtual` dep · 25 admin pages >500 LOC unsplit · analytics drops events with any null param · `DocStaging.purge()` deletes the whole OS temp dir on logout/idle · WS subscribes before auth-ack + no 4001 refresh on the legacy path · CDS blocker modal can omit which basket item is blocked · MAR route coerces an unparseable `maId` to 0 · eager `ListView(children: map())` on large lists · undisposed sheet controllers · staff legacy WS gives up after 5 retries with no half-open detection · stale `NEXT_PUBLIC_FIREBASE_*` in admin `.env.example` · 52k-LOC generated Dart client is dead (delete-or-commit) · design-system fragmentation (status colors redefined per app).

### Wave 2 opportunities (33, grouped)
- **Real-time-first:** wire the ~36 admin clinical boards + staff code-blue/handover + patient dashboard onto the *existing* WS fabric (push, not 30–60s polling) — Epic-grade live ops; collapse the 3 WS implementations into one core client `[M/L]`.
- **Contract pipeline:** one OpenAPI source → Dart client **and** admin TS types, **drift-gated in CI** (the single highest-leverage frontend architecture fix) `[L]`; typed shared DTO/repository layer in `vhhealth_core` (kills the 135-file raw-Map threading) `[L]`.
- **White-label:** finish the theming loop in all three clients (map `--tenant-primary` into Tailwind tokens; route staff/patient themes through `TenantConfig`) → real per-tenant SaaS branding `[M]`.
- **Clinical-safety UX (S-tier):** NEWS2 banner + one-tap escalate after vitals (fixes F-H2); **wrong-patient/wrong-drug hard-stop + positive patient-ID read-back header on every clinical-write screen** (fixes F-H1 + the manual-vitals gap; Joint Commission NPSG) `[M]`; **offline-first MAR/vitals/orders** with idempotent sync `[M/L]`.
- **AI/copilot:** on-device patient symptom-checker → triage + lab/prescription explainer (offline-encrypted record cache is a ready local corpus) `[L]`; inline prescribing copilot layered on the existing advisory CDS pre-check `[L]`; admin audit-stream anomaly/copilot (act-as, cross-tenant, off-hours) `[L]`; cross-page command copilot unifying the 40+ clinical-AI panels `[L]`.
- **Hardening/quality:** drop `unsafe-eval` + add CSP report-uri `[M]`; edge-trusted client-IP header + proxy role gate `[S]`; HMAC-sign the act-as cookie `[M]`; server-side pagination + virtualization for PHI grids `[M]`; CI i18n lint (no hardcoded `Text`, no unreviewed clinical strings shipped) `[S]`; accessibility program (Semantics + textScaler clamping + `eslint-jsx-a11y`) `[M]`; decompose the 5 god-widgets + adopt a state container `[L]`; responsive master-detail for ward tablets `[M]`.

### Cross-wave compound themes (highest priority)
1. **NEWS2 / deterioration is broken end-to-end:** backend never pages (W1-H4) **and** the frontend never displays the score (W2-H2). Fix both + the shared `resolveResponsibleClinicians` helper together.
2. **Wrong-patient safety has gaps on multiple write paths:** MAR identity-mismatch is overridable (W2-H1) and manual vitals key a typed raw `patient_id` with no read-back. One shared positive-ID header + identity hard-stop addresses the class.
3. **"Fix applied to one path, not its sibling"** (W1) and **"half-migrated"** (W2: dual WS, dead generated client, inconsistent theming) — both argue for the consolidation/shared-helper opportunities over piecemeal patches.

---

## Wave 3 — Infra (k8s / CNPG / ArgoCD / Cloudflare / Kyverno)

**4 confirmed High (union of both runs), 0 refuted, ~37 Medium/Low, 23 opportunities.** The infra is mature (digest-pinned images, cosign signing, PSA-restricted, SealedSecrets, CNPG HA, default-deny baseline) — but several **manifest defects would bite at first GitOps sync or the multi-tenant cutover**, and two are cross-tenant/observability blind spots.

### W3-H1 — App Ingresses carry `configuration-snippet` while the controller disables snippet annotations
- **Where:** `base/ingress-nginx/ingress-nginx.yaml:101` (`allow-snippet-annotations: "false"`, validating webhook at `:407`) vs `apps/{backend,admin,backend/ingress-clinical-internal,staff-web}/ingress.yaml`.
- **What/impact:** ingress-nginx ≥ v1.9 **rejects** an Ingress bearing a snippet annotation when snippets are disabled → on first sync (or any edit — e.g. the W7 wildcard rule just added to the backend Ingress) the public API + admin Ingresses can fail admission (routing outage); at minimum the per-Ingress CSP is silently dropped.
- **Fix:** delete the redundant snippets (HSTS/X-* already applied controller-wide via `proxy-set-headers`); move the backend CSP to Helmet.js (as admin already does). Validate with `kubectl apply --dry-run=server`.

### W3-H2 — `TENANT_BASE_HOST` is unset cluster-wide → per-tenant subdomains resolve to the DEFAULT tenant
- **Where:** absent from `apps/backend/configmap.yaml` + `overlays/prod` (only `INGRESS_*_HOST` set); `tenantService.js:296` falls back to `'localhost'`.
- **What/impact:** when W7 wildcard DNS goes live, `parseTenantSlug('<slug>-api.vhhealth.app', ['localhost'])` returns null → `tenantFromHost()` returns **DEFAULT_TENANT_ID**. With `ALLOW_DEFAULT_TENANT=true` (current) that's a **cross-tenant data-exposure path**, and it silently disables the W4 Host↔token cross-check. A config defect, not "DNS not yet applied."
- **Fix:** set `TENANT_BASE_HOST: "vhhealth.app"` in the prod backend env; add to `validateEnv.js` to **fail closed** in production when it's `localhost`/unset; deploy-gate assertion.

### W3-H3 — CNPG nightly base backup is in the wrong namespace → never runs
- **Where:** `base/cnpg/scheduled-backup.yaml:16` (`namespace: vhhealth`) vs the Cluster in `vhhealth-platform`; no kustomize namespace transformer rewrites it.
- **What/impact:** the CR applies cleanly to the *wrong* namespace, finds no Cluster, and the operator never runs it — exactly the "WAL with no base backup" failure its own header warns of. (The daily full backup in `cluster.yaml` *is* correctly namespaced, so PITR isn't base-less — but the designed prefer-standby nightly is silently absent.)
- **Fix:** one line → `namespace: vhhealth-platform`; add a post-apply `kubectl get scheduledbackup/backup` verification + a kustomize lint asserting CNPG CRs share the cluster namespace.

### W3-H4 — Backend `/metrics` ServiceMonitor can't scrape (endpoint fails closed on a token the scrape never sends)
- **Where:** `apps/backend/service-monitor.yaml:20-31` + the app's `/metrics` auth.
- **What/impact:** the Prometheus scrape doesn't send the monitoring token the endpoint requires → **Prometheus is blind to the backend** (no app metrics, no backend alerts) — and the RED-dashboard/SLO story silently doesn't exist for the most important workload.
- **Fix:** split a dedicated unauthenticated `/metrics` listener (NetworkPolicy-scoped to the monitoring namespace) or give the ServiceMonitor the bearer token; assert a non-zero scrape in CI.

### Medium / Low (selected, ~33)
| Area | Finding |
|---|---|
| net/RBAC | `nginx-internal` IngressClass has no controller (staff-web/clinical-internal unroutable) · ingress-nginx SA has **cluster-wide secrets list/watch** · `allow-app-to-platform` NetworkPolicy admits the whole app ns to every data-plane pod/port · backend egress `0.0.0.0/0` on 443/587 + bare-`0.0.0.0/0` NTP |
| edge-trust | backend `trust proxy:1` behind a 2-hop edge → admin IP-allowlist matches the cloudflared pod IP (**non-functional**) · admin middleware trusts spoofable leftmost XFF · no edge WAF/rate-limit (per-IP collapses to one bucket) · `ALLOWED_ORIGINS` has no per-tenant subdomain (W7 CORS break) |
| DR/data | two overlapping ScheduledBackups to one stanza · **no RO pooler** + `DATABASE_READ_URL` placeholder (analytics hits primary) · PgBouncer session-mode pool sizing can exhaust `max_connections` · sync-replica `minSync=1` write-block on double-standby loss · `preferred` anti-affinity (PG pods can co-schedule) · CNPG image tag-pinned not digest |
| supply-chain | **no `cosign attest` / SBOM-provenance** on the prod Forgejo path (SBOM = throwaway artifact) · digest-pin write-back resolves tag→digest **without `cosign verify`** · Kyverno tlog posture unresolved · base images + ollama/busybox on **floating tags** · no Kyverno hardening backstop (readOnlyRootFS/limits) |
| gitops | monitoring ArgoCD Apps run `prune+selfHeal` against moving HEAD (contradicts the manual-sync posture of platform/apps) |
| observability | canary/backup-verify CronJobs have **no staleness alert** (the synthetic-outage signal is itself unmonitored) · **Loki 30d vs CERT-In 180d** + single-binary SPOF · **Ollama deep-AI is a single-replica StatefulSet, no PDB** (PHI deep-tier SPOF) · no Redis-HA / outbox-depth / dead-letter alerts · Prometheus 30d, no Thanos · topology spread `ScheduleAnyway` |

### Infra opportunities (23, grouped)
- **Supply-chain → SLSA-L3:** `cosign attest` SBOM + SLSA provenance, *required at admission*; verify-before-pin; digest-pin base + 3rd-party images; ArgoCD SSO/RBAC `[S–M]`.
- **DR / multi-region:** 2nd-region CNPG **replica cluster bootstrapped from R2**; automated monthly restore-verify; **object-store Loki + Thanos on R2** (180-day retention + durability + multi-region in one move) `[M–L]`.
- **Edge:** **Cloudflare Access (Zero-Trust)** for the admin portal (replaces the broken IP allowlist); codify the CF edge (WAF, rate-limit, wildcard DNS, tunnel) as **Terraform in-repo**; tenant-slug validation against DNS/cert constraints; synthetic edge→tenant Host-resolution smoke `[S–M]`.
- **Data:** RO pooler + wire `DATABASE_READ_URL`; pgAudit → independent 180-day object-store sink; CNPG ImageCatalog declarative major-upgrade path `[S–M]`.
- **Net/runtime:** Cilium L7 default-deny + per-tenant NetworkPolicy for the W7 model; Falco + Kyverno PolicyReports → alerting + a runtime-anomaly model on the Ollama PHI path `[M–L]`.
- **Observability:** unauthenticated `/metrics` listener; the missing alert tier (Redis HA, outbox/dead-letter depth, canary/backup staleness, pooler saturation); de-SPOF the deep-AI tier (2nd GPU + model-aware router) `[S–L]`.

---

## Consolidated remediation backlog
The prioritized, workstream-grouped, tier-ranked action plan across all three waves is maintained as **§0 of [`ROADMAP.md`](ROADMAP.md)** (the live tracker; this doc is the evidence record it links back to). Summary: **13 confirmed Highs → 9 T0 workstreams; ~60 Mediums → T1 hardening; ~85 opportunities → ~12 T2 S-tier upgrade epics.**
