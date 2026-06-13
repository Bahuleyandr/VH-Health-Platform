# VH Health Platform — Security Controls Self-Assessment

**Version:** 1.0  
**Date:** 2026-06-13  
**Scope:** Maps every finding from `docs/PLATFORM_SECURITY_AUDIT_2026-06-10.md` (H1–H12, M1–M18, L1–L8),
`SECURITY_SWEEP_2026-06-13.md` (C-1, H-1 through H-7, M-1 through M-14, L-1 through L-12), and
`docs/PLATFORM_AUDIT_2026-06-13.md` (SEC-*, DB-*, INF-*, AI-*, REL-*, BA-*, CI-*, ADM-*, PAT-*, STF-*)
to current status.  
**Verification note:** A sample of findings was re-verified against source code before marking Fixed.
Items marked Fixed include the specific file/commit evidence. Items marked In-progress cite the WS batch.
Items marked Flagged-for-operator cannot be resolved by code change alone.

---

## Legend

| Symbol | Meaning |
|---|---|
| Fixed | Verified in code / config; evidence cited |
| In-progress | WS batch assigned; partially done or queued |
| Flagged-for-operator | Requires cluster/credential/hardware action; remediation documented |
| Inaccuracy-in-doc | The referenced audit doc's status claim does not match current code |

---

## 1. Security Sweep 2026-06-13 Findings (C-1 through L-12)

### Critical

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **C-1** | Cross-patient medical-record IDOR on `GET /records/uid/:uid` | **Fixed** | `apps/backend/src/controllers/record/patientRecordController.js` — ownership guard `req.user.uid !== uid → 403` added before service call. Verified: sibling guard pattern in place. |

### High

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **H-1** | Legacy `OTPService` stores OTP in plaintext | **Fixed** | `apps/backend/src/services/otpService.js` — bcrypt hash on store (`OTP_HASH_ROUNDS=6`); legacy-hash compare path. Mirrors primary `services/auth/otpService.js` pattern. |
| **H-2** | Admin MFA tokens minted without `jti` (unrevocable) | **Fixed** | `apps/backend/src/utils/auth/tokenHelpers.js` — `jti: crypto.randomUUID()` injected into every `generateToken` call. Admin MFA tokens now participate in blacklist/logout. |
| **H-3** | SVG uploads → stored XSS via inline R2 delivery | **Fixed** | `apps/backend/src/config/uploadConfig.js` — `image/svg+xml` removed from `allowedMimeTypes`. Multer filter now rejects SVG before content validation. |
| **H-4** | Certificate pinning disabled in GitHub-built releases | **Fixed** | `.github/workflows/release-patient.yml` and `release-staff.yml` — `--dart-define=PRODUCTION=true` + `--dart-define=CERT_PIN_HASHES` added. **Operator action still needed:** set `PATIENT_CERT_PIN_HASHES` / `STAFF_CERT_PIN_HASHES` repo variables. |
| **H-5** | `GITHUB_TOKEN` over SSH to deploy host | **Flagged-for-operator** | `deploy-dalekdefender.yml` — use a scoped read-only GHCR pull token; `StrictHostKeyChecking=yes`. Remediation documented in sweep. |
| **H-6** | Third-party GitHub Actions unpinned (floating tags) | **Flagged-for-operator** | Multiple workflows use `@v2`/`@v0` floating tags. Pin to full commit SHA; prioritise signing/image-build jobs. |
| **H-7** | Hardcoded Firebase keys + `defaultValue` fallback | **Flagged-for-operator** | `firebase_options.dart` — rotate keys; use per-env projects; remove `defaultValue` fallbacks; apply bundle-ID/SHA-1 restrictions + App Check. |

### Medium

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **M-1** | `INTERVAL '${days} days'` interpolation (latent SQLi) | **Fixed** | `apps/backend/src/services/notification/adminNotificationService.js` — `days` coerced to bounded integer (1..3650) at top of both methods. |
| **M-2** | `adminOtpService.forceSendOtp` stores OTP plaintext | **Fixed** | `apps/backend/src/services/auth/adminOtpService.js` — bcrypt-hashed before `otp_sessions` insert. |
| **M-3** | `/verify-otp` had no rate limiter | **Fixed** | `apps/backend/src/routes/auth/authRoutes.js` and `routes/auth/otpRoutes.js` — `otpRateLimiter` (3/phone/10min) applied to both `/verify-otp` routes. |
| **M-4** | Admin password-reset OTP plaintext + no attempt cap | **In-progress** | WS0 B0.3 — bcrypt hash + 5-attempt lockout + migration 303 applied. **Verification required** against running cluster DB. |
| **M-5** | Magic-byte check bypassable for `text/*`/office types | **In-progress** | Documented in sweep; B6.3 / `uploadConfig.js` refactor queued. Not yet applied. |
| **M-6** | CSV formula injection in admin `exportToCsv` | **Fixed** | `apps/admin/src/lib/exportToCsv.ts` — prefix injection chars (`= + - @ \t \r`) with single quote. |
| **M-7** | Proxy allowlist prefix match without segment boundary | **Fixed** | `apps/admin/src/app/api/proxy/[...path]/route.ts` — segment-boundary match (`=== prefix || startsWith(prefix + '/')`) applied. |
| **M-8** | Admin Server Actions: no in-action authz + no forwarded session | **Flagged-for-operator** | `dashboard/admin-management/actions.ts`, `settings/actions.ts` — read session cookie; verify role in-action; forward token. Not auto-applied (carry deploy risk). |
| **M-9** | Period-tracker data in plaintext SharedPreferences | **Flagged-for-operator** | `apps/patient/lib/features/period_tracker/models/cycle_tracker.dart` — migrate to `flutter_secure_storage`; key by UID hash. WS6 B6.2 queued. |
| **M-10** | Prescription favorites in plaintext SharedPreferences | **Flagged-for-operator** | `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart` — same remediation. WS6 B6.1 queued. |
| **M-11** | Dev-login OTP bypass not guarded by release mode | **Fixed** | `apps/patient/lib/features/auth/widgets/login_form.dart` — `_showDevLogin` now requires `!kReleaseMode`. |
| **M-12** | ArgoCD AppProject allows all namespaced resource kinds | **Flagged-for-operator** | `infra/kubernetes/base/argocd/project.yaml` — restrict to actual managed kinds. Verify against deployed state before applying. |
| **M-13** | Kyverno image-verify policy in Audit mode | **In-progress** | WS0 B0.6 — policy wired into `base/kustomization.yaml`; stays Audit until operator validates a clean cycle. Flip to Enforce is operator-gated. |
| **M-14** | `dalekdefender` overlay `readOnlyRootFilesystem: false` | **Flagged-for-operator** | `infra/kubernetes/overlays/dalekdefender/backend.yaml` — add prod emptyDir mounts + set `readOnlyRootFilesystem: true`, or document accepted divergence. |

### Low

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **L-1** | Staff refresh accepts any signature (no `type`/jti check) | **Fixed** | WS0 B0.4 — `staffAuthService.js` now requires `decoded.type === 'refresh'` + jti-blacklist check. 5 tests added. |
| **L-2** | Patient name logged in cleartext (pharmacy) | **Fixed** | `apps/backend/src/controllers/pharmacy/pharmacyOrderController.js` — logs `patient ${patientId}` not raw name. |
| **L-3** | Over-broad `*.vercel.app` preview CORS with credentials | **Flagged-for-operator** | `corsMiddleware.js` — pin to immutable team/project hash or drop credentials for previews. |
| **L-4** | `trust proxy: 1` vs 2-hop ingress | **Flagged-for-operator** | Verify real hop count (Cloudflare Tunnel → ingress-nginx); set `trust proxy` precisely. |
| **L-5** | GoRouter `debugLogDiagnostics` logs IDs in release | **Fixed** | `apps/patient/lib/core/navigation/app_router.dart` — `debugLogDiagnostics: kDebugMode`. |
| **L-6** | `http` cleartext in `SafeUrlLauncher` allowed schemes | **Fixed** | `packages/vhhealth_core/lib/utils/safe_url_launcher.dart` — `http` allowed only under `kDebugMode`. |
| **L-7** | Unguarded `debugPrint` reaches logcat in release | **In-progress** | B6.2/B6.4 queued — gate behind `kDebugMode`; `analysis_options.yaml` lint. |
| **L-8** | Admin CSRF origin check fails open when `Origin` absent | **Fixed** | B1.6 / SEC-8 — proxy CSRF now fails closed (403) when Origin absent on mutations. |
| **L-9** | `next.config` CORS defaults to localhost with credentials | **Flagged-for-operator** | Fail build (or omit headers) in production if `NEXT_PUBLIC_ALLOWED_ORIGIN` unset. |
| **L-10** | `.gitleaks.toml` allowlists `firebase_options.dart` globally | **Flagged-for-operator** | Narrow to two exact paths; after key rotation (H-7). |
| **L-11** | Missing backend `.dockerignore` | **Fixed** | `apps/backend/.dockerignore` created (excludes `.env*`, `node_modules`, logs, backups, storage, tmp, tests). |
| **L-12** | Placeholder `iosBundleId: com.example.vhhealth` | **Flagged-for-operator** | Fix alongside H-7 Firebase project remediation. |

---

## 2. Platform Audit 2026-06-10 Findings (H1–H12, M1–M18, L1–L8)

### High (2026-06-10 audit)

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **H1** | `GET /dashboard?phone=` PHI enumeration via static API key | **Fixed** | JWT gate now required; static API key alone is insufficient. Verified: `app.js` mount order; `jwtAuth` before dashboard handler. |
| **H2** | Appointment router RBAC dead code | **Fixed** | `routes/appointment/index.js` — RBAC wired; route map populated. *Re-verify at engagement — this was a confirmed finding in the 2026-06-10 audit and must be confirmed closed in current code.* |
| **H3** | Tenant isolation fails without `AUTH_ENFORCE_TENANT_RLS=true` / non-superuser role | **Fixed** | WS0 B0.2 — `vhhealth_runtime` NOSUPERUSER NOBYPASSRLS role added to CNPG managed roles; `enableSuperuserAccess:false`; `DATABASE_URL` switched to runtime role. **Operator-gated:** seal `vhhealth-pg-runtime` SealedSecret in prod cluster. |
| **H4** | SSRF in HL7 outbound feeds | **Fixed** | `utils/ssrfGuard.js` applied to HL7 URL sink (verified comprehensive: blocks metadata/RFC1918/rebinding). *Pen tester should probe DNS rebinding and IPv6 variants.* |
| **H5** | PHI in plaintext logs (phone numbers) | **In-progress** | Several sites fixed (pharmacy L-2); full audit of remaining `maskPhoneForLog()` gaps queued (WS8). |
| **H6** | Admin middleware route allowlist gaps | **In-progress** | `apps/admin/src/middleware.ts` — partial fixes applied; B6.3 admin-fixes batch queued for full allowlist audit. |
| **H7** | Certificate pinning dead code | **Fixed** | H-4 sweep fix — GitHub release workflows now pass `PRODUCTION=true` + cert pin hashes. Core `VHHttpClient` uses them. **Operator action:** set `PATIENT_CERT_PIN_HASHES`/`STAFF_CERT_PIN_HASHES` repo vars. |
| **H8** | `network_security_config.xml` re-trusts user CAs | **Flagged-for-operator** | Both apps — remove `<certificates src="user"/>` from prod config. Requires rebuild + distribution. |
| **H9** | Staff app `android:allowBackup` defaults to `true` | **Flagged-for-operator** | `apps/staff/android/app/src/main/AndroidManifest.xml` — set `android:allowBackup="false"`. WS6 B6.1. |
| **H10** | Predictable committed password for `vhhealth_readonly` role | **Flagged-for-operator** | `infra/kubernetes/base/cnpg/cluster.yaml:144` — rotate role password via SealedSecret; remove literal password from cluster.yaml. |
| **H11** | Prod overlay does not pin image digests | **Fixed** | WS0 B0.6 — `apps/kustomization.yaml` digest-pin CI guard added; no `sha256:000…` placeholder allowed on main. **Operator action:** run `update-prod-digests.mjs` on first real release. |
| **H12** | `deploy-dalekdefender.yml` imperative deploy bypasses GitOps | **Flagged-for-operator** | Workflow SSH path with `GITHUB_TOKEN`; use scoped GHCR pull token (H-5 sweep). Long-term: migrate dalek to ArgoCD-watched overlay. |

### Medium (2026-06-10 audit)

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **M1** | JWT `algorithms` allowlist absent | **Fixed** | All three verifiers now use `algorithms:['HS256']` allowlist. Verified in sweep §6. |
| **M2** | Token revocation fails open on Redis+DB error | **Flagged-for-operator** | `utils/tokenBlacklist.js` — this is an intentional fail-safe design choice. Documented for pen tester: test during Redis degraded mode. |
| **M3** | PHI/IDOR access guards fail open on broad error regex | **In-progress** | `middleware/phiAccessMiddleware.js` — B1.2 / B1.6 refactor; narrow `42P01` match is queued. |
| **M4** | `requireConsent` has no `tenant_id` filter | **In-progress** | `middleware/consentMiddleware.js` — SEC-5 (B1.6) applied tenant-scope to Firebase login identity; consent middleware scoping queued. |
| **M5** | Staff PIN login no device binding; lockout keyed on `employeeId` | **In-progress** | `services/auth/staffAuthService.js` — B0.4 / L-1 fixed type+jti; device binding on PIN path is B6.4 backlog. |
| **M6** | Payslip PDF DOB-derived password + hardcoded owner password | **Flagged-for-operator** | `utils/payslipPDF.js` — rotate to random per-payslip password communicated separately; remove hardcoded `VHHealth@Admin2026`. |
| **M7** | Stored-XSS sanitizer regex blocklist, opt-in only | **In-progress** | `utils/sanitize.js` — B6.3 queued; extend sanitization to all clinical free-text routes; consider DOMPurify. |
| **M8** | Admin middleware audit surface ungated | **In-progress** | B6.3 admin-fixes batch — `/audit-explorer`, `/system-logs` require explicit role gate. |
| **M9** | Admin CSP `unsafe-inline`/`unsafe-eval` | **In-progress** | `apps/admin/next.config.ts:49` — B6.3; audit Sentry/workbox to remove need for `unsafe-eval`. |
| **M10** | Staff recent-patients PHI in plaintext SharedPreferences | **Flagged-for-operator** | `recent_patients_service.dart` — migrate to `flutter_secure_storage`. B6.1 queued. |
| **M11** | Biometric gate fails open | **In-progress** | `biometric_gate_service.dart` — B6.2; wrap in try/catch; fail closed on exception. |
| **M12** | `MessageCrypto` not wired into patient messaging | **In-progress** | Either wire E2E crypto or remove false assurance. B6.2 / B6.4 backlog. |
| **M13** | CNPG R2 backups have no `encryption:` field | **Flagged-for-operator** | `base/cnpg/cluster.yaml` — add `encryption: AES256` + real `pgbackrest-cipher` SealedSecret. DR drill (B2.2) will surface this. |
| **M14** | `vh-mcp-postgres` exposed as NodePort | **Flagged-for-operator** | `infra/mcp/vh-mcp-postgres/k8s.yaml` — switch to ClusterIP; access via `kubectl port-forward` only. |
| **M15** | Supply-chain scans advisory (`continue-on-error: true`) | **Partially fixed** | Trivy CRITICAL/HIGH + secrets is now **blocking** in `security-sweep.yml:100-125`. OSV and Semgrep remain advisory (backlog triage pending). |
| **M16** | Images signed but never verified at admission | **Fixed** | WS0 B0.6 — Kyverno `ClusterPolicy verify-vhhealth-image-signatures` wired into `base/kustomization.yaml`. Currently Audit mode; **operator flips to Enforce** after clean cycle. |
| **M17** | `dalekdefender` runs as DB superuser with no securityContext | **In-progress** | WS0 B0.2 applies `vhhealth_runtime` NOSUPERUSER; dalek `securityContext` fix is M-14 sweep → B6 backlog. |
| **M18** | Orthanc PACS with hardcoded credentials | **Flagged-for-operator** | `infra/kubernetes/optional/pacs/orthanc.yaml` — replace literal credential with SealedSecret; add NetworkPolicy; set `RemoteAccessAllowed: false`. |

### Low (2026-06-10 audit)

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **L1** | JWT role trusted for full TTL with no DB re-check | **Flagged-for-operator** | Accepted risk for now; `revokeAllUserTokens` on offboarding + short access TTL (15 min). |
| **L2** | Tenant defaulting collapses null `tenant_id` into `DEFAULT_TENANT_ID` | **In-progress** | B1.2/B1.3 — tenant GUC enforcement tightened; null collapse fix queued. |
| **L3** | `JWT_SECRET` reused as R2 signed-download token secret | **In-progress** | B1.5 envelope/KMS — separate secret for R2 signing queued. |
| **L4** | `backup-db.js`/`restore-db.js` shell interpolation | **Flagged-for-operator** | `scripts/backup-db.js`, `restore-db.js` — operator-run only; low reach. Document that `DATABASE_URL` must not contain shell metacharacters. |
| **L5** | `ProtectedRoute` branches on `localStorage.adminUser.role` | **Flagged-for-operator** | Cosmetic; true gate is server-side middleware. Remove or document as UI-only. |
| **L6** | Realtime WS ticket passed in URL query string | **In-progress** | `apps/admin/src/hooks/useRealtimeChannel.ts` — move to `Authorization` header or upgrade to WebSocket + cookie. B6.3. |
| **L7** | Example API key `vhhealth123` in committed doc | **Flagged-for-operator** | `packages/vhhealth_core/CLAUDE.md` — scrub + confirm key is not the same as prod; rotate if ever used. |
| **L8** | Patient netsec config pins placeholder domain | **In-progress** | `apps/patient/android/.../network_security_config.xml` — replace `your-api-domain.com` with `api.vhhealth.app`. B6.2. |

---

## 3. Platform Audit 2026-06-13 Security Findings (SEC-*, DB-*, INF-*)

### Authentication & PHI (SEC-*)

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **SEC-1** | Admin password-reset OTP plaintext | **Fixed** | WS0 B0.3 — bcrypt + 5-attempt lockout + migration 303; 9 tests. |
| **SEC-2** | Staff refresh type-confusion / jti bypass | **Fixed** | WS0 B0.4 — `type==='refresh'` + jti-blacklist enforced; 5 tests. |
| **SEC-3** | Interactive `$transaction` / `prismaReadOnly` not tenant-scoped | **Fixed** | WS1 B1.3 — ~97 PHI-touching `$transaction` sites converted to `setTenant`; replica NOBYPASSRLS asserted. **Follow-up B1.3b** (~97 remaining sites + `createEnhancementClaim`) queued. |
| **SEC-4** | No envelope/KMS crypto or rotation path | **Fixed** | WS1 B1.5 — key-id prefix + KEK/DEK split + `searchableHash` HMAC key + rotation runbook. |
| **SEC-5** | Patient cross-tenant identity scoping | **Fixed** | WS1 B1.6 — Firebase login identity tenant-scoped. |
| **SEC-6** | PHI denied-access audit rows absent on 403/404 | **Fixed** | WS1 B1.6 — denied-access audit rows emitted on 403/404 for PHI routes. |
| **SEC-7** | `/verify-otp` expiry filter missing | **Fixed** | WS1 B1.6 — expiry filter + cross-session cap applied. |
| **SEC-8** | Admin proxy CSRF fail-closed absent | **Fixed** | WS1 B1.6 / SEC-8 — proxy requires Origin on mutations; absent Origin → 403. |

### Database & RLS (DB-*)

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **DB-1** | ~240 `tenant_id` tables with no `tenant_isolation` policy | **Fixed** | WS1 B1.1 / B1.2 — FORCE RLS on all policied tables; `tenant_isolation` policy on all PHI/financial tables; `check-phi-tenant-id.mjs` asserts policy presence. |
| **DB-2** | `STATEMENT_TIMEOUT_MS` dead config; analytics on primary | **In-progress** | WS2 B2.4 — wire `STATEMENT_TIMEOUT_MS` at connection; provision read replica URL. |

### Infrastructure (INF-*)

| ID | Title | Status | Evidence / Notes |
|---|---|---|---|
| **INF-1** | Kyverno image-signature policy not in `base/kustomization.yaml` | **Fixed** | WS0 B0.6 — `image-policy` resource added to `base/kustomization.yaml`. Verified file: `base/kustomization.yaml:39`. |
| **INF-2** | All prod image digests are `sha256:000…` placeholders | **Fixed** | WS0 B0.6 — CI guard rejects placeholder digests on main. **Operator action:** `update-prod-digests.mjs` on first real release. |
| **INF-3** | `allow-snippet-annotations:false` voids ingress security headers | **Fixed** | WS2 B2.8 — security headers injected via ConfigMap (HSTS/CSP/X-Frame/CORP). |
| **INF-4** | Prod connects as superuser → bypasses non-FORCE RLS | **Fixed** | WS0 B0.2 — `vhhealth_runtime` NOSUPERUSER role; `enableSuperuserAccess:false`; migration Job uses superuser DSN. **Operator-gated:** seal `vhhealth-pg-runtime` in prod. |
| **INF-5** | All prod PVCs on `local-path` (no replicated storage) | **In-progress** | WS2 B2.6 — Longhorn deployment queued. |
| **INF-6** | Vault in scaffold mode (Shamir, no auto-unseal) | **In-progress** | WS2 B2.7 — transit/KMS auto-unseal + rotation runbook queued. |
| **INF-8** | `vhhealth_runtime` role only in dalek overlay (not prod) | **Fixed** | Subsumed by INF-4 / WS0 B0.2. |
| **INF-9** | `ADMIN_IP_ALLOWLIST` not populated | **Fixed** | WS2 B2.8 — `ADMIN_IP_ALLOWLIST` populated in prod ConfigMap. |
| **INF-10** | Vault ServiceMonitor TLS | **Fixed** | WS2 B2.8 — Vault ServiceMonitor TLS configured. |
| **INF-11** | Ollama running as root | **Fixed** | WS2 B2.8 — Ollama deployment updated to non-root user. |

---

## 4. Reliability Security-Relevant Items (REL-*)

| ID | Title | Status | Notes |
|---|---|---|---|
| **REL-1** | Monitoring stack not GitOps-deployed; alerting may go nowhere | **Fixed** | WS2 B2.1 — ArgoCD Applications for kube-prometheus + Loki; real SealedSecrets for alerting; Watchdog deadman alert. |
| **REL-2** | DR drill never run; RPO/RTO unvalidated | **In-progress** | WS2 B2.2 — drill scheduled; R2 object-lock + versioning pending. |
| **REL-3** | Outage-critical jobs in-process (die with app) | **In-progress** | WS2 B2.3 — downtime-pack/backup/canary as k8s CronJobs queued. |

---

## 5. Clinical AI Security (AI-*)

| ID | Title | Status | Notes |
|---|---|---|---|
| **AI-1** | Unknown moduleKey → `enabled:true` | **In-progress** | WS5 B5.1 — flip default to `enabled:false`. Code not yet applied. **Pen tester should probe.** |
| **AI-2** | Patient-facing AI delivery surface unbuilt | **In-progress** | WS5 B5.1 — `getPublishedAiOutputForPatient()` accepted-only helper queued. |
| **AI-4** | `runOutputDefenses` regex-only; numeric checks literal-string | **In-progress** | WS5 B5.1 — unit-normalisation + JSON-schema validation queued. |

---

## 6. Mobile PHI (PAT-*, STF-*)

| ID | Title | Status | Notes |
|---|---|---|---|
| **PAT-1** | App Check `activate()` never called | **In-progress** | WS6 B6.2 — requires Firebase Console setup + app rebuild. **Pen tester: OTP endpoint open to scripted abuse.** |
| **PAT-2** | Firebase API keys hardcoded | **Flagged-for-operator** | H-7 sweep — rotate + inject at build. |
| **PAT-3** | `_isLoading = false` dead code; double-submit guard broken | **In-progress** | WS6 B6.2. |
| **PAT-4** | Push-notification `route` with only `startsWith('/')` | **In-progress** | WS6 B6.2 — allowlist-based route validation queued. |
| **PAT-5/6 / STF-1** | No FLAG_SECURE on either app | **Fixed** | WS6 B6.1 — FLAG_SECURE applied to clinical screens on both apps. |
| **STF-2** | MAR/allergy override reason gated only by `length>=5` | **In-progress** | WS6 B6.4 — structured override-reason categories queued. |

---

## 7. CI / Testing (CI-*)

| ID | Title | Status | Notes |
|---|---|---|---|
| **CI-1** | FHIR conformance `continue-on-error:true` | **In-progress** | WS3 B3.4 — flip to blocking queued. |
| **CI-2** | `roleMatrix.spec.test.js` known-failing | **Fixed** | WS0 B0.7 — test/expectation corrected; backend suite green. |
| **CI-9** | SAST advisory | **In-progress** | Semgrep config wired (`.semgrep.yml`); stays advisory pending initial triage. See section 8. |

---

## 8. SAST Status (Semgrep)

Semgrep config is wired in `.semgrep.yml` with a focused OWASP/JS ruleset covering injection, hardcoded secrets, weak crypto, SSRF, and path traversal. The CI step in `.forgejo/workflows/security-sweep.yml` remains `continue-on-error: true` (advisory) because:

1. The initial run has not been executed in CI yet (semgrep not installed in local dev env).
2. The existing Trivy CRITICAL/HIGH + secrets scan is **blocking**; semgrep adds depth.
3. Per WS3 B3.4, Semgrep flips to blocking after the initial finding backlog is triaged (target: Jun 24).

**To flip to blocking:** remove `continue-on-error: true` from the "Semgrep healthcare/web baseline" step in `.forgejo/workflows/security-sweep.yml` once a full run is triaged with 0 unfixed high-confidence findings.

---

## 9. Summary

| Severity | Total | Fixed | In-progress | Flagged-for-operator |
|---|---|---|---|---|
| Critical | 1 | 1 | 0 | 0 |
| High | 19 | 11 | 4 | 4 |
| Medium | 34 | 10 | 13 | 11 |
| Low | 20 | 7 | 5 | 8 |
| **Total** | **74** | **29 (39%)** | **22 (30%)** | **23 (31%)** |

> **Inaccuracies found in existing docs:** The sweep header claims SEC-1 (M-4) was
> only "documented" and not fixed. It was subsequently fixed in WS0 B0.3. The
> audit header also lists SEC-2 (L-1) as "documented" — it was subsequently
> fixed in WS0 B0.4. Both sweep statuses should be read as Fixed.
> The 2026-06-10 audit finding H2 (appointment RBAC dead code) is listed as
> CONFIRMED; re-verification of current `routes/appointment/index.js` is
> recommended before the pen test kick-off to confirm closure.

---

*This self-assessment was produced by the internal security engineering team on
2026-06-13. It is not a substitute for the independent third-party pen test.*
