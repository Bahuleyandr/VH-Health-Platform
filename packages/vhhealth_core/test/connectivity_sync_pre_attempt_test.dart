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
    harness = OfflineQueueTestHarness('connectivity_sync_pre_attempt');
    await harness.setUp();
    OfflineQueue.registerMetadataResolvers(
      tenantIdResolver: () => TenantConfig.id,
      reconciliationOwnerResolver: (_) =>
          OfflineQueue.fallbackReconciliationRole,
      currentActorUidResolver: () async => harness.currentActorUid,
      currentActorRoleResolver: () async => 'doctor',
    );
    await AuthService.setStaffId('staff-1');
    await AuthService.setJwt('test-jwt');
    await service.resetForTesting(
      readinessProbe: () async => ClientReadinessOutcome.alwaysReadyForTesting,
    );
  });

  tearDown(() async {
    VHHttpClient.resetClientForTesting();
    await service.resetForTesting();
    await harness.tearDown();
  });

  test('failed durable insert causes zero HTTP mutations', () async {
    var requestCount = 0;
    VHHttpClient.setClientForTesting(
      MockClient((_) async {
        requestCount++;
        return http.Response('{"data":{}}', 200);
      }),
    );
    final db = await OfflineQueue.database;
    await db.execute('''
      CREATE TRIGGER fail_prepared_insert
      BEFORE INSERT ON pending_writes
      BEGIN
        SELECT RAISE(FAIL, 'simulated disk failure');
      END
    ''');

    await expectLater(service.prepareCapture(_draft()), throwsA(anything));

    expect(requestCount, 0);
    expect(await db.query('pending_writes'), isEmpty);
    expect(await db.query('offline_write_sequences'), isEmpty);
    expect(await db.query('offline_write_state_events'), isEmpty);
  });

  test(
    'missing facility and uncertain clock fail before insert or HTTP',
    () async {
      var requestCount = 0;
      VHHttpClient.setClientForTesting(
        MockClient((_) async {
          requestCount++;
          return http.Response('{"data":{}}', 200);
        }),
      );

      await expectLater(
        service.prepareCapture(_draft(facilityId: 0)),
        throwsA(
          isA<OfflineWriteRejected>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'facility_context_unavailable',
          ),
        ),
      );
      await expectLater(
        service.prepareCapture(
          _draft(
            clockSkewMilliseconds: 31000,
            clockToleranceMilliseconds: 30000,
          ),
        ),
        throwsA(
          isA<OfflineWriteRejected>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'clock_evidence_untrusted',
          ),
        ),
      );

      expect(requestCount, 0);
      expect(
        await (await OfflineQueue.database).query('pending_writes'),
        isEmpty,
      );
    },
  );

  test('first attempt and retry reuse one committed identity', () async {
    final requests = <http.Request>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requests.add(request);
        if (requests.length == 1) {
          return http.Response(
            '{"message":"retry"}',
            429,
            headers: {'retry-after': '0'},
          );
        }
        return http.Response('{"data":{}}', 200);
      }),
    );

    final persisted = await service.prepareCapture(_draft());
    expect(requests, hasLength(1));
    final db = await OfflineQueue.database;
    var row = (await db.query('pending_writes')).single;
    expect(row['status'], 'retry_wait');
    expect(row['client_event_id'], persisted.envelope.clientEventId);
    expect(row['idempotency_key'], persisted.envelope.idempotencyKey);
    expect(row['command_fingerprint'], persisted.envelope.commandFingerprint);

    await db.update(
      'pending_writes',
      {'next_attempt_at': 0},
      where: 'id = ?',
      whereArgs: [persisted.rowId],
    );
    await service.syncPending();

    expect(requests, hasLength(2));
    for (final request in requests) {
      expect(
        request.headers['idempotency-key'],
        persisted.envelope.idempotencyKey,
      );
      expect(
        request.headers['x-vh-continuity-action-id'],
        OfflineActionIds.opNoteDraftStore,
      );
      expect(
        request.headers['x-vh-continuity-facility-id'],
        persisted.envelope.facilityId.toString(),
      );
    }
    row = (await db.query('pending_writes')).single;
    expect(row['status'], 'applied');
    expect(row['attempt_count'], 2);
    expect(row['client_event_id'], persisted.envelope.clientEventId);
    expect(row['idempotency_key'], persisted.envelope.idempotencyKey);
    expect(row['command_fingerprint'], persisted.envelope.commandFingerprint);
  });
}

OfflineCommandDraft _draft({
  int facilityId = 17,
  int clockSkewMilliseconds = 0,
  int clockToleranceMilliseconds = 30000,
}) {
  final captured = DateTime.now().toUtc();
  return OfflineCommandDraft(
    actionId: OfflineActionIds.opNoteDraftStore,
    payload: const {
      'patient_uid': 'patient-1',
      'note_type': 'op_consultation',
      'content': {'assessment': 'stable'},
    },
    appVersion: '6.0.0+600',
    actionVersion: 1,
    actionChecksum: 'action-checksum',
    actionSchemaId: 'schema.op-note-draft',
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
    minimumAppVersion: '6.0.0',
    tenantId: TenantConfig.id,
    facilityId: facilityId,
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
      serverTime: captured.add(Duration(milliseconds: clockSkewMilliseconds)),
      midpoint: captured,
      skewMilliseconds: clockSkewMilliseconds,
      uncertaintyMilliseconds: 10,
      toleranceMilliseconds: clockToleranceMilliseconds,
      routeKind: 'public',
    ),
    cachedSources: {'patient_identity': captured},
    expiresAt: captured.add(const Duration(hours: 8)),
    orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
  );
}
