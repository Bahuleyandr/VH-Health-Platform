// lib/core/offline/record_cache_manager.dart

import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';

/// Manages offline caching of medical record manifests.
///
/// Data at rest is encrypted using the same AES-256-GCM pattern as
/// [ApiCacheManager] to protect PHI stored on the device.
class RecordCacheManager {
  static Future<DateTime?> saveManifest(
    String phone,
    List<dynamic> data,
  ) async {
    try {
      // Encrypt via ApiCacheManager's shared encryption
      return await ApiCacheManager.save('records_manifest_$phone', data);
    } catch (e) {
      debugPrint('RecordCacheManager.saveManifest failed: $e');
      return null;
    }
  }

  static Future<RecordManifestSnapshot?> loadManifest(String phone) async {
    try {
      final cached = await ApiCacheManager.load('records_manifest_$phone');
      if (cached != null && cached.data is List) {
        return RecordManifestSnapshot(
          records: cached.data as List<dynamic>,
          cachedAt: cached.cachedAt,
        );
      }
    } catch (e) {
      debugPrint('RecordCacheManager.loadManifest failed: $e');
    }
    return null;
  }

  static Future<void> clearCache(String phone) async {
    await ApiCacheManager.invalidate('records_manifest_$phone');
  }
}

@immutable
class RecordManifestSnapshot {
  const RecordManifestSnapshot({required this.records, required this.cachedAt});

  final List<dynamic> records;
  final DateTime cachedAt;
}
