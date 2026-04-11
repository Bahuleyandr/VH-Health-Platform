// lib/config/security_config.dart

/// Security configuration shared by all VHHealth apps.
///
/// Controls certificate pinning behaviour and stores the pinned
/// certificate fingerprints used to verify the backend TLS certificate.
class SecurityConfig {
  SecurityConfig._();

  // ── Environment detection ──────────────────────────────────────────────────

  /// `true` when the app was compiled with `--dart-define=PRODUCTION=true`.
  ///
  /// Flutter's debug/profile/release mode flags are unreliable for this
  /// purpose because `kReleaseMode` is true for *any* release build
  /// (including internal test builds). Using a compile-time define gives
  /// explicit control.
  static const bool isProduction = bool.fromEnvironment(
    'PRODUCTION',
    defaultValue: false,
  );

  // ── Certificate pinning ────────────────────────────────────────────────────

  /// Whether TLS certificate pinning is active.
  ///
  /// Enabled only in production builds so that local development against
  /// `localhost` or staging servers with self-signed certificates is not
  /// blocked.
  static const bool enableCertPinning = isProduction;

  /// SHA-256 fingerprints of the backend TLS certificate chain.
  ///
  /// ### How to obtain the fingerprint
  /// ```bash
  /// openssl s_client -connect api.vhhealth.app:443 </dev/null 2>/dev/null \
  ///   | openssl x509 -pubkey -noout \
  ///   | openssl pkey -pubin -outform DER \
  ///   | openssl dgst -sha256
  /// ```
  ///
  /// ### Certificate rotation
  /// 1. Obtain the SHA-256 SPKI hash of the **new** certificate.
  /// 2. Add it alongside the old hash — clients will accept both during overlap.
  /// 3. Ship an app update. Deploy new cert on server.
  /// 4. After all users have updated, remove the old hash.
  /// **PRODUCTION BLOCKER**: Populate before release.
  ///
  /// Run the following to obtain the SHA-256 SPKI fingerprint:
  /// ```bash
  /// openssl s_client -connect api.vhhealth.app:443 </dev/null 2>/dev/null \
  ///   | openssl x509 -pubkey -noout \
  ///   | openssl pkey -pubin -outform DER \
  ///   | openssl dgst -sha256
  /// ```
  /// Add both the current and next (backup) certificate fingerprints for
  /// seamless rotation.
  static const List<String> pinnedCertFingerprints = [
    // ⚠️  PRODUCTION BLOCKER — populate before any release build.
    //
    // How to obtain fingerprints:
    //   openssl s_client -connect api.vhhealth.app:443 </dev/null 2>/dev/null \
    //     | openssl x509 -pubkey -noout \
    //     | openssl pkey -pubin -outform DER \
    //     | openssl dgst -sha256
    //
    // Add at least 2 hashes (current cert + backup/next CA) for safe rotation.
    // Example (replace with real values):
    //   'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    //   'sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
  ];

  /// Call at app startup to verify security configuration is sane.
  ///
  /// In production builds, **throws** [StateError] if certificate pinning
  /// is enabled but no fingerprints are configured — this intentionally
  /// blocks launch until the team populates [pinnedCertFingerprints].
  ///
  /// In non-production builds, logs a warning and continues.
  static void verifyOrWarn() {
    if (enableCertPinning && pinnedCertFingerprints.isEmpty) {
      const msg =
          'SecurityConfig: Certificate pinning is enabled but '
          'pinnedCertFingerprints is empty. '
          'Populate the list before shipping a production build.';

      if (isProduction) {
        throw StateError(msg);
      }

      // ignore: avoid_print
      print('WARNING: $msg Pinning will be skipped in this build.');
    }
  }
}
