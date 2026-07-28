import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

import '../models/offline_write_entry.dart';
import '../utils/log_sanitizer.dart';
import 'auth_service.dart';
import 'http_client.dart';
import 'offline_queue.dart';
import 'offline_write_containment.dart';

enum SyncDisposition { success, conflict, retry }

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

class OfflineSessionBarrierActive implements Exception {
  const OfflineSessionBarrierActive();

  @override
  String toString() => 'Offline session barrier is active';
}

/// Owner-scoped offline queue coordinator.
///
/// C0A admits only the two recognized controls, partitions drain failures by
/// tenant/capture-owner/action-family, and retains review evidence across every
/// session transition.
class ConnectivitySyncService extends ChangeNotifier {
  static final ConnectivitySyncService instance = ConnectivitySyncService._();
  ConnectivitySyncService._();

  bool _isOnline = true;
  bool get isOnline => _isOnline;

  bool _isSyncing = false;
  bool get isSyncing => _isSyncing;

  int _pendingCount = 0;
  int get pendingCount => _pendingCount;

  int _conflictCount = 0;
  int get conflictCount => _conflictCount;

  int _needsReviewCount = 0;
  int get needsReviewCount => _needsReviewCount;

  int get unresolvedCount => _pendingCount + _conflictCount + _needsReviewCount;

  StreamSubscription<List<ConnectivityResult>>? _subscription;
  int _sessionBarrierDepth = 0;
  int _activeEnqueues = 0;
  Completer<void>? _quiescent;

  bool get isSessionBarrierActive => _sessionBarrierDepth > 0;

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
      if (_isOnline && wasOffline && !isSessionBarrierActive) {
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

  /// Closes admission synchronously, then waits for an enqueue or drain that
  /// had already crossed the gate to quiesce.
  Future<void> beginSessionBarrier() async {
    _sessionBarrierDepth++;
    if (_activeEnqueues == 0 && !_isSyncing) return;
    _quiescent ??= Completer<void>();
    await _quiescent!.future;
  }

  /// Releases one barrier holder. Extra releases are safe no-ops.
  void endSessionBarrier() {
    if (_sessionBarrierDepth > 0) _sessionBarrierDepth--;
  }

  void _signalQuiescentIfReady() {
    if (_activeEnqueues == 0 && !_isSyncing) {
      final completer = _quiescent;
      _quiescent = null;
      if (completer != null && !completer.isCompleted) completer.complete();
    }
  }

  Future<void> refreshCounts() async {
    final entries = await OfflineQueue.unresolvedEntriesForCurrentOwner();
    final pending = entries
        .where((entry) => entry.status == OfflineWriteStatus.pending)
        .length;
    final conflicts = entries
        .where((entry) => entry.status == OfflineWriteStatus.conflict)
        .length;
    final review = entries
        .where((entry) => entry.status == OfflineWriteStatus.needsReview)
        .length;
    final changed =
        pending != _pendingCount ||
        conflicts != _conflictCount ||
        review != _needsReviewCount;
    _pendingCount = pending;
    _conflictCount = conflicts;
    _needsReviewCount = review;
    if (changed) notifyListeners();
  }

  Future<List<OfflineWriteEntry>> unresolvedEntriesForCurrentOwner() =>
      OfflineQueue.unresolvedEntriesForCurrentOwner();

  Future<int> blockingWriteCountForCurrentOwner() =>
      OfflineQueue.blockingWriteCountForCurrentOwner();

  Future<int> unresolvedWriteCountForCurrentOwner() =>
      OfflineQueue.unresolvedWriteCountForCurrentOwner();

  /// Compatibility facade used by the byte-identical idle-timeout provider.
  /// It now counts all unresolved owner-bound states, not only `pending`.
  Future<int> pendingWriteCountForCurrentOwner() =>
      unresolvedWriteCountForCurrentOwner();

  Future<int> enqueue({
    required String endpoint,
    required String method,
    required Map<String, dynamic> body,
    String? contextLabel,
  }) async {
    if (isSessionBarrierActive) throw const OfflineSessionBarrierActive();
    final classification = OfflineWriteContainment.classify(
      method: method,
      path: endpoint,
    );
    if (!classification.isEnqueueAllowed) {
      throw OfflineWriteRejected(
        classification.reviewReasonCode ??
            OfflineWriteReviewReason.unknownAction.code,
      );
    }
    _activeEnqueues++;
    try {
      if (isSessionBarrierActive) throw const OfflineSessionBarrierActive();
      final id = await OfflineQueue.enqueue(
        endpoint: endpoint,
        method: method,
        body: body,
        contextLabel: contextLabel,
      );
      await refreshCounts();
      return id;
    } finally {
      _activeEnqueues--;
      _signalQuiescentIfReady();
    }
  }

  Future<bool> attestHandoff(int id, {required String actorUid}) async {
    final recorded = await OfflineQueue.attestHandoff(
      id: id,
      actorUid: actorUid,
    );
    if (recorded) await refreshCounts();
    return recorded;
  }

  Future<bool> discardConflict(
    int id, {
    required bool reconciliationConfirmed,
  }) async {
    final discarded = await OfflineQueue.discardConflict(
      id,
      reconciliationConfirmed: reconciliationConfirmed,
    );
    if (discarded) await refreshCounts();
    return discarded;
  }

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

  Future<bool> retryConflict(int id) async {
    if (isSessionBarrierActive) return false;
    final retried = await OfflineQueue.retryConflict(id);
    if (!retried) return false;
    await refreshCounts();
    if (_isOnline && !isSessionBarrierActive) {
      await syncPending();
    }
    return true;
  }

  Future<void> syncPending() async {
    if (_isSyncing || isSessionBarrierActive || !_isOnline) return;
    _isSyncing = true;
    notifyListeners();

    try {
      final ownerAtStart = await AuthService.getStaffId();
      if (ownerAtStart == null || isSessionBarrierActive) return;
      final entries = await OfflineQueue.unresolvedEntriesForCurrentOwner();
      final transientlyBlockedPartitions = <String>{};
      if (kDebugMode && entries.isNotEmpty) {
        debugPrint(
          'ConnectivitySync: inspecting ${entries.length} unresolved writes',
        );
      }

      for (final entry in entries) {
        if (isSessionBarrierActive) break;
        if (await AuthService.getStaffId() != ownerAtStart) break;
        if (entry.status != OfflineWriteStatus.pending ||
            entry.isSkipped ||
            transientlyBlockedPartitions.contains(entry.partitionKey)) {
          continue;
        }
        if (!entry.classification.isControl ||
            entry.encryptionVersion != OfflineQueue.currentEncryptionVersion ||
            entry.tenantId == null ||
            entry.staffId != ownerAtStart ||
            entry.retryCount >= OfflineQueue.maxRetryCount) {
          continue;
        }

        final body = await OfflineQueue.readBodyForReplay(entry);
        if (body == null) {
          transientlyBlockedPartitions.add(entry.partitionKey);
          continue;
        }
        if (isSessionBarrierActive ||
            await AuthService.getStaffId() != ownerAtStart) {
          break;
        }

        try {
          final response = switch (entry.method) {
            'POST' => await VHHttpClient.post(
              entry.endpoint,
              body: body,
              idempotencyKey: entry.idempotencyKey,
            ),
            'PUT' => await VHHttpClient.put(
              entry.endpoint,
              body: body,
              idempotencyKey: entry.idempotencyKey,
            ),
            _ => null,
          };
          if (response == null) {
            transientlyBlockedPartitions.add(entry.partitionKey);
            continue;
          }

          if (response.statusCode == 401 ||
              isSessionBarrierActive ||
              await AuthService.getStaffId() != ownerAtStart) {
            break;
          }
          if (response.isSuccess) {
            await OfflineQueue.removeAfterSuccessfulSync(
              id: entry.id,
              expectedStaffId: ownerAtStart,
              expectedTenantId: entry.tenantId!,
            );
            if (kDebugMode) {
              debugPrint(
                'ConnectivitySync: synced id=${entry.id} '
                '(${logSafePath(entry.endpoint)})',
              );
            }
          } else if (dispositionForStatus(response.statusCode) ==
              SyncDisposition.conflict) {
            await OfflineQueue.markConflict(
              entry.id,
              response.message ?? 'Resource was modified on the server',
            );
            transientlyBlockedPartitions.add(entry.partitionKey);
          } else {
            await OfflineQueue.incrementRetryOrExhaust(entry.id);
            transientlyBlockedPartitions.add(entry.partitionKey);
          }
        } catch (error) {
          if (isSessionBarrierActive ||
              await AuthService.getStaffId() != ownerAtStart) {
            break;
          }
          if (kDebugMode) {
            debugPrint(
              'ConnectivitySync: error id=${entry.id}: '
              '${logSafeError(error)}',
            );
          }
          await OfflineQueue.incrementRetryOrExhaust(entry.id);
          transientlyBlockedPartitions.add(entry.partitionKey);
        }
      }
    } finally {
      _isSyncing = false;
      try {
        await refreshCounts();
        notifyListeners();
      } finally {
        _signalQuiescentIfReady();
      }
    }
  }

  @visibleForTesting
  Future<void> resetForTesting() async {
    stopListening();
    _isOnline = true;
    _isSyncing = false;
    _pendingCount = 0;
    _conflictCount = 0;
    _needsReviewCount = 0;
    _sessionBarrierDepth = 0;
    _activeEnqueues = 0;
    _signalQuiescentIfReady();
  }
}
