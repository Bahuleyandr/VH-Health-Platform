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
  static const List<String> pinnedCertFingerprints = [
    // TODO: Replace with real SHA-256 fingerprint(s) before production release.
    // Example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  ];
}
