import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;
  final service = ConnectivitySyncService.instance;

  setUp(() async {
    harness = OfflineQueueTestHarness('connectivity_sync_c0a');
    await harness.setUp();
    await service.resetForTesting();
    await AuthService.setStaffId('staff-1');
    await AuthService.setJwt('test-jwt');
  });

  tearDown(() async {
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.resetClientForTesting();
    await service.resetForTesting();
    await harness.tearDown();
  });

  test(
    'generic service enqueue independently rejects contained and unknown',
    () async {
      for (final route in const [
        ('POST', '/prescriptions/create'),
        ('POST', '/emr/orders'),
        ('POST', '/clinical/mar/1/administer-with-scan'),
        ('POST', '/lab/samples/1/collect'),
        ('POST', '/blood-bank/1/verify-bedside'),
        ('POST', '/emr/notes'),
        ('PATCH', '/future/action'),
      ]) {
        await expectLater(
          service.enqueue(
            endpoint: route.$2,
            method: route.$1,
            body: const {'clinical': true},
          ),
          throwsA(isA<OfflineWriteRejected>()),
        );
      }
      expect(await OfflineQueue.debugAllRows(), isEmpty);
    },
  );

  test('mock 200 transport receives zero contained-family requests', () async {
    harness.installFixedEncryptionKey();
    final encrypted = await harness.encryptV1('{"clinical":true}');
    const routes = [
      '/prescriptions/create',
      '/emr/orders',
      '/clinical/mar/1/administer-with-scan',
      '/lab/samples/1/collect',
      '/blood-bank/1/verify-bedside',
      '/emr/notes',
    ];
    await harness.createV5Fixture([
      for (var index = 0; index < routes.length; index++)
        {
          'id': index + 1,
          'endpoint': routes[index],
          'method': 'POST',
          'body': encrypted,
          'created_at': index + 1,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'contained-$index',
          'staff_id': 'staff-1',
          'tenant_id': TenantConfig.id,
          'encryption_version': 1,
          'reconciliation_owner_id': 'staff-1',
        },
    ]);
    var requestCount = 0;
    VHHttpClient.setClientForTesting(
      MockClient((_) async {
        requestCount++;
        return http.Response('{"data":{}}', 200);
      }),
    );

    await service.syncPending();

    expect(requestCount, 0);
    final rows = await OfflineQueue.debugAllRows();
    expect(rows, hasLength(6));
    expect(rows.map((row) => row['status']), everyElement('needs_review'));
  });

  test('service retry and discard retain queue authorization checks', () async {
    final vitalsId = await service.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 70},
    );
    await OfflineQueue.markConflict(vitalsId, 'server newer');
    expect(
      await service.discardConflict(vitalsId, reconciliationConfirmed: false),
      isFalse,
    );
    expect(
      await service.discardConflict(vitalsId, reconciliationConfirmed: true),
      isTrue,
    );

    final draftId = await service.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'text': 'retry'},
    );
    await OfflineQueue.markConflict(draftId, 'server newer');
    VHHttpClient.setClientForTesting(
      MockClient((_) async => http.Response('{"message":"later"}', 429)),
    );
    expect(await service.retryConflict(draftId), isTrue);
    final row = (await OfflineQueue.debugAllRows()).single;
    expect(row['id'], draftId);
    expect(row['status'], 'pending');
    expect(row['retry_count'], 1);
  });

  test(
    'attested review row remains undrainable, unretryable, undeletable',
    () async {
      final id = await service.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 70},
      );
      final db = await OfflineQueue.database;
      await db.update(
        'pending_writes',
        {
          'status': 'needs_review',
          'review_reason_code': 'retry_exhausted',
          'retry_count': 6,
        },
        where: 'id = ?',
        whereArgs: [id],
      );
      expect(
        await service.attestHandoff(id, actorUid: 'staff-user-uid'),
        isTrue,
      );
      var requests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((_) async {
          requests++;
          return http.Response('{"data":{}}', 200);
        }),
      );

      await service.syncPending();

      expect(requests, 0);
      expect(await service.retryConflict(id), isFalse);
      expect(
        await service.discardConflict(id, reconciliationConfirmed: true),
        isFalse,
      );
      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['id'], id);
      expect(row['status'], 'needs_review');
      expect(row['handoff_attested_by'], 'staff-user-uid');
    },
  );

  test('persisted conflict blocks only its safe drain partition', () async {
    final blockerId = await service.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 70},
    );
    await OfflineQueue.markConflict(blockerId, 'server newer');
    final skippedId = await service.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 71},
    );
    final draftId = await service.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'text': 'independent draft'},
    );
    final paths = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        paths.add(request.url.path);
        return http.Response('{"data":{}}', 200);
      }),
    );

    await service.syncPending();

    expect(paths, ['/api/v1/emr/notes/draft']);
    final rows = await OfflineQueue.debugAllRows();
    expect(rows.map((row) => row['id']), containsAll([blockerId, skippedId]));
    expect(rows.map((row) => row['id']), isNot(contains(draftId)));
  });

  test('transient failure blocks its partition for one pass only', () async {
    final firstVitals = await service.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 70},
    );
    final laterVitals = await service.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 71},
    );
    final draft = await service.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'text': 'independent'},
    );
    final paths = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        paths.add(request.url.path);
        if (request.url.path.endsWith('/health/records')) {
          return http.Response('{"message":"later"}', 429);
        }
        return http.Response('{"data":{}}', 200);
      }),
    );

    await service.syncPending();

    expect(paths, ['/api/v1/health/records', '/api/v1/emr/notes/draft']);
    final rows = await OfflineQueue.debugAllRows();
    expect(
      rows.singleWhere((row) => row['id'] == firstVitals)['retry_count'],
      1,
    );
    expect(
      rows.singleWhere((row) => row['id'] == laterVitals)['retry_count'],
      0,
    );
    expect(rows.map((row) => row['id']), isNot(contains(draft)));
  });

  test('retry 5 to 6 becomes review and preloaded six sends no HTTP', () async {
    final fiveId = await service.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 70},
    );
    final sixId = await service.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'text': 'exhausted'},
    );
    final db = await OfflineQueue.database;
    await db.update(
      'pending_writes',
      {'retry_count': 5},
      where: 'id = ?',
      whereArgs: [fiveId],
    );
    await db.update(
      'pending_writes',
      {'retry_count': 6},
      where: 'id = ?',
      whereArgs: [sixId],
    );
    final paths = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        paths.add(request.url.path);
        return http.Response('{"message":"later"}', 429);
      }),
    );

    await service.syncPending();

    expect(paths, ['/api/v1/health/records']);
    final rows = await OfflineQueue.debugAllRows();
    final five = rows.singleWhere((row) => row['id'] == fiveId);
    final six = rows.singleWhere((row) => row['id'] == sixId);
    expect(five['retry_count'], 6);
    expect(five['status'], 'needs_review');
    expect(five['review_reason_code'], 'retry_exhausted');
    expect(six['retry_count'], 6);
    expect(six['status'], 'needs_review');
  });

  test(
    'persistent 401 stops whole pass without clinical retry consumption',
    () async {
      final vitalsId = await service.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 70},
      );
      final draftId = await service.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {'text': 'must not send'},
      );
      final paths = <String>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          paths.add(request.url.path);
          return http.Response('{"message":"expired"}', 401);
        }),
      );

      await service.syncPending();

      expect(paths.first, '/api/v1/health/records');
      expect(paths, contains('/api/v1/auth/refresh-token'));
      expect(paths, isNot(contains('/api/v1/emr/notes/draft')));
      final rows = await OfflineQueue.debugAllRows();
      expect(
        rows.singleWhere((row) => row['id'] == vitalsId)['retry_count'],
        0,
      );
      expect(rows.singleWhere((row) => row['id'] == draftId)['retry_count'], 0);
    },
  );

  test('owner change during HTTP stops pass without consuming retry', () async {
    final firstId = await service.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 70},
    );
    await service.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'text': 'must not send'},
    );
    final paths = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        paths.add(request.url.path);
        await AuthService.setStaffId('staff-2');
        return http.Response('{"message":"later"}', 429);
      }),
    );

    await service.syncPending();

    expect(paths, ['/api/v1/health/records']);
    final rows = await OfflineQueue.debugAllRows();
    expect(rows.singleWhere((row) => row['id'] == firstId)['retry_count'], 0);
  });

  test(
    'session barrier blocks enqueue and drain until explicitly released',
    () async {
      final id = await service.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 70},
      );
      var requests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((_) async {
          requests++;
          return http.Response('{"data":{}}', 200);
        }),
      );

      await service.beginSessionBarrier();
      expect(service.isSessionBarrierActive, isTrue);
      await expectLater(
        service.enqueue(
          endpoint: '/emr/notes/draft',
          method: 'PUT',
          body: const {'text': 'blocked'},
        ),
        throwsA(isA<OfflineSessionBarrierActive>()),
      );
      await service.syncPending();
      expect(requests, 0);
      expect(
        (await OfflineQueue.debugAllRows()).map((row) => row['id']),
        contains(id),
      );

      service.endSessionBarrier();
      service.endSessionBarrier();
      expect(service.isSessionBarrierActive, isFalse);
      await service.syncPending();
      expect(requests, 1);
      expect(await OfflineQueue.debugAllRows(), isEmpty);
    },
  );

  test(
    'session barrier waits for a race-time enqueue before owner recheck',
    () async {
      harness.blockSecureStorageRead('staffId');
      final enqueue = service.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 70},
      );
      await Future<void>.delayed(Duration.zero);

      var barrierFinished = false;
      final barrier = service.beginSessionBarrier().then((_) {
        barrierFinished = true;
      });
      await Future<void>.delayed(Duration.zero);
      expect(service.isSessionBarrierActive, isTrue);
      expect(barrierFinished, isFalse);

      harness.releaseSecureStorageRead();
      await enqueue;
      await barrier;

      expect(barrierFinished, isTrue);
      expect(await service.blockingWriteCountForCurrentOwner(), 1);
      service.endSessionBarrier();
    },
  );

  test('unknown tenant/version rows send zero HTTP and retain bytes', () async {
    harness.installFixedEncryptionKey();
    final encrypted = await harness.encryptV1(jsonEncode({'pulse': 70}));
    await harness.createV5Fixture([
      {
        'id': 1,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': encrypted,
        'created_at': 1,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'bad-tenant',
        'staff_id': 'staff-1',
        'tenant_id': 'wrong-tenant',
        'encryption_version': 1,
        'reconciliation_owner_id': 'staff-1',
      },
      {
        'id': 2,
        'endpoint': '/emr/notes/draft',
        'method': 'PUT',
        'body': encrypted,
        'created_at': 2,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'bad-version',
        'staff_id': 'staff-1',
        'tenant_id': TenantConfig.id,
        'encryption_version': 99,
        'reconciliation_owner_id': 'staff-1',
      },
    ]);
    var requests = 0;
    VHHttpClient.setClientForTesting(
      MockClient((_) async {
        requests++;
        return http.Response('{"data":{}}', 200);
      }),
    );

    await service.syncPending();

    expect(requests, 0);
    final rows = await OfflineQueue.debugAllRows();
    expect(rows, hasLength(2));
    expect(rows[0]['body'], encrypted);
    expect(rows[1]['body'], encrypted);
    expect(rows.map((row) => row['status']), everyElement('needs_review'));
  });

  test(
    'unknown owner/action/method rows send zero HTTP and remain retained',
    () async {
      harness.installFixedEncryptionKey();
      final encrypted = await harness.encryptV1('{"clinical":true}');
      await harness.createV5Fixture([
        {
          'id': 11,
          'endpoint': '/health/records',
          'method': 'POST',
          'body': encrypted,
          'created_at': 11,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'unknown-owner',
          'staff_id': null,
          'tenant_id': TenantConfig.id,
          'encryption_version': 1,
          'reconciliation_owner_id': OfflineQueue.fallbackReconciliationRole,
        },
        {
          'id': 12,
          'endpoint': '/future/clinical-action',
          'method': 'POST',
          'body': encrypted,
          'created_at': 12,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'unknown-action',
          'staff_id': 'staff-1',
          'tenant_id': TenantConfig.id,
          'encryption_version': 1,
          'reconciliation_owner_id': 'staff-1',
        },
        {
          'id': 13,
          'endpoint': '/health/records',
          'method': 'DELETE',
          'body': encrypted,
          'created_at': 13,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'unknown-method',
          'staff_id': 'staff-1',
          'tenant_id': TenantConfig.id,
          'encryption_version': 1,
          'reconciliation_owner_id': 'staff-1',
        },
      ]);
      var requests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((_) async {
          requests++;
          return http.Response('{"data":{}}', 200);
        }),
      );

      await service.syncPending();

      expect(requests, 0);
      final rows = await OfflineQueue.debugAllRows();
      expect(rows, hasLength(3));
      expect(rows.map((row) => row['body']), everyElement(encrypted));
      expect(rows.map((row) => row['status']), everyElement('needs_review'));
      expect(rows[0]['review_reason_code'], 'unknown_owner');
      expect(rows[1]['review_reason_code'], 'unknown_action');
      expect(rows[2]['review_reason_code'], 'unknown_action');
    },
  );

  test(
    'missing encryption key sends zero HTTP and preserves ciphertext bytes',
    () async {
      harness.installFixedEncryptionKey();
      final encrypted = await harness.encryptV1('{"pulse":70}');
      harness.removeEncryptionKey();
      await harness.createV5Fixture([
        {
          'id': 14,
          'endpoint': '/health/records',
          'method': 'POST',
          'body': encrypted,
          'created_at': 14,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'missing-key',
          'staff_id': 'staff-1',
          'tenant_id': TenantConfig.id,
          'encryption_version': 1,
          'reconciliation_owner_id': 'staff-1',
        },
      ]);
      var requests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((_) async {
          requests++;
          return http.Response('{"data":{}}', 200);
        }),
      );

      await service.syncPending();

      expect(requests, 0);
      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['body'], encrypted);
      expect(row['encryption_version'], isNull);
      expect(row['status'], 'needs_review');
      expect(row['review_reason_code'], 'unknown_encryption_version');
      expect(harness.storedEncryptionKey, isNull);
    },
  );
}
