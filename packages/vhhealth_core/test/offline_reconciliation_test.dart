import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;

  setUp(() async {
    harness = OfflineQueueTestHarness('offline_reconciliation');
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

  test(
    'draft cancellation requires fresh actor and explicit confirmation',
    () async {
      final command = await OfflineQueue.persistPreparedCommand(_draft());

      expect(
        await OfflineQueue.reconcileCommand(
          command.rowId,
          const OfflineReconciliationRequest(
            reason: OfflineReconciliationReason.draftCancelled,
            actorUuid: 'wrong-actor',
            confirmedNotRecordedOnServer: true,
          ),
        ),
        isFalse,
      );
      expect(
        await OfflineQueue.reconcileCommand(
          command.rowId,
          OfflineReconciliationRequest(
            reason: OfflineReconciliationReason.draftCancelled,
            actorUuid: harness.currentActorUid,
            confirmedNotRecordedOnServer: false,
          ),
        ),
        isFalse,
      );
      expect(
        await OfflineQueue.reconcileCommand(
          command.rowId,
          OfflineReconciliationRequest(
            reason: OfflineReconciliationReason.draftCancelled,
            actorUuid: harness.currentActorUid,
            confirmedNotRecordedOnServer: true,
            explanation: 'Editor explicitly cancelled the local draft.',
          ),
        ),
        isTrue,
      );

      final row = (await (await OfflineQueue.database).query(
        'pending_writes',
        where: 'id = ?',
        whereArgs: [command.rowId],
      )).single;
      expect(row['status'], 'cancelled');
      expect(row['state_reason_code'], 'draft_cancelled');
      final event = (await OfflineQueue.debugStateEvents()).last;
      expect(event['actor_uid'], harness.currentActorUid);
      expect(event['reason_code'], 'draft_cancelled');
      final detail =
          jsonDecode(
                await harness.decryptV1(event['detail_ciphertext'] as String),
              )
              as Map<String, dynamic>;
      expect(detail['confirmed_not_recorded_on_server'], isTrue);
      expect(detail['reason'], 'draft_cancelled');
    },
  );

  test('explanation is mandatory for context and policy reasons', () async {
    final command = await OfflineQueue.persistPreparedCommand(_draft());
    final withoutExplanation = OfflineReconciliationRequest(
      reason: OfflineReconciliationReason.wrongPatientOrContext,
      actorUuid: harness.currentActorUid,
      confirmedNotRecordedOnServer: true,
    );
    expect(
      await OfflineQueue.reconcileCommand(command.rowId, withoutExplanation),
      isFalse,
    );
    expect(
      await OfflineQueue.reconcileCommand(
        command.rowId,
        OfflineReconciliationRequest(
          reason: OfflineReconciliationReason.policyOrSchemaConflict,
          actorUuid: harness.currentActorUid,
          confirmedNotRecordedOnServer: true,
          explanation: 'The cached action schema no longer matches policy.',
        ),
      ),
      isTrue,
    );
    final row = (await (await OfflineQueue.database).query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [command.rowId],
    )).single;
    expect(row['status'], 'needs_review');
    expect(row['review_reason_code'], 'policy_or_schema_conflict');
  });

  test(
    'non-draft observation is retained, never cancelled or deleted',
    () async {
      final command = await OfflineQueue.persistPreparedCommand(
        _draft(actionId: OfflineActionIds.vitalsCapture),
      );

      expect(
        await OfflineQueue.reconcileCommand(
          command.rowId,
          OfflineReconciliationRequest(
            reason: OfflineReconciliationReason.draftCancelled,
            actorUuid: harness.currentActorUid,
            confirmedNotRecordedOnServer: true,
          ),
        ),
        isFalse,
      );
      expect(
        await OfflineQueue.reconcileCommand(
          command.rowId,
          OfflineReconciliationRequest(
            reason: OfflineReconciliationReason.transferredToPaper,
            actorUuid: harness.currentActorUid,
            confirmedNotRecordedOnServer: true,
            explanation: 'Verified against the signed downtime sheet.',
          ),
        ),
        isTrue,
      );
      final rows = await (await OfflineQueue.database).query(
        'pending_writes',
        where: 'id = ?',
        whereArgs: [command.rowId],
      );
      expect(rows, hasLength(1));
      expect(rows.single['status'], 'applied');
      expect(rows.single['state_reason_code'], 'transferred_to_paper');
    },
  );

  test(
    'production reconciliation resolves legacy C0A conflict audibly',
    () async {
      final id = await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: const {'patient_id': 9, 'pulse': 72},
      );
      await OfflineQueue.markConflict(id, 'Server contains a newer record');

      expect(
        await OfflineQueue.reconcileCommand(
          id,
          OfflineReconciliationRequest(
            reason: OfflineReconciliationReason.manualEntryVerified,
            actorUuid: harness.currentActorUid,
            confirmedNotRecordedOnServer: true,
            explanation: 'Manual chart entry was verified.',
          ),
        ),
        isTrue,
      );
      expect(
        await (await OfflineQueue.database).query(
          'pending_writes',
          where: 'id = ?',
          whereArgs: [id],
        ),
        isEmpty,
      );
      final event = (await OfflineQueue.debugStateEvents()).last;
      expect(event['reason_code'], 'manual_entry_verified');
      expect(event['actor_uid'], harness.currentActorUid);
      expect(event['detail_ciphertext'], isNotNull);
    },
  );

  test(
    'deprecated boolean facade retains C0A authorization and audit',
    () async {
      final id = await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: const {
          'patient_uid': 'patient-1',
          'content': {'text': 'draft'},
        },
      );
      await OfflineQueue.markConflict(id, 'Server contains a newer draft');

      expect(
        await OfflineQueue.discardConflict(id, reconciliationConfirmed: false),
        isFalse,
      );
      expect(
        await OfflineQueue.discardConflict(id, reconciliationConfirmed: true),
        isTrue,
      );
      final event = (await OfflineQueue.debugStateEvents()).last;
      expect(event['reason_code'], 'legacy_reconciliation_confirmed');
      expect(event['actor_uid'], harness.currentActorUid);
    },
  );
}

OfflineCommandDraft _draft({
  String actionId = OfflineActionIds.opNoteDraftStore,
}) {
  final captured = DateTime.now().toUtc();
  return OfflineCommandDraft(
    actionId: actionId,
    payload: const {'patient_uid': 'patient-1', 'value': 72},
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
    policyEffectiveUntil: captured.add(const Duration(days: 1)),
    policyRevocationEpoch: '1',
    registryVersion: '1',
    registryChecksum: 'registry-checksum',
    minimumAppVersion: '6.0.0',
    tenantId: TenantConfig.id,
    facilityId: 17,
    deviceId: 'device-1',
    devicePosture: 'desktop',
    captureSessionId: '11111111-1111-4111-8111-111111111111',
    captureActorUuid: 'staff-user-uid',
    captureRole: 'doctor',
    patientReference: 'patient-1',
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
    orderingKey: 'patient-1\u0000reconciliation',
  );
}
