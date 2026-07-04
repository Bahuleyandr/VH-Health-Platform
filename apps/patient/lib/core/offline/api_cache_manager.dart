// lib/core/offline/api_cache_manager.dart
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:encrypt/encrypt.dart' as encrypt;
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/http_client.dart';

/// Generic JSON response cache for API endpoints.
///
/// Provides a simple cache-first pattern:
/// 1. Return cached data immediately (if available and not expired)
/// 2. Fetch from network in background
/// 3. Update cache + notify caller with fresh data
///
/// Cache keys are derived from the API path, so `/appointments/patient/123`
/// becomes `appointments_patient_123.json`.
///
/// Data at rest is encrypted with AES-256-GCM.
class ApiCacheManager {
  ApiCacheManager._();

  /// Default cache TTL — data older than this is considered stale
  /// (but still served while a network refresh happens).
  static const Duration defaultTtl = Duration(minutes: 15);

  static String? _cacheDir;
  static encrypt.Key? _aesKey;

  /// Retrieve or generate a 256-bit AES key stored in secure storage.
  static Future<encrypt.Key> _getEncryptionKey() async {
    if (_aesKey != null) return _aesKey!;
    final storage = VHSecureStorage.instance;
    var keyBase64 = await storage.read(key: 'cache_aes_key');
    if (keyBase64 == null) {
      final random = Random.secure();
      final keyBytes = Uint8List(32);
      for (var i = 0; i < 32; i++) {
        keyBytes[i] = random.nextInt(256);
      }
      keyBase64 = base64Encode(keyBytes);
      await storage.write(key: 'cache_aes_key', value: keyBase64);
    }
    _aesKey = encrypt.Key.fromBase64(keyBase64);
    return _aesKey!;
  }

  /// Encrypt plaintext using AES-256-GCM with a random 12-byte IV.
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

  /// Encrypt raw bytes (e.g. a downloaded PHI document) for storage at rest,
  /// reusing the SAME per-device AES-256 key as the JSON cache above
  /// (`cache_aes_key` in secure storage). Exposed so file-level callers
  /// (`CacheFileUtils`, `DocumentOpener`) encrypt downloaded clinical
  /// documents instead of writing cleartext PHI to disk — without inventing a
  /// second key scheme.
  ///
  /// On-disk layout is binary: a random 12-byte GCM IV, then the GCM
  /// ciphertext+tag. Keeping it binary (not base64) avoids inflating large
  /// reports/scans by ~33%. Decrypt with [decryptBytes].
  static Future<Uint8List> encryptBytes(List<int> plainBytes) async {
    final key = await _getEncryptionKey();
    final iv = encrypt.IV.fromSecureRandom(12);
    final encrypter = encrypt.Encrypter(
      encrypt.AES(key, mode: encrypt.AESMode.gcm),
    );
    final encrypted = encrypter.encryptBytes(plainBytes, iv: iv);
    final out = Uint8List(iv.bytes.length + encrypted.bytes.length);
    out.setRange(0, iv.bytes.length, iv.bytes);
    out.setRange(iv.bytes.length, out.length, encrypted.bytes);
    return out;
  }

  /// Decrypt bytes produced by [encryptBytes]. Throws if the payload is
  /// truncated or the GCM tag fails to authenticate (tampered / wrong key).
  static Future<Uint8List> decryptBytes(List<int> storedBytes) async {
    if (storedBytes.length <= 12) {
      throw const FormatException('Invalid encrypted file');
    }
    final key = await _getEncryptionKey();
    final bytes = Uint8List.fromList(storedBytes);
    final iv = encrypt.IV(Uint8List.sublistView(bytes, 0, 12));
    final cipher = encrypt.Encrypted(Uint8List.sublistView(bytes, 12));
    final encrypter = encrypt.Encrypter(
      encrypt.AES(key, mode: encrypt.AESMode.gcm),
    );
    return Uint8List.fromList(encrypter.decryptBytes(cipher, iv: iv));
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

  /// Convert an API path like `/appointments/patient/123` to a safe filename,
  /// NAMESPACED by the active acting-as profile (#12b) so a guardian's cache and
  /// a dependent's cache for the same path can never collide — and a dependent's
  /// PHI is never served back under the guardian's profile on a shared device.
  /// A null acting-as uid (guardian on their own profile) keeps the legacy
  /// un-prefixed key, so existing cache files stay valid.
  static String _baseKeyForPath(String path) {
    return path
        .replaceAll('/', '_')
        .replaceAll(RegExp(r'[^a-zA-Z0-9_\-]'), '')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceFirst(RegExp(r'^_'), '');
  }

  static String _keyForPath(String path) {
    final base = _baseKeyForPath(path);
    final actingAs = VHHttpClient.actingAsUidProvider?.call();
    if (actingAs == null || actingAs.isEmpty) return base;
    final safeUid = actingAs.replaceAll(RegExp(r'[^a-zA-Z0-9_\-]'), '');
    return 'as_${safeUid}__$base';
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
      final encrypted = await _encrypt(jsonEncode(envelope));
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
      String decrypted;
      try {
        decrypted = await _decrypt(content);
      } catch (_) {
        // Cache was written with old encryption — discard it
        await file.delete();
        return null;
      }
      final envelope = jsonDecode(decrypted) as Map<String, dynamic>;
      final cachedAt = DateTime.parse(envelope['cachedAt'] as String);
      return CachedData(data: envelope['data'], cachedAt: cachedAt);
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

  /// Delete cached data whose sanitized key starts with [pathPrefix].
  ///
  /// By default this only clears the active acting-as profile namespace. Set
  /// [allProfiles] when a mutation changes profile membership itself, such as
  /// linking or unlinking a dependent.
  static Future<void> invalidateByPrefix(
    String pathPrefix, {
    bool allProfiles = false,
  }) async {
    try {
      final dir = await _getCacheDir();
      final directory = Directory(dir);
      if (!await directory.exists()) return;

      final prefix = allProfiles
          ? _baseKeyForPath(pathPrefix)
          : _keyForPath(pathPrefix);
      await for (final entity in directory.list()) {
        if (entity is! File || !entity.path.endsWith('.json')) continue;
        final fileName = entity.path.split(Platform.pathSeparator).last;
        final key = fileName.substring(0, fileName.length - '.json'.length);
        final candidate = allProfiles ? _stripProfileNamespace(key) : key;
        if (_matchesPrefix(candidate, prefix)) {
          await entity.delete();
        }
      }
    } catch (_) {
      if (kDebugMode) debugPrint('ApiCacheManager.invalidateByPrefix failed');
    }
  }

  static bool _matchesPrefix(String key, String prefix) {
    return key == prefix || key.startsWith('${prefix}_');
  }

  static String _stripProfileNamespace(String key) {
    if (!key.startsWith('as_')) return key;
    final separator = key.indexOf('__');
    if (separator == -1) return key;
    return key.substring(separator + 2);
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
