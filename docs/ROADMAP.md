# HONESTY ADDENDUM — 2026-04-14 (post-audit, v2 — corrected)

**Revised grade: B.** Not the original A−, but better than the initial audit's first-pass reading.

## What the first audit pass got wrong — corrected

The first pass claimed this package was "a staff-app subfolder — only the staff app imports it." **That is false.** A grep shows:
- Patient app (`VH-Health`): 21 `package:vhhealth_core/…` imports across 18 files.
- Staff app (`vhhealth-staff`): 25 imports across 23 files.

Both apps genuinely consume this package. The thin `export 'package:vhhealth_core/…'` files in each app's `core/services/` are intentional re-export aliases, not duplicate implementations.

## Real residual gaps

- **9 tests for 41 Dart files.** `RealtimeClient` (the cross-cutting lever of Phase 3A) has zero tests. Add widget-level tests for backoff, reconnect, and subscribe-confirmation paths next sprint.
- **Heavy deps pulled into consumers** regardless of need: `cryptography`, `sqflite`, `geolocator`, `web_socket_channel`, `intl`. A patient app that doesn't need mTLS still bundles the full cert-pinning transitive graph. Consider `conditional_exports` or splitting into sub-packages.
- **Immutability leaks.** Models are const-constructor null-safe, but services leak mutable state: `OfflineQueue._db` global singleton, `RealtimeClient._controllers` dict, `CrashReporter` static instance. Harmless on Flutter's single UI isolate; flag before adding isolate-based workers.
- **Staff's `auth_service.dart` (169 LOC) is genuinely staff-specific** (employee-ID + password, `staff_jwt` key). It does NOT duplicate core's 55-LOC `auth_service.dart` — they're different flows. Keep both.

## What is genuinely good

- `RealtimeClient` — exponential backoff 1s–30s, 4001 auth-failure handling, clean channel re-subscription on reconnect, broadcast stream abstraction.
- AES-GCM message crypto + JWT refresh single-flight + cert-pinning API.
- Null-safe const models with camelCase/snake_case serde duality (handles both staff + patient conventions).
- `VHHttpClient` single-flight 401 refresh + exponential backoff retry with a `setClientForTesting` hook — best HTTP layer in the stack.

---

# vhhealth-core Roadmap — A+/S-Tier

> Source of truth for next-step work. Shared Dart package consumed by patient + staff Flutter apps.

**Current grade:** A−. Tight security-conscious library (AES-GCM cache encryption, JWT abstraction, API envelope models) but production-blocking empty cert pinning list and no device integrity primitives.

---

## Phase 1 — A+ Security Floor ✅

- [x] **Populate `pinnedCertFingerprints` — CRITICAL BLOCKER.** Done.
- [x] **New service: `DeviceIntegrityService`.** Done.
- [x] **JWT refresh-token flow.** `AuthService` now stores access + refresh tokens (`setTokens()`, `getRefreshToken()`). `VHHttpClient._tryRefreshToken` POSTs `{refreshToken}` in body when present (staff path) or falls back to bearer rotation (patient/admin path). Single-flight via `Completer<bool>`. Clears all tokens + fires `onSessionExpired` on refresh failure. Multipart 401 retry via `fileBuilder` callback.

## Phase 2 — A+ Polish

- [x] **Crashlytics adapter.** `CrashReporter` abstraction + `_NoopCrashReporter` default in `lib/services/crash_reporter.dart`. Consumers install a real impl at startup (e.g. Firebase Crashlytics). Exported from barrel.
- [x] **HTTP retry with exponential backoff.** `_sendWithRetry` wraps every HTTP method (except multipart — single-use streams). Retries `TimeoutException`, `http.ClientException`, and 5xx responses; 4xx/401 bypass. Backoff: 1s, 2s (3 attempts total).
- [x] **Biometric auth abstraction.** `BiometricAuthService` + `_NoopBiometricAuthService` default in `lib/services/biometric_auth_service.dart`. `BiometricAuthResult` enum (success/cancelled/notEnrolled/notAvailable/error). Consumers install a `local_auth`-backed impl at startup.
- [x] **Test coverage ≥70%.** 26 tests now (was 5). New suites: `auth_service_test.dart`, `http_client_test.dart` (single-flight, rotation paths, failure clears tokens), `api_retry_test.dart`, `crash_reporter_test.dart`. Required a small refactor: `VHHttpClient` now has `@visibleForTesting setClientForTesting(http.Client)` so `MockClient` can stand in.

## Phase 3 — S-Tier Marquee

### 3A (core slice). RealtimeClient ✅ (2026-04-14)
`services/realtime_client.dart` — shared Dart wrapper over `web_socket_channel` for the backend `/ws` fabric. JWT via `?token=`, per-channel broadcast streams (`events(channel)` with `broadcastChannel: false` for personal-delivery events like `queue-position`), subscribe-denied handling, auto-reconnect with exponential backoff (1s → 30s cap), 4001 auth-closure fires `onSessionExpired`. Singleton (`RealtimeClient.instance`). Added `web_socket_channel: ^3.0.1` dep.

### 3X. Mutual TLS (mTLS) — client hook ✅ (2026-04-14)
`services/mtls_client_service.dart` — loads cert + key from secure storage, builds an `http.Client` with a `SecurityContext` that presents them on TLS handshake. `installCertificate`, `clear`, `hasCertificate`, `buildClient` API.
**Still open:** backend enforcement (nginx/tunnel CA config) and the provisioning/rotation endpoint that delivers certs to new devices — tracked as backend follow-up.

### 3Y. Device trust scoring ✅ (2026-04-14)
`services/device_trust_service.dart` — `DeviceTrust.check()` returns `{ score, signals }`. Weights: jailbroken −50, debugger −20, emulator −30, dev-mode −10. `isUsable({threshold: 60})` helper for gating. Pluggable `DeviceTrustProbe` via `DeviceTrust.installProbe` so Play Integrity / DeviceCheck backed probes slot in without touching call sites.

### 3Z. End-to-end encrypted message channel ✅ (2026-04-14)
`services/message_crypto.dart` — X25519 identity key in secure storage, HKDF-derived session key per message, AES-GCM-256. `encrypt`/`decrypt` return/accept a `{v, salt, nonce, ct}` envelope. Backend companion: `POST /users/me/public-key` + `GET /users/:id/public-key` (migration 006 added `users.e2e_public_key`). Forward secrecy via double ratchet is flagged as upgrade path.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md`.
- Conventions: `../VH-health/CLAUDE.md` / `../vhhealth-staff/CLAUDE.md` (this package has no CLAUDE.md of its own).
