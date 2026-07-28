import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

import '../config/tenant_config.dart';
import '../models/offline_write_entry.dart';
import 'auth_service.dart';
import 'idempotency_key.dart';
import 'offline_write_containment.dart';
import 'secure_storage.dart';

typedef OfflineQueueTenantIdResolver = String? Function();
typedef OfflineQueueReconciliationOwnerResolver =
    String? Function(String tenantId);
typedef OfflineQueueCurrentActorUidResolver = Future<String?> Function();

class OfflineWriteRejected implements Exception {
  const OfflineWriteRejected(this.reasonCode);

  final String reasonCode;

  @override
  String toString() => 'OfflineWriteRejected($reasonCode)';
}

/// SQLite-backed, owner-bound queue for the two C0A-eligible offline controls.
///
/// The six quarantined clinical families, unknown actions, and rows with
/// untrusted metadata are retained as `needs_review` and never replayed.
class OfflineQueue {
  OfflineQueue._();

  static const int schemaVersion = 5;
  static const int currentEncryptionVersion = 1;
  static const int maxRetryCount = 6;
  static const String fallbackReconciliationRole = 'role:clinical_safety_lead';

  static Database? _db;
  static Future<Database>? _dbOpening;
  static SecretKey? _aesKey;
  static final AesGcm _aesGcm = AesGcm.with256bits();
  static OfflineQueueTenantIdResolver? _tenantIdResolver;
  static OfflineQueueReconciliationOwnerResolver? _reconciliationOwnerResolver;
  static OfflineQueueCurrentActorUidResolver? _currentActorUidResolver;

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
  }) {
    _tenantIdResolver = tenantIdResolver;
    _reconciliationOwnerResolver = reconciliationOwnerResolver;
    _currentActorUidResolver = currentActorUidResolver;
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

  static Future<String> _encryptWithKey(String plaintext, SecretKey key) async {
    final nonce = _secureRandomBytes(12);
    final box = await _aesGcm.encrypt(
      utf8.encode(plaintext),
      secretKey: key,
      nonce: nonce,
    );
    final combined = Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
    return '${base64Encode(nonce)}:${base64Encode(combined)}';
  }

  static Future<String> _decryptWithKey(
    String ciphertext,
    SecretKey key,
  ) async {
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
            handoff_attested_by TEXT
          )
        ''');
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        await _migrateToV5(db);
      },
      onOpen: (db) async {
        await db.transaction((txn) => _migrateToV5(txn));
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

  static Future<void> _migrateToV5(DatabaseExecutor db) async {
    final info = await db.rawQuery('PRAGMA table_info(pending_writes)');
    if (info.isEmpty) return;
    final columns = info.map((row) => row['name'] as String).toSet();
    for (final entry in _columnsThroughV5.entries) {
      if (!columns.contains(entry.key)) {
        await db.execute(
          'ALTER TABLE pending_writes ADD COLUMN ${entry.key} ${entry.value}',
        );
      }
    }

    final rows = await db.query('pending_writes', orderBy: pendingDrainOrderBy);
    for (final row in rows) {
      await _migrateRow(db, row);
    }
  }

  static Future<void> _migrateRow(
    DatabaseExecutor db,
    Map<String, Object?> row,
  ) async {
    final id = row['id'] as int;
    final storedBody = row['body'] as String;
    final updates = <String, Object?>{};
    final validTenantId = _validatedTenantId();
    final storedTenantId = _nonEmptyString(row['tenant_id']);
    final staffId = _nonEmptyString(row['staff_id']);
    var tenantId = storedTenantId;
    var reconciliationOwnerId = _nonEmptyString(row['reconciliation_owner_id']);
    var encryptionVersion = row['encryption_version'] as int?;
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
          if (jsonDecode(plain) is! Map<String, dynamic>) {
            throw const FormatException('Body is not a JSON object');
          }
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
          if (jsonDecode(plain) is! Map<String, dynamic>) {
            throw const FormatException('Body is not a JSON object');
          }
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
    if (reason != null || alreadyNeedsReview) {
      updates['status'] = 'needs_review';
      updates['review_reason_code'] =
          reason?.code ??
          existingReason?.code ??
          OfflineWriteReviewReason.unknownAction.code;
    } else if (storedStatus != 'pending' && storedStatus != 'conflict') {
      updates['status'] = 'needs_review';
      updates['review_reason_code'] =
          OfflineWriteReviewReason.unknownAction.code;
    }

    if (updates.isNotEmpty) {
      await db.update(
        'pending_writes',
        updates,
        where: 'id = ?',
        whereArgs: [id],
      );
    }
  }

  static String? _nonEmptyString(Object? value) {
    final text = value as String?;
    return text == null || text.isEmpty ? null : text;
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
    final encryptedBody = await _encrypt(jsonEncode(body));
    final encryptedContext = contextLabel == null
        ? null
        : await _encrypt(contextLabel);
    return db.insert('pending_writes', {
      'endpoint': endpoint,
      'method': classification.method,
      'body': encryptedBody,
      'created_at': DateTime.now().millisecondsSinceEpoch,
      'retry_count': 0,
      'context_label': encryptedContext,
      'status': OfflineWriteStatus.pending.value,
      'idempotency_key': IdempotencyKey.generate(),
      'staff_id': staffId,
      'tenant_id': tenantId,
      'encryption_version': currentEncryptionVersion,
      'reconciliation_owner_id': staffId,
    });
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
    return db.query(
      'pending_writes',
      where: "status = 'conflict' AND staff_id = ?",
      whereArgs: [staffId],
      orderBy: pendingDrainOrderBy,
    );
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
          "staff_id = ? AND status IN ('pending', 'conflict', 'needs_review')",
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
          "staff_id = ? AND status IN ('pending', 'conflict', 'needs_review')",
      whereArgs: [staffId],
      orderBy: pendingDrainOrderBy,
    );
    final validTenantId = _validatedTenantId();
    for (final row in rows) {
      if (row['status'] == 'needs_review') continue;
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
    var status =
        OfflineWriteStatus.fromValue(row['status'] as String?) ??
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
    final endpoint = row['endpoint'] as String;
    final method = row['method'] as String;
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
      classification: OfflineWriteContainment.classify(
        method: method,
        path: endpoint,
      ),
    );
  }

  static List<OfflineWriteEntry> _withComputedPartitionBlockers(
    List<OfflineWriteEntry> entries,
  ) {
    final blockers = <String, OfflineWriteEntry>{};
    final result = <OfflineWriteEntry>[];
    for (final entry in entries) {
      final partition = _partitionKey(entry);
      final blocker = blockers[partition];
      if (entry.status == OfflineWriteStatus.pending && blocker != null) {
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

  static Future<void> markConflict(int id, String reason) async {
    final db = await database;
    final rows = await db.query(
      'pending_writes',
      where: "id = ? AND status = 'pending'",
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
    await db.update(
      'pending_writes',
      {
        'status': OfflineWriteStatus.conflict.value,
        'conflict_reason': encryptedReason,
      },
      where:
          "id = ? AND status = 'pending' AND encryption_version = ? "
          'AND tenant_id = ?',
      whereArgs: [id, currentEncryptionVersion, _validatedTenantId()],
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
        row['staff_id'] != expectedStaffId ||
        row['tenant_id'] != expectedTenantId ||
        row['encryption_version'] != currentEncryptionVersion) {
      return false;
    }
    return await db.delete(
          'pending_writes',
          where:
              "id = ? AND status = 'pending' AND staff_id = ? "
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
          "status = 'pending' AND staff_id = ? AND tenant_id = ? "
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
        where: "id = ? AND status = 'pending'",
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
        where: "id = ? AND status = 'pending'",
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
    if (!classification.isControl ||
        row['status'] != OfflineWriteStatus.conflict.value ||
        row['staff_id'] != currentStaffId ||
        row['tenant_id'] != tenantId ||
        row['encryption_version'] != currentEncryptionVersion) {
      return false;
    }
    return await db.update(
          'pending_writes',
          {
            'status': OfflineWriteStatus.pending.value,
            'conflict_reason': null,
            'retry_count': 0,
          },
          where:
              "id = ? AND status = 'conflict' AND staff_id = ? "
              'AND tenant_id = ? AND encryption_version = ?',
          whereArgs: [id, currentStaffId, tenantId, currentEncryptionVersion],
        ) ==
        1;
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
    if (!classification.isControl ||
        row['status'] != OfflineWriteStatus.conflict.value ||
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
    return await db.delete(
          'pending_writes',
          where:
              "id = ? AND status = 'conflict' AND staff_id = ? "
              'AND tenant_id = ? AND encryption_version = ?',
          whereArgs: [id, currentStaffId, tenantId, currentEncryptionVersion],
        ) ==
        1;
  }

  static Future<int> blockingWriteCountForCurrentOwner() async {
    final entries = await unresolvedEntriesForCurrentOwner();
    return entries
        .where(
          (entry) =>
              entry.status == OfflineWriteStatus.pending ||
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
    return db.query('pending_writes', orderBy: pendingDrainOrderBy);
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
  }
}
