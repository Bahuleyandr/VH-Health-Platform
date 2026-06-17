// lib/core/utils/cache_file_utils.dart

import 'dart:io';
import 'package:path_provider/path_provider.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:flutter/foundation.dart'; // needed for debugPrint
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/http_client.dart';

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
    return File('$path/$fileKey');
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
        // Only persist on success — never leave a partial file in the cache.
        await file.writeAsBytes(response.bodyBytes);
        return file;
      }
    } catch (e) {
      debugPrint('Download and cache file failed: $e');
    }
    return null;
  }

  /// Save raw bytes directly to the cache directory.
  static Future<File?> saveBytesToCache(
    String fileName,
    List<int> bytes,
  ) async {
    try {
      final file = await _getLocalFile(fileName);
      await file.writeAsBytes(bytes);
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

  static Future<void> openCachedFile(String filePath) async {
    try {
      await OpenFilex.open(filePath);
    } catch (e) {
      debugPrint('Error opening file: $e'); // ✅ replaced print with debugPrint
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
