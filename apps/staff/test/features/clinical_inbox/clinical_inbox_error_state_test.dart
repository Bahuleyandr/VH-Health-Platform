import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/clinical_inbox_provider.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';
import 'package:vhhealth_staff/features/clinical_inbox/screens/clinical_inbox_screen.dart';

void main() {
  test(
    'stop prevents an in-flight refresh from restoring signed-out PHI',
    () async {
      final api = _DeferredInboxApi();
      final provider = ClinicalInboxProvider(api: api);
      provider.setTasksForTesting([_task()]);

      final refresh = provider.refresh();
      await api.started.future;
      provider.stop();
      api.response.complete(ClinicalInboxResult(tasks: [_task()], count: 1));
      await refresh;

      expect(provider.tasks, isEmpty);
      expect(provider.lastError, isNull);
      expect(provider.isRefreshing, isFalse);
    },
  );

  testWidgets('empty refresh failure never renders empty-success copy', (
    tester,
  ) async {
    final api = _InboxApi()..fail = true;
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('fixture refresh failure'), findsOneWidget);
    expect(find.text('No pending critical results'), findsNothing);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('refresh failure retains cached tasks with an error banner', (
    tester,
  ) async {
    final api = _InboxApi(tasks: [_task()]);
    final provider = ClinicalInboxProvider(api: api);
    await provider.refresh();
    api.fail = true;

    await tester.pumpWidget(_host(provider));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('fixture refresh failure'), findsOneWidget);
    expect(find.text('Retained critical task'), findsOneWidget);
    expect(find.text('No pending critical results'), findsNothing);
  });
}

class _DeferredInboxApi extends ClinicalInboxApi {
  final started = Completer<void>();
  final response = Completer<ClinicalInboxResult>();

  @override
  Future<ClinicalInboxResult> listInboxTasks({int limit = 100}) {
    if (!started.isCompleted) started.complete();
    return response.future;
  }

  @override
  Future<ClinicalInboxTask> acknowledgeTask(String id, {int? breakGlassId}) {
    throw UnsupportedError('Acknowledgement is outside this fixture');
  }

  @override
  Future<ClinicalInboxTask> claimTask(String id) =>
      throw UnsupportedError('Claim is outside this fixture');

  @override
  Future<void> claimMarMedicationException({
    required String caseId,
    required String idempotencyKey,
  }) => throw UnsupportedError('MAR claim is outside this fixture');

  @override
  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) => throw UnsupportedError('Action is outside this fixture');

  @override
  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  ) => throw UnsupportedError('Cross-sign is outside this fixture');

  @override
  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  }) => throw UnsupportedError('Reopen is outside this fixture');
}

Widget _host(ClinicalInboxProvider provider) {
  return ChangeNotifierProvider.value(
    value: provider,
    child: const MaterialApp(home: ClinicalInboxScreen()),
  );
}

class _InboxApi extends ClinicalInboxApi {
  _InboxApi({this.tasks = const []});

  final List<ClinicalInboxTask> tasks;
  bool fail = false;

  @override
  Future<ClinicalInboxResult> listInboxTasks({int limit = 100}) async {
    if (fail) throw StateError('fixture refresh failure');
    return ClinicalInboxResult(tasks: tasks, count: tasks.length);
  }

  @override
  Future<ClinicalInboxTask> acknowledgeTask(String id, {int? breakGlassId}) {
    throw UnsupportedError('Acknowledgement is outside this fixture');
  }

  @override
  Future<ClinicalInboxTask> claimTask(String id) =>
      throw UnsupportedError('Claim is outside this fixture');

  @override
  Future<void> claimMarMedicationException({
    required String caseId,
    required String idempotencyKey,
  }) => throw UnsupportedError('MAR claim is outside this fixture');

  @override
  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) => throw UnsupportedError('Action is outside this fixture');

  @override
  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  ) => throw UnsupportedError('Cross-sign is outside this fixture');

  @override
  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  }) => throw UnsupportedError('Reopen is outside this fixture');
}

ClinicalInboxTask _task() {
  final now = DateTime.utc(2026, 7, 31, 12);
  return ClinicalInboxTask(
    id: 'task-1',
    taskKind: 'critical_result',
    title: 'Retained critical task',
    description: 'Cached description',
    patientUid: 'patient-1',
    priority: 'critical',
    status: 'open',
    relatedResourceType: 'lab_result',
    relatedResourceId: 'result-1',
    assignedToUid: '',
    assignedToRole: 'DUTY_DOCTOR',
    slaCompletionSemantics: 'acknowledgement',
    diagnosticGenerationId: '',
    diagnosticClassification: '',
    diagnosticGenerationSnapshotSha256: '',
    pendingResultHandoffId: '',
    pendingResultOwnerActionId: '',
    pendingResultHandoffState: '',
    pendingResultResolutionActionId: '',
    diagnosticAuthoritativeActionId: '',
    diagnosticAuthoritativeActionKind: '',
    diagnosticAuthoritativeDisposition: '',
    canCrossSignPendingResult: false,
    dueAt: now.add(const Duration(minutes: 10)),
    slaBreachedAt: null,
    createdAt: now,
    metadata: const {},
  );
}
