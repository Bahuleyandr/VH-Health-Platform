import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/navigation/app_router.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/services/websocket_service.dart';

/// Centralized logout that clears ALL local state.
///
/// Call this from any logout trigger (button, session timeout, 401)
/// instead of clearing storage in individual places.
class LogoutService {
  LogoutService._();

  static const _storage = FlutterSecureStorage();

  /// Full logout: clears credentials, disconnects services, wipes caches.
  static Future<void> logout() async {
    // 1. Disconnect real-time services
    try {
      WebSocketService.instance.disconnect();
    } catch (e) {
      debugPrint('LogoutService: WebSocket disconnect failed: $e');
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

    // 5. Clear AppRouter static user data
    AppRouter.clearUserData();
  }
}
