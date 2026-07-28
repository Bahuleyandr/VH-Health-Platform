import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;

  setUp(() async {
    harness = OfflineQueueTestHarness('offline_queue_drain_order');
    await harness.setUp();
    await AuthService.setStaffId('staff-1');
  });

  tearDown(() => harness.tearDown());

  test('drain order carries deterministic id tiebreak', () {
    expect(OfflineQueue.pendingDrainOrderBy, 'created_at ASC, id ASC');
  });

  test('same-created_at controls return in ascending id order', () async {
    harness.installFixedEncryptionKey();
    final draft = await harness.encryptV1('{"text":"draft"}');
    final vitals = await harness.encryptV1('{"pulse":70}');
    await harness.createV5Fixture([
      {
        'id': 30,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': vitals,
        'created_at': 1751000000000,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'k30',
        'staff_id': 'staff-1',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
        'reconciliation_owner_id': 'staff-1',
      },
      {
        'id': 10,
        'endpoint': '/emr/notes/draft',
        'method': 'PUT',
        'body': draft,
        'created_at': 1751000000000,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'k10',
        'staff_id': 'staff-1',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
        'reconciliation_owner_id': 'staff-1',
      },
    ]);

    expect((await OfflineQueue.getPending()).map((row) => row['id']), [10, 30]);
  });

  test('created_at remains primary across milliseconds', () async {
    final newer = await OfflineQueue.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 80},
    );
    final older = await OfflineQueue.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'text': 'draft'},
    );
    final db = await OfflineQueue.database;
    await db.update(
      'pending_writes',
      {'created_at': 2000},
      where: 'id = ?',
      whereArgs: [newer],
    );
    await db.update(
      'pending_writes',
      {'created_at': 1000},
      where: 'id = ?',
      whereArgs: [older],
    );

    expect((await OfflineQueue.getPending()).map((row) => row['id']), [
      older,
      newer,
    ]);
  });

  test('enqueue round-trips controls in insert order', () async {
    final first = await OfflineQueue.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'text': 'partial'},
    );
    final second = await OfflineQueue.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 72},
    );
    expect((await OfflineQueue.getPending()).map((row) => row['id']), [
      first,
      second,
    ]);
  });
}
