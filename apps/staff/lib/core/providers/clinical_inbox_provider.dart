import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import '../services/clinical_inbox_api_service.dart';

class ClinicalInboxProvider extends ChangeNotifier {
  ClinicalInboxProvider({
    ClinicalInboxApi api = ClinicalInboxApiService.instance,
    this.pollInterval = const Duration(minutes: 2),
  }) : _api = api;

  final ClinicalInboxApi _api;
  final Duration pollInterval;

  final Set<String> _mutatingIds = <String>{};
  final List<StreamSubscription<RealtimeEvent>> _subscriptions = [];
  Timer? _pollTimer;
  List<ClinicalInboxTask> _tasks = const [];
  bool _started = false;
  bool _refreshing = false;
  bool _refreshPending = false;
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

  Future<void> refresh() async {
    if (_refreshing) {
      _refreshPending = true;
      return;
    }

    do {
      _refreshing = true;
      _refreshPending = false;
      notifyListeners();
      try {
        final result = await _api.listInboxTasks();
        _tasks = _sortTasks(result.tasks);
        _lastError = null;
      } catch (e) {
        _lastError = e.toString();
        if (kDebugMode) debugPrint('Clinical inbox refresh failed: $e');
      } finally {
        _refreshing = false;
        notifyListeners();
      }
    } while (_refreshPending);
  }

  Future<void> acknowledge(String id, {int? breakGlassId}) async {
    if (_mutatingIds.contains(id)) return;
    _mutatingIds.add(id);
    notifyListeners();
    try {
      final updated = await _api.acknowledgeTask(
        id,
        breakGlassId: breakGlassId,
      );
      _tasks = _sortTasks([
        for (final task in _tasks) task.id == id ? updated : task,
      ]);
      _lastError = null;
    } catch (e) {
      _lastError = e.toString();
      rethrow;
    } finally {
      _mutatingIds.remove(id);
      notifyListeners();
    }
  }

  Future<ClinicalInboxTask> claimForReview(String id) async {
    if (_mutatingIds.contains(id)) {
      throw StateError('This task is already being updated');
    }
    _mutatingIds.add(id);
    notifyListeners();
    try {
      await _api.claimTask(id);
      await refresh();
      _lastError = null;
      return _tasks.firstWhere((task) => task.id == id);
    } catch (e) {
      _lastError = e.toString();
      rethrow;
    } finally {
      _mutatingIds.remove(id);
      notifyListeners();
    }
  }

  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) async {
    if (_mutatingIds.contains(command.taskId)) {
      throw StateError('This task is already being updated');
    }
    _mutatingIds.add(command.taskId);
    notifyListeners();
    try {
      final receipt = await _api.recordDiagnosticAction(command);
      await refresh();
      _lastError = null;
      return receipt;
    } catch (e) {
      _lastError = e.toString();
      rethrow;
    } finally {
      _mutatingIds.remove(command.taskId);
      notifyListeners();
    }
  }

  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  ) async {
    if (_mutatingIds.contains(command.actionTaskId)) {
      throw StateError('This task is already being updated');
    }
    _mutatingIds.add(command.actionTaskId);
    notifyListeners();
    try {
      final receipt = await _api.crossSignPendingResult(command);
      await refresh();
      _lastError = null;
      return receipt;
    } catch (e) {
      _lastError = e.toString();
      if (e is PostDischargeCrossSignException && e.requiresRefresh) {
        await refresh();
      }
      rethrow;
    } finally {
      _mutatingIds.remove(command.actionTaskId);
      notifyListeners();
    }
  }

  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  }) async {
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
      await refresh();
      _lastError = null;
      return receipt;
    } catch (e) {
      _lastError = e.toString();
      rethrow;
    } finally {
      _mutatingIds.remove(mutationId);
      notifyListeners();
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

  @override
  void dispose() {
    _pollTimer?.cancel();
    for (final sub in _subscriptions) {
      unawaited(sub.cancel());
    }
    super.dispose();
  }
}
