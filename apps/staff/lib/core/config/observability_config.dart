import 'package:flutter/foundation.dart';

class ObservabilityConfig {
  ObservabilityConfig._();

  static const _sentryDsn = String.fromEnvironment('SENTRY_DSN');
  static const _vhSentryDsn = String.fromEnvironment('VH_SENTRY_DSN');
  static const _sentryEnvironment = String.fromEnvironment(
    'SENTRY_ENVIRONMENT',
  );
  static const _vhSentryEnvironment = String.fromEnvironment(
    'VH_SENTRY_ENVIRONMENT',
  );
  static const _sentryRelease = String.fromEnvironment('SENTRY_RELEASE');
  static const _vhSentryRelease = String.fromEnvironment('VH_SENTRY_RELEASE');
  static const _disableSentry = bool.fromEnvironment('VH_DISABLE_SENTRY');
  static const _sentryTracesSampleRate = String.fromEnvironment(
    'SENTRY_TRACES_SAMPLE_RATE',
  );

  static String get sentryDsn =>
      _sentryDsn.isNotEmpty ? _sentryDsn : _vhSentryDsn;

  static String get sentryEnvironment {
    if (_sentryEnvironment.isNotEmpty) return _sentryEnvironment;
    if (_vhSentryEnvironment.isNotEmpty) return _vhSentryEnvironment;
    return kReleaseMode ? 'production' : 'development';
  }

  static String get sentryRelease =>
      _sentryRelease.isNotEmpty ? _sentryRelease : _vhSentryRelease;

  static double get sentryTracesSampleRate {
    final parsed = double.tryParse(_sentryTracesSampleRate);
    if (parsed != null && parsed >= 0 && parsed <= 1) return parsed;
    return kReleaseMode ? 0.1 : 1.0;
  }

  static bool get sentryEnabled => !_disableSentry && sentryDsn.isNotEmpty;
}
