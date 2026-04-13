import 'package:flutter/foundation.dart';

/// Abstraction over a crash / non-fatal error reporter.
///
/// Core and consuming apps (patient, staff) both report through this
/// interface. The default is a silent no-op; apps that use Firebase
/// Crashlytics install [FirebaseCrashReporter] at startup (see
/// `firebase_crash_reporter.dart` inside each app, or a future
/// `vhhealth_core_firebase` companion package).
///
/// Usage:
/// ```dart
/// // In main.dart, after Firebase.initializeApp():
/// CrashReporter.install(FirebaseCrashReporter());
///
/// // Then anywhere in app or core:
/// CrashReporter.instance.recordError(e, stack, context: 'vitals upload');
/// ```
abstract class CrashReporter {
  static CrashReporter _instance = _NoopCrashReporter();

  /// The currently installed reporter. Defaults to a silent no-op until
  /// [install] is called at app startup.
  static CrashReporter get instance => _instance;

  /// Replace the active reporter. Call once at startup from `main.dart`
  /// before any error-prone work.
  static void install(CrashReporter reporter) {
    _instance = reporter;
    if (kDebugMode) {
      debugPrint('CrashReporter: installed ${reporter.runtimeType}');
    }
  }

  /// Restore the no-op reporter. Useful in tests.
  @visibleForTesting
  static void reset() {
    _instance = _NoopCrashReporter();
  }

  /// Record a non-fatal error with optional stack trace + context.
  /// Implementations should be safe to call from any isolate and should
  /// never throw — reporting a crash must not cause a crash.
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  });

  /// Record a free-form log line that will be attached to the next crash.
  /// Implementations may buffer these.
  Future<void> log(String message);

  /// Associate a user identifier with subsequent reports. Pass `null`
  /// to clear on logout. Implementations MUST strip or hash PII —
  /// phone numbers, emails, medical record numbers must not reach the
  /// reporting backend.
  Future<void> setUserId(String? userId);

  /// Attach a custom key/value that travels with every subsequent report.
  /// Use for non-PII context such as build flavour, role, screen name.
  Future<void> setCustomKey(String key, Object value);
}

/// Default implementation that swallows everything. Installed until the
/// app wires up a real reporter.
class _NoopCrashReporter implements CrashReporter {
  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    if (kDebugMode) {
      debugPrint('CrashReporter (noop): $error');
      if (context != null) debugPrint('  context: $context');
      if (stack != null) debugPrint(stack.toString());
    }
  }

  @override
  Future<void> log(String message) async {
    if (kDebugMode) debugPrint('CrashReporter (noop) log: $message');
  }

  @override
  Future<void> setUserId(String? userId) async {}

  @override
  Future<void> setCustomKey(String key, Object value) async {}
}
