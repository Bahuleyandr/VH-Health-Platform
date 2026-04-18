// lib/config/security_config.dart

/// Security configuration shared by all VHHealth apps.
///
/// Controls certificate pinning behaviour and stores the pinned certificate
/// fingerprints used to verify the backend TLS certificate.
///
/// ## Populating fingerprints
/// Production builds must pass both the current and next-rotation SPKI
/// SHA-256 hashes via a build-time define:
///
/// ```bash
/// flutter build apk --release \
///   --dart-define=PRODUCTION=true \
///   --dart-define=CERT_PIN_HASHES=sha256/AAA...,sha256/BBB...
/// ```
///
/// Hashes are comma-separated. Prefix each with `sha256/`.
///
/// ## Extracting a fingerprint
/// ```bash
/// openssl s_client -servername api.vhhealth.app -connect api.vhhealth.app:443 \
///   </dev/null 2>/dev/null \
///   | openssl x509 -pubkey -noout \
///   | openssl pkey -pubin -outform DER \
///   | openssl dgst -sha256 -binary \
///   | base64
/// ```
/// Prepend `sha256/` to the base64 output.
///
/// ## Rotation checklist (60 days before cert expiry)
/// 1. Obtain the SPKI hash of the **next** certificate.
/// 2. Ship an app update that pins BOTH old and new hashes.
/// 3. Wait for >95% of users to update (monitor via Crashlytics).
/// 4. Deploy the new cert on the backend.
/// 5. In a subsequent app release, remove the old hash.
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

  /// Raw comma-separated fingerprints injected at build time.
  ///
  /// Prefer the runtime-parsed [pinnedCertFingerprints] getter for use in
  /// app code.
  static const String _rawFingerprints = String.fromEnvironment(
    'CERT_PIN_HASHES',
    defaultValue: '',
  );

  /// Whether TLS certificate pinning is active.
  ///
  /// Enabled only in production builds so local development against
  /// `localhost` or staging with self-signed certificates is not blocked.
  static const bool enableCertPinning = isProduction;

  /// SHA-256 SPKI fingerprints of accepted backend TLS certificates.
  ///
  /// Parsed from the `CERT_PIN_HASHES` build-time define. Empty outside
  /// production (pinning is disabled there). In production, an empty list
  /// is treated as a configuration error — [verifyOrWarn] throws.
  static List<String> get pinnedCertFingerprints {
    if (_rawFingerprints.isEmpty) return const <String>[];
    return _rawFingerprints
        .split(',')
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList(growable: false);
  }

  /// Call at app startup to verify the security configuration is sane.
  ///
  /// In production builds, **throws** [StateError] if certificate pinning
  /// is enabled but no fingerprints are configured — this intentionally
  /// blocks launch until the build is configured with `CERT_PIN_HASHES`.
  ///
  /// In non-production builds, logs a warning and continues so developer
  /// builds keep working without the define.
  static void verifyOrWarn() {
    if (!enableCertPinning) return;

    final hashes = pinnedCertFingerprints;
    if (hashes.isEmpty) {
      const msg =
          'SecurityConfig: Certificate pinning is enabled but no hashes '
          'were provided via --dart-define=CERT_PIN_HASHES. '
          'Populate at least two (current + next) SPKI SHA-256 hashes '
          'before shipping a production build.';
      throw StateError(msg);
    }

    // Warn if only one hash — rotation requires overlap.
    if (hashes.length < 2) {
      // ignore: avoid_print
      print(
        'WARNING: SecurityConfig has only one pinned certificate fingerprint. '
        'Add a second (backup / next-rotation) hash to avoid a hard lockout '
        'when the current certificate expires.',
      );
    }

    // Basic shape validation — reject obviously malformed entries.
    for (final hash in hashes) {
      if (!hash.startsWith('sha256/') || hash.length < 20) {
        throw StateError(
          'SecurityConfig: invalid pinned fingerprint "$hash". '
          'Expected format "sha256/<base64 hash>".',
        );
      }
    }
  }
}
