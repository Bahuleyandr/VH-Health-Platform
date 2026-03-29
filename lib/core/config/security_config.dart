// lib/core/config/security_config.dart

/// Security configuration for the VHHealth Patient App.
///
/// Controls certificate pinning behaviour and stores the pinned
/// certificate fingerprints used to verify the backend TLS certificate.
class SecurityConfig {
  SecurityConfig._();

  // ── Environment detection ──────────────────────────────────────────────────

  /// `true` when the app was compiled with `--dart-define=PRODUCTION=true`.
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

  /// SHA-256 fingerprints of the **Subject Public Key Info (SPKI)** for the
  /// backend TLS certificate chain.
  ///
  /// ### How to obtain the fingerprint
  /// Run the following command against the production API host:
  /// ```bash
  /// openssl s_client -connect api.vhhealth.app:443 </dev/null 2>/dev/null \
  ///   | openssl x509 -pubkey -noout \
  ///   | openssl pkey -pubin -outform DER \
  ///   | openssl dgst -sha256
  /// ```
  /// The output looks like:
  /// ```
  /// SHA2-256(stdin)= a1b2c3d4e5f6...
  /// ```
  /// Copy the hex string (without the prefix) and add it to this list.
  ///
  /// ### Certificate rotation
  /// When the backend certificate is renewed:
  /// 1. **Before** the old certificate expires, obtain the fingerprint of the
  ///    **new** certificate and add it to this list (keep the old one too).
  /// 2. Ship an app update so that clients accept both old and new certs.
  /// 3. Once the old certificate has expired and all users have updated,
  ///    remove the old fingerprint from this list.
  ///
  /// Keeping two fingerprints during the overlap window prevents users on
  /// older app versions from being locked out.
  static const List<String> pinnedCertFingerprints = [
    // TODO: Replace with real SHA-256 fingerprint(s) before production release.
    // Example:
    // 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  ];
}
