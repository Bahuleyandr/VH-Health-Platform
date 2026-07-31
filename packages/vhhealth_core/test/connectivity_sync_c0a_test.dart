import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;
  final service = ConnectivitySyncService.instance;

  setUp(() async {
    harness = OfflineQueueTestHarness('connectivity_sync_c0a');
    await harness.setUp();
    OfflineQueue.registerMetadataResolvers(
      tenantIdResolver: () => TenantConfig.id,
      reconciliationOwnerResolver: (_) =>
          OfflineQueue.fallbackReconciliationRole,
      currentActorUidResolver: () async => harness.currentActorUid,
      currentActorRoleResolver: () async => 'doctor',
    );
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

  test('legacy retry and discard never restore transport authority', () async {
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
    expect(row['retry_count'], 0);
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
    service.setTransportAvailableForTesting(false);
    final blockerId = await _prepareQueued(
      service,
      actionId: OfflineActionIds.opNoteDraftStore,
      orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
      marker: 'blocker',
    );
    await OfflineQueue.markPreparedNeedsReview(
      rowId: blockerId,
      reasonCode: 'server_concurrency_conflict',
    );
    final skippedId = await _prepareQueued(
      service,
      actionId: OfflineActionIds.opNoteDraftStore,
      orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
      marker: 'skipped',
    );
    final draftId = await _prepareQueued(
      service,
      actionId: OfflineActionIds.nursingNoteDraftStore,
      orderingKey: 'patient-1\u0000admission-1\u0000nursing-note',
      marker: 'independent',
    );
    final actions = <String?>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        actions.add(request.headers['x-vh-continuity-action-id']);
        return http.Response('{"data":{}}', 200);
      }),
    );
    _enableDrain(service);

    await service.syncPending();

    expect(actions, [OfflineActionIds.nursingNoteDraftStore]);
    final rows = await OfflineQueue.debugAllRows();
    expect(rows.map((row) => row['id']), containsAll([blockerId, skippedId]));
    expect(
      rows.singleWhere((row) => row['id'] == draftId)['status'],
      'applied',
    );
  });

  test('transient failure blocks its partition for one pass only', () async {
    service.setTransportAvailableForTesting(false);
    final firstDraft = await _prepareQueued(
      service,
      actionId: OfflineActionIds.opNoteDraftStore,
      orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
      marker: 'first',
    );
    final laterDraft = await _prepareQueued(
      service,
      actionId: OfflineActionIds.opNoteDraftStore,
      orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
      marker: 'later',
      supersessionGeneration: 1,
    );
    final independentDraft = await _prepareQueued(
      service,
      actionId: OfflineActionIds.nursingNoteDraftStore,
      orderingKey: 'patient-1\u0000admission-1\u0000nursing-note',
      marker: 'independent',
    );
    final actions = <String?>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        final action = request.headers['x-vh-continuity-action-id'];
        actions.add(action);
        if (action == OfflineActionIds.opNoteDraftStore) {
          return http.Response('{"message":"later"}', 429);
        }
        return http.Response('{"data":{}}', 200);
      }),
    );
    _enableDrain(service);

    await service.syncPending();

    expect(actions, [
      OfflineActionIds.opNoteDraftStore,
      OfflineActionIds.nursingNoteDraftStore,
    ]);
    final rows = await OfflineQueue.debugAllRows();
    expect(
      rows.singleWhere((row) => row['id'] == firstDraft)['retry_count'],
      1,
    );
    expect(
      rows.singleWhere((row) => row['id'] == laterDraft)['retry_count'],
      0,
    );
    expect(
      rows.singleWhere((row) => row['id'] == independentDraft)['status'],
      'applied',
    );
  });

  test('retry 5 to 6 becomes review and preloaded six sends no HTTP', () async {
    service.setTransportAvailableForTesting(false);
    final fiveId = await _prepareQueued(
      service,
      actionId: OfflineActionIds.opNoteDraftStore,
      orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
      marker: 'retry-five',
    );
    final sixId = await _prepareQueued(
      service,
      actionId: OfflineActionIds.nursingNoteDraftStore,
      orderingKey: 'patient-1\u0000admission-1\u0000nursing-note',
      marker: 'retry-six',
    );
    final db = await OfflineQueue.database;
    await db.update(
      'pending_writes',
      {'attempt_count': 5, 'retry_count': 5},
      where: 'id = ?',
      whereArgs: [fiveId],
    );
    await db.update(
      'pending_writes',
      {'attempt_count': 6, 'retry_count': 6},
      where: 'id = ?',
      whereArgs: [sixId],
    );
    final actions = <String?>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        actions.add(request.headers['x-vh-continuity-action-id']);
        return http.Response('{"message":"later"}', 429);
      }),
    );
    _enableDrain(service);

    await service.syncPending();

    expect(actions, [OfflineActionIds.opNoteDraftStore]);
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
      service.setTransportAvailableForTesting(false);
      final firstId = await _prepareQueued(
        service,
        actionId: OfflineActionIds.opNoteDraftStore,
        orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
        marker: 'first',
      );
      final secondId = await _prepareQueued(
        service,
        actionId: OfflineActionIds.nursingNoteDraftStore,
        orderingKey: 'patient-1\u0000admission-1\u0000nursing-note',
        marker: 'must-not-send',
      );
      final actions = <String?>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          actions.add(request.headers['x-vh-continuity-action-id']);
          return http.Response('{"message":"expired"}', 401);
        }),
      );
      _enableDrain(service);

      await service.syncPending();

      expect(actions.first, OfflineActionIds.opNoteDraftStore);
      expect(actions, contains(null));
      expect(actions, isNot(contains(OfflineActionIds.nursingNoteDraftStore)));
      final rows = await OfflineQueue.debugAllRows();
      expect(rows.singleWhere((row) => row['id'] == firstId)['retry_count'], 0);
      expect(
        rows.singleWhere((row) => row['id'] == secondId)['retry_count'],
        0,
      );
    },
  );

  test('owner change during HTTP stops pass without consuming retry', () async {
    service.setTransportAvailableForTesting(false);
    final firstId = await _prepareQueued(
      service,
      actionId: OfflineActionIds.opNoteDraftStore,
      orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
      marker: 'first',
    );
    await _prepareQueued(
      service,
      actionId: OfflineActionIds.nursingNoteDraftStore,
      orderingKey: 'patient-1\u0000admission-1\u0000nursing-note',
      marker: 'must-not-send',
    );
    final actions = <String?>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        actions.add(request.headers['x-vh-continuity-action-id']);
        await AuthService.setStaffId('staff-2');
        return http.Response('{"message":"later"}', 429);
      }),
    );
    _enableDrain(service);

    await service.syncPending();

    expect(actions, [OfflineActionIds.opNoteDraftStore]);
    final rows = await OfflineQueue.debugAllRows();
    expect(rows.singleWhere((row) => row['id'] == firstId)['retry_count'], 0);
  });

  test(
    'session barrier blocks enqueue and drain until explicitly released',
    () async {
      service.setTransportAvailableForTesting(false);
      final id = await _prepareQueued(
        service,
        actionId: OfflineActionIds.opNoteDraftStore,
        orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
        marker: 'barrier',
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
        service.prepareCapture(
          _draft(
            actionId: OfflineActionIds.nursingNoteDraftStore,
            orderingKey: 'patient-1\u0000admission-1\u0000nursing-note',
            marker: 'blocked',
          ),
        ),
        throwsA(isA<OfflineSessionBarrierActive>()),
      );
      _enableDrain(service);
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
      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['id'], id);
      expect(row['status'], 'applied');
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

Future<int> _prepareQueued(
  ConnectivitySyncService service, {
  required String actionId,
  required String orderingKey,
  required String marker,
  int supersessionGeneration = 0,
}) async {
  final persisted = await service.prepareCapture(
    _draft(
      actionId: actionId,
      orderingKey: orderingKey,
      marker: marker,
      supersessionGeneration: supersessionGeneration,
    ),
  );
  return persisted.rowId;
}

void _enableDrain(ConnectivitySyncService service) {
  service.setConnectionStateForTesting(
    transport: ClientTransportState.available,
    continuity: ContinuityLifecycleState.notReady,
  );
}

OfflineCommandDraft _draft({
  required String actionId,
  required String orderingKey,
  required String marker,
  int supersessionGeneration = 0,
}) {
  final captured = DateTime.now().toUtc();
  final noteType = actionId == OfflineActionIds.opNoteDraftStore
      ? 'op_consultation'
      : 'nursing_note';
  return OfflineCommandDraft(
    actionId: actionId,
    payload: {
      'patient_uid': 'patient-1',
      'note_type': noteType,
      'content': {'marker': marker},
    },
    appVersion: '1.2.0+4',
    actionVersion: 1,
    actionChecksum: 'action-checksum',
    actionSchemaId: 'schema.$noteType',
    actionSchemaVersion: 1,
    actionSchemaChecksum: 'schema-checksum',
    policyId: 'policy-1',
    policyVersion: '1',
    policyChecksum: 'policy-checksum',
    policySigningKeyId: 'key-1',
    policyEffectiveFrom: captured.subtract(const Duration(hours: 1)),
    policyEffectiveUntil: captured.add(const Duration(days: 1)),
    policyRevocationEpoch: '1',
    registryVersion: '1',
    registryChecksum: 'registry-checksum',
    minimumAppVersion: '1.2.0',
    tenantId: TenantConfig.id,
    facilityId: 17,
    deviceId: 'device-1',
    devicePosture: 'desktop',
    captureSessionId: '11111111-1111-4111-8111-111111111111',
    captureActorUuid: 'staff-user-uid',
    captureRole: 'doctor',
    patientReference: 'patient-1',
    appointmentId: 'appointment-1',
    occurredAt: captured,
    capturedAt: captured,
    clockEvidence: OfflineClockEvidence(
      observedAt: captured,
      serverTime: captured,
      midpoint: captured,
      skewMilliseconds: 0,
      uncertaintyMilliseconds: 10,
      toleranceMilliseconds: 30000,
      routeKind: 'public',
    ),
    cachedSources: {'patient_identity': captured},
    expiresAt: captured.add(const Duration(hours: 8)),
    orderingKey: orderingKey,
    supersessionGeneration: supersessionGeneration,
  );
}
