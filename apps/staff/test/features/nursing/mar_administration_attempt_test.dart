import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/idempotency_attempt_registry.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_scan_screen.dart';

void main() {
  const payload = <String, dynamic>{
    'scanned_patient_uid': '11111111-1111-4111-8111-111111111111',
    'scanned_barcode': 'BATCH-42',
    'supply_quantity': 1.5,
  };

  test('lost response is closed by authoritative administered state', () async {
    final attempts = IdempotencyAttemptRegistry();
    final coordinator = MarAdministrationAttemptCoordinator(attempts);
    var authoritative = <String, dynamic>{'id': 42, 'status': 'scheduled'};
    final keys = <String>[];

    final result = await coordinator.submit(
      maId: 42,
      payload: payload,
      command: (key) async {
        keys.add(key);
        authoritative = {'id': 42, 'status': 'administered'};
        throw Exception('response lost after commit');
      },
      refresh: () async => authoritative,
    );

    expect(result.confirmedAdministered, isTrue);
    expect(keys, hasLength(1));
    expect(attempts.current('mar-administer-scan:42'), isNull);
  });

  test('open authoritative state keeps the same key for retry', () async {
    final attempts = IdempotencyAttemptRegistry();
    final coordinator = MarAdministrationAttemptCoordinator(attempts);
    var authoritative = <String, dynamic>{'id': 42, 'status': 'scheduled'};
    final keys = <String>[];
    var calls = 0;

    Future<Map<String, dynamic>> command(String key) async {
      keys.add(key);
      calls++;
      if (calls == 1) throw Exception('response lost before confirmation');
      authoritative = {'id': 42, 'status': 'administered'};
      return authoritative;
    }

    final first = await coordinator.submit(
      maId: 42,
      payload: payload,
      command: command,
      refresh: () async => authoritative,
    );
    final second = await coordinator.submit(
      maId: 42,
      payload: payload,
      command: command,
      refresh: () async => authoritative,
    );

    expect(first.confirmedAdministered, isFalse);
    expect(second.confirmedAdministered, isTrue);
    expect(keys, hasLength(2));
    expect(keys[1], keys[0]);
    expect(attempts.current('mar-administer-scan:42'), isNull);
  });

  test('changed exact payload starts a new protected attempt', () async {
    final attempts = IdempotencyAttemptRegistry();
    final coordinator = MarAdministrationAttemptCoordinator(attempts);
    final keys = <String>[];

    Future<Map<String, dynamic>> ambiguous(String key) async {
      keys.add(key);
      throw Exception('response lost');
    }

    await coordinator.submit(
      maId: 42,
      payload: payload,
      command: ambiguous,
      refresh: () async => {'id': 42, 'status': 'scheduled'},
    );
    await coordinator.submit(
      maId: 42,
      payload: {...payload, 'supply_quantity': 2},
      command: ambiguous,
      refresh: () async => {'id': 42, 'status': 'scheduled'},
    );

    expect(keys, hasLength(2));
    expect(keys[1], isNot(keys[0]));
    expect(attempts.current('mar-administer-scan:42'), keys[1]);
  });
}
