import 'dart:async';
import 'dart:convert';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'offline_queue.dart';
import 'api_client.dart';

/// Monitors connectivity and auto-syncs pending offline writes when back online.
class ConnectivitySyncService {
  static final ConnectivitySyncService instance = ConnectivitySyncService._();
  ConnectivitySyncService._();

  bool _isOnline = true;
  bool get isOnline => _isOnline;

  bool _isSyncing = false;
  StreamSubscription<List<ConnectivityResult>>? _subscription;

  /// Listen to connectivity changes, trigger sync when back online.
  void startListening() {
    _subscription = Connectivity().onConnectivityChanged.listen((results) {
      final wasOffline = !_isOnline;
      _isOnline = results.any((r) => r != ConnectivityResult.none);

      if (kDebugMode) {
        debugPrint('ConnectivitySync: online=$_isOnline results=$results');
      }

      if (_isOnline && wasOffline) {
        syncPending();
      }
    });

    // Check initial state
    Connectivity().checkConnectivity().then((results) {
      _isOnline = results.any((r) => r != ConnectivityResult.none);
    });
  }

  /// Attempt to sync all pending writes.
  Future<void> syncPending() async {
    if (_isSyncing) return;
    _isSyncing = true;

    try {
      final pending = await OfflineQueue.getPending();
      if (pending.isEmpty) return;

      if (kDebugMode) {
        debugPrint('ConnectivitySync: syncing ${pending.length} pending writes');
      }

      for (final write in pending) {
        final id = write['id'] as int;
        final endpoint = write['endpoint'] as String;
        final method = (write['method'] as String).toUpperCase();
        final body =
            jsonDecode(write['body'] as String) as Map<String, dynamic>;
        final retryCount = write['retry_count'] as int? ?? 0;

        if (retryCount > 5) {
          if (kDebugMode) {
            debugPrint('ConnectivitySync: skipping id=$id (max retries)');
          }
          continue;
        }

        try {
          switch (method) {
            case 'POST':
              await ApiClient.post(endpoint, body: body);
              break;
            case 'PUT':
              await ApiClient.put(endpoint, body: body);
              break;
            case 'PATCH':
              await ApiClient.patch(endpoint, body: body);
              break;
            default:
              if (kDebugMode) {
                debugPrint('ConnectivitySync: unknown method $method for id=$id');
              }
              continue;
          }
          await OfflineQueue.remove(id);
          if (kDebugMode) {
            debugPrint('ConnectivitySync: synced id=$id ($endpoint)');
          }
        } catch (e) {
          if (kDebugMode) {
            debugPrint('ConnectivitySync: failed id=$id: $e');
          }
          await OfflineQueue.incrementRetry(id);
        }
      }
    } finally {
      _isSyncing = false;
    }
  }

  void stopListening() {
    _subscription?.cancel();
    _subscription = null;
  }
}
