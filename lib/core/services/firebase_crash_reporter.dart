import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';

/// Firebase Crashlytics-backed [CrashReporter]. Call [CrashReporter.install]
/// with an instance of this in `main.dart` after `Firebase.initializeApp`.
///
/// PII policy: never pass a patient phone or full name into `extra`,
/// `context`, or `setUserId`. Hash/truncate upstream. The core
/// [CrashReporter] docstring spells this out; this adapter does not try to
/// scrub — it's the caller's contract.
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
    } catch (_) {
      // Reporting errors must never crash the app.
    }
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
