import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;

  setUp(() async {
    harness = OfflineQueueTestHarness('connectivity_sync_state_machine');
    await harness.setUp();
    OfflineQueue.registerMetadataResolvers(
      tenantIdResolver: () => TenantConfig.id,
      reconciliationOwnerResolver: (_) =>
          OfflineQueue.fallbackReconciliationRole,
      currentActorUidResolver: () async => harness.currentActorUid,
      currentActorRoleResolver: () async => 'doctor',
    );
    await AuthService.setStaffId('staff-1');
  });

  tearDown(() => harness.tearDown());

  test('prepared outcome matrix separates review from transient retry', () {
    for (final status in [400, 403, 404, 409, 410, 412, 422]) {
      expect(
        preparedDispositionForStatus(status),
        SyncDisposition.conflict,
        reason: 'prepared status $status',
      );
    }
    for (final status in [401, 408, 429, 500, 502, 503]) {
      expect(
        preparedDispositionForStatus(status),
        SyncDisposition.retry,
        reason: 'prepared status $status',
      );
    }
  });

  test(
    'capture actor and role must match fresh authenticated identity',
    () async {
      final captured = DateTime.utc(2026, 7, 31, 10);
      await expectLater(
        OfflineQueue.persistPreparedCommand(
          _draft(captured: captured, captureActorUuid: 'forged-actor'),
        ),
        throwsA(
          isA<OfflineWriteRejected>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'capture_identity_mismatch',
          ),
        ),
      );
      await expectLater(
        OfflineQueue.persistPreparedCommand(
          _draft(captured: captured, captureRole: 'administrator'),
        ),
        throwsA(
          isA<OfflineWriteRejected>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'capture_identity_mismatch',
          ),
        ),
      );
      expect(
        await (await OfflineQueue.database).query('pending_writes'),
        isEmpty,
      );
    },
  );

  test(
    'lease, retry, authentication release, and applied state are guarded',
    () async {
      final start = DateTime.utc(2026, 7, 31, 10);
      final command = await OfflineQueue.persistPreparedCommand(
        _draft(captured: start),
        queuedAt: start,
      );

      final firstLease = await OfflineQueue.claimPreparedCommand(
        command.rowId,
        now: start,
      );
      expect(firstLease?.state, OfflineCommandState.inFlight);
      expect(firstLease?.attemptCount, 1);
      expect(
        await OfflineQueue.markPreparedApplied(
          rowId: command.rowId,
          leaseId: 'wrong-lease',
        ),
        isFalse,
      );
      expect(
        await OfflineQueue.releasePreparedLeaseForAuthentication(
          rowId: command.rowId,
          leaseId: firstLease!.leaseId!,
        ),
        isTrue,
      );
      var row = await (await OfflineQueue.database).query(
        'pending_writes',
        where: 'id = ?',
        whereArgs: [command.rowId],
      );
      expect(row.single['status'], 'pending');
      expect(row.single['attempt_count'], 0);

      final secondLease = await OfflineQueue.claimPreparedCommand(
        command.rowId,
        now: start.add(const Duration(seconds: 1)),
      );
      expect(secondLease?.attemptCount, 1);
      expect(
        await OfflineQueue.schedulePreparedRetry(
          rowId: command.rowId,
          leaseId: secondLease!.leaseId!,
          now: start.add(const Duration(seconds: 1)),
          retryAfter: start.add(const Duration(seconds: 30)),
        ),
        isTrue,
      );
      row = await (await OfflineQueue.database).query(
        'pending_writes',
        where: 'id = ?',
        whereArgs: [command.rowId],
      );
      expect(row.single['status'], 'retry_wait');
      expect(
        row.single['next_attempt_at'],
        start.add(const Duration(seconds: 30)).millisecondsSinceEpoch,
      );

      final finalLease = await OfflineQueue.claimPreparedCommand(
        command.rowId,
        now: start.add(const Duration(seconds: 31)),
      );
      expect(finalLease, isNotNull);
      expect(
        await OfflineQueue.markPreparedApplied(
          rowId: command.rowId,
          leaseId: finalLease!.leaseId!,
          at: start.add(const Duration(seconds: 32)),
        ),
        isTrue,
      );
      expect(
        await OfflineQueue.markPreparedNeedsReview(
          rowId: command.rowId,
          reasonCode: 'forbidden_terminal_rearm',
        ),
        isFalse,
      );
      expect(
        await OfflineQueue.claimPreparedCommand(
          command.rowId,
          now: start.add(const Duration(minutes: 1)),
        ),
        isNull,
      );
    },
  );

  test('expired lease becomes ambiguous retry without new identity', () async {
    final start = DateTime.utc(2026, 7, 31, 10);
    final command = await OfflineQueue.persistPreparedCommand(
      _draft(captured: start),
      queuedAt: start,
    );
    final lease = await OfflineQueue.claimPreparedCommand(
      command.rowId,
      now: start,
    );
    expect(lease, isNotNull);

    await OfflineQueue.resetForTesting();
    await OfflineQueue.recoverExpiredLeases(
      now: start.add(OfflineQueue.leaseDuration + const Duration(seconds: 1)),
    );

    final row = (await (await OfflineQueue.database).query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [command.rowId],
    )).single;
    expect(row['status'], 'retry_wait');
    expect(row['state_reason_code'], 'lease_expired');
    expect(row['client_event_id'], command.envelope.clientEventId);
    expect(row['idempotency_key'], command.envelope.idempotencyKey);
    expect(row['command_fingerprint'], command.envelope.commandFingerprint);
  });

  test('corrupt ciphertext fails closed into typed review', () async {
    final start = DateTime.utc(2026, 7, 31, 10);
    final command = await OfflineQueue.persistPreparedCommand(
      _draft(captured: start),
    );
    final db = await OfflineQueue.database;
    await db.update(
      'pending_writes',
      {'envelope_ciphertext': 'corrupt'},
      where: 'id = ?',
      whereArgs: [command.rowId],
    );

    expect(
      await OfflineQueue.claimPreparedCommand(command.rowId, now: start),
      isNull,
    );
    final row = (await db.query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [command.rowId],
    )).single;
    expect(row['status'], 'needs_review');
    expect(row['state_reason_code'], 'command_integrity_failed');
  });

  test(
    'a different signed-in owner cannot inspect or claim the command',
    () async {
      final start = DateTime.utc(2026, 7, 31, 10);
      final command = await OfflineQueue.persistPreparedCommand(
        _draft(captured: start),
      );
      await AuthService.setStaffId('staff-2');

      expect(await OfflineQueue.unresolvedEntriesForCurrentOwner(), isEmpty);
      expect(
        await OfflineQueue.claimPreparedCommand(command.rowId, now: start),
        isNull,
      );
      final row = (await (await OfflineQueue.database).query(
        'pending_writes',
        where: 'id = ?',
        whereArgs: [command.rowId],
      )).single;
      expect(row['staff_id'], 'staff-1');
      expect(row['status'], 'pending');
    },
  );

  test('six lease cycles end visibly in needs_review', () async {
    final start = DateTime.utc(2026, 7, 31, 10);
    final command = await OfflineQueue.persistPreparedCommand(
      _draft(captured: start, expiresAt: start.add(const Duration(days: 2))),
      queuedAt: start,
    );
    var attemptAt = start;
    for (var attempt = 1; attempt <= OfflineQueue.maxRetryCount; attempt++) {
      final lease = await OfflineQueue.claimPreparedCommand(
        command.rowId,
        now: attemptAt,
      );
      expect(lease?.attemptCount, attempt);
      expect(
        await OfflineQueue.schedulePreparedRetry(
          rowId: command.rowId,
          leaseId: lease!.leaseId!,
          now: attemptAt,
          reasonCode: 'ambiguous_transport_outcome',
        ),
        isTrue,
      );
      attemptAt = attemptAt.add(const Duration(hours: 1));
    }

    final row = (await (await OfflineQueue.database).query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [command.rowId],
    )).single;
    expect(row['status'], 'needs_review');
    expect(row['state_reason_code'], 'retry_exhausted');
    expect(row['attempt_count'], OfflineQueue.maxRetryCount);
  });

  test('predecessor failure blocks only its dependent partition', () async {
    final start = DateTime.utc(2026, 7, 31, 10);
    final parent = await OfflineQueue.persistPreparedCommand(
      _draft(
        captured: start,
        actionId: OfflineActionIds.vitalsCapture,
        orderingKey: 'patient-1\u0000vitals',
      ),
      queuedAt: start,
    );
    final child = await OfflineQueue.persistPreparedCommand(
      _draft(
        captured: start.add(const Duration(seconds: 1)),
        actionId: OfflineActionIds.vitalsCapture,
        orderingKey: 'patient-1\u0000vitals',
        predecessorClientEventId: parent.envelope.clientEventId,
      ),
      queuedAt: start.add(const Duration(seconds: 1)),
    );
    final independent = await OfflineQueue.persistPreparedCommand(
      _draft(
        captured: start.add(const Duration(seconds: 2)),
        actionId: OfflineActionIds.vitalsCapture,
        orderingKey: 'patient-2\u0000vitals',
        patientReference: 'patient-2',
      ),
      queuedAt: start.add(const Duration(seconds: 2)),
    );

    expect(
      await OfflineQueue.claimPreparedCommand(child.rowId, now: start),
      isNull,
    );
    expect(
      await OfflineQueue.claimPreparedCommand(
        independent.rowId,
        now: start.add(const Duration(seconds: 3)),
      ),
      isNotNull,
    );
    expect(
      await OfflineQueue.markPreparedNeedsReview(
        rowId: parent.rowId,
        reasonCode: 'parent_reconciliation_required',
      ),
      isTrue,
    );
    expect(
      await OfflineQueue.claimPreparedCommand(
        child.rowId,
        now: start.add(const Duration(seconds: 4)),
      ),
      isNull,
    );
    final childRow = (await (await OfflineQueue.database).query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [child.rowId],
    )).single;
    expect(childRow['status'], 'needs_review');
    expect(childRow['state_reason_code'], 'predecessor_failed');
  });

  test('drafts supersede, while observations remain append-only', () async {
    final start = DateTime.utc(2026, 7, 31, 10);
    final firstDraft = await OfflineQueue.persistPreparedCommand(
      _draft(captured: start, supersessionGeneration: 4),
      queuedAt: start,
    );
    final secondDraft = await OfflineQueue.persistPreparedCommand(
      _draft(
        captured: start.add(const Duration(seconds: 1)),
        supersessionGeneration: 4,
      ),
      queuedAt: start.add(const Duration(seconds: 1)),
    );
    final firstObservation = await OfflineQueue.persistPreparedCommand(
      _draft(
        captured: start.add(const Duration(seconds: 2)),
        actionId: OfflineActionIds.vitalsCapture,
        orderingKey: 'patient-1\u0000observations',
      ),
    );
    final secondObservation = await OfflineQueue.persistPreparedCommand(
      _draft(
        captured: start.add(const Duration(seconds: 3)),
        actionId: OfflineActionIds.vitalsCapture,
        orderingKey: 'patient-1\u0000observations',
      ),
    );

    final rows = await (await OfflineQueue.database).query(
      'pending_writes',
      orderBy: 'id',
    );
    final byId = {for (final row in rows) row['id']: row};
    expect(byId[firstDraft.rowId]!['status'], 'superseded');
    expect(byId[secondDraft.rowId]!['status'], 'pending');
    expect(byId[firstObservation.rowId]!['status'], 'pending');
    expect(byId[secondObservation.rowId]!['status'], 'pending');
  });

  test('an attempted draft becomes the newer draft predecessor', () async {
    final start = DateTime.utc(2026, 7, 31, 10);
    final first = await OfflineQueue.persistPreparedCommand(
      _draft(captured: start, supersessionGeneration: 3),
      queuedAt: start,
    );
    final lease = await OfflineQueue.claimPreparedCommand(
      first.rowId,
      now: start,
    );
    await OfflineQueue.schedulePreparedRetry(
      rowId: first.rowId,
      leaseId: lease!.leaseId!,
      now: start,
    );

    final second = await OfflineQueue.persistPreparedCommand(
      _draft(
        captured: start.add(const Duration(seconds: 5)),
        supersessionGeneration: 3,
      ),
      queuedAt: start.add(const Duration(seconds: 5)),
    );

    expect(
      second.envelope.predecessorClientEventId,
      first.envelope.clientEventId,
    );
    final firstRow = (await (await OfflineQueue.database).query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [first.rowId],
    )).single;
    expect(firstRow['status'], 'retry_wait');
  });

  test('retry backoff is bounded and never precedes Retry-After', () {
    final now = DateTime.utc(2026, 7, 31, 10);
    expect(
      OfflineQueue.nextRetryAt(attemptCount: 1, now: now, jitterFraction: 0),
      now.add(const Duration(seconds: 2)),
    );
    expect(
      OfflineQueue.nextRetryAt(attemptCount: 1, now: now, jitterFraction: 1),
      now.add(const Duration(seconds: 3)),
    );
    final floor = now.add(const Duration(minutes: 20));
    expect(
      OfflineQueue.nextRetryAt(
        attemptCount: 20,
        now: now,
        retryAfter: floor,
        jitterFraction: 0,
      ),
      floor,
    );
  });
}

OfflineCommandDraft _draft({
  required DateTime captured,
  String actionId = OfflineActionIds.opNoteDraftStore,
  String orderingKey = 'patient-1\u0000appointment-1\u0000op-note',
  String patientReference = 'patient-1',
  String? predecessorClientEventId,
  int supersessionGeneration = 0,
  DateTime? expiresAt,
  String captureActorUuid = 'staff-user-uid',
  String captureRole = 'doctor',
}) {
  return OfflineCommandDraft(
    actionId: actionId,
    payload: {
      'patient_uid': patientReference,
      'value': captured.millisecondsSinceEpoch,
    },
    appVersion: '6.0.0+600',
    actionVersion: 1,
    actionChecksum: 'action-checksum',
    actionSchemaId: 'schema.c4',
    actionSchemaVersion: 1,
    actionSchemaChecksum: 'schema-checksum',
    policyId: 'policy-1',
    policyVersion: '1',
    policyChecksum: 'policy-checksum',
    policySigningKeyId: 'key-1',
    policyEffectiveFrom: captured.subtract(const Duration(hours: 1)),
    policyEffectiveUntil: captured.add(const Duration(days: 3)),
    policyRevocationEpoch: '1',
    registryVersion: '1',
    registryChecksum: 'registry-checksum',
    minimumAppVersion: '6.0.0',
    tenantId: TenantConfig.id,
    facilityId: 17,
    deviceId: 'device-1',
    devicePosture: 'desktop',
    captureSessionId: '11111111-1111-4111-8111-111111111111',
    captureActorUuid: captureActorUuid,
    captureRole: captureRole,
    patientReference: patientReference,
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
    expiresAt: expiresAt ?? captured.add(const Duration(days: 1)),
    orderingKey: orderingKey,
    predecessorClientEventId: predecessorClientEventId,
    supersessionGeneration: supersessionGeneration,
  );
}
