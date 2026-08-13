// lib/core/offline/api_cache_manager.dart
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/utils/log_sanitizer.dart';

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
  static int _sessionGeneration = 0;
  static SecretKeyData? _aesKey;
  static Future<SecretKeyData>? _aesKeyInFlight;
  static Future<void>? _teardownInFlight;
  static Future<void> _cacheIo = Future<void>.value();
  static final AesGcm _aesGcm = AesGcm.with256bits();

  /// Retrieve or generate one 256-bit AES key for the current session.
  /// Concurrent first use shares the same initialization future, and logout
  /// waits for that future before deleting the persisted key.
  static Future<SecretKey> _getEncryptionKey() async {
    final teardown = _teardownInFlight;
    if (teardown != null) {
      await teardown;
      throw StateError('Cache teardown was in progress');
    }

    final existingKey = _aesKey;
    if (existingKey != null) return existingKey;
    final existingInit = _aesKeyInFlight;
    if (existingInit != null) return existingInit;

    final generation = _sessionGeneration;
    late final Future<SecretKeyData> tracked;
    tracked = _loadOrCreateEncryptionKey()
        .then((key) {
          if (generation != _sessionGeneration || _teardownInFlight != null) {
            key.destroy();
            throw StateError('Cache session changed during key initialization');
          }
          _aesKey = key;
          return key;
        })
        .whenComplete(() {
          if (identical(_aesKeyInFlight, tracked)) _aesKeyInFlight = null;
        });
    _aesKeyInFlight = tracked;
    return tracked;
  }

  static Future<SecretKeyData> _loadOrCreateEncryptionKey() async {
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
    return SecretKeyData(
      Uint8List.fromList(base64Decode(keyBase64)),
      overwriteWhenDestroyed: true,
      debugLabel: 'patient-cache-session-key',
    );
  }

  /// Encrypt plaintext using AES-256-GCM with a random 12-byte IV.
  /// Returns `iv_base64:ciphertext_base64`.
  static Future<String> _encrypt(String plaintext) async {
    final generation = _sessionGeneration;
    final key = await _getEncryptionKey();
    _requireCurrentGeneration(generation);
    final nonce = _secureRandomBytes(12);
    final box = await _aesGcm.encrypt(
      utf8.encode(plaintext),
      secretKey: key,
      nonce: nonce,
    );
    final combined = Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
    _requireCurrentGeneration(generation);
    return '${base64Encode(nonce)}:${base64Encode(combined)}';
  }

  /// Decrypt a string produced by [_encrypt].
  static Future<String> _decrypt(String ciphertext) async {
    final generation = _sessionGeneration;
    final key = await _getEncryptionKey();
    _requireCurrentGeneration(generation);
    final parts = ciphertext.split(':');
    if (parts.length != 2) {
      throw const FormatException('Invalid encrypted data');
    }
    final nonce = base64Decode(parts[0]);
    final combined = base64Decode(parts[1]);
    if (combined.length < 16) {
      throw const FormatException('Invalid encrypted data');
    }
    final cipherText = combined.sublist(0, combined.length - 16);
    final mac = Mac(combined.sublist(combined.length - 16));
    final plain = await _aesGcm.decrypt(
      SecretBox(cipherText, nonce: nonce, mac: mac),
      secretKey: key,
    );
    _requireCurrentGeneration(generation);
    return utf8.decode(plain);
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
    final generation = _sessionGeneration;
    final key = await _getEncryptionKey();
    _requireCurrentGeneration(generation);
    final nonce = _secureRandomBytes(12);
    final box = await _aesGcm.encrypt(plainBytes, secretKey: key, nonce: nonce);
    final out = Uint8List(nonce.length + box.cipherText.length + 16);
    out.setRange(0, nonce.length, nonce);
    out.setRange(
      nonce.length,
      nonce.length + box.cipherText.length,
      box.cipherText,
    );
    out.setRange(
      nonce.length + box.cipherText.length,
      out.length,
      box.mac.bytes,
    );
    _requireCurrentGeneration(generation);
    return out;
  }

  /// Decrypt bytes produced by [encryptBytes]. Throws if the payload is
  /// truncated or the GCM tag fails to authenticate (tampered / wrong key).
  static Future<Uint8List> decryptBytes(List<int> storedBytes) async {
    if (storedBytes.length <= 12) {
      throw const FormatException('Invalid encrypted file');
    }
    final generation = _sessionGeneration;
    final key = await _getEncryptionKey();
    _requireCurrentGeneration(generation);
    final bytes = Uint8List.fromList(storedBytes);
    if (bytes.length < 28) {
      throw const FormatException('Invalid encrypted file');
    }
    final nonce = Uint8List.sublistView(bytes, 0, 12);
    final cipherText = Uint8List.sublistView(bytes, 12, bytes.length - 16);
    final mac = Mac(Uint8List.sublistView(bytes, bytes.length - 16));
    final plain = await _aesGcm.decrypt(
      SecretBox(cipherText, nonce: nonce, mac: mac),
      secretKey: key,
    );
    _requireCurrentGeneration(generation);
    return Uint8List.fromList(plain);
  }

  static void _requireCurrentGeneration(int generation) {
    if (generation != _sessionGeneration || _teardownInFlight != null) {
      throw StateError('Cache session was retired');
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

  /// Drop only the process-local key, preserving secure storage to model a
  /// cold process restart in tests.
  @visibleForTesting
  static Future<void> debugForgetInMemoryKey() async {
    final initializing = _aesKeyInFlight;
    if (initializing != null) await initializing;
    final key = _aesKey;
    _aesKey = null;
    key?.destroy();
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

  static String _keyForPath(String path, {CacheProfileScope? profile}) {
    final base = _baseKeyForPath(path);
    final actingAs = profile != null
        ? profile.uid
        : VHHttpClient.actingAsUidProvider?.call();
    if (actingAs == null || actingAs.isEmpty) return base;
    final safeUid = actingAs.replaceAll(RegExp(r'[^a-zA-Z0-9_\-]'), '');
    return 'as_${safeUid}__$base';
  }

  /// Save JSON data to cache for a given API path.
  ///
  /// Pass [profile] (captured via [CacheProfileScope.current] when the
  /// request STARTED) for responses saved after an await: without it the
  /// acting-as namespace is resolved at save time, so a profile switch while
  /// the request was in flight would file profile A's PHI under profile B's
  /// namespace and serve it back there.
  static Future<DateTime?> save(
    String path,
    dynamic data, {
    CacheProfileScope? profile,
  }) async {
    try {
      final generation = _sessionGeneration;
      if (profile != null && !profile.isCurrent) return null;
      final dir = await _getCacheDir();
      if (profile != null && !profile.isCurrent) return null;
      final fileKey = _keyForPath(path, profile: profile);
      final file = File('$dir/$fileKey.json');
      final cachedAt = DateTime.now();
      final envelope = {'cachedAt': cachedAt.toIso8601String(), 'data': data};
      final encrypted = await _encrypt(jsonEncode(envelope));
      if (generation != _sessionGeneration ||
          (profile != null && !profile.isCurrent)) {
        return null;
      }
      var wrote = false;
      await _serializeCacheIo(() async {
        if (generation != _sessionGeneration ||
            (profile != null && !profile.isCurrent)) {
          return;
        }
        await file.writeAsString(encrypted);
        wrote = true;
      });
      if (!wrote) return null;
      return cachedAt;
    } catch (e) {
      if (kDebugMode) {
        debugPrint(
          'ApiCacheManager.save failed for ${logSafePath(path)}: ${logSafeError(e)}',
        );
      }
      return null;
    }
  }

  /// Load cached data for a given API path.
  /// Returns null if no cache exists.
  ///
  /// [profile] pins the acting-as namespace to a request-time snapshot —
  /// see [save].
  static Future<CachedData?> load(
    String path, {
    CacheProfileScope? profile,
  }) async {
    try {
      if (profile != null && !profile.isCurrent) return null;
      final dir = await _getCacheDir();
      if (profile != null && !profile.isCurrent) return null;
      final key = _keyForPath(path, profile: profile);
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
      if (kDebugMode) {
        debugPrint(
          'ApiCacheManager.load failed for ${logSafePath(path)}: ${logSafeError(e)}',
        );
      }
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
      if (kDebugMode) {
        debugPrint(
          'ApiCacheManager.invalidate failed for ${logSafePath(path)}: ${logSafeError(e)}',
        );
      }
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
    } catch (e) {
      if (kDebugMode) {
        debugPrint(
          'ApiCacheManager.invalidateByPrefix failed for ${logSafePath(pathPrefix)}: ${logSafeError(e)}',
        );
      }
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
  static Future<void> clearAll() {
    // Invalidate request-time scopes synchronously. A response that started
    // before logout must not recreate PHI cache files after this wipe.
    _sessionGeneration += 1;
    final existing = _teardownInFlight;
    if (existing != null) return existing;

    late final Future<void> tracked;
    tracked = _serializeCacheIo(_clearAllForRetiredSession).whenComplete(() {
      if (identical(_teardownInFlight, tracked)) _teardownInFlight = null;
    });
    _teardownInFlight = tracked;
    return tracked;
  }

  static Future<void> _clearAllForRetiredSession() async {
    final initializing = _aesKeyInFlight;
    if (initializing != null) {
      try {
        await initializing;
      } catch (_) {
        // Its generation was retired; cleanup below is still authoritative.
      }
    }
    final key = _aesKey;
    _aesKey = null;
    key?.destroy();

    try {
      await VHSecureStorage.instance.delete(key: 'cache_aes_key');
    } catch (e) {
      if (kDebugMode) debugPrint('Failed to delete cache encryption key: $e');
    }

    try {
      final dir = await _getCacheDir();
      final directory = Directory(dir);
      if (await directory.exists()) {
        await directory.delete(recursive: true);
        _cacheDir = null; // Force re-creation next time
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('ApiCacheManager.clearAll failed: ${logSafeError(e)}');
      }
    }
  }

  /// Serialize a non-JSON cache write with logout teardown and reject it when
  /// the request-time patient profile/session has been retired.
  static Future<T?> writeForSession<T>(
    CacheProfileScope profile,
    Future<T> Function() operation,
  ) {
    return _serializeCacheIo(() async {
      if (!profile.isCurrent) return null;
      final result = await operation();
      return profile.isCurrent ? result : null;
    });
  }

  static Future<T> _serializeCacheIo<T>(Future<T> Function() operation) {
    final result = _cacheIo.then((_) => operation());
    _cacheIo = result.then<void>((_) {}, onError: (_) {});
    return result;
  }
}

/// Snapshot of the acting-as cache namespace, captured when a request starts.
///
/// [ApiCacheManager] keys are namespaced by the active acting-as profile.
/// Resolving that namespace lazily at save time is a race: a guardian can
/// switch profiles while a fetch is in flight, re-homing the response under
/// the wrong profile's namespace. Capture the scope once at request time and
/// pass it to every load/save belonging to that request.
class CacheProfileScope {
  CacheProfileScope.uid(this.uid)
    : _generation = ApiCacheManager._sessionGeneration;

  /// Resolve the currently-active acting-as uid, now.
  CacheProfileScope.current()
    : uid = VHHttpClient.actingAsUidProvider?.call(),
      _generation = ApiCacheManager._sessionGeneration;

  /// Null means the guardian's own (un-prefixed) namespace.
  final String? uid;
  final int _generation;

  bool get isCurrent => _generation == ApiCacheManager._sessionGeneration;
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
