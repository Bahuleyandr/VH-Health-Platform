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

### 3X. Mutual TLS (mTLS) with client certificate
Beyond pinning: server authenticates *us* too. Client cert per device, rotated on install. Blocks credential stuffing at network layer.

### 3Y. Device trust scoring
Risk score = f(jailbreak, debugger attached, USB debug enabled, sideloaded apps, emulator). Conditional access: score below threshold → require MFA. Exposed as `DeviceTrust.score()`.

### 3Z. End-to-end encrypted message channel
For sensitive clinical messages (Rx, lab critical values). Per-user X25519 key pair, messages encrypted client-side before hitting the backend. Backend stores opaque ciphertext.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md`.
- Conventions: `../VH-health/CLAUDE.md` / `../vhhealth-staff/CLAUDE.md` (this package has no CLAUDE.md of its own).
