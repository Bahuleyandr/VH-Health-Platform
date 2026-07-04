import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

import '../utils/log_sanitizer.dart';
import 'http_client.dart';
import 'offline_queue.dart';

/// How a drained offline write's HTTP status maps to a queue disposition.
enum SyncDisposition { success, conflict, retry }

/// Classify a drain response. A *definitive* client rejection that a blind retry
/// can never fix becomes a conflict the user must resolve; anything transient
/// (auth refresh, timeout, rate-limit, server error) is retried.
///
/// Conflict set: 400 (e.g. CDS_BLOCKER), 403 (device-posture clinical-write
/// gate), 409 (in-flight / state conflict), 422 (idempotency body mismatch /
/// validation). 401 stays transient — VHHttpClient refresh-retries it and a
/// persistent auth failure is a re-login problem, not a clinical conflict.
SyncDisposition dispositionForStatus(int statusCode) {
  if (statusCode >= 200 && statusCode < 300) return SyncDisposition.success;
  if (statusCode == 400 ||
      statusCode == 403 ||
      statusCode == 409 ||
      statusCode == 422) {
    return SyncDisposition.conflict;
  }
  return SyncDisposition.retry;
}

/// Monitors connectivity, auto-syncs pending offline writes when back online,
/// and exposes observable state (isOnline / isSyncing / counts) to the UI.
///
/// Lives in `vhhealth_core` so both patient and staff apps share the same
/// offline-write model, conflict UX, and sync-badge widget.
///
/// UI code listens via `context.watch<ConnectivitySyncService>()` *or* wraps
/// an `AnimatedBuilder(animation: ConnectivitySyncService.instance, ...)`.
class ConnectivitySyncService extends ChangeNotifier {
  static final ConnectivitySyncService instance = ConnectivitySyncService._();
  ConnectivitySyncService._();

  // ── Observable state ──────────────────────────────────────────────────
  bool _isOnline = true;
  bool get isOnline => _isOnline;

  bool _isSyncing = false;
  bool get isSyncing => _isSyncing;

  int _pendingCount = 0;
  int get pendingCount => _pendingCount;

  int _conflictCount = 0;
  int get conflictCount => _conflictCount;

  // ── Internals ─────────────────────────────────────────────────────────
  StreamSubscription<List<ConnectivityResult>>? _subscription;

  /// Listen to connectivity changes; trigger sync when back online.
  void startListening() {
    _subscription ??= Connectivity().onConnectivityChanged.listen((results) {
      final wasOffline = !_isOnline;
      final newOnline = results.any((r) => r != ConnectivityResult.none);

      if (kDebugMode) {
        debugPrint('ConnectivitySync: online=$newOnline results=$results');
      }

      if (newOnline != _isOnline) {
        _isOnline = newOnline;
        notifyListeners();
      }

      if (_isOnline && wasOffline) {
        syncPending();
      }
    });

    Connectivity().checkConnectivity().then((results) {
      final newOnline = results.any((r) => r != ConnectivityResult.none);
      if (newOnline != _isOnline) {
        _isOnline = newOnline;
        notifyListeners();
      }
    });
    refreshCounts();
  }

  void stopListening() {
    _subscription?.cancel();
    _subscription = null;
  }

  /// Re-read pending + conflict counts from the queue and notify listeners
  /// if anything changed. Cheap — call after any queue mutation, or on a
  /// pull-to-refresh.
  Future<void> refreshCounts() async {
    final pending = await OfflineQueue.getPending();
    final conflicts = await OfflineQueue.getConflicts();
    final changed =
        pending.length != _pendingCount || conflicts.length != _conflictCount;
    _pendingCount = pending.length;
    _conflictCount = conflicts.length;
    if (changed) notifyListeners();
  }

  /// Queue a write and update counts. Prefer this over calling
  /// [OfflineQueue.enqueue] directly so the badge stays accurate.
  Future<int> enqueue({
    required String endpoint,
    required String method,
    required Map<String, dynamic> body,
    String? contextLabel,
  }) async {
    final id = await OfflineQueue.enqueue(
      endpoint: endpoint,
      method: method,
      body: body,
      contextLabel: contextLabel,
    );
    await refreshCounts();
    return id;
  }

  /// User discarded a conflicted write — remove it from the queue.
  Future<void> discardConflict(int id) async {
    await OfflineQueue.remove(id);
    await refreshCounts();
  }

  /// Remove queued (not-yet-synced) writes for [endpoint] whose decoded body
  /// satisfies [matches], then refresh counts so the badge stays accurate.
  /// Returns the number removed.
  ///
  /// Used by an offline draft-discard: dropping the queued draft `PUT` for the
  /// discarded context stops it recreating the draft on reconnect. Prefer this
  /// over [OfflineQueue.removePendingMatching] directly so the sync badge/counts
  /// stay consistent.
  Future<int> removePendingWrites({
    required String endpoint,
    required bool Function(Map<String, dynamic> body) matches,
  }) async {
    final removed = await OfflineQueue.removePendingMatching(
      endpoint: endpoint,
      matches: matches,
    );
    if (removed > 0) await refreshCounts();
    return removed;
  }

  /// Clear the entire offline write queue and reset observable state.
  ///
  /// Call on logout so the next user on a shared device cannot drain the
  /// previous user's queued clinical writes (vitals, nursing notes). Prefer
  /// this over [OfflineQueue.clearAll] directly so the sync badge/counts
  /// stay consistent.
  Future<void> clearQueue() async {
    await OfflineQueue.clearAll();
    await refreshCounts();
  }

  /// User asked to retry a conflicted write — flip it back to pending and
  /// trigger a sync pass if online.
  Future<void> retryConflict(int id) async {
    final db = await OfflineQueue.database;
    await db.update(
      'pending_writes',
      {'status': 'pending', 'conflict_reason': null, 'retry_count': 0},
      where: 'id = ?',
      whereArgs: [id],
    );
    await refreshCounts();
    if (_isOnline) {
      syncPending();
    }
  }

  /// Attempt to sync all pending writes via [VHHttpClient].
  Future<void> syncPending() async {
    if (_isSyncing) return;
    _isSyncing = true;
    notifyListeners();

    try {
      final pending = await OfflineQueue.getPending();
      if (pending.isEmpty) {
        await refreshCounts();
        return;
      }

      if (kDebugMode) {
        debugPrint(
          'ConnectivitySync: syncing ${pending.length} pending writes',
        );
      }

      for (final write in pending) {
        final id = write['id'] as int;
        final endpoint = write['endpoint'] as String;
        final method = (write['method'] as String).toUpperCase();
        // `body` is stored AES-256-GCM-encrypted at rest (audit 2026-06-18);
        // decodeBody() decrypts it (and transparently reads legacy plaintext
        // rows queued before the v4 migration).
        final body = await OfflineQueue.decodeBody(write['body'] as String);
        final retryCount = write['retry_count'] as int? ?? 0;
        // Stable per-write key persisted at enqueue time. Reusing it on every
        // redrain lets the backend de-duplicate a lost-2xx replay rather than
        // create a duplicate order / vital / note (finding #15). Older rows
        // queued before the v3 schema migration have a null key — they fall
        // back to no header (best-effort, pre-existing behaviour).
        final idempotencyKey = write['idempotency_key'] as String?;

        if (retryCount > 5) {
          if (kDebugMode) {
            debugPrint('ConnectivitySync: skipping id=$id (max retries)');
          }
          continue;
        }

        try {
          final resp = switch (method) {
            'POST' => await VHHttpClient.post(
              endpoint,
              body: body,
              idempotencyKey: idempotencyKey,
            ),
            'PUT' => await VHHttpClient.put(
              endpoint,
              body: body,
              idempotencyKey: idempotencyKey,
            ),
            'PATCH' => await VHHttpClient.patch(
              endpoint,
              body: body,
              idempotencyKey: idempotencyKey,
            ),
            _ => null,
          };

          if (resp == null) {
            if (kDebugMode) {
              debugPrint('ConnectivitySync: unknown method $method for id=$id');
            }
            continue;
          }

          if (resp.isSuccess) {
            await OfflineQueue.remove(id);
            if (kDebugMode) {
              debugPrint(
                'ConnectivitySync: synced id=$id (${logSafePath(endpoint)})',
              );
            }
          } else if (dispositionForStatus(resp.statusCode) ==
              SyncDisposition.conflict) {
            final reason =
                resp.message ?? 'Resource was modified on the server';
            await OfflineQueue.markConflict(id, reason);
            if (kDebugMode) {
              debugPrint(
                'ConnectivitySync: CONFLICT id=$id (${logSafePath(endpoint)})',
              );
            }
          } else {
            await OfflineQueue.incrementRetry(id);
            if (kDebugMode) {
              debugPrint(
                'ConnectivitySync: failed id=$id (${resp.statusCode})',
              );
            }
          }
        } catch (e) {
          if (kDebugMode) {
            debugPrint('ConnectivitySync: error id=$id: ${logSafeError(e)}');
          }
          await OfflineQueue.incrementRetry(id);
        }
      }
    } finally {
      _isSyncing = false;
      await refreshCounts();
      notifyListeners();
    }
  }
}
