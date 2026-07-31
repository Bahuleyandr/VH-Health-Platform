import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

import '../config/tenant_config.dart';
import '../models/offline_command_envelope.dart';
import '../models/offline_write_entry.dart';
import 'auth_service.dart';
import 'idempotency_key.dart';
import 'offline_action_ids.dart';
import 'offline_command_codec.dart';
import 'offline_write_containment.dart';
import 'secure_storage.dart';

typedef OfflineQueueTenantIdResolver = String? Function();
typedef OfflineQueueReconciliationOwnerResolver =
    String? Function(String tenantId);
typedef OfflineQueueCurrentActorUidResolver = Future<String?> Function();
typedef OfflineQueueCurrentActorRoleResolver = Future<String?> Function();

class OfflineWriteRejected implements Exception {
  const OfflineWriteRejected(this.reasonCode);

  final String reasonCode;

  @override
  String toString() => 'OfflineWriteRejected($reasonCode)';
}

/// SQLite-backed, owner-bound clinical command journal.
///
/// C4-ready commands use immutable action envelopes and the seven-state v6
/// machine. The temporary C0A endpoint facade remains fail-closed and is never
/// accepted as C4 execution authority.
class OfflineQueue {
  OfflineQueue._();

  static const int schemaVersion = 6;
  static const int currentEncryptionVersion = 1;
  static const int maxRetryCount = 6;
  static const String fallbackReconciliationRole = 'role:clinical_safety_lead';
  static const Duration leaseDuration = Duration(seconds: 90);
  static const Duration retryBaseDelay = Duration(seconds: 2);
  static const Duration retryMaximumDelay = Duration(minutes: 5);
  static const String _c4EndpointSentinel = 'c4-action';
  static const String _c4MethodSentinel = 'ACTION';

  static Database? _db;
  static Future<Database>? _dbOpening;
  static SecretKey? _aesKey;
  static final AesGcm _aesGcm = AesGcm.with256bits();
  static OfflineQueueTenantIdResolver? _tenantIdResolver;
  static OfflineQueueReconciliationOwnerResolver? _reconciliationOwnerResolver;
  static OfflineQueueCurrentActorUidResolver? _currentActorUidResolver;
  static OfflineQueueCurrentActorRoleResolver? _currentActorRoleResolver;

  @visibleForTesting
  static String? debugDbFileNameOverride;

  static String get _expectedDbFileName => TenantConfig.isDefaultTenant
      ? 'offline_queue.db'
      : 'offline_queue_${TenantConfig.cacheNamespace}.db';

  static String get dbFileName =>
      debugDbFileNameOverride ?? _expectedDbFileName;

  static String get _keyName => TenantConfig.isDefaultTenant
      ? 'offline_queue_aes_key'
      : 'offline_queue_aes_key_${TenantConfig.cacheNamespace}';

  @visibleForTesting
  static String get debugEncryptionKeyName => _keyName;

  @visibleForTesting
  static void debugDropCachedEncryptionKey() {
    _aesKey = null;
  }

  /// Registers the Staff application's tenant-specific C0A metadata contract.
  ///
  /// There is intentionally no fallback principal default in this package.
  /// The tenant resolver must return the build-stamped [TenantConfig.id], and
  /// the reconciliation resolver must explicitly return the recorded stable
  /// role code for that tenant.
  static void registerMetadataResolvers({
    required OfflineQueueTenantIdResolver tenantIdResolver,
    required OfflineQueueReconciliationOwnerResolver
    reconciliationOwnerResolver,
    OfflineQueueCurrentActorUidResolver? currentActorUidResolver,
    OfflineQueueCurrentActorRoleResolver? currentActorRoleResolver,
  }) {
    _tenantIdResolver = tenantIdResolver;
    _reconciliationOwnerResolver = reconciliationOwnerResolver;
    _currentActorUidResolver = currentActorUidResolver;
    _currentActorRoleResolver = currentActorRoleResolver;
  }

  static String? _validatedTenantId() {
    try {
      final value = _tenantIdResolver?.call();
      if (value == null || value.isEmpty || value != TenantConfig.id) {
        return null;
      }
      if (debugDbFileNameOverride == null &&
          dbFileName != _expectedDbFileName) {
        return null;
      }
      return value;
    } catch (_) {
      return null;
    }
  }

  static String? _fallbackOwnerFor(String tenantId) {
    try {
      final value = _reconciliationOwnerResolver?.call(tenantId);
      return value == fallbackReconciliationRole ? value : null;
    } catch (_) {
      return null;
    }
  }

  static Future<SecretKey?> _readEncryptionKey({
    required bool createIfMissing,
  }) async {
    if (_aesKey != null) return _aesKey;
    final storage = VHSecureStorage.instance;
    var keyBase64 = await storage.read(key: _keyName);
    if (keyBase64 == null) {
      if (!createIfMissing) return null;
      final bytes = _secureRandomBytes(32);
      keyBase64 = base64Encode(bytes);
      await storage.write(key: _keyName, value: keyBase64);
    }
    try {
      final bytes = base64Decode(keyBase64);
      if (bytes.length != 32) return null;
      _aesKey = SecretKey(bytes);
      return _aesKey;
    } catch (_) {
      return null;
    }
  }

  static Uint8List _secureRandomBytes(int length) {
    final random = Random.secure();
    final bytes = Uint8List(length);
    for (var i = 0; i < length; i++) {
      bytes[i] = random.nextInt(256);
    }
    return bytes;
  }

  static Future<String> _encryptWithKey(
    String plaintext,
    SecretKey key, {
    List<int> authenticatedData = const [],
  }) async {
    final nonce = _secureRandomBytes(12);
    final box = await _aesGcm.encrypt(
      utf8.encode(plaintext),
      secretKey: key,
      nonce: nonce,
      aad: authenticatedData,
    );
    final combined = Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
    return '${base64Encode(nonce)}:${base64Encode(combined)}';
  }

  static Future<String> _decryptWithKey(
    String ciphertext,
    SecretKey key, {
    List<int> authenticatedData = const [],
  }) async {
    final parts = ciphertext.split(':');
    if (parts.length != 2) {
      throw const FormatException('Unrecognized offline encryption envelope');
    }
    final nonce = base64Decode(parts[0]);
    final combined = base64Decode(parts[1]);
    if (nonce.length != 12 || combined.length < 16) {
      throw const FormatException('Unrecognized offline encryption envelope');
    }
    final cipherText = combined.sublist(0, combined.length - 16);
    final mac = Mac(combined.sublist(combined.length - 16));
    final plain = await _aesGcm.decrypt(
      SecretBox(cipherText, nonce: nonce, mac: mac),
      secretKey: key,
      aad: authenticatedData,
    );
    return utf8.decode(plain);
  }

  static bool _looksLikeV1Envelope(String value) {
    final parts = value.split(':');
    if (parts.length != 2) return false;
    try {
      return base64Decode(parts[0]).length == 12 &&
          base64Decode(parts[1]).length >= 16;
    } catch (_) {
      return false;
    }
  }

  static Future<String> _encrypt(String plaintext) async {
    final key = await _readEncryptionKey(createIfMissing: true);
    if (key == null) {
      throw const OfflineWriteRejected('unknown_encryption_version');
    }
    return _encryptWithKey(plaintext, key);
  }

  /// Strict post-v5 decoding. Plaintext fallback exists only inside migration.
  static Future<Map<String, dynamic>> decodeBody(
    String stored, {
    int encryptionVersion = currentEncryptionVersion,
  }) async {
    if (encryptionVersion != currentEncryptionVersion) {
      throw const OfflineWriteRejected('unknown_encryption_version');
    }
    final key = await _readEncryptionKey(createIfMissing: false);
    if (key == null) {
      throw const OfflineWriteRejected('unknown_encryption_version');
    }
    final decoded = jsonDecode(await _decryptWithKey(stored, key));
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Offline write body must be a JSON object');
    }
    return decoded;
  }

  static Future<String?> _decodeOptionalField(
    Object? stored, {
    required int? encryptionVersion,
  }) async {
    if (stored == null) return null;
    if (encryptionVersion != currentEncryptionVersion) {
      throw const OfflineWriteRejected('unknown_encryption_version');
    }
    final key = await _readEncryptionKey(createIfMissing: false);
    if (key == null) {
      throw const OfflineWriteRejected('unknown_encryption_version');
    }
    return _decryptWithKey(stored as String, key);
  }

  static Future<Database> get database async {
    final existing = _db;
    if (existing != null) return existing;
    final inFlight = _dbOpening;
    if (inFlight != null) return inFlight;

    final opening = _initDb();
    _dbOpening = opening;
    try {
      final opened = await opening;
      _db = opened;
      return opened;
    } finally {
      if (identical(_dbOpening, opening)) {
        _dbOpening = null;
      }
    }
  }

  static Future<Database> _initDb() async {
    final dbPath = await getDatabasesPath();
    return openDatabase(
      join(dbPath, dbFileName),
      version: schemaVersion,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE pending_writes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint TEXT NOT NULL,
            method TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            retry_count INTEGER DEFAULT 0,
            context_label TEXT,
            status TEXT DEFAULT 'pending',
            conflict_reason TEXT,
            idempotency_key TEXT,
            staff_id TEXT,
            tenant_id TEXT,
            encryption_version INTEGER,
            review_reason_code TEXT,
            reconciliation_owner_id TEXT,
            handoff_attested_at INTEGER,
            handoff_attested_by TEXT,
            client_event_id TEXT,
            action_id TEXT,
            command_fingerprint TEXT,
            payload_hash TEXT,
            envelope_ciphertext TEXT,
            envelope_schema_version INTEGER,
            envelope_ready INTEGER DEFAULT 0,
            ordering_key_digest TEXT,
            sequence_no INTEGER,
            predecessor_client_event_id TEXT,
            supersession_generation INTEGER DEFAULT 0,
            human_review_required INTEGER DEFAULT 0,
            lease_id TEXT,
            lease_expires_at INTEGER,
            next_attempt_at INTEGER,
            attempt_count INTEGER DEFAULT 0,
            last_attempt_at INTEGER,
            applied_at INTEGER,
            state_reason_code TEXT
          )
        ''');
        await _ensureV6Tables(db);
        await _ensureV6Indexes(db);
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        await _migrateToV6(db);
      },
      onOpen: (db) async {
        await db.transaction((txn) => _migrateToV6(txn));
      },
    );
  }

  static const Map<String, String> _columnsThroughV5 = {
    'status': "TEXT DEFAULT 'pending'",
    'conflict_reason': 'TEXT',
    'idempotency_key': 'TEXT',
    'staff_id': 'TEXT',
    'tenant_id': 'TEXT',
    'encryption_version': 'INTEGER',
    'review_reason_code': 'TEXT',
    'reconciliation_owner_id': 'TEXT',
    'handoff_attested_at': 'INTEGER',
    'handoff_attested_by': 'TEXT',
  };

  static const Map<String, String> _columnsForV6 = {
    'client_event_id': 'TEXT',
    'action_id': 'TEXT',
    'command_fingerprint': 'TEXT',
    'payload_hash': 'TEXT',
    'envelope_ciphertext': 'TEXT',
    'envelope_schema_version': 'INTEGER',
    'envelope_ready': 'INTEGER DEFAULT 0',
    'ordering_key_digest': 'TEXT',
    'sequence_no': 'INTEGER',
    'predecessor_client_event_id': 'TEXT',
    'supersession_generation': 'INTEGER DEFAULT 0',
    'human_review_required': 'INTEGER DEFAULT 0',
    'lease_id': 'TEXT',
    'lease_expires_at': 'INTEGER',
    'next_attempt_at': 'INTEGER',
    'attempt_count': 'INTEGER DEFAULT 0',
    'last_attempt_at': 'INTEGER',
    'applied_at': 'INTEGER',
    'state_reason_code': 'TEXT',
  };

  static Future<void> _migrateToV6(DatabaseExecutor db) async {
    final info = await db.rawQuery('PRAGMA table_info(pending_writes)');
    if (info.isEmpty) return;
    final columns = info.map((row) => row['name'] as String).toSet();
    for (final entry in {..._columnsThroughV5, ..._columnsForV6}.entries) {
      if (!columns.contains(entry.key)) {
        await db.execute(
          'ALTER TABLE pending_writes ADD COLUMN ${entry.key} ${entry.value}',
        );
      }
    }

    await _ensureV6Tables(db);
    final rows = await db.query('pending_writes', orderBy: pendingDrainOrderBy);
    for (final row in rows) {
      await _migrateRow(db, row);
    }
    await _ensureV6Indexes(db);
  }

  static Future<void> _ensureV6Tables(DatabaseExecutor db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS offline_write_sequences (
        partition_key TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS offline_write_state_events (
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
    await _ensureColumns(db, 'offline_write_sequences', const {
      'partition_key': 'TEXT',
      'next_sequence': 'INTEGER',
    });
    await _ensureColumns(db, 'offline_write_state_events', const {
      'event_key': 'TEXT',
      'pending_write_id': 'INTEGER',
      'client_event_id': 'TEXT',
      'event_at': 'INTEGER',
      'actor_uid': 'TEXT',
      'from_state': 'TEXT',
      'to_state': 'TEXT',
      'reason_code': 'TEXT',
      'detail_ciphertext': 'TEXT',
      'encryption_version': 'INTEGER',
    });
  }

  static Future<void> _ensureV6Indexes(DatabaseExecutor db) async {
    await db.execute('''
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_writes_client_event_id
      ON pending_writes(client_event_id)
      WHERE envelope_ready = 1 AND client_event_id IS NOT NULL
    ''');
    await db.execute('''
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_writes_ready_idempotency
      ON pending_writes(tenant_id, staff_id, idempotency_key)
      WHERE envelope_ready = 1 AND idempotency_key IS NOT NULL
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_pending_writes_v6_due
      ON pending_writes(
        tenant_id,
        staff_id,
        status,
        next_attempt_at,
        lease_expires_at,
        ordering_key_digest,
        sequence_no
      )
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_offline_state_events_command
      ON offline_write_state_events(client_event_id, event_at, id)
    ''');
  }

  static Future<void> _ensureColumns(
    DatabaseExecutor db,
    String table,
    Map<String, String> expected,
  ) async {
    final info = await db.rawQuery('PRAGMA table_info($table)');
    final present = info.map((row) => row['name'] as String).toSet();
    for (final entry in expected.entries) {
      if (!present.contains(entry.key)) {
        await db.execute(
          'ALTER TABLE $table ADD COLUMN ${entry.key} ${entry.value}',
        );
      }
    }
  }

  static Future<void> _migrateRow(
    DatabaseExecutor db,
    Map<String, Object?> row,
  ) async {
    if (row['envelope_ready'] == 1) {
      await _validateReadyV6Row(db, row);
      return;
    }
    final id = row['id'] as int;
    final storedBody = row['body'] as String;
    final updates = <String, Object?>{};
    final validTenantId = _validatedTenantId();
    final storedTenantId = _nonEmptyString(row['tenant_id']);
    final staffId = _nonEmptyString(row['staff_id']);
    var tenantId = storedTenantId;
    var reconciliationOwnerId = _nonEmptyString(row['reconciliation_owner_id']);
    var encryptionVersion = row['encryption_version'] as int?;
    Map<String, dynamic>? decodedBody;
    OfflineWriteReviewReason? safetyFailure;

    if (tenantId == null && validTenantId != null) {
      tenantId = validTenantId;
      updates['tenant_id'] = tenantId;
    }
    if (tenantId == null ||
        validTenantId == null ||
        tenantId != validTenantId) {
      safetyFailure = OfflineWriteReviewReason.unknownTenant;
    }

    if (staffId != null) {
      if (reconciliationOwnerId != staffId) {
        reconciliationOwnerId = staffId;
        updates['reconciliation_owner_id'] = staffId;
      }
    } else {
      final fallback = validTenantId == null
          ? null
          : _fallbackOwnerFor(validTenantId);
      if (fallback != null && reconciliationOwnerId != fallback) {
        reconciliationOwnerId = fallback;
        updates['reconciliation_owner_id'] = fallback;
      }
      safetyFailure ??= OfflineWriteReviewReason.unknownOwner;
    }

    SecretKey? key = await _readEncryptionKey(createIfMissing: false);
    if (encryptionVersion == currentEncryptionVersion) {
      if (key == null) {
        safetyFailure = OfflineWriteReviewReason.unknownEncryptionVersion;
        encryptionVersion = null;
        updates['encryption_version'] = null;
      } else {
        try {
          final plain = await _decryptWithKey(storedBody, key);
          final decoded = jsonDecode(plain);
          if (decoded is! Map<String, dynamic>) {
            throw const FormatException('Body is not a JSON object');
          }
          decodedBody = decoded;
        } catch (_) {
          safetyFailure = OfflineWriteReviewReason.decryptFailed;
          encryptionVersion = null;
          updates['encryption_version'] = null;
        }
      }
    } else if (encryptionVersion != null) {
      safetyFailure = OfflineWriteReviewReason.unknownEncryptionVersion;
      encryptionVersion = null;
      updates['encryption_version'] = null;
    } else if (_looksLikeV1Envelope(storedBody)) {
      if (key == null) {
        safetyFailure = OfflineWriteReviewReason.unknownEncryptionVersion;
      } else {
        try {
          final plain = await _decryptWithKey(storedBody, key);
          final decoded = jsonDecode(plain);
          if (decoded is! Map<String, dynamic>) {
            throw const FormatException('Body is not a JSON object');
          }
          decodedBody = decoded;
          encryptionVersion = currentEncryptionVersion;
          updates['encryption_version'] = currentEncryptionVersion;
        } catch (_) {
          safetyFailure = OfflineWriteReviewReason.decryptFailed;
          encryptionVersion = null;
          updates['encryption_version'] = null;
        }
      }
    } else {
      try {
        final decoded = jsonDecode(storedBody);
        if (decoded is! Map<String, dynamic>) {
          throw const FormatException('Body is not a JSON object');
        }
        decodedBody = decoded;
        key ??= await _readEncryptionKey(createIfMissing: true);
        if (key == null) {
          throw const OfflineWriteRejected('unknown_encryption_version');
        }
        final encrypted = await _encryptWithKey(storedBody, key);
        final roundTrip = await _decryptWithKey(encrypted, key);
        if (roundTrip != storedBody) {
          throw const FormatException('Offline encryption round-trip failed');
        }
        updates['body'] = encrypted;
        encryptionVersion = currentEncryptionVersion;
        updates['encryption_version'] = currentEncryptionVersion;
      } catch (_) {
        safetyFailure ??= OfflineWriteReviewReason.unknownEncryptionVersion;
      }
    }

    if (key != null && encryptionVersion == currentEncryptionVersion) {
      for (final column in const ['context_label', 'conflict_reason']) {
        final value = row[column] as String?;
        if (value == null) continue;
        if (_looksLikeV1Envelope(value)) {
          try {
            await _decryptWithKey(value, key);
          } catch (_) {
            safetyFailure = OfflineWriteReviewReason.decryptFailed;
            encryptionVersion = null;
            updates['encryption_version'] = null;
          }
          continue;
        }
        try {
          final encrypted = await _encryptWithKey(value, key);
          if (await _decryptWithKey(encrypted, key) != value) {
            throw const FormatException('Offline encryption round-trip failed');
          }
          updates[column] = encrypted;
        } catch (_) {
          safetyFailure = OfflineWriteReviewReason.decryptFailed;
          encryptionVersion = null;
          updates['encryption_version'] = null;
        }
      }
    } else if (row['context_label'] != null || row['conflict_reason'] != null) {
      safetyFailure ??= OfflineWriteReviewReason.unknownEncryptionVersion;
    }

    final classification = OfflineWriteContainment.classify(
      method: row['method'] as String,
      path: row['endpoint'] as String,
    );
    final retryCount = row['retry_count'] as int? ?? 0;
    final storedStatus = row['status'] as String? ?? 'pending';
    var reason = safetyFailure;
    reason ??= retryCount >= maxRetryCount
        ? OfflineWriteReviewReason.retryExhausted
        : null;
    reason ??= classification.isControl ? null : classification.reviewReason;

    final existingReason = OfflineWriteReviewReason.fromCode(
      row['review_reason_code'] as String?,
    );
    final alreadyNeedsReview = storedStatus == 'needs_review';
    final existingStateReason = _nonEmptyString(row['state_reason_code']);
    final isLegacyConflict =
        alreadyNeedsReview && existingStateReason == 'legacy_conflict';
    if (reason != null) {
      updates['status'] = 'needs_review';
      updates['review_reason_code'] = reason.code;
    } else if (isLegacyConflict) {
      updates['status'] = OfflineCommandState.needsReview.value;
      updates['state_reason_code'] = 'legacy_conflict';
    } else if (alreadyNeedsReview) {
      updates['status'] = 'needs_review';
      updates['review_reason_code'] =
          existingReason?.code ?? OfflineWriteReviewReason.unknownAction.code;
    } else if (storedStatus == 'conflict') {
      updates['status'] = OfflineCommandState.needsReview.value;
      updates['state_reason_code'] = 'legacy_conflict';
    } else if (storedStatus != 'pending') {
      updates['status'] = 'needs_review';
      updates['review_reason_code'] =
          OfflineWriteReviewReason.unknownAction.code;
    }

    final storedIdempotencyKey = _nonEmptyString(row['idempotency_key']);
    var legacyIdentityIncomplete = storedIdempotencyKey == null;
    if (storedIdempotencyKey != null) {
      final duplicateKeys = await db.query(
        'pending_writes',
        columns: ['id'],
        where: 'id <> ? AND idempotency_key = ?',
        whereArgs: [id, storedIdempotencyKey],
        limit: 1,
      );
      legacyIdentityIncomplete = duplicateKeys.isNotEmpty;
    }
    if (legacyIdentityIncomplete) {
      updates['status'] = OfflineCommandState.needsReview.value;
      updates['review_reason_code'] = 'legacy_identity_incomplete';
      updates['state_reason_code'] = 'legacy_identity_incomplete';
    }

    final actionId =
        _nonEmptyString(row['action_id']) ??
        OfflineActionIds.fromLegacyControl(
          method: row['method'] as String,
          path: row['endpoint'] as String,
          body: decodedBody ?? const {},
        );
    final clientEventId =
        _nonEmptyString(row['client_event_id']) ?? IdempotencyKey.generate();
    updates['client_event_id'] = clientEventId;
    updates['action_id'] = actionId;
    updates['envelope_ready'] = 0;
    updates['envelope_schema_version'] = null;
    updates['supersession_generation'] =
        row['supersession_generation'] as int? ?? 0;
    updates['human_review_required'] =
        row['human_review_required'] as int? ?? 0;
    final storedAttemptCount = row['attempt_count'] as int? ?? 0;
    updates['attempt_count'] = max(
      storedAttemptCount,
      row['retry_count'] as int? ?? 0,
    );
    if (decodedBody != null) {
      final payloadHash = await OfflineCommandCodec.hashCanonical(decodedBody);
      updates['payload_hash'] =
          _nonEmptyString(row['payload_hash']) ?? payloadHash;
      updates['command_fingerprint'] =
          _nonEmptyString(row['command_fingerprint']) ??
          await OfflineCommandCodec.hashCanonical({
            'action_id': actionId,
            'capture_owner': staffId,
            'captured_at': row['created_at'],
            'payload_hash': payloadHash,
            'tenant_id': tenantId,
          });
    }
    updates['state_reason_code'] ??=
        existingStateReason ??
        (updates['review_reason_code'] ?? row['review_reason_code']) as String?;

    if (updates.isNotEmpty) {
      await db.update(
        'pending_writes',
        updates,
        where: 'id = ?',
        whereArgs: [id],
      );
    }
    final toState =
        updates['status'] as String? ??
        (storedStatus == 'conflict'
            ? OfflineCommandState.needsReview.value
            : storedStatus);
    await _appendStateEvent(
      db,
      pendingWriteId: id,
      clientEventId: clientEventId,
      fromState: storedStatus,
      toState: toState,
      reasonCode: 'v6_migration',
      eventKey: 'v6-migration:$id',
    );
  }

  static Future<void> _validateReadyV6Row(
    DatabaseExecutor db,
    Map<String, Object?> row,
  ) async {
    final state = OfflineCommandState.fromValue(row['status'] as String?);
    final duplicateEventIds = row['client_event_id'] == null
        ? const <Map<String, Object?>>[]
        : await db.query(
            'pending_writes',
            columns: ['id'],
            where: 'id <> ? AND client_event_id = ?',
            whereArgs: [row['id'], row['client_event_id']],
            limit: 1,
          );
    final duplicateIdempotencyKeys = row['idempotency_key'] == null
        ? const <Map<String, Object?>>[]
        : await db.query(
            'pending_writes',
            columns: ['id'],
            where:
                'id <> ? AND tenant_id = ? AND staff_id = ? '
                'AND idempotency_key = ?',
            whereArgs: [
              row['id'],
              row['tenant_id'],
              row['staff_id'],
              row['idempotency_key'],
            ],
            limit: 1,
          );
    final valid =
        state != null &&
        _nonEmptyString(row['client_event_id']) != null &&
        OfflineActionIds.isKnown(_nonEmptyString(row['action_id']) ?? '') &&
        _nonEmptyString(row['idempotency_key']) != null &&
        _nonEmptyString(row['command_fingerprint']) != null &&
        _nonEmptyString(row['payload_hash']) != null &&
        _nonEmptyString(row['envelope_ciphertext']) != null &&
        row['envelope_schema_version'] ==
            OfflineCommandEnvelope.schemaVersion &&
        row['encryption_version'] == currentEncryptionVersion &&
        row['sequence_no'] is int &&
        row['ordering_key_digest'] is String &&
        duplicateEventIds.isEmpty &&
        duplicateIdempotencyKeys.isEmpty;
    if (valid) return;
    await db.update(
      'pending_writes',
      {
        'status': OfflineCommandState.needsReview.value,
        'envelope_ready': 0,
        'state_reason_code': 'v6_integrity_incomplete',
        'review_reason_code': 'v6_integrity_incomplete',
      },
      where: 'id = ?',
      whereArgs: [row['id']],
    );
    await _appendStateEvent(
      db,
      pendingWriteId: row['id'] as int,
      clientEventId: _nonEmptyString(row['client_event_id']),
      fromState: row['status'] as String?,
      toState: OfflineCommandState.needsReview.value,
      reasonCode: 'v6_integrity_incomplete',
      eventKey: 'v6-integrity:${row['id']}',
    );
  }

  static String? _nonEmptyString(Object? value) {
    final text = value as String?;
    return text == null || text.isEmpty ? null : text;
  }

  static Future<void> _appendStateEvent(
    DatabaseExecutor db, {
    required int pendingWriteId,
    required String? clientEventId,
    required String? fromState,
    required String toState,
    required String reasonCode,
    String? actorUid,
    String? detailCiphertext,
    String? eventKey,
    DateTime? at,
  }) async {
    await db.insert('offline_write_state_events', {
      'event_key': eventKey,
      'pending_write_id': pendingWriteId,
      'client_event_id': clientEventId,
      'event_at': (at ?? DateTime.now()).millisecondsSinceEpoch,
      'actor_uid': actorUid,
      'from_state': fromState,
      'to_state': toState,
      'reason_code': reasonCode,
      'detail_ciphertext': detailCiphertext,
      'encryption_version': detailCiphertext == null
          ? null
          : currentEncryptionVersion,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
  }

  /// Queue a known C0A control with trustworthy capture metadata.
  ///
  /// The service has an independent barrier; this lower layer also rejects
  /// contained and unknown actions so direct future callers fail closed.
  static Future<int> enqueue({
    required String endpoint,
    required String method,
    required Map<String, dynamic> body,
    String? contextLabel,
  }) async {
    final classification = OfflineWriteContainment.classify(
      method: method,
      path: endpoint,
    );
    if (!classification.isEnqueueAllowed) {
      throw OfflineWriteRejected(
        classification.reviewReasonCode ??
            OfflineWriteReviewReason.unknownAction.code,
      );
    }
    final tenantId = _validatedTenantId();
    if (tenantId == null) {
      throw OfflineWriteRejected(OfflineWriteReviewReason.unknownTenant.code);
    }
    final staffId = await AuthService.getStaffId();
    if (staffId == null || staffId.isEmpty) {
      throw OfflineWriteRejected(OfflineWriteReviewReason.unknownOwner.code);
    }

    final db = await database;
    return db.transaction((txn) async {
      final createdAt = DateTime.now();
      final clientEventId = IdempotencyKey.generate();
      final idempotencyKey = IdempotencyKey.generate();
      final actionId = OfflineActionIds.fromLegacyControl(
        method: method,
        path: endpoint,
        body: body,
      );
      final payloadHash = await OfflineCommandCodec.hashCanonical(body);
      final fingerprint = await OfflineCommandCodec.hashCanonical({
        'action_id': actionId,
        'capture_owner': staffId,
        'captured_at': createdAt.toUtc().toIso8601String(),
        'payload_hash': payloadHash,
        'tenant_id': tenantId,
      });
      final encryptedBody = await _encrypt(jsonEncode(body));
      final encryptedContext = contextLabel == null
          ? null
          : await _encrypt(contextLabel);
      final id = await txn.insert('pending_writes', {
        'endpoint': endpoint,
        'method': classification.method,
        'body': encryptedBody,
        'created_at': createdAt.millisecondsSinceEpoch,
        'retry_count': 0,
        'context_label': encryptedContext,
        'status': OfflineWriteStatus.pending.value,
        'idempotency_key': idempotencyKey,
        'staff_id': staffId,
        'tenant_id': tenantId,
        'encryption_version': currentEncryptionVersion,
        'reconciliation_owner_id': staffId,
        'client_event_id': clientEventId,
        'action_id': actionId,
        'command_fingerprint': fingerprint,
        'payload_hash': payloadHash,
        'envelope_ready': 0,
        'supersession_generation': 0,
        'human_review_required': 0,
        'attempt_count': 0,
      });
      await _appendStateEvent(
        txn,
        pendingWriteId: id,
        clientEventId: clientEventId,
        fromState: null,
        toState: OfflineCommandState.pending.value,
        reasonCode: 'legacy_c0a_enqueued',
      );
      return id;
    });
  }

  /// Persists a complete immutable command before any network attempt.
  ///
  /// There is no endpoint or method input. A missing facility or signed
  /// authority claim fails before the insert; the caller must not fall back to
  /// an inferred facility or a direct HTTP mutation.
  static Future<PersistedOfflineCommand> persistPreparedCommand(
    OfflineCommandDraft draft, {
    DateTime? queuedAt,
  }) async {
    final tenantId = _validatedTenantId();
    final ownerId = await AuthService.getStaffId();
    String? currentActor;
    String? currentRole;
    try {
      currentActor = await _currentActorUidResolver?.call();
      currentRole = await _currentActorRoleResolver?.call();
    } catch (_) {
      throw const OfflineWriteRejected('capture_identity_unavailable');
    }
    _validatePreparedDraft(
      draft,
      tenantId: tenantId,
      ownerId: ownerId,
      currentActor: currentActor,
      currentRole: currentRole,
    );
    final db = await database;
    return db.transaction((txn) async {
      final key = await _readEncryptionKey(createIfMissing: true);
      if (key == null) {
        throw const OfflineWriteRejected('unknown_encryption_version');
      }
      final clientEventId = IdempotencyKey.generate();
      final idempotencyKey = IdempotencyKey.generate();
      final queued = (queuedAt ?? DateTime.now()).toUtc();
      final payloadHash = await OfflineCommandCodec.hashCanonical(
        draft.payload,
      );
      final orderingKeyDigest = await _orderingDigest(draft.orderingKey, key);
      final sequence = await _allocateSequence(
        txn,
        tenantId: tenantId!,
        ownerId: ownerId!,
        actionId: draft.actionId,
        orderingKeyDigest: orderingKeyDigest,
      );
      final predecessorClientEventId = await _resolvePredecessor(
        txn,
        draft: draft,
        tenantId: tenantId,
        ownerId: ownerId,
        orderingKeyDigest: orderingKeyDigest,
      );
      await _validatePredecessor(
        txn,
        predecessorClientEventId: predecessorClientEventId,
        actionId: draft.actionId,
        tenantId: tenantId,
        ownerId: ownerId,
        orderingKeyDigest: orderingKeyDigest,
      );

      var envelope = OfflineCommandEnvelope(
        clientEventId: clientEventId,
        idempotencyKey: idempotencyKey,
        actionId: draft.actionId,
        commandFingerprint: 'pending',
        payloadHash: payloadHash,
        appVersion: draft.appVersion,
        envelopeSchemaVersion: OfflineCommandEnvelope.schemaVersion,
        queueSchemaVersion: schemaVersion,
        actionVersion: draft.actionVersion,
        actionChecksum: draft.actionChecksum,
        actionSchemaId: draft.actionSchemaId,
        actionSchemaVersion: draft.actionSchemaVersion,
        actionSchemaChecksum: draft.actionSchemaChecksum,
        policyId: draft.policyId,
        policyVersion: draft.policyVersion,
        policyChecksum: draft.policyChecksum,
        policySigningKeyId: draft.policySigningKeyId,
        policyEffectiveFrom: draft.policyEffectiveFrom.toUtc(),
        policyEffectiveUntil: draft.policyEffectiveUntil.toUtc(),
        policySupersedesId: draft.policySupersedesId,
        policyRevocationEpoch: draft.policyRevocationEpoch,
        registryVersion: draft.registryVersion,
        registryChecksum: draft.registryChecksum,
        minimumAppVersion: draft.minimumAppVersion,
        tenantId: draft.tenantId,
        facilityId: draft.facilityId,
        unitId: draft.unitId,
        deviceId: draft.deviceId,
        devicePosture: draft.devicePosture,
        captureSessionId: draft.captureSessionId,
        incidentId: draft.incidentId,
        captureActorUuid: draft.captureActorUuid,
        captureRole: draft.captureRole,
        patientReference: draft.patientReference,
        encounterId: draft.encounterId,
        appointmentId: draft.appointmentId,
        admissionId: draft.admissionId,
        occurredAt: draft.occurredAt.toUtc(),
        capturedAt: draft.capturedAt.toUtc(),
        queuedAt: queued,
        clockEvidence: draft.clockEvidence,
        cachedSources: Map.unmodifiable(draft.cachedSources),
        sourceCacheVersion: draft.sourceCacheVersion,
        baseRevision: draft.baseRevision,
        baseEtag: draft.baseEtag,
        expiresAt: draft.expiresAt.toUtc(),
        orderingKey: draft.orderingKey,
        orderingKeyDigest: orderingKeyDigest,
        sequence: sequence,
        predecessorClientEventId: predecessorClientEventId,
        supersessionGeneration: draft.supersessionGeneration,
        humanReviewRequired: draft.humanReviewRequired,
      );
      envelope = envelope.withCommandFingerprint(
        await OfflineCommandCodec.commandFingerprint(envelope),
      );

      final encryptedBody = await _encryptWithKey(
        OfflineCommandCodec.canonicalize(draft.payload),
        key,
      );
      final bodyCiphertextHash = await OfflineCommandCodec.sha256Hex(
        utf8.encode(encryptedBody),
      );
      final authenticatedData = _envelopeAuthenticatedData(
        envelope,
        bodyCiphertextHash: bodyCiphertextHash,
        ownerId: ownerId,
      );
      final encryptedEnvelope = await _encryptWithKey(
        OfflineCommandCodec.encodeEnvelope(envelope),
        key,
        authenticatedData: authenticatedData,
      );
      final encryptedContext = draft.contextLabel == null
          ? null
          : await _encryptWithKey(draft.contextLabel!, key);

      final rowId = await txn.insert('pending_writes', {
        'endpoint': _c4EndpointSentinel,
        'method': _c4MethodSentinel,
        'body': encryptedBody,
        'created_at': queued.millisecondsSinceEpoch,
        'retry_count': 0,
        'context_label': encryptedContext,
        'status': OfflineCommandState.pending.value,
        'idempotency_key': idempotencyKey,
        'staff_id': ownerId,
        'tenant_id': tenantId,
        'encryption_version': currentEncryptionVersion,
        'reconciliation_owner_id': ownerId,
        'client_event_id': clientEventId,
        'action_id': draft.actionId,
        'command_fingerprint': envelope.commandFingerprint,
        'payload_hash': payloadHash,
        'envelope_ciphertext': encryptedEnvelope,
        'envelope_schema_version': OfflineCommandEnvelope.schemaVersion,
        'envelope_ready': 1,
        'ordering_key_digest': orderingKeyDigest,
        'sequence_no': sequence,
        'predecessor_client_event_id': predecessorClientEventId,
        'supersession_generation': draft.supersessionGeneration,
        'human_review_required': draft.humanReviewRequired ? 1 : 0,
        'attempt_count': 0,
      });
      await _appendStateEvent(
        txn,
        pendingWriteId: rowId,
        clientEventId: clientEventId,
        fromState: null,
        toState: OfflineCommandState.pending.value,
        reasonCode: 'prepared_before_first_attempt',
        actorUid: draft.captureActorUuid,
      );
      if (OfflineActionIds.isDraft(draft.actionId)) {
        await _supersedeOlderDrafts(
          txn,
          newRowId: rowId,
          clientEventId: clientEventId,
          tenantId: tenantId,
          ownerId: ownerId,
          actionId: draft.actionId,
          orderingKeyDigest: orderingKeyDigest,
          generation: draft.supersessionGeneration,
          actorUid: draft.captureActorUuid,
        );
      }
      return PersistedOfflineCommand(
        rowId: rowId,
        envelope: envelope,
        payload: Map.unmodifiable(draft.payload),
        state: OfflineCommandState.pending,
        attemptCount: 0,
      );
    });
  }

  static void _validatePreparedDraft(
    OfflineCommandDraft draft, {
    required String? tenantId,
    required String? ownerId,
    required String? currentActor,
    required String? currentRole,
  }) {
    if (tenantId == null || draft.tenantId != tenantId) {
      throw const OfflineWriteRejected('unknown_tenant');
    }
    if (ownerId == null || ownerId.isEmpty) {
      throw const OfflineWriteRejected('unknown_owner');
    }
    if (currentActor == null ||
        currentActor.isEmpty ||
        currentRole == null ||
        currentRole.isEmpty ||
        draft.captureActorUuid != currentActor ||
        draft.captureRole != currentRole) {
      throw const OfflineWriteRejected('capture_identity_mismatch');
    }
    if (!OfflineActionIds.isKnown(draft.actionId) ||
        draft.actionId == OfflineActionIds.unknown) {
      throw const OfflineWriteRejected('unknown_action');
    }
    if (draft.facilityId <= 0) {
      throw const OfflineWriteRejected('facility_context_unavailable');
    }
    for (final value in [
      draft.appVersion,
      draft.actionChecksum,
      draft.actionSchemaId,
      draft.actionSchemaChecksum,
      draft.policyId,
      draft.policyVersion,
      draft.policyChecksum,
      draft.policySigningKeyId,
      draft.policyRevocationEpoch,
      draft.registryVersion,
      draft.registryChecksum,
      draft.minimumAppVersion,
      draft.deviceId,
      draft.devicePosture,
      draft.captureSessionId,
      draft.captureActorUuid,
      draft.captureRole,
      draft.patientReference,
      draft.orderingKey,
    ]) {
      if (value.trim().isEmpty || value != value.trim()) {
        throw const OfflineWriteRejected('capture_context_incomplete');
      }
    }
    if (draft.actionVersion <= 0 ||
        draft.actionSchemaVersion <= 0 ||
        draft.supersessionGeneration < 0 ||
        draft.cachedSources.isEmpty ||
        draft.cachedSources.keys.any((key) => key.trim().isEmpty)) {
      throw const OfflineWriteRejected('capture_context_incomplete');
    }
    final captured = draft.capturedAt.toUtc();
    final clock = draft.clockEvidence;
    final measuredSkew = clock.serverTime
        .toUtc()
        .difference(clock.midpoint.toUtc())
        .inMilliseconds;
    if (!const {'public', 'internal'}.contains(clock.routeKind) ||
        clock.observedAt.toUtc().isAfter(captured) ||
        clock.uncertaintyMilliseconds > clock.toleranceMilliseconds ||
        measuredSkew != clock.skewMilliseconds ||
        measuredSkew.abs() + clock.uncertaintyMilliseconds >
            clock.toleranceMilliseconds) {
      throw const OfflineWriteRejected('clock_evidence_untrusted');
    }
    if (draft.policyEffectiveFrom.toUtc().isAfter(captured) ||
        !draft.policyEffectiveUntil.toUtc().isAfter(captured) ||
        draft.occurredAt.toUtc().isAfter(captured) ||
        !draft.expiresAt.toUtc().isAfter(captured) ||
        draft.expiresAt.toUtc().isAfter(draft.policyEffectiveUntil.toUtc())) {
      throw const OfflineWriteRejected('capture_authority_expired');
    }
    if (draft.cachedSources.values.any(
      (timestamp) => timestamp.toUtc().isAfter(captured),
    )) {
      throw const OfflineWriteRejected('source_time_invalid');
    }
  }

  static Future<String> _orderingDigest(
    String orderingKey,
    SecretKey key,
  ) async {
    final mac = await Hmac.sha256().calculateMac(
      utf8.encode(orderingKey),
      secretKey: key,
    );
    return mac.bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  static Future<int> _allocateSequence(
    DatabaseExecutor db, {
    required String tenantId,
    required String ownerId,
    required String actionId,
    required String orderingKeyDigest,
  }) async {
    final partition =
        '$tenantId\u0000$ownerId\u0000'
        '$actionId\u0000$orderingKeyDigest';
    final rows = await db.query(
      'offline_write_sequences',
      where: 'partition_key = ?',
      whereArgs: [partition],
      limit: 1,
    );
    final sequence = rows.isEmpty ? 1 : rows.single['next_sequence'] as int;
    await db.insert('offline_write_sequences', {
      'partition_key': partition,
      'next_sequence': sequence + 1,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    return sequence;
  }

  static Future<void> _validatePredecessor(
    DatabaseExecutor db, {
    required String? predecessorClientEventId,
    required String actionId,
    required String tenantId,
    required String ownerId,
    required String orderingKeyDigest,
  }) async {
    final predecessor = predecessorClientEventId;
    if (predecessor == null) return;
    final rows = await db.query(
      'pending_writes',
      columns: ['tenant_id', 'staff_id', 'action_id', 'ordering_key_digest'],
      where: 'client_event_id = ?',
      whereArgs: [predecessor],
      limit: 1,
    );
    if (rows.isEmpty) {
      throw const OfflineWriteRejected('predecessor_missing');
    }
    final row = rows.single;
    if (row['tenant_id'] != tenantId ||
        row['staff_id'] != ownerId ||
        row['action_id'] != actionId ||
        row['ordering_key_digest'] != orderingKeyDigest) {
      throw const OfflineWriteRejected('predecessor_partition_mismatch');
    }
  }

  static Future<String?> _resolvePredecessor(
    DatabaseExecutor db, {
    required OfflineCommandDraft draft,
    required String tenantId,
    required String ownerId,
    required String orderingKeyDigest,
  }) async {
    if (draft.predecessorClientEventId != null ||
        !OfflineActionIds.isDraft(draft.actionId)) {
      return draft.predecessorClientEventId;
    }
    final attempted = await db.query(
      'pending_writes',
      columns: ['client_event_id'],
      where:
          'envelope_ready = 1 AND tenant_id = ? AND staff_id = ? '
          'AND action_id = ? AND ordering_key_digest = ? '
          'AND supersession_generation = ? AND attempt_count > 0 '
          "AND status IN ('pending', 'in_flight', 'retry_wait', "
          "'needs_review')",
      whereArgs: [
        tenantId,
        ownerId,
        draft.actionId,
        orderingKeyDigest,
        draft.supersessionGeneration,
      ],
      orderBy: 'sequence_no DESC, id DESC',
      limit: 1,
    );
    return attempted.isEmpty
        ? null
        : attempted.single['client_event_id'] as String?;
  }

  static Future<void> _supersedeOlderDrafts(
    DatabaseExecutor db, {
    required int newRowId,
    required String clientEventId,
    required String tenantId,
    required String ownerId,
    required String actionId,
    required String orderingKeyDigest,
    required int generation,
    required String actorUid,
  }) async {
    final rows = await db.query(
      'pending_writes',
      columns: ['id', 'client_event_id', 'status'],
      where:
          'id <> ? AND envelope_ready = 1 AND tenant_id = ? AND staff_id = ? '
          'AND action_id = ? AND ordering_key_digest = ? '
          'AND supersession_generation = ? AND attempt_count = 0 '
          "AND status IN ('pending', 'retry_wait')",
      whereArgs: [
        newRowId,
        tenantId,
        ownerId,
        actionId,
        orderingKeyDigest,
        generation,
      ],
    );
    for (final row in rows) {
      final changed = await db.update(
        'pending_writes',
        {
          'status': OfflineCommandState.superseded.value,
          'state_reason_code': 'newer_draft_generation',
          'lease_id': null,
          'lease_expires_at': null,
          'next_attempt_at': null,
        },
        where:
            "id = ? AND attempt_count = 0 "
            "AND status IN ('pending', 'retry_wait')",
        whereArgs: [row['id']],
      );
      if (changed == 1) {
        await _appendStateEvent(
          db,
          pendingWriteId: row['id'] as int,
          clientEventId: row['client_event_id'] as String?,
          fromState: row['status'] as String?,
          toState: OfflineCommandState.superseded.value,
          reasonCode: 'newer_draft_generation',
          actorUid: actorUid,
          eventKey: 'superseded:${row['id']}:by:$clientEventId',
        );
      }
    }
  }

  static List<int> _envelopeAuthenticatedData(
    OfflineCommandEnvelope envelope, {
    required String bodyCiphertextHash,
    required String ownerId,
  }) {
    return _envelopeAuthenticatedDataFromValues(
      actionId: envelope.actionId,
      bodyCiphertextHash: bodyCiphertextHash,
      clientEventId: envelope.clientEventId,
      envelopeSchemaVersion: envelope.envelopeSchemaVersion,
      orderingKeyDigest: envelope.orderingKeyDigest,
      sequence: envelope.sequence,
      ownerId: ownerId,
      tenantId: envelope.tenantId,
    );
  }

  static List<int> _envelopeAuthenticatedDataFromValues({
    required String actionId,
    required String bodyCiphertextHash,
    required String clientEventId,
    required int envelopeSchemaVersion,
    required String orderingKeyDigest,
    required int sequence,
    required String ownerId,
    required String tenantId,
  }) {
    final canonical = OfflineCommandCodec.canonicalize({
      'action_id': actionId,
      'body_ciphertext_hash': bodyCiphertextHash,
      'client_event_id': clientEventId,
      'envelope_schema_version': envelopeSchemaVersion,
      'ordering_key_digest': orderingKeyDigest,
      'sequence': sequence,
      'staff_id': ownerId,
      'tenant_id': tenantId,
    });
    return utf8.encode(canonical);
  }

  @visibleForTesting
  static const String pendingDrainOrderBy = 'created_at ASC, id ASC';

  static Future<List<Map<String, dynamic>>> getPending() async {
    final db = await database;
    final staffId = await AuthService.getStaffId();
    if (staffId == null) return const [];
    await _quarantineUnsafeCurrentOwnerRows(db, staffId);
    return db.query(
      'pending_writes',
      where: "status = 'pending' AND staff_id = ?",
      whereArgs: [staffId],
      orderBy: pendingDrainOrderBy,
    );
  }

  static Future<List<Map<String, dynamic>>> getConflicts() async {
    final db = await database;
    final staffId = await AuthService.getStaffId();
    if (staffId == null) return const [];
    await _quarantineUnsafeCurrentOwnerRows(db, staffId);
    final rows = await db.query(
      'pending_writes',
      where:
          "staff_id = ? AND (status = 'conflict' OR "
          "(status = 'needs_review' AND state_reason_code = 'legacy_conflict'))",
      whereArgs: [staffId],
      orderBy: pendingDrainOrderBy,
    );
    return rows.map(_legacyCompatibilityRow).toList();
  }

  static Future<List<OfflineWriteEntry>>
  unresolvedEntriesForCurrentOwner() async {
    final db = await database;
    final staffId = await AuthService.getStaffId();
    if (staffId == null) return const [];
    await _quarantineUnsafeCurrentOwnerRows(db, staffId);
    final rows = await db.query(
      'pending_writes',
      where:
          "staff_id = ? AND status IN "
          "('pending', 'in_flight', 'retry_wait', 'conflict', 'needs_review')",
      whereArgs: [staffId],
      orderBy: pendingDrainOrderBy,
    );
    final entries = <OfflineWriteEntry>[];
    for (final row in rows) {
      entries.add(await _entryFromRow(db, row));
    }
    return _withComputedPartitionBlockers(entries);
  }

  static Future<void> _quarantineUnsafeCurrentOwnerRows(
    Database db,
    String staffId,
  ) async {
    final rows = await db.query(
      'pending_writes',
      where:
          "staff_id = ? AND status IN "
          "('pending', 'in_flight', 'retry_wait', 'conflict', 'needs_review')",
      whereArgs: [staffId],
      orderBy: pendingDrainOrderBy,
    );
    final validTenantId = _validatedTenantId();
    for (final row in rows) {
      if (row['status'] == 'needs_review') continue;
      if (row['envelope_ready'] == 1) {
        await _validateReadyV6Row(db, row);
        continue;
      }
      final classification = OfflineWriteContainment.classify(
        method: row['method'] as String,
        path: row['endpoint'] as String,
      );
      OfflineWriteReviewReason? reason;
      if (row['tenant_id'] == null ||
          validTenantId == null ||
          row['tenant_id'] != validTenantId) {
        reason = OfflineWriteReviewReason.unknownTenant;
      } else if (_nonEmptyString(row['staff_id']) == null) {
        reason = OfflineWriteReviewReason.unknownOwner;
      } else if (row['encryption_version'] != currentEncryptionVersion) {
        reason = OfflineWriteReviewReason.unknownEncryptionVersion;
      } else if ((row['retry_count'] as int? ?? 0) >= maxRetryCount) {
        reason = OfflineWriteReviewReason.retryExhausted;
      } else if (!classification.isControl) {
        reason =
            classification.reviewReason ??
            OfflineWriteReviewReason.unknownAction;
      }
      if (reason != null) {
        await db.update(
          'pending_writes',
          {
            'status': OfflineWriteStatus.needsReview.value,
            'review_reason_code': reason.code,
          },
          where: 'id = ?',
          whereArgs: [row['id']],
        );
      }
    }
  }

  static Future<OfflineWriteEntry> _entryFromRow(
    Database db,
    Map<String, Object?> row,
  ) async {
    final id = row['id'] as int;
    var version = row['encryption_version'] as int?;
    String? context;
    String? conflictReason;
    final isLegacyConflict =
        row['status'] == OfflineCommandState.needsReview.value &&
        row['state_reason_code'] == 'legacy_conflict';
    var status = isLegacyConflict
        ? OfflineWriteStatus.conflict
        : OfflineWriteStatus.fromValue(row['status'] as String?) ??
              OfflineWriteStatus.needsReview;
    var reviewReasonCode = row['review_reason_code'] as String?;
    try {
      context = await _decodeOptionalField(
        row['context_label'],
        encryptionVersion: version,
      );
      conflictReason = await _decodeOptionalField(
        row['conflict_reason'],
        encryptionVersion: version,
      );
    } on OfflineWriteRejected {
      status = OfflineWriteStatus.needsReview;
      reviewReasonCode = OfflineWriteReviewReason.unknownEncryptionVersion.code;
      version = null;
      await db.update(
        'pending_writes',
        {
          'status': status.value,
          'review_reason_code': reviewReasonCode,
          'encryption_version': null,
        },
        where: 'id = ?',
        whereArgs: [id],
      );
    } catch (_) {
      status = OfflineWriteStatus.needsReview;
      reviewReasonCode = OfflineWriteReviewReason.decryptFailed.code;
      version = null;
      await db.update(
        'pending_writes',
        {
          'status': status.value,
          'review_reason_code': reviewReasonCode,
          'encryption_version': null,
        },
        where: 'id = ?',
        whereArgs: [id],
      );
    }
    final isReady = row['envelope_ready'] == 1;
    final actionId = row['action_id'] as String?;
    final endpoint = isReady
        ? 'action:${actionId ?? OfflineActionIds.unknown}'
        : row['endpoint'] as String;
    final method = isReady ? 'ACTION' : row['method'] as String;
    final classification = isReady
        ? _legacyClassificationForAction(actionId)
        : OfflineWriteContainment.classify(method: method, path: endpoint);
    return OfflineWriteEntry(
      id: id,
      endpoint: endpoint,
      method: method.toUpperCase(),
      createdAt: DateTime.fromMillisecondsSinceEpoch(row['created_at'] as int),
      retryCount: row['retry_count'] as int? ?? 0,
      contextLabel: context,
      status: status,
      conflictReason: conflictReason,
      idempotencyKey: row['idempotency_key'] as String?,
      staffId: row['staff_id'] as String?,
      tenantId: row['tenant_id'] as String?,
      encryptionVersion: version,
      reviewReasonCode: reviewReasonCode,
      reconciliationOwnerId: row['reconciliation_owner_id'] as String?,
      handoffAttestedAt: row['handoff_attested_at'] == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(
              row['handoff_attested_at'] as int,
            ),
      handoffAttestedBy: row['handoff_attested_by'] as String?,
      classification: classification,
      clientEventId: row['client_event_id'] as String?,
      actionId: actionId,
      commandFingerprint: row['command_fingerprint'] as String?,
      envelopeReady: isReady,
      orderingKeyDigest: row['ordering_key_digest'] as String?,
      sequence: row['sequence_no'] as int?,
      predecessorClientEventId: row['predecessor_client_event_id'] as String?,
      supersessionGeneration: row['supersession_generation'] as int? ?? 0,
      humanReviewRequired: row['human_review_required'] == 1,
      leaseId: row['lease_id'] as String?,
      leaseExpiresAt: _dateFromEpoch(row['lease_expires_at']),
      nextAttemptAt: _dateFromEpoch(row['next_attempt_at']),
      attemptCount: row['attempt_count'] as int? ?? 0,
      lastAttemptAt: _dateFromEpoch(row['last_attempt_at']),
      appliedAt: _dateFromEpoch(row['applied_at']),
      stateReasonCode: row['state_reason_code'] as String?,
    );
  }

  static DateTime? _dateFromEpoch(Object? value) =>
      value is int ? DateTime.fromMillisecondsSinceEpoch(value) : null;

  static OfflineWriteClassification _legacyClassificationForAction(
    String? actionId,
  ) {
    return switch (actionId) {
      OfflineActionIds.vitalsCapture => OfflineWriteContainment.classify(
        method: 'POST',
        path: '/health/records',
      ),
      OfflineActionIds.nursingNoteDraftStore ||
      OfflineActionIds.opNoteDraftStore => OfflineWriteContainment.classify(
        method: 'PUT',
        path: '/emr/notes/draft',
      ),
      _ => OfflineWriteContainment.classify(method: 'ACTION', path: '/unknown'),
    };
  }

  static Map<String, dynamic> _legacyCompatibilityRow(
    Map<String, Object?> row,
  ) {
    final projected = Map<String, dynamic>.from(row);
    if (projected['status'] == OfflineCommandState.needsReview.value &&
        projected['state_reason_code'] == 'legacy_conflict') {
      projected['status'] = OfflineWriteStatus.conflict.value;
    }
    return projected;
  }

  static List<OfflineWriteEntry> _withComputedPartitionBlockers(
    List<OfflineWriteEntry> entries,
  ) {
    final blockers = <String, OfflineWriteEntry>{};
    final result = <OfflineWriteEntry>[];
    for (final entry in entries) {
      final partition = _partitionKey(entry);
      final blocker = blockers[partition];
      if ((entry.status == OfflineWriteStatus.pending ||
              entry.status == OfflineWriteStatus.retryWait) &&
          blocker != null) {
        result.add(
          entry.copyWithComputedBlocker(
            blockerRowId: blocker.id,
            blockerReasonCode: blocker.reviewReasonCode ?? blocker.status.value,
          ),
        );
      } else {
        result.add(entry);
      }
      if (blocker == null &&
          (entry.status == OfflineWriteStatus.conflict ||
              entry.status == OfflineWriteStatus.needsReview ||
              entry.status == OfflineWriteStatus.inFlight ||
              entry.status == OfflineWriteStatus.retryWait ||
              entry.isRetryExhausted)) {
        blockers[partition] = entry;
      }
    }
    return result;
  }

  static String _partitionKey(OfflineWriteEntry entry) => entry.partitionKey;

  static Future<Map<String, dynamic>?> readBodyForReplay(
    OfflineWriteEntry entry,
  ) async {
    final currentStaffId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (currentStaffId == null ||
        tenantId == null ||
        entry.staffId != currentStaffId ||
        entry.tenantId != tenantId ||
        entry.status != OfflineWriteStatus.pending ||
        entry.isSkipped ||
        entry.envelopeReady ||
        !entry.classification.isControl) {
      return null;
    }
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [entry.id],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final row = rows.single;
    if (row['status'] != OfflineWriteStatus.pending.value ||
        row['envelope_ready'] == 1 ||
        row['staff_id'] != currentStaffId ||
        row['tenant_id'] != tenantId ||
        row['encryption_version'] != currentEncryptionVersion) {
      return null;
    }
    final classification = OfflineWriteContainment.classify(
      method: row['method'] as String,
      path: row['endpoint'] as String,
    );
    if (!classification.isControl ||
        classification.family != entry.classification.family) {
      await _markNeedsReview(
        db,
        entry.id,
        classification.reviewReason ?? OfflineWriteReviewReason.unknownAction,
      );
      return null;
    }
    try {
      return await decodeBody(
        row['body'] as String,
        encryptionVersion: row['encryption_version'] as int,
      );
    } on OfflineWriteRejected {
      await _markNeedsReview(
        db,
        entry.id,
        OfflineWriteReviewReason.unknownEncryptionVersion,
        clearEncryptionVersion: true,
      );
      return null;
    } catch (_) {
      await _markNeedsReview(
        db,
        entry.id,
        OfflineWriteReviewReason.decryptFailed,
        clearEncryptionVersion: true,
      );
      return null;
    }
  }

  static Future<void> recoverExpiredLeases({DateTime? now}) async {
    final ownerId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (ownerId == null || tenantId == null) return;
    final instant = (now ?? DateTime.now()).toUtc();
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where:
          "envelope_ready = 1 AND tenant_id = ? AND staff_id = ? "
          "AND status = 'in_flight' AND lease_expires_at <= ?",
      whereArgs: [tenantId, ownerId, instant.millisecondsSinceEpoch],
      orderBy: 'lease_expires_at ASC, id ASC',
    );
    for (final row in rows) {
      await db.transaction((txn) async {
        final fresh = await txn.query(
          'pending_writes',
          where: "id = ? AND status = 'in_flight' AND lease_expires_at <= ?",
          whereArgs: [row['id'], instant.millisecondsSinceEpoch],
          limit: 1,
        );
        if (fresh.isEmpty) return;
        final current = fresh.single;
        final command = await _decodePreparedRow(txn, current);
        if (command == null) return;
        await _scheduleRetryTransition(
          txn,
          current,
          command.envelope,
          now: instant,
          reasonCode: 'lease_expired',
        );
      });
    }
  }

  static Future<PersistedOfflineCommand?> claimPreparedCommand(
    int rowId, {
    DateTime? now,
  }) async {
    final ownerId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (ownerId == null || tenantId == null) return null;
    String? actorUid;
    String? actorRole;
    try {
      actorUid = await _currentActorUidResolver?.call();
      actorRole = await _currentActorRoleResolver?.call();
    } catch (_) {
      return null;
    }
    if (actorUid == null ||
        actorUid.isEmpty ||
        actorRole == null ||
        actorRole.isEmpty) {
      return null;
    }
    final instant = (now ?? DateTime.now()).toUtc();
    final detail = await _encrypt(
      OfflineCommandCodec.canonicalize({
        'replay_actor_uuid': actorUid,
        'replay_role': actorRole,
      }),
    );
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where: 'id = ?',
        whereArgs: [rowId],
        limit: 1,
      );
      if (rows.isEmpty) return null;
      final row = rows.single;
      if (row['envelope_ready'] != 1 ||
          row['tenant_id'] != tenantId ||
          row['staff_id'] != ownerId ||
          row['encryption_version'] != currentEncryptionVersion) {
        return null;
      }
      final state = OfflineCommandState.fromValue(row['status'] as String?);
      final due =
          state == OfflineCommandState.pending ||
          (state == OfflineCommandState.retryWait &&
              ((row['next_attempt_at'] as int?) ?? 0) <=
                  instant.millisecondsSinceEpoch);
      if (!due || row['human_review_required'] == 1) return null;
      final predecessor = row['predecessor_client_event_id'] as String?;
      if (predecessor != null) {
        final predecessorRows = await txn.query(
          'pending_writes',
          columns: ['status'],
          where: 'client_event_id = ?',
          whereArgs: [predecessor],
          limit: 1,
        );
        if (predecessorRows.isEmpty) {
          await _transitionReady(
            txn,
            row,
            toState: OfflineCommandState.needsReview,
            reasonCode: 'predecessor_missing',
            actorUid: actorUid,
          );
          return null;
        }
        final predecessorState = OfflineCommandState.fromValue(
          predecessorRows.single['status'] as String?,
        );
        if (predecessorState == OfflineCommandState.needsReview) {
          await _transitionReady(
            txn,
            row,
            toState: OfflineCommandState.needsReview,
            reasonCode: 'predecessor_failed',
            actorUid: actorUid,
          );
          return null;
        }
        if (predecessorState == OfflineCommandState.superseded ||
            predecessorState == OfflineCommandState.cancelled) {
          await _transitionReady(
            txn,
            row,
            toState: OfflineCommandState.needsReview,
            reasonCode: 'predecessor_terminal_transition_unapproved',
            actorUid: actorUid,
          );
          return null;
        }
        if (predecessorState != OfflineCommandState.applied) {
          return null;
        }
      }

      final leaseId = IdempotencyKey.generate();
      final leaseExpiresAt = instant.add(leaseDuration);
      final attempt = (row['attempt_count'] as int? ?? 0) + 1;
      final changed = await txn.update(
        'pending_writes',
        {
          'status': OfflineCommandState.inFlight.value,
          'lease_id': leaseId,
          'lease_expires_at': leaseExpiresAt.millisecondsSinceEpoch,
          'next_attempt_at': null,
          'attempt_count': attempt,
          'retry_count': attempt,
          'last_attempt_at': instant.millisecondsSinceEpoch,
          'state_reason_code': 'leased_for_attempt',
        },
        where:
            'id = ? AND envelope_ready = 1 AND tenant_id = ? AND staff_id = ? '
            "AND (status = 'pending' OR "
            "(status = 'retry_wait' AND next_attempt_at <= ?))",
        whereArgs: [rowId, tenantId, ownerId, instant.millisecondsSinceEpoch],
      );
      if (changed != 1) return null;
      final leasedRow = Map<String, Object?>.from(row)
        ..['status'] = OfflineCommandState.inFlight.value
        ..['lease_id'] = leaseId
        ..['lease_expires_at'] = leaseExpiresAt.millisecondsSinceEpoch
        ..['attempt_count'] = attempt
        ..['last_attempt_at'] = instant.millisecondsSinceEpoch;
      await _appendStateEvent(
        txn,
        pendingWriteId: rowId,
        clientEventId: row['client_event_id'] as String?,
        fromState: state?.value,
        toState: OfflineCommandState.inFlight.value,
        reasonCode: 'leased_for_attempt',
        actorUid: actorUid,
        detailCiphertext: detail,
      );
      final command = await _decodePreparedRow(txn, leasedRow);
      if (command == null) return null;
      if (command.envelope.captureActorUuid != actorUid) {
        await _transitionReady(
          txn,
          leasedRow,
          toState: OfflineCommandState.needsReview,
          reasonCode: 'replay_actor_handoff_unapproved',
          actorUid: actorUid,
          expectedLeaseId: leaseId,
        );
        return null;
      }
      if (!command.envelope.expiresAt.isAfter(instant)) {
        await _transitionReady(
          txn,
          leasedRow,
          toState: OfflineCommandState.needsReview,
          reasonCode: 'capture_expired',
          actorUid: actorUid,
          expectedLeaseId: leaseId,
        );
        return null;
      }
      return PersistedOfflineCommand(
        rowId: rowId,
        envelope: command.envelope,
        payload: command.payload,
        state: OfflineCommandState.inFlight,
        attemptCount: attempt,
        leaseId: leaseId,
        leaseExpiresAt: leaseExpiresAt,
      );
    });
  }

  static Future<PersistedOfflineCommand?> _decodePreparedRow(
    DatabaseExecutor db,
    Map<String, Object?> row,
  ) async {
    try {
      final key = await _readEncryptionKey(createIfMissing: false);
      if (key == null) {
        throw const OfflineWriteRejected('unknown_encryption_version');
      }
      final bodyCiphertext = row['body'] as String;
      final bodyCiphertextHash = await OfflineCommandCodec.sha256Hex(
        utf8.encode(bodyCiphertext),
      );
      final authenticatedData = _envelopeAuthenticatedDataFromValues(
        actionId: row['action_id'] as String,
        bodyCiphertextHash: bodyCiphertextHash,
        clientEventId: row['client_event_id'] as String,
        envelopeSchemaVersion: row['envelope_schema_version'] as int,
        orderingKeyDigest: row['ordering_key_digest'] as String,
        sequence: row['sequence_no'] as int,
        ownerId: row['staff_id'] as String,
        tenantId: row['tenant_id'] as String,
      );
      final envelope = OfflineCommandCodec.decodeEnvelope(
        await _decryptWithKey(
          row['envelope_ciphertext'] as String,
          key,
          authenticatedData: authenticatedData,
        ),
      );
      final decodedPayload = jsonDecode(
        await _decryptWithKey(bodyCiphertext, key),
      );
      if (decodedPayload is! Map<String, dynamic>) {
        throw const FormatException('Prepared payload is not an object');
      }
      final payloadHash = await OfflineCommandCodec.hashCanonical(
        decodedPayload,
      );
      final fingerprint = await OfflineCommandCodec.commandFingerprint(
        envelope,
      );
      if (envelope.clientEventId != row['client_event_id'] ||
          envelope.idempotencyKey != row['idempotency_key'] ||
          envelope.actionId != row['action_id'] ||
          envelope.commandFingerprint != row['command_fingerprint'] ||
          envelope.payloadHash != row['payload_hash'] ||
          envelope.orderingKeyDigest != row['ordering_key_digest'] ||
          envelope.sequence != row['sequence_no'] ||
          envelope.tenantId != row['tenant_id'] ||
          payloadHash != envelope.payloadHash ||
          fingerprint != envelope.commandFingerprint) {
        throw const FormatException('Prepared command integrity mismatch');
      }
      return PersistedOfflineCommand(
        rowId: row['id'] as int,
        envelope: envelope,
        payload: decodedPayload,
        state:
            OfflineCommandState.fromValue(row['status'] as String?) ??
            OfflineCommandState.needsReview,
        attemptCount: row['attempt_count'] as int? ?? 0,
        leaseId: row['lease_id'] as String?,
        leaseExpiresAt: _dateFromEpoch(row['lease_expires_at']),
      );
    } catch (_) {
      await _transitionReady(
        db,
        row,
        toState: OfflineCommandState.needsReview,
        reasonCode: 'command_integrity_failed',
      );
      return null;
    }
  }

  static Future<bool> markPreparedApplied({
    required int rowId,
    required String leaseId,
    DateTime? at,
  }) async {
    final instant = (at ?? DateTime.now()).toUtc();
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where:
            "id = ? AND envelope_ready = 1 AND status = 'in_flight' "
            'AND lease_id = ?',
        whereArgs: [rowId, leaseId],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      return _transitionReady(
        txn,
        rows.single,
        toState: OfflineCommandState.applied,
        reasonCode: 'server_applied',
        expectedLeaseId: leaseId,
        at: instant,
        extra: {'applied_at': instant.millisecondsSinceEpoch},
      );
    });
  }

  static Future<bool> schedulePreparedRetry({
    required int rowId,
    required String leaseId,
    DateTime? retryAfter,
    DateTime? now,
    String reasonCode = 'transient_failure',
  }) async {
    final instant = (now ?? DateTime.now()).toUtc();
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where:
            "id = ? AND envelope_ready = 1 AND status = 'in_flight' "
            'AND lease_id = ?',
        whereArgs: [rowId, leaseId],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final row = rows.single;
      final command = await _decodePreparedRow(txn, row);
      if (command == null) return false;
      return _scheduleRetryTransition(
        txn,
        row,
        command.envelope,
        now: instant,
        retryAfter: retryAfter,
        reasonCode: reasonCode,
        expectedLeaseId: leaseId,
      );
    });
  }

  static Future<bool> releasePreparedLeaseForAuthentication({
    required int rowId,
    required String leaseId,
  }) async {
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where:
            "id = ? AND envelope_ready = 1 AND status = 'in_flight' "
            'AND lease_id = ?',
        whereArgs: [rowId, leaseId],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final row = rows.single;
      final currentAttempts = row['attempt_count'] as int? ?? 0;
      final restoredAttempts = max(0, currentAttempts - 1);
      final changed = await txn.update(
        'pending_writes',
        {
          'status': OfflineCommandState.pending.value,
          'lease_id': null,
          'lease_expires_at': null,
          'next_attempt_at': null,
          'attempt_count': restoredAttempts,
          'retry_count': restoredAttempts,
          'state_reason_code': 'authentication_required',
        },
        where: "id = ? AND status = 'in_flight' AND lease_id = ?",
        whereArgs: [rowId, leaseId],
      );
      if (changed != 1) return false;
      await _appendStateEvent(
        txn,
        pendingWriteId: rowId,
        clientEventId: row['client_event_id'] as String?,
        fromState: OfflineCommandState.inFlight.value,
        toState: OfflineCommandState.pending.value,
        reasonCode: 'authentication_required_no_retry_burn',
      );
      return true;
    });
  }

  static Future<bool> _scheduleRetryTransition(
    DatabaseExecutor db,
    Map<String, Object?> row,
    OfflineCommandEnvelope envelope, {
    required DateTime now,
    DateTime? retryAfter,
    required String reasonCode,
    String? expectedLeaseId,
  }) async {
    final attempt = row['attempt_count'] as int? ?? 0;
    if (attempt >= maxRetryCount) {
      return _transitionReady(
        db,
        row,
        toState: OfflineCommandState.needsReview,
        reasonCode: 'retry_exhausted',
        expectedLeaseId: expectedLeaseId,
      );
    }
    final nextAttempt = nextRetryAt(
      attemptCount: attempt,
      now: now,
      retryAfter: retryAfter,
    );
    if (!envelope.expiresAt.isAfter(nextAttempt)) {
      return _transitionReady(
        db,
        row,
        toState: OfflineCommandState.needsReview,
        reasonCode: 'expired_before_retry',
        expectedLeaseId: expectedLeaseId,
      );
    }
    return _transitionReady(
      db,
      row,
      toState: OfflineCommandState.retryWait,
      reasonCode: reasonCode,
      expectedLeaseId: expectedLeaseId,
      extra: {'next_attempt_at': nextAttempt.millisecondsSinceEpoch},
    );
  }

  @visibleForTesting
  static DateTime nextRetryAt({
    required int attemptCount,
    required DateTime now,
    DateTime? retryAfter,
    double? jitterFraction,
  }) {
    final exponent = max(0, attemptCount - 1);
    final rawSeconds = retryBaseDelay.inSeconds * (1 << min(exponent, 20));
    final baseSeconds = min(rawSeconds, retryMaximumDelay.inSeconds);
    final availableJitter = retryMaximumDelay.inSeconds - baseSeconds;
    final maximumJitter = min((baseSeconds * 0.2).ceil(), availableJitter);
    final fraction = (jitterFraction ?? Random.secure().nextDouble()).clamp(
      0.0,
      1.0,
    );
    final jitterSeconds = (maximumJitter * fraction).ceil();
    var candidate = now.toUtc().add(
      Duration(seconds: baseSeconds + jitterSeconds),
    );
    final retryFloor = retryAfter?.toUtc();
    if (retryFloor != null && retryFloor.isAfter(candidate)) {
      candidate = retryFloor;
    }
    return candidate;
  }

  static Future<bool> markPreparedNeedsReview({
    required int rowId,
    required String reasonCode,
    String? leaseId,
  }) async {
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where: 'id = ? AND envelope_ready = 1',
        whereArgs: [rowId],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      return _transitionReady(
        txn,
        rows.single,
        toState: OfflineCommandState.needsReview,
        reasonCode: reasonCode,
        expectedLeaseId: leaseId,
      );
    });
  }

  static Future<bool> _transitionReady(
    DatabaseExecutor db,
    Map<String, Object?> row, {
    required OfflineCommandState toState,
    required String reasonCode,
    String? actorUid,
    String? expectedLeaseId,
    DateTime? at,
    Map<String, Object?> extra = const {},
  }) async {
    final fromState = row['status'] as String?;
    final from = OfflineCommandState.fromValue(fromState);
    if (from == null || !_isPreparedTransitionAllowed(from, toState)) {
      return false;
    }
    final where = StringBuffer('id = ? AND envelope_ready = 1');
    final args = <Object?>[row['id']];
    if (fromState != null) {
      where.write(' AND status = ?');
      args.add(fromState);
    }
    if (expectedLeaseId != null) {
      where.write(' AND lease_id = ?');
      args.add(expectedLeaseId);
    }
    final changed = await db.update(
      'pending_writes',
      {
        'status': toState.value,
        'state_reason_code': reasonCode,
        'review_reason_code': toState == OfflineCommandState.needsReview
            ? reasonCode
            : null,
        'lease_id': null,
        'lease_expires_at': null,
        if (toState != OfflineCommandState.retryWait) 'next_attempt_at': null,
        ...extra,
      },
      where: where.toString(),
      whereArgs: args,
    );
    if (changed != 1) return false;
    await _appendStateEvent(
      db,
      pendingWriteId: row['id'] as int,
      clientEventId: row['client_event_id'] as String?,
      fromState: fromState,
      toState: toState.value,
      reasonCode: reasonCode,
      actorUid: actorUid,
      at: at,
    );
    return true;
  }

  static bool _isPreparedTransitionAllowed(
    OfflineCommandState from,
    OfflineCommandState to,
  ) {
    return switch (from) {
      OfflineCommandState.pending =>
        to == OfflineCommandState.inFlight ||
            to == OfflineCommandState.needsReview ||
            to == OfflineCommandState.superseded ||
            to == OfflineCommandState.cancelled,
      OfflineCommandState.inFlight =>
        to == OfflineCommandState.applied ||
            to == OfflineCommandState.retryWait ||
            to == OfflineCommandState.needsReview,
      OfflineCommandState.retryWait =>
        to == OfflineCommandState.inFlight ||
            to == OfflineCommandState.needsReview ||
            to == OfflineCommandState.superseded ||
            to == OfflineCommandState.cancelled,
      OfflineCommandState.needsReview =>
        to == OfflineCommandState.needsReview ||
            to == OfflineCommandState.applied ||
            to == OfflineCommandState.cancelled,
      OfflineCommandState.applied ||
      OfflineCommandState.superseded ||
      OfflineCommandState.cancelled => false,
    };
  }

  static Future<bool> reconcileCommand(
    int rowId,
    OfflineReconciliationRequest request,
  ) async {
    if (!request.confirmedNotRecordedOnServer ||
        request.actorUuid.trim().isEmpty) {
      return false;
    }
    final ownerId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (ownerId == null || tenantId == null) return false;
    String? currentActor;
    try {
      currentActor = await _currentActorUidResolver?.call();
    } catch (_) {
      return false;
    }
    if (currentActor != request.actorUuid) return false;
    final explanation = request.explanation?.trim();
    if ((request.reason == OfflineReconciliationReason.wrongPatientOrContext ||
            request.reason ==
                OfflineReconciliationReason.policyOrSchemaConflict) &&
        (explanation == null || explanation.isEmpty)) {
      return false;
    }
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where: 'id = ? AND tenant_id = ? AND staff_id = ?',
        whereArgs: [rowId, tenantId, ownerId],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final row = rows.single;
      final envelopeReady = row['envelope_ready'] == 1;
      final state = OfflineCommandState.fromValue(row['status'] as String?);
      final isLegacyConflict =
          !envelopeReady &&
          state == OfflineCommandState.needsReview &&
          row['state_reason_code'] == 'legacy_conflict' &&
          row['encryption_version'] == currentEncryptionVersion;
      if (!envelopeReady && !isLegacyConflict) return false;

      if (isLegacyConflict) {
        final classification = OfflineWriteContainment.classify(
          method: row['method'] as String,
          path: row['endpoint'] as String,
        );
        final legacyIsDraft = OfflineActionIds.isDraft(
          row['action_id'] as String? ?? OfflineActionIds.unknown,
        );
        final allowedReasons = legacyIsDraft
            ? const {
                OfflineReconciliationReason.recordedElsewhereVerified,
                OfflineReconciliationReason.manualEntryVerified,
                OfflineReconciliationReason.duplicateConfirmed,
                OfflineReconciliationReason.wrongPatientOrContext,
                OfflineReconciliationReason.policyOrSchemaConflict,
                OfflineReconciliationReason.draftCancelled,
              }
            : const {
                OfflineReconciliationReason.recordedElsewhereVerified,
                OfflineReconciliationReason.transferredToPaper,
                OfflineReconciliationReason.manualEntryVerified,
                OfflineReconciliationReason.duplicateConfirmed,
                OfflineReconciliationReason.wrongPatientOrContext,
                OfflineReconciliationReason.policyOrSchemaConflict,
              };
        if (!classification.isControl ||
            !allowedReasons.contains(request.reason)) {
          return false;
        }
        final detail = await _encrypt(
          OfflineCommandCodec.canonicalize({
            'confirmed_not_recorded_on_server':
                request.confirmedNotRecordedOnServer,
            'explanation': explanation,
            'reason': request.reason.code,
          }),
        );
        final deleted =
            await txn.delete(
              'pending_writes',
              where:
                  "id = ? AND status = 'needs_review' "
                  "AND state_reason_code = 'legacy_conflict' "
                  'AND tenant_id = ? AND staff_id = ? '
                  'AND encryption_version = ?',
              whereArgs: [rowId, tenantId, ownerId, currentEncryptionVersion],
            ) ==
            1;
        if (!deleted) return false;
        await _appendStateEvent(
          txn,
          pendingWriteId: rowId,
          clientEventId: row['client_event_id'] as String?,
          fromState: OfflineCommandState.needsReview.value,
          toState: OfflineCommandState.cancelled.value,
          reasonCode: request.reason.code,
          actorUid: request.actorUuid,
          detailCiphertext: detail,
        );
        return true;
      }

      final decoded = await _decodePreparedRow(txn, row);
      if (decoded == null) return false;
      final actionId = decoded.envelope.actionId;
      final isDraft = OfflineActionIds.isDraft(actionId);
      if (request.reason == OfflineReconciliationReason.draftCancelled &&
          !isDraft) {
        return false;
      }
      if (request.reason == OfflineReconciliationReason.transferredToPaper &&
          isDraft) {
        return false;
      }
      if (state == null ||
          state == OfflineCommandState.applied ||
          state == OfflineCommandState.superseded ||
          state == OfflineCommandState.cancelled ||
          state == OfflineCommandState.inFlight) {
        return false;
      }
      final detail = await _encrypt(
        OfflineCommandCodec.canonicalize({
          'confirmed_not_recorded_on_server':
              request.confirmedNotRecordedOnServer,
          'explanation': explanation,
          'reason': request.reason.code,
        }),
      );
      OfflineCommandState target;
      if (isDraft) {
        target =
            request.reason == OfflineReconciliationReason.policyOrSchemaConflict
            ? OfflineCommandState.needsReview
            : OfflineCommandState.cancelled;
      } else if (const {
        OfflineReconciliationReason.recordedElsewhereVerified,
        OfflineReconciliationReason.transferredToPaper,
        OfflineReconciliationReason.manualEntryVerified,
        OfflineReconciliationReason.duplicateConfirmed,
      }.contains(request.reason)) {
        target = OfflineCommandState.applied;
      } else {
        target = OfflineCommandState.needsReview;
      }
      final changed = await txn.update(
        'pending_writes',
        {
          'status': target.value,
          'state_reason_code': request.reason.code,
          'review_reason_code': target == OfflineCommandState.needsReview
              ? request.reason.code
              : null,
          'lease_id': null,
          'lease_expires_at': null,
          'next_attempt_at': null,
          if (target == OfflineCommandState.applied)
            'applied_at': DateTime.now().millisecondsSinceEpoch,
        },
        where: 'id = ? AND status = ?',
        whereArgs: [rowId, state.value],
      );
      if (changed != 1) return false;
      await _appendStateEvent(
        txn,
        pendingWriteId: rowId,
        clientEventId: row['client_event_id'] as String?,
        fromState: state.value,
        toState: target.value,
        reasonCode: request.reason.code,
        actorUid: request.actorUuid,
        detailCiphertext: detail,
      );
      return true;
    });
  }

  @visibleForTesting
  static Future<PersistedOfflineCommand?> debugReadPreparedCommand(
    int rowId,
  ) async {
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where: 'id = ? AND envelope_ready = 1',
      whereArgs: [rowId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return _decodePreparedRow(db, rows.single);
  }

  static Future<void> markConflict(int id, String reason) async {
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where: "id = ? AND envelope_ready = 0 AND status = 'pending'",
      whereArgs: [id],
      limit: 1,
    );
    if (rows.isEmpty) return;
    final row = rows.single;
    final key = await _readEncryptionKey(createIfMissing: false);
    if (key == null) {
      await _markNeedsReview(
        db,
        id,
        OfflineWriteReviewReason.unknownEncryptionVersion,
        clearEncryptionVersion: true,
      );
      return;
    }
    String encryptedReason;
    try {
      if (row['encryption_version'] != currentEncryptionVersion) {
        throw const OfflineWriteRejected('unknown_encryption_version');
      }
      final plain = await _decryptWithKey(row['body'] as String, key);
      if (jsonDecode(plain) is! Map<String, dynamic>) {
        throw const FormatException('Body is not a JSON object');
      }
      encryptedReason = await _encryptWithKey(reason, key);
    } on OfflineWriteRejected {
      await _markNeedsReview(
        db,
        id,
        OfflineWriteReviewReason.unknownEncryptionVersion,
        clearEncryptionVersion: true,
      );
      return;
    } catch (_) {
      await _markNeedsReview(
        db,
        id,
        OfflineWriteReviewReason.decryptFailed,
        clearEncryptionVersion: true,
      );
      return;
    }
    final changed = await db.update(
      'pending_writes',
      {
        'status': OfflineCommandState.needsReview.value,
        'conflict_reason': encryptedReason,
        'state_reason_code': 'legacy_conflict',
      },
      where:
          "id = ? AND envelope_ready = 0 AND status = 'pending' "
          "AND encryption_version = ? "
          'AND tenant_id = ?',
      whereArgs: [id, currentEncryptionVersion, _validatedTenantId()],
    );
    if (changed != 1) return;
    await _appendStateEvent(
      db,
      pendingWriteId: id,
      clientEventId: row['client_event_id'] as String?,
      fromState: OfflineCommandState.pending.value,
      toState: OfflineCommandState.needsReview.value,
      reasonCode: 'legacy_conflict',
    );
  }

  static Future<bool> removeAfterSuccessfulSync({
    required int id,
    required String expectedStaffId,
    required String expectedTenantId,
  }) async {
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (rows.isEmpty) return false;
    final row = rows.single;
    final classification = OfflineWriteContainment.classify(
      method: row['method'] as String,
      path: row['endpoint'] as String,
    );
    if (!classification.isControl ||
        row['status'] != OfflineWriteStatus.pending.value ||
        row['envelope_ready'] == 1 ||
        row['staff_id'] != expectedStaffId ||
        row['tenant_id'] != expectedTenantId ||
        row['encryption_version'] != currentEncryptionVersion) {
      return false;
    }
    return await db.delete(
          'pending_writes',
          where:
              "id = ? AND envelope_ready = 0 AND status = 'pending' "
              "AND staff_id = ? "
              'AND tenant_id = ? AND encryption_version = ?',
          whereArgs: [
            id,
            expectedStaffId,
            expectedTenantId,
            currentEncryptionVersion,
          ],
        ) ==
        1;
  }

  /// The deliberate scratchpad-draft cleanup path.
  static Future<int> removePendingMatching({
    required String endpoint,
    required bool Function(Map<String, dynamic> body) matches,
  }) async {
    final db = await database;
    final staffId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (staffId == null || tenantId == null) return 0;
    if (OfflineWriteContainment.classify(
          method: 'PUT',
          path: endpoint,
        ).family !=
        OfflineWriteActionFamily.noteDraft) {
      return 0;
    }
    final rows = await db.query(
      'pending_writes',
      columns: ['id', 'body', 'encryption_version'],
      where:
          "envelope_ready = 0 AND status = 'pending' "
          "AND staff_id = ? AND tenant_id = ? "
          "AND endpoint = ? AND method = 'PUT'",
      whereArgs: [staffId, tenantId, endpoint],
    );
    var removed = 0;
    for (final row in rows) {
      try {
        final body = await decodeBody(
          row['body'] as String,
          encryptionVersion: row['encryption_version'] as int? ?? -1,
        );
        if (!matches(body)) continue;
        removed += await db.delete(
          'pending_writes',
          where:
              "id = ? AND status = 'pending' AND staff_id = ? "
              'AND tenant_id = ?',
          whereArgs: [row['id'], staffId, tenantId],
        );
      } on OfflineWriteRejected {
        await _markNeedsReview(
          db,
          row['id'] as int,
          OfflineWriteReviewReason.unknownEncryptionVersion,
          clearEncryptionVersion: true,
        );
      } catch (_) {
        await _markNeedsReview(
          db,
          row['id'] as int,
          OfflineWriteReviewReason.decryptFailed,
          clearEncryptionVersion: true,
        );
      }
    }
    return removed;
  }

  static Future<int> incrementRetryOrExhaust(int id) async {
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where: "id = ? AND envelope_ready = 0 AND status = 'pending'",
        whereArgs: [id],
        limit: 1,
      );
      if (rows.isEmpty) return 0;
      final current = rows.single['retry_count'] as int? ?? 0;
      final next = current + 1;
      await txn.update(
        'pending_writes',
        next >= maxRetryCount
            ? {
                'retry_count': next,
                'status': OfflineWriteStatus.needsReview.value,
                'review_reason_code':
                    OfflineWriteReviewReason.retryExhausted.code,
              }
            : {'retry_count': next},
        where: "id = ? AND envelope_ready = 0 AND status = 'pending'",
        whereArgs: [id],
      );
      return next;
    });
  }

  static Future<void> quarantineDecryptFailure(int id) async {
    final db = await database;
    await _markNeedsReview(
      db,
      id,
      OfflineWriteReviewReason.decryptFailed,
      clearEncryptionVersion: true,
    );
  }

  static Future<void> _markNeedsReview(
    DatabaseExecutor db,
    int id,
    OfflineWriteReviewReason reason, {
    bool clearEncryptionVersion = false,
  }) async {
    await db.update(
      'pending_writes',
      {
        'status': OfflineWriteStatus.needsReview.value,
        'review_reason_code': reason.code,
        if (clearEncryptionVersion) 'encryption_version': null,
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  static Future<bool> attestHandoff({
    required int id,
    required String actorUid,
    DateTime? at,
  }) async {
    if (actorUid.isEmpty) return false;
    final currentStaffId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (currentStaffId == null || tenantId == null) {
      return false;
    }
    String? authoritativeActorUid;
    try {
      authoritativeActorUid = await _currentActorUidResolver?.call();
    } catch (_) {
      return false;
    }
    if (authoritativeActorUid == null ||
        authoritativeActorUid.isEmpty ||
        authoritativeActorUid != actorUid) {
      return false;
    }
    final db = await database;
    return db.transaction((txn) async {
      final rows = await txn.query(
        'pending_writes',
        where: 'id = ?',
        whereArgs: [id],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final row = rows.single;
      final classification = OfflineWriteContainment.classify(
        method: row['method'] as String,
        path: row['endpoint'] as String,
      );
      if (row['status'] != OfflineWriteStatus.needsReview.value ||
          row['staff_id'] != currentStaffId ||
          row['tenant_id'] != tenantId ||
          row['reconciliation_owner_id'] == null ||
          !_reviewReasonMatchesClassification(
            row['review_reason_code'] as String?,
            classification,
          ) ||
          row['handoff_attested_at'] != null ||
          row['handoff_attested_by'] != null) {
        return false;
      }
      return await txn.update(
            'pending_writes',
            {
              'handoff_attested_at':
                  (at ?? DateTime.now()).millisecondsSinceEpoch,
              'handoff_attested_by': actorUid,
            },
            where:
                "id = ? AND status = 'needs_review' AND staff_id = ? "
                'AND tenant_id = ? AND handoff_attested_at IS NULL '
                'AND handoff_attested_by IS NULL',
            whereArgs: [id, currentStaffId, tenantId],
          ) ==
          1;
    });
  }

  static Future<bool> retryConflict(int id) async {
    final currentStaffId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (currentStaffId == null || tenantId == null) return false;
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (rows.isEmpty) return false;
    final row = rows.single;
    final classification = OfflineWriteContainment.classify(
      method: row['method'] as String,
      path: row['endpoint'] as String,
    );
    final isLegacyConflict =
        row['status'] == OfflineCommandState.needsReview.value &&
        row['state_reason_code'] == 'legacy_conflict';
    if (!classification.isControl ||
        !isLegacyConflict ||
        row['staff_id'] != currentStaffId ||
        row['tenant_id'] != tenantId ||
        row['encryption_version'] != currentEncryptionVersion) {
      return false;
    }
    return db.transaction((txn) async {
      final changed = await txn.update(
        'pending_writes',
        {
          'status': OfflineWriteStatus.pending.value,
          'conflict_reason': null,
          'retry_count': 0,
          'state_reason_code': null,
        },
        where:
            "id = ? AND status = 'needs_review' "
            "AND state_reason_code = 'legacy_conflict' AND staff_id = ? "
            'AND tenant_id = ? AND encryption_version = ?',
        whereArgs: [id, currentStaffId, tenantId, currentEncryptionVersion],
      );
      if (changed == 1) {
        await _appendStateEvent(
          txn,
          pendingWriteId: id,
          clientEventId: row['client_event_id'] as String?,
          fromState: OfflineCommandState.needsReview.value,
          toState: OfflineCommandState.pending.value,
          reasonCode: 'legacy_conflict_retry',
        );
      }
      return changed == 1;
    });
  }

  static bool _reviewReasonMatchesClassification(
    String? reasonCode,
    OfflineWriteClassification classification,
  ) {
    final reason = OfflineWriteReviewReason.fromCode(reasonCode);
    if (reason == null) return false;
    if (reason == OfflineWriteReviewReason.unknownAction) {
      return !classification.isKnown;
    }
    if (reason.name.startsWith('contained')) {
      return classification.isContained &&
          classification.reviewReason == reason;
    }
    return true;
  }

  static Future<bool> discardConflict(
    int id, {
    required bool reconciliationConfirmed,
  }) async {
    final currentStaffId = await AuthService.getStaffId();
    final tenantId = _validatedTenantId();
    if (currentStaffId == null || tenantId == null) return false;
    String? currentActor;
    try {
      currentActor = await _currentActorUidResolver?.call();
    } catch (_) {
      return false;
    }
    if (currentActor == null || currentActor.trim().isEmpty) return false;
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where: 'id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (rows.isEmpty) return false;
    final row = rows.single;
    final method = row['method'] as String;
    final endpoint = row['endpoint'] as String;
    final classification = OfflineWriteContainment.classify(
      method: method,
      path: endpoint,
    );
    final isLegacyConflict =
        row['status'] == OfflineCommandState.needsReview.value &&
        row['state_reason_code'] == 'legacy_conflict';
    if (!classification.isControl ||
        !isLegacyConflict ||
        row['staff_id'] != currentStaffId ||
        row['tenant_id'] != tenantId ||
        row['encryption_version'] != currentEncryptionVersion ||
        (OfflineWriteContainment.requiresReconciledDiscard(
              method: method,
              path: endpoint,
            ) &&
            !reconciliationConfirmed)) {
      return false;
    }
    return db.transaction((txn) async {
      final deleted =
          await txn.delete(
            'pending_writes',
            where:
                "id = ? AND status = 'needs_review' "
                "AND state_reason_code = 'legacy_conflict' AND staff_id = ? "
                'AND tenant_id = ? AND encryption_version = ?',
            whereArgs: [id, currentStaffId, tenantId, currentEncryptionVersion],
          ) ==
          1;
      if (!deleted) return false;
      await _appendStateEvent(
        txn,
        pendingWriteId: id,
        clientEventId: row['client_event_id'] as String?,
        fromState: OfflineCommandState.needsReview.value,
        toState: OfflineCommandState.cancelled.value,
        reasonCode:
            OfflineReconciliationReason.legacyReconciliationConfirmed.code,
        actorUid: currentActor,
      );
      return true;
    });
  }

  static Future<int> blockingWriteCountForCurrentOwner() async {
    final entries = await unresolvedEntriesForCurrentOwner();
    return entries
        .where(
          (entry) =>
              entry.status == OfflineWriteStatus.pending ||
              entry.status == OfflineWriteStatus.inFlight ||
              entry.status == OfflineWriteStatus.retryWait ||
              entry.status == OfflineWriteStatus.conflict ||
              (entry.status == OfflineWriteStatus.needsReview &&
                  !entry.isHandoffAttested),
        )
        .length;
  }

  static Future<int> unresolvedWriteCountForCurrentOwner() async =>
      (await unresolvedEntriesForCurrentOwner()).length;

  @visibleForTesting
  static Future<List<Map<String, Object?>>> debugAllRows() async {
    final db = await database;
    final rows = await db.query('pending_writes', orderBy: pendingDrainOrderBy);
    return rows.map(_legacyCompatibilityRow).toList();
  }

  @visibleForTesting
  static Future<List<Map<String, Object?>>> debugStateEvents() async {
    final db = await database;
    return db.query(
      'offline_write_state_events',
      orderBy: 'event_at ASC, id ASC',
    );
  }

  /// Close singleton state without deleting rows or the encryption key.
  @visibleForTesting
  static Future<void> resetForTesting() async {
    final opening = _dbOpening;
    if (opening != null) {
      try {
        await opening;
      } catch (_) {
        // A failed test-only open has no database handle to close.
      }
    }
    await _db?.close();
    _db = null;
    _dbOpening = null;
    _aesKey = null;
  }

  /// Deletes only a uniquely named test database.
  @visibleForTesting
  static Future<void> deleteTestDatabase() async {
    final override = debugDbFileNameOverride;
    if (override == null ||
        override.isEmpty ||
        override == _expectedDbFileName ||
        override.contains('/') ||
        override.contains(r'\')) {
      throw StateError('A unique test DB override is required');
    }
    await resetForTesting();
    final dbPath = await getDatabasesPath();
    await deleteDatabase(join(dbPath, override));
  }

  @visibleForTesting
  static void resetMetadataResolversForTesting() {
    _tenantIdResolver = null;
    _reconciliationOwnerResolver = null;
    _currentActorUidResolver = null;
    _currentActorRoleResolver = null;
  }
}
