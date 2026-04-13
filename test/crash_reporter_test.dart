import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';

class _FakeCrashReporter implements CrashReporter {
  final List<(Object, StackTrace?, String?, bool)> errors = [];
  final List<String> logs = [];
  final List<String?> userIds = [];
  final Map<String, Object> customKeys = {};

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    errors.add((error, stack, context, fatal));
  }

  @override
  Future<void> log(String message) async {
    logs.add(message);
  }

  @override
  Future<void> setUserId(String? userId) async {
    userIds.add(userId);
  }

  @override
  Future<void> setCustomKey(String key, Object value) async {
    customKeys[key] = value;
  }
}

void main() {
  tearDown(CrashReporter.reset);

  group('CrashReporter', () {
    test('default instance is a silent no-op', () async {
      // Should not throw or block; just logs in debug (not observable here).
      await CrashReporter.instance
          .recordError(Exception('boom'), StackTrace.current);
      await CrashReporter.instance.log('hi');
      await CrashReporter.instance.setUserId('abc');
      await CrashReporter.instance.setCustomKey('screen', 'login');
    });

    test('install() replaces the active reporter', () async {
      final fake = _FakeCrashReporter();
      CrashReporter.install(fake);

      await CrashReporter.instance.recordError(
        StateError('oops'),
        StackTrace.current,
        context: 'test',
      );
      expect(fake.errors, hasLength(1));
      expect(fake.errors.first.$1, isA<StateError>());
      expect(fake.errors.first.$3, 'test');
      expect(fake.errors.first.$4, isFalse);
    });

    test('log / setUserId / setCustomKey flow through', () async {
      final fake = _FakeCrashReporter();
      CrashReporter.install(fake);

      await CrashReporter.instance.log('navigated to /vitals');
      await CrashReporter.instance.setUserId('user-123');
      await CrashReporter.instance.setUserId(null);
      await CrashReporter.instance.setCustomKey('role', 'nurse');

      expect(fake.logs, ['navigated to /vitals']);
      expect(fake.userIds, ['user-123', null]);
      expect(fake.customKeys, {'role': 'nurse'});
    });

    test('reset() restores the no-op default', () async {
      final fake = _FakeCrashReporter();
      CrashReporter.install(fake);
      CrashReporter.reset();

      // Subsequent calls should NOT reach the fake.
      await CrashReporter.instance.recordError(Exception('x'), null);
      expect(fake.errors, isEmpty);
    });

    test('fatal flag is preserved', () async {
      final fake = _FakeCrashReporter();
      CrashReporter.install(fake);

      await CrashReporter.instance.recordError(
        Exception('fatal'),
        null,
        fatal: true,
      );
      expect(fake.errors.first.$4, isTrue);
    });
  });
}
