# W6 — Flutter apps multi-tenancy (design)

- **Date:** 2026-06-21 · **Wave:** 6 of the [multi-tenancy program](2026-06-19-multi-tenancy-program-design.md).
- **Status:** Design — derived from program spec §Wave 6 + a current-state mapping of `packages/vhhealth_core` + the two Flutter apps. Reconciles the spec with W4's decided trust model. Ready for a plan.
- **Branch:** `feat/multi-tenancy-program` (HOLD — not pushed). Builds on W4 (edge routing) + W5 (admin).
- **Depends on:** W4. Coordinates with W7 (the wildcard `*.api` DNS/TLS + per-tenant build/release pipeline is operator/product).

## Objective

Each hospital's patient + staff apps are a **per-tenant build** that talks only to that tenant's backend subdomain and (defense-in-depth) keeps its on-device caches tenant-segregated. After W6: a build stamped with a tenant points `VHHttpClient` at `https://<slug>.api.vhhealth.app/...`, the backend derives the tenant from that Host (W4), and offline queues/caches are namespaced by tenant so a re-login or a shared device can't surface another tenant's cached PHI.

## Reconciliation with W4 (important — the spec predates W4)

Program spec §Wave 6 said "tenantProvider → `X-Tenant-Id` on `VHHttpClient`". **W4 superseded this**: the backend now derives the tenant from the **Host subdomain** and treats client `x-tenant-*` as **untrusted** (ignored except the audited SUPER_ADMIN override). So W6 does **NOT** add an `X-Tenant-Id` header — a per-tenant build instead points at its **per-tenant subdomain** (`VH_BASE_URL`), and the Host carries the tenant. This is simpler and matches the trust-by-topology model.

## What already exists (so W6 is small)

- **`ApiConfig.baseUrl` already reads `String.fromEnvironment('VH_BASE_URL', default 'https://api.vhhealth.app/api/v1')`** — a per-tenant build already overrides the backend URL via `--dart-define=VH_BASE_URL=https://<slug>.api.vhhealth.app/api/v1`. `VH_API_KEY` is likewise a build-time define. So **per-tenant API routing needs no code change** — only a build-time define + (W7) the wildcard DNS/TLS.
- `services/offline_queue.dart` + `services/secure_storage.dart` (`VHSecureStorage`) hold the on-device queue/cache — the tenant-keying target.
- `services/realtime_client.dart` (WebSocket) derives its URL from the same base URL → already per-tenant via `VH_BASE_URL`.
- No hospital picker exists today (single build) — the program's "build is the hospital" model is the natural extension.

## NO-OP invariant

A build with **no** tenant defines (`VH_TENANT_SLUG` unset) behaves exactly as today: `VH_BASE_URL` defaults to `api.vhhealth.app`, cache keys use the existing namespace (the default-tenant key resolves to today's keys), theme is the current theme. Per-tenant behaviour activates only when a build is stamped.

## Design — workstreams

### T1 — `TenantConfig` build constants (vhhealth_core)
`config/tenant_config.dart`: compile-time `VH_TENANT_SLUG` (default `''`) + `VH_TENANT_ID` (default the platform default-tenant UUID) via `String.fromEnvironment`, plus `isDefaultTenant` (slug empty) and a `cacheNamespace` (`slug` or `'default'`). Exported from the barrel. Pure constants — trivially unit-testable, NO-OP by default.

### T2 — Tenant-keyed offline queue + cache (defense-in-depth)
Namespace `offline_queue` + the non-secret cache keys in `VHSecureStorage` by `TenantConfig.cacheNamespace` (e.g. `t:<slug>:<key>`). Each per-tenant build is already a separate app sandbox, so cross-tenant bleed is not a live vector — this is DiD for the shared-device / re-login edge. The default tenant maps to the existing key shape (NO-OP — must not orphan today's persisted data; migrate-on-read or default-namespace alias). Unit tests assert default keys are unchanged and a stamped build namespaces.

### T3 — Per-tenant theme/branding (minimal)
`app_theme.dart` accepts an optional seed/primary colour from a `VH_TENANT_PRIMARY` define (default = current palette). Optional, low-priority; ship a hook even if the colour isn't wired into every screen.

### T4 — Per-tenant build/release wiring (OPERATOR / PRODUCT — DEFERRED to W7 + the user)
Android flavors / iOS schemes per tenant, signing configs, store listings, and the **Firebase decision** (shared project now per §8.3 → per-tenant `google-services.json`/`GoogleService-Info.plist` per build later) are **product + operator** work requiring the user's accounts/keys. W6 (code) makes the app *consume* a tenant stamp; standing up the per-tenant build matrix is W7. Documented, not built here.

## Decisions (binding for the plan)

1. **Per-tenant build via `--dart-define`** (`VH_BASE_URL` + `VH_TENANT_SLUG` [+ `VH_TENANT_ID`, `VH_TENANT_PRIMARY`]) — no hospital picker, the build is the hospital.
2. **No `X-Tenant-Id` header** — superseded by W4 (Host-derived tenant). The subdomain carries the tenant.
3. **Cache-keying = defense-in-depth**, default-tenant NO-OP (don't orphan existing persisted data).
4. **Firebase stays one shared project now** (per-tenant per-build later — product decision, W7).

## Test / gate plan

- `melos run analyze` + `melos run test` (Dart) for T1–T3 (TenantConfig defaults; cache default-namespace unchanged + stamped namespacing; theme default).
- The deferred T4 (flavors/Firebase/signing) is operator/product — verified at onboarding (W7), not in this code gate.
- NO-OP discipline: an unstamped build is byte-identical (URL, cache keys, theme).
