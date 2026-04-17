import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';

/// Firebase Crashlytics-backed [CrashReporter]. Installed from `main.dart`
/// after `Firebase.initializeApp`. Identical contract to the patient app's
/// copy — lives per-app because the dependency on firebase_crashlytics is
/// intentionally kept out of the shared core package.
///
/// PII policy: callers must not pass patient phone or full name into
/// `extra`, `context`, or `setUserId`. This adapter does not scrub.
class FirebaseCrashReporter implements CrashReporter {
  const FirebaseCrashReporter();

  FirebaseCrashlytics get _cl => FirebaseCrashlytics.instance;

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    try {
      await _cl.recordError(
        error,
        stack,
        reason: context,
        information: [
          if (context != null) 'context: $context',
          ...extra.entries.map((e) => '${e.key}: ${e.value}'),
        ],
        fatal: fatal,
      );
    } catch (_) {}
  }

  @override
  Future<void> log(String message) async {
    try {
      await _cl.log(message);
    } catch (_) {}
  }

  @override
  Future<void> setUserId(String? userId) async {
    try {
      await _cl.setUserIdentifier(userId ?? '');
    } catch (_) {}
  }

  @override
  Future<void> setCustomKey(String key, Object value) async {
    try {
      await _cl.setCustomKey(key, value);
    } catch (_) {}
  }
}
