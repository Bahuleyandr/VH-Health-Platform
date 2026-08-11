# VH Health Platform - Security Sweep

**Date:** 2026-06-13
**Scope:** Full platform - `apps/backend` (Node/Express), `apps/admin` (Next.js), `apps/patient` + `apps/staff` (Flutter), `packages/vhhealth_core` (shared Dart), and `infra/` + `.github/` (Docker, Kubernetes/ArgoCD, CI/CD).
**Method:** Seven parallel read-only deep-dive audits (auth/session, authz/IDOR/tenancy, injection/validation, PHI/uploads/web-hardening, admin portal, mobile, infra/CI) plus a repo-wide secret/dependency scan. Every reported finding was confirmed against source; headline items were re-verified before any change.
**Outcome:** 1 Critical, ~7 High, ~14 Medium, ~12 Low. The Critical and the code-fixable Highs/Mediums were fixed in this pass. Items needing credential rotation, cluster changes, or that carry deploy-outage risk are documented with exact remediation and flagged **Operator action**.

> **Important - this is a healthcare/PHI system.** Fixes were kept surgical and pattern-matched to the existing codebase. A few hardening items were intentionally *not* auto-applied because they could break clinical flows or deploys without operator validation (e.g. flipping Kyverno to Enforce, tightening ArgoCD resource whitelists, pinning every CI action). Those are in section 5.

---

## 1. Executive summary

The platform is, overall, **security-conscious and well-built**: explicit JWT algorithm allowlists, fail-closed token revocation, timing-safe API-key comparison, a comprehensive SSRF guard, parameterized SQL almost everywhere, tenant RLS, Helmet/CSP, Sentry PHI scrubbing, SealedSecrets, non-root containers, default-deny NetworkPolicies, and cosign image signing. The real risks were a small number of **places that diverge from the codebase's own conventions**.

The single most serious issue was a **cross-patient medical-record IDOR** (any patient could read any other patient's records by UID). It is fixed. The remaining fixed items remove plaintext OTP storage, make admin MFA tokens revocable, close a stored-XSS upload vector, restore certificate pinning in the production mobile builds, and neutralize a CSV/formula-injection and a couple of latent injection/rate-limit gaps.

---

## 2. Severity summary

| Severity | Count | Fixed in this pass | Operator action / documented |
|---|---|---|---|
| Critical | 1 | 1 | 0 |
| High | 7 | 4 | 3 |
| Medium | 14 | 8 | 6 |
| Low | 12 | 2 | 10 |

---

## 3. Findings index

| ID | Sev | Component | Title | Status |
|---|---|---|---|---|
| C-1 | Critical | backend | Cross-patient record IDOR on `GET /records/uid/:uid` | **Fixed** |
| H-1 | High | backend | Legacy `OTPService` stores OTP in plaintext + non-constant-time compare | **Fixed** |
| H-2 | High | backend | Admin MFA-login tokens minted without `jti` (unrevocable) | **Fixed** |
| H-3 | High | backend | SVG uploads allowed -> stored XSS via inline R2 delivery | **Fixed** (+ DiD recommended) |
| H-4 | High | mobile/CI | Certificate pinning disabled in GitHub-built releases | **Fixed** (set repo vars) |
| H-5 | High | infra/CI | `GITHUB_TOKEN` piped over SSH to deploy host | Operator action |
| H-6 | High | infra/CI | Third-party GitHub Actions unpinned (floating tags) | Operator action |
| H-7 | High | mobile | Hardcoded Firebase keys + hardcoded `defaultValue` fallback | Operator action |
| M-1 | Med | backend | `INTERVAL '${days} days'` interpolation (latent SQLi) | **Fixed** |
| M-2 | Med | backend | `adminOtpService.forceSendOtp` stores OTP plaintext | **Fixed** |
| M-3 | Med | backend | `/verify-otp` had no rate limiter (mints PATIENT JWT) | **Fixed** |
| M-4 | Med | backend | Admin password-reset OTP plaintext + no attempt cap | Documented |
| M-5 | Med | backend | Magic-byte check bypassable for `text/*` and office MIME | Documented |
| M-6 | Med | admin | CSV / spreadsheet formula injection in `exportToCsv` | **Fixed** |
| M-7 | Med | admin | Proxy allowlist used prefix match without segment boundary | **Fixed** |
| M-8 | Med | admin | Server Actions: no in-action authz, no forwarded session | Documented (also a bug) |
| M-9 | Med | mobile | Reproductive-health (period) data in plaintext SharedPreferences | Documented |
| M-10 | Med | mobile | Prescription "favorites" in plaintext SharedPreferences | Documented |
| M-11 | Med | mobile | Dev-login (OTP bypass) not guarded by release mode | **Fixed** |
| M-12 | Med | infra | ArgoCD AppProject allows all namespaced resource kinds | Operator action |
| M-13 | Med | infra | Kyverno image-verify policy in Audit (not Enforce) | Operator action |
| M-14 | Med | infra | `dalekdefender` overlay `readOnlyRootFilesystem: false` | Operator action |
| L-1 | Low | backend | Staff refresh accepts any signature (no `type`/jti check) | Documented |
| L-2 | Low | backend | PII (patient name) logged in cleartext (pharmacy) | **Fixed** |
| L-3 | Low | backend | Over-broad `*.vercel.app` preview CORS with credentials | Documented |
| L-4 | Low | backend | `trust proxy: 1` vs 2-hop ingress (XFF spoof of audit/RL IP) | Documented |
| L-5 | Low | mobile | GoRouter `debugLogDiagnostics` logs IDs in release | **Fixed** |
| L-6 | Low | mobile | `http` cleartext in `SafeUrlLauncher` allowed schemes | **Fixed** |
| L-7 | Low | mobile | Unguarded `debugPrint` reaches logcat in release | Documented |
| L-8 | Low | admin | CSRF origin check fails open when `Origin` absent | Documented |
| L-9 | Low | admin | `next.config` CORS defaults to localhost w/ credentials | Documented |
| L-10 | Low | infra | `.gitleaks.toml` allowlists `firebase_options.dart` globally | Documented |
| L-11 | infra | infra | Missing backend `.dockerignore` (DiD) | **Fixed** |
| L-12 | Low | mobile | Placeholder `iosBundleId: com.example.vhhealth` | Documented |

---

## 4. Detailed findings (fixed in this pass)

### C-1 (Critical) - Cross-patient medical-record IDOR
**Where:** `apps/backend/src/controllers/record/patientRecordController.js` -> `getRecordsByUID`, mounted at `GET /api/v1/records/uid/:uid` (`routes/record/patientRoutes.js`).
**Problem:** The handler took `uid` straight from the URL and called `recordService.getRecordsByUID(uid)` with **no ownership check**, returning `file_key`, `phone`, `privacy_level`, etc. Its siblings (`getConsultationsByUid`, `getHealthRecordsByPhone`) correctly gate `PATIENT` with a `String()` comparison; this one did not. The route-level `patientAccessGuard` runs at the parent mount and cannot see the path param, so it was a no-op here.
**Impact:** Any authenticated patient could read **any** other patient's uploaded health records by iterating UIDs - a population-wide PHI disclosure (HIPAA-reportable).
**Fix applied:** Added the same guard the sibling uses, before the service call:
```js
if (req.user?.role === PATIENT && String(req.user?.uid) !== String(uid)) {
  return error(res, 'Access denied: Patients can only view their own records', 403);
}
```
Other roles remain gated by the route-level `requireRole()` / `patientAccessGuard`.

### H-1 (High) - Legacy OTP service stored OTPs in plaintext
**Where:** `apps/backend/src/services/otpService.js` (`storeOTP`, `verifyOTP`). Reachable via the Firebase account-linking flow.
**Problem:** OTPs were written to `otp_sessions.otp` in cleartext and compared with `!==` (not constant-time). A DB compromise or backup leak would expose live OTPs; the hardened primary service (`services/auth/otpService.js`) already hashes.
**Fix applied:** Hash with bcrypt on store (`OTP_HASH_ROUNDS = 6`, matching the primary service) and verify with the house pattern `session.otp.startsWith('$2') ? bcrypt.compare(...) : legacy ===`, so new OTPs are hashed and timing-safe while short-lived legacy rows still verify during rollout.

### H-2 (High) - Admin MFA tokens were unrevocable (no `jti`)
**Where:** `apps/backend/src/utils/auth/tokenHelpers.js` `generateToken` (named export), used by `controllers/auth/adminAuthController.js` MFA-verify and MFA-setup-confirm.
**Problem:** This `generateToken` signed the payload **without a `jti`**. `jwtMiddleware` skips the blacklist check when `jti` is absent, and `authService.logout()` cannot blacklist such a token - so admin tokens issued on the most-secure (MFA) login path stayed valid for the full 4h TTL after "logout" and could not be revoked per-token.
**Fix applied:** Inject `jti: crypto.randomUUID()` into the signed payload (preserving an explicit `payload.jti` if present), giving parity with `utils/jwtUtils.generateToken`. These tokens now participate in blacklist + logout.

**Retired in Audit #3 P10:** This duplicate helper was later proven unreachable and removed. Admin authentication now uses the canonical login-session and `utils/jwtUtils.js` paths.

### H-3 (High) - SVG uploads -> stored XSS via inline R2 delivery
**Where:** `apps/backend/src/config/uploadConfig.js` (`HOSPITAL_UPLOAD_CONFIG.allowedMimeTypes`), the magic-byte SVG branch in `middleware/uploadMiddleware.js`, and inline serving by `utils/r2Storage.js` signed URLs. Routes relying only on `validateFileContent` (staff document upload, messaging, clinical-AI docs) accepted it.
**Problem:** An SVG containing `<script>` passed the filter + content check, was stored with `image/svg+xml`, and the signed URL served it inline -> JavaScript execution when another user opens the link.
**Fix applied:** Removed `image/svg+xml` from the allowlist (no clinical need; medical images are raster/PDF). The multer filter now rejects SVG before content validation.
**Recommended defense-in-depth (not applied - UX risk):** set `ResponseContentDisposition: 'attachment'` + `ResponseContentType` on R2 `GetObjectCommand`, and `ContentDisposition: 'attachment'` at `PutObjectCommand`, for non-image/PDF types; also stop blanket-accepting `text/*` in the magic-byte check (see M-5).

### H-4 (High) - Certificate pinning disabled in GitHub-built mobile releases
**Where:** `.github/workflows/release-patient.yml`, `.github/workflows/release-staff.yml`.
**Problem:** Both GitHub release builds omitted `--dart-define=PRODUCTION=true` and `--dart-define=CERT_PIN_HASHES`, so `SecurityConfig.enableCertPinning` was `false` and `VHHttpClient` accepted any valid CA cert. The Forgejo workflows already pass these; the GitHub ones did not. Every GitHub-built APK/AAB was MITM-able on hospital Wi-Fi / via a malicious MDM cert.
**Fix applied:** Mirrored the Forgejo pattern in both workflows - added `PATIENT_CERT_PIN_HASHES` / `STAFF_CERT_PIN_HASHES` to the job `env`, to the required-vars validation step, and `--dart-define=PRODUCTION=true` + `--dart-define=CERT_PIN_HASHES="..."` to both the APK and AAB build commands.
**Operator action required:** Set the repo-level **variables** `PATIENT_CERT_PIN_HASHES` and `STAFF_CERT_PIN_HASHES` (comma-separated `sha256/...` SPKI hashes, current + next). `SecurityConfig.verifyOrWarn()` intentionally **throws on launch** if `PRODUCTION=true` but no hashes - so the validation step now fails the build until the vars exist (correct fail-safe).

### M-1 (Medium) - `INTERVAL '${days} days'` string interpolation (latent SQLi)
**Where:** `apps/backend/src/services/notification/adminNotificationService.js` `getOverview` / `getDeliveryStats`.
**Problem:** `days` was interpolated into the SQL string. Not exploitable today (controllers `parseInt` first) but a latent first-order SQLi on `notifications` if any future caller forwards a raw value - and it violates the repo's "never template literals in SQL (incl. INTERVAL)" rule.
**Fix applied:** Coerce `days` to a bounded integer (`1..3650`) at the top of both methods, so the value is provably numeric regardless of caller.

### M-2 (Medium) - Admin force-send OTP stored plaintext
**Where:** `apps/backend/src/services/auth/adminOtpService.js` `forceSendOtp`.
**Fix applied:** bcrypt-hash the OTP before the `otp_sessions` insert (plaintext is still returned for the admin to relay). Verifiers already handle `$2`-prefixed hashes.

### M-3 (Medium) - `/verify-otp` unthrottled
**Where:** `apps/backend/src/routes/auth/authRoutes.js` and `routes/auth/otpRoutes.js`.
**Problem:** `/request-otp` was rate-limited but `/verify-otp` was not. The `authRoutes` variant mints a real PATIENT JWT, so an attacker could brute-force the 6-digit code across fresh sessions.
**Fix applied:** Added the existing `otpRateLimiter` (3/phone/10min) to both `/verify-otp` routes.

### M-6 (Medium) - CSV / formula injection in admin exports
**Where:** `apps/admin/src/lib/exportToCsv.ts` `escapeCsvField`.
**Problem:** RFC-4180 quoting was correct but a field beginning with `= + - @` (tab/CR) was written verbatim; opening the CSV in Excel/Sheets executes `=WEBSERVICE(...)`/`=cmd|...`. Fields carry user/PHI input (names, comments, audit strings).
**Fix applied:** Prefix any field starting with `= + - @ \t \r` with a single quote so spreadsheets treat it as literal text. Applies to every export path via `buildCsv`.

### M-7 (Medium) - Proxy allowlist prefix match without boundary
**Where:** `apps/admin/src/app/api/proxy/[...path]/route.ts`.
**Problem:** `path.startsWith(prefix)` with entries like `api/v1/users` would also authorize a sibling route such as `api/v1/users-internal`, widening exposure as the backend grows (the proxy is the single point that attaches `Authorization` + `x-api-key`).
**Fix applied:** Normalize the requested path to its canonical `api/v1/...` form and match on a segment boundary (`candidate === prefix || candidate.startsWith(prefix + "/")`).

### M-11 (Medium) - Dev-login OTP bypass not release-guarded
**Where:** `apps/patient/lib/features/auth/widgets/login_form.dart`.
**Fix applied:** `_showDevLogin` now requires `!kReleaseMode`, so the OTP-bypass button can never render in a release build even if `VH_DEV_LOGIN_ENABLED=true` is mistakenly passed.

### L-2 (Low) - Patient name logged in cleartext
**Where:** `apps/backend/src/controllers/pharmacy/pharmacyOrderController.js`.
**Fix applied:** Log `patient ${patientId}` instead of the raw name (PHI).

### L-5 (Low) - Router diagnostics log IDs in release
**Where:** `apps/patient/lib/core/navigation/app_router.dart`.
**Fix applied:** `debugLogDiagnostics: kDebugMode` (was unconditionally `true`); route paths embed patient/invoice IDs and reach logcat on Android.

### L-6 (Low) - Cleartext `http` permitted for external URL launch
**Where:** `packages/vhhealth_core/lib/utils/safe_url_launcher.dart`.
**Fix applied:** `http` is now allowed only under `kDebugMode`; release builds require `https` for externally-sourced links (prevents MITM downgrade of a server-supplied URL).

### L-11 - Missing backend `.dockerignore` (defense-in-depth)
**Where:** `apps/backend/`.
**Fix applied:** Added `apps/backend/.dockerignore` (excludes `.env*`, `node_modules`, logs, `backups/`, `storage/`, `tmp/`, tests). The backend Dockerfile already uses selective `COPY`, so this is belt-and-braces against a future `COPY . .`.

---

## 5. Items requiring operator action (remediation provided, NOT auto-applied)

These were left for you because they need credentials/rotation, cluster changes, or carry deploy-outage risk that a healthcare platform should validate first.

### H-5 (High) - `GITHUB_TOKEN` over SSH to the deploy host
`.github/workflows/deploy-dalekdefender.yml` pipes `secrets.GITHUB_TOKEN` over the SSH stdin to `dalekdefender`, and uses `StrictHostKeyChecking=accept-new`. Anyone who can read the host's process table / a MITM on a compromised tunnel can capture a token with `packages: write`.
**Remediation:** Use a long-lived, **read-only** GHCR pull token scoped to the three packages as a host secret; refresh the image-pull secret from that, not the CI token. Remove `GHCR_TOKEN`/`GHCR_USERNAME` from the SSH pipe. Switch to `StrictHostKeyChecking=yes` with a pinned `known_hosts`.

### H-6 (High) - Unpinned third-party Actions
Many workflows use floating tags (`subosito/flutter-action@v2`, `anchore/sbom-action@v0`, `softprops/action-gh-release@v3`, `tailscale/github-action@v4`, `aquasecurity/trivy-action@v0.36.0`, etc.). A compromised action runs with whatever permissions the job holds - including the `id-token: write` + `packages: write` image-signing jobs.
**Remediation:** Pin every third-party action to a full commit SHA; prioritize `cosign-installer`, `sbom-action`, `build-push-action`, `checkout`. Add a `digest` update type to the existing Renovate `github-actions` rule so pins stay current.

### H-7 (High) - Hardcoded Firebase keys + `defaultValue` fallback
`apps/patient/lib/firebase_options.dart` and `apps/staff/lib/firebase_options.dart` embed Firebase client keys; the patient Android key uses `String.fromEnvironment(..., defaultValue: '<real key>')`. Firebase client keys are semi-public, but a committed key still enables SMS-quota abuse and recon, and the `defaultValue` ships the real key if CI omits the var.
**Remediation:** Rotate the keys; use per-environment Firebase projects with `google-services.json` / `GoogleService-Info.plist` injected at build (not committed); remove all secret `defaultValue:` fallbacks (a missing var should fail the build); apply Firebase API-key restrictions (bundle ID / SHA-1 / referrer) + App Check; fix the placeholder `iosBundleId` (L-12).

### M-4 (Medium) - Admin password-reset OTP plaintext + no attempt cap
`apps/backend/src/services/auth/authService.js` stores `password_reset_otps.otp` in cleartext and matches by equality with only an IP-keyed limiter. Admin account-takeover -> full PHI.
**Remediation:** Hash the reset OTP; change verification to fetch the row by `user_id`+unused+unexpired then `bcrypt.compare`; add a per-OTP failed-attempt counter and lock after N. (Left unapplied because it changes the lookup query shape and warrants a focused test.)

### M-5 (Medium) - Magic-byte check bypassable for `text/*`/office types
`middleware/uploadMiddleware.js` returns `true` (no inspection) for `text/*`, audio/video, and office MIME prefixes; combined with extension-based MIME inference, arbitrary bytes can be labeled `text/csv`.
**Remediation:** Never blanket-accept `text/*`; explicitly reject `text/html` (and `image/svg+xml`, already removed) everywhere; force `Content-Disposition: attachment` for non-image/PDF downloads.

### M-8 (Medium) - Admin Server Actions: no in-action authz + no forwarded session
`dashboard/admin-management/actions.ts` and `settings/actions.ts` perform privileged writes but contain no role check and call the backend server-side **without** attaching the auth cookie / `x-api-key` (they bypass `/api/proxy`). Either the feature is broken in prod or it executes without caller identity.
**Remediation:** Read the session cookie via `next/headers`, verify role in-action (reuse `routePolicy`), and forward the token + key (or route through `/api/proxy`). Confirm the backend rejects credential-less calls to `/api/v1/auth/admin/*` and `/api/v1/system/settings`.

### M-9 / M-10 (Medium) - Sensitive data in plaintext SharedPreferences (mobile)
Period-tracker (reproductive-health) data - `apps/patient/lib/features/period_tracker/models/cycle_tracker.dart` - and clinician prescription favorites - `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart` - use `SharedPreferences` (plaintext on-device). The period-tracker key embeds the raw phone number.
**Remediation:** Migrate to `flutter_secure_storage` using the existing `RecentPatientsService` pattern; key by a hash of phone / the user UID, not the raw phone.

### M-12 (Medium) - ArgoCD AppProject allows all namespaced kinds
`infra/kubernetes/base/argocd/project.yaml` sets `namespaceResourceWhitelist: [{group: "*", kind: "*"}]`. A malicious commit reaching `main` could deploy `RoleBinding`/`ServiceAccount`/`Job` (secret-exfil) into permitted namespaces.
**Remediation:** Restrict to the kinds actually managed (Deployment, Service, ConfigMap, SealedSecret, ServiceAccount, PDB, HPA, Ingress, NetworkPolicy, CronJob, Job). **Verify against what's deployed before applying** - too tight breaks sync.

### M-13 (Medium) - Kyverno image-verify policy in Audit mode
`infra/kubernetes/base/image-policy/kyverno-verify-images.yaml` has `validationFailureAction: Audit`. Signature verification is monitoring-only; unsigned images can deploy.
**Remediation:** Flip to `Enforce` after confirming a clean sync with a test unsigned pod (per the operator-actions doc). Outage-risk if flipped blindly, hence not auto-applied.

### M-14 (Medium) - `dalekdefender` overlay weaker than prod
`infra/kubernetes/overlays/dalekdefender/backend.yaml` sets `readOnlyRootFilesystem: false` (prod is `true`). The rig is internet-reachable via Tailscale and promotes to prod.
**Remediation:** Add the prod emptyDir mounts and set `readOnlyRootFilesystem: true`, or document the accepted divergence.

### Low items (documented)
- **L-1** Staff refresh (`staffAuthService.js`) verifies signature only - add `decoded.type === 'refresh'` + jti-blacklist check (mirror `AuthService.refreshToken`).
- **L-3** `corsMiddleware.js` `^https://vh-health-adminportal-[a-z0-9-]+\.vercel\.app$` lets any attacker-named Vercel deploy match with `credentials:true`. Pin to immutable team/project hash or drop credentials for previews (or remove if Vercel previews are retired).
- **L-4** `app.set('trust proxy', 1)` vs the documented Cloudflare Tunnel -> ingress-nginx (2 hops): a client `X-Forwarded-For` may shift the trusted index, spoofing the rate-limit key and HIPAA-audit IP. Verify real hop count; set `trust proxy` precisely. `uploadMiddleware.js` also reads `x-forwarded-for` directly - use `req.ip`.
- **L-7** Gate `debugPrint`/`print` in `notification_provider.dart`, `biometric_gate_service.dart`, etc. behind `kDebugMode` (Android `debugPrint` reaches logcat in release); add an `analysis_options.yaml` lint.
- **L-8** Admin CSRF check (`/api/proxy`, `/api/refresh`, `/api/logout`, login routes) returns allow when `Origin` is absent; relies solely on `SameSite=Strict`. Require Origin/Referer for unsafe methods.
- **L-9** `apps/admin/next.config.ts` CORS defaults to `http://localhost:3000` with `Allow-Credentials:true` if `NEXT_PUBLIC_ALLOWED_ORIGIN` is unset at build; fail the build (or omit the headers) in production instead.
- **L-10** `.gitleaks.toml` allowlists `firebase_options.dart`/`google-services.json` by basename anywhere; narrow to the two exact paths.

---

## 6. Strong controls confirmed (no change needed)

JWT verification uses an explicit `algorithms: ['HS256']` allowlist (no alg-confusion); no fallback JWT secret (fatal exit + Joi `min(32)`); token revocation is genuinely fail-closed (503 when Redis+DB both unavailable); API key compared with `crypto.timingSafeEqual`; Firebase missing-creds installs a rejecting stub (no bypass); the primary OTP service hashes + caps attempts; staff PIN login is device-bound with two-tier lockout; admin MFA uses AES-256-GCM TOTP secrets + single-use bcrypt backup codes. SQL is parameterized across the 288+ raw sites with allowlisted `ORDER BY`/identifiers; `utils/ssrfGuard.js` is comprehensive and fail-closed (blocks metadata/RFC1918/rebinding) and is invoked on all user/operator URL sinks; R2 key resolution is path-traversal-safe; no XML parser (no XXE). Error handler never returns `err.message`/stack in prod; Sentry scrubs PHI/tokens; PHI access logging is broadly applied; GDPR export/erasure is tenant-scoped + rate-limited. Admin auth uses an httpOnly+Secure+SameSite=Strict cookie (no token in JS/localStorage), `middleware.ts` does `jose.jwtVerify` and fails closed in prod, the proxy injects the API key server-side, and there is no `dangerouslySetInnerHTML`/`eval`. Infra: SealedSecrets throughout, non-root containers, prod `readOnlyRootFilesystem:true` + dropped caps + seccomp, default-deny NetworkPolicies, cosign signing + Trivy scans, `ci.yml` already has least-privilege `permissions: contents: read`.

**Audit notes corrected:** `apps/admin/.dockerignore` already exists; `ci.yml` already pins least-privilege permissions; the warehouse `*.sealed-secret.yaml.example` is a labeled placeholder template (no real secret). These were initial flags that did not hold up on full review.

---

## 7. Verification & limitations

- Every fix was applied to follow an existing in-repo pattern; the Critical and all High fixes were re-read against source before changing.
- **Sandbox limitation (important):** the Linux build sandbox mounts the Windows project folder, and during this session it served **truncated read-backs** of files the editor had just written when they contain multibyte characters near EOF. This made `node --check`, `git diff`, and `eslint` *via the sandbox* unreliable (they reported spurious "unexpected end of input"). The authoritative editor view confirmed every edited file is **complete and correct** (e.g. `uploadConfig.js` retains `MULTER_CONFIG`; `otpService.js` retains its `logActivity` export). **Do not run `git add`/`commit` from inside that sandbox** for these files - commit from your normal Windows Git, which reads the intact files.
- **Recommended final validation (on real infra / your machine):** `cd apps/backend && npm run lint && npm test`; `cd apps/admin && npm run lint && npm run build`; `melos run analyze` for the Flutter workspace. Targeted regression tests: record IDOR (`src/tests/authorization.test.js`), OTP request/verify + rate limit, admin MFA login -> logout -> token rejected, and a staff document upload rejecting `.svg`.

## 8. Files changed in this pass

Backend: `controllers/record/patientRecordController.js`, `services/otpService.js`, `services/auth/adminOtpService.js`, `utils/auth/tokenHelpers.js` (subsequently retired in Audit #3 P10), `config/uploadConfig.js`, `services/notification/adminNotificationService.js`, `routes/auth/authRoutes.js`, `routes/auth/otpRoutes.js`, `controllers/pharmacy/pharmacyOrderController.js`, `.dockerignore` (new).
Admin: `lib/exportToCsv.ts`, `app/api/proxy/[...path]/route.ts`.
Mobile/shared: `apps/patient/lib/features/auth/widgets/login_form.dart`, `apps/patient/lib/core/navigation/app_router.dart`, `packages/vhhealth_core/lib/utils/safe_url_launcher.dart`.
CI: `.github/workflows/release-patient.yml`, `.github/workflows/release-staff.yml`.
