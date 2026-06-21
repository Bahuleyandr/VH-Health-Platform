# W6 — Flutter apps multi-tenancy — Implementation Plan

> Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the patient + staff Flutter apps consume a per-tenant build stamp (subdomain already handled via `VH_BASE_URL`) and segregate on-device caches by tenant — reconciled with W4 (Host-derived tenant, NO `X-Tenant-Id` header).

**Spec:** `docs/superpowers/specs/2026-06-21-w6-flutter-multitenancy-design.md`

**Stack:** Dart 3.11 / Flutter 3.41 (`D:/Dev/Tools/flutter`), pub workspace (Melos). Verify: `dart analyze` + `dart test` in `packages/vhhealth_core` (melos not on PATH here — invoke dart directly per package).

**Invariant:** an unstamped build (`VH_TENANT_SLUG` unset) is byte-identical to today — same URL, same cache keys, same theme.

---

## T1 — `TenantConfig` build constants (vhhealth_core) — ✅ DONE this session

- [x] `lib/config/tenant_config.dart`: compile-time `slug` (`VH_TENANT_SLUG`, default `''`), `id` (`VH_TENANT_ID`, default platform default-tenant UUID), `primaryColorHex` (`VH_TENANT_PRIMARY`, default `''`); derived `isDefaultTenant` (slug empty) + `cacheNamespace` (`slug` or `'default'`).
- [x] Export from the `vhhealth_core.dart` barrel.
- [x] `test/config/tenant_config_test.dart`: defaults (unstamped ⇒ isDefaultTenant true, cacheNamespace 'default', default id) + a stamped read note.
- [x] **Verify:** `dart analyze lib/config/tenant_config.dart` + `dart test test/config/tenant_config_test.dart` green.

## T2 — Tenant-key the offline queue + non-secret caches (defense-in-depth) — DEFERRED (user/device)

> Lower priority (spec): each per-tenant build is already a separate app sandbox, so cross-tenant bleed is not a live vector. It touches PERSISTED on-device data, so the NO-OP (default tenant keeps today's exact keys — must not orphan users' queued data) needs device verification. Recommended approach:

- [x] `services/offline_queue.dart` namespaces the SQLite file (`offline_queue_<slug>.db`) + the AES key name by `TenantConfig` — default tenant ⇒ original names (NO-OP, no orphaning); a stamped build is a fresh sandbox. (Commit `42269348`.)
- [x] Did NOT tenant-key the auth/JWT keys (a per-tenant build holds one tenant's user).
- [x] `dart test` green (default DB filename unchanged). **Still recommended before shipping a 2nd tenant: a manual device check that an existing install's queued items load after upgrade** (the default-tenant path is NO-OP so this should hold, but verify on a device).
- Note: the patient app's `ApiCacheManager` (apps/patient) mirrors this queue and is a parallel namespacing candidate — app-specific, follow-up.

## T3 — Per-tenant theme seed (minimal) — ✅ DONE (commit `42269348`)

- [x] `app_theme.dart`: `seedColor` derives the Material 3 `ColorScheme.fromSeed` seed from `VH_TENANT_PRIMARY` (testable `parseHexColor`); default ⇒ brand colour (NO-OP). App bar/buttons follow the tenant seed.

## T4 — Per-tenant build/release + Firebase — DEFERRED (operator / product; needs the user)

- [ ] Android product flavors / iOS schemes per tenant (one `--dart-define` set per build: `VH_BASE_URL`, `VH_TENANT_SLUG`, `VH_TENANT_ID`, `VH_API_KEY`, `VH_TENANT_PRIMARY`).
- [ ] Signing configs + store listings per tenant.
- [ ] **Firebase decision** (§8.3): shared project now → per-tenant `google-services.json` / `GoogleService-Info.plist` per build later. Product decision — gated on the user.
- [ ] This is the W7 onboarding/build-matrix work; W6 code only makes the app *consume* a stamp.

## Handoff

W6 code-side (T1) is done + verified. T2 (DiD cache-keying) is a safe, well-specified follow-up that should be verified on a device before shipping. T3 is optional polish. T4 is operator/product (Firebase, signing, flavors) requiring the user's accounts/keys. Per-tenant **API routing already works** via `VH_BASE_URL` — the only thing between here and a live second tenant is W7's wildcard DNS/TLS + the build matrix.
