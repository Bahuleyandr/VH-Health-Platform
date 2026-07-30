import 'security_config.dart';

/// Build-time contract for the authenticated client-readiness probe.
class ClientReadinessConfig {
  ClientReadinessConfig._();

  static const String path = '/health/client-readiness';
  static const String endpointId = 'vhhealth-api';
  static const int contractVersion = 1;
  static const int policySchemaVersion = 1;
  static const int ownerApprovedMaxClockSkewSeconds = 300;

  static const String _rawMaxClockSkewSeconds = String.fromEnvironment(
    'CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS',
    defaultValue: '',
  );

  static int? parseMaxClockSkewSeconds(String raw) {
    final seconds = int.tryParse(raw.trim());
    if (seconds == null || seconds <= 0) return null;
    return seconds;
  }

  static Duration? get maxClockSkew {
    final seconds = parseMaxClockSkewSeconds(_rawMaxClockSkewSeconds);
    return seconds == ownerApprovedMaxClockSkewSeconds
        ? Duration(seconds: seconds!)
        : null;
  }

  /// Production builds must explicitly inject the owner-approved tolerance.
  static void verifyOrThrow({
    bool production = SecurityConfig.isProduction,
    String rawValue = _rawMaxClockSkewSeconds,
  }) {
    if (!production) return;
    if (parseMaxClockSkewSeconds(rawValue) !=
        ownerApprovedMaxClockSkewSeconds) {
      throw StateError(
        'ClientReadinessConfig: production builds require the '
        'owner-approved CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS value.',
      );
    }
  }
}
