import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/clinical_inbox_provider.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';
import 'package:vhhealth_staff/core/widgets/message_unread_badge.dart';
import 'package:vhhealth_staff/features/clinical_inbox/screens/clinical_inbox_screen.dart';

void main() {
  testWidgets('clinical inbox renders grouped tasks', (tester) async {
    final api = _FakeClinicalInboxApi(tasks: [_task(id: '1')]);
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pump();
    await tester.pump();

    expect(find.text('Clinical Inbox'), findsOneWidget);
    expect(find.text('Critical'), findsOneWidget);
    expect(find.text('Critical lab: Potassium'), findsOneWidget);
    expect(find.textContaining('patient-1'), findsOneWidget);
  });

  testWidgets('acknowledge button fires once while pending', (tester) async {
    final releaseAck = Completer<void>();
    final api = _FakeClinicalInboxApi(
      tasks: [_task(id: '1')],
      acknowledgeDelay: releaseAck.future,
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pump();
    await tester.pump();

    final acknowledge = find.byType(FilledButton).first;
    await tester.tap(acknowledge);
    await tester.pump();
    await tester.tap(acknowledge, warnIfMissed: false);
    await tester.pump();

    expect(api.acknowledgeCalls, 1);
    releaseAck.complete();
    await tester.pumpAndSettle();
    expect(find.text('Acknowledged'), findsWidgets);
  });

  test('provider pending count updates after acknowledgement', () async {
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(id: '1'),
        _task(id: '2'),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);

    await provider.refresh();
    expect(provider.pendingCount, 2);

    await provider.acknowledge('1');
    expect(provider.pendingCount, 1);
    expect(api.acknowledgeCalls, 1);
  });

  testWidgets('clinical inbox badge updates from provider count', (
    tester,
  ) async {
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(id: '1'),
        _task(id: '2'),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);
    await provider.refresh();

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: provider,
        child: MaterialApp(
          home: Consumer<ClinicalInboxProvider>(
            builder: (context, inbox, child) => MessageUnreadBadge(
              unreadCount: inbox.pendingCount,
              semanticLabel: 'pending clinical tasks',
              child: const Icon(Icons.assignment_late_outlined),
            ),
          ),
        ),
      ),
    );

    expect(find.text('2'), findsOneWidget);

    await provider.acknowledge('1');
    await tester.pump();

    expect(find.text('1'), findsOneWidget);
  });

  testWidgets('domain-evidence work requires a signed disposition', (
    tester,
  ) async {
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(
          id: '73',
          semantics: 'domain_evidence',
          assignedToUid: 'doctor-1',
        ),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pumpAndSettle();

    expect(find.text('Review and record action'), findsOneWidget);
    expect(find.text('Acknowledge critical result'), findsNothing);

    await tester.tap(find.text('Review and record action'));
    await tester.pumpAndSettle();
    expect(find.text('Record diagnostic action'), findsOneWidget);

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('No action required').last);
    await tester.pumpAndSettle();

    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), 'Reviewed the signed generation.');
    await tester.enterText(fields.at(1), 'No treatment change is required.');
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.ensureVisible(find.text('Sign and record action'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign and record action'));
    await tester.pumpAndSettle();

    expect(api.actionCalls, 1);
    expect(api.lastAction?.disposition, 'no_action');
    expect(find.text('Diagnostic action recorded'), findsOneWidget);
  });
}

Widget _host(ClinicalInboxProvider provider) {
  return ChangeNotifierProvider.value(
    value: provider,
    child: const MaterialApp(home: ClinicalInboxScreen()),
  );
}

ClinicalInboxTask _task({
  required String id,
  String semantics = 'acknowledgement',
  String assignedToUid = '',
}) {
  final now = DateTime.now();
  return ClinicalInboxTask(
    id: id,
    title: 'Critical lab: Potassium',
    description: 'K 6.8 mmol/L above critical threshold',
    patientUid: 'patient-$id',
    priority: 'critical',
    status: 'open',
    relatedResourceType: 'lab_result',
    relatedResourceId: 'lr-$id',
    assignedToUid: assignedToUid,
    assignedToRole: assignedToUid.isEmpty ? 'DUTY_DOCTOR' : '',
    slaCompletionSemantics: semantics,
    diagnosticGenerationId: semantics == 'domain_evidence'
        ? '11111111-1111-4111-8111-111111111111'
        : '',
    diagnosticClassification: semantics == 'domain_evidence' ? 'abnormal' : '',
    diagnosticGenerationSnapshotSha256: semantics == 'domain_evidence'
        ? List.filled(64, 'a').join()
        : '',
    dueAt: now.add(const Duration(minutes: 8)),
    slaBreachedAt: null,
    createdAt: now.subtract(const Duration(minutes: 2)),
    metadata: const {'source': 'lab_result'},
  );
}

class _FakeClinicalInboxApi extends ClinicalInboxApi {
  _FakeClinicalInboxApi({
    required List<ClinicalInboxTask> tasks,
    this.acknowledgeDelay,
  }) : _tasks = tasks;

  List<ClinicalInboxTask> _tasks;
  final Future<void>? acknowledgeDelay;
  int acknowledgeCalls = 0;
  int actionCalls = 0;
  DiagnosticActionCommand? lastAction;

  @override
  Future<ClinicalInboxResult> listInboxTasks({int limit = 100}) async {
    return ClinicalInboxResult(tasks: _tasks, count: _tasks.length);
  }

  @override
  Future<ClinicalInboxTask> acknowledgeTask(
    String id, {
    int? breakGlassId,
  }) async {
    acknowledgeCalls += 1;
    final delay = acknowledgeDelay;
    if (delay != null) await delay;
    final updated = _tasks
        .firstWhere((task) => task.id == id)
        .copyWith(status: 'in_progress');
    _tasks = [for (final task in _tasks) task.id == id ? updated : task];
    return updated;
  }

  @override
  Future<ClinicalInboxTask> claimTask(String id) async {
    final updated = _tasks
        .firstWhere((task) => task.id == id)
        .copyWith(assignedToUid: 'doctor-1', assignedToRole: '');
    _tasks = [for (final task in _tasks) task.id == id ? updated : task];
    return updated;
  }

  @override
  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) async {
    actionCalls += 1;
    lastAction = command;
    _tasks = [
      for (final task in _tasks)
        if (task.id != command.taskId) task,
    ];
    return DiagnosticActionReceipt(
      id: 'action-1',
      generationId: command.generationId,
      taskId: command.taskId,
      actionKind: 'doctor_disposition',
      disposition: command.disposition,
      signatureId: 'signature-1',
      replayed: false,
    );
  }
}
