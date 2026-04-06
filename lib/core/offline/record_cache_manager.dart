// lib/core/offline/record_cache_manager.dart

import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';

/// Manages offline caching of medical record manifests.
///
/// Data at rest is encrypted using the same AES-256-GCM pattern as
/// [ApiCacheManager] to protect PHI stored on the device.
class RecordCacheManager {
  static Future<void> saveManifest(String phone, List<dynamic> data) async {
    try {
      // Encrypt via ApiCacheManager's shared encryption
      await ApiCacheManager.save('records_manifest_$phone', data);
    } catch (e) {
      debugPrint('RecordCacheManager.saveManifest failed: $e');
    }
  }

  static Future<List<dynamic>?> loadManifest(String phone) async {
    try {
      final cached = await ApiCacheManager.load('records_manifest_$phone');
      if (cached != null && cached.data is List) {
        return cached.data as List<dynamic>;
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
