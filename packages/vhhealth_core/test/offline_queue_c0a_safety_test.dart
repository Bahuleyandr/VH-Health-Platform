import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/models/offline_write_entry.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;

  setUp(() async {
    harness = OfflineQueueTestHarness('offline_queue_c0a_safety');
    await harness.setUp();
    await ConnectivitySyncService.instance.resetForTesting();
    await AuthService.setStaffId('capture-staff-id');
  });

  tearDown(() async {
    await ConnectivitySyncService.instance.resetForTesting();
    await harness.tearDown();
  });

  test('concurrent startup callers share one database open', () async {
    final databases = await Future.wait(
      List.generate(8, (_) => OfflineQueue.database),
    );
    expect(
      databases.every((database) => identical(database, databases.first)),
      isTrue,
    );
  });

  test(
    'public sync-service enqueue rejects every contained and unknown action',
    () async {
      for (final route in const [
        ('POST', '/prescriptions/create'),
        ('POST', '/emr/orders'),
        ('POST', '/clinical/mar/1/administer-with-scan'),
        ('POST', '/lab/samples/1/collect'),
        ('POST', '/blood-bank/1/verify-bedside'),
        ('POST', '/emr/notes'),
        ('POST', '/future/action'),
      ]) {
        await expectLater(
          ConnectivitySyncService.instance.enqueue(
            endpoint: route.$2,
            method: route.$1,
            body: const {'clinical': 'data'},
          ),
          throwsA(isA<OfflineWriteRejected>()),
          reason: '${route.$1} ${route.$2}',
        );
      }
      expect(await OfflineQueue.debugAllRows(), isEmpty);
    },
  );

  test(
    'lower-layer enqueue rejects all contained and unknown actions',
    () async {
      for (final route in const [
        ('POST', '/prescriptions/create'),
        ('POST', '/emr/orders'),
        ('POST', '/clinical/mar/1/administer-with-scan'),
        ('POST', '/lab/samples/1/collect'),
        ('POST', '/blood-bank/1/verify-bedside'),
        ('POST', '/emr/notes'),
        ('POST', '/future/action'),
      ]) {
        await expectLater(
          OfflineQueue.enqueue(
            endpoint: route.$2,
            method: route.$1,
            body: const {'clinical': 'data'},
          ),
          throwsA(isA<OfflineWriteRejected>()),
          reason: '${route.$1} ${route.$2}',
        );
      }
      expect(await OfflineQueue.debugAllRows(), isEmpty);
    },
  );

  test(
    'eligible controls persist encrypted PHI and trusted metadata',
    () async {
      await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'post',
        body: {'patient_uid': 'pt-1', 'pulse': 72},
        contextLabel: 'Patient One',
      );
      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['method'], 'POST');
      expect(row['body'], isNot(contains('pt-1')));
      expect(row['context_label'], isNot(contains('Patient One')));
      expect(row['tenant_id'], TenantConfig.id);
      expect(row['staff_id'], 'capture-staff-id');
      expect(row['reconciliation_owner_id'], 'capture-staff-id');
      expect(row['encryption_version'], 1);
      expect(await OfflineQueue.decodeBody(row['body'] as String), {
        'patient_uid': 'pt-1',
        'pulse': 72,
      });
      expect(
        (await OfflineQueue.unresolvedEntriesForCurrentOwner())
            .single
            .contextLabel,
        'Patient One',
      );
    },
  );

  test('strict v5 decode never falls back to legacy plaintext', () async {
    await expectLater(
      OfflineQueue.decodeBody('{"patient_uid":"plaintext"}'),
      throwsA(anything),
    );
  });

  test(
    'unattested review blocks, immutable UID attestation unblocks only it',
    () async {
      final pendingId = await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 71},
      );
      final reviewId = await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {'text': 'draft'},
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
        whereArgs: [reviewId],
      );

      expect(await OfflineQueue.unresolvedWriteCountForCurrentOwner(), 2);
      expect(await OfflineQueue.blockingWriteCountForCurrentOwner(), 2);
      final firstAt = DateTime.fromMillisecondsSinceEpoch(1700000000000);
      expect(
        await OfflineQueue.attestHandoff(
          id: reviewId,
          actorUid: 'staff-user-uid',
          at: firstAt,
        ),
        isTrue,
      );
      expect(await OfflineQueue.blockingWriteCountForCurrentOwner(), 1);
      expect(
        await OfflineQueue.attestHandoff(
          id: reviewId,
          actorUid: 'different-uid',
          at: DateTime.fromMillisecondsSinceEpoch(1800000000000),
        ),
        isFalse,
      );

      final entry = (await OfflineQueue.unresolvedEntriesForCurrentOwner())
          .singleWhere((item) => item.id == reviewId);
      expect(entry.handoffAttestedBy, 'staff-user-uid');
      expect(entry.handoffAttestedAt, firstAt);
      expect(entry.status, OfflineWriteStatus.needsReview);
      expect(entry.canRetry, isFalse);
      expect(entry.canDiscard, isFalse);
      expect((await OfflineQueue.debugAllRows()), hasLength(2));
      expect(
        (await OfflineQueue.debugAllRows()).singleWhere(
          (row) => row['id'] == pendingId,
        )['status'],
        'pending',
      );
    },
  );

  test(
    'conflict discard requires reconciliation and service-layer rechecks',
    () async {
      final vitalsId = await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 72},
      );
      await OfflineQueue.markConflict(vitalsId, 'server changed');
      expect(
        await OfflineQueue.discardConflict(
          vitalsId,
          reconciliationConfirmed: false,
        ),
        isFalse,
      );
      expect(await OfflineQueue.getConflicts(), hasLength(1));
      expect(
        await OfflineQueue.discardConflict(
          vitalsId,
          reconciliationConfirmed: true,
        ),
        isTrue,
      );

      final reviewId = await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {'text': 'draft'},
      );
      final db = await OfflineQueue.database;
      await db.update(
        'pending_writes',
        {'status': 'needs_review', 'review_reason_code': 'retry_exhausted'},
        where: 'id = ?',
        whereArgs: [reviewId],
      );
      expect(
        await OfflineQueue.discardConflict(
          reviewId,
          reconciliationConfirmed: true,
        ),
        isFalse,
      );

      await AuthService.setStaffId('other-staff');
      expect(
        await OfflineQueue.discardConflict(
          reviewId,
          reconciliationConfirmed: true,
        ),
        isFalse,
      );
      expect((await OfflineQueue.debugAllRows()), hasLength(1));
    },
  );

  test(
    'markConflict never creates a replacement for a missing stored key',
    () async {
      final id = await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 72},
      );
      final before = (await OfflineQueue.debugAllRows()).single;
      final bodyBytes = before['body'];
      harness.removeEncryptionKey();
      OfflineQueue.debugDropCachedEncryptionKey();

      await OfflineQueue.markConflict(
        id,
        'must not be encrypted with a new key',
      );

      final after = (await OfflineQueue.debugAllRows()).single;
      expect(harness.storedEncryptionKey, isNull);
      expect(after['body'], bodyBytes);
      expect(after['conflict_reason'], isNull);
      expect(after['encryption_version'], isNull);
      expect(after['status'], 'needs_review');
      expect(after['review_reason_code'], 'unknown_encryption_version');
    },
  );

  test('attestation actor must match the authoritative UID resolver', () async {
    final id = await OfflineQueue.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 72},
    );
    final db = await OfflineQueue.database;
    await db.update(
      'pending_writes',
      {'status': 'needs_review', 'review_reason_code': 'retry_exhausted'},
      where: 'id = ?',
      whereArgs: [id],
    );
    harness.currentActorUid = 'authoritative-user-uid';

    expect(
      await OfflineQueue.attestHandoff(id: id, actorUid: 'spoofed-user-uid'),
      isFalse,
    );
    expect(
      await OfflineQueue.attestHandoff(
        id: id,
        actorUid: 'authoritative-user-uid',
      ),
      isTrue,
    );
    final row = (await OfflineQueue.debugAllRows()).single;
    expect(row['handoff_attested_by'], 'authoritative-user-uid');
  });

  test(
    'conflict and review rows compute skipped state only in their partition',
    () async {
      final blockerId = await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 70},
      );
      await OfflineQueue.markConflict(blockerId, 'server changed');
      final skippedId = await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'pulse': 71},
      );
      final independentId = await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {'text': 'independent'},
      );

      var entries = await OfflineQueue.unresolvedEntriesForCurrentOwner();
      expect(
        entries.singleWhere((entry) => entry.id == skippedId).isSkipped,
        isTrue,
      );
      expect(
        entries.singleWhere((entry) => entry.id == skippedId).blockerRowId,
        blockerId,
      );
      expect(
        entries.singleWhere((entry) => entry.id == independentId).isSkipped,
        isFalse,
      );

      await OfflineQueue.resetForTesting();
      entries = await OfflineQueue.unresolvedEntriesForCurrentOwner();
      expect(
        entries.singleWhere((entry) => entry.id == skippedId).isSkipped,
        isTrue,
        reason: 'restart reconstructs the blocker from durable rows',
      );
    },
  );

  test('retry 5 to 6 atomically becomes review-required', () async {
    final id = await OfflineQueue.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'pulse': 70},
    );
    final db = await OfflineQueue.database;
    await db.update(
      'pending_writes',
      {'retry_count': 5},
      where: 'id = ?',
      whereArgs: [id],
    );

    expect(await OfflineQueue.incrementRetryOrExhaust(id), 6);
    final row = (await OfflineQueue.debugAllRows()).single;
    expect(row['retry_count'], 6);
    expect(row['status'], 'needs_review');
    expect(row['review_reason_code'], 'retry_exhausted');
  });

  test('unknown metadata is retained as review-required', () async {
    harness.installFixedEncryptionKey();
    final encrypted = await harness.encryptV1('{"pulse":70}');
    await harness.createV5Fixture([
      {
        'id': 91,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': encrypted,
        'created_at': 91,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'unknown-tenant',
        'staff_id': 'capture-staff-id',
        'tenant_id': 'mismatched-tenant',
        'encryption_version': 1,
        'reconciliation_owner_id': 'capture-staff-id',
      },
      {
        'id': 92,
        'endpoint': '/emr/notes/draft',
        'method': 'PUT',
        'body': encrypted,
        'created_at': 92,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'unknown-version',
        'staff_id': 'capture-staff-id',
        'tenant_id': TenantConfig.id,
        'encryption_version': 9,
        'reconciliation_owner_id': 'capture-staff-id',
      },
    ]);

    final rows = await OfflineQueue.debugAllRows();
    expect(rows, hasLength(2));
    expect(rows[0]['status'], 'needs_review');
    expect(rows[0]['review_reason_code'], 'unknown_tenant');
    expect(rows[1]['status'], 'needs_review');
    expect(rows[1]['review_reason_code'], 'unknown_encryption_version');
    expect(rows[0]['body'], encrypted);
    expect(rows[1]['body'], encrypted);
  });

  test(
    'session clear and app restart preserve rows, key, and decryptability',
    () async {
      final id = await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'patient_uid': 'pt-preserved', 'pulse': 72},
      );
      final before = (await OfflineQueue.debugAllRows()).single;
      final storedBody = before['body'] as String;
      final storedKey = harness.storedEncryptionKey;

      await AuthService.clearSessionIdentity();
      await OfflineQueue.resetForTesting();

      expect(harness.storedEncryptionKey, storedKey);
      await AuthService.setStaffId('capture-staff-id');
      final entries = await OfflineQueue.unresolvedEntriesForCurrentOwner();
      expect(entries.map((entry) => entry.id), [id]);
      expect(await OfflineQueue.decodeBody(storedBody), {
        'patient_uid': 'pt-preserved',
        'pulse': 72,
      });
      expect((await OfflineQueue.debugAllRows()), hasLength(1));
    },
  );

  test(
    'contained review evidence survives session clear and restart',
    () async {
      harness.installFixedEncryptionKey();
      final encrypted = await harness.encryptV1('{"prescription":"evidence"}');
      await harness.createV5Fixture([
        {
          'id': 401,
          'endpoint': '/prescriptions/create',
          'method': 'POST',
          'body': encrypted,
          'created_at': 401,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'test',
          'staff_id': 'capture-staff-id',
          'tenant_id': TenantConfig.id,
          'encryption_version': 1,
          'reconciliation_owner_id': 'capture-staff-id',
        },
      ]);
      final migrated = (await OfflineQueue.debugAllRows()).single;
      expect(migrated['status'], 'needs_review');
      expect(migrated['review_reason_code'], 'contained_prescription_create');

      await AuthService.clearSessionIdentity();
      await OfflineQueue.resetForTesting();
      await AuthService.setStaffId('capture-staff-id');

      final after = (await OfflineQueue.debugAllRows()).single;
      expect(after['id'], 401);
      expect(after['body'], encrypted);
      expect(after['status'], 'needs_review');
      expect(after['review_reason_code'], 'contained_prescription_create');
    },
  );
}
