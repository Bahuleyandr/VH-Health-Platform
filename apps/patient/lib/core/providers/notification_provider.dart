// lib/core/providers/notification_provider.dart

import 'package:flutter/material.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';

typedef NotificationFeedFetcher = Future<dynamic> Function();
typedef NotificationCachedFeedFetcher = Future<dynamic> Function();

Future<dynamic> _loadCachedNotificationFeed() async {
  return (await ApiCacheManager.load('/notifications/my'))?.data;
}

class NotificationProvider extends ChangeNotifier {
  factory NotificationProvider({
    NotificationFeedFetcher? feedFetcher,
    NotificationCachedFeedFetcher? cachedFeedFetcher,
  }) => NotificationProvider._(
    feedFetcher,
    cachedFeedFetcher ?? _loadCachedNotificationFeed,
  );

  NotificationProvider._(this._feedFetcher, this._cachedFeedFetcher);

  final NotificationFeedFetcher? _feedFetcher;
  final NotificationCachedFeedFetcher _cachedFeedFetcher;
  WebSocketProvider? _webSocketSource;
  int _unreadCount = 0;
  int get unreadCount => _unreadCount;

  /// Live-wires realtime `notification` events into the unread badge.
  ///
  /// [mergeFromWebSocket] had zero callers after the #867 realtime
  /// consolidation deleted the old websocket_service wire, so WS-delivered
  /// notifications were buffered forever and the badge only moved on the next
  /// poll. Binding here re-attaches the wire: every [WebSocketProvider]
  /// notification event drains the buffer into [unreadCount] immediately
  /// (which also keeps the buffer from growing for the life of the session).
  /// Called once from `main.dart` where both providers are constructed.
  void bindWebSocket(WebSocketProvider webSocketProvider) {
    if (identical(_webSocketSource, webSocketProvider)) return;
    _webSocketSource?.removeListener(_onWebSocketChanged);
    _webSocketSource = webSocketProvider;
    webSocketProvider.addListener(_onWebSocketChanged);
    // Drain anything that arrived before the wire was attached.
    mergeFromWebSocket(webSocketProvider);
  }

  void _onWebSocketChanged() {
    final source = _webSocketSource;
    if (source != null) mergeFromWebSocket(source);
  }

  @override
  void dispose() {
    _webSocketSource?.removeListener(_onWebSocketChanged);
    _webSocketSource = null;
    super.dispose();
  }

  /// Merge any pending WS-delivered notifications into the unread count.
  void mergeFromWebSocket(WebSocketProvider wsProv) {
    final pending = wsProv.wsNotifications;
    if (pending.isEmpty) return;
    _setUnreadCount(_unreadCount + pending.length);
    wsProv.clearNotifications();
  }

  void _setUnreadCount(int value) {
    final next = value < 0 ? 0 : value;
    if (_unreadCount == next) return;
    _unreadCount = next;
    notifyListeners();
  }

  /// Reconcile the badge from a server or encrypted-cache feed envelope.
  /// The backend's aggregate `unread_count` wins over counting the paginated
  /// first page; list counting remains a compatibility fallback.
  bool reconcileFromFeed(dynamic data) {
    final count = _unreadCountFromFeed(data);
    if (count == null) return false;
    _setUnreadCount(count);
    return true;
  }

  void markOneReadLocally() => _setUnreadCount(_unreadCount - 1);

  /// Fetch unread notifications for the authenticated user.
  ///
  /// The [phone] parameter is kept for API compatibility but is no longer
  /// sent to the backend — the `/my` endpoint derives the user from the JWT.
  Future<void> fetchUnreadCount(String phone) async {
    if (phone.isEmpty || phone == 'guest') {
      _setUnreadCount(0);
      return;
    }

    try {
      if (_feedFetcher != null) {
        if (reconcileFromFeed(await _feedFetcher())) return;
      } else {
        final response = await ApiClient.get(
          '/notifications/my',
          timeout: const Duration(seconds: 10),
        );

        if (response.isSuccess && reconcileFromFeed(response.data)) return;

        debugPrint('❌ Failed to fetch notifications: ${response.statusCode}');
      }
    } catch (e) {
      debugPrint('❌ Error fetching unread notifications: $e');
    }

    try {
      reconcileFromFeed(await _cachedFeedFetcher());
    } catch (e) {
      // Preserve the last known badge when neither server nor encrypted cache
      // can answer. Resetting to zero lies about unread clinical updates.
      debugPrint('❌ Error loading cached unread notifications: $e');
    }
  }

  /// Mark all notifications as read for the authenticated user.
  Future<void> markAllRead(String phone) async {
    if (phone.isEmpty || phone == 'guest') return;

    try {
      final response = await ApiClient.patch(
        '/notifications/my/mark-all-read',
        timeout: const Duration(seconds: 10),
      );

      if (response.isSuccess) {
        _setUnreadCount(0);
      } else {
        debugPrint(
          '❌ Failed to mark notifications as read: ${response.statusCode}',
        );
      }
    } catch (e) {
      debugPrint('❌ Error marking notifications as read: $e');
    }
  }

  /// Convenience alias for `markAllRead`
  void markAllAsRead(String phone) {
    markAllRead(phone);
  }

  Future<void> refreshBadgeAfterPush(String phone) => fetchUnreadCount(phone);

  int? _unreadCountFromFeed(dynamic data) {
    if (data is Map) {
      final aggregate = data['unread_count'];
      final parsed = aggregate is num
          ? aggregate.toInt()
          : int.tryParse(aggregate?.toString() ?? '');
      if (parsed != null && parsed >= 0) return parsed;
      if (data['notifications'] is List) {
        return _normalizeNotifications(data).where(_isUnread).length;
      }
      if (data['data'] != null) return _unreadCountFromFeed(data['data']);
      return null;
    }
    if (data is List) {
      return _normalizeNotifications(data).where(_isUnread).length;
    }
    return null;
  }

  bool _isUnread(Map<String, dynamic> notification) {
    if (notification.containsKey('is_read')) {
      return notification['is_read'] == false;
    }
    return notification['read'] == false;
  }

  List<Map<String, dynamic>> _normalizeNotifications(dynamic data) {
    final List<dynamic> notifications;
    if (data is List) {
      notifications = data;
    } else if (data is Map) {
      notifications = (data['notifications'] as List?) ?? [];
    } else {
      notifications = [];
    }
    return notifications
        .whereType<Map>()
        .map(
          (item) => item.map((key, value) => MapEntry(key.toString(), value)),
        )
        .toList();
  }
}
