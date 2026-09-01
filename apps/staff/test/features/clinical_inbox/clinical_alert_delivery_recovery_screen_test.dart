import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/clinical_alert_delivery_recovery_api_service.dart';
import 'package:vhhealth_staff/features/clinical_inbox/screens/clinical_alert_delivery_recovery_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class _FakeRecoveryApi implements ClinicalAlertDeliveryRecoveryApi {
  _FakeRecoveryApi(this.recoveryCase, {this.loadError, this.actionError});

  final ClinicalAlertDeliveryRecoveryCase recoveryCase;
  final Object? loadError;
  final Object? actionError;
  int listCalls = 0;
  int getCalls = 0;

  @override
  Future<ClinicalAlertDeliveryRecoveryCase> getCase(String caseId) async {
    getCalls += 1;
    expect(caseId, recoveryCase.caseId);
    if (loadError != null) throw loadError!;
    return recoveryCase;
  }

  @override
  Future<List<ClinicalAlertDeliveryRecoveryCase>> listOpenCases() async {
    listCalls += 1;
    return [recoveryCase];
  }

  @override
  Future<ClinicalAlertDeliveryRecoveryAction> retry({
    required String caseId,
    required String reason,
  }) async {
    if (actionError != null) throw actionError!;
    return _action('recovered');
  }

  @override
  Future<ClinicalAlertDeliveryRecoveryAction> supersede({
    required String caseId,
    required String reason,
  }) async {
    if (actionError != null) throw actionError!;
    return _action('superseded');
  }

  ClinicalAlertDeliveryRecoveryAction _action(String outcome) =>
      ClinicalAlertDeliveryRecoveryAction(
        caseId: recoveryCase.caseId,
        obligationId: recoveryCase.obligationId,
        actionId: '701',
        outcome: outcome,
        replayed: false,
        replacementObligationId: outcome == 'superseded' ? '702' : '',
      );
}

ClinicalAlertDeliveryRecoveryCase _case({
  required String kind,
  String status = 'open',
  String sourceTable = 'clinical_orders',
  String failureKind = 'order_mar_schedule',
  String? obligationStatus,
  String taskStatus = 'open',
  String slaStatus = 'active',
  String? lastErrorCode,
  String? manualHoldCode,
  String manualHoldReason = '',
  String resolutionKind = '',
}) => ClinicalAlertDeliveryRecoveryCase(
  caseId: '9223372036854775701',
  caseKind: kind,
  status: status,
  obligationId: '9223372036854775702',
  sourceTable: sourceTable,
  sourceId: '91',
  failureKind: failureKind,
  obligationStatus:
      obligationStatus ?? (kind == 'manual_hold' ? 'manual_hold' : 'pending'),
  taskStatus: taskStatus,
  slaStatus: slaStatus,
  openAgeSeconds: 42,
  overdue: false,
  escalationAttemptCount: 0,
  dueAt: DateTime.utc(2026, 8, 28, 1),
  escalatedAt: null,
  lastErrorCode:
      lastErrorCode ??
      (kind == 'recipient_coverage' ? 'no_active_clinical_recipients' : ''),
  manualHoldCode:
      manualHoldCode ??
      (kind == 'manual_hold' ? 'CLINICAL_ALERT_OBLIGATION_INTENT_INVALID' : ''),
  manualHoldReason: manualHoldReason,
  resolutionKind: resolutionKind,
);

Future<void> _pump(
  WidgetTester tester, {
  required String role,
  required _FakeRecoveryApi api,
}) async {
  tester.view.physicalSize = const Size(1400, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: ClinicalAlertDeliveryRecoveryScreen(
        initialCaseId: api.recoveryCase.caseId,
        api: api,
        roleLoader: () async => role,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('clinical staff cannot load the platform-admin recovery case', (
    tester,
  ) async {
    final api = _FakeRecoveryApi(_case(kind: 'recipient_coverage'));

    await _pump(tester, role: 'DUTY_DOCTOR', api: api);

    expect(api.getCalls, 0);
    expect(api.listCalls, 0);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('ADMIN sees retry only for recipient coverage', (tester) async {
    final api = _FakeRecoveryApi(_case(kind: 'recipient_coverage'));

    await _pump(tester, role: 'ADMIN', api: api);

    expect(api.getCalls, 1);
    expect(find.widgetWithIcon(FilledButton, Icons.replay), findsOneWidget);
    expect(
      find.widgetWithIcon(FilledButton, Icons.fact_check_outlined),
      findsNothing,
    );
    expect(find.text('recipient_coverage'), findsNothing);
    expect(find.textContaining('clinical_orders'), findsNothing);
    expect(find.text('order_mar_schedule'), findsNothing);
    expect(find.text('no_active_clinical_recipients'), findsNothing);
    expect(find.text('Clinical recipient coverage recovery'), findsOneWidget);
    expect(find.text('Medication order MAR scheduling failed'), findsOneWidget);
  });

  testWidgets('SUPER_ADMIN sees supersede only for an immutable manual hold', (
    tester,
  ) async {
    final api = _FakeRecoveryApi(_case(kind: 'manual_hold'));

    await _pump(tester, role: 'SUPER_ADMIN', api: api);

    expect(api.getCalls, 1);
    expect(find.widgetWithIcon(FilledButton, Icons.replay), findsNothing);
    expect(
      find.widgetWithIcon(FilledButton, Icons.fact_check_outlined),
      findsOneWidget,
    );
  });

  testWidgets('manual-hold backend reason and codes never render raw', (
    tester,
  ) async {
    const rawReason =
        'The exact stored clinical alert intent is unavailable or malformed.';
    final api = _FakeRecoveryApi(
      _case(kind: 'manual_hold', manualHoldReason: rawReason),
    );

    await _pump(tester, role: 'ADMIN', api: api);

    expect(find.text('manual_hold'), findsNothing);
    expect(find.text('CLINICAL_ALERT_OBLIGATION_INTENT_INVALID'), findsNothing);
    expect(find.text(rawReason), findsNothing);
    expect(find.text('Manual-hold source review'), findsOneWidget);
    expect(
      find.textContaining('stored alert intent is unavailable or invalid'),
      findsOneWidget,
    );
  });

  testWidgets('future alert fields fail closed to localized unknown values', (
    tester,
  ) async {
    final api = _FakeRecoveryApi(
      _case(
        kind: 'recipient_coverage',
        sourceTable: 'future_source',
        failureKind: 'future_failure',
        obligationStatus: 'future_delivery_status',
        taskStatus: 'future_task_status',
        slaStatus: 'future_sla_status',
        lastErrorCode: 'FUTURE_DELIVERY_ERROR',
      ),
    );

    await _pump(tester, role: 'SUPER_ADMIN', api: api);

    for (final raw in const [
      'future_source',
      'future_failure',
      'future_delivery_status',
      'future_task_status',
      'future_sla_status',
      'FUTURE_DELIVERY_ERROR',
    ]) {
      expect(find.textContaining(raw), findsNothing, reason: raw);
    }
    final strings = AppStrings.forLocale(const Locale('en'));
    expect(
      find.textContaining(
        strings.lookup('med03.alert_recovery.source.unknown'),
      ),
      findsOneWidget,
    );
    expect(
      find.text(strings.lookup('med03.alert_recovery.failure.unknown')),
      findsOneWidget,
    );
    expect(
      find.text(strings.lookup('med03.alert_recovery.error.unknown')),
      findsOneWidget,
    );
  });

  testWidgets('load failures use localized safe copy instead of raw errors', (
    tester,
  ) async {
    const rawError = 'Exception: upstream English database failure';
    final api = _FakeRecoveryApi(
      _case(kind: 'recipient_coverage'),
      loadError: Exception(rawError),
    );

    await _pump(tester, role: 'ADMIN', api: api);

    expect(find.textContaining(rawError), findsNothing);
    expect(
      find.text(
        AppStrings.forLocale(const Locale('en'))
            .lookup('med03.alert_recovery.load_failed'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('action failures use localized safe copy instead of raw errors', (
    tester,
  ) async {
    const rawError = 'Exception: raw retry transport failure';
    final api = _FakeRecoveryApi(
      _case(kind: 'recipient_coverage'),
      actionError: Exception(rawError),
    );
    await _pump(tester, role: 'ADMIN', api: api);
    await tester.enterText(find.byType(TextField), 'Retry after role coverage');
    await tester.tap(find.widgetWithIcon(FilledButton, Icons.replay));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.textContaining(rawError), findsNothing);
    expect(
      find.text(
        AppStrings.forLocale(const Locale('en'))
            .lookup('med03.alert_recovery.action_failed'),
      ),
      findsOneWidget,
    );
  });
}
