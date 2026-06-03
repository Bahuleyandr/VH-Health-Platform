import 'package:vhhealth_core/services/crash_reporter.dart';

class CompositeCrashReporter implements CrashReporter {
  const CompositeCrashReporter(this._reporters);

  final List<CrashReporter> _reporters;

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    for (final reporter in _reporters) {
      try {
        await reporter.recordError(
          error,
          stack,
          context: context,
          extra: extra,
          fatal: fatal,
        );
      } catch (_) {}
    }
  }

  @override
  Future<void> log(String message) async {
    for (final reporter in _reporters) {
      try {
        await reporter.log(message);
      } catch (_) {}
    }
  }

  @override
  Future<void> setUserId(String? userId) async {
    for (final reporter in _reporters) {
      try {
        await reporter.setUserId(userId);
      } catch (_) {}
    }
  }

  @override
  Future<void> setCustomKey(String key, Object value) async {
    for (final reporter in _reporters) {
      try {
        await reporter.setCustomKey(key, value);
      } catch (_) {}
    }
  }
}
