import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth_core/services/connectivity_service.dart';

/// Queues API mutations when offline and replays them when connectivity returns.
///
/// Usage:
/// ```dart
/// // Instead of: await ApiClient.post('/path', body: data);
/// await MutationQueue.enqueueOrExecute(
///   method: 'POST',
///   path: '/pharmacy-orders/orders/place',
///   body: orderData,
/// );
/// ```
class MutationQueue {
  MutationQueue._();

  static final _storage = VHSecureStorage.instance;
  static const _queueKey = 'mutation_queue';
  static bool _replaying = false;

  /// If online, execute immediately. If offline, queue for later.
  static Future<bool> enqueueOrExecute({
    required String method,
    required String path,
    Map<String, dynamic>? body,
  }) async {
    // One stable key for this logical mutation, reused across the online
    // attempt AND any subsequent enqueue/replay — so a lost-2xx that falls back
    // to the queue (or a queued item replayed more than once) can't double-write.
    final idempotencyKey = IdempotencyKey.generate();
    if (ConnectivityService.isOnline) {
      try {
        final response = await _execute(method, path, body, idempotencyKey);
        return response.isSuccess;
      } catch (_) {
        // Network failed despite appearing online — queue it
        await _enqueue(method, path, body, idempotencyKey);
        return false;
      }
    }
    await _enqueue(method, path, body, idempotencyKey);
    return false;
  }

  /// Queue a mutation for later replay.
  static Future<void> _enqueue(
    String method,
    String path,
    Map<String, dynamic>? body,
    String idempotencyKey,
  ) async {
    final queue = await _loadQueue();
    queue.add({
      'method': method,
      'path': path,
      'body': body,
      'idempotencyKey': idempotencyKey,
      'queuedAt': DateTime.now().toIso8601String(),
    });
    await _saveQueue(queue);
    if (kDebugMode) {
      debugPrint(
        'MutationQueue: queued $method $path (${queue.length} pending)',
      );
    }
  }

  /// Replay all queued mutations. Call when connectivity returns.
  static Future<int> replayQueue() async {
    if (_replaying) return 0;
    _replaying = true;

    try {
      final queue = await _loadQueue();
      if (queue.isEmpty) return 0;

      int replayed = 0;
      final failed = <Map<String, dynamic>>[];

      for (final item in queue) {
        try {
          final response = await _execute(
            item['method'] as String,
            item['path'] as String,
            item['body'] as Map<String, dynamic>?,
            item['idempotencyKey'] as String?,
          );
          if (response.isSuccess) {
            replayed++;
          } else {
            failed.add(item);
          }
        } catch (_) {
          failed.add(item);
        }
      }

      await _saveQueue(failed);
      if (kDebugMode) {
        debugPrint(
          'MutationQueue: replayed $replayed, ${failed.length} still pending',
        );
      }
      return replayed;
    } finally {
      _replaying = false;
    }
  }

  /// Get the number of pending mutations.
  static Future<int> get pendingCount async {
    final queue = await _loadQueue();
    return queue.length;
  }

  static Future<ApiResponse> _execute(
    String method,
    String path,
    Map<String, dynamic>? body,
    String? idempotencyKey,
  ) {
    switch (method.toUpperCase()) {
      case 'POST':
        return ApiClient.post(path, body: body, idempotencyKey: idempotencyKey);
      case 'PUT':
        return ApiClient.put(path, body: body, idempotencyKey: idempotencyKey);
      case 'PATCH':
        return ApiClient.patch(path, body: body, idempotencyKey: idempotencyKey);
      case 'DELETE':
        return ApiClient.delete(path);
      default:
        return ApiClient.post(path, body: body, idempotencyKey: idempotencyKey);
    }
  }

  static Future<List<Map<String, dynamic>>> _loadQueue() async {
    final raw = await _storage.read(key: _queueKey);
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    } catch (_) {
      return [];
    }
  }

  static Future<void> _saveQueue(List<Map<String, dynamic>> queue) async {
    await _storage.write(key: _queueKey, value: jsonEncode(queue));
  }
}
