# Security Hardening Checklist (Roadmap A7 + A8)

Owner-executable list closing the two items left unchecked in
`PLATFORM_REMEDIATION_PLAN.md` ("rotate any real secrets that appeared in
local ignored .env or log files", "purge or regenerate local logs") plus
the pre-pilot security actions from `EPIC_LEVEL_ROADMAP.md`.

## A7 — Secret rotation (do once, then on a calendar)

Rotation order matters: rotate at the provider, update the sealed secret /
GitHub secret, roll the deployment, THEN revoke the old credential.

- [ ] `JWT_SECRET` — generate new 64-byte value; deploy; old tokens expire
      naturally (patient 7d / staff 8h / admin 4h). Coordinate a low-traffic
      window; mobile clients re-login via refresh flow.
- [ ] `API_KEY` + per-client `API_KEY_PATIENT/STAFF/ADMIN` — rotate and
      ship with app config (release builds read from dart-defines).
- [ ] Database passwords: `vhhealth` (CNPG app secret), `vhhealth_readonly`
      (was a literal in postInitApplicationSQL — verify it was changed),
      `qa_writer` (dev-only, local).
- [ ] Cloudflare R2 keys (`CF_R2_*` + `cnpg-backup-credentials`).
- [ ] Firebase service account JSON; Twilio auth token; SMTP creds;
      `SENTRY_DSN` (rotate if it ever appeared in logs).
- [ ] GitHub Actions secrets re-entered after rotation
      (`VH_API_KEY`, Android signing secrets).
- [ ] Purge local artifacts: `.env*` backups, `output/logs/*`,
      `backend-ci-*.log` at repo root (contains workflow run output),
      old `pg.log` files. `node scripts/gitleaks-scan.mjs range` after.
- [ ] Calendar: repeat every 180 days (JWT/API keys) / 365 days (storage
      keys), and immediately on any contractor offboarding.

## A8 — Supply chain + external validation

Already in place (verify, don't rebuild): image build+SBOM+scan+sign in
`release-images.yml`, CodeQL, gitleaks, npm audit gates, ArgoCD pinned
digests in `overlays/prod/kustomization.yaml`.

- [ ] **Signature verification at admission**: today images are signed but
      the cluster does not VERIFY. Options (pick one, ticket it):
      sigstore policy-controller, or Kyverno `verifyImages` on the
      `vhhealth` namespace, keyed to the GitHub OIDC identity of
      `release-images.yml`.
- [ ] **Pen test**: commission an external test before pilot go-live.
      Scope: public surface (api.vhhealth.app via Cloudflare Tunnel),
      auth flows (OTP, staff login, refresh rotation, MFA), IDOR sweep on
      patient-facing routes, file upload pipeline, multi-tenant isolation
      (give testers two tenant accounts and the explicit goal of crossing),
      and the staff-web LAN surface. Provide the QA cluster, never prod.
- [ ] **DPDP Act review**: data-inventory walk (what PHI lives where),
      consent records coverage, breach-notification dry run using the
      existing `data_breaches` + `breach_log` tables.
- [ ] **Dependency watch**: Renovate/dependabot already configured —
      add a monthly 30-minute triage slot so PRs don't rot.

## Standing rules (already enforced in code/CI — keep them green)

- No secrets in tracked files (gitleaks in lefthook + CI).
- All env secrets validated at boot (`validateEnv.js`) — app crashes on
  missing `JWT_SECRET`/`DATABASE_URL`/`API_KEY`.
- API keys compared timing-safe; tokens carry `jti` and are blacklisted on
  logout/rotation.
