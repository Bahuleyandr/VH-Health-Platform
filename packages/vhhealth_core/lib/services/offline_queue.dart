import 'dart:convert';
import 'dart:math';

import 'package:encrypt/encrypt.dart' as encrypt;
import 'package:flutter/foundation.dart';
import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

import '../config/tenant_config.dart';
import 'auth_service.dart';
import 'idempotency_key.dart';
import 'secure_storage.dart';

/// SQLite-based queue for pending API writes when offline.
///
/// PHI-at-rest hardening (audit 2026-06-18, staff app §3):
///
///  * **Encryption** — the request `body` (patient ids, vitals, clinical
///    notes) is encrypted with AES-256-GCM before it is written to the
///    `body` column and decrypted only when a write is drained. The column
///    therefore never holds cleartext PHI, mirroring the patient app's
///    `ApiCacheManager` at-rest scheme (same `iv:ciphertext` envelope, same
///    `VHSecureStorage`-held key).
///  * **Owner scoping** — every row records the `staff_id` that enqueued it.
///    On a shared ward device the drain only ever syncs rows belonging to the
///    currently-logged-in staff identity, so user B can never replay user A's
///    queued clinical writes under B's JWT/authorship.
///  * **Secure delete** — [clearAll] runs `VACUUM` after the delete so the
///    freed pages holding (encrypted) PHI do not linger in the database file.
class OfflineQueue {
  OfflineQueue._();
  static Database? _db;

  // ── At-rest encryption (AES-256-GCM) ──────────────────────────────────
  // Mirrors apps/patient ApiCacheManager: a 256-bit key minted once and kept
  // in the shared secure store, ciphertext serialised as `iv:ciphertext`.
  //
  // W6 T2 (defense-in-depth): the DB file + the AES key name are namespaced by
  // the build's tenant. Each per-tenant build is already a separate app sandbox,
  // so this is belt-and-suspenders, not the primary isolation. The DEFAULT
  // (unstamped) build keeps the original names verbatim — a strict NO-OP so an
  // existing install never orphans its queued (encrypted) PHI.
  static String get _keyName => TenantConfig.isDefaultTenant
      ? 'offline_queue_aes_key'
      : 'offline_queue_aes_key_${TenantConfig.cacheNamespace}';

  /// SQLite filename, tenant-namespaced for stamped builds (default ⇒ unchanged).
  @visibleForTesting
  static String? debugDbFileNameOverride;

  /// SQLite filename, tenant-namespaced for stamped builds (default ⇒ unchanged).
  @visibleForTesting
  static String get dbFileName {
    final override = debugDbFileNameOverride;
    if (override != null) return override;
    return TenantConfig.isDefaultTenant
        ? 'offline_queue.db'
        : 'offline_queue_${TenantConfig.cacheNamespace}.db';
  }

  static encrypt.Key? _aesKey;

  /// Retrieve or generate the 256-bit AES key from secure storage.
  static Future<encrypt.Key> _getEncryptionKey() async {
    if (_aesKey != null) return _aesKey!;
    final storage = VHSecureStorage.instance;
    var keyBase64 = await storage.read(key: _keyName);
    if (keyBase64 == null) {
      final random = Random.secure();
      final keyBytes = Uint8List(32);
      for (var i = 0; i < 32; i++) {
        keyBytes[i] = random.nextInt(256);
      }
      keyBase64 = base64Encode(keyBytes);
      await storage.write(key: _keyName, value: keyBase64);
    }
    _aesKey = encrypt.Key.fromBase64(keyBase64);
    return _aesKey!;
  }

  /// Encrypt [plaintext] with AES-256-GCM and a random 12-byte IV.
  /// Returns `iv_base64:ciphertext_base64`.
  static Future<String> _encrypt(String plaintext) async {
    final key = await _getEncryptionKey();
    final iv = encrypt.IV.fromSecureRandom(12);
    final encrypter = encrypt.Encrypter(
      encrypt.AES(key, mode: encrypt.AESMode.gcm),
    );
    final encrypted = encrypter.encrypt(plaintext, iv: iv);
    return '${iv.base64}:${encrypted.base64}';
  }

  /// Decrypt a string produced by [_encrypt].
  static Future<String> _decrypt(String ciphertext) async {
    final key = await _getEncryptionKey();
    final parts = ciphertext.split(':');
    if (parts.length != 2) {
      throw const FormatException('Invalid encrypted data');
    }
    final iv = encrypt.IV.fromBase64(parts[0]);
    final encrypter = encrypt.Encrypter(
      encrypt.AES(key, mode: encrypt.AESMode.gcm),
    );
    return encrypter.decrypt(encrypt.Encrypted.fromBase64(parts[1]), iv: iv);
  }

  /// Decode a stored `body` value into the original request map.
  ///
  /// New rows hold an `iv:ciphertext` envelope. Rows written before the v4
  /// migration hold raw `jsonEncode(body)` — detected by a failed decrypt —
  /// and are read back as-is so an in-flight pre-upgrade queue still drains.
  static Future<Map<String, dynamic>> decodeBody(String stored) async {
    String jsonStr;
    try {
      jsonStr = await _decrypt(stored);
    } catch (_) {
      // Legacy plaintext row (pre-v4) — fall back to the raw JSON.
      jsonStr = stored;
    }
    return jsonDecode(jsonStr) as Map<String, dynamic>;
  }

  static Future<Database> get database async {
    _db ??= await _initDb();
    return _db!;
  }

  static Future<Database> _initDb() async {
    final dbPath = await getDatabasesPath();
    return openDatabase(
      join(dbPath, dbFileName),
      version: 4,
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
            staff_id TEXT
          )
        ''');
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
            "ALTER TABLE pending_writes ADD COLUMN status TEXT DEFAULT 'pending'",
          );
          await db.execute(
            'ALTER TABLE pending_writes ADD COLUMN conflict_reason TEXT',
          );
        }
        if (oldVersion < 3) {
          // Stable Idempotency-Key per queued write so a redrain reuses the
          // SAME key and the backend de-duplicates replays (finding #15).
          await db.execute(
            'ALTER TABLE pending_writes ADD COLUMN idempotency_key TEXT',
          );
        }
        if (oldVersion < 4) {
          // Owner column so the drain can scope to the current staff identity
          // on a shared ward device (audit 2026-06-18). Existing rows have a
          // NULL owner; the drain quarantines those rather than replaying
          // them under whoever logs in next. `body` for those legacy rows is
          // still plaintext — decodeBody() handles that transparently.
          await db.execute(
            'ALTER TABLE pending_writes ADD COLUMN staff_id TEXT',
          );
        }
      },
    );
  }

  /// Enqueue a write (POST/PUT/PATCH).
  ///
  /// A stable [IdempotencyKey] is minted once at enqueue time and persisted
  /// with the row. Every drain (including a redrain after a lost-2xx retry)
  /// sends the SAME `Idempotency-Key` header, so the backend collapses the
  /// replay into the original response instead of duplicating the write.
  ///
  /// The [body] is encrypted at rest (AES-256-GCM) and the row is stamped with
  /// the current staff identity ([AuthService.getStaffId]) so the drain can
  /// scope replays to the right user on a shared device.
  static Future<int> enqueue({
    required String endpoint,
    required String method,
    required Map<String, dynamic> body,
    String? contextLabel,
  }) async {
    final db = await database;
    final encryptedBody = await _encrypt(jsonEncode(body));
    final staffId = await AuthService.getStaffId();
    return db.insert('pending_writes', {
      'endpoint': endpoint,
      'method': method,
      'body': encryptedBody,
      'created_at': DateTime.now().millisecondsSinceEpoch,
      'retry_count': 0,
      'context_label': contextLabel,
      'idempotency_key': IdempotencyKey.generate(),
      'staff_id': staffId,
    });
  }

  /// Drain order for [getPending].
  ///
  /// `created_at ASC` is the primary key (oldest write first). The `id ASC`
  /// secondary key makes SAME-MILLISECOND ties deterministic: within one
  /// `created_at` value rows drain in insert order (lowest auto-increment `id`
  /// first). Without it the tie order is left to SQLite and is not guaranteed.
  ///
  /// This matters for the offline notes flow: an autosave draft
  /// `PUT /emr/notes/draft` is enqueued while typing (lower `id`) and the final
  /// `POST /emr/notes` is enqueued on finalize (higher `id`). If both land in
  /// the same millisecond, the tiebreak guarantees the draft PUT drains BEFORE
  /// the note POST, so the server's finalize-clear reaps the recreated draft
  /// (self-healing order) instead of leaving a stale draft behind.
  @visibleForTesting
  static const String pendingDrainOrderBy = 'created_at ASC, id ASC';

  /// Get all pending writes owned by the current staff identity (excludes
  /// conflicted items and rows belonging to a different user / legacy NULL
  /// owner — those are quarantined, never drained under the wrong identity).
  static Future<List<Map<String, dynamic>>> getPending() async {
    final db = await database;
    final staffId = await AuthService.getStaffId();
    if (staffId == null) {
      // No identity → nothing this user owns is drainable.
      return const [];
    }
    return db.query(
      'pending_writes',
      where: "status = 'pending' AND staff_id = ?",
      whereArgs: [staffId],
      orderBy: pendingDrainOrderBy,
    );
  }

  /// Get writes that were rejected as conflicts (server had newer data),
  /// scoped to the current staff identity. UI can show these to the user for
  /// manual resolution.
  static Future<List<Map<String, dynamic>>> getConflicts() async {
    final db = await database;
    final staffId = await AuthService.getStaffId();
    if (staffId == null) return const [];
    return db.query(
      'pending_writes',
      where: "status = 'conflict' AND staff_id = ?",
      whereArgs: [staffId],
      orderBy: 'created_at DESC',
    );
  }

  /// Mark a write as conflicted. The server returned 409/422 indicating
  /// the resource was modified since the offline write was queued.
  static Future<void> markConflict(int id, String reason) async {
    final db = await database;
    await db.update(
      'pending_writes',
      {'status': 'conflict', 'conflict_reason': reason},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Remove a write after successful sync.
  static Future<void> remove(int id) async {
    final db = await database;
    await db.delete('pending_writes', where: 'id = ?', whereArgs: [id]);
  }

  /// Remove not-yet-drained (`status = 'pending'`) writes for [endpoint] whose
  /// decoded body satisfies [matches], scoped to the current staff identity.
  /// Returns the number of rows removed.
  ///
  /// Used to make an offline "discard draft" durable: a draft `PUT` enqueued
  /// while typing offline would otherwise survive in the queue and RECREATE the
  /// draft on reconnect — there is no finalize `POST` to reap it, unlike the
  /// Save/Sign path. Dropping the queued PUT for the discarded context removes
  /// that recreation, so the discard no longer depends on the 14-day TTL
  /// janitor. Only `status = 'pending'` rows are touched (conflicts are left
  /// for the user to resolve), and only rows the current staff owns — a
  /// different user on a shared ward device can never dequeue another's write.
  static Future<int> removePendingMatching({
    required String endpoint,
    required bool Function(Map<String, dynamic> body) matches,
  }) async {
    final db = await database;
    final staffId = await AuthService.getStaffId();
    if (staffId == null) return 0;
    final rows = await db.query(
      'pending_writes',
      columns: ['id', 'body'],
      where: "status = 'pending' AND staff_id = ? AND endpoint = ?",
      whereArgs: [staffId, endpoint],
    );
    var removed = 0;
    for (final row in rows) {
      Map<String, dynamic> body;
      try {
        body = await decodeBody(row['body'] as String);
      } catch (_) {
        // Undecodable row — leave it for the normal drain path rather than
        // guess. Never let one bad row abort the discard.
        continue;
      }
      if (matches(body)) {
        await db.delete(
          'pending_writes',
          where: 'id = ?',
          whereArgs: [row['id']],
        );
        removed++;
      }
    }
    return removed;
  }

  /// Increment retry count.
  static Future<void> incrementRetry(int id) async {
    final db = await database;
    await db.rawUpdate(
      'UPDATE pending_writes SET retry_count = retry_count + 1 WHERE id = ?',
      [id],
    );
  }

  /// Clear all (on logout).
  ///
  /// Runs `VACUUM` after the delete so the freed pages that held (encrypted)
  /// PHI are rewritten and do not linger as recoverable free-list content in
  /// the on-disk database file (audit 2026-06-18 secure-delete requirement).
  static Future<void> clearAll() async {
    final db = await database;
    await db.delete('pending_writes');
    try {
      await db.execute('VACUUM');
    } catch (e) {
      // VACUUM can fail if a transaction is open; the delete already removed
      // the rows, so this is best-effort defence-in-depth, not correctness.
      if (kDebugMode) debugPrint('OfflineQueue.clearAll VACUUM skipped: $e');
    }
  }

  /// Close the cached database + drop the in-memory key handle. Test-only so
  /// each case starts from a clean singleton (the AES key still lives in the
  /// secure-storage fake until that is reset too).
  @visibleForTesting
  static Future<void> resetForTesting() async {
    await _db?.close();
    _db = null;
    _aesKey = null;
  }
}
