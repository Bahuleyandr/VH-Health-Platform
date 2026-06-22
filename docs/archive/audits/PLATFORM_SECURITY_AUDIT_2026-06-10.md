# VH Health Platform — Full Security & Quality Audit

**Date:** 2026-06-10
**Scope:** entire monorepo — `apps/backend`, `apps/admin`, `apps/patient`, `apps/staff`, `packages/vhhealth_core`, `infra/`, CI/CD.
**Method:** five parallel deep-read audits (one per stack area), every High finding re-verified against source by hand. Each finding is tagged **CONFIRMED** (traced end-to-end) or **SUSPECTED** (needs a runtime/cluster check).
**Important:** this is a static review. Items marked *runtime-dependent* hinge on production env vars / live cluster state and must be confirmed against the running system before they are closed or dismissed.

---

## 1. Executive summary

The platform is **materially more mature than typical healthcare software**. Real, working controls already exist: JWT revocation, Postgres RLS, PHI access logging, guardian "acting-as" delegation with fail-closed gates, parameterised SQL throughout (no SQL injection found across dozens of raw-query sites), boot-time secret validation, Sentry PHI scrubbing, httpOnly-cookie admin auth, secure storage on mobile, default-deny K8s NetworkPolicies, PSS `restricted`, and keyless cosign signing. The team clearly takes security seriously.

The risk is **not** the absence of controls — it is **controls that are present but not wired in, applied inconsistently, or fail open**. The pattern repeats in every layer:

- Auth/RBAC machinery exists but a few high-value endpoints slip past it (the appointment router's RBAC is dead code; a patient dashboard sits in front of the JWT gate).
- TLS pinning, E2E message crypto, and image-signature verification are all built but never invoked.
- Tenant isolation leans on RLS as a *sole* backstop that goes inert under a misconfiguration or a superuser DB role.
- Several guards (token revocation, PHI access checks) deliberately **fail open**, which is the wrong default for a PHI system.

None of the confirmed issues require exotic exploitation. The highest-priority items below are reachable by an authenticated low-privilege user or anyone who extracts the static API key from the shipped mobile app.

**Headline counts:** 12 High, 18 Medium, 12 Low/hardening. No Critical (no unauthenticated RCE or trivial full-DB exfiltration found), but several Highs are PHI-disclosure or authorization-bypass class and should be treated as urgent for a hospital deployment.

---

## 2. Findings register (ranked)

### High

| ID | Area | Finding | Evidence | Status |
|---|---|---|---|---|
| H1 | Backend | `GET /api/v1/dashboard?phone=` returns patient name, appointment dates/times, **doctor name**, and loyalty tier for **any phone number**, authenticated by the **static shared API key only** (mounted before the JWT gate). No tenant scoping → cross-tenant PHI enumeration. The key is baked into the Flutter APK and trivially extractable. | `controllers/dashboard/dashboardController.js:18-113` (returns `doctorName` at :67 despite the file comment claiming it doesn't); mounted `app.js:487`, before `app.use(jwtAuth)` at `app.js:505` | CONFIRMED |
| H2 | Backend | Appointment router's RBAC is **dead code**: `wrapAutoRBAC(router, 'appointmentRoutes', {get:[],post:[],...}, {roles:[...]})` attaches nothing because the route map is empty, and the `app.js` mount adds no `requireRole`. Any authenticated user (incl. PATIENT) can hit `/completed/recent` (cross-patient names + dates), `/pending`, `/admin/sla-dashboard`, `/admin/documents`, `/admin/audit-trail`. | `routes/appointment/index.js:16-31`, `routes/appointment/appointmentListRoutes.js:26`, mount `app.js:544` | CONFIRMED |
| H3 | Backend | Tenant isolation relies on Postgres RLS as the **sole** backstop, and RLS enforcement is OFF unless `AUTH_ENFORCE_TENANT_RLS=true` **or** `NODE_ENV='production'`. Interactive `$transaction(async tx ⇒ …)` callbacks are documented as **not** auto-scoped, and a SUPERUSER/BYPASSRLS DB role makes all policies inert. Application queries are largely not tenant-scoped themselves. | `config/tenantRlsConfig.js:7-13`, `lib/prisma.js:167-300`, `middleware/tenantContextMiddleware.js` | CONFIRMED (runtime-dependent) |
| H4 | Backend | **SSRF** in HL7 outbound feeds: `createSubscription()` validates only the URL *scheme* (`/^https?:\/\//`), then the stored `endpoint_url` is fetched server-side (`fetch(...)`) with an attacker-chosen `Authorization` header. No block on `127.0.0.1`, RFC-1918, or `169.254.169.254`. Lets an insider POST from inside the "sealed" hospital network to cluster services. | `services/hl7/hl7OutboundService.js:47` (validate) → `:210` (sink) | CONFIRMED |
| H5 | Backend | **PHI in plaintext logs.** Patient/staff phone numbers (HIPAA identifiers) are logged raw in many services, despite a `maskPhoneForLog()` helper existing and being used in a few places. Lands on disk via `winston-daily-rotate-file` and any log aggregation. | `services/otpService.js:121`, `services/auth/otpService.js:50`, `services/pharmacy/orderService.js:84`, `utils/notifications/appointmentReminderJob.js:258,267`, `services/user/userService.js:186,204`, others | CONFIRMED |
| H6 | Admin | **Broken function-level authorization.** `middleware.ts` role gating is an allowlist covering ~15 of ~95 routes. Sensitive surfaces gated only by "is authenticated" (so any rank-0 role passes): `/dashboard/patients`, `/patients/dedupe`, `/dashboard/database` (live DB browser), `/dashboard/tenants`, `/feature-flags`, `/consent`, `/mar`, `/blood-bank`, `/icu`, `/executive`. Actual exposure then depends entirely on backend per-endpoint authz. | `apps/admin/src/middleware.ts:77-110` | CONFIRMED |
| H7 | Mobile | **Certificate pinning is dead code** — `CertificatePinner` / `SecurityConfig.verifyOrWarn()` exist and are exported but never called; all traffic goes through a plain `http.Client()`. It's also **broken** (hashes whole-cert DER as hex vs SPKI-base64 pins, never strips `sha256/`), so it would reject 100% of connections if wired. Net: no pinning on a PHI app. | `packages/vhhealth_core/lib/services/certificate_pinner.dart:11,61-64`, `lib/services/http_client.dart:62` | CONFIRMED |
| H8 | Mobile | Both apps' `network_security_config.xml` declare `<certificates src="user"/>`, re-trusting user-installed CAs that Android 7+ excludes by default. Any proxy/MDM/malicious CA can MITM all PHI traffic — and with H7 there is no app-layer backstop. | `apps/patient/.../network_security_config.xml:15`, `apps/staff/.../network_security_config.xml` | CONFIRMED |
| H9 | Mobile | Staff (clinical EMR) app's `<application>` omits `android:allowBackup` → **defaults to `true`**. `adb backup` on a ward/kiosk device can extract the app data dir, including the secure-storage blob and the plaintext recent-patient PHI cache (M10). Patient app is correctly hardened; staff is not. | `apps/staff/android/app/src/main/AndroidManifest.xml:28-32` | CONFIRMED |
| H10 | Infra | Predictable committed password for the PHI-reading DB role: `CREATE ROLE vhhealth_readonly WITH LOGIN PASSWORD 'set-in-sealed-secret'` runs at initdb and is the **only** place the password is set (no `ALTER ROLE` from a SealedSecret). The role can `SELECT` every table (all PHI); pg_hba allows scram from all RFC-1918. | `infra/kubernetes/base/cnpg/cluster.yaml:144` | CONFIRMED (verify+rotate on running cluster) |
| H11 | Infra | Prod overlay does **not** pin image digests (no `images:` block), and the base Deployment ships `:0.0.0-placeholder` with `imagePullPolicy: IfNotPresent`. Contradicts the documented "ArgoCD pins digests" posture; a moving tag would never re-pull. | `infra/kubernetes/overlays/prod/kustomization.yaml`, `infra/kubernetes/apps/backend/deployment.yaml:82-83` | CONFIRMED |
| H12 | Infra | The only *active* deploy automation bypasses GitOps: `deploy-dalekdefender.yml` fires on every `main` push, SSHes to a host, `git reset --hard`, builds locally, imports the image, and `kubectl set image/set env` with passwordless sudo — unsigned, unscanned, mutable tag, imperative secret patching. A poisoned `main` = code execution on a privileged host. | `.github/workflows/deploy-dalekdefender.yml` | CONFIRMED |

### Medium

| ID | Area | Finding | Evidence |
|---|---|---|---|
| M1 | Backend | `jwt.verify` called with no `algorithms` allowlist in all three verifiers — latent alg-confusion footgun the moment any RS/ES/JWKS verification is added (Hasura/SMART-on-FHIR). Not presently exploitable (symmetric secret only). | `utils/jwtUtils.js:89,138`, `utils/auth/tokenHelpers.js:27` |
| M2 | Backend | Token revocation **fails open**: `isTokenBlacklisted`/`isUserTokensRevoked` return `false` (accept) when Redis+DB both error. A revoked/force-logged-out token is honoured during any store blip; access tokens live up to 7 days. | `utils/tokenBlacklist.js:79-88,128-160` |
| M3 | Backend | PHI/IDOR access guards **fail open** on a broad `/does not exist/i` message regex (not just SQLSTATE `42P01`). A partial migration or one renamed column/function silently disables the patient-access check. | `middleware/phiAccessMiddleware.js:88-94`, `services/security/accessDecisionService.js:203-207`, `middleware/staffAccessMiddleware.js:22-28` |
| M4 | Backend | `requireConsent` checks consent *existence*, not authorization, and has no `tenant_id` filter — patient id comes straight from `req.params/body/query`. On any route relying on it for patient scoping it's an IDOR + cross-tenant lookup. | `middleware/consentMiddleware.js:23-47` |
| M5 | Backend | Staff PIN login (`/auth/staff/login-pin`) has **no device binding** (unlike biometric/quick-login), a 4–6 digit secret, and lockout keyed on `employeeId` across all methods — enabling ~480 guesses/day **and** deliberate lockout (DoS) of any clinician. | `services/auth/staffAuthService.js:502-598,53-72` |
| M6 | Backend | Payslip PDFs are locked with a **DOB-derived** user password (`DDMMYYYY`, ~8 digits, brute-forceable) and a **hardcoded owner-password fallback** `'VHHealth@Admin2026'`. Payslips are salary PII. | `utils/payslipPDF.js:42-50` |
| M7 | Backend | Stored-XSS sanitizer is a **regex blocklist** (bypassable) applied opt-in to only ~9 of 237 route files; most clinical free-text (notes, diagnoses, surgical/ICU/maternity docs) reaches storage unsanitized and is rendered by the admin portal. | `utils/sanitize.js:10-29` + 9 wired route files |
| M8 | Admin | Allowlist drift: `/dashboard/audit-explorer`, `/system-logs`, `/logs` are ungated while a non-existent `/system-audit` is listed — audit/log surfaces (which contain PHI) open to any authenticated role. | `apps/admin/src/middleware.ts:82` |
| M9 | Admin | CSP `script-src` includes `'unsafe-inline'` and `'unsafe-eval'`, neutering CSP as an XSS backstop. Attributed to Sentry/workbox. | `apps/admin/next.config.ts:49` |
| M10 | Mobile | Staff "recent patients" cache writes `{uid, name}` PHI to **plaintext SharedPreferences** (rest of app uses secure storage). Extractable on rooted device or via H9 backup. | `apps/staff/lib/core/services/recent_patients_service.dart:79` |
| M11 | Mobile | Biometric re-auth gate (in front of "View Medical Records") **fails open** — returns `true` when biometrics unavailable or on any exception. | `apps/patient/lib/core/services/biometric_gate_service.dart:34,44` |
| M12 | Mobile | `MessageCrypto` (X25519+HKDF+AES-GCM) is built and exported but **not wired** into the patient↔hospital messaging feature — "secure messages" are server-side plaintext. Either wire it or remove the false assurance. | `packages/vhhealth_core/lib/services/message_crypto.dart` vs `apps/patient/.../message_thread_screen.dart:9` |
| M13 | Infra | CNPG off-site (R2) backups have **no `encryption:` field** (no AES-256/customer key), yet docs claim "pgBackRest encrypts with AES-256" and reference a `pgbackrest-cipher` secret that doesn't exist. Backups protected only by Cloudflare-held keys. | `infra/kubernetes/base/cnpg/cluster.yaml:183-205` |
| M14 | Infra | `vh-mcp-postgres` (an arbitrary-query DB bridge) is exposed as a **NodePort** (`30092`) reachable from any node IP on the LAN, gated only by a bearer token. | `infra/mcp/vh-mcp-postgres/k8s.yaml:13-20,54-58` |
| M15 | Infra | Supply-chain scans (Trivy, SBOM/syft, OSV, Semgrep) are **`continue-on-error: true`** on the day-to-day Forgejo pipeline and use mutable scanner images — CRITICAL/HIGH vulns never block a merge. | `.forgejo/workflows/container-supply-chain.yml:92-110`, `security-sweep.yml:53-88` |
| M16 | Infra | Images are cosign-signed but **never verified** at admission: ArgoCD `signatureKeys: []` and no Kyverno/policy-controller `verifyImages` rule. A registry compromise or manual `kubectl set image` runs unsigned. | `infra/kubernetes/base/argocd/project.yaml:79` |
| M17 | Infra | The `dalekdefender` rig (auto-deployed prod code per H12, internet-reachable via Tailscale) runs the backend as a **DB superuser** with **no securityContext** in a namespace **without PSS labels** — RLS bypassable outside tenant transactions. | `infra/kubernetes/overlays/dalekdefender/backend.yaml:39-68`, `.../namespace.yaml` |
| M18 | Infra | Optional Orthanc PACS (DICOM/PHI imaging) ships a literal `"vhhealth": "CHANGE-ME-sealed-secret"` in a plain ConfigMap, runs as root with no NetworkPolicy and `RemoteAccessAllowed: true`. ClusterIP-only limits blast radius. | `infra/kubernetes/optional/pacs/orthanc.yaml:21,30-94` |

### Low / hardening

| ID | Area | Finding | Evidence |
|---|---|---|---|
| L1 | Backend | JWT role trusted for the token's full ≤7-day life with no DB re-check; demotion/offboarding lags until expiry (and `revokeAllUserTokens` itself fails open, M2). | `middleware/jwtMiddleware.js:139-147` |
| L2 | Backend | Tenant defaulting collapses users with null `tenant_id` (or on DB error, when not fail-closed) into `DEFAULT_TENANT_ID` — dissolves isolation in non-prod multi-tenant mode. | `services/tenant/tenantService.js:190-205` |
| L3 | Backend | `JWT_SECRET` reused as the R2 signed-download token secret — couples two trust domains' cryptographic fate. | `utils/r2Storage.js:57` |
| L4 | Backend | `backup-db.js`/`restore-db.js` run `execSync(..., {shell:true})` interpolating the DSN/paths — command injection if `DATABASE_URL` ever holds shell metacharacters. Operator-run only (low reach). | `scripts/backup-db.js:10`, `scripts/restore-db.js:55` |
| L5 | Admin | Client-side `ProtectedRoute` branches on `localStorage.adminUser.role` (user-controlled) — cosmetic only, but load-bearing where a route is missing from middleware (H6). | `apps/admin/src/components/auth/ProtectedRoute.tsx:43-72` |
| L6 | Admin | Realtime WS ticket passed in the URL query string (`/ws?token=`) — lands in proxy logs/history; replayable within its ~60s TTL. | `apps/admin/src/hooks/useRealtimeChannel.ts:25` |
| L7 | Mobile | Example API key `vhhealth123` printed in committed doc (source is correctly `String.fromEnvironment`). Scrub + rotate if ever deployed. | `packages/vhhealth_core/CLAUDE.md:52` |
| L8 | Mobile | Patient netsec config pins placeholder `your-api-domain.com` instead of `api.vhhealth.app` — dead config giving false impression of per-domain pinning. | `apps/patient/.../network_security_config.xml:4` |
| L9 | Mobile | Staff config emits `x-api-key:` even when the key is empty (core guards with `isNotEmpty`) — masks misconfiguration. | `apps/staff/lib/core/config/api_config.dart:28` |
| L10 | Infra | cloudflared→ingress-nginx hop is plain HTTP (`service: http://...:80`) despite `noTLSVerify:false` — PHI unencrypted on the pod network (default-deny CNI mitigates). | `infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml:62-83` |
| L11 | Infra | MinIO metrics set to `public` (unauth) and the PHI `vhhealth-records` bucket has `objectLock:false` (only backups are WORM) — clinical record objects are deletable/overwritable. | `infra/kubernetes/base/minio/tenant.yaml:145-159` |
| L12 | Infra | Optional analytics warehouse holds a 2nd PHI copy behind a `bypassrls:true` dbt role + `enableSuperuserAccess:true` — document/scope as a tenant-isolation trust boundary. | `infra/kubernetes/optional/analytics-warehouse/warehouse-cluster.yaml:31,55-68` |

---

## 3. Cross-cutting themes

Five systemic patterns drive most of the findings. Fixing the **pattern** is higher-leverage than fixing each instance:

**Built-but-not-wired.** Cert pinning (H7), E2E message crypto (M12), and image-signature verification (M16) are all implemented and then never invoked. A "wire-up audit" — grep each security module for its call sites and add a CI test asserting it's reached — would catch this class permanently.

**Fail-open guards.** Token revocation (M2), PHI/IDOR access checks (M3), tenant defaulting (H3/L2), and the biometric gate (M11) all prefer availability over safety on error. For a PHI system the default should invert: fail closed, alert loudly, and treat "I can't tell if this is allowed" as "deny."

**Authorization as an incomplete allowlist.** Both the backend appointment router (H2) and the admin middleware (H6/M8) protect an enumerated subset and silently leave the rest open. Replace allowlists with **default-deny + a CI coverage test** that fails when any route/page lacks an explicit policy entry.

**RLS as the only tenant control.** Application queries mostly don't carry `tenant_id` themselves (H3); isolation is one misconfig (or one BYPASSRLS role, M17) away from collapse. Defense-in-depth: make `tenant_id` predicates explicit in queries *and* keep RLS, so neither is load-bearing alone.

**Secret hygiene in initdb/ConfigMaps.** The readonly DB role (H10) and Orthanc (M18) set credentials as literals at bootstrap rather than from SealedSecrets/managed roles. Move every credential to the SealedSecret/Vault path the rest of the platform already uses correctly.

---

## 4. Remediation & upgrade plan

Phased by risk and effort. P0 items are reachable today and disclose PHI or bypass authz — do these first, out of band if needed.

### Phase 0 — Emergency (this week)

1. **H1** — Put `/api/v1/dashboard` behind `jwtAuth` + `requireRole('PATIENT')`; derive `phone` from `req.user`, not the query string; add tenant scoping; remove `doctorName` (or keep it, now that it's authenticated). Fix the misleading comment.
2. **H2** — Add `requireRole(...APPOINTMENT_ROLES)` at the `app.js:544` mount; convert the dead `wrapAutoRBAC` to the working `use:`-form (as `routes/user/index.js` does) or delete it; add per-handler role checks on the `/admin/*` appointment endpoints.
3. **H10** — On every running cluster, rotate the `vhhealth_readonly` password to a SealedSecret-sourced value (`ALTER ROLE … PASSWORD`); change the manifest to create the role with no inline password (or CNPG `managed.roles` + `passwordSecret`).
4. **H12** — Freeze/firewall the `deploy-dalekdefender` path or route it through the signed `release-images.yml` pipeline; confirm no real PHI is on that rig; tighten the Tailscale ACL and host sudoers.
5. **H4** — Add an egress allowlist + private/loopback/link-local IP block (re-validated after DNS resolution) to HL7 feed creation **and** each delivery.
6. **Verify the runtime-dependent Highs** in prod: confirm `NODE_ENV=production` / `AUTH_ENFORCE_TENANT_RLS=true` are actually set (H3), and that the prod CNPG app role is **not** SUPERUSER/BYPASSRLS (the boot guard in `lib/prisma.js` should already enforce this — confirm it's active).

### Phase 1 — High severity (2–3 weeks)

7. **H6 / M8** — Convert admin `middleware.ts` to default-deny: map every `/dashboard/*` segment to a minimum role; add a CI test that fails when a `page.tsx` has no policy entry. Independently confirm the backend authorizes `/admin/database/*`, `/users`, `/records` per-role (the portal's authz is only as strong as that).
8. **H7 / H8 / L8** — Wire a pinned `IOClient` into `VHHttpClient`; fix the pin algorithm (hash SPKI, strip `sha256/`); call `verifyOrWarn()` at startup (fail fast); remove `<certificates src="user"/>` from both apps; pin the real domain.
9. **H9 / M10** — Add `allowBackup="false"` + `usesCleartextTraffic="false"` + restrictive `dataExtractionRules` to the staff manifest; move the recent-patients cache to secure storage.
10. **H5** — Route all identifier logging through `maskPhoneForLog`; add a Winston redaction format (phone/email/MRN regex) as a global backstop; sweep the call sites.
11. **H11** — Add an `images:` digest-pin block to `overlays/prod`; wire ArgoCD Image Updater (or the release pipeline) to write `@sha256:` digests; set `imagePullPolicy` consistently.

### Phase 2 — Medium severity (1–2 months)

12. **M2 / M3 / M11** — Flip the fail-open guards to fail-closed on the authenticated path; restrict M3's skip to an exact SQLSTATE allowlist (never message text); alert on every such event.
13. **M5** — Bind staff PIN login to a registered device; key lockout on `(employeeId, deviceId/IP)` with a separate counter so attackers can't lock out clinicians; raise PIN entropy or add per-device throttling.
14. **M7 + M9** — Replace the regex sanitizer with `sanitize-html`/DOMPurify; move admin CSP to nonce/hash-based `script-src` and drop `'unsafe-inline'` (then `'unsafe-eval'`). Treat XSS as an output-encoding + CSP problem in the portal, with backend sanitization as defense-in-depth.
15. **M1** — Pass `{ algorithms: ['HS256'] }` to all three `jwt.verify` calls (cheap, do alongside Phase 1).
16. **M4 / M6 / M12** — Tenant-scope `requireConsent` and pair it with an ownership check; replace the payslip DOB password with a random out-of-band one and remove the hardcoded owner fallback; wire or remove `MessageCrypto`.
17. **M13 / M14 / M16** — Set `barmanObjectStore.encryption: AES256` (or customer passphrase) and reconcile the DR docs; make `vh-mcp-postgres` ClusterIP + NetworkPolicy; add a Kyverno `verifyImages` policy keyed to the release workflow's OIDC identity and populate ArgoCD `signatureKeys`.
18. **M15** — Make Trivy/secret findings blocking on the merge path; pin scanner images by digest.
19. **M17 / M18** — Add securityContext + PSS labels to the dalekdefender namespace and a non-superuser DB role; source Orthanc credentials from a SealedSecret and harden it before enabling.

### Phase 3 — Hardening & upgrades (ongoing)

20. **Shorten token TTL.** Drop access-token lifetime from 7d to minutes and lean on the existing patient/staff refresh-rotation; re-load role from DB for privileged routes (addresses L1, blunts M2).
21. **Make tenant_id explicit** in application queries so RLS is defense-in-depth, not the sole control (H3); add a lint similar to the existing `check-phi-tenant-id` for query-level scoping. Migrate the remaining interactive-`$transaction` call sites.
22. **Secret-domain separation** (L3): derive a distinct `STORAGE_TOKEN_SECRET` (or HKDF sub-key) for R2 download tokens.
23. **Mobile hardening:** enable Firebase **App Check** + restrict the API keys in Google Cloud console; `kDebugMode`-guard the FCM-token log; fix the staff empty-`x-api-key` guard (L9).
24. **Infra hardening:** terminate TLS on the cloudflared→ingress hop or document it as accepted (L10); switch MinIO metrics to `jwt` auth and add versioning/object-lock to `vhhealth-records` (L11); confirm the CNI is in enforcing mode (NetworkPolicies are inert otherwise); disable `enableSuperuserAccess` on prod CNPG if unused; execute and record the quarterly DR restore drill and R2 object-lock.
25. **Supply chain:** make Semgrep SAST blocking; add dependency-review/`npm audit` gates to the merge path (backend lockfile especially — eyeball was clean but run it); ensure `release-images.yml`-style cosign+Trivy applies to *every* image that can reach a cluster, not just version tags.
26. **CI coverage tests** (the highest-leverage upgrade): one test that fails if any backend `/api/v1/*` mount resolves to a stack without `requireRole`, and one that fails if any admin `page.tsx` lacks a middleware policy entry. These prevent H2/H6-class regressions permanently.

---

## 5. What could not be verified (needs runtime/cluster access)

- Live values of `NODE_ENV`, `AUTH_ENFORCE_TENANT_RLS`, `OTP_CONFIG.devMode`, `ENABLE_DEV_AUTH`, and the production DB connection role's `SUPERUSER`/`BYPASSRLS` status — these determine whether H3/L2/M17 are active in prod. Confirm via SealedSecrets + the CNPG role spec and the `lib/prisma.js` boot guard.
- Whether already-bootstrapped clusters still carry the predictable `vhhealth_readonly` / Orthanc passwords (initdb SQL can't be re-read from manifests) — verify and rotate on the running DBs.
- Backend **per-endpoint** authorization for `/admin/database/*`, `/users`, `/records` — the load-bearing control behind admin finding H6; not traced exhaustively.
- A real `npm audit` against both lockfiles (admin reported 0; backend was eyeballed-clean but not run).
- Runtime confirmation that ClamAV scanning is *mandatory* (not advisory) on every upload route.
- That the CNI is actually enforcing NetworkPolicies, and that the DR restore drill + R2 object-lock have been executed (both are open checkboxes in the existing docs).

---

## 6. Notable existing strengths (keep these)

Parameterised SQL everywhere (no injection found across dozens of raw-query sites; ORDER BY/LIMIT go through whitelists); prod-aware error handler that strips stacks/SQL/schema leakage; boot-time secret validation with `process.exit(1)` and no hardcoded auth fallbacks; the guardian "acting-as" delegation (UUID check, single binding query, fail-closed minor/role/tenant gates); transaction-local RLS GUC (no cross-request leak); httpOnly-cookie admin auth with same-origin proxy and server-side key injection; PHI-aware Sentry scrubbing on both web and backend; secure storage + server-side OTP verification + sound session lifecycle on mobile; per-namespace default-deny NetworkPolicies; PSS `restricted`; non-root + read-only-rootfs + dropped caps on core pods; digest-pinned platform images; keyless cosign signing + build-failing Trivy in `release-images.yml`; correct prod tenant-RLS role model with a boot guard; strong Ansible host hardening; and — notably — **no `pull_request_target` and no `${{ github.event.* }}` interpolation in `run:` blocks**, so the classic GitHub-Actions poisoned-pipeline vectors are absent.

---

*Audit performed by automated deep-read of source with manual verification of all High findings. File:line references are to the repo state at 2026-06-10. This report is advisory; validate runtime-dependent items against the live system before closing or dismissing them.*
