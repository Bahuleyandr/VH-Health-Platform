import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/models/composition_alternatives.dart';
import 'package:vhhealth_staff/features/pharmacy/models/ward_indent_models.dart';
import 'package:vhhealth_staff/features/pharmacy/services/ward_indent_gateway.dart';
import 'package:vhhealth_staff/features/pharmacy/services/ward_indent_role_policy.dart';
import 'package:vhhealth_staff/features/pharmacy/widgets/ward_indent_workbench.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    await ConnectivitySyncService.instance.resetForTesting();
  });

  tearDown(() async {
    await ConnectivitySyncService.instance.resetForTesting();
  });

  testWidgets('hydrates an exact deep-linked indent outside the first list', (
    tester,
  ) async {
    final listed = _indent(id: 1, number: 'WARD-1');
    final exact = _indent(id: 73, number: 'WARD-73');
    final gateway = _FakeWardIndentGateway(
      listRows: [listed],
      initialDetail: exact,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );

    expect(gateway.getIds, [73]);
    expect(find.byKey(const Key('ward-indent-detail-73')), findsOneWidget);
    expect(find.text('WARD-73'), findsWidgets);
  });

  testWidgets('read-only actor cannot inherit owner lifecycle actions', (
    tester,
  ) async {
    final issued = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'issued',
      version: 5,
      ownerRoles: const ['NURSING_STAFF'],
      quantityIssued: 2,
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [issued],
      initialDetail: issued,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'ADMISSION_OFFICER',
      initialIndentId: 73,
    );

    expect(
      find.text('No actions are available for your role in this state.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('ward-indent-action-issue')), findsNothing);
    expect(find.byKey(const Key('ward-indent-action-receive')), findsNothing);
  });

  testWidgets('pharmacy actor sees only valid requested-state actions', (
    tester,
  ) async {
    final requested = _indent(id: 73, number: 'WARD-73');
    final gateway = _FakeWardIndentGateway(
      listRows: [requested],
      initialDetail: requested,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );

    expect(find.byKey(const Key('ward-indent-action-reserve')), findsOneWidget);
    expect(
      find.byKey(const Key('ward-indent-action-shortSupply')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('ward-indent-action-reject')), findsOneWidget);
    expect(find.byKey(const Key('ward-indent-action-cancel')), findsOneWidget);
    expect(find.byKey(const Key('ward-indent-action-issue')), findsNothing);
    expect(find.byKey(const Key('ward-indent-action-receive')), findsNothing);
  });

  testWidgets('all mutation controls are disabled while offline', (
    tester,
  ) async {
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.notReady,
    );
    final requested = _indent(id: 73, number: 'WARD-73');
    final gateway = _FakeWardIndentGateway(
      listRows: [requested],
      initialDetail: requested,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );

    final reserve = tester.widget<FilledButton>(
      find.byKey(const Key('ward-indent-action-reserve')),
    );
    expect(reserve.onPressed, isNull);
    expect(
      find.text(
        'Reconnect to continue. This action cannot be completed offline.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('failed mutation reloads the authoritative version', (
    tester,
  ) async {
    final requested = _indent(id: 73, number: 'WARD-73');
    final refreshed = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'reserved',
      version: 2,
      quantityReserved: 2,
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [requested],
      initialDetail: requested,
      refreshedDetail: refreshed,
      mutateError: Exception('state version conflict'),
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    await tester.ensureVisible(
      find.byKey(const Key('ward-indent-action-reserve')),
    );
    await tester.tap(find.byKey(const Key('ward-indent-action-reserve')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    expect(gateway.mutateCalls, 1);
    expect(gateway.lastMutationVersion, 1);
    expect(gateway.lastIdempotencyKey, startsWith('ward-indent-73-reserve-'));
    expect(gateway.getIds, [73, 73]);
    expect(find.textContaining('version 2'), findsOneWidget);
    expect(find.text('Reserved'), findsWidgets);
  });

  testWidgets('reconciliation requires an explicit variance disposition', (
    tester,
  ) async {
    final variance = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'reconciliation_required',
      version: 7,
      ownerRoles: const ['PHARMACY_INCHARGE'],
      quantityIssued: 4,
      quantityReceived: 2,
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [variance],
      initialDetail: variance,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_INCHARGE',
      initialIndentId: 73,
    );
    final action = find.byKey(const Key('ward-indent-action-reconcile'));
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('ward-indent-reason')),
      'Count sheet reviewed by both teams',
    );
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    final confirm = find.byKey(const Key('ward-indent-disposition-confirm'));
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    expect(gateway.mutateCalls, 0);

    await tester.tap(find.byKey(const Key('ward-indent-disposition-701')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Transit shortage').last);
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull);
    await tester.tap(confirm);
    await tester.pumpAndSettle();

    expect(gateway.lastAction, WardIndentAction.reconcile);
    expect(gateway.lastPayload?['item_reconciliations'], [
      {
        'item_id': 701,
        'quantity_variance_resolved': 2.0,
        'disposition': 'transit_shortage',
        'note': 'Count sheet reviewed by both teams',
      },
    ]);
  });

  testWidgets('controlled dispense uses witness and recovered exact evidence', (
    tester,
  ) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final pending = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'controlled_handoff_required',
      version: 3,
      quantityReserved: 2,
      quantityApproved: 2,
      controlledReference: 'ward-indent:73:item:701',
    );
    final recoverable = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'controlled_handoff_required',
      version: 3,
      quantityReserved: 2,
      quantityApproved: 2,
      controlledReference: 'ward-indent:73:item:701',
      recovery: const {
        'item_id': 701,
        'status': 'available',
        'candidate_count': 1,
        'movement_id': 801,
        'register_id': 901,
      },
    );
    final completed = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'approved',
      version: 4,
      quantityReserved: 2,
      quantityApproved: 2,
      controlledReference: 'ward-indent:73:item:701',
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [pending],
      initialDetail: pending,
      refreshedDetail: recoverable,
      mutationResult: completed,
      inventoryItems: const [
        WardIndentInventoryItem(
          id: 501,
          catalogId: 101,
          displayName: 'Controlled stock',
          scheduleClass: 'X',
          isNarcotic: true,
          unitLabel: 'each',
        ),
      ],
      inventoryBatches: [
        WardIndentInventoryBatch(
          id: 601,
          inventoryItemId: 501,
          batchNumber: 'B-1',
          remainingQuantity: 10,
          expiryDate: today,
        ),
      ],
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    final action = find.byKey(
      const Key('ward-indent-action-controlledHandoff'),
    );
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await _pumpUntilFound(tester, find.textContaining('B-1'));
    await tester.tap(find.textContaining('B-1'));
    await _pumpUntilFound(
      tester,
      find.byKey(const Key('ward-indent-witness-employee-id')),
    );
    await tester.enterText(
      find.byKey(const Key('ward-indent-witness-employee-id')),
      'wit-2',
    );
    await tester.enterText(
      find.byKey(const Key('ward-indent-witness-password')),
      'secret',
    );
    await tester.tap(find.byKey(const Key('ward-indent-witness-confirm')));
    await tester.pumpAndSettle();

    expect(gateway.witnessRequestCalls, 1);
    expect(gateway.lastInventoryCatalogId, 101);
    expect(gateway.witnessApprovalCalls, 1);
    expect(gateway.lastWitnessEmployeeId, 'WIT-2');
    expect(gateway.dispenseCalls, 1);
    expect(gateway.lastDispense?['reference_id'], 'ward-indent:73:item:701');
    expect(gateway.lastDispense?['witness_approval_id'], 'approval-1');
    expect(gateway.lastAction, WardIndentAction.controlledHandoff);
    expect(gateway.lastPayload?['item_evidence'], [
      {'item_id': 701, 'movement_id': 801, 'register_id': 901},
    ]);
    expect(find.text('Approved'), findsWidgets);
  });

  testWidgets('ambiguous controlled recovery blocks dispense and handoff', (
    tester,
  ) async {
    final ambiguous = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'controlled_handoff_required',
      version: 3,
      quantityReserved: 2,
      quantityApproved: 2,
      controlledReference: 'ward-indent:73:item:701',
      recovery: const {
        'item_id': 701,
        'status': 'ambiguous',
        'candidate_count': 2,
      },
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [ambiguous],
      initialDetail: ambiguous,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    final action = find.byKey(
      const Key('ward-indent-action-controlledHandoff'),
    );
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    expect(gateway.dispenseCalls, 0);
    expect(gateway.mutateCalls, 0);
    expect(
      find.textContaining('Multiple controlled-drug evidence candidates'),
      findsOneWidget,
    );
  });

  testWidgets('loads the next server-filtered page with the stable cursor', (
    tester,
  ) async {
    final cursorTime = DateTime.utc(2026, 8, 27, 10);
    final first = _indent(id: 73, number: 'WARD-73', requestedAt: cursorTime);
    final older = _indent(
      id: 72,
      number: 'WARD-72',
      requestedAt: cursorTime.subtract(const Duration(minutes: 1)),
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [first],
      listPages: [
        [first],
        [older],
      ],
      initialDetail: first,
    );

    await _pumpWorkbench(tester, gateway: gateway, rawRole: 'PHARMACY_STAFF');

    expect(gateway.listRequests.single.worklist, 'open');
    await tester.tap(find.byKey(const Key('ward-indent-load-more')));
    await tester.pumpAndSettle();

    expect(gateway.listRequests, hasLength(2));
    expect(gateway.listRequests.last.beforeRequestedAt, cursorTime);
    expect(gateway.listRequests.last.beforeId, 73);
    expect(gateway.listRequests.last.limit, 100);
    expect(find.byKey(const Key('ward-indent-row-72')), findsOneWidget);
    expect(find.byKey(const Key('ward-indent-load-more')), findsNothing);
  });

  testWidgets('changing filters reloads the matching server worklist', (
    tester,
  ) async {
    final open = _indent(id: 73, number: 'WARD-73');
    final closed = _indent(id: 72, number: 'WARD-72', status: 'closed');
    final gateway = _FakeWardIndentGateway(
      listRows: [open],
      listPages: [
        [open],
        [closed],
      ],
      initialDetail: open,
    );

    await _pumpWorkbench(tester, gateway: gateway, rawRole: 'PHARMACY_STAFF');
    await tester.tap(find.byKey(const Key('ward-indent-filter-terminal')));
    await tester.pumpAndSettle();

    expect(gateway.listRequests.last.worklist, 'terminal');
    expect(find.byKey(const Key('ward-indent-row-72')), findsOneWidget);
    expect(find.byKey(const Key('ward-indent-row-73')), findsNothing);
  });
}

Future<void> _pumpWorkbench(
  WidgetTester tester, {
  required _FakeWardIndentGateway gateway,
  required String rawRole,
  int? initialIndentId,
}) async {
  tester.view.physicalSize = const Size(1200, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: WardIndentWorkbench(
          rawRole: rawRole,
          role: StaffRole.fromString(rawRole),
          initialIndentId: initialIndentId,
          gateway: gateway,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pumpUntilFound(WidgetTester tester, Finder finder) async {
  for (var attempt = 0; attempt < 40; attempt += 1) {
    await tester.pump(const Duration(milliseconds: 50));
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('Timed out waiting for the requested ward-indent widget');
}

WardIndent _indent({
  required int id,
  required String number,
  String status = 'requested',
  int version = 1,
  List<String> ownerRoles = const ['PHARMACY_STAFF'],
  double quantityReserved = 0,
  double quantityApproved = 0,
  double quantityIssued = 0,
  double quantityReceived = 0,
  String? controlledReference,
  Map<String, dynamic>? recovery,
  DateTime? requestedAt,
}) {
  return WardIndent.fromJson({
    'id': id,
    'indent_number': number,
    'status': status,
    'state_version': version,
    'patient_uid': '00000000-0000-4000-8000-000000000073',
    'ward_name': 'Ward A',
    'requested_at': requestedAt?.toIso8601String(),
    'items': [
      {
        'id': 701,
        'pharmacy_catalog_id': 101,
        'item_name': 'Test medicine',
        'quantity_requested': 2,
        'quantity_reserved': quantityReserved,
        'quantity_approved': quantityApproved,
        'quantity_issued': quantityIssued,
        'quantity_received': quantityReceived,
        'quantity_return_requested': 0,
        'quantity_returned': 0,
        'quantity_variance_resolved': 0,
        'controlled_reference_id': ?controlledReference,
      },
    ],
    'workflow': {
      'owner_role_codes': ownerRoles,
      'active_slas': const [],
      'events': const [],
      'pending_controlled_handoff_evidence': [?recovery],
    },
  });
}

class _FakeWardIndentGateway implements WardIndentGateway {
  _FakeWardIndentGateway({
    required this.listRows,
    required this.initialDetail,
    this.listPages,
    this.refreshedDetail,
    this.mutationResult,
    this.mutateError,
    this.inventoryItems = const [],
    this.inventoryBatches = const [],
  });

  final List<WardIndent> listRows;
  final List<List<WardIndent>>? listPages;
  final WardIndent initialDetail;
  final WardIndent? refreshedDetail;
  final WardIndent? mutationResult;
  final Object? mutateError;
  final List<WardIndentInventoryItem> inventoryItems;
  final List<WardIndentInventoryBatch> inventoryBatches;

  final List<int> getIds = [];
  final List<_ListRequest> listRequests = [];
  int _listCall = 0;
  int mutateCalls = 0;
  int dispenseCalls = 0;
  int witnessRequestCalls = 0;
  int witnessApprovalCalls = 0;
  int? lastMutationVersion;
  String? lastIdempotencyKey;
  WardIndentAction? lastAction;
  Map<String, dynamic>? lastPayload;
  Map<String, dynamic>? lastDispense;
  String? lastWitnessEmployeeId;
  int? lastInventoryCatalogId;

  @override
  Future<WardIndentPage> listIndents({
    bool overdueOnly = false,
    String? worklist,
    DateTime? beforeRequestedAt,
    int? beforeId,
    int limit = 100,
  }) async {
    listRequests.add(
      _ListRequest(
        worklist: worklist,
        beforeRequestedAt: beforeRequestedAt,
        beforeId: beforeId,
        limit: limit,
      ),
    );
    final pages = listPages;
    if (pages == null) {
      return WardIndentPage(items: listRows, hasMore: false);
    }
    final pageIndex = _listCall < pages.length ? _listCall : pages.length - 1;
    _listCall += 1;
    final rows = pages[pageIndex];
    final hasMore = pageIndex < pages.length - 1;
    final last = rows.isEmpty ? null : rows.last;
    return WardIndentPage(
      items: rows,
      hasMore: hasMore,
      nextBeforeRequestedAt: hasMore ? last?.requestedAt : null,
      nextBeforeId: hasMore ? last?.id : null,
    );
  }

  @override
  Future<WardIndent> getIndent(int id) async {
    getIds.add(id);
    return getIds.length == 1
        ? initialDetail
        : (refreshedDetail ?? initialDetail);
  }

  @override
  Future<WardIndent> mutateIndent(
    WardIndent indent,
    WardIndentAction action, {
    required Map<String, dynamic> payload,
    required String idempotencyKey,
  }) async {
    mutateCalls += 1;
    lastMutationVersion = indent.stateVersion;
    lastIdempotencyKey = idempotencyKey;
    lastAction = action;
    lastPayload = payload;
    if (mutateError != null) throw mutateError!;
    return mutationResult ?? indent;
  }

  @override
  Future<List<WardIndentInventoryItem>> listInventoryItems({
    int? catalogId,
  }) async {
    lastInventoryCatalogId = catalogId;
    return inventoryItems;
  }

  @override
  Future<List<WardIndentInventoryBatch>> listInventoryBatches(
    int itemId,
  ) async {
    return inventoryBatches;
  }

  @override
  Future<CompositionAlternativesResult> getCatalogAlternatives(
    int catalogId,
  ) async {
    return const CompositionAlternativesResult(
      selected: null,
      groups: [],
      alternatives: [],
    );
  }

  @override
  Future<Map<String, dynamic>> requestControlledDispenseWitnessApproval({
    required Map<String, dynamic> dispense,
    required String idempotencyKey,
  }) async {
    witnessRequestCalls += 1;
    return {'id': 'approval-1'};
  }

  @override
  Future<Map<String, dynamic>> approveControlledDispenseWitnessApproval({
    required String approvalId,
    required Map<String, dynamic> dispense,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    witnessApprovalCalls += 1;
    lastWitnessEmployeeId = employeeId;
    return const {'status': 'approved'};
  }

  @override
  Future<Map<String, dynamic>> dispenseControlledInventory({
    required Map<String, dynamic> dispense,
    required String idempotencyKey,
  }) async {
    dispenseCalls += 1;
    lastDispense = Map<String, dynamic>.from(dispense);
    return const {
      'movement': {'id': 801},
      'register_entry': {'id': 901},
    };
  }
}

class _ListRequest {
  const _ListRequest({
    required this.worklist,
    required this.beforeRequestedAt,
    required this.beforeId,
    required this.limit,
  });

  final String? worklist;
  final DateTime? beforeRequestedAt;
  final int? beforeId;
  final int limit;
}
