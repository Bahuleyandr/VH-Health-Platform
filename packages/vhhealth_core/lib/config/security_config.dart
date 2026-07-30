import 'dart:convert';

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
    return _deduplicate(_rawFingerprints);
  }

  /// The same undifferentiated flat pin set after strict shape validation.
  ///
  /// Pins intentionally have no host or route role in C2.2. Production
  /// requires at least two distinct values so current/next rotation overlap
  /// cannot be omitted accidentally.
  static List<String> get validatedPinnedCertFingerprints =>
      validatePinSet(_rawFingerprints, requireOverlap: enableCertPinning);

  static List<String> validatePinSet(
    String raw, {
    required bool requireOverlap,
  }) {
    final hashes = _deduplicate(raw);
    for (final hash in hashes) {
      if (!hash.startsWith('sha256/')) {
        throw StateError(
          'SecurityConfig: invalid pinned fingerprint. '
          'Expected format "sha256/<base64 SHA-256>".',
        );
      }
      final encoded = hash.substring('sha256/'.length);
      try {
        final decoded = base64.decode(encoded);
        if (decoded.length != 32 || base64.encode(decoded) != encoded) {
          throw const FormatException();
        }
      } on FormatException {
        throw StateError(
          'SecurityConfig: invalid pinned fingerprint. '
          'Expected a canonical base64-encoded SHA-256 value.',
        );
      }
    }
    if (requireOverlap && hashes.length < 2) {
      throw StateError(
        'SecurityConfig: production requires at least two distinct '
        'CERT_PIN_HASHES values for current/next rotation overlap.',
      );
    }
    return hashes;
  }

  static List<String> _deduplicate(String raw) {
    if (raw.trim().isEmpty) return const <String>[];
    final seen = <String>{};
    return raw
        .split(',')
        .map((value) => value.trim())
        .where((value) => value.isNotEmpty && seen.add(value))
        .toList(growable: false);
  }

  /// Call at app startup to verify the security configuration is sane.
  ///
  /// In production builds, **throws** [StateError] if certificate pinning
  /// is enabled but no fingerprints are configured — this intentionally
  /// blocks launch until the build is configured with `CERT_PIN_HASHES`.
  ///
  /// In non-production builds, returns without requiring pin configuration so
  /// developer builds keep working without the define.
  static void verifyOrWarn() {
    if (!enableCertPinning) return;

    validatePinSet(_rawFingerprints, requireOverlap: true);
  }
}
