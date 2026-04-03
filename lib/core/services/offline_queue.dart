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
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
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

  /// Get all pending writes ordered by created_at.
  static Future<List<Map<String, dynamic>>> getPending() async {
    final db = await database;
    return db.query('pending_writes', orderBy: 'created_at ASC');
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
