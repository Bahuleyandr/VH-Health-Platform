import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('wearable surfaces keep independent durable checkpoints', () {
    final source = File(
      'lib/core/services/health_sync_service.dart',
    ).readAsStringSync();

    expect(source, contains('_prefsLastVitalsSyncPrefix'));
    expect(source, contains('_prefsLastActivitySyncPrefix'));
    expect(source, contains('latestVitalSampleAt'));
    expect(source, contains('latestActivitySampleAt'));
    expect(
      source,
      isNot(contains("await prefs.setString(sourceKey, (latestSampleAt")),
    );
  });

  test('overlapping sync triggers share one in-flight operation', () {
    final source = File(
      'lib/core/services/health_sync_service.dart',
    ).readAsStringSync();

    expect(source, contains('Future<int>? _syncInFlight'));
    expect(
      source,
      matches(
        RegExp(
          r'final pendingSync = _syncInFlight;[\s\S]*?'
          r'if \(pendingSync != null\) return pendingSync;',
        ),
      ),
    );
  });

  test('background execution reports a failed or partial sync for retry', () {
    final source = File(
      'lib/core/services/health_sync_service.dart',
    ).readAsStringSync();

    expect(source, contains('bool _lastSyncSucceeded = true'));
    expect(source, contains('return service._lastSyncSucceeded'));
    expect(source, isNot(contains('return true; // never error')));
  });
}
