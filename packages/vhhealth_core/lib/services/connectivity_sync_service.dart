import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

import '../models/client_readiness.dart';
import '../models/offline_command_envelope.dart';
import '../models/offline_write_entry.dart';
import '../utils/log_sanitizer.dart';
import 'auth_service.dart';
import 'client_readiness_service.dart';
import 'http_client.dart';
import 'offline_queue.dart';
import 'offline_action_ids.dart';
import 'offline_write_containment.dart';

enum SyncDisposition { success, conflict, retry }

enum PreparedDrainGateDisposition { allow, pause, needsReview }

@immutable
class PreparedDrainGateDecision {
  const PreparedDrainGateDecision._({
    required this.disposition,
    required this.reasonCode,
  });

  const PreparedDrainGateDecision.allow()
    : this._(
        disposition: PreparedDrainGateDisposition.allow,
        reasonCode: 'allowed',
      );

  const PreparedDrainGateDecision.pause(String reasonCode)
    : this._(
        disposition: PreparedDrainGateDisposition.pause,
        reasonCode: reasonCode,
      );

  const PreparedDrainGateDecision.needsReview(String reasonCode)
    : this._(
        disposition: PreparedDrainGateDisposition.needsReview,
        reasonCode: reasonCode,
      );

  final PreparedDrainGateDisposition disposition;
  final String reasonCode;
}

typedef PreparedDrainGate =
    Future<PreparedDrainGateDecision> Function(OfflineCommandEnvelope envelope);

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

SyncDisposition preparedDispositionForStatus(int statusCode) {
  if (statusCode >= 200 && statusCode < 300) return SyncDisposition.success;
  if (const {400, 403, 404, 409, 410, 412, 422}.contains(statusCode)) {
    return SyncDisposition.conflict;
  }
  return SyncDisposition.retry;
}

bool _isTypedPreparedSuccess(PreparedMutationResponse result) {
  final raw = result.response.raw;
  return result.response.isSuccess &&
      raw is Map<String, dynamic> &&
      raw.containsKey('data');
}

String _preparedReviewReason(int statusCode) {
  return switch (statusCode) {
    400 || 422 => 'server_validation_rejected',
    403 => 'server_authorization_rejected',
    404 => 'server_target_not_found',
    409 || 412 => 'server_concurrency_conflict',
    410 => 'server_target_gone',
    _ => 'server_reconciliation_required',
  };
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

  ClientTransportState _transportState = ClientTransportState.unknown;
  ClientTransportState get transportState => _transportState;

  ContinuityLifecycleState _continuityLifecycleState =
      ContinuityLifecycleState.notReady;
  ContinuityLifecycleState get continuityLifecycleState =>
      _continuityLifecycleState;

  ClientReadinessRouteKind? _readinessRouteKind;
  ClientReadinessRouteKind? get readinessRouteKind => _readinessRouteKind;

  bool _isSyncing = false;
  bool get isSyncing => _isSyncing;

  bool _isEvaluatingReadiness = false;
  bool get isEvaluatingReadiness => _isEvaluatingReadiness;

  bool _hasAuthenticatedSession = false;
  bool get canAttemptSync =>
      _transportState == ClientTransportState.available &&
      _hasAuthenticatedSession &&
      !_isSyncing &&
      !_isEvaluatingReadiness;

  int _pendingCount = 0;
  int get pendingCount => _pendingCount;

  int _conflictCount = 0;
  int get conflictCount => _conflictCount;

  int _needsReviewCount = 0;
  int get needsReviewCount => _needsReviewCount;

  int get unresolvedCount => _pendingCount + _conflictCount + _needsReviewCount;

  StreamSubscription<List<ConnectivityResult>>? _subscription;
  Timer? _readinessDebounceTimer;
  Duration _readinessDebounce = const Duration(milliseconds: 750);
  ClientReadinessProbe _readinessProbe =
      ClientReadinessService.instance.ensureReady;
  bool _wakeQueued = false;
  int _sessionBarrierDepth = 0;
  int _activeEnqueues = 0;
  Completer<void>? _quiescent;
  PreparedDrainGate? _preparedDrainGate;

  bool get isSessionBarrierActive => _sessionBarrierDepth > 0;

  void registerPreparedDrainGate(PreparedDrainGate gate) {
    _preparedDrainGate = gate;
  }

  void startListening() {
    _subscription ??= Connectivity().onConnectivityChanged.listen((results) {
      final newOnline = results.any((r) => r != ConnectivityResult.none);
      if (kDebugMode) {
        debugPrint('ConnectivitySync: online=$newOnline results=$results');
      }
      _handleTransportAvailability(newOnline);
    });

    Connectivity()
        .checkConnectivity()
        .then((results) {
          final newOnline = results.any((r) => r != ConnectivityResult.none);
          _handleTransportAvailability(newOnline);
        })
        .catchError((Object e) {
          // Probe failure is not a transport verdict — keep the current state
          // and let the onConnectivityChanged stream drive the next update.
          if (kDebugMode) debugPrint('ConnectivitySync: probe failed: $e');
        });
    refreshCounts();
  }

  void stopListening() {
    _subscription?.cancel();
    _subscription = null;
    _readinessDebounceTimer?.cancel();
    _readinessDebounceTimer = null;
  }

  void _handleTransportAvailability(bool available) {
    final nextTransport = available
        ? ClientTransportState.available
        : ClientTransportState.unavailable;
    final changed = _transportState != nextTransport || _isOnline != available;
    _transportState = nextTransport;
    _isOnline = available;

    _readinessDebounceTimer?.cancel();
    _readinessDebounceTimer = null;
    if (!available) {
      ClientReadinessService.instance.closeForTransportLoss();
      _readinessRouteKind = null;
      _continuityLifecycleState = ContinuityLifecycleState.notReady;
    } else if (!isSessionBarrierActive) {
      _readinessDebounceTimer = Timer(_readinessDebounce, () {
        _readinessDebounceTimer = null;
        syncPending();
      });
    }
    if (changed) notifyListeners();
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
        .where(
          (entry) =>
              entry.status == OfflineWriteStatus.pending ||
              entry.status == OfflineWriteStatus.inFlight ||
              entry.status == OfflineWriteStatus.retryWait,
        )
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

  /// Legacy fixture hook retained solely for the unchanged C0A migration and
  /// safety suites. Production Staff code is statically forbidden from
  /// attaching to this endpoint-classified path.
  @visibleForTesting
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

  Future<PersistedOfflineCommand> prepareCapture(
    OfflineCommandDraft draft,
  ) async {
    if (isSessionBarrierActive) throw const OfflineSessionBarrierActive();
    _activeEnqueues++;
    try {
      if (isSessionBarrierActive) throw const OfflineSessionBarrierActive();
      final command = await OfflineQueue.persistPreparedCommand(draft);
      await refreshCounts();
      if (_transportState == ClientTransportState.available &&
          !isSessionBarrierActive) {
        await syncPending();
      }
      return command;
    } finally {
      _activeEnqueues--;
      _signalQuiescentIfReady();
    }
  }

  Future<bool> reconcileCommand(
    int id,
    OfflineReconciliationRequest request,
  ) async {
    final reconciled = await OfflineQueue.reconcileCommand(id, request);
    if (reconciled) await refreshCounts();
    return reconciled;
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

  Future<int> cancelPreparedDrafts({
    required String actionId,
    required String patientReference,
    String? appointmentId,
    String? encounterId,
    String? admissionId,
  }) async {
    final removed = await OfflineQueue.cancelPreparedDrafts(
      actionId: actionId,
      patientReference: patientReference,
      appointmentId: appointmentId,
      encounterId: encounterId,
      admissionId: admissionId,
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
    if (isSessionBarrierActive) return;
    if (_isSyncing || _isEvaluatingReadiness) {
      _wakeQueued = true;
      return;
    }
    _isEvaluatingReadiness = true;
    var enteredDrain = false;

    try {
      final ownerAtStart = await AuthService.getStaffId();
      final wasAuthenticated = _hasAuthenticatedSession;
      _hasAuthenticatedSession =
          ownerAtStart != null && ownerAtStart.isNotEmpty;
      if (ownerAtStart == null || ownerAtStart.isEmpty) {
        _continuityLifecycleState = ContinuityLifecycleState.signedOut;
        if (wasAuthenticated != _hasAuthenticatedSession) notifyListeners();
        return;
      }
      if (_transportState != ClientTransportState.available) return;

      _continuityLifecycleState = ContinuityLifecycleState.checking;
      notifyListeners();
      ClientReadinessOutcome readiness;
      try {
        readiness = await _readinessProbe();
      } catch (error) {
        if (kDebugMode) {
          debugPrint(
            'ConnectivitySync: readiness failed: ${logSafeError(error)}',
          );
        }
        readiness = ClientReadinessOutcome.notReady;
      }
      _readinessRouteKind = readiness.routeKind;
      _continuityLifecycleState = readiness.lifecycle;
      notifyListeners();
      if (!readiness.ready) return;

      if (isSessionBarrierActive ||
          _transportState != ClientTransportState.available ||
          await AuthService.getStaffId() != ownerAtStart) {
        _readinessRouteKind = null;
        _continuityLifecycleState = isSessionBarrierActive
            ? ContinuityLifecycleState.notReady
            : ContinuityLifecycleState.signedOut;
        notifyListeners();
        return;
      }

      _isEvaluatingReadiness = false;
      _isSyncing = true;
      enteredDrain = true;
      _continuityLifecycleState = ContinuityLifecycleState.syncing;
      notifyListeners();

      await OfflineQueue.recoverExpiredLeases();
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
        if (entry.envelopeReady) {
          if ((entry.status != OfflineWriteStatus.pending &&
                  entry.status != OfflineWriteStatus.retryWait) ||
              entry.isSkipped ||
              transientlyBlockedPartitions.contains(entry.partitionKey)) {
            continue;
          }
          if (entry.attemptCount >= OfflineQueue.maxRetryCount) {
            await OfflineQueue.markPreparedNeedsReview(
              rowId: entry.id,
              reasonCode: 'retry_exhausted',
            );
            transientlyBlockedPartitions.add(entry.partitionKey);
            continue;
          }
          final inspected = await OfflineQueue.inspectPreparedCommand(entry.id);
          if (inspected == null) {
            transientlyBlockedPartitions.add(entry.partitionKey);
            continue;
          }
          final drainGate = _preparedDrainGate;
          // The shared core also serves Patient, whose queue contract is
          // unchanged. Staff registers its fail-closed policy gate before
          // starting connectivity orchestration.
          final gateDecision = drainGate == null
              ? const PreparedDrainGateDecision.allow()
              : await drainGate(inspected.envelope);
          if (gateDecision.disposition == PreparedDrainGateDisposition.pause) {
            transientlyBlockedPartitions.add(entry.partitionKey);
            continue;
          }
          if (gateDecision.disposition ==
              PreparedDrainGateDisposition.needsReview) {
            await OfflineQueue.markPreparedNeedsReview(
              rowId: entry.id,
              reasonCode: gateDecision.reasonCode,
            );
            transientlyBlockedPartitions.add(entry.partitionKey);
            continue;
          }
          final transport = entry.actionId == null
              ? null
              : OfflineActionIds.clientTransportFor(entry.actionId!);
          if (transport == null) {
            await OfflineQueue.markPreparedNeedsReview(
              rowId: entry.id,
              reasonCode: 'client_transport_binding_unavailable',
            );
            transientlyBlockedPartitions.add(entry.partitionKey);
            continue;
          }
          final command = await OfflineQueue.claimPreparedCommand(entry.id);
          if (command == null) {
            transientlyBlockedPartitions.add(entry.partitionKey);
            continue;
          }
          try {
            final result = await VHHttpClient.sendPreparedMutation(
              command,
              path: transport.path,
              method: transport.method,
            );
            if (isSessionBarrierActive ||
                await AuthService.getStaffId() != ownerAtStart) {
              await OfflineQueue.releasePreparedLeaseForAuthentication(
                rowId: command.rowId,
                leaseId: command.leaseId!,
              );
              break;
            }
            if (result.response.statusCode == 401) {
              await OfflineQueue.releasePreparedLeaseForAuthentication(
                rowId: command.rowId,
                leaseId: command.leaseId!,
              );
              break;
            }
            if (_isTypedPreparedSuccess(result)) {
              await OfflineQueue.markPreparedApplied(
                rowId: command.rowId,
                leaseId: command.leaseId!,
              );
            } else if (result.response.isSuccess) {
              await OfflineQueue.markPreparedNeedsReview(
                rowId: command.rowId,
                leaseId: command.leaseId,
                reasonCode: 'malformed_success_response',
              );
              transientlyBlockedPartitions.add(entry.partitionKey);
            } else if (preparedDispositionForStatus(
                  result.response.statusCode,
                ) ==
                SyncDisposition.conflict) {
              await OfflineQueue.markPreparedNeedsReview(
                rowId: command.rowId,
                leaseId: command.leaseId,
                reasonCode: _preparedReviewReason(result.response.statusCode),
              );
              transientlyBlockedPartitions.add(entry.partitionKey);
            } else {
              await OfflineQueue.schedulePreparedRetry(
                rowId: command.rowId,
                leaseId: command.leaseId!,
                retryAfter: result.retryAfter,
                reasonCode: result.response.statusCode == 429
                    ? 'server_retry_after'
                    : 'transient_http_failure',
              );
              transientlyBlockedPartitions.add(entry.partitionKey);
            }
          } catch (error) {
            if (kDebugMode) {
              debugPrint(
                'ConnectivitySync: prepared error id=${entry.id}: '
                '${logSafeError(error)}',
              );
            }
            await OfflineQueue.schedulePreparedRetry(
              rowId: command.rowId,
              leaseId: command.leaseId!,
              reasonCode: 'ambiguous_transport_outcome',
            );
            transientlyBlockedPartitions.add(entry.partitionKey);
          }
          if (isSessionBarrierActive ||
              await AuthService.getStaffId() != ownerAtStart) {
            break;
          }
          continue;
        }
        // C4.3 never executes endpoint/method authority from a legacy row.
        // All unresolved envelope_ready=0 rows are preserved as visible
        // needs_review evidence during queue open.
      }
    } finally {
      _isEvaluatingReadiness = false;
      _isSyncing = false;
      try {
        if (enteredDrain) await refreshCounts();
        if (enteredDrain && _needsReviewCount > 0) {
          _continuityLifecycleState = ContinuityLifecycleState.reviewRequired;
        } else if (enteredDrain &&
            _readinessRouteKind == ClientReadinessRouteKind.internal) {
          _continuityLifecycleState = ContinuityLifecycleState.readyInternal;
        } else if (enteredDrain &&
            _readinessRouteKind == ClientReadinessRouteKind.public) {
          _continuityLifecycleState = ContinuityLifecycleState.readyPublic;
        }
        notifyListeners();
      } finally {
        _signalQuiescentIfReady();
        _runCoalescedWake();
      }
    }
  }

  void _runCoalescedWake() {
    if (!_wakeQueued) return;
    _wakeQueued = false;
    if (isSessionBarrierActive) return;
    scheduleMicrotask(syncPending);
  }

  @visibleForTesting
  void setTransportAvailableForTesting(bool available) {
    _handleTransportAvailability(available);
  }

  @visibleForTesting
  void setConnectionStateForTesting({
    required ClientTransportState transport,
    required ContinuityLifecycleState continuity,
    bool authenticated = true,
    ClientReadinessRouteKind? routeKind,
  }) {
    _transportState = transport;
    _isOnline = transport == ClientTransportState.available;
    _continuityLifecycleState = continuity;
    _hasAuthenticatedSession = authenticated;
    _readinessRouteKind = routeKind;
    notifyListeners();
  }

  @visibleForTesting
  Future<void> resetForTesting({
    ClientReadinessProbe? readinessProbe,
    Duration readinessDebounce = const Duration(milliseconds: 750),
  }) async {
    stopListening();
    _isOnline = true;
    _transportState = ClientTransportState.available;
    _continuityLifecycleState = ContinuityLifecycleState.notReady;
    _readinessRouteKind = null;
    _isSyncing = false;
    _isEvaluatingReadiness = false;
    _hasAuthenticatedSession = false;
    _wakeQueued = false;
    _readinessDebounce = readinessDebounce;
    _readinessProbe =
        readinessProbe ??
        () async => ClientReadinessOutcome.alwaysReadyForTesting;
    ClientReadinessService.instance.resetForTesting();
    _pendingCount = 0;
    _conflictCount = 0;
    _needsReviewCount = 0;
    _sessionBarrierDepth = 0;
    _activeEnqueues = 0;
    _signalQuiescentIfReady();
  }
}
