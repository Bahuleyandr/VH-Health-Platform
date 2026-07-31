import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;

  setUp(() async {
    harness = OfflineQueueTestHarness('offline_queue_v6_migration');
    await harness.setUp();
    harness.installFixedEncryptionKey();
  });

  tearDown(() => harness.tearDown());

  test(
    'authentic v4 fixture converges without identity or body loss',
    () async {
      final body = await harness.encryptV1(
        '{"patient_uid":"patient-v4","content":{"note":"retain"}}',
      );
      final context = await harness.encryptV1(
        'Patient V4',
        nonce: List<int>.filled(12, 8),
      );
      await harness.createV4Fixture([
        {
          'id': 401,
          'endpoint': '/emr/notes/draft',
          'method': 'PUT',
          'body': body,
          'created_at': 1700000000401,
          'retry_count': 2,
          'context_label': context,
          'status': 'pending',
          'idempotency_key': 'v4-preserved-key',
          'staff_id': 'staff-v4',
        },
      ]);

      final db = await OfflineQueue.database;
      final row = (await db.query('pending_writes')).single;
      expect(row['id'], 401);
      expect(row['body'], body);
      expect(row['context_label'], context);
      expect(row['staff_id'], 'staff-v4');
      expect(row['idempotency_key'], 'v4-preserved-key');
      expect(row['created_at'], 1700000000401);
      expect(row['retry_count'], 2);
      expect(row['tenant_id'], TenantConfig.id);
      expect(row['envelope_ready'], 0);
      expect(row['client_event_id'], isNotNull);
      expect(row['action_id'], 'emr.nursing_note.draft.store');
      await _expectCompleteV6Schema(db);

      final firstEventCount = await _count(db, 'offline_write_state_events');
      await OfflineQueue.resetForTesting();
      final reopened = await OfflineQueue.database;
      expect((await reopened.query('pending_writes')).single['body'], body);
      expect(
        await _count(reopened, 'offline_write_state_events'),
        firstEventCount,
      );
      await _expectCompleteV6Schema(reopened);
    },
  );

  test('authentic v5 fixture preserves owner, key, and attestation', () async {
    final body = await harness.encryptV1(
      '{"patient_id":52,"vital_signs":{"pulse":72}}',
    );
    final context = await harness.encryptV1(
      'Vitals patient 52',
      nonce: List<int>.filled(12, 9),
    );
    await harness.createV5Fixture([
      {
        'id': 502,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': body,
        'created_at': 1700000000502,
        'retry_count': 6,
        'context_label': context,
        'status': 'needs_review',
        'idempotency_key': 'v5-preserved-key',
        'staff_id': 'staff-v5',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
        'review_reason_code': 'retry_exhausted',
        'reconciliation_owner_id': 'staff-v5',
        'handoff_attested_at': 1700000000600,
        'handoff_attested_by': 'actor-v5',
      },
    ]);

    final db = await OfflineQueue.database;
    final row = (await db.query('pending_writes')).single;
    expect(row['id'], 502);
    expect(row['body'], body);
    expect(row['context_label'], context);
    expect(row['staff_id'], 'staff-v5');
    expect(row['idempotency_key'], 'v5-preserved-key');
    expect(row['review_reason_code'], 'retry_exhausted');
    expect(row['handoff_attested_at'], 1700000000600);
    expect(row['handoff_attested_by'], 'actor-v5');
    expect(row['status'], 'needs_review');
    expect(row['action_id'], 'vitals.capture');
    await _expectCompleteV6Schema(db);
  });

  test(
    'partially upgraded database repairs columns, indexes, and both tables',
    () async {
      final body = await harness.encryptV1('{"patient_id":603}');
      await harness.createV5Fixture([
        {
          'id': 603,
          'endpoint': '/health/records',
          'method': 'POST',
          'body': body,
          'created_at': 1700000000603,
          'retry_count': 1,
          'status': 'pending',
          'idempotency_key': 'partial-preserved-key',
          'staff_id': 'staff-partial',
          'tenant_id': TenantConfig.id,
          'encryption_version': 1,
          'reconciliation_owner_id': 'staff-partial',
        },
      ]);
      final path = await harness.databasePath;
      final partial = await sqflite.openDatabase(path);
      await partial.execute(
        'ALTER TABLE pending_writes ADD COLUMN client_event_id TEXT',
      );
      await partial.execute(
        'ALTER TABLE pending_writes ADD COLUMN action_id TEXT',
      );
      await partial.execute(
        'ALTER TABLE pending_writes ADD COLUMN envelope_ready '
        'INTEGER DEFAULT 0',
      );
      await partial.execute('PRAGMA user_version = 6');
      await partial.close();
      await OfflineQueue.resetForTesting();

      final db = await OfflineQueue.database;
      final row = (await db.query('pending_writes')).single;
      expect(row['id'], 603);
      expect(row['body'], body);
      expect(row['staff_id'], 'staff-partial');
      expect(row['idempotency_key'], 'partial-preserved-key');
      await _expectCompleteV6Schema(db);
      final schemaBefore = await _schemaSnapshot(db);
      final eventsBefore = await _count(db, 'offline_write_state_events');

      await OfflineQueue.resetForTesting();
      final reopened = await OfflineQueue.database;
      expect(await _schemaSnapshot(reopened), schemaBefore);
      expect(
        await _count(reopened, 'offline_write_state_events'),
        eventsBefore,
      );
      final reopenedRow = (await reopened.query('pending_writes')).single;
      expect(reopenedRow['id'], 603);
      expect(reopenedRow['body'], body);
      expect(reopenedRow['idempotency_key'], 'partial-preserved-key');
    },
  );

  test('missing and duplicate legacy keys are retained for review', () async {
    final firstBody = await harness.encryptV1('{"patient_id":1}');
    final secondBody = await harness.encryptV1(
      '{"patient_id":2}',
      nonce: List<int>.filled(12, 10),
    );
    final thirdBody = await harness.encryptV1(
      '{"patient_id":3}',
      nonce: List<int>.filled(12, 11),
    );
    await harness.createV5Fixture([
      {
        'id': 1,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': firstBody,
        'created_at': 1,
        'status': 'pending',
        'staff_id': 'staff-a',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
      },
      {
        'id': 2,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': secondBody,
        'created_at': 2,
        'status': 'pending',
        'idempotency_key': 'duplicate-key',
        'staff_id': 'staff-a',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
      },
      {
        'id': 3,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': thirdBody,
        'created_at': 3,
        'status': 'pending',
        'idempotency_key': 'duplicate-key',
        'staff_id': 'staff-a',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
      },
    ]);

    final rows = await (await OfflineQueue.database).query(
      'pending_writes',
      orderBy: 'id',
    );
    expect(rows, hasLength(3));
    expect(rows.map((row) => row['body']), [firstBody, secondBody, thirdBody]);
    expect(rows.map((row) => row['status']), everyElement('needs_review'));
    expect(
      rows.map((row) => row['review_reason_code']),
      everyElement('legacy_identity_incomplete'),
    );
    expect(rows[0]['idempotency_key'], isNull);
    expect(rows[1]['idempotency_key'], 'duplicate-key');
    expect(rows[2]['idempotency_key'], 'duplicate-key');
  });

  test('interrupted v5 upgrade rolls back schema and row mutations', () async {
    final body = await harness.encryptV1('{"patient_id":704,"pulse":70}');
    await harness.createV5Fixture([
      {
        'id': 704,
        'endpoint': '/health/records',
        'method': 'POST',
        'body': body,
        'created_at': 1700000000704,
        'status': 'pending',
        'idempotency_key': 'rollback-key',
        'staff_id': 'staff-rollback',
        'tenant_id': TenantConfig.id,
        'encryption_version': 1,
        'reconciliation_owner_id': 'staff-rollback',
      },
    ]);
    final path = await harness.databasePath;
    var raw = await sqflite.openDatabase(path);
    await raw.execute('''
      CREATE TABLE offline_write_state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT UNIQUE,
        pending_write_id INTEGER,
        client_event_id TEXT,
        event_at INTEGER NOT NULL,
        actor_uid TEXT,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        detail_ciphertext TEXT,
        encryption_version INTEGER
      )
    ''');
    await raw.execute('''
      CREATE TRIGGER interrupt_v6_migration
      BEFORE INSERT ON offline_write_state_events
      BEGIN
        SELECT RAISE(FAIL, 'simulated interrupted upgrade');
      END
    ''');
    await raw.close();
    await OfflineQueue.resetForTesting();

    await expectLater(OfflineQueue.database, throwsA(anything));
    await OfflineQueue.resetForTesting();
    raw = await sqflite.openDatabase(path);
    final columns = (await raw.rawQuery(
      'PRAGMA table_info(pending_writes)',
    )).map((row) => row['name']).toSet();
    final retained = (await raw.query('pending_writes')).single;
    expect(columns, isNot(contains('client_event_id')));
    expect(retained['id'], 704);
    expect(retained['body'], body);
    expect(retained['staff_id'], 'staff-rollback');
    expect(retained['idempotency_key'], 'rollback-key');

    await raw.execute('DROP TRIGGER interrupt_v6_migration');
    await raw.close();
    await OfflineQueue.resetForTesting();
    final recovered = await OfflineQueue.database;
    expect((await recovered.query('pending_writes')).single['body'], body);
    await _expectCompleteV6Schema(recovered);
  });
}

Future<int> _count(sqflite.Database db, String table) async {
  final result = await db.rawQuery('SELECT COUNT(*) AS count FROM $table');
  return result.single['count'] as int;
}

Future<void> _expectCompleteV6Schema(sqflite.Database db) async {
  final pendingColumns = (await db.rawQuery(
    'PRAGMA table_info(pending_writes)',
  )).map((row) => row['name']).toSet();
  expect(
    pendingColumns,
    containsAll(const [
      'client_event_id',
      'action_id',
      'command_fingerprint',
      'payload_hash',
      'envelope_ciphertext',
      'envelope_schema_version',
      'envelope_ready',
      'ordering_key_digest',
      'sequence_no',
      'predecessor_client_event_id',
      'supersession_generation',
      'human_review_required',
      'lease_id',
      'lease_expires_at',
      'next_attempt_at',
      'attempt_count',
      'last_attempt_at',
      'applied_at',
      'state_reason_code',
    ]),
  );
  final tables = (await db.rawQuery(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  )).map((row) => row['name']).toSet();
  expect(
    tables,
    containsAll(const [
      'pending_writes',
      'offline_write_sequences',
      'offline_write_state_events',
    ]),
  );
  final indexes = (await db.rawQuery(
    "SELECT name FROM sqlite_master WHERE type = 'index'",
  )).map((row) => row['name']).toSet();
  expect(
    indexes,
    containsAll(const [
      'ux_pending_writes_client_event_id',
      'ux_pending_writes_ready_idempotency',
      'ix_pending_writes_v6_due',
      'ix_offline_state_events_command',
    ]),
  );
}

Future<Map<String, Set<Object?>>> _schemaSnapshot(sqflite.Database db) async {
  return {
    'pending': (await db.rawQuery(
      'PRAGMA table_info(pending_writes)',
    )).map((row) => row['name']).toSet(),
    'sequence': (await db.rawQuery(
      'PRAGMA table_info(offline_write_sequences)',
    )).map((row) => row['name']).toSet(),
    'events': (await db.rawQuery(
      'PRAGMA table_info(offline_write_state_events)',
    )).map((row) => row['name']).toSet(),
    'indexes': (await db.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    )).map((row) => row['name']).toSet(),
  };
}
