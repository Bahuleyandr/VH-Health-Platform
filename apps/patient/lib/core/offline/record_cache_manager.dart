import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth_core/config/tenant_config.dart';

/// Manages encrypted offline medical-record manifests.
///
/// A manifest is isolated by tenant build, effective patient profile, acting-as
/// scope, and server filter. An empty patient UID fails closed rather than
/// falling back to a phone-only cache shared across sessions.
class RecordCacheManager {
  static Future<DateTime?> saveManifest({
    required String patientUid,
    required String filter,
    required List<dynamic> data,
    CacheProfileScope? profile,
  }) async {
    final path = cachePath(patientUid: patientUid, filter: filter);
    if (path == null) return null;
    try {
      return await ApiCacheManager.save(path, data, profile: profile);
    } catch (e) {
      debugPrint('RecordCacheManager.saveManifest failed: $e');
      return null;
    }
  }

  static Future<RecordManifestSnapshot?> loadManifest({
    required String patientUid,
    required String filter,
    CacheProfileScope? profile,
  }) async {
    final path = cachePath(patientUid: patientUid, filter: filter);
    if (path == null) return null;
    try {
      final cached = await ApiCacheManager.load(path, profile: profile);
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

  static Future<void> clearCache({
    required String patientUid,
    required String filter,
  }) async {
    final path = cachePath(patientUid: patientUid, filter: filter);
    if (path != null) await ApiCacheManager.invalidate(path);
  }

  @visibleForTesting
  static String? cachePath({
    required String patientUid,
    required String filter,
    String? tenantNamespace,
  }) {
    final uid = patientUid.trim();
    if (uid.isEmpty) return null;
    final normalizedFilter = filter.trim().toLowerCase();
    final safeFilter = normalizedFilter.isEmpty || normalizedFilter == 'all'
        ? 'all'
        : normalizedFilter;
    return 'records_manifest_v2_${tenantNamespace ?? TenantConfig.cacheNamespace}_${uid}_$safeFilter';
  }
}

@immutable
class RecordManifestSnapshot {
  const RecordManifestSnapshot({required this.records, required this.cachedAt});

  final List<dynamic> records;
  final DateTime cachedAt;
}
