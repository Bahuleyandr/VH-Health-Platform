import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;

  setUp(() async {
    harness = OfflineQueueTestHarness('offline_queue_v5_migration');
    await harness.setUp();
  });

  tearDown(() => harness.tearDown());

  test('v1 fixture upgrades in place without losing row semantics', () async {
    const body = '{"patient_uid":"pt-v1","value":98}';
    await harness.createV1Fixture([
      {
        'id': 41,
        'endpoint': '/prescriptions/create',
        'method': 'POST',
        'body': body,
        'created_at': 1700000000041,
        'retry_count': 3,
        'context_label': 'Patient V1',
      },
    ]);

    final rows = await OfflineQueue.debugAllRows();
    expect(rows, hasLength(1));
    final row = rows.single;
    expect(row['id'], 41);
    expect(row['endpoint'], '/prescriptions/create');
    expect(row['method'], 'POST');
    expect(row['created_at'], 1700000000041);
    expect(row['retry_count'], 3);
    expect(row['idempotency_key'], isNull);
    expect(row['staff_id'], isNull);
    expect(row['tenant_id'], TenantConfig.id);
    expect(row['encryption_version'], 1);
    expect(row['status'], 'needs_review');
    expect(row['reconciliation_owner_id'], 'role:clinical_safety_lead');
    expect(
      await OfflineQueue.decodeBody(row['body'] as String),
      jsonDecode(body),
    );
    expect(
      await harness.decryptV1(row['context_label'] as String),
      'Patient V1',
    );
    expect(row['body'], isNot(body));
    expect(row['context_label'], isNot('Patient V1'));
  });

  test(
    'v4 fixture preserves fixed identity/order/conflict data semantically',
    () async {
      harness.installFixedEncryptionKey();
      final encryptedBody = await harness.encryptV1(
        '{"patient_uid":"pt-v4","draft":{"text":"keep"}}',
      );
      await harness.createV4Fixture([
        {
          'id': 77,
          'endpoint': '/emr/notes/draft',
          'method': 'PUT',
          'body': encryptedBody,
          'created_at': 1700000000077,
          'retry_count': 2,
          'context_label': 'Ward 7 / Patient V4',
          'status': 'conflict',
          'conflict_reason': 'Server has a newer draft',
          'idempotency_key': 'fixed-key-77',
          'staff_id': 'staff-77',
        },
      ]);

      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['id'], 77);
      expect(row['endpoint'], '/emr/notes/draft');
      expect(row['method'], 'PUT');
      expect(row['created_at'], 1700000000077);
      expect(row['retry_count'], 2);
      expect(row['status'], 'conflict');
      expect(row['idempotency_key'], 'fixed-key-77');
      expect(row['staff_id'], 'staff-77');
      expect(row['tenant_id'], TenantConfig.id);
      expect(row['reconciliation_owner_id'], 'staff-77');
      expect(row['encryption_version'], 1);
      expect(row['body'], encryptedBody);
      expect(await OfflineQueue.decodeBody(row['body'] as String), {
        'patient_uid': 'pt-v4',
        'draft': {'text': 'keep'},
      });
      expect(
        await harness.decryptV1(row['context_label'] as String),
        'Ward 7 / Patient V4',
      );
      expect(
        await harness.decryptV1(row['conflict_reason'] as String),
        'Server has a newer draft',
      );
    },
  );

  test(
    'all six v5 columns are present and guarded migration is idempotent',
    () async {
      await harness.createV4Fixture(const []);
      final db = await OfflineQueue.database;
      final before = await db.rawQuery('PRAGMA table_info(pending_writes)');
      await OfflineQueue.resetForTesting();
      await OfflineQueue.database;
      final after = await (await OfflineQueue.database).rawQuery(
        'PRAGMA table_info(pending_writes)',
      );
      final names = after.map((row) => row['name']).toSet();
      expect(
        names,
        containsAll(const [
          'tenant_id',
          'encryption_version',
          'review_reason_code',
          'reconciliation_owner_id',
          'handoff_attested_at',
          'handoff_attested_by',
        ]),
      );
      expect(after.length, before.length);
      expect(await OfflineQueue.debugAllRows(), isEmpty);
    },
  );

  test(
    'contained pending and conflict rows retain conflict evidence',
    () async {
      harness.installFixedEncryptionKey();
      final bodyA = await harness.encryptV1(
        '{"a":1}',
        nonce: List.filled(12, 3),
      );
      final bodyB = await harness.encryptV1(
        '{"b":2}',
        nonce: List.filled(12, 4),
      );
      await harness.createV4Fixture([
        {
          'id': 1,
          'endpoint': '/clinical/mar/11/administer-with-scan',
          'method': 'POST',
          'body': bodyA,
          'created_at': 1,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'mar-1',
          'staff_id': 'staff-a',
        },
        {
          'id': 2,
          'endpoint': '/emr/notes',
          'method': 'POST',
          'body': bodyB,
          'created_at': 2,
          'retry_count': 1,
          'status': 'conflict',
          'conflict_reason': 'Authoritative note changed',
          'idempotency_key': 'note-2',
          'staff_id': 'staff-a',
        },
      ]);

      final rows = await OfflineQueue.debugAllRows();
      expect(rows.map((row) => row['status']), everyElement('needs_review'));
      expect(rows.map((row) => row['review_reason_code']), [
        'contained_mar_administration',
        'contained_authoritative_note',
      ]);
      expect(
        await harness.decryptV1(rows[1]['conflict_reason'] as String),
        'Authoritative note changed',
      );
    },
  );

  test('retry_count six becomes typed needs_review without deletion', () async {
    await harness.createV4Fixture([
      {
        'id': 6,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': '{"value":120}',
        'created_at': 6,
        'retry_count': 6,
        'context_label': 'Vitals',
        'status': 'pending',
        'idempotency_key': 'retry-6',
        'staff_id': 'staff-6',
      },
    ]);

    final row = (await OfflineQueue.debugAllRows()).single;
    expect(row['retry_count'], 6);
    expect(row['status'], 'needs_review');
    expect(row['review_reason_code'], 'retry_exhausted');
    expect(row['id'], 6);
    expect(await OfflineQueue.decodeBody(row['body'] as String), {
      'value': 120,
    });
  });

  test(
    'missing key preserves ciphertext bytes and quarantines the row',
    () async {
      harness.installFixedEncryptionKey();
      final ciphertext = await harness.encryptV1('{"value":99}');
      harness.removeEncryptionKey();
      await harness.createV4Fixture([
        {
          'id': 8,
          'endpoint': '/health/records',
          'method': 'POST',
          'body': ciphertext,
          'created_at': 8,
          'retry_count': 0,
          'context_label': null,
          'status': 'pending',
          'idempotency_key': 'missing-key',
          'staff_id': 'staff-8',
        },
      ]);

      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['body'], ciphertext);
      expect(row['encryption_version'], isNull);
      expect(row['status'], 'needs_review');
      expect(row['review_reason_code'], 'unknown_encryption_version');
      expect(harness.storedEncryptionKey, isNull);
    },
  );

  test(
    'first enqueue cannot mint a key before missing-key upgrade inspection',
    () async {
      harness.installFixedEncryptionKey();
      final legacyCiphertext = await harness.encryptV1('{"legacy":true}');
      harness.removeEncryptionKey();
      await harness.createV4Fixture([
        {
          'id': 81,
          'endpoint': '/health/records',
          'method': 'POST',
          'body': legacyCiphertext,
          'created_at': 81,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'legacy-missing-key',
          'staff_id': 'staff-legacy',
        },
      ]);
      await AuthService.setStaffId('staff-new');

      await OfflineQueue.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {'new': true},
      );

      final rows = await OfflineQueue.debugAllRows();
      final legacy = rows.singleWhere((row) => row['id'] == 81);
      expect(legacy['body'], legacyCiphertext);
      expect(legacy['encryption_version'], isNull);
      expect(legacy['status'], 'needs_review');
      expect(legacy['review_reason_code'], 'unknown_encryption_version');
      expect(harness.storedEncryptionKey, isNotNull);
    },
  );

  test('corrupt ciphertext and future formats remain byte-preserved', () async {
    harness.installFixedEncryptionKey();
    final corrupt =
        '${base64Encode(List<int>.filled(12, 1))}:'
        '${base64Encode(List<int>.filled(32, 2))}';
    await harness.createV5Fixture([
      {
        'id': 9,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': corrupt,
        'created_at': 9,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'corrupt',
        'staff_id': 'staff-9',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
        'reconciliation_owner_id': 'staff-9',
      },
      {
        'id': 10,
        'endpoint': '/emr/notes/draft',
        'method': 'PUT',
        'body': 'v2:future-envelope-bytes',
        'created_at': 10,
        'retry_count': 0,
        'status': 'pending',
        'idempotency_key': 'future',
        'staff_id': 'staff-9',
        'tenant_id': TenantConfig.id,
        'encryption_version': 2,
        'reconciliation_owner_id': 'staff-9',
      },
    ]);

    final rows = await OfflineQueue.debugAllRows();
    expect(rows[0]['body'], corrupt);
    expect(rows[0]['encryption_version'], isNull);
    expect(rows[0]['status'], 'needs_review');
    expect(rows[0]['review_reason_code'], 'decrypt_failed');
    expect(rows[1]['body'], 'v2:future-envelope-bytes');
    expect(rows[1]['encryption_version'], isNull);
    expect(rows[1]['status'], 'needs_review');
    expect(rows[1]['review_reason_code'], 'unknown_encryption_version');
  });

  test(
    'unknown owner uses fallback principal without login attribution',
    () async {
      await harness.createV4Fixture([
        {
          'id': 12,
          'endpoint': '/emr/notes/draft',
          'method': 'PUT',
          'body': '{"text":"legacy"}',
          'created_at': 12,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'unknown-owner',
          'staff_id': null,
        },
      ]);

      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['staff_id'], isNull);
      expect(row['reconciliation_owner_id'], 'role:clinical_safety_lead');
      expect(row['status'], 'needs_review');
      expect(row['review_reason_code'], 'unknown_owner');
    },
  );

  test(
    'unknown tenant and owner use the configured namespace fallback',
    () async {
      harness.installFixedEncryptionKey();
      final encryptedBody = await harness.encryptV1('{"text":"legacy"}');
      await harness.createV5Fixture([
        {
          'id': 13,
          'endpoint': '/emr/notes/draft',
          'method': 'PUT',
          'body': encryptedBody,
          'created_at': 13,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'unknown-metadata',
          'staff_id': null,
          'tenant_id': 'untrusted-tenant',
          'encryption_version': 1,
        },
      ]);

      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['tenant_id'], 'untrusted-tenant');
      expect(row['staff_id'], isNull);
      expect(row['reconciliation_owner_id'], 'role:clinical_safety_lead');
      expect(row['status'], 'needs_review');
      expect(row['review_reason_code'], 'unknown_tenant');
    },
  );
}
