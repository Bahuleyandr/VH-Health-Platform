import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

class OfflineQueueTestHarness {
  OfflineQueueTestHarness(this.name);

  static int _sequence = 0;
  static const _storageChannel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  final String name;
  final Map<String, String> secureStore = {};
  String currentActorUid = 'staff-user-uid';
  String? _blockedReadKey;
  Completer<void>? _blockedRead;
  late final String dbName =
      '${name}_${DateTime.now().microsecondsSinceEpoch}_${_sequence++}.db';

  Future<void> setUp() async {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_storageChannel, _handleStorageCall);
    OfflineQueue.debugDbFileNameOverride = dbName;
    OfflineQueue.registerMetadataResolvers(
      tenantIdResolver: () => TenantConfig.id,
      reconciliationOwnerResolver: (_) =>
          OfflineQueue.fallbackReconciliationRole,
      currentActorUidResolver: () async => currentActorUid,
    );
    await OfflineQueue.deleteTestDatabase();
  }

  Future<void> tearDown() async {
    await OfflineQueue.deleteTestDatabase();
    OfflineQueue.resetMetadataResolversForTesting();
    OfflineQueue.debugDbFileNameOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_storageChannel, null);
    secureStore.clear();
  }

  Future<Object?> _handleStorageCall(MethodCall call) async {
    final args = Map<String, dynamic>.from(call.arguments as Map);
    switch (call.method) {
      case 'read':
        if (args['key'] == _blockedReadKey && _blockedRead != null) {
          await _blockedRead!.future;
        }
        return secureStore[args['key']];
      case 'write':
        secureStore[args['key'] as String] = args['value'] as String;
        return null;
      case 'delete':
        secureStore.remove(args['key']);
        return null;
      case 'deleteAll':
        secureStore.clear();
        return null;
      case 'readAll':
        return Map<String, String>.from(secureStore);
      case 'containsKey':
        return secureStore.containsKey(args['key']);
      default:
        return null;
    }
  }

  void blockSecureStorageRead(String key) {
    _blockedReadKey = key;
    _blockedRead = Completer<void>();
  }

  void releaseSecureStorageRead() {
    _blockedReadKey = null;
    final blocked = _blockedRead;
    _blockedRead = null;
    if (blocked != null && !blocked.isCompleted) blocked.complete();
  }

  Future<String> get databasePath async =>
      p.join(await sqflite.getDatabasesPath(), dbName);

  void installFixedEncryptionKey([List<int>? bytes]) {
    final key = bytes ?? List<int>.generate(32, (index) => index);
    secureStore[OfflineQueue.debugEncryptionKeyName] = base64Encode(key);
  }

  void removeEncryptionKey() {
    secureStore.remove(OfflineQueue.debugEncryptionKeyName);
  }

  String? get storedEncryptionKey =>
      secureStore[OfflineQueue.debugEncryptionKeyName];

  Future<String> encryptV1(String plaintext, {List<int>? nonce}) async {
    final keyBase64 = storedEncryptionKey;
    if (keyBase64 == null) {
      throw StateError('Install a fixed encryption key first');
    }
    final actualNonce = nonce ?? List<int>.generate(12, (index) => index + 1);
    final box = await AesGcm.with256bits().encrypt(
      utf8.encode(plaintext),
      secretKey: SecretKey(base64Decode(keyBase64)),
      nonce: actualNonce,
    );
    final combined = <int>[...box.cipherText, ...box.mac.bytes];
    return '${base64Encode(actualNonce)}:${base64Encode(combined)}';
  }

  Future<String> decryptV1(String stored) async {
    final keyBase64 = storedEncryptionKey;
    if (keyBase64 == null) {
      throw StateError('Install a fixed encryption key first');
    }
    final parts = stored.split(':');
    final nonce = base64Decode(parts[0]);
    final combined = base64Decode(parts[1]);
    final plain = await AesGcm.with256bits().decrypt(
      SecretBox(
        combined.sublist(0, combined.length - 16),
        nonce: nonce,
        mac: Mac(combined.sublist(combined.length - 16)),
      ),
      secretKey: SecretKey(base64Decode(keyBase64)),
    );
    return utf8.decode(plain);
  }

  Future<void> createV1Fixture(List<Map<String, Object?>> rows) async {
    await _createFixture(version: 1, rows: rows);
  }

  Future<void> createV4Fixture(List<Map<String, Object?>> rows) async {
    await _createFixture(version: 4, rows: rows);
  }

  Future<void> createV5Fixture(List<Map<String, Object?>> rows) async {
    await _createFixture(version: 5, rows: rows);
  }

  Future<void> _createFixture({
    required int version,
    required List<Map<String, Object?>> rows,
  }) async {
    await OfflineQueue.deleteTestDatabase();
    final path = await databasePath;
    final db = await sqflite.openDatabase(
      path,
      version: version,
      onCreate: (database, _) async {
        if (version == 1) {
          await database.execute('''
            CREATE TABLE pending_writes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              endpoint TEXT NOT NULL,
              method TEXT NOT NULL,
              body TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              retry_count INTEGER DEFAULT 0,
              context_label TEXT
            )
          ''');
        } else if (version == 4) {
          await database.execute('''
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
              staff_id TEXT
            )
          ''');
        } else {
          await database.execute('''
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
        }
      },
    );
    for (final row in rows) {
      await db.insert('pending_writes', row);
    }
    await db.close();
    await OfflineQueue.resetForTesting();
  }
}
