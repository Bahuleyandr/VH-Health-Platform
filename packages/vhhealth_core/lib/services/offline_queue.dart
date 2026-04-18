import 'dart:convert';
import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';

/// SQLite-based queue for pending API writes when offline.
class OfflineQueue {
  OfflineQueue._();
  static Database? _db;

  static Future<Database> get database async {
    _db ??= await _initDb();
    return _db!;
  }

  static Future<Database> _initDb() async {
    final dbPath = await getDatabasesPath();
    return openDatabase(
      join(dbPath, 'offline_queue.db'),
      version: 2,
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
            conflict_reason TEXT
          )
        ''');
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
              "ALTER TABLE pending_writes ADD COLUMN status TEXT DEFAULT 'pending'");
          await db.execute(
              'ALTER TABLE pending_writes ADD COLUMN conflict_reason TEXT');
        }
      },
    );
  }

  /// Enqueue a write (POST/PUT/PATCH).
  static Future<int> enqueue({
    required String endpoint,
    required String method,
    required Map<String, dynamic> body,
    String? contextLabel,
  }) async {
    final db = await database;
    return db.insert('pending_writes', {
      'endpoint': endpoint,
      'method': method,
      'body': jsonEncode(body),
      'created_at': DateTime.now().millisecondsSinceEpoch,
      'retry_count': 0,
      'context_label': contextLabel,
    });
  }

  /// Get all pending writes (excludes conflicted items).
  static Future<List<Map<String, dynamic>>> getPending() async {
    final db = await database;
    return db.query(
      'pending_writes',
      where: "status = 'pending'",
      orderBy: 'created_at ASC',
    );
  }

  /// Get writes that were rejected as conflicts (server had newer data).
  /// UI can show these to the user for manual resolution.
  static Future<List<Map<String, dynamic>>> getConflicts() async {
    final db = await database;
    return db.query(
      'pending_writes',
      where: "status = 'conflict'",
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

  /// Increment retry count.
  static Future<void> incrementRetry(int id) async {
    final db = await database;
    await db.rawUpdate(
      'UPDATE pending_writes SET retry_count = retry_count + 1 WHERE id = ?',
      [id],
    );
  }

  /// Clear all (on logout).
  static Future<void> clearAll() async {
    final db = await database;
    await db.delete('pending_writes');
  }
}
