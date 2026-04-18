# DeviceTrust roadmap

Staged plan for moving `DeviceTrust` from heuristic signals to a production-grade
device-trust score suitable for gating high-risk flows (bulk export, settings
changes, large pharmacy orders, etc.).

## Stage 1 — landed

`lib/services/device_trust_service.dart` ships today with a probe interface and
a default `kDebugMode`-based probe. Scoring, thresholds, and the audit-signal
map are stable; higher-fidelity probes are drop-in replacements.

## Stage 2 — landed in this PR

`DeviceInfoPlusProbe` (this PR) raises the fidelity of two signals:

- **Emulator detection** — uses `device_info_plus` + fingerprint fallbacks.
  Catches every default Android Studio AVD + iOS Simulator variant.
- **Developer-mode / USB-debug detection** — surfaces a MethodChannel
  (`vhhealth/device_trust_developer_mode`) the host app implements to read
  `Settings.Global.ADB_ENABLED` on Android. iOS has no equivalent — returns
  false by design.

Install at app startup:

```dart
DeviceTrust.installProbe(DeviceInfoPlusProbe());
```

Host-app MethodChannel wiring (Kotlin, in `MainActivity`):

```kotlin
MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "vhhealth/device_trust_developer_mode")
  .setMethodCallHandler { call, result ->
    if (call.method == "isDeveloperModeEnabled") {
      val enabled = Settings.Global.getInt(
        contentResolver, Settings.Global.ADB_ENABLED, 0
      ) == 1
      result.success(enabled)
    } else result.notImplemented()
  }
```

Nothing to wire on iOS — the method channel is Android-only.

## Stage 3 — not started

### Android: Play Integrity API

Replaces `DeviceIntegrityService` (currently a stub that always returns
`ok: true`) with Google's official hardware-backed attestation.

1. Add native dependency: `com.google.android.play:integrity:1.4.0+`.
2. Request a nonce from the backend, pass to
   `IntegrityManager.requestIntegrityToken(nonce)`.
3. Forward the returned JWS to the backend.
4. Backend verifies the JWS signature against Google's public keys and
   inspects the `deviceIntegrity.deviceRecognitionVerdict` claims. Fail any
   token where the device isn't `MEETS_DEVICE_INTEGRITY` or better.
5. Surface the verdict as a `-50` signal in `DeviceTrust.check` (same slot
   `jailbroken_or_rooted` uses today).

Off-the-shelf option: `play_integrity_flutter` package — reduces native code
but adds supply-chain risk. Prefer a thin custom MethodChannel.

### iOS: DeviceCheck + AppAttest

Apple's equivalent of Play Integrity. Two tiers:

- **DeviceCheck** — 2 bits of per-device storage, useful for "has this device
  seen fraud before" flags. Low signal for day-to-day trust scoring.
- **AppAttest** (iOS 14+) — hardware-attested key pair. Server challenges the
  client, client signs, server verifies against Apple's attestation CA. This
  is the production path.

Implementation steps mirror the Android flow: request challenge →
`AppAttest.attestKey()` → forward attestation object → backend verifies →
signal lands in `DeviceTrust.check`.

### Runtime debugger detection

`kDebugMode` only catches debug-mode builds. Release-mode attachments (ptrace
on Android, sysctl on iOS) need a native hook. Implement via MethodChannel
returning a boolean:

- **Android**: check `/proc/self/status`, `TracerPid` field
- **iOS**: `sysctl` with `CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()`,
  inspect `kp_proc.p_flag & P_TRACED`

Neither is bulletproof — attackers with root can patch both — but raises the
bar from "read kDebugMode at compile time" to "patch the binary and re-sign".

## Stage 4 — observability

- Log every `DeviceTrustResult` with its signals map (but not raw
  identifiers) to the backend on auth events (login, sensitive action).
- Weekly dashboard: trend of average trust score per cohort; alert on drops.
- Redacted Sentry extras: signals map, not the verdict summary.

## Out of scope

- Biometric attestation (Face ID / fingerprint) — different security model,
  already handled via `BiometricAuthService`.
- Certificate pinning — separate concern, lives in `ApiClient`.
- App tamper detection (resource hash + signature check on startup) — Stage 5
  if attacker sophistication ever warrants it.
