# Tenant Onboarding Runbook (multi-tenancy W7)

Repeatable steps to stand up a new tenant (hospital/clinic) on the shared VH Health
cluster. Design + rationale: [`docs/superpowers/specs/2026-06-21-w7-infra-onboarding-design.md`](superpowers/specs/2026-06-21-w7-infra-onboarding-design.md).

> **Status:** the backend/admin/client CODE is in place (program waves W1–W6). The
> steps below are **operator-led** and require cluster + Cloudflare + signing/Firebase
> access. **Part A is one-time**; **Part B repeats per tenant**.

---

## Part A — One-time platform prep (enables per-tenant subdomains)

Do these **once** before the first additional tenant. Until they're done, only the
default tenant on the apex hosts works (which is today's behaviour — NO-OP).

1. **Decide the subdomain/TLS model (design D1).**
   - **Recommended (A):** nested `<slug>.api.vhhealth.app` + Cloudflare **Advanced
     Certificate Manager** for a `*.api.vhhealth.app` (and `*.admin.vhhealth.app`)
     edge cert. Set `TENANT_BASE_HOST=api.vhhealth.app` in the backend configmap.
   - Alt (B): flat `<slug>-api.vhhealth.app` (Universal SSL covers it) — requires a
     small `parseTenantSlug` change first; do NOT use without that code change.
2. **Cloudflare DNS:** add wildcard CNAMEs `*.api.vhhealth.app` and
   `*.admin.vhhealth.app` → `<tunnel-id>.cfargotunnel.com` (proxied). Confirm the
   ACM cert (A) is active for both wildcards.
3. **cloudflared:** add the two wildcard ingress rules (Host-preserving,
   `httpHostHeader: ""`) ABOVE the `http_status:404` catch-all in
   `infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml` (snippet in the design
   D2). Keep the apex rules first. `git push` → ArgoCD sync → `kubectl rollout status
   deploy/cloudflared -n vhhealth-ingress`.
4. **ingress-nginx:** add the `*.api.vhhealth.app` host rule (+ admin) and the
   wildcard to the `tls.hosts` in `apps/backend/ingress.yaml` /
   `apps/admin/ingress.yaml` (snippet D3). Sync.
5. **Verify Redis** (`REDIS_URL`) is wired (W3 WS2 per-tenant rate-limit quotas use it).
6. **Smoke the wildcard:** `curl -sI https://probe.api.vhhealth.app/api/v1/health` →
   resolves (an unknown slug returns the app's unknown-tenant response, proving the
   route reaches the backend, not a 404 at the edge).

---

## Part B — Per-tenant onboarding (repeat per tenant)

Inputs: `slug` (e.g. `acme`), `name`, `region`, `compliance_profile`, brand colour,
optional logo URL, whether the tenant federates (ABDM/HL7).

### B1 — Create + seed the tenant (backend)
Run the orchestrator (idempotent — safe to re-run):
```bash
node apps/backend/scripts/onboard-tenant.mjs \
  --slug acme --name "Acme Hospital" --region IN --compliance DPDP \
  --primary "#1565C0" --admin-email admin@acme.example
```
It performs (each skip-if-exists): create the `tenants` row · seed `settings.branding`
+ rate-limit overrides · register the per-tenant KEK (`encryption_keys`) · bootstrap one
`ADMIN` (tenant-bound, forced reset) · seed reference data + the R2 key-prefix · run the
clinical-AI tenant preflight. (If the script is not yet present, do these via
`POST /api/v1/admin/tenants` as a SUPER_ADMIN + the SQL in the design D5.)

### B2 — Interop secrets (only if the tenant federates)
For ABDM: set `x-hip-id` → secret. For HL7: receiving-facility (MSH-6) → secret. Via
`upsertInteropSecret` (W3 WS6). Skip if the tenant doesn't use ABDM/HL7 (the env-backed
default applies).

### B3 — Verify routing + isolation
- `curl -sI https://acme.api.vhhealth.app/api/v1/health` → 200.
- Log in to `https://acme.admin.vhhealth.app` as the bootstrapped admin → you see ONLY
  Acme's data (backend RLS + Host-derived tenant).
- **Phase-E RLS check** (GO_LIVE): run the runtime RLS verification for `tenant_id =
  <acme-uuid>` (the non-superuser role cannot read another tenant's rows).

### B4 — Per-tenant client builds (patient + staff apps)
For each app, build with the tenant's `--dart-define` set (design D6):
```bash
flutter build apk --flavor acme \
  --dart-define=VH_BASE_URL=https://acme.api.vhhealth.app/api/v1 \
  --dart-define=VH_TENANT_SLUG=acme \
  --dart-define=VH_TENANT_ID=<acme-uuid> \
  --dart-define=VH_API_KEY=<api-key> \
  --dart-define=VH_TENANT_PRIMARY=#1565C0
```
- **Firebase:** shared project now → the build uses the shared `google-services.json`.
  (Per-tenant Firebase later: swap in the tenant's config per flavor.)
- Sign with the tenant's signing config; distribute via the tenant's store listing /
  Firebase App Distribution.
- The admin portal needs **no build** — it's host-derived (`acme.admin.vhhealth.app`).

### B5 — Hand-off
Give the tenant: their admin URL + the bootstrapped admin credentials (forced reset),
the patient/staff app links, and a note that all access is tenant-isolated + audited.

---

## Verification checklist (per tenant)
- [ ] `https://<slug>.api.vhhealth.app/api/v1/health` → 200.
- [ ] Admin login at `<slug>.admin.vhhealth.app` shows only this tenant's data.
- [ ] A second tenant's admin CANNOT see this tenant's data (cross-tenant 403/empty).
- [ ] Phase-E runtime RLS green for the new `tenant_id`.
- [ ] Patient + staff builds point at the subdomain (decode a token → `tenant_id` matches).
- [ ] Branding (name/colour) renders in the admin chrome.

## Rollback (a tenant onboarded in error)
1. Set the tenant `status='suspended'` (admin tenants page or `PATCH /admin/tenants/:id`)
   — the middleware then rejects its requests.
2. Crypto-shred its PHI: NULL the tenant's `wrapped_key_material` (W3 WS5) — its
   encrypted data becomes unreadable.
3. (Optional) hard-delete via a tenant-scoped purge once exports are taken.
The wildcard DNS/TLS + cloudflared/ingress changes are platform-wide — never roll those
back to remove one tenant.

## Notes
- After **all** tenants are subdomained, flip `ALLOW_DEFAULT_TENANT=false` (design D4)
  to fail-close the apex.
- Scale items (per-tenant metrics/quotas/backups/erase, Vault, Kyverno Enforce) are
  separate tickets — see the W7 design "Scale items".
