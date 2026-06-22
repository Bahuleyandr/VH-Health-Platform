# VH Health Platform — Remediation Work Order (Agent Handoff)

**For:** the executing agent (Fable)
**From:** security audit, 2026-06-10
**Companion doc:** `docs/PLATFORM_SECURITY_AUDIT_2026-06-10.md` — full findings, evidence, and rationale. Read it before starting. This work order is the actionable layer; the audit is the "why."

---

## 0. Mission & non-negotiable guardrails

You are fixing security findings in a **hospital-grade healthcare platform handling real patient PHI**. Correctness and safety beat speed. Follow these rules on every change:

1. **Re-verify before you edit.** Line numbers in this doc and the audit are from a static read on 2026-06-10 and may have drifted. Open each file, confirm the code still matches the description, and locate the current line before editing. If the code already looks fixed, note it and move on — don't blindly apply.
2. **Fail closed, not open.** When a security decision can't be made (error, missing data, unreachable store), the safe default is **deny** + log + alert. Several findings exist *because* the current code fails open. Do not introduce new fail-open paths.
3. **Don't weaken tenant isolation.** Postgres RLS + `tenant_id` scoping is load-bearing. Never run a clinical/PHI query without tenant scoping. If you touch any OP/IP clinical write, honor the canonical clinical timeline invariant in `docs/CANONICAL_CLINICAL_TIMELINE.md` (detail row + `clinical_timeline_events` + `clinical_audit_events` in one transaction).
4. **Write a test for every behavioral fix.** Especially auth/authz changes: add a test proving the *attack* is now blocked (e.g. PATIENT token → 403) and the *legitimate* path still works. A fix without a regression test is not done.
5. **One finding = one focused commit/PR.** Reference the finding ID (e.g. `fix(security): H2 ...`). Small, reviewable diffs. Every change to auth/PHI code must be human-reviewable.
6. **Keep CI green.** The repo has pre-commit hooks (`lefthook`) and lint gates that include `secrets:scan`, `check:phi-tenant-id`, and `lint:raw-params`. Don't disable them; make your changes pass them.
7. **Some items can't be fixed from code alone** (cluster secret rotation, deploy-pipeline policy). They're marked **HUMAN** — produce the manifest/workflow change and a written action for the operator; do not attempt to touch a live cluster.

---

## 1. Repo orientation

Monorepo. Stacks and how to verify each (run the relevant ones after every change in that stack):

| Stack | Path | Lint | Test | Build/extra |
|---|---|---|---|---|
| Backend (Node 22 / Express 5 / Prisma + raw pg) | `apps/backend` | `npm run lint` | `npm test` (needs Postgres on :5433) | `npm run ci` runs the full gate (lint + audit + swagger + docker tests) |
| Admin (Next.js 16 / React 19 / TS) | `apps/admin` | `npm run lint` | `npm test` | `npm run build` |
| Flutter patient + staff + core (one Dart workspace) | `apps/patient`, `apps/staff`, `packages/vhhealth_core` | `melos run analyze` | `melos run test` | `melos run format-fix`, `melos run codegen` |
| Infra (K8s/Kustomize, ArgoCD, Ansible) | `infra/` | `kustomize build overlays/<env>` to validate | — | manifests only — **do not apply to a live cluster** |

Local CI without pushing: `act -l`, `act push`, `act -j <job>` (wrapper at `D:\Dev\Tools\act\act.cmd`). Backend tests need Postgres 16/17 on :5433.

When done, update the existing trackers so the team sees progress: `docs/PLATFORM_REMEDIATION_PLAN.md`, `docs/SECURITY_HARDENING_CHECKLIST.md`, and tick items in `AUDIT.md` if mirrored there.

---

## 2. Phase 0 — Emergency (do first; PHI-disclosure / authz-bypass reachable today)

### H1 — Patient dashboard leaks PHI behind the static API key
- **Files:** `apps/backend/src/controllers/dashboard/dashboardController.js` (handler `getPatientDashboard`); mount in `apps/backend/src/app.js` (currently `app.use('/api/v1/dashboard', dashboardRateLimiter, dashboardRoutes)` placed *before* `app.use(jwtAuth)`).
- **Problem:** reachable with the shared API key only (no JWT). Takes `phone` from the query string, returns name + appointment dates/times + `doctorName` + loyalty tier for **any** phone, with **no tenant scoping**. The file comment falsely claims it returns no doctor names (it does, ~line 67).
- **Fix:**
  1. Move the `/api/v1/dashboard` mount to **after** `app.use(jwtAuth)` and add `requireRole('PATIENT')` (plus the existing rate limiter).
  2. In the handler, derive the phone from `req.user.phone` (the authenticated subject), **not** `req.query.phone`. If a phone param is still accepted, it must equal the caller's own.
  3. Add tenant scoping to all four queries (`AND tenant_id = $n` using `req.tenantId`/`req.user.tenant_id`, or confirm the tenant-RLS context middleware now covers this route and rely on it explicitly).
  4. Fix the misleading comment to match reality.
- **Verify (add tests):** PATIENT token + own phone → 200 with own data; no token → 401; a *different* phone → returns only the caller's data (or 403), never another patient's; cross-tenant phone → no data.
- **Done when:** the endpoint is JWT+role gated, self-scoped, tenant-scoped, and tests prove enumeration is blocked.

### H2 — Appointment router RBAC is dead code
- **Files:** `apps/backend/src/routes/appointment/index.js` (the no-op `wrapAutoRBAC(... {get:[],post:[],...})`); mount in `app.js` (`app.use('/api/v1/appointments', patientRateLimiter, phiAccessLogger('APPOINTMENT'), appointmentRoutes)` — no `requireRole`); ungated handlers in `apps/backend/src/routes/appointment/appointmentListRoutes.js` (`/completed/recent`) and the `/admin/*` routes.
- **Problem:** `wrapAutoRBAC` with empty route maps attaches nothing (`applyWrappers` only wraps routes present in the map). With no `requireRole` at the mount, any authenticated user (incl. PATIENT) can read cross-patient data via `/completed/recent`, `/pending`, `/admin/sla-dashboard`, `/admin/documents`, `/admin/audit-trail`.
- **Fix:**
  1. Add `requireRole(...APPOINTMENT_ROLES)` at the `app.js` mount (use/define the role set in `config/routeRolePolicy.js`; PATIENT should reach only patient-appropriate sub-routes).
  2. Delete the dead `wrapAutoRBAC` call, or convert it to the working `use:`-form — see `apps/backend/src/routes/user/index.js` for the correct pattern.
  3. Add explicit per-handler role checks to the admin handlers (`getPendingAppointments`, `getStatusAuditTrail`, `getAllDocumentsAdmin`, `getAppointmentSLADashboard`) and to `getRecentCompletedAppointments` so they require an admin/clinical role.
- **Verify (tests):** PATIENT token → 403 on `/admin/*` and `/completed/recent`; an authorized role → 200; confirm patient-facing appointment routes still work for PATIENT.
- **Done when:** no `/api/v1/appointments` route resolves to a stack lacking a role gate, proven by tests.

### H4 — SSRF in HL7 outbound feed delivery
- **Files:** `apps/backend/src/services/hl7/hl7OutboundService.js` — validation at `createSubscription` (~line 47, scheme-only check) and the sink `deliverOne` (~line 210, `fetch(subscription.endpoint_url, ...)`).
- **Problem:** only the URL scheme is validated; the stored URL is fetched server-side with an attacker-chosen `Authorization` header. No block on loopback/RFC-1918/link-local (`169.254.169.254`), so an insider can POST to internal cluster services.
- **Fix:** add an SSRF guard used both at subscription-create and before each delivery — resolve the hostname and reject loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local/metadata (`169.254/16`), ULA (`fc00::/7`), and `::1`; re-resolve and re-check immediately before `fetch` to defeat DNS rebinding; ideally constrain to an operator-managed allowlist of approved feed hosts. Consider routing through an egress proxy with a destination allowlist.
- **Verify (tests):** subscription/delivery targeting `127.0.0.1`, `169.254.169.254`, an internal Service DNS name, and a rebinding host → rejected; an allowlisted public host → allowed.
- **Note:** also confirm with the auth owner *which* role can call `createSubscription` — if any staff can, severity rises.

### H10 — Predictable committed password for the PHI-reading DB role  *(HUMAN + manifest)*
- **File:** `infra/kubernetes/base/cnpg/cluster.yaml` (~line 144, `CREATE ROLE vhhealth_readonly WITH LOGIN PASSWORD 'set-in-sealed-secret'`).
- **Fix (manifest):** stop setting the password inline at initdb. Create the role with `NOLOGIN`/no password, then set it via `ALTER ROLE … PASSWORD` sourced from a SealedSecret, or move to CNPG `managed.roles` with `passwordSecret`.
- **HUMAN action:** on every already-bootstrapped cluster, rotate the `vhhealth_readonly` password now (initdb SQL won't re-run) and store it in the SealedSecret/Vault path. Document completion in `SECURITY_HARDENING_CHECKLIST.md`.

### H12 — Deploy pipeline bypasses GitOps  *(HUMAN + workflow)*
- **File:** `.github/workflows/deploy-dalekdefender.yml`.
- **Problem:** fires on every `main` push, SSHes to a host, `git reset --hard` + local build + `kubectl set image/set env` with passwordless sudo — unsigned, unscanned, mutable tag, imperative secret patching.
- **Fix:** route this through the signed `release-images.yml` path (build → sign → scan → pull by digest), remove the on-host `git reset --hard`+build, and stop imperative `kubectl patch secret`. Restrict the Tailscale ACL (`tag:gha-deploy`) and host sudoers.
- **HUMAN action:** confirm no real PHI is on the dalekdefender rig; if it's a true test rig, firewall it from anything resembling real data and label it clearly. This is a policy decision — produce the workflow diff and escalate.

### Phase-0 runtime verification (HUMAN, no code)
Confirm in the running prod environment, then record results: `NODE_ENV=production` and/or `AUTH_ENFORCE_TENANT_RLS=true` are set (gates H3); the prod CNPG app role is **not** SUPERUSER/BYPASSRLS (the boot guard in `apps/backend/src/lib/prisma.js` should already enforce this — verify it's active and not bypassed).

---

## 3. Phase 1 — High severity (next)

### H6 / M8 — Admin authorization is an incomplete allowlist
- **File:** `apps/admin/src/middleware.ts` (`ADMIN_ONLY_PATHS`, `HR_PLUS_PATHS`, `CLINICAL_AI_CONTROL_PATHS` cover ~15 of ~95 routes).
- **Fix:** invert to **default-deny** — map every `/dashboard/*` segment to a minimum role; anything unmapped is denied (or sent to a safe page). Add the currently-ungated sensitive routes (`/dashboard/patients`, `/patients/dedupe`, `/dashboard/database`, `/tenants`, `/feature-flags`, `/integrations`, `/death-certification`, `/consent`, `/mar`, `/blood-bank`, `/icu`, `/executive`, `/audit-explorer`, `/system-logs`, `/logs`). Add a **CI test** that fails when a `page.tsx` exists under `app/(protected)`/`(with-auth)` with no policy entry.
- **Verify:** low-privilege role → redirected/403 on each sensitive route; correct roles → allowed. **Also** confirm the backend enforces role on `/api/v1/admin/database/*`, `/users`, `/records` — the portal's gate is only as strong as the backend's (cross-check with H2-style review of those routers).

### H7 / H8 / L8 — Mobile TLS pinning dead + user-CA trust
- **Files:** `packages/vhhealth_core/lib/services/certificate_pinner.dart` (broken hash: hashes whole-cert DER as hex vs SPKI base64; never strips `sha256/`), `packages/vhhealth_core/lib/services/http_client.dart` (uses plain `http.Client()`), both `network_security_config.xml` (`<certificates src="user"/>`), patient config's placeholder `your-api-domain.com`.
- **Fix:** inject a pinned `IOClient` into `VHHttpClient` (add a production client, not just the test hook); correct the algorithm to hash the **SPKI public-key info** and normalize the `sha256/`-prefixed base64 pins; call `SecurityConfig.verifyOrWarn()` at app startup so a misconfigured prod build fails fast; remove `<certificates src="user"/>` from **both** apps' `base-config`; replace the placeholder domain with `api.vhhealth.app` (+ staging).
- **Verify:** `melos run analyze` + a test that pinning rejects a wrong cert and accepts the real SPKI; manual check that a proxy CA can no longer intercept (document the manual step).

### H9 / M10 — Staff app backup + plaintext PHI cache
- **Files:** `apps/staff/android/app/src/main/AndroidManifest.xml` (`<application>` missing `android:allowBackup`), `apps/staff/lib/core/services/recent_patients_service.dart` (~line 79, PHI in SharedPreferences).
- **Fix:** add `android:allowBackup="false"`, `android:fullBackupContent="false"` (or restrictive `dataExtractionRules`), and `android:usesCleartextTraffic="false"` to the staff `<application>` (mirror the patient manifest). Move the recent-patients cache to `flutter_secure_storage` / encrypted Hive.
- **Verify:** `melos run analyze`; confirm the cache read/write path still works through secure storage.

### H5 — PHI (phone numbers) in plaintext logs
- **Files:** `apps/backend/src/services/otpService.js:121`, `services/auth/otpService.js:50`, `services/pharmacy/orderService.js:84`, `utils/notifications/appointmentReminderJob.js:258,267`, `services/user/userService.js:186,204`, and any other `logger.*` emitting raw phone/email/MRN (grep for it).
- **Fix:** route every identifier log through the existing `maskPhoneForLog()` helper; add a Winston format that scrubs phone/email/MRN patterns globally as a backstop. Keep the masking consistent across all services.
- **Verify:** a test asserting the redaction format masks a sample phone/email; grep shows no remaining raw `${phone}` in logger calls.

### H11 — Prod overlay doesn't pin image digests  *(manifest)*
- **Files:** `infra/kubernetes/overlays/prod/kustomization.yaml` (no `images:` block), `infra/kubernetes/apps/backend/deployment.yaml` (`:0.0.0-placeholder`, `IfNotPresent`).
- **Fix:** add an `images:` block to `overlays/prod` pinning each app image by `@sha256:` digest (match the already-correct platform images); wire the release pipeline / ArgoCD Image Updater to write digests; set `imagePullPolicy` consistently with digests.
- **Verify:** `kustomize build overlays/prod` resolves to digest-pinned images.

---

## 4. Phase 2 — Medium severity

Backend code (each needs a regression test):
- **M2** `apps/backend/src/utils/tokenBlacklist.js` — make revocation **fail closed** on store errors (reject 503/401 when the blacklist store is unreachable) instead of returning `false`.
- **M3** `middleware/phiAccessMiddleware.js`, `services/security/accessDecisionService.js`, `middleware/staffAccessMiddleware.js` — restrict the "schema missing → allow" skip to an exact SQLSTATE allowlist on a verified `err.code` (never the `/does not exist/i` message regex); alert loudly; prefer fail-closed in prod.
- **M11** `apps/patient/lib/core/services/biometric_gate_service.dart` — fail **closed** when biometrics are enabled-but-unavailable/errored.
- **M5** `services/auth/staffAuthService.js` — bind PIN login to a registered device; key lockout on `(employeeId, deviceId/IP)` separately so attackers can't lock out clinicians; raise PIN entropy or per-device throttle.
- **M7 + M9** replace the regex sanitizer (`apps/backend/src/utils/sanitize.js`) with `sanitize-html`/DOMPurify applied consistently; in `apps/admin/next.config.ts` move CSP `script-src` to nonce/hash-based and drop `'unsafe-inline'` then `'unsafe-eval'`.
- **M1** `utils/jwtUtils.js` (both verifiers) + `utils/auth/tokenHelpers.js` — pass `{ algorithms: ['HS256'] }` to every `jwt.verify`.
- **M4** `middleware/consentMiddleware.js` — tenant-scope the consent query and pair consent with an ownership check (consent existence ≠ authorization).
- **M6** `utils/payslipPDF.js` — random per-document password delivered out-of-band; remove the hardcoded `'VHHealth@Admin2026'` owner fallback (fail closed if unset).
- **M12** `packages/vhhealth_core/lib/services/message_crypto.dart` — wire it into the patient↔hospital messaging path, or delete it to remove the false E2E assurance (decide with product owner).

Infra (manifests / pipeline):
- **M13** `infra/kubernetes/base/cnpg/cluster.yaml` — add `barmanObjectStore.encryption: AES256` (or customer passphrase); reconcile the DR docs.
- **M14** `infra/mcp/vh-mcp-postgres/k8s.yaml` — change NodePort → ClusterIP + NetworkPolicy; enforce a strong bearer token + statement allowlist.
- **M16** `infra/kubernetes/base/argocd/project.yaml` + new Kyverno/policy-controller rule — verify image signatures at admission keyed to the release workflow's OIDC identity; populate `signatureKeys`.
- **M15** `.forgejo/workflows/container-supply-chain.yml`, `security-sweep.yml` — make Trivy/secret findings blocking on the merge path; pin scanner images by digest.
- **M17** `infra/kubernetes/overlays/dalekdefender/*` — add securityContext + PSS labels + non-superuser DB role.
- **M18** `infra/kubernetes/optional/pacs/orthanc.yaml` — source `RegisteredUsers` from a SealedSecret, add securityContext + default-deny NetworkPolicy before enabling.

---

## 5. Phase 3 — Hardening & upgrades (after the above)

Pull these from audit §4 (Phase 3): shorten access-token TTL to minutes + lean on existing refresh rotation (L1); make `tenant_id` explicit in app queries so RLS is defense-in-depth not sole control (H3) + add a query-scoping lint; derive a separate `STORAGE_TOKEN_SECRET` (L3); Firebase App Check + GCP key restriction; cloudflared→ingress TLS (L10); MinIO metrics auth + record-bucket object-lock (L11); make Semgrep SAST blocking + dependency-review gate; **the two CI coverage tests** (backend: fail if any `/api/v1/*` mount lacks `requireRole`; admin: fail if any page lacks a policy entry) — these prevent H2/H6 regressions permanently and are the highest-leverage upgrade.

---

## 6. Definition of done

Per item: code matches the fix, a regression test proves the attack is blocked **and** the legitimate path works, the relevant stack's lint + tests pass, and the diff is scoped to one finding. Overall: backend `npm run ci`, admin `npm run lint && npm test && npm run build`, and `melos run analyze && melos run test` all green; no new fail-open paths; trackers updated; HUMAN items written up with explicit operator actions. Do **not** mark a runtime-dependent or HUMAN item "fixed" from code alone — mark it "code/manifest ready, awaiting operator verification."

---

## 7. Priority order (summary)

1. H1, H2, H4 (backend code — start here, fully specified, contained)
2. H10 manifest + HUMAN rotate; H12 workflow + HUMAN policy; Phase-0 runtime checks (HUMAN)
3. H6/M8, H7/H8, H9/M10, H5, H11
4. Phase 2 mediums
5. Phase 3 hardening + the two CI coverage tests

Work top-down. Re-read each file before editing. Test every behavioral change. When unsure whether something is safe, fail closed and flag it.
