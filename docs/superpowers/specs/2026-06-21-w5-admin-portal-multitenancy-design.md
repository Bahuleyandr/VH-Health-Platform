# W5 — Admin portal multi-tenancy (design)

- **Date:** 2026-06-21 · **Wave:** 5 of the [multi-tenancy program](2026-06-19-multi-tenancy-program-design.md).
- **Status:** ✅ IMPLEMENTED + GATED (2026-06-21). S1–S4 done; backend chunked-as-postgres gate GREEN ("All chunks passed", 87 chunks) + admin `npm test` (435) + `tsc` + `eslint` + `next build` all green. Commits S1 `040b0e4b` · S2 `71f661ab` · S3 `c52c6db6` · S4 `63783458`. Wildcard admin subdomain DNS/TLS = operator/HELD (W7). Branch `feat/multi-tenancy-program`, HOLD (not pushed).
- **Branch:** `feat/multi-tenancy-program` (HOLD — not pushed). Builds on W1 (fail-closed resolution), W2 (schema), W3 (per-tenant secrets/state), **W4 (edge routing + token tenant claim)**.
- **Depends on:** W4 — the admin token now carries `tenant_id` (C5), the backend derives tenant from Host (C1/C2), and the SUPER_ADMIN `x-tenant-id` override is audited (W1/W3). W5 is the **admin-app delivery** of that backend isolation. Coordinates with W7 (wildcard admin subdomain DNS/TLS = operator/HELD).

## Objective

After W5: each hospital's admins use **their own tenant's admin portal** (branded from `tenants.settings`, data hard-scoped to their tenant), a regular `ADMIN` cannot see or act on another tenant, and a `SUPER_ADMIN` has a **single dedicated console** to manage tenants and **act inside** any one of them (an audited, reason-required surface). One admin deployment serves all tenants; the tenant is derived from the Host subdomain, exactly as the backend resolves it.

## What W1–W4 already delivered (so W5 is small + mostly client-side)

- **Admin token `tenant_id`** — W4 C5: `adminLogin` (via the session helper's admins-aware `resolveTenantIdForUid`) + the MFA enroll/challenge-verify mints all stamp the admin's tenant. `jwtMiddleware` reads it; `tenantContextMiddleware` scopes every admin request by it; backend RLS isolates the data. **A regular ADMIN is therefore already hard-scoped to their tenant by the backend** — the app cannot widen that.
- **SUPER_ADMIN cross-tenant override** — W1/W3: `tenantContextMiddleware` honours `x-tenant-id` **only** for a SUPER_ADMIN, **only** with an `x-tenant-override-reason` (≥ 8 chars), and **audit-logs every use** (`TENANT_OVERRIDE_USED`). This is the acting-tenant mechanism; W5 builds the UI that drives it.
- **Tenant CRUD** — `apps/admin/.../dashboard/tenants/page.tsx` (280 LOC, functional: list/create/update via `@/lib/api/tenants`) backed by `/api/v1/admin/tenants` (`routes/admin/tenantRoutes.js`); `routePolicy` already pins `tenants` to `SUPER_ADMIN_ONLY`.
- **Admin proxy** — `app/api/proxy/[...path]/route.ts` forwards all non-hop-by-hop client headers, so an `x-tenant-id` + reason set by the console already reaches the backend.

So the program-spec line "issue tenant claim on admin token" and "proxy `x-tenant-id` whitelist" are **already satisfied**. W5's net-new is branding + the acting-tenant UX + proxy hardening.

## NO-OP invariant (single-tenant stays byte-identical)

Today there is one tenant (the default) on `admin.vhhealth.app`. Branding falls back to the current VH Health look when `tenants.settings.branding` is absent; the acting-tenant switcher only appears for `SUPER_ADMIN`; a regular ADMIN's experience is unchanged. Per-tenant behaviour activates only once a real tenant onboards on its subdomain (W7).

## Trust model (decided) — one deployment, Host-derived tenant

Per program spec §Wave 5 lean: **one admin deployment behind a wildcard subdomain, tenant resolved from Host** (not a per-tenant build, not a hospital picker). Rationale: the admin portal is staff-facing and low-volume; a single deployment with host-derived branding + backend-enforced scoping is simpler than N builds and matches how the backend already resolves tenant. The browser cannot spoof the Host to another tenant (Cloudflare tunnel + per-tenant TLS, same trust-by-topology as W4). The wildcard DNS/TLS is the only operator/HELD piece (W7).

## Design — 4 workstreams

### S1 — Backend: tenant branding/context endpoint (small)
A regular ADMIN's app must render its tenant's identity without exposing the full `admins`/`tenants` row. Add a thin, tenant-scoped read: **`GET /api/v1/admin/tenant/context`** → `{ id, slug, name, region, branding }` where `branding` is the typed `tenants.settings.branding` accessor (W3 WS1) — `{ displayName?, logoUrl?, primaryColor?, ... }` with safe defaults. Scoped to `req.tenantId` (the caller's own tenant); SUPER_ADMIN acting-as returns the acted tenant's context (rides the same override). No new table. Gate: backend chunked gate + a small deep test (default tenant → default branding; tenant A → A's branding; cross-tenant read blocked for a regular ADMIN).

### S2 — Admin: tenant-context provider + branding
A `TenantProvider` (React context) fetches `/admin/tenant/context` once post-auth (TanStack Query) and exposes `{ name, branding }`. The dashboard chrome (sidebar/header) renders the tenant `displayName` + `logoUrl`; a CSS variable (`--tenant-primary`) is set from `branding.primaryColor` with the current palette as the default. Pure-additive; absent branding → today's look (NO-OP). Gate: admin jest (provider renders default when branding absent; renders A's name when present) + `next build` (type-check).

### S3 — Admin: SUPER_ADMIN acting-tenant switcher (the console)
The existing `/dashboard/tenants` page becomes the **console**: each tenant row gets an **"Act as"** action that (a) prompts for a short reason, (b) stores the acting-tenant `{ id, slug, reason }` in memory + an httpOnly-mirrored client flag, and (c) makes the proxy attach `x-tenant-id` + `x-tenant-override-reason` to subsequent calls. A persistent **banner** ("Acting as **Tenant A** — exit") shows while active; "exit" clears it. Only rendered for `SUPER_ADMIN` (routePolicy already gates the page). The backend audits every override (existing). Gate: admin jest (switcher sets/clears acting-tenant; banner visibility keyed on role) + build.

### S4 — Admin proxy: defense-in-depth header discipline
Harden `app/api/proxy/[...path]/route.ts`: **strip any inbound `x-tenant-id` / `x-tenant-override-reason`** from the raw client request, and re-attach them **only** from the server-trusted acting-tenant state when the verified token role is `SUPER_ADMIN`. Belt-and-suspenders over the backend's own gating (the backend already ignores the header for non-super), but it stops a non-super admin's browser from ever putting a tenant header on the wire. Gate: admin jest (non-super inbound `x-tenant-id` dropped; super acting-tenant header attached; reason required).

## Out of scope / deferred

- **Tenant-driven theming beyond a primary color + logo** (full white-label themes) — settings schema supports more, but ship the minimal brandable surface first.
- **Per-tenant admin *builds*** — explicitly rejected by the lean (one deployment, host-derived).
- **Wildcard admin subdomain DNS/TLS + Cloudflare routing** — operator/HELD → W7 (same as W4's wildcard piece). Until then the default tenant on `admin.vhhealth.app` is the only live path; the switcher exercises acting-as without needing subdomains.
- **W6 (Flutter per-tenant builds)** and **W7 (onboarding)** — later waves.

## Test/gate plan

- Backend: the authoritative chunked-as-postgres gate (`run-ci-jest.mjs` as `postgres`) → "All chunks passed", plus an S1 deep test.
- Admin: `npm test` (jest) for S2–S4 + `npm run build` (type-check) + `npm run lint`. Existing Playwright e2e stays green (the seeded `playwright-admin` is a regular ADMIN → no switcher; smoke unaffected).
- NO-OP discipline: every change byte-identical for the single default tenant (no branding row, non-super admin).

## Decisions (binding for the plan)

1. **One admin deployment, Host-derived tenant** (program §Wave 5 lean) — not per-tenant builds, no picker.
2. **Acting-tenant lives on the existing `/dashboard/tenants` page** (already SUPER_ADMIN-gated) rather than a brand-new route — un-orphans it into the console with the least surface.
3. **Branding is minimal first** (displayName + logo + primary color) from `tenants.settings.branding`, defaulting to today's look.
4. **Proxy strips client tenant headers and re-attaches server-side** (S4) — defense-in-depth even though the backend already gates on SUPER_ADMIN.
