import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/services/websocket_service.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/utils/doc_staging.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';

/// Centralized logout that clears ALL local state.
///
/// Call this from any logout trigger (button, session timeout, 401)
/// instead of clearing storage in individual places.
class LogoutService {
  LogoutService._();

  static final _storage = VHSecureStorage.instance;

  /// Full logout: clears credentials, disconnects services, wipes caches.
  static Future<void> logout() async {
    // 1. Disconnect real-time services. Both the legacy WebSocketService AND
    //    the shared RealtimeClient (vhhealth_core) must be torn down — the
    //    RealtimeClient singleton otherwise stays authenticated and keeps
    //    receiving PHI events (queue-position, broadcasts) for the prior user
    //    after logout, a real exposure on shared/family devices.
    try {
      WebSocketService.instance.disconnect();
    } catch (e) {
      debugPrint('LogoutService: WebSocket disconnect failed: $e');
    }
    try {
      await RealtimeClient.instance.disconnect();
    } catch (e) {
      debugPrint('LogoutService: RealtimeClient disconnect failed: $e');
    }

    // 2. Cancel all local notifications
    try {
      await NotificationScheduler.cancelAll();
    } catch (e) {
      debugPrint('LogoutService: notification cancel failed: $e');
    }

    // 3. Clear all secure storage (JWT, phone, device token, etc.)
    try {
      await _storage.deleteAll();
    } catch (e) {
      debugPrint('LogoutService: secure storage clear failed: $e');
    }

    // 4. Clear API cache
    try {
      await ApiCacheManager.clearAll();
    } catch (e) {
      debugPrint('LogoutService: cache clear failed: $e');
    }

    // 5. Clear downloaded-file cache (vhhealth_cache) — this holds
    //    PHI bytes (reports, documents) separate from the API cache above.
    //    Encrypted at rest now, but still wiped so the prior user's documents
    //    don't linger on a shared/family device.
    try {
      await CacheFileUtils.clearCache();
    } catch (e) {
      debugPrint('LogoutService: file cache clear failed: $e');
    }

    // 6. Purge plaintext document staging + the OS temp dir. DocumentOpener
    //    and the cached-file viewer decrypt PHI into a temp staging file so the
    //    system viewer can read it; those plaintext copies must not survive
    //    logout on a shared/family device. Audit §3 (patient).
    try {
      await DocStaging.purge();
    } catch (e) {
      debugPrint('LogoutService: temp/staging purge failed: $e');
    }

    // 7. Clear cycle/period/fertility data — stored as plaintext in
    //    SharedPreferences, must not survive for the next user on a
    //    shared device.
    try {
      await CycleTrackerStore.clearAll();
    } catch (e) {
      debugPrint('LogoutService: cycle data clear failed: $e');
    }

    // 8. Clear in-memory user identity. UserProvider is the single source
    //    of truth; its backing storage keys were wiped in step 3 above.
    UserProvider.instance?.clear();
  }
}
