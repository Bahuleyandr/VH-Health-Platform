import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import '../services/clinical_inbox_api_service.dart';
import '../services/idempotency_attempt_registry.dart';

class ClinicalInboxProvider extends ChangeNotifier {
  // Keep the public injection seam named `api` while the dependency remains
  // encapsulated as a private field.
  ClinicalInboxProvider({
    ClinicalInboxApi api = ClinicalInboxApiService.instance,
    this.pollInterval = const Duration(minutes: 2),
    // ignore: prefer_initializing_formals
  }) : _api = api;

  final ClinicalInboxApi _api;
  final Duration pollInterval;

  final Set<String> _mutatingIds = <String>{};
  final IdempotencyAttemptRegistry _claimAttempts =
      IdempotencyAttemptRegistry();
  final List<StreamSubscription<RealtimeEvent>> _subscriptions = [];
  Timer? _pollTimer;
  List<ClinicalInboxTask> _tasks = const [];
  bool _started = false;
  bool _refreshing = false;
  bool _refreshPending = false;
  int _sessionGeneration = 0;
  int? _refreshGeneration;
  String? _lastError;

  List<ClinicalInboxTask> get tasks => _tasks;
  bool get isRefreshing => _refreshing;
  String? get lastError => _lastError;
  int get pendingCount =>
      _tasks.where((task) => task.needsClinicalAction).length;

  bool isMutating(String id) => _mutatingIds.contains(id);

  bool isAcknowledging(String id) => isMutating(id);

  Future<void> start() async {
    if (_started) return;
    _started = true;
    _sessionGeneration += 1;
    _subscriptions.addAll([
      RealtimeClient.instance
          .events('staff:clinical-alerts')
          .listen((_) => unawaited(refresh())),
      RealtimeClient.instance
          .events('staff:lab')
          .listen((_) => unawaited(refresh())),
    ]);
    _pollTimer = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
    await refresh();
  }

  /// Tear down on logout (STF-1): cancel the poll timer and realtime
  /// subscriptions and drop the previous clinician's task list so no PHI
  /// survives into the login screen or the next session. [start] may be
  /// called again after the next login.
  void stop() {
    _sessionGeneration += 1;
    _started = false;
    _pollTimer?.cancel();
    _pollTimer = null;
    for (final sub in _subscriptions) {
      unawaited(sub.cancel());
    }
    _subscriptions.clear();
    _mutatingIds.clear();
    _claimAttempts.clear();
    _tasks = const [];
    _lastError = null;
    _refreshing = false;
    _refreshPending = false;
    _refreshGeneration = null;
    notifyListeners();
  }

  Future<void> refresh() async {
    final generation = _sessionGeneration;
    if (_refreshing && _refreshGeneration == generation) {
      _refreshPending = true;
      return;
    }

    do {
      if (generation != _sessionGeneration) return;
      _refreshing = true;
      _refreshGeneration = generation;
      _refreshPending = false;
      notifyListeners();
      try {
        final result = await _api.listInboxTasks();
        if (generation != _sessionGeneration) return;
        _tasks = _sortTasks(result.tasks);
        _lastError = null;
      } catch (e) {
        if (generation != _sessionGeneration) return;
        _lastError = e.toString();
        if (kDebugMode) debugPrint('Clinical inbox refresh failed: $e');
      } finally {
        if (_refreshGeneration == generation) {
          _refreshing = false;
          _refreshGeneration = null;
          notifyListeners();
        }
      }
    } while (_refreshPending && generation == _sessionGeneration);
  }

  Future<void> acknowledge(String id, {int? breakGlassId}) async {
    final generation = _sessionGeneration;
    _requireOnlineMutation();
    if (_mutatingIds.contains(id)) return;
    _mutatingIds.add(id);
    notifyListeners();
    try {
      final updated = await _api.acknowledgeTask(
        id,
        breakGlassId: breakGlassId,
      );
      if (generation != _sessionGeneration) return;
      _tasks = _sortTasks([
        for (final task in _tasks) task.id == id ? updated : task,
      ]);
      _lastError = null;
    } catch (e) {
      if (generation == _sessionGeneration) _lastError = e.toString();
      rethrow;
    } finally {
      if (generation == _sessionGeneration) {
        _mutatingIds.remove(id);
        notifyListeners();
      }
    }
  }

  Future<ClinicalInboxTask> claimForReview(String id) async {
    final generation = _sessionGeneration;
    _requireOnlineMutation();
    if (_mutatingIds.contains(id)) {
      throw StateError('This task is already being updated');
    }
    _mutatingIds.add(id);
    notifyListeners();
    try {
      final claimed = await _api.claimTask(id);
      if (generation != _sessionGeneration) return claimed;
      await refresh();
      if (generation != _sessionGeneration) return claimed;
      _lastError = null;
      return _tasks.firstWhere((task) => task.id == id, orElse: () => claimed);
    } catch (e) {
      if (generation == _sessionGeneration) _lastError = e.toString();
      rethrow;
    } finally {
      if (generation == _sessionGeneration) {
        _mutatingIds.remove(id);
        notifyListeners();
      }
    }
  }

  Future<ClinicalInboxTask> claimMarMedicationException(
    ClinicalInboxTask task,
  ) async {
    final generation = _sessionGeneration;
    _requireOnlineMutation();
    if (!task.isMarMedicationException || !task.isRoleOwned) {
      throw StateError('This is not an unassigned medication exception task');
    }
    if (_mutatingIds.contains(task.id)) {
      throw StateError('This task is already being updated');
    }
    final caseId = task.relatedResourceId;
    final attemptScope = 'mar-exception-claim:$caseId';
    final idempotencyKey = _claimAttempts.keyFor(attemptScope, {
      'exception_case_id': caseId,
      'task_id': task.id,
    });
    _mutatingIds.add(task.id);
    notifyListeners();
    try {
      await _api.claimMarMedicationException(
        caseId: caseId,
        idempotencyKey: idempotencyKey,
      );
      _claimAttempts.complete(attemptScope);
      if (generation != _sessionGeneration) return task;
      await refresh();
      if (generation != _sessionGeneration) return task;
      _lastError = null;
      return _tasks.firstWhere(
        (candidate) => candidate.id == task.id,
        orElse: () => task,
      );
    } catch (e) {
      if (generation == _sessionGeneration) _lastError = e.toString();
      rethrow;
    } finally {
      if (generation == _sessionGeneration) {
        _mutatingIds.remove(task.id);
        notifyListeners();
      }
    }
  }

  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) async {
    final generation = _sessionGeneration;
    _requireOnlineMutation();
    if (_mutatingIds.contains(command.taskId)) {
      throw StateError('This task is already being updated');
    }
    _mutatingIds.add(command.taskId);
    notifyListeners();
    try {
      final receipt = await _api.recordDiagnosticAction(command);
      if (generation == _sessionGeneration) {
        await refresh();
        if (generation == _sessionGeneration) _lastError = null;
      }
      return receipt;
    } catch (e) {
      if (generation == _sessionGeneration) _lastError = e.toString();
      rethrow;
    } finally {
      if (generation == _sessionGeneration) {
        _mutatingIds.remove(command.taskId);
        notifyListeners();
      }
    }
  }

  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  ) async {
    final generation = _sessionGeneration;
    _requireOnlineMutation();
    if (_mutatingIds.contains(command.actionTaskId)) {
      throw StateError('This task is already being updated');
    }
    _mutatingIds.add(command.actionTaskId);
    notifyListeners();
    try {
      final receipt = await _api.crossSignPendingResult(command);
      if (generation == _sessionGeneration) {
        await refresh();
        if (generation == _sessionGeneration) _lastError = null;
      }
      return receipt;
    } catch (e) {
      if (generation == _sessionGeneration) _lastError = e.toString();
      if (generation == _sessionGeneration &&
          e is PostDischargeCrossSignException &&
          e.requiresRefresh) {
        await refresh();
      }
      rethrow;
    } finally {
      if (generation == _sessionGeneration) {
        _mutatingIds.remove(command.actionTaskId);
        notifyListeners();
      }
    }
  }

  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  }) async {
    final sessionGeneration = _sessionGeneration;
    _requireOnlineMutation();
    final mutationId = 'generation:$generationId';
    if (_mutatingIds.contains(mutationId)) {
      throw StateError('This result is already being updated');
    }
    _mutatingIds.add(mutationId);
    notifyListeners();
    try {
      final receipt = await _api.reopenDiagnosticResult(
        generationId: generationId,
        reason: reason,
      );
      if (sessionGeneration == _sessionGeneration) {
        await refresh();
        if (sessionGeneration == _sessionGeneration) _lastError = null;
      }
      return receipt;
    } catch (e) {
      if (sessionGeneration == _sessionGeneration) {
        _lastError = e.toString();
      }
      rethrow;
    } finally {
      if (sessionGeneration == _sessionGeneration) {
        _mutatingIds.remove(mutationId);
        notifyListeners();
      }
    }
  }

  @visibleForTesting
  void setTasksForTesting(List<ClinicalInboxTask> tasks) {
    _tasks = _sortTasks(tasks);
    notifyListeners();
  }

  List<ClinicalInboxTask> _sortTasks(List<ClinicalInboxTask> tasks) {
    final now = DateTime.now();
    final sorted = [...tasks];
    sorted.sort((a, b) {
      final urgency = _sortRank(a, now).compareTo(_sortRank(b, now));
      if (urgency != 0) return urgency;
      final aDue = a.dueAt;
      final bDue = b.dueAt;
      if (aDue != null && bDue != null) return aDue.compareTo(bDue);
      if (aDue != null) return -1;
      if (bDue != null) return 1;
      return (b.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0)).compareTo(
        a.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0),
      );
    });
    return List.unmodifiable(sorted);
  }

  int _sortRank(ClinicalInboxTask task, DateTime now) {
    if (task.isOverdue(now)) return 0;
    return switch (task.priority) {
      'critical' => 1,
      'high' => 2,
      'normal' => 3,
      _ => task.needsClinicalAction ? 4 : 5,
    };
  }

  void _requireOnlineMutation() {
    if (!ConnectivitySyncService.instance.isOnline) {
      throw const ClinicalInboxOfflineMutation();
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    for (final sub in _subscriptions) {
      unawaited(sub.cancel());
    }
    super.dispose();
  }
}

class ClinicalInboxOfflineMutation implements Exception {
  const ClinicalInboxOfflineMutation();

  @override
  String toString() => 'Online connection required for clinical inbox action';
}
