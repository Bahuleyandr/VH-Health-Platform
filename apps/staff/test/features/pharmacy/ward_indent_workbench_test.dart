import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/models/composition_alternatives.dart';
import 'package:vhhealth_staff/core/services/idempotency_attempt_registry.dart';
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

  test('multi-item controlled handoff preserves each exact reserved batch', () {
    final indent = WardIndent.fromJson({
      'id': 73,
      'status': 'controlled_handoff_required',
      'state_version': 3,
      'items': [
        {
          'id': 701,
          'item_name': 'Controlled A',
          'controlled_reference_id': 'ward-indent:73:item:701',
        },
        {
          'id': 702,
          'item_name': 'Controlled B',
          'controlled_reference_id': 'ward-indent:73:item:702',
        },
      ],
      'workflow': {
        'medication_closure': {
          'allocations': [
            {
              'id': '9001',
              'ward_indent_id': 73,
              'ward_indent_item_id': 701,
              'inventory_item_id': 501,
              'inventory_batch_id': 601,
              'status': 'reserved',
              'reserved_quantity': 1,
              'issued_quantity': 0,
            },
            {
              'id': '9002',
              'ward_indent_id': 73,
              'ward_indent_item_id': 702,
              'inventory_item_id': 502,
              'inventory_batch_id': 602,
              'status': 'reserved',
              'reserved_quantity': 2,
              'issued_quantity': 0,
            },
          ],
        },
      },
    });

    final first = exactControlledIssueAllocation(indent, indent.items[0]);
    final second = exactControlledIssueAllocation(indent, indent.items[1]);

    expect(first?.id, '9001');
    expect(first?.inventoryItemId, 501);
    expect(first?.inventoryBatchId, 601);
    expect(second?.id, '9002');
    expect(second?.inventoryItemId, 502);
    expect(second?.inventoryBatchId, 602);
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
    expect(gateway.lastIdempotencyKey, startsWith('ward-indent-73-reserve:'));
    expect(gateway.getIds, [73, 73]);
    expect(find.textContaining('version 2'), findsOneWidget);
    expect(find.text('Reserved'), findsWidgets);
  });

  testWidgets('ambiguous mutation retry reuses the exact payload key', (
    tester,
  ) async {
    final requested = _indent(id: 73, number: 'WARD-73');
    final reserved = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'reserved',
      version: 2,
      quantityReserved: 2,
    );
    final attempts = IdempotencyAttemptRegistry();
    final gateway = _FakeWardIndentGateway(
      listRows: [requested],
      initialDetail: requested,
      refreshedDetail: requested,
      mutationResult: reserved,
      mutateErrors: [Exception('response lost'), null],
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
      attempts: attempts,
    );

    Future<void> reserve() async {
      final action = find.byKey(const Key('ward-indent-action-reserve'));
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
    }

    await reserve();
    expect(gateway.idempotencyKeys, hasLength(1));
    expect(
      attempts.current('ward-indent:73:reserve'),
      gateway.idempotencyKeys.single,
    );

    await reserve();
    expect(gateway.idempotencyKeys, hasLength(2));
    expect(gateway.idempotencyKeys[1], gateway.idempotencyKeys[0]);
    expect(attempts.current('ward-indent:73:reserve'), isNull);
    expect(find.text('Reserved'), findsWidgets);
  });

  testWidgets('changed authoritative version starts a new mutation key', (
    tester,
  ) async {
    final requestedV1 = _indent(id: 73, number: 'WARD-73');
    final requestedV2 = _indent(id: 73, number: 'WARD-73', version: 2);
    final reserved = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'reserved',
      version: 3,
      quantityReserved: 2,
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [requestedV1],
      initialDetail: requestedV1,
      refreshedDetail: requestedV2,
      mutationResult: reserved,
      mutateErrors: [Exception('state changed'), null],
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );

    for (var attempt = 0; attempt < 2; attempt++) {
      final action = find.byKey(const Key('ward-indent-action-reserve'));
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
    }

    expect(gateway.idempotencyKeys, hasLength(2));
    expect(gateway.idempotencyKeys[1], isNot(gateway.idempotencyKeys[0]));
    expect(gateway.mutationVersions, [1, 2]);
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
      inventoryCandidates: const [
        WardIndentInventoryItem(
          id: 501,
          catalogId: 101,
          displayName: 'Controlled stock',
          scheduleClass: 'X',
          isNarcotic: true,
          unitLabel: 'each',
          unreservedQuantity: 8,
          batches: [
            WardIndentInventoryBatch(
              id: 601,
              inventoryItemId: 501,
              batchNumber: 'B-1',
              remainingQuantity: 10,
              unreservedQuantity: 8,
            ),
          ],
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
    expect(gateway.inventoryCandidateCalls, 1);
    expect(gateway.witnessApprovalCalls, 1);
    expect(gateway.lastWitnessEmployeeId, 'WIT-2');
    expect(gateway.lastAction, WardIndentAction.controlledHandoff);
    expect(gateway.lastPayload?['item_evidence'], [
      {'item_id': 701, 'witness_approval_id': 'approval-1'},
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

    expect(gateway.witnessRequestCalls, 0);
    expect(gateway.mutateCalls, 0);
    expect(
      find.textContaining('Multiple controlled-drug evidence candidates'),
      findsOneWidget,
    );
  });

  testWidgets('reserve submits the selected inventory candidate identity', (
    tester,
  ) async {
    final requested = _indent(id: 73, number: 'WARD-73');
    final gateway = _FakeWardIndentGateway(
      listRows: [requested],
      initialDetail: requested,
      inventoryCandidates: const [
        WardIndentInventoryItem(
          id: 991,
          catalogId: 101,
          displayName: 'Exact ward stock',
          isNarcotic: false,
          unreservedQuantity: 2,
        ),
      ],
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    final action = find.byKey(const Key('ward-indent-action-reserve'));
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    expect(gateway.inventoryCandidateCalls, 1);
    expect(gateway.lastAction, WardIndentAction.reserve);
    expect(gateway.lastPayload, {
      'inventory_selections': [
        {'item_id': 701, 'inventory_item_id': 991},
      ],
    });
  });

  testWidgets(
    'substitution approval accepts global stock for a facility indent',
    (tester) async {
      final pending = _indent(
        id: 73,
        number: 'WARD-73',
        status: 'substitution_pending',
        ownerRoles: const ['DOCTOR'],
        substitutionStatus: 'pending',
        proposedName: 'Composition-safe alternate',
        proposedCatalogId: 102,
        proposedQuantity: 2,
        facilityId: 8,
      );
      final gateway = _FakeWardIndentGateway(
        listRows: [pending],
        initialDetail: pending,
        inventoryItems: const [
          WardIndentInventoryItem(
            id: 992,
            catalogId: 102,
            displayName: 'Proposed stock',
            isNarcotic: false,
            unreservedQuantity: 2,
          ),
        ],
      );

      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'DOCTOR',
        initialIndentId: 73,
      );
      final action = find.byKey(
        const Key('ward-indent-action-approveSubstitution'),
      );
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();

      expect(gateway.lastInventoryCatalogId, 102);
      expect(gateway.lastAction, WardIndentAction.approveSubstitution);
      expect(gateway.lastPayload, {
        'inventory_selections': [
          {'item_id': 701, 'inventory_item_id': 992},
        ],
      });
    },
  );

  testWidgets('short supply binds available quantity to inventory selection', (
    tester,
  ) async {
    final requested = _indent(id: 73, number: 'WARD-73');
    final gateway = _FakeWardIndentGateway(
      listRows: [requested],
      initialDetail: requested,
      inventoryCandidates: const [
        WardIndentInventoryItem(
          id: 993,
          catalogId: 101,
          displayName: 'Partial stock',
          isNarcotic: false,
          unreservedQuantity: 1,
        ),
      ],
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    final action = find.byKey(const Key('ward-indent-action-shortSupply'));
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('ward-indent-reason')),
      'Only one pack is available in ward-linked inventory',
    );
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('ward-indent-quantity-701')),
      '1',
    );
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    expect(gateway.lastAction, WardIndentAction.shortSupply);
    expect(gateway.lastPayload?['item_quantities_available'], [
      {'item_id': 701, 'quantity_available': 1.0},
    ]);
    expect(gateway.lastPayload?['inventory_selections'], [
      {'item_id': 701, 'inventory_item_id': 993},
    ]);
  });

  testWidgets('receipt sends approved substitution acknowledgement', (
    tester,
  ) async {
    final issued = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'issued',
      version: 5,
      ownerRoles: const ['NURSING_STAFF'],
      quantityIssued: 2,
      substitutionStatus: 'approved',
      proposedName: 'Approved alternate',
      proposedCatalogId: 102,
      proposedQuantity: 2,
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [issued],
      initialDetail: issued,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'NURSING_STAFF',
      initialIndentId: 73,
    );
    final action = find.byKey(const Key('ward-indent-action-receive'));
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('ward-indent-substitution-acknowledge')),
      findsOneWidget,
    );
    await tester.tap(
      find.byKey(const Key('ward-indent-substitution-acknowledge')),
    );
    await tester.pumpAndSettle();

    expect(gateway.lastAction, WardIndentAction.receive);
    expect(gateway.lastPayload?['substitution_acknowledgements'], [
      {'item_id': 701},
    ]);
    expect(gateway.lastPayload?['item_quantities_received'], [
      {'item_id': 701, 'quantity_received': 2.0},
    ]);
  });

  testWidgets('return request defaults and caps at unconsumed ward custody', (
    tester,
  ) async {
    final received = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'received',
      version: 8,
      ownerRoles: const ['NURSING_STAFF'],
      quantityIssued: 10,
      quantityReceived: 10,
      quantityReturned: 1,
      quantityConsumed: 4,
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [received],
      initialDetail: received,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'NURSING_STAFF',
      initialIndentId: 73,
    );
    final action = find.byKey(const Key('ward-indent-action-requestReturn'));
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('ward-indent-reason')),
      'Returning unused packs after administered doses',
    );
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    final quantityField = find.byKey(const Key('ward-indent-quantity-701'));
    expect(tester.widget<TextFormField>(quantityField).initialValue, '6');
    expect(find.text('1 - 6'), findsOneWidget);
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    expect(gateway.lastAction, WardIndentAction.requestReturn);
    expect(gateway.lastPayload?['item_quantities_returned'], [
      {'item_id': 701, 'quantity_returned': 6.0},
    ]);
  });

  testWidgets(
    'reconciliation creates controlled return evidence and allocation lineage',
    (tester) async {
      final pending = _indent(
        id: 73,
        number: 'WARD-73',
        status: 'reconciliation_required',
        version: 9,
        ownerRoles: const ['PHARMACY_INCHARGE'],
        quantityReserved: 2,
        quantityIssued: 2,
        quantityReceived: 2,
        quantityReturnRequested: 2,
        controlledReference: 'ward-indent:73:item:701',
      );
      final gateway = _FakeWardIndentGateway(
        listRows: [pending],
        initialDetail: pending,
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
        'Controlled balance returned to pharmacy custody',
      );
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();

      expect(gateway.lastAction, WardIndentAction.reconcile);
      expect(gateway.lastPayload?['allocation_returns'], [
        {'allocation_id': '9001', 'quantity': 2.0},
      ]);
      expect(gateway.lastPayload?.containsKey('controlled_return_evidence'), isFalse);
    },
  );

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
  IdempotencyAttemptRegistry? attempts,
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
          attempts: attempts ?? IdempotencyAttemptRegistry(),
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
  double quantityReturnRequested = 0,
  double quantityReturned = 0,
  double quantityConsumed = 0,
  String? controlledReference,
  String? substitutionStatus,
  String? proposedName,
  int? proposedCatalogId,
  double? proposedQuantity,
  Map<String, dynamic>? recovery,
  DateTime? requestedAt,
  int? facilityId,
}) {
  return WardIndent.fromJson({
    'id': id,
    'indent_number': number,
    'status': status,
    'state_version': version,
    'patient_uid': '00000000-0000-4000-8000-000000000073',
    'facility_id': ?facilityId,
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
        'quantity_return_requested': quantityReturnRequested,
        'quantity_returned': quantityReturned,
        'quantity_variance_resolved': 0,
        'substitution_status': ?substitutionStatus,
        'proposed_item_name': ?proposedName,
        'proposed_pharmacy_catalog_id': ?proposedCatalogId,
        'proposed_quantity': ?proposedQuantity,
        'controlled_reference_id': ?controlledReference,
      },
    ],
    'workflow': {
      'owner_role_codes': ownerRoles,
      'active_slas': const [],
      'events': const [],
      'pending_controlled_handoff_evidence': [?recovery],
      'medication_closure': {
        'allocations': [
          if (quantityReserved > 0 || quantityReceived > 0)
            {
              'id': '9001',
              'ward_indent_id': id,
              'ward_indent_item_id': 701,
              'inventory_item_id': 501,
              'inventory_batch_id': 601,
              'status': 'reserved',
              'reserved_quantity': quantityReserved,
              'issued_quantity': 0,
              'received_quantity': quantityReceived,
              'consumed_quantity': quantityConsumed,
              'returned_quantity': quantityReturned,
              'custody_available_quantity':
                  quantityReceived - quantityConsumed - quantityReturned,
              'batch_number': 'B-1',
              'lot_number': 'L-1',
              'expiry_date': '2027-08-27',
            },
        ],
        'movement_lineage': const [],
        'financial_events': const [],
      },
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
    this.mutateErrors,
    this.inventoryItems = const [],
    this.inventoryCandidates = const [
      WardIndentInventoryItem(
        id: 501,
        catalogId: 101,
        displayName: 'Test inventory',
        isNarcotic: false,
        unreservedQuantity: 100,
      ),
    ],
  });

  final List<WardIndent> listRows;
  final List<List<WardIndent>>? listPages;
  final WardIndent initialDetail;
  final WardIndent? refreshedDetail;
  final WardIndent? mutationResult;
  final Object? mutateError;
  final List<Object?>? mutateErrors;
  final List<WardIndentInventoryItem> inventoryItems;
  final List<WardIndentInventoryItem> inventoryCandidates;

  final List<int> getIds = [];
  final List<_ListRequest> listRequests = [];
  int _listCall = 0;
  int mutateCalls = 0;
  int witnessRequestCalls = 0;
  int witnessApprovalCalls = 0;
  int inventoryCandidateCalls = 0;
  int? lastMutationVersion;
  String? lastIdempotencyKey;
  final List<String> idempotencyKeys = [];
  final List<int> mutationVersions = [];
  WardIndentAction? lastAction;
  Map<String, dynamic>? lastPayload;
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
    mutationVersions.add(indent.stateVersion);
    lastIdempotencyKey = idempotencyKey;
    idempotencyKeys.add(idempotencyKey);
    lastAction = action;
    lastPayload = payload;
    final queuedError =
        mutateErrors != null && mutateCalls <= mutateErrors!.length
        ? mutateErrors![mutateCalls - 1]
        : null;
    if (queuedError != null) throw queuedError;
    if (mutateErrors == null && mutateError != null) throw mutateError!;
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
    return const [];
  }

  @override
  Future<List<WardIndentInventoryItem>> listInventoryCandidates(
    int indentId,
    int itemId,
  ) async {
    inventoryCandidateCalls += 1;
    return inventoryCandidates;
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
  Future<Map<String, dynamic>> requestWardControlledWitnessApproval({
    required int indentId,
    required int itemId,
    required Object allocationId,
    required String idempotencyKey,
  }) async {
    witnessRequestCalls += 1;
    return {'id': 'approval-1'};
  }

  @override
  Future<Map<String, dynamic>> approveWardControlledWitnessApproval({
    required int indentId,
    required String approvalId,
    required int itemId,
    required Object allocationId,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    witnessApprovalCalls += 1;
    lastWitnessEmployeeId = employeeId;
    return const {'status': 'approved'};
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
