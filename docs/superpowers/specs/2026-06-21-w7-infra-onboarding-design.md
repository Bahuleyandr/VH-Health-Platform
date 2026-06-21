# W7 — Infra & tenant onboarding (design)

- **Date:** 2026-06-21 · **Wave:** 7 of the [multi-tenancy program](2026-06-19-multi-tenancy-program-design.md).
- **Status:** 🛠 DESIGNED + SCAFFOLDED (2026-06-21). The code/manifest artifacts are written + locally verified; only operator EXECUTION (apply to cluster + Cloudflare DNS + signing/Firebase) remains.
- **⚠️ SUBDOMAIN MODEL DECIDED — FLAT, NO ACM (supersedes the D1 nested-ACM analysis below):** to avoid the Cloudflare ACM cost, the per-tenant API host is **`<slug>-api.vhhealth.app`** (a 1st-level label → **free** Universal SSL `*.vhhealth.app`). `parseTenantSlug` strips the `-api` suffix (`TENANT_BASE_HOST=vhhealth.app`); apex `api`/`admin`/`www`/other labels → default tenant. The **admin portal stays single-host** at `admin.vhhealth.app` (a K8s Ingress can't wildcard-route `*-admin`, and W5 drives the admin's tenant+branding from the JWT). DNS = ONE `*.vhhealth.app` wildcard → tunnel (specific records win). The cloudflared/ingress/onboard/build-helper/tests/runbook were all updated to flat. The D1–D6 sections below describe the original nested-vs-flat analysis (kept for context). Done: **Part-A** flat wildcard manifests (`cloudflared` `*.vhhealth.app` + backend `*.vhhealth.app`; admin single-host) · **Part-B** idempotent `onboard-tenant.mjs` (verified against the QA DB) · build helper `scripts/build-tenant-client.sh`. Firebase decision RESOLVED by the user: **one shared project now → per-tenant per-build later.**
- **Branch:** `feat/multi-tenancy-program` (HOLD). **Depends on:** W3 (secrets), W4 (Host-derived routing), W5 (admin tenant CRUD), W6 (per-tenant client stamp).
- **Companion runbook:** [`docs/TENANT_ONBOARDING_RUNBOOK.md`](../../TENANT_ONBOARDING_RUNBOOK.md) (the step-by-step).

## Objective

Stand up and operate additional tenants **repeatably** on the shared cluster: a documented onboarding that produces a working, isolated tenant (its own subdomains, branding, secrets, client builds) with GO_LIVE Phase-E RLS verified — and the per-tenant operational surface (metrics, backups, quotas) to run it.

## Current routing (verified from the manifests)

`browser → Cloudflare edge (TLS) → Tunnel (gRPC) → cloudflared → ingress-nginx (HTTP :80) → Service`. Today:
- **DNS:** `api.vhhealth.app` + `admin.vhhealth.app` are CNAMEs to the tunnel.
- **`cloudflared` ConfigMap** (`infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml`): one ingress rule per host, each **rewriting `httpHostHeader` to the apex host** (e.g. `api.vhhealth.app`), then a `http_status:404` catch-all.
- **ingress-nginx**: `apps/backend/ingress.yaml` matches `host: api.vhhealth.app` → `vhhealth-backend`; admin similarly.
- **TLS:** cert-manager (Let's Encrypt) mints `vhhealth-backend-tls` for the apex host; Cloudflare edge holds the browser-facing cert.

## The wildcard piece (the W4 operator/HELD item)

To route `tenant-a.api.vhhealth.app` to the backend so W4's `parseTenantSlug` sees `tenant-a`:

### D1 — Subdomain structure + TLS (DECISION REQUIRED)
`*.api.vhhealth.app` is a **2nd-level wildcard**. **Cloudflare Universal SSL covers only `vhhealth.app` + `*.vhhealth.app` (one level)** — it does NOT cover `*.api.vhhealth.app`. Options:
- **(A) Nested `<slug>.api.vhhealth.app`** (matches W4's `TENANT_BASE_HOST=api.vhhealth.app`, leftmost-label slug). Needs **Cloudflare Advanced Certificate Manager (ACM, paid ~$10/mo)** for a `*.api.vhhealth.app` edge cert, or an Origin CA / custom cert. **Recommended** — cleanest model, W4 already assumes it.
- **(B) Flat `<slug>-api.vhhealth.app`** (single level, covered by Universal SSL `*.vhhealth.app`). Avoids ACM, but W4's `parseTenantSlug` would need a `-api`-suffix variant (the slug is the label minus the `-api` suffix) — a small `tenantService` tweak + `TENANT_BASE_HOST` semantics change.
- Same choice applies to the admin host (`*.admin.vhhealth.app` vs `<slug>-admin.vhhealth.app`).

### D2 — cloudflared: preserve the Host on the wildcard rule
Add wildcard ingress rules that **do NOT rewrite the Host** (the apex-rewrite is what loses the tenant). Insert ABOVE the `404` catch-all:
```yaml
- hostname: "*.api.vhhealth.app"
  service: http://ingress-nginx-controller.vhhealth-ingress.svc.cluster.local:80
  originRequest:
    httpHostHeader: ""        # preserve the original <slug>.api.vhhealth.app Host
    connectTimeout: 30s
    keepAliveTimeout: 90s
- hostname: "*.admin.vhhealth.app"
  service: http://ingress-nginx-controller.vhhealth-ingress.svc.cluster.local:80
  originRequest:
    httpHostHeader: ""
```
(Keep the existing apex rules first so the default tenant is byte-identical.) `origin-request.originServerName` is moot here — the in-cluster hop is plain HTTP.

### D3 — ingress-nginx: a wildcard host rule
Add a wildcard host to the backend Ingress (a second rule or a dedicated Ingress) so nginx routes `*.api.vhhealth.app` → `vhhealth-backend`:
```yaml
rules:
  - host: api.vhhealth.app        # existing — default tenant
    http: { paths: [ {path: /, pathType: Prefix, backend: {service: {name: vhhealth-backend, port: {number: 80}}}} ] }
  - host: "*.api.vhhealth.app"     # W7 — every per-tenant subdomain
    http: { paths: [ {path: /, pathType: Prefix, backend: {service: {name: vhhealth-backend, port: {number: 80}}}} ] }
tls:
  - hosts: [api.vhhealth.app, "*.api.vhhealth.app"]
    secretName: vhhealth-backend-tls   # if option A, the cert/edge must cover the wildcard
```
Admin ingress mirrors this. nginx supports a single wildcard label in `host`.

### D4 — backend env
Set `TENANT_BASE_HOST=api.vhhealth.app` (option A) so `parseTenantSlug` resolves the leftmost label, and **flip `ALLOW_DEFAULT_TENANT=false`** only after every tenant is onboarded on its subdomain (until then the default-tenant floor keeps the apex working). Already plumbed (W1/W4); this is the GO_LIVE cutover toggle.

## Tenant-onboarding orchestrator (D5)

A single idempotent script (`apps/backend/scripts/onboard-tenant.mjs`, design below) that an operator runs per new tenant. It wraps the pieces W2–W6 already built:
1. **Create the tenant row** — `createTenant({slug,name,region,compliance_profile})` (W5 service / `/api/v1/admin/tenants`).
2. **Seed `settings`** — branding (`{name,logoUrl,primaryColor}`), rate-limit overrides (W3 WS1/WS2).
3. **Provision the per-tenant KEK** — register in `encryption_keys` (W3 WS5 `tenantKekProvider`); re-wrap not needed for a fresh tenant.
4. **Seed interop secrets** — ABDM/HL7 per-tenant rows if the tenant federates (W3 WS6 `upsertInteropSecret`).
5. **Bootstrap the tenant admin** — one `ADMIN` row with `tenant_id` set (mig 334), forced password reset.
6. **Reference data + R2 prefix** — seed any per-tenant reference rows; create the R2 key-prefix.
7. **Clinical-AI preflight** — run `check-clinical-ai-tenant-preflight` (existing).
8. **DNS** — (Cloudflare API) ensure the wildcard already covers `<slug>.api` + `<slug>.admin` (no per-tenant DNS once the wildcard exists).
9. **Client builds** — produce the patient + staff per-tenant builds (W6 `--dart-define` matrix; see runbook) + the admin host registration (no build — host-derived).
10. **Phase-E verify** — runtime RLS check for the new tenant (GO_LIVE checklist).

Each step is idempotent (skip-if-exists) so a re-run after a partial failure is safe — same discipline as `ci-setup-db.mjs`.

## Per-tenant client builds (D6 — from W6 T4)

One `--dart-define` set per tenant per app:
```
flutter build apk --dart-define=VH_BASE_URL=https://<slug>.api.vhhealth.app/api/v1 \
  --dart-define=VH_TENANT_SLUG=<slug> --dart-define=VH_TENANT_ID=<uuid> \
  --dart-define=VH_API_KEY=<key> --dart-define=VH_TENANT_PRIMARY=#RRGGBB
```
Android product flavors / iOS schemes encode this per tenant. **Firebase** (the open product decision): one shared project now (all tenants share the OTP project; the backend isolates by tenant) → per-tenant `google-services.json` / `GoogleService-Info.plist` per build later. Signing configs per tenant. This is the build-matrix the operator/CI runs; the app CODE already consumes the stamp (W6).

## Scale items (deferred — larger sub-projects)

Per-tenant metrics/quotas/alert-routing; per-tenant logical backup/export/erase (DPDP erasure); connection-budget per tenant; residency silo; per-tenant R2 isolation; activate Vault (secret store), Kyverno Enforce, Longhorn; a CI mobile-build/release pipeline per tenant. Each is its own ticket; none blocks the first additional tenant.

## Decisions needed from the operator/product owner

1. **D1 subdomain/TLS:** option A (nested + Cloudflare ACM) [recommended] vs B (flat + Universal SSL). Gates the cloudflared/ingress/`TENANT_BASE_HOST` shape.
2. **Firebase:** shared project now (recommended for speed) vs per-tenant per-build.
3. **When to flip `ALLOW_DEFAULT_TENANT=false`** (after all tenants are subdomained).

## Gate / done

A documented, repeatable onboarding (the runbook) produces a working isolated tenant reachable at its subdomain, branded, with its own KEK + admin, and Phase-E RLS green. The wildcard DNS/TLS + cloudflared/ingress changes are applied once; subsequent tenants need only the orchestrator + the build matrix.
