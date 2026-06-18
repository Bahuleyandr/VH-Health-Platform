// lib/core/utils/cache_file_utils.dart

import 'dart:io';
import 'package:path_provider/path_provider.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:flutter/foundation.dart'; // needed for debugPrint
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/utils/doc_staging.dart';
import 'package:vhhealth/core/utils/safe_filename.dart';

/// On-disk cache for downloaded PHI documents (lab reports, prescriptions,
/// scans).
///
/// Files are stored ENCRYPTED at rest with AES-256-GCM, reusing the same
/// per-device random key as [ApiCacheManager] (`cache_aes_key` in secure
/// storage). Nothing in `vhhealth_cache` is plaintext PHI. The system viewer
/// can't read ciphertext, so [openCachedFile] decrypts into a short-lived
/// plaintext staging file (under [DocStaging.dirName]) which logout purges.
class CacheFileUtils {
  static Future<String> _getCacheDirPath() async {
    final dir = await getApplicationDocumentsDirectory();
    final cacheDir = Directory('${dir.path}/vhhealth_cache');
    if (!await cacheDir.exists()) {
      await cacheDir.create(recursive: true);
    }
    return cacheDir.path;
  }

  static Future<File> _getLocalFile(String fileKey) async {
    final path = await _getCacheDirPath();
    // fileKey is often a server-supplied file_key / storage key — sanitise it
    // to a single safe segment so a `../`-laden key can't write raw PHI bytes
    // outside vhhealth_cache or redirect a later read. All four public methods
    // funnel through here, so read/write paths stay consistent. Audit #6.
    return File('$path/${safeFileName(fileKey)}');
  }

  static Future<bool> isFileCached(String fileKey) async {
    final file = await _getLocalFile(fileKey);
    return file.exists();
  }

  static Future<File?> downloadAndCacheFile(String fileKey, String url) async {
    try {
      final file = await _getLocalFile(fileKey);
      // Backend PHI URLs go through the SPKI-pinned client (auth + 401-refresh);
      // off-host URLs (e.g. pre-signed R2) keep a plain GET since pinning to the
      // API host would be wrong for them.
      final http.Response response;
      if (url.startsWith(ApiConfig.baseUrl)) {
        final rest = url.substring(ApiConfig.baseUrl.length);
        final qIndex = rest.indexOf('?');
        final path = qIndex == -1 ? rest : rest.substring(0, qIndex);
        final query = qIndex == -1
            ? null
            : Uri.splitQueryString(rest.substring(qIndex + 1));
        response = await VHHttpClient.getBytes(path, queryParameters: query);
      } else {
        response = await http.get(Uri.parse(url));
      }
      if (response.statusCode == 200) {
        // Encrypt PHI bytes before they touch disk, then persist. Only persist
        // on success — never leave a partial file in the cache.
        final encrypted = await ApiCacheManager.encryptBytes(
          response.bodyBytes,
        );
        await file.writeAsBytes(encrypted, flush: true);
        return file;
      }
    } catch (e) {
      debugPrint('Download and cache file failed: $e');
    }
    return null;
  }

  /// Save raw bytes directly to the cache directory, encrypted at rest.
  static Future<File?> saveBytesToCache(
    String fileName,
    List<int> bytes,
  ) async {
    try {
      final file = await _getLocalFile(fileName);
      final encrypted = await ApiCacheManager.encryptBytes(bytes);
      await file.writeAsBytes(encrypted, flush: true);
      return file;
    } catch (e) {
      debugPrint('Save bytes to cache failed: $e');
      return null;
    }
  }

  static Future<File?> getCachedFile(String fileKey) async {
    final file = await _getLocalFile(fileKey);
    return await file.exists() ? file : null;
  }

  /// Decrypt the cached PHI bytes for [fileKey], or null if not cached / the
  /// payload can't be authenticated (truncated, tampered, or wrong key after a
  /// key rotation). Callers that need the raw document bytes (in-app viewers)
  /// use this instead of reading the on-disk file directly, which is ciphertext.
  static Future<Uint8List?> readDecryptedBytes(String fileKey) async {
    try {
      final file = await _getLocalFile(fileKey);
      if (!await file.exists()) return null;
      return await ApiCacheManager.decryptBytes(await file.readAsBytes());
    } catch (e) {
      debugPrint('Read cached file failed: $e');
      return null;
    }
  }

  /// Open a cached document with the system viewer.
  ///
  /// [cachePath] is the path returned by [downloadAndCacheFile] /
  /// [saveBytesToCache] (an ENCRYPTED file). The OS viewer needs plaintext, so
  /// the bytes are decrypted into a short-lived staging file that logout purges
  /// ([DocStaging]). The staging name keeps the original extension so the
  /// viewer recognises the type.
  static Future<void> openCachedFile(String cachePath) async {
    try {
      final encrypted = File(cachePath);
      if (!await encrypted.exists()) return;
      final plainBytes = await ApiCacheManager.decryptBytes(
        await encrypted.readAsBytes(),
      );
      final staged = await DocStaging.writePlaintext(
        safeFileName(cachePath.split(Platform.pathSeparator).last),
        plainBytes,
      );
      await OpenFilex.open(staged.path);
    } catch (e) {
      debugPrint('Error opening file: $e');
    }
  }

  static Future<void> clearCache() async {
    final dirPath = await _getCacheDirPath();
    final dir = Directory(dirPath);
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  }
}
