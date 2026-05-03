import 'package:flutter/foundation.dart';

/// Lightweight, pluggable telemetry abstraction.
///
/// Records named events with arbitrary string-keyed props. Default
/// implementation is a no-op debug logger; production should
/// `Telemetry.install(...)` a real backend at startup (Firebase
/// Analytics, PostHog, Mixpanel — anything that satisfies the
/// [TelemetrySink] interface). Keeping the abstraction in the staff
/// app rather than `vhhealth_core` since the patient and admin apps
/// will likely want different sinks (parent-of-PHI separation).
///
/// PII policy: callers MUST NOT pass patient phone numbers, names, or
/// uids in event properties. Use IDs and codes only. The sink itself
/// does not scrub.
///
/// Usage:
/// ```
/// Telemetry.event('bed.notes_saved', {
///   'role': 'NURSING_STAFF',
///   'has_patient': 'true',
/// });
/// ```
abstract class TelemetrySink {
  Future<void> event(String name, Map<String, String> props);
  Future<void> screenView(String screenName, {Map<String, String>? props});
  Future<void> setUserProperties({String? role, String? employeeIdHash});
}

/// Default sink — logs to debugPrint in debug builds, no-ops in release.
class _DebugTelemetrySink implements TelemetrySink {
  const _DebugTelemetrySink();

  @override
  Future<void> event(String name, Map<String, String> props) async {
    if (kDebugMode) {
      debugPrint('[telemetry] event: $name $props');
    }
  }

  @override
  Future<void> screenView(
    String screenName, {
    Map<String, String>? props,
  }) async {
    if (kDebugMode) {
      debugPrint('[telemetry] screen: $screenName ${props ?? ''}');
    }
  }

  @override
  Future<void> setUserProperties({String? role, String? employeeIdHash}) async {
    if (kDebugMode) {
      debugPrint(
        '[telemetry] user_properties: role=$role employeeIdHash=$employeeIdHash',
      );
    }
  }
}

class Telemetry {
  Telemetry._();

  static TelemetrySink _sink = const _DebugTelemetrySink();

  /// Swap in a real backend at startup. Call once from main.dart after
  /// Firebase / Sentry / etc. are ready.
  static void install(TelemetrySink sink) {
    _sink = sink;
  }

  /// Reset to the no-op debug sink (handy for tests).
  static void reset() {
    _sink = const _DebugTelemetrySink();
  }

  /// Record a named event. Best-effort — swallows backend errors so a
  /// flaky analytics endpoint never crashes the app.
  static Future<void> event(String name, [Map<String, String>? props]) async {
    try {
      await _sink.event(name, props ?? const {});
    } catch (e) {
      if (kDebugMode) debugPrint('Telemetry.event failed: $e');
    }
  }

  /// Record a screen view. Hook into route changes (GoRouter observer)
  /// or screen `initState` to fire once per mount.
  static Future<void> screenView(
    String screenName, {
    Map<String, String>? props,
  }) async {
    try {
      await _sink.screenView(screenName, props: props);
    } catch (e) {
      if (kDebugMode) debugPrint('Telemetry.screenView failed: $e');
    }
  }

  /// Set sticky user properties (role, hashed employee id) so events
  /// can be sliced by clinician cohort. Never pass raw PII.
  static Future<void> setUserProperties({
    String? role,
    String? employeeIdHash,
  }) async {
    try {
      await _sink.setUserProperties(role: role, employeeIdHash: employeeIdHash);
    } catch (e) {
      if (kDebugMode) debugPrint('Telemetry.setUserProperties failed: $e');
    }
  }
}
