# Tenant Onboarding Runbook (multi-tenancy W7)

> **PREREQUISITE — currently SINGLE-TENANT.** The backend runs with ALLOW_DEFAULT_TENANT=true today; multi-tenant isolation is NOT active. This runbook is the OPERATOR procedure to enable it. Until platform-ops completes Part A (wildcard DNS/TLS/ingress) AND flips ALLOW_DEFAULT_TENANT=false, Part B onboardings are not isolated.

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
   the production Redis Sentinel contract is live and proved
   (`REDIS_REQUIRE_SENTINEL=true`, three `REDIS_SENTINEL_HOSTS`, matching data
   and Sentinel credentials). Follow `REDIS_SENTINEL_HA_RUNBOOK.md`; a standalone
   `REDIS_URL` is local-development only.
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

### B2.1 — Add an explicit private-ingress host (only after C2 activation)

C2.1 deliberately ships only the apex `api.vhhealth.app` rule on the private
controller. The public Cloudflare route may keep its existing wildcard, but
the hospital-LAN route never inherits it.

If the tenant is approved for split-horizon private access:

1. confirm C-D13, the network-owner ledger, C0.1 parity, and the C2.1 operator
   drill are complete for the active private path;
2. record `<slug>-api.vhhealth.app` in the reviewed tenant-host inventory;
3. add one literal host rule to
   `infra/kubernetes/apps/backend/ingress-internal-api.yaml`, using path `/`,
   `Prefix`, and Service `vhhealth-backend`;
4. add the exact hostname to the selected certificate SAN ledger. Do not add
   `*.vhhealth.app`, and do not use wildcard-with-HTTP-01;
5. preserve the original Host: do not add a rewrite, `upstream-vhost`,
   `httpHostHeader`, or Host-replacement annotation;
6. run
   `node infra/kubernetes/qa/c2-1-internal-ingress-contract.mjs`, production
   apps/platform Kustomize renders, and strict kubeconform;
7. obtain the required review and merge. A merge remains inert because the
   production Applications are manual-sync; and
8. after the separately approved manual sync, C2.2 may publish one explicit
   private DNS record on managed clinical networks.

Before and after the new rule, an unlisted tenant, arbitrary wildcard host,
node-IP Host, and `admin.vhhealth.app` must reach the internal controller's
default backend 404. If any reaches the VH Health backend, roll back the rule.

### B3 — Verify routing + isolation
- `curl -sI https://acme-api.vhhealth.app/api/v1/health` → 200.
- If private access was approved, repeat from an approved clinical network and
  prove DNS resolves to the private VIP, the original Host reaches the backend,
  and the same request from a guest network retains the public route.
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
- [ ] If private access is approved, the exact `<slug>-api` rule and SAN exist;
  there is no wildcard private rule or record, and unlisted hosts return the
  internal default backend 404.
- [ ] Branding (name/colour) renders in the admin chrome.

## Rollback (a tenant onboarded in error)
1. Set the tenant `status='suspended'` (admin tenants page or `PATCH /admin/tenants/:id`)
   — the middleware then rejects its requests.
2. Crypto-shred its PHI: `cryptoShredTenant(tenantId)` (W3 WS5) clears
   `wrapped_key_material` on **every** `t:<tenant>:v<n>` row and retires it — its
   encrypted data becomes unreadable. Do **not** hand-edit the column: migration 672
   makes tenant KEK material write-once (it may only be cleared), so an in-place
   `UPDATE … SET wrapped_key_material = …` is refused with SQLSTATE 23514.
3. (Optional) hard-delete via a tenant-scoped purge once exports are taken.

### Un-shredding is impossible; re-provisioning is not
A shred is final for the data it covered — that is the point. The tenant itself
is **not** bricked: re-run the onboarding KEK step
(`node scripts/onboard-tenant.mjs …`, or `provisionTenantKek(tenantId)`) and it
allocates the **next** version, e.g. `t:<tenant>:v2` with `rotated_from` pointing
at the shredded row. New writes are stamped with the new version and work
immediately; anything encrypted before the shred stays unrecoverable. Re-running
against a tenant that still has a live KEK is a no-op — it reuses the active
version rather than rotating.
The wildcard DNS/TLS + cloudflared/ingress changes are platform-wide — never roll those
back to remove one tenant.

## Notes
- After **all** tenants are subdomained, flip `ALLOW_DEFAULT_TENANT=false` (design D4)
  to fail-close the apex.
- `clinical.vhhealth.hospital.local` is the staff SPA identity, not a tenant API
  host. It remains on `nginx-internal-held` until C2.2 fixes the web artifact's
  `/api/v1` base URL and completes browser CORS/WebSocket/login/upload proof.
- Scale items (per-tenant metrics/quotas/backups/erase, Vault, Kyverno Enforce) are
  separate tickets — see the W7 design "Scale items".
