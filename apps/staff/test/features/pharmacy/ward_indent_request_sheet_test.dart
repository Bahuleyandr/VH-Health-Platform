import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/config/ward_indent_role_contract.dart';
import 'package:vhhealth_staff/core/services/idempotency_attempt_registry.dart';
import 'package:vhhealth_staff/features/pharmacy/models/ward_indent_models.dart';
import 'package:vhhealth_staff/features/pharmacy/services/ward_indent_gateway.dart';
import 'package:vhhealth_staff/features/pharmacy/widgets/ward_indent_request_sheet.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    await ConnectivitySyncService.instance.resetForTesting();
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.available,
      continuity: ContinuityLifecycleState.readyInternal,
    );
  });

  tearDown(() async {
    await ConnectivitySyncService.instance.resetForTesting();
  });

  test(
    'command contains only order-bound confirmations and server projection',
    () {
      final command = WardIndentOrderBoundCommand(
        admissionId: 73,
        order: _eligibleOrder,
        notes: '  automatic request missing  ',
      );

      expect(command.toRequestBody(), {
        'admission_id': 73,
        'indent_type': 'pharmacy',
        'items': [
          {
            'clinical_order_id': 91,
            'pharmacy_catalog_id': 41,
            'quantity_requested': 2,
            'unit': 'tablet',
          },
        ],
        'notes': 'automatic request missing',
      });
      expect(command.toRequestBody(), isNot(contains('patient_uid')));
      expect(command.toRequestBody(), isNot(contains('ward_id')));
      expect(
        (command.toRequestBody()['items'] as List).single,
        isNot(contains('item_name')),
      );
      expect(
        (command.toRequestBody()['items'] as List).single,
        isNot(contains('unit_price')),
      );
    },
  );

  test(
    'request role contract remains explicit and denies stores-only actors',
    () {
      expect(
        WardIndentRoleContract.canRequest(
          rawRole: 'NURSING_STAFF',
          role: StaffRole.nurse,
        ),
        isTrue,
      );
      expect(
        WardIndentRoleContract.canRequest(
          rawRole: 'STORES_PURCHASE_INCHARGE',
          role: StaffRole.fromString('STORES_PURCHASE_INCHARGE'),
        ),
        isFalse,
      );
    },
  );

  test('typed conflict preserves winning and canonical server details', () {
    const conflict = WardIndentRequestConflict(
      code: 'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
      message: 'already linked',
      details: {
        'ward_indent_id': 501,
        'expected_catalog_id': 41,
        'expected_quantity': 3,
        'expected_unit': 'tablets',
      },
    );

    expect(conflict.winningIndentId, 501);
    expect(conflict.expectedCatalogId, 41);
    expect(conflict.expectedQuantity, 3);
    expect(conflict.expectedUnit, 'tablets');
  });

  testWidgets('loads read-only context and submits the exact projected order', (
    tester,
  ) async {
    final gateway = _FakeRequesterGateway(projections: [_projection()]);
    await _pumpSheet(tester, gateway);

    await tester.enterText(
      find.byKey(const Key('ward-indent-request-admission-id')),
      '73',
    );
    await tester.tap(find.byKey(const Key('ward-indent-request-load')));
    await tester.pumpAndSettle();

    expect(find.text('Patient: Test Patient (VH-000073)'), findsOneWidget);
    expect(find.text('Admission 73 - Ward Ward A'), findsOneWidget);
    expect(find.text('Paracetamol 500 mg tablet'), findsOneWidget);
    expect(
      find.text(
        'ORD-91 - 2 tablet; dose 500 mg; route oral; schedule TID / 08:00 / 14:00 / 20:00; status verified; priority urgent',
      ),
      findsOneWidget,
    );
    final unconfirmed = tester.widget<FilledButton>(
      find.byKey(const Key('ward-indent-request-submit')),
    );
    expect(unconfirmed.onPressed, isNull);
    await tester.tap(find.byKey(const Key('ward-indent-request-order-91')));

    await tester.enterText(
      find.byKey(const Key('ward-indent-request-notes')),
      'automatic request missing',
    );
    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();

    expect(gateway.commands, hasLength(1));
    expect(gateway.commands.single.toRequestBody(), {
      'admission_id': 73,
      'indent_type': 'pharmacy',
      'items': [
        {
          'clinical_order_id': 91,
          'pharmacy_catalog_id': 41,
          'quantity_requested': 2,
          'unit': 'tablet',
        },
      ],
      'notes': 'automatic request missing',
    });
    expect(gateway.keys.single, startsWith('ward-indent-order-bound-request:'));
  });

  testWidgets('ambiguous failure keeps the same key until success', (
    tester,
  ) async {
    final attempts = IdempotencyAttemptRegistry();
    final gateway = _FakeRequesterGateway(
      projections: [_projection()],
      createErrors: [Exception('response lost'), null],
    );
    await _pumpSheet(tester, gateway, attempts: attempts);
    await _loadAdmission(tester);

    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();
    expect(gateway.keys, hasLength(1));
    expect(
      attempts.current('ward-indent-order-bound-request'),
      gateway.keys.single,
    );

    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();
    expect(gateway.keys, hasLength(2));
    expect(gateway.keys[1], gateway.keys[0]);
    expect(attempts.current('ward-indent-order-bound-request'), isNull);
  });

  testWidgets('changing notes rotates the command key after a failed attempt', (
    tester,
  ) async {
    final gateway = _FakeRequesterGateway(
      projections: [_projection()],
      createErrors: [Exception('timeout'), Exception('timeout')],
    );
    await _pumpSheet(tester, gateway);
    await _loadAdmission(tester);

    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('ward-indent-request-notes')),
      'changed recovery reason',
    );
    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();

    expect(gateway.keys, hasLength(2));
    expect(gateway.keys[1], isNot(gateway.keys[0]));
  });

  testWidgets('changing admission clears notes, attempt, and confirmation', (
    tester,
  ) async {
    final attempts = IdempotencyAttemptRegistry();
    final gateway = _FakeRequesterGateway(
      projections: [_projection(), _projection(admissionId: 74)],
      createErrors: [Exception('response lost')],
    );
    await _pumpSheet(tester, gateway, attempts: attempts);
    await _loadAdmission(tester);
    await tester.enterText(
      find.byKey(const Key('ward-indent-request-notes')),
      'patient 73 recovery',
    );
    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();
    expect(attempts.current('ward-indent-order-bound-request'), isNotNull);

    await tester.enterText(
      find.byKey(const Key('ward-indent-request-admission-id')),
      '74',
    );
    // enterText schedules no frame of its own: onChanged drops the projection
    // synchronously, but the context card only leaves the tree on the next
    // build, so the widget assertions below need that frame pumped first.
    await tester.pump();
    expect(attempts.current('ward-indent-order-bound-request'), isNull);
    expect(find.byKey(const Key('ward-indent-request-context')), findsNothing);
    expect(find.byKey(const Key('ward-indent-request-submit')), findsNothing);

    await tester.tap(find.byKey(const Key('ward-indent-request-load')));
    await tester.pumpAndSettle();
    final notes = tester.widget<TextField>(
      find.byKey(const Key('ward-indent-request-notes')),
    );
    expect(notes.controller?.text, isEmpty);
    final submit = tester.widget<FilledButton>(
      find.byKey(const Key('ward-indent-request-submit')),
    );
    expect(submit.onPressed, isNull);
  });

  testWidgets('changing order clears notes, attempt, and prior error', (
    tester,
  ) async {
    final attempts = IdempotencyAttemptRegistry();
    final gateway = _FakeRequesterGateway(
      projections: [
        _projection(orders: const [_eligibleOrder, _secondEligibleOrder]),
      ],
      createErrors: [Exception('response lost')],
    );
    await _pumpSheet(tester, gateway, attempts: attempts);
    await _loadAdmission(tester);
    await tester.enterText(
      find.byKey(const Key('ward-indent-request-notes')),
      'specific to order 91',
    );
    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();
    expect(attempts.current('ward-indent-order-bound-request'), isNotNull);
    expect(find.byKey(const Key('ward-indent-request-error')), findsOneWidget);

    await tester.tap(find.byKey(const Key('ward-indent-request-order-92')));
    await tester.pump();

    final notes = tester.widget<TextField>(
      find.byKey(const Key('ward-indent-request-notes')),
    );
    expect(notes.controller?.text, isEmpty);
    expect(attempts.current('ward-indent-order-bound-request'), isNull);
    expect(find.byKey(const Key('ward-indent-request-error')), findsNothing);
    final submit = tester.widget<FilledButton>(
      find.byKey(const Key('ward-indent-request-submit')),
    );
    expect(submit.onPressed, isNotNull);
  });

  testWidgets('already-linked conflict opens the winning indent from details', (
    tester,
  ) async {
    final gateway = _FakeRequesterGateway(
      projections: [_projection()],
      winningIndent: WardIndent.fromJson({
        'id': 501,
        'indent_number': 'WI-501',
        'status': 'requested',
        'state_version': 1,
        'items': const [],
        'workflow': const {},
      }),
      createErrors: const [
        WardIndentRequestConflict(
          code: 'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
          message: 'already linked',
          details: {'ward_indent_id': 501},
        ),
      ],
    );
    await _pumpSheet(tester, gateway);
    await _loadAdmission(tester);

    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();

    expect(gateway.getIds, [501]);
    expect(gateway.loadAdmissionIds, [73]);
  });

  testWidgets('canonical conflict displays structured expected fields', (
    tester,
  ) async {
    final gateway = _FakeRequesterGateway(
      projections: [_projection(), _projection()],
      createErrors: const [
        WardIndentRequestConflict(
          code: 'WARD_INDENT_CLINICAL_ORDER_QUANTITY_MISMATCH',
          message: 'quantity changed',
          details: {
            'expected_catalog_id': 41,
            'expected_quantity': 3,
            'expected_unit': 'tablets',
          },
        ),
      ],
    );
    await _pumpSheet(tester, gateway);
    await _loadAdmission(tester);

    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'Supply changed to catalog 41, quantity 3 tablets. Review the refreshed order before trying again.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('typed link conflict refreshes and removes the submit action', (
    tester,
  ) async {
    final gateway = _FakeRequesterGateway(
      projections: [_projection(), _projection(eligible: false)],
      createErrors: const [
        WardIndentRequestConflict(
          code: 'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
          message: 'already linked',
        ),
      ],
    );
    await _pumpSheet(tester, gateway);
    await _loadAdmission(tester);

    await tester.tap(find.byKey(const Key('ward-indent-request-submit')));
    await tester.pumpAndSettle();

    expect(gateway.loadAdmissionIds, [73, 73]);
    expect(
      find.byKey(const Key('ward-indent-request-conflict')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('ward-indent-request-empty')), findsOneWidget);
    expect(find.byKey(const Key('ward-indent-request-submit')), findsNothing);
  });

  testWidgets('offline state disables projection loading and never queues', (
    tester,
  ) async {
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.notReady,
    );
    final gateway = _FakeRequesterGateway(projections: [_projection()]);
    await _pumpSheet(tester, gateway);

    final load = tester.widget<FilledButton>(
      find.byKey(const Key('ward-indent-request-load')),
    );
    expect(load.onPressed, isNull);
    expect(
      find.byKey(const Key('ward-indent-request-offline')),
      findsOneWidget,
    );
    expect(gateway.loadAdmissionIds, isEmpty);
  });
}

const _eligibleOrder = WardIndentEligibleOrder(
  clinicalOrderId: 91,
  catalogId: 41,
  itemLabel: 'Paracetamol 500 mg tablet',
  quantity: 2,
  unit: 'tablet',
  status: 'verified',
  orderNumber: 'ORD-91',
  priority: 'urgent',
  route: 'oral',
  dose: '500 mg',
  frequency: 'TID',
  schedule: ['08:00', '14:00', '20:00'],
);

const _secondEligibleOrder = WardIndentEligibleOrder(
  clinicalOrderId: 92,
  catalogId: 42,
  itemLabel: 'Paracetamol 500 mg tablet',
  quantity: 1,
  unit: 'tablet',
  status: 'ordered',
  orderNumber: 'ORD-92',
  priority: 'routine',
  route: 'intravenous',
  dose: '1 g',
  frequency: 'BID',
  schedule: ['08:00', '20:00'],
);

WardIndentRecoveryProjection _projection({
  bool eligible = true,
  int admissionId = 73,
  List<WardIndentEligibleOrder>? orders,
}) {
  return WardIndentRecoveryProjection(
    admission: WardIndentRequestAdmissionContext(
      id: admissionId,
      status: 'admitted',
      patientUid: '10000000-0000-4000-8000-000000000001',
      patientName: 'Test Patient',
      hospitalId: 'VH-000073',
      encounterId: '20000000-0000-4000-8000-000000000001',
      wardId: 5,
      wardName: 'Ward A',
    ),
    eligibleOrders: eligible ? orders ?? const [_eligibleOrder] : const [],
    onlineOnly: true,
  );
}

Future<void> _pumpSheet(
  WidgetTester tester,
  _FakeRequesterGateway gateway, {
  IdempotencyAttemptRegistry? attempts,
}) async {
  tester.view.physicalSize = const Size(1000, 1800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: WardIndentRequestSheet(gateway: gateway, attempts: attempts),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _loadAdmission(WidgetTester tester) async {
  await tester.enterText(
    find.byKey(const Key('ward-indent-request-admission-id')),
    '73',
  );
  await tester.tap(find.byKey(const Key('ward-indent-request-load')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('ward-indent-request-order-91')));
  await tester.pump();
}

class _FakeRequesterGateway implements WardIndentRequesterGateway {
  _FakeRequesterGateway({
    required this.projections,
    this.createErrors = const [],
    this.winningIndent,
  });

  final List<WardIndentRecoveryProjection> projections;
  final List<Object?> createErrors;
  final WardIndent? winningIndent;
  final List<int> loadAdmissionIds = [];
  final List<int> getIds = [];
  final List<WardIndentOrderBoundCommand> commands = [];
  final List<String> keys = [];
  int _loadIndex = 0;

  @override
  Future<WardIndent> getIndent(int id) async {
    getIds.add(id);
    final indent = winningIndent;
    if (indent == null || indent.id != id) throw Exception('indent not found');
    return indent;
  }

  @override
  Future<WardIndentRecoveryProjection> loadOrderBoundProjection(
    int admissionId,
  ) async {
    loadAdmissionIds.add(admissionId);
    final index = _loadIndex < projections.length
        ? _loadIndex
        : projections.length - 1;
    _loadIndex += 1;
    return projections[index];
  }

  @override
  Future<WardIndent> createOrderBoundRequest(
    WardIndentOrderBoundCommand command, {
    required String idempotencyKey,
  }) async {
    commands.add(command);
    keys.add(idempotencyKey);
    final index = commands.length - 1;
    if (index < createErrors.length && createErrors[index] != null) {
      throw createErrors[index]!;
    }
    return WardIndent.fromJson({
      'id': 501,
      'indent_number': 'WI-501',
      'status': 'requested',
      'state_version': 1,
      'admission_id': command.admissionId,
      'items': const [],
      'workflow': const {},
    });
  }
}
