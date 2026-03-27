// lib/core/offline/api_cache_manager.dart
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

/// Generic JSON response cache for API endpoints.
///
/// Provides a simple cache-first pattern:
/// 1. Return cached data immediately (if available and not expired)
/// 2. Fetch from network in background
/// 3. Update cache + notify caller with fresh data
///
/// Cache keys are derived from the API path, so `/appointments/patient/123`
/// becomes `appointments_patient_123.json`.
class ApiCacheManager {
  ApiCacheManager._();

  /// Default cache TTL — data older than this is considered stale
  /// (but still served while a network refresh happens).
  static const Duration defaultTtl = Duration(minutes: 15);

  static String? _cacheDir;
  static String? _encryptionKey;

  /// Retrieve or generate a cache encryption key stored in secure storage.
  static Future<String> _getEncryptionKey() async {
    if (_encryptionKey != null) return _encryptionKey!;
    const storage = FlutterSecureStorage();
    var key = await storage.read(key: 'cache_encryption_key');
    if (key == null) {
      final random = Random.secure();
      key = List.generate(
        32,
        (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      await storage.write(key: 'cache_encryption_key', value: key);
    }
    _encryptionKey = key;
    return key;
  }

  /// XOR-encrypt a plaintext string using the given key, returning base64.
  static String _xorEncrypt(String input, String key) {
    final keyBytes = key.codeUnits;
    final inputBytes = utf8.encode(input);
    final output = List<int>.generate(
      inputBytes.length,
      (i) => inputBytes[i] ^ keyBytes[i % keyBytes.length],
    );
    return base64Encode(output);
  }

  /// XOR-decrypt a base64 string using the given key, returning plaintext.
  static String _xorDecrypt(String input, String key) {
    final keyBytes = key.codeUnits;
    final inputBytes = base64Decode(input);
    final output = List<int>.generate(
      inputBytes.length,
      (i) => inputBytes[i] ^ keyBytes[i % keyBytes.length],
    );
    return utf8.decode(output);
  }

  static Future<String> _getCacheDir() async {
    if (_cacheDir != null) return _cacheDir!;
    final dir = await getApplicationDocumentsDirectory();
    final cacheDir = Directory('${dir.path}/vhhealth/api_cache');
    if (!await cacheDir.exists()) {
      await cacheDir.create(recursive: true);
    }
    _cacheDir = cacheDir.path;
    return _cacheDir!;
  }

  /// Convert an API path like `/appointments/patient/123` to a safe filename.
  static String _keyForPath(String path) {
    return path
        .replaceAll('/', '_')
        .replaceAll(RegExp(r'[^a-zA-Z0-9_\-]'), '')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceFirst(RegExp(r'^_'), '');
  }

  /// Save JSON data to cache for a given API path.
  static Future<void> save(String path, dynamic data) async {
    try {
      final dir = await _getCacheDir();
      final fileKey = _keyForPath(path);
      final file = File('$dir/$fileKey.json');
      final envelope = {
        'cachedAt': DateTime.now().toIso8601String(),
        'data': data,
      };
      final encryptionKey = await _getEncryptionKey();
      final encrypted = _xorEncrypt(jsonEncode(envelope), encryptionKey);
      await file.writeAsString(encrypted);
    } catch (e) {
      if (kDebugMode) debugPrint('ApiCacheManager.save failed for $path: $e');
    }
  }

  /// Load cached data for a given API path.
  /// Returns null if no cache exists.
  static Future<CachedData?> load(String path) async {
    try {
      final dir = await _getCacheDir();
      final key = _keyForPath(path);
      final file = File('$dir/$key.json');
      if (!await file.exists()) return null;

      final content = await file.readAsString();
      final encryptionKey = await _getEncryptionKey();
      final decrypted = _xorDecrypt(content, encryptionKey);
      final envelope = jsonDecode(decrypted) as Map<String, dynamic>;
      final cachedAt = DateTime.parse(envelope['cachedAt'] as String);
      return CachedData(
        data: envelope['data'],
        cachedAt: cachedAt,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('ApiCacheManager.load failed for $path: $e');
      return null;
    }
  }

  /// Delete cached data for a specific path.
  static Future<void> invalidate(String path) async {
    try {
      final dir = await _getCacheDir();
      final key = _keyForPath(path);
      final file = File('$dir/$key.json');
      if (await file.exists()) await file.delete();
    } catch (e) {
      if (kDebugMode) debugPrint('ApiCacheManager.invalidate failed: $e');
    }
  }

  /// Clear all cached API data.
  static Future<void> clearAll() async {
    try {
      final dir = await _getCacheDir();
      final directory = Directory(dir);
      if (await directory.exists()) {
        await directory.delete(recursive: true);
        _cacheDir = null; // Force re-creation next time
      }
    } catch (e) {
      if (kDebugMode) debugPrint('ApiCacheManager.clearAll failed: $e');
    }
  }
}

/// Cached data with timestamp.
class CachedData {
  final dynamic data;
  final DateTime cachedAt;

  const CachedData({required this.data, required this.cachedAt});

  /// How old this cached data is.
  Duration get age => DateTime.now().difference(cachedAt);

  /// Whether this data is older than the given TTL.
  bool isStale([Duration ttl = ApiCacheManager.defaultTtl]) => age > ttl;

  /// Human-readable age label (e.g., "5 min ago", "2 hours ago").
  String get ageLabel {
    final mins = age.inMinutes;
    if (mins < 1) return 'just now';
    if (mins < 60) return '$mins min ago';
    final hours = age.inHours;
    if (hours < 24) return '$hours ${hours == 1 ? 'hour' : 'hours'} ago';
    return '${age.inDays} ${age.inDays == 1 ? 'day' : 'days'} ago';
  }
}
