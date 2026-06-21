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

**Model: FLAT `<slug>-api.vhhealth.app`** (1st-level → **free** Cloudflare Universal
SSL `*.vhhealth.app`, **no ACM cost**). The admin portal stays single-host at
`admin.vhhealth.app` (the admin's tenant + branding come from the JWT — W5).

1. **Backend config:** set `TENANT_BASE_HOST=vhhealth.app` in the backend configmap
   (so `parseTenantSlug` reads `<slug>-api.vhhealth.app` → `<slug>`). Confirm
   `REDIS_URL` is wired (W3 WS2 per-tenant rate-limit quotas use it).
2. **Cloudflare DNS:** add ONE wildcard CNAME **`*.vhhealth.app` → `<tunnel-id>.cfargotunnel.com`**
   (proxied / orange cloud). Existing specific records (`api`, `admin`, `www`, …)
   always win over the wildcard, so it only catches new `<slug>-api` hosts. No new
   cert needed — Universal SSL already covers `*.vhhealth.app` (1st-level).
3. **cloudflared:** the `*.vhhealth.app` Host-preserving rule (no `httpHostHeader`)
   is already in `infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml` (after the
   apex rules). It applies on the next ArgoCD sync (merge to main) →
   `kubectl rollout status deploy/cloudflared -n vhhealth-ingress`.
4. **ingress-nginx:** the `*.vhhealth.app` host rule on the backend Ingress
   (`apps/backend/ingress.yaml`) is already in place (admin keeps its specific
   `admin.vhhealth.app` rule). Kept OUT of cert-manager `tls.hosts` on purpose
   (browser TLS is Cloudflare's free Universal SSL; the cloudflared→ingress hop is
   HTTP). Applies on the same sync.
5. **Smoke the wildcard** (after the merge applies the manifests):
   `curl -sI https://probe-api.vhhealth.app/api/v1/health` → reaches the backend (an
   unknown slug returns the app's unknown-tenant response, proving the route works
   end-to-end, not a 404 at the edge).

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
- `curl -sI https://acme-api.vhhealth.app/api/v1/health` → 200.
- Log in to `https://admin.vhhealth.app` as the bootstrapped admin → you see ONLY
  Acme's data (backend RLS + the admin's token tenant_id; admin is single-host).
- **Phase-E RLS check** (GO_LIVE): run the runtime RLS verification for `tenant_id =
  <acme-uuid>` (the non-superuser role cannot read another tenant's rows).

### B4 — Per-tenant client builds (patient + staff apps)
For each app, build with the tenant's `--dart-define` set (design D6):
```bash
flutter build apk --flavor acme \
  --dart-define=VH_BASE_URL=https://acme-api.vhhealth.app/api/v1 \
  --dart-define=VH_TENANT_SLUG=acme \
  --dart-define=VH_TENANT_ID=<acme-uuid> \
  --dart-define=VH_API_KEY=<api-key> \
  --dart-define=VH_TENANT_PRIMARY=#1565C0
```
- **Firebase:** shared project now → the build uses the shared `google-services.json`.
  (Per-tenant Firebase later: swap in the tenant's config per flavor.)
- Sign with the tenant's signing config; distribute via the tenant's store listing /
  Firebase App Distribution.
- The admin portal needs **no build** and **no per-tenant subdomain** — it's the
  single `admin.vhhealth.app`, tenant driven by the admin's JWT (W5).

### B5 — Hand-off
Give the tenant: their admin URL + the bootstrapped admin credentials (forced reset),
the patient/staff app links, and a note that all access is tenant-isolated + audited.

---

## Verification checklist (per tenant)
- [ ] `https://<slug>-api.vhhealth.app/api/v1/health` → 200.
- [ ] Admin login at `admin.vhhealth.app` (single host) shows only this tenant's data.
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
