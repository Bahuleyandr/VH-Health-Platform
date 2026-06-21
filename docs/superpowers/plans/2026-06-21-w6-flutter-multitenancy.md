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

- [ ] In `services/offline_queue.dart` (+ any non-secret cache in `VHSecureStorage`), derive the storage key via `TenantConfig.isDefaultTenant ? key : 't:${TenantConfig.cacheNamespace}:$key'` — default tenant ⇒ bare key (NO-OP, no orphaning); a stamped build is a fresh sandbox ⇒ namespaced from first run.
- [ ] Do NOT tenant-key the auth/JWT keys (a per-tenant build holds one tenant's user; re-keying risks logging users out on upgrade).
- [ ] `dart test` for the keying (default key unchanged; stamped key namespaced) + a manual device check that an existing install's queued items still load after upgrade.

## T3 — Per-tenant theme seed (minimal) — DEFERRED (optional)

- [ ] `app_theme.dart`: accept an optional seed colour from `TenantConfig.primaryColorHex` (default ⇒ current palette). Wire into the Material 3 `ColorScheme.fromSeed`. Optional; ship the hook even if not every screen consumes it.

## T4 — Per-tenant build/release + Firebase — DEFERRED (operator / product; needs the user)

- [ ] Android product flavors / iOS schemes per tenant (one `--dart-define` set per build: `VH_BASE_URL`, `VH_TENANT_SLUG`, `VH_TENANT_ID`, `VH_API_KEY`, `VH_TENANT_PRIMARY`).
- [ ] Signing configs + store listings per tenant.
- [ ] **Firebase decision** (§8.3): shared project now → per-tenant `google-services.json` / `GoogleService-Info.plist` per build later. Product decision — gated on the user.
- [ ] This is the W7 onboarding/build-matrix work; W6 code only makes the app *consume* a stamp.

## Handoff

W6 code-side (T1) is done + verified. T2 (DiD cache-keying) is a safe, well-specified follow-up that should be verified on a device before shipping. T3 is optional polish. T4 is operator/product (Firebase, signing, flavors) requiring the user's accounts/keys. Per-tenant **API routing already works** via `VH_BASE_URL` — the only thing between here and a live second tenant is W7's wildcard DNS/TLS + the build matrix.
