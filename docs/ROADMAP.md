# vhhealth-core Roadmap — A+/S-Tier

> Source of truth for next-step work. Shared Dart package consumed by patient + staff Flutter apps.

**Current grade:** A−. Tight security-conscious library (AES-GCM cache encryption, JWT abstraction, API envelope models) but production-blocking empty cert pinning list and no device integrity primitives.

---

## Phase 1 — A+ Security Floor (in progress)

- [x] **Populate `pinnedCertFingerprints` — CRITICAL BLOCKER.** `lib/config/security_config.dart` L58-71 currently `[]`. Replace with build-time env-injected production + backup SPKI SHA-256 hashes. Add doc: extract via `openssl s_client -servername api.vhhealth.app -connect api.vhhealth.app:443 | openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64`. Crash early on empty list + `kReleaseMode`.
- [x] **New service: `DeviceIntegrityService`.** `lib/services/device_integrity_service.dart`. Thin wrapper over `flutter_jailbreak_detection` so both patient + staff apps call one API: `await DeviceIntegrityService.check()` returns `{ ok, reasons[] }`. Release builds hard-block on compromise; debug warns only.
- [ ] **JWT refresh-token flow.** `lib/services/auth_service.dart` currently reads static JWT. Add `refresh()` that swaps expired access token using stored refresh token. Silent retry on 401 in the HTTP client.

## Phase 2 — A+ Polish

- [ ] **Crashlytics adapter.** Core can't report its own errors today; consumers must add Firebase. Add a `CrashReporter` abstraction with a Firebase Crashlytics default impl + no-op fallback.
- [ ] **HTTP retry with exponential backoff.** `lib/services/http_client.dart` (276L) has no retry logic. Add retry on 5xx/network error with backoff (1s, 2s, 4s — cap 3 attempts).
- [ ] **Biometric auth abstraction.** `BiometricAuthService` so patient + staff both get fingerprint/FaceID without reimplementing. Backed by `local_auth` on both apps.
- [ ] **Test coverage ≥70%.** Currently 5 unit tests. Add: HTTP client retry behavior, JWT refresh path, cache encryption round-trip, API envelope error cases.

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
