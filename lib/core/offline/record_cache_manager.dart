// lib/core/offline/record_cache_manager.dart

import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

class RecordCacheManager {
  static Future<String> _getCacheDirPath() async {
    final dir = await getApplicationDocumentsDirectory();
    final cacheDir = Directory('${dir.path}/vhhealth/records');
    if (!await cacheDir.exists()) {
      await cacheDir.create(recursive: true);
    }
    return cacheDir.path;
  }

  static Future<void> saveManifest(String phone, List<dynamic> data) async {
    final cachePath = await _getCacheDirPath();
    final manifestFile = File('$cachePath/${phone}_manifest.json');
    await manifestFile.writeAsString(jsonEncode(data));
  }

  static Future<List<dynamic>?> loadManifest(String phone) async {
    try {
      final cachePath = await _getCacheDirPath();
      final manifestFile = File('$cachePath/${phone}_manifest.json');
      if (await manifestFile.exists()) {
        final content = await manifestFile.readAsString();
        return jsonDecode(content);
      }
    } catch (e) {
      debugPrint('Load manifest failed: $e');
    }
    return null;
  }

  static Future<void> clearCache(String phone) async {
    final cachePath = await _getCacheDirPath();
    final manifestFile = File('$cachePath/${phone}_manifest.json');
    if (await manifestFile.exists()) {
      await manifestFile.delete();
    }
  }
}
