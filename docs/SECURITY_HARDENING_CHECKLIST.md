# Security Hardening Checklist (Roadmap A7 + A8)

Owner-executable list closing the two items left unchecked in
`archive/PLATFORM_REMEDIATION_PLAN.md` ("rotate any real secrets that appeared in
local ignored .env or log files", "purge or regenerate local logs") plus
the pre-pilot security actions now consolidated in [`ROADMAP.md`](ROADMAP.md) §2.

## A7 — Secret rotation (do once, then on a calendar)

For credentials that remain in service, rotation order matters: rotate at the
provider, update the sealed secret / GitHub secret, roll the authorized
deployment, THEN revoke the old credential. Retired Forgejo identities instead
require containment and revocation evidence; do not re-provision them.

- [ ] `JWT_SECRET` — generate new 64-byte value; deploy; old tokens expire
      naturally (patient 7d / staff 8h / admin 4h). Coordinate a low-traffic
      window; mobile clients re-login via refresh flow.
- [ ] `API_KEY` + per-client `API_KEY_PATIENT/STAFF/ADMIN` — rotate and
      ship with app config (release builds read from dart-defines).
- [ ] Database passwords: `vhhealth` (CNPG app secret), `vhhealth_readonly`
      (2026-06-11: manifest fixed — now CNPG-managed via the
      `vhhealth-pg-readonly` SealedSecret, audit finding H10. ROTATION on
      every already-bootstrapped cluster still required — steps in
      `docs/PHASE0_OPERATOR_ACTIONS_2026-06-10.md` §1), `qa_writer`
      (dev-only, local).
- [ ] Cloudflare R2 keys (`CF_R2_*` + `cnpg-backup-credentials`).
- [ ] Firebase service account JSON; Twilio auth token; SMTP creds;
      `SENTRY_DSN` (rotate if it ever appeared in logs).
- [ ] Signed integration secrets: `HL7_INBOUND_SHARED_SECRET` (required in
      production) and `ABDM_CALLBACK_SECRET` (required when
      `ABDM_ENABLED=true`). Generate with `openssl rand -base64 32`, seal via
      `vhhealth-backend-env`, and restart all backend pods.
- [ ] Legacy secret-bearing DB rows: run
      `npm run security:audit-secret-encryption -- --json` from
      `apps/backend`. Rotate or backfill every reported row before pilot
      sign-off; the current app encrypts new writes but cannot safely rotate
      existing partner/TOTP/SMART/HL7 credentials without operator approval.
- [ ] Approved GitHub/deployment identities updated after rotation; retired
      Forgejo bot, registry, SSH, signing and mobile-release credentials
      inventoried and revoked or restricted without disrupting shared users.
      INF-006 / PR #872 remains held until named external receipts are attached
      to [`RELEASE_READINESS.md`](RELEASE_READINESS.md).
- [ ] Purge local artifacts: `.env*` backups, `output/logs/*`,
      `backend-ci-*.log` at repo root (contains workflow run output),
      old `pg.log` files. `node scripts/gitleaks-scan.mjs range` after.
- [ ] Calendar: repeat every 180 days (JWT/API keys) / 365 days (storage
      keys), and immediately on any contractor offboarding.

## A8 — Supply chain + external validation

Already in place (verify, don't rebuild): image build+SBOM+scan+sign in
`release-images.yml`, CodeQL, gitleaks, npm audit gates, ArgoCD pinned
digests in `infra/kubernetes/apps/kustomization.yaml`.

- [ ] **Signature verification at admission**: review the GitHub OIDC policy
      at `infra/kubernetes/base/image-policy/kyverno-verify-images.yaml` and the
      current [`KYVERNO_ENFORCE_READINESS.md`](KYVERNO_ENFORCE_READINESS.md)
      evidence requirements before any operator-authorized sync. The retired
      Forgejo public key remains historical evidence only; do not create an
      active admission Secret from it. Source retirement does not prove live
      admission or rollback-image trust and does not authorize activation.
- [ ] **Pen test**: commission an external test before pilot go-live.
      Scope: public surface (api.vhhealth.app via Cloudflare Tunnel),
      auth flows (OTP, staff login, refresh rotation, MFA), IDOR sweep on
      patient-facing routes, file upload pipeline, multi-tenant isolation
      (give testers two tenant accounts and the explicit goal of crossing),
      and the staff-web LAN surface. Provide the QA cluster, never prod.
- [ ] **DPDP Act review**: data-inventory walk (what PHI lives where),
      consent records coverage, breach-notification dry run using the
      existing `data_breaches` + `breach_log` tables.
- [ ] **Dependency watch**: review GitHub Dependabot updates monthly using
      [`qa/dependency-updates.md`](qa/dependency-updates.md). Kubernetes
      manifest-image updater coverage remains held for an owner decision.

## Standing rules (already enforced in code/CI — keep them green)

- No secrets in tracked files (gitleaks in lefthook + CI).
- All env secrets validated at boot (`validateEnv.js`) — app crashes on
  missing `JWT_SECRET`/`DATABASE_URL`/`API_KEY`, production
  `HL7_INBOUND_SHARED_SECRET`, or ABDM callback signing config when
  `ABDM_ENABLED=true`.
- API keys compared timing-safe; tokens carry `jti` and are blacklisted on
  logout/rotation.
- Legacy Firebase body-only registration stays disabled by default; do not set
  `ENABLE_LEGACY_FIREBASE_REGISTER=true` outside a local compatibility harness,
  and it is ignored in production.
- Legacy phone-only auth and dev patient-login shortcuts stay disabled by
  default; do not set `ENABLE_LEGACY_PHONE_AUTH=true` or `ENABLE_DEV_AUTH=true`
  outside a local compatibility harness, and both are ignored in production.
- The admin SMART-on-FHIR authorize-code helper stays disabled by default in
  every environment; do not set `SMART_FHIR_ADMIN_AUTHORIZE_ENABLED=true`
  outside a local integration test harness.
- Patient and staff Android release jobs must define
  `PATIENT_CERT_PIN_HASHES` / `STAFF_CERT_PIN_HASHES` GitHub variables with
  current + next-rotation `sha256/<SPKI base64>` hashes. Release workflows pass
  `PRODUCTION=true` and `CERT_PIN_HASHES`; missing pin variables must block the
  signed APK/AAB build.
